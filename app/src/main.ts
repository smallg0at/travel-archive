import { captureView, refreshDensity, renderAlbum } from "./album";
import {
  forgetAllMonths,
  forgetHomeIndex,
  forgetIndex,
  forgetSearchIndex,
  loadContentTranslations,
  loadIndex,
  SignInRequiredError,
} from "./archiveData";
import { getActiveAccount, signIn } from "./msAuth";
import { isLocalMachine } from "./backend";
import { initGeneration } from "./tripMode";
import { initSidebarNav, initSidebarResize } from "./chrome";
import { setArchiveRefresh } from "./dayEdit";
import { setActivityRefresh } from "./activity";
import { ui } from "./i18n";
import { restorePrefs } from "./prefs";
import { setupNeeded, showSetup } from "./setup";
import { readTheme, showTheme } from "./theme";
import { healthResult } from "./backend";
import { localServerSource, setThumbnailSource } from "./photoSource";
import { initServerStatus } from "./serverStatus";
import { initSearch, runSearch } from "./searchBar";
import { requireAccess } from "./gate";

let panelMounted = false;

/**
 * Whether the local job server holds its own Microsoft session.
 *
 * Set from the single health read at startup. When it is true the server serves
 * the metadata from the mirror and the images from `/thumb`, so the renderer
 * needs no Microsoft session of its own — and a read that fails there is a gap
 * in the mirror, not a missing sign-in.
 */
let serverHasGraph = false;

function showSignInBanner(): void {
  document.getElementById("signin-banner")!.hidden = false;
}
function hideSignInBanner(): void {
  document.getElementById("signin-banner")!.hidden = true;
}

function showMessage(html: string): void {
  const content = document.getElementById("content")!;
  content.replaceChildren();
  const div = document.createElement("div");
  div.className = "loading";
  div.textContent = html;
  content.appendChild(div);
}

/**
 * Unlike the previous build, there's nothing to show before sign-in: the
 * index and photo shards live in OneDrive and are fetched at runtime (see
 * archiveData.ts), so a signed-out app has no archive to render rather than
 * text-without-images.
 */
async function loadAndRender(): Promise<void> {
  // Before the placeholder replaces #content and takes its scroll offset with
  // it — a reload after a job should put the reader back, not at the top of
  // the newest trip.
  captureView();
  showMessage(ui.app.loadingArchive);
  // Every caller of this is a reload — after a job, a day edit, a sign-in — so
  // the session copies go here, in one place, rather than at each caller.
  // Search and the map index were never forgotten at all before: after a
  // collect added 1,164 captions, search kept answering from the old ones.
  forgetIndex();
  forgetSearchIndex();
  forgetHomeIndex();
  try {
    // Together, not one after the other: the second language's text is small
    // and neither needs the other to start.
    const [index] = await Promise.all([loadIndex(), loadContentTranslations()]);
    renderAlbum(index);

    // Built once and kept: a finished job re-renders the album, and rebuilding
    // the panel would delete the result line the user is waiting to read — or a
    // half-filled form. The backend is optional and its health check runs after
    // first paint; absent simply means no Generate page, which is the phone's
    // experience and needs no separate code path.
    if (!panelMounted) {
      panelMounted = true;
      setArchiveRefresh(() => void loadAndRender());
      // After a job, every cached month may be stale — see forgetAllMonths.
      // The day editor above knows its months and forgets only those.
      const afterJob = () => {
        forgetAllMonths();
        void loadAndRender();
      };
      setActivityRefresh(afterJob);
      void initGeneration(afterJob);
    }
  } catch (err) {
    if (err instanceof SignInRequiredError) {
      // With the server signed in, a Microsoft session in the renderer is not
      // what is missing: it is a month the mirror has not got yet, which the
      // server is fetching as we speak. Prompting for a sign-in there is a lie
      // the owner reads as "am I signed in or not?" (reported 2026-10-14).
      if (serverHasGraph) {
        showMessage(ui.app.loadGap);
        return;
      }
      showSignInBanner();
      showMessage(ui.app.signInToLoadArchive);
      return;
    }
    showMessage(ui.app.failedToLoad((err as Error).message));
  }
}

/**
 * The static page's own words. `index.html` keeps its English for the moment
 * before this runs; from here on they are in the reader's language.
 */
function localiseShell(): void {
  document.title = ui.app.title;
  document.querySelector("#signin-banner span")!.textContent = ui.app.signInPrompt;
  document.getElementById("signin-button")!.textContent = ui.app.signInButton;
  document.getElementById("sidebar-resize")!.title = ui.app.resizeHandle;
  const lbBack = document.getElementById("lightbox-back");
  if (lbBack) {
    lbBack.setAttribute("aria-label", ui.common.back ?? "Back");
    lbBack.title = `${ui.common.back ?? "Back"} (Esc)`;
    const textNode = lbBack.querySelector(".lightbox-back-text");
    if (textNode) textNode.textContent = ui.common.back ?? "Back";
  }
  const zoom = document.getElementById("lightbox-zoom")!;
  zoom.querySelector('[data-zoom="out"]')!.setAttribute("aria-label", ui.viewer.zoomOut);
  zoom.querySelector('[data-zoom="in"]')!.setAttribute("aria-label", ui.viewer.zoomIn);
  zoom.querySelector('[data-zoom="fit"]')!.textContent = ui.common.fit;
  // A bare text node after the spinner's <span>, which is the spinning mark.
  document.getElementById("lightbox-spinner")!.lastChild!.textContent = ui.viewer.loadingFull;
}

async function main() {
  // Before the first render, and before anything is read from the server: a
  // gated server answers 401 to everything, so the password has to be settled
  // first. Anything drawn earlier would be an app whose photographs cannot
  // load — and a reconcile that ran before this would see 401 for every value
  // and conclude the archive holds none, which is how a remote reader ended up
  // on its own language until something made it reload.
  await requireAccess();

  // Then the settings, before anything paints with one. The browser's copy of
  // these was being lost on every launch of the desktop shell — see prefs.ts —
  // and the job server's copy is what puts them back. With no server this
  // answers immediately with nothing to do, which is the phone's path.
  //
  // Only the theme and the density need re-applying: their modules read the
  // setting while they loaded, which was before this could have answered. The
  // sidebar width is read by `initSidebarResize` below, the open nav groups
  // when the nav is built, and the content language is applied in place.
  //
  // Together with the health check, and not one after the other: both are
  // requests to a server that is usually not there, and an absent one that
  // *drops* rather than refuses costs the full 1.5s timeout each. Neither
  // needs the other.
  const [restored, health] = await Promise.all([restorePrefs(), healthResult()]);
  if (restored.theme) showTheme(readTheme());
  if (restored.density) refreshDensity();

  /**
   * Where photos come from, decided before the first render rather than after
   * it.
   *
   * `initGeneration` also sets this, but it runs after `renderAlbum`, so the
   * first screen's thumbnails resolved against the Graph path — which needs a
   * token the renderer may not have, and which raises the sign-in banner when
   * it does not. On the desktop shell the server can serve every one of those
   * images from its own disk cache without the renderer holding any Microsoft
   * session at all.
   *
   * `initGeneration`'s own health check stays: it is a loopback request in the
   * same machine, and sharing this one would mean attaching to a snapshot of
   * the running job taken before the archive had even loaded.
   */
  if (health.ok) setThumbnailSource(localServerSource);

  localiseShell();
  initSidebarResize();
  initSidebarNav();
  initServerStatus(health.ok, health.ok ? null : health.failure);

  // The title-bar search, on every view, and the one handler for a tag clicked
  // anywhere — including from the lightbox, which is what closes it.
  initSearch();
  document.addEventListener("tag-search", (event) => {
    const tag = (event as CustomEvent<string>).detail;
    if (typeof tag === "string" && tag) runSearch(tag);
  });

  // Photo/shard loads that hit an expired session ask for a re-auth click
  // via this event rather than popping a popup themselves — browsers block
  // popups that don't originate from a user gesture.
  window.addEventListener("signin-required", () => {
    // Only the reader's own Graph use raises this; when the server can serve it
    // means a mirror gap, so the banner stays away.
    if (!serverHasGraph) showSignInBanner();
  });

  document.getElementById("signin-button")!.addEventListener("click", async () => {
    try {
      await signIn();
      hideSignInBanner();
      await loadAndRender();
    } catch (err) {
      console.error("Sign-in failed:", err);
    }
  });

  // No account is not the same as nothing to show. When the local job server
  // is running it holds a byte-identical mirror of the archive and `loadIndex`
  // prefers it, so a signed-out desktop can still read everything — this used
  // to stop at the banner with the whole archive sitting on disk. Offer the
  // sign-in, then try anyway: with no mirror the load raises
  // SignInRequiredError and lands on exactly the same banner.
  //
  // And do not offer it at all when the server is signed in itself: it then
  // supplies the metadata from the mirror and the images from `/thumb`, so the
  // renderer needs no Microsoft session of its own and asking for one is
  // asking for something nothing will use. That was the whole of "I have to
  // sign in to Microsoft every time" — MSAL's cache lives in the same
  // localStorage that was being lost, while the pipeline's own token cache is
  // a file and was never affected. Anything that genuinely still needs Graph
  // — a month with no mirror — raises SignInRequiredError and the banner
  // appears then.
  //
  // **On another machine this is not a question at all.** MSAL cannot even
  // initialise there: it needs `crypto.subtle`, which browsers only provide in
  // a secure context, and `http://192.168.x.y` is not one — the failure is
  // `crypto_nonexistent` before anything is asked. It does not need to: a
  // remote reader is served by a signed-in job server and never talks to Graph,
  // so the Microsoft session is neither available nor wanted.
  if (isLocalMachine) {
    serverHasGraph = health.ok && health.health.signedIn;
    if (!serverHasGraph && !(await getActiveAccount())) showSignInBanner();
  }

  // A fresh archive is configured before it is drawn: with no scan there is no
  // index to show, and the wizard's last page is what runs that scan. Only
  // when the server itself is answering — it computes the state, and a wizard
  // whose every step talks to it cannot start against a dead one. On the phone
  // (no server) and for a remote reader this is false and nothing changes.
  if (health.ok && (await setupNeeded())) {
    showSetup({ onDone: () => void loadAndRender() });
  } else {
    await loadAndRender();
  }
}

main().catch((err) => {
  console.error(err);
  showMessage(ui.app.failedToStart((err as Error).message));
});
