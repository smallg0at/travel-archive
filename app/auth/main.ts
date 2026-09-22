// The MSAL redirect bridge. Every auth arrival lands here (see
// ../src/msalConfig.ts for why this is a dedicated page rather than the app).
//
// Three arrivals, two jobs:
//
//   as a POPUP — merely constructing a PublicClientApplication here does NOT
//   process the auth response; that was the earlier bug (the popup landed on
//   the right URL with a valid code and just sat there). msal-browser ships a
//   function for exactly this page: it parses the response from the URL,
//   broadcasts it to the opener via BroadcastChannel, and closes the window.
//
//   as a SILENT IFRAME — msal-browser's hidden frame for renewing a token
//   without a sign-in (see isSilentFrame below). Same job as the popup: it too
//   wants the broadcast, not the full-page handling.
//
//   as a FULL-PAGE REDIRECT — there is no opener to broadcast to. Handle the
//   response here instead, which writes the account into MSAL's localStorage
//   cache, then send the tab back to the app, which finds it already signed
//   in. Used where popups are blocked: in-app browsers, embedded webviews,
//   and iOS Safari.
import { broadcastResponseToMainFrame } from "@azure/msal-browser/redirect-bridge";
import { PublicClientApplication } from "@azure/msal-browser";
import { msalConfig } from "../src/msalConfig";

const isPopup = window.opener != null && window.opener !== window;

/**
 * Whether this load is the hidden iframe msal-browser uses to renew silently.
 *
 * It has no `opener` and is not the top frame — and msal-browser 5 no longer
 * reads the response out of the iframe's URL. `SilentIframeClient` waits on
 * `waitForBridgeResponse`, a `BroadcastChannel` message carrying the raw
 * payload — exactly what `broadcastResponseToMainFrame` sends, and exactly
 * what the popup path here already sends. Falling through to the full-page
 * branch instead (which processes the response and replaces the URL) destroys
 * the payload before the parent can read it, so every renewal past the SPA
 * refresh token's 24-hour life timed out and the app asked to be signed in
 * again every day.
 */
const isSilentFrame = window.self !== window.top;

async function completeRedirect(): Promise<void> {
  const msal = new PublicClientApplication(msalConfig);
  await msal.initialize();
  await msal.handleRedirectPromise();
  // replace(), not assign(): the bridge URL still carries the auth response,
  // and it must not be reachable with Back.
  window.location.replace("/");
}

const done = isPopup || isSilentFrame ? broadcastResponseToMainFrame() : completeRedirect();

done.catch((err) => {
  console.error("Auth redirect bridge failed:", err);
  document.body.textContent = "Sign-in could not be completed. Close this window and try again.";
});
