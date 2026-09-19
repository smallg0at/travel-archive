import { loadContentTranslations, loadIndex, SignInRequiredError } from "../archiveData";
import { completeRedirect, getActiveAccount, signIn, signInRedirect } from "../msAuth";
import { checkHealth } from "../backend";
import { localServerSource, setThumbnailSource } from "../photoSource";
import { restorePrefs } from "../prefs";
import { readTheme, showTheme } from "../theme";
import { el } from "../photoUi";
import { ui } from "../i18n";
import { startRouter, switchTab, type Route, type Tab } from "./router";
import { renderHome } from "./home";
import { renderTrip, renderTrips } from "./trips";
import { renderDay } from "./day";
import { renderLibrary, renderMonth } from "./library";
import { renderSearch, renderSettings } from "./more";
import { ICONS, setArchive, spinner } from "./ui";
import { currentEtag, keepIndex, keptIndex } from "./cache";
import { followThemeInSystemBars, initBackButton, isNative, keepSignInAcrossLaunches } from "./native";

/** A popup where there can be one; the installed app always redirects — see signInRedirect. */
const signInNow = (): Promise<unknown> => (isNative ? signInRedirect() : signIn());

/**
 * The phone app: a separate page from the desktop's (index.html), sharing its
 * data layer and nothing of its layout.
 *
 * Separate because the two are different shapes of the same reader, not one
 * layout at two widths. The desktop is a sidebar and one long scrolling
 * document; this is tabs and a stack of pages. Squeezing the desktop down —
 * which is what the <=700px rules in style.css do — gets a sidebar turned
 * sideways, and was never going to become the other.
 *
 * View-only, by design (docs/design-brief.md): the phone reads the archive
 * from OneDrive and generates nothing. When a local job server happens to be
 * reachable — this page opened on the desktop, at /mobile/ — it is used the
 * same way the desktop uses it, which is what makes this page quick to work on.
 */

const screens = document.getElementById("m-screens")!;
const tabs = document.getElementById("m-tabs")!;
const banner = document.getElementById("m-banner")!;

const ROUTES: Route[] = [
  { pattern: /^\/$/, render: renderHome, tab: "home" },
  { pattern: /^\/trips$/, render: renderTrips, tab: "trips" },
  { pattern: /^\/library$/, render: renderLibrary, tab: "library" },
  { pattern: /^\/search$/, render: renderSearch, tab: "search" },
  { pattern: /^\/trip\/(.+)$/, render: ([id]) => renderTrip(id) },
  { pattern: /^\/day\/(\d{4}-\d{2}-\d{2})(?:\/(.+))?$/, render: ([date, stop]) => renderDay(date, stop) },
  { pattern: /^\/month\/(\d{4}-\d{2})$/, render: ([month]) => renderMonth(month) },
  { pattern: /^\/settings$/, render: renderSettings },
];

function buildTabs(): (tab: Tab) => void {
  const buttons = new Map<Tab, HTMLButtonElement>();
  for (const tab of ["home", "trips", "library", "search"] as Tab[]) {
    const button = el<HTMLButtonElement>(`<button type="button" class="m-tab">${ICONS[tab]}<span></span></button>`);
    button.querySelector("span")!.textContent = ui.mobile.tabs[tab];
    button.addEventListener("click", () => switchTab(tab));
    buttons.set(tab, button);
    tabs.appendChild(button);
  }
  tabs.hidden = false;
  return (active) => {
    for (const [tab, button] of buttons) {
      button.classList.toggle("is-active", tab === active);
      if (tab === active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  };
}

function message(text: string): void {
  screens.replaceChildren(el(`<div class="m-center"></div>`));
  screens.firstElementChild!.appendChild(Object.assign(document.createElement("p"), { className: "m-note", textContent: text }));
}

/**
 * Signed out: one screen, one button. The button has to be a real click —
 * `signIn` opens a popup first, and browsers only allow that from a gesture.
 * Inside the native app the popup is refused and MSAL falls back to a full
 * redirect through /auth/, which returns to this page already signed in.
 */
function signInScreen(): void {
  const view = el<HTMLElement>(`
    <div class="m-center m-signin">
      <div class="m-signin-mark">${ICONS.home}</div>
      <h1></h1><p></p>
      <button type="button" class="m-primary"></button>
    </div>
  `);
  view.querySelector("h1")!.textContent = ui.mobile.signInTitle;
  view.querySelector("p")!.textContent = ui.mobile.signInLead;
  const button = view.querySelector<HTMLButtonElement>("button")!;
  button.textContent = ui.app.signInButton;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await signInNow();
      await start();
    } catch (err) {
      console.error("Sign-in failed:", err);
      button.disabled = false;
    }
  });
  screens.replaceChildren(view);
}

/** A bar across the top with one action. The page under it stays as it is. */
function showBanner(text: string, action: string, onAction: () => void): void {
  if (!banner.hidden) return;
  const button = Object.assign(el<HTMLButtonElement>(`<button type="button"></button>`), { textContent: action });
  button.addEventListener("click", onAction);
  banner.replaceChildren(Object.assign(document.createElement("span"), { textContent: text }), button);
  banner.hidden = false;
}

/**
 * An expired session in the middle of reading. Renewing needs a click, so the
 * bar offers one; reloading afterwards is the simple way to retry every
 * thumbnail and shard that failed while signed out.
 */
function showSessionBanner(): void {
  // Offline, a token cannot be renewed either, so every uncached thumbnail
  // reports "sign in" — which would tell a reader on a plane that their
  // session had expired. Say what is actually true, and offer a retry.
  if (!navigator.onLine) {
    showBanner(ui.mobile.offline, ui.mobile.refresh, () => location.reload());
    return;
  }
  showBanner(ui.mobile.sessionExpired, ui.mobile.signInAgain, async () => {
    try {
      await signInNow();
      location.reload();
    } catch (err) {
      console.error("Sign-in failed:", err);
    }
  });
}

/**
 * After painting from the kept index: is it still the one in OneDrive? If
 * not, fetch the new one now and keep it, and offer a refresh — the next
 * launch opens on it either way.
 */
async function revalidate(keptEtag: string | null): Promise<void> {
  const etag = await currentEtag();
  if (!etag || etag === keptEtag) return;
  const fresh = await loadIndex().catch(() => null);
  if (!fresh) return;
  await keepIndex(fresh, etag);
  showBanner(ui.mobile.archiveUpdated, ui.mobile.refresh, () => location.reload());
}

let started = false;
/**
 * Whether to open on the kept index. Not when a local server answers — this
 * page opened on the desktop — since its mirror is current and ~34ms away,
 * and that browser often holds no Microsoft session to ask for an eTag with,
 * so a kept copy could never be found stale.
 */
let useKept = true;

async function start(): Promise<void> {
  const kept = useKept ? await keptIndex() : null;
  if (kept) {
    // Open on the kept copy — see cache.ts. The translations are small and
    // still fetched, so a Chinese reader's first screen is in Chinese.
    await loadContentTranslations().catch(() => {});
    setArchive(kept.index);
    void revalidate(kept.etag);
    // The kept copy opens without asking Microsoft anything, so a lost sign-in
    // would otherwise show only as pictures that never arrive and a map that
    // says there are no places. Say so up front.
    void getActiveAccount().then((account) => {
      if (!account) showSessionBanner();
    });
  } else {
    screens.replaceChildren(el(`<div class="m-center"></div>`));
    screens.firstElementChild!.appendChild(spinner());
    try {
      // The eTag alongside, not after: it is what the next launch compares
      // against, and asking once the index has landed would add a round trip.
      const [index, , etag] = await Promise.all([loadIndex(), loadContentTranslations(), currentEtag()]);
      setArchive(index);
      void keepIndex(index, etag);
    } catch (err) {
      if (err instanceof SignInRequiredError) {
        signInScreen();
        return;
      }
      message(ui.app.failedToLoad((err as Error).message));
      return;
    }
  }
  if (started) return;
  started = true;
  screens.replaceChildren();
  document.title = ui.app.title;
  startRouter({ routes: ROUTES, host: screens, onTab: buildTabs() });
}

async function main(): Promise<void> {
  // First, before anything asks for a token: this load may be the return from
  // a redirect sign-in that MSAL left for this page to finish (msAuth.ts).
  await completeRedirect().catch((err) => console.error("Sign-in could not be completed:", err));
  // In the installed app, Microsoft returns to /auth/, and Capacitor serves
  // this page there too (its html5 fallback maps any extensionless path to
  // index.html). Once the response is handled, be at the root again — a
  // cancelled sign-in lands on the sign-in screen, not on a leftover path.
  if (location.pathname.startsWith("/auth")) history.replaceState(null, "", "/");
  keepSignInAcrossLaunches();
  initBackButton();
  followThemeInSystemBars();
  window.addEventListener("signin-required", showSessionBanner);

  // In a browser, the same two questions the desktop asks first, together: is
  // there a server to restore settings from, and to take thumbnails from.
  // The installed app skips both — its WebView is served from
  // https://localhost, and a request to http://127.0.0.1 is mixed content it
  // may not make at all.
  if (!isNative) {
    const [restored, health] = await Promise.all([restorePrefs(), checkHealth()]);
    if (restored.theme) showTheme(readTheme());
    if (health?.ok) {
      setThumbnailSource(localServerSource);
      useKept = false;
    }
  }

  // Load first and ask second, as the desktop does: no account is not the same
  // as nothing to read, since a signed-in local server serves the whole
  // archive. `start` shows the sign-in screen only when loading needs it.
  await start();
}

main().catch((err) => {
  console.error(err);
  message(ui.app.failedToStart((err as Error).message));
});
