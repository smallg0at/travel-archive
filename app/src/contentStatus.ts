/**
 * Why photos are not appearing, said out loud.
 *
 * Before this existed a failed thumbnail was drawn as nothing at all: no cell
 * could distinguish "still loading" from "the fetch failed", so the reader had
 * no way to tell a bad network from a broken archive. On 2026-11-13 every
 * content read returned 401 from OneDrive's backend while metadata kept working
 * — the app showed an empty-looking library and no explanation.
 *
 * Two causes, deliberately kept apart because the reader's next move differs:
 * offline means "reconnect", a failed backend means "this is not us, check the
 * service". Both are read from the server's own remembered answer (`/health`
 * carries `content`), which costs one cheap request and no probe of the failing
 * image — asking a 15-second-failing URL again was slower than the failure it
 * was trying to explain.
 */
import { healthResult } from "./backend";
import { ui } from "./i18n";

export type ContentHealth = "ok" | "offline" | "remote";

let health: ContentHealth = "ok";
let banner: HTMLElement | null = null;
let probing = false;
let lastProbe = 0;
let lastFailureAt = 0;

/** A probe per half minute is enough: the state does not flip that fast. */
const PROBE_COOLDOWN_MS = 30_000;

export function contentHealth(): ContentHealth {
  return health;
}

function set(next: ContentHealth): void {
  if (health === next) return;
  health = next;
  render();
}

/** An image the server already knows it could not fetch: no probe needed. */
export function noteContentUnavailable(): void {
  lastFailureAt = Date.now();
  set("remote");
}

/** Classifies the failure behind one image, from the server's own report. */
export function noteImageFailure(): void {
  const now = Date.now();
  lastFailureAt = now;
  if (probing || now - lastProbe < PROBE_COOLDOWN_MS) return;
  probing = true;
  lastProbe = now;

  void healthResult()
    .then((result) => {
      if (!result.ok) {
        set("offline");
        return;
      }
      // `content` is optional: a server built before it existed says nothing,
      // and silence is not evidence of trouble.
      set(result.health.content === "unavailable" ? "remote" : "ok");
    })
    .catch(() => set("offline"))
    .finally(() => {
      probing = false;
    });
}

export function noteImageSuccess(): void {
  // A grid of 250 photos keeps loading while a handful fail: clearing on the
  // first success flickered the banner off again before anyone could read it
  // (reported within minutes of the first build). Only a quiet minute means the
  // trouble is over.
  if (health !== "ok" && Date.now() - lastFailureAt > 60_000) set("ok");
}

function render(): void {
  if (health === "ok") {
    banner?.remove();
    banner = null;
    return;
  }
  if (banner) {
    paint(banner);
    return;
  }
  banner = document.createElement("div");
  banner.className = "content-banner";
  paint(banner);
  document.body.appendChild(banner);
}

function paint(node: HTMLElement): void {
  node.replaceChildren();
  const text = document.createElement("span");
  text.textContent = health === "offline" ? ui.album.contentOffline : ui.album.contentRemote;
  node.appendChild(text);

  if (health === "remote") {
    // A plain anchor: the desktop shell already routes http(s) clicks to the
    // system browser, so this needs no new bridge.
    const link = document.createElement("a");
    link.href = "https://status.cloud.microsoft/";
    link.target = "_blank";
    link.rel = "noreferrer";
    link.className = "content-banner-action";
    link.textContent = ui.album.contentCheckStatus;
    node.appendChild(link);
  }
}
