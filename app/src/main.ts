import { captureView, renderAlbum } from "./album";
import { forgetAllMonths, loadContentTranslations, loadIndex, SignInRequiredError } from "./archiveData";
import { getActiveAccount, signIn } from "./msAuth";
import { initGeneration } from "./tripMode";
import { initSidebarResize } from "./chrome";
import { setArchiveRefresh } from "./dayEdit";
import { setActivityRefresh } from "./activity";
import { ui } from "./i18n";

let panelMounted = false;

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
  document.getElementById("lightbox-close")!.setAttribute("aria-label", ui.common.close);
  const zoom = document.getElementById("lightbox-zoom")!;
  zoom.querySelector('[data-zoom="out"]')!.setAttribute("aria-label", ui.viewer.zoomOut);
  zoom.querySelector('[data-zoom="in"]')!.setAttribute("aria-label", ui.viewer.zoomIn);
  zoom.querySelector('[data-zoom="fit"]')!.textContent = ui.common.fit;
  // A bare text node after the spinner's <span>, which is the spinning mark.
  document.getElementById("lightbox-spinner")!.lastChild!.textContent = ui.viewer.loadingFull;
}

async function main() {
  localiseShell();
  initSidebarResize();

  // Photo/shard loads that hit an expired session ask for a re-auth click
  // via this event rather than popping a popup themselves — browsers block
  // popups that don't originate from a user gesture.
  window.addEventListener("signin-required", showSignInBanner);

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
  if (!(await getActiveAccount())) showSignInBanner();

  await loadAndRender();
}

main().catch((err) => {
  console.error(err);
  showMessage(ui.app.failedToStart((err as Error).message));
});
