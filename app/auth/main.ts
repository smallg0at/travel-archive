// The MSAL redirect bridge. Both interactive flows land here (see
// ../src/msalConfig.ts for why this is a dedicated page rather than the app).
//
// Two arrivals, two jobs:
//
//   as a POPUP — merely constructing a PublicClientApplication here does NOT
//   process the auth response; that was the earlier bug (the popup landed on
//   the right URL with a valid code and just sat there). msal-browser ships a
//   function for exactly this page: it parses the response from the URL,
//   broadcasts it to the opener via BroadcastChannel, and closes the window.
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

async function completeRedirect(): Promise<void> {
  const msal = new PublicClientApplication(msalConfig);
  await msal.initialize();
  await msal.handleRedirectPromise();
  // replace(), not assign(): the bridge URL still carries the auth response,
  // and it must not be reachable with Back.
  window.location.replace("/");
}

const done = isPopup ? broadcastResponseToMainFrame() : completeRedirect();

done.catch((err) => {
  console.error("Auth redirect bridge failed:", err);
  document.body.textContent = "Sign-in could not be completed. Close this window and try again.";
});
