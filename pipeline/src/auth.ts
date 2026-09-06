import { PublicClientApplication, type AccountInfo, type ICachePlugin } from "@azure/msal-node";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { env } from "./env.js";

const CACHE_PATH = new URL("../token-cache.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
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

  const result = await pca.acquireTokenByDeviceCode({
    scopes: GRAPH_SCOPES,
    deviceCodeCallback: (response) => {
      console.log(response.message);
    },
  });

  if (!result) throw new Error("Device code sign-in did not return a token");
  return result.accessToken;
}
