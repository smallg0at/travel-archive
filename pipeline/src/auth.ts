import { PublicClientApplication, type AccountInfo, type ICachePlugin } from "@azure/msal-node";
import { homeFile } from "./paths.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { env } from "./env.js";

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
export interface PendingDeviceCode {
  url: string;
  code: string;
  /** ISO timestamp — the page counts down from it. */
  expiresAt: string;
}

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

  try {
    const result = await pca.acquireTokenByDeviceCode({
      scopes: GRAPH_SCOPES,
      deviceCodeCallback: (response) => {
        console.log(response.message);
        pendingDeviceCode = {
          url: response.verificationUri,
          code: response.userCode,
          expiresAt: new Date(Date.now() + response.expiresIn * 1000).toISOString(),
        };
      },
    });

    if (!result) throw new Error("Device code sign-in did not return a token");
    return result.accessToken;
  } finally {
    // Completed or abandoned: either way this code is spent.
    pendingDeviceCode = null;
  }
}
