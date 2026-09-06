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
    // application" platform in Azure — including the trailing slash. This
    // is a DEDICATED bridge page (auth/index.html), not the main app:
    // msal-browser's loginPopup() needs the popup to land on a page that
    // just initializes MSAL, which then detects it's running inside a
    // popup it opened and broadcasts the response back via BroadcastChannel
    // — pointing this at the main app (which runs the whole UI instead)
    // means that handoff never happens and the popup never closes. The
    // trailing slash matters: confirmed live that Vite's dev/preview
    // server only resolves auth/index.html for the exact path `/auth/`
    // (directory-index convention) — `/auth` without it falls through to
    // the SPA fallback and serves the main app instead.
    redirectUri: `${window.location.origin}/auth/`,
  },
  cache: {
    cacheLocation: "localStorage",
  },
};

export const SCOPES = ["Files.Read"];
