// Device-code flow (the pipeline's approach) does NOT work from a browser:
// Microsoft's /devicecode and device-code /token endpoints aren't CORS-
// enabled for direct fetch() from a page origin — confirmed live, not just
// theorized (`Access to fetch at '.../devicecode' ... blocked by CORS
// policy`). Authorization Code + PKCE via msal-browser is the flow
// Microsoft actually supports from a browser/webview, and only when the
// app's redirect URI is registered under the "Single-page application"
// platform in Azure AD (that's what makes the token endpoint answer CORS
// preflights) — see README "Photo access" for the registration step, and
// msalConfig.ts for why the redirect URI points at a dedicated bridge page.
import { BrowserAuthError, PublicClientApplication, type AccountInfo } from "@azure/msal-browser";
import { msalConfig, SCOPES } from "./msalConfig";

const msalInstance = new PublicClientApplication(msalConfig);

let initPromise: Promise<void> | null = null;
function ensureInitialized(): Promise<void> {
  if (!initPromise) initPromise = msalInstance.initialize();
  return initPromise;
}

export async function getActiveAccount(): Promise<AccountInfo | null> {
  await ensureInitialized();
  return msalInstance.getAllAccounts()[0] ?? null;
}

/**
 * MSAL sets a lock flag (sessionStorage, `msal.*` keys) before opening an
 * interactive popup and clears it once that popup finishes. If a popup gets
 * abandoned instead of completing — closed manually, browser crash, or (as
 * happened here) an earlier misconfigured redirect page that never handed
 * control back — that flag is stuck "on" forever and every future signIn()
 * fails immediately with `interaction_in_progress`, no popup even opens.
 */
function clearStaleInteractionLock(): void {
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith("msal.")) sessionStorage.removeItem(key);
  }
}

/**
 * Interactive sign-in. Must be called directly from a user gesture (a click
 * handler) — browsers block popups opened from anywhere else (e.g. from
 * inside an IntersectionObserver callback, which is why photo loading no
 * longer tries to trigger sign-in itself; see graphPhoto.ts's
 * "signin-required" event instead).
 *
 * Popup first, because it keeps the app's state and scroll position. But a
 * popup is not always available: embedded webviews and in-app browsers refuse
 * `window.open` outright, and iOS Safari blocks it in enough situations to
 * matter — which covers the phone, the stated view-only client. MSAL reports
 * that as `popup_window_error`, so treat it as "this browser does not do
 * popups" and navigate the whole tab instead.
 *
 * The redirect lands on the same /auth/ bridge page the popup uses, which is
 * already registered in Azure — see auth/main.ts, which handles both arrivals.
 * A redirect never returns: the promise below is left pending while the tab
 * navigates away.
 */
export async function signIn(): Promise<AccountInfo> {
  await ensureInitialized();

  const popup = async () => (await msalInstance.loginPopup({ scopes: SCOPES })).account;

  try {
    return await popup();
  } catch (err) {
    if (err instanceof BrowserAuthError && err.errorCode === "interaction_in_progress") {
      clearStaleInteractionLock();
      return await popup();
    }
    if (err instanceof BrowserAuthError && err.errorCode === "popup_window_error") {
      await msalInstance.loginRedirect({ scopes: SCOPES });
      return await new Promise<AccountInfo>(() => {});
    }
    throw err;
  }
}

/**
 * A valid Graph access token via silent renewal — no user gesture needed,
 * works as long as the cached session is still valid. Throws if there's no
 * signed-in account, or if silent renewal fails and interactive sign-in
 * would be required (that has to go back through signIn(), from a click).
 */
export async function getAccessToken(): Promise<string> {
  await ensureInitialized();
  const account = msalInstance.getAllAccounts()[0];
  if (!account) throw new Error("SIGN_IN_REQUIRED");

  try {
    const result = await msalInstance.acquireTokenSilent({ scopes: SCOPES, account });
    return result.accessToken;
  } catch {
    throw new Error("SIGN_IN_REQUIRED");
  }
}

/**
 * Sign-in for the native app, where a popup can never work: Capacitor's
 * WebView has no second window to open, so `window.open` either fails or
 * replaces the app itself, and MSAL's popup handoff has nothing to hand back
 * to. The whole WebView goes to Microsoft instead and returns through the
 * /auth/ bridge. Never resolves — the page navigates away.
 */
export async function signInRedirect(): Promise<void> {
  await ensureInitialized();
  await msalInstance.loginRedirect({ scopes: SCOPES });
}

/**
 * Finishes a redirect sign-in, if this page load is the return from one.
 *
 * The bridge page (auth/main.ts) handles the response itself, but MSAL may
 * instead carry it on to the page that started the login — by default it
 * navigates back there — and then it is this page that must process it, or
 * the sign-in is silently dropped. Calling this on a page with nothing to
 * finish does nothing.
 */
export async function completeRedirect(): Promise<void> {
  await ensureInitialized();
  await msalInstance.handleRedirectPromise();
}
