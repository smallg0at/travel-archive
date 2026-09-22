import type { Configuration } from "@azure/msal-browser";

// Shared between the main app (msAuth.ts) and the dedicated redirect
// bridge page (auth/main.ts) — both need an identically-configured
// PublicClientApplication for msal-browser's popup handoff to work.
const CLIENT_ID = import.meta.env.VITE_AZURE_CLIENT_ID;
const TENANT = import.meta.env.VITE_AZURE_TENANT_ID || "consumers";

export const msalConfig: Configuration = {
  auth: {
    clientId: CLIENT_ID,
    authority: `https://login.microsoftonline.com/${TENANT}`,
    // Must exactly match a redirect URI registered under the "Single-page
    // application" platform in Azure. This is a DEDICATED bridge page
    // (auth.html), not the main app: msal-browser's loginPopup() needs the
    // popup to land on a page that just initializes MSAL, which then detects
    // it's running inside a popup it opened and broadcasts the response back
    // via BroadcastChannel — pointing this at the main app (which runs the
    // whole UI instead) means that handoff never happens and the popup never
    // closes.
    //
    // The `.html` extension is load-bearing, which is why this is not the
    // trailing-slash `/auth/` it used to be. Capacitor's local server runs in
    // html5mode: it serves *any* extensionless path as index.html, so `/auth/`
    // booted the whole app inside msal-browser's hidden renewal iframe instead
    // of the bridge, and silent renewal timed out once the SPA refresh token's
    // 24 hours lapsed. A real file path is served as itself by every server
    // here — Capacitor, Vite dev/preview, and the desktop's own static server
    // — with no per-platform routing to get right.
    redirectUri: `${window.location.origin}/auth.html`,
  },
  cache: {
    cacheLocation: "localStorage",
  },
};

export const SCOPES = ["Files.Read"];
