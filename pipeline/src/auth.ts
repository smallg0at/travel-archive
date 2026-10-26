import { PublicClientApplication, type AccountInfo, type ICachePlugin } from "@azure/msal-node";
import { homeFile } from "./paths.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { env } from "./env.js";
import { pendingFromDeviceCode, type PendingDeviceCode } from "./deviceCode.js";

// Per-user state, so it follows home rather than the module: installed, the
// module directory is read-only and writing the refresh token there fails.
const CACHE_PATH = homeFile("token-cache.json");
const GRAPH_SCOPES = ["Files.ReadWrite", "offline_access"];

const cachePlugin: ICachePlugin = {
  async beforeCacheAccess(context) {
    try {
      const data = await readFile(CACHE_PATH, "utf-8");
      context.tokenCache.deserialize(data);
    } catch {
      // no cache yet — first run
    }
  },
  async afterCacheAccess(context) {
    if (context.cacheHasChanged) {
      await mkdir(dirname(CACHE_PATH), { recursive: true });
      await writeFile(CACHE_PATH, context.tokenCache.serialize(), "utf-8");
    }
  },
};

const pca = new PublicClientApplication({
  auth: {
    clientId: env.azureClientId,
    authority: `https://login.microsoftonline.com/${env.azureTenantId}`,
  },
  cache: { cachePlugin },
});

async function getCachedAccount(): Promise<AccountInfo | null> {
  const accounts = await pca.getTokenCache().getAllAccounts();
  return accounts[0] ?? null;
}

/**
 * Whether an account is in the token cache, **without any network call**.
 *
 * For `/health`, which must answer even while a job is busy: reading the cache
 * is local, whereas `getCachedAccessToken` performs a silent token request that
 * can take a moment. "Signed in" here means "has an account we could use", which
 * is what the app's banner needs to know.
 */
export async function hasCachedAccount(): Promise<boolean> {
  try {
    return (await pca.getTokenCache().getAllAccounts()).length > 0;
  } catch {
    return false;
  }
}

/**
 * A token if one can be had without asking the user anything, else null.
 *
 * `getAccessToken` falls through to the device-code flow, which prints a code
 * and blocks until somebody types it into a browser. That is right for a CLI
 * run the user is watching and wrong for anything else — the server's /health
 * endpoint would hang forever on the first request and report nothing. This is
 * the non-blocking half of it.
 */
export async function getCachedAccessToken(): Promise<string | null> {
  const account = await getCachedAccount();
  if (!account) return null;
  try {
    const result = await pca.acquireTokenSilent({ account, scopes: GRAPH_SCOPES });
    return result?.accessToken ?? null;
  } catch {
    return null;
  }
}

/**
 * The device-code prompt while it is waiting for a human.
 *
 * `getAccessToken` used to render it to `console.log` alone, which is right
 * for a CLI run and wrong for a server: on a real first run the job page said
 * "Signing in…" forever while the code sat in `serve.log` where nobody looks.
 * This slot lets a page show it (loopback-only — see `/oobe`), and it clears
 * itself whether the sign-in lands or fails, so a stale code is never on
 * offer twice.
 */
export type { PendingDeviceCode } from "./deviceCode.js";

let pendingDeviceCode: PendingDeviceCode | null = null;

export function getPendingDeviceCode(): PendingDeviceCode | null {
  return pendingDeviceCode;
}

/**
 * Returns a valid Graph API access token, reusing the cached refresh token
 * silently when possible and only prompting the device-code flow on first
 * run or once the refresh token itself expires.
 */
export async function getAccessToken(): Promise<string> {
  const account = await getCachedAccount();

  if (account) {
    try {
      const result = await pca.acquireTokenSilent({ account, scopes: GRAPH_SCOPES });
      if (result) return result.accessToken;
    } catch {
      // fall through to interactive device-code flow
    }
  }

  let deviceCodeUnusable = false;

  try {
    const result = await pca.acquireTokenByDeviceCode({
      scopes: GRAPH_SCOPES,
      deviceCodeCallback: (response) => {
        // MSAL calls this before it validates the answer, so a rejected
        // request — a wrong client id or tenant, or a proxy returning junk —
        // arrives here with every field undefined. Building a Date from
        // `undefined` threw "Invalid time value", which replaced the real
        // cause with a message about dates; the same shape as the empty
        // reasoning block, an action that should fail loudly instead
        // reporting something plausible and useless. Leave the state unset
        // and let MSAL raise what actually went wrong.
        const pending = pendingFromDeviceCode(response);
        if (!pending) {
          deviceCodeUnusable = true;
          return;
        }
        console.log(response.message);
        pendingDeviceCode = pending;
      },
    });

    if (!result) throw new Error("Device code sign-in did not return a token");
    return result.accessToken;
  } catch (err) {
    // The callback above cannot throw without masking whichever error MSAL
    // was about to raise, so it flags the bad response and the rewrite
    // happens here, where MSAL's own message can be kept as the cause.
    if (deviceCodeUnusable) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Sign-in could not start: ${cause}. Azure rejected the device code request before issuing a code — check AZURE_CLIENT_ID and AZURE_TENANT_ID.`,
      );
    }
    throw err;
  } finally {
    // Completed or abandoned: either way this code is spent.
    pendingDeviceCode = null;
  }
}
