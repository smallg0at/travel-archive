import { captureView, renderAlbum } from "./album";
import { loadIndex, SignInRequiredError } from "./archiveData";
import { getActiveAccount, signIn } from "./msAuth";
import { initGeneration } from "./tripMode";
import { initSidebarResize } from "./chrome";
import { setArchiveRefresh } from "./dayEdit";

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
  showMessage("Loading archive…");
  try {
    renderAlbum(await loadIndex());

    // Built once and kept: a finished job re-renders the album, and rebuilding
    // the panel would delete the result line the user is waiting to read — or a
    // half-filled form. The backend is optional and its health check runs after
    // first paint; absent simply means no Generate page, which is the phone's
    // experience and needs no separate code path.
    if (!panelMounted) {
      panelMounted = true;
      setArchiveRefresh(() => void loadAndRender());
      void initGeneration(() => void loadAndRender());
    }
  } catch (err) {
    if (err instanceof SignInRequiredError) {
      showSignInBanner();
      showMessage("Sign in to load your archive.");
      return;
    }
    showMessage(`Failed to load archive: ${(err as Error).message}`);
  }
}

async function main() {
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
  showMessage(`Failed to start: ${(err as Error).message}`);
});
