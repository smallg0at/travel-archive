import type { Highlight, PhotoRecord } from "@travel-archive/shared";
import { loadFullPhoto, loadLarge, loadVideoUrl, releaseFullPhoto } from "./graphPhoto";
import { canCopyImage, copyImage } from "./clipboard";
import { currentBaseView, photoHash, resolveSession, splitPhoto } from "./photoRoute";
import { isLocalMachine } from "./backend";
import { thumbnailSource } from "./photoSource";
import { el, tagChip, transcript, transcriptOriginal } from "./photoUi";
import { addPhotoTimeControl } from "./dayEdit";
import { screenCaptionSlot } from "./screenCaptions";
import { loc } from "./contentLang";
import { fmtDateTime, ui } from "./i18n";

/**
 * The photo viewer, opened from a card rather than from a single image.
 *
 * A card is the unit the archive actually curates — one subject, its
 * description, the placard that explains it and one to three photographs of it.
 * Opening a lone image threw all of that away at the moment someone was looking
 * closest: the caption they had just read vanished, and the other photos of the
 * same thing became unreachable without closing and clicking again.
 *
 * So the right column carries both contexts at once — what the *card* is about
 * above, what *this photograph* is below — and the card's other images sit in a
 * strip beneath, one click away.
 */

const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/**
 * Point an image at a job-server URL, with the credentials the gate requires.
 *
 * The lightbox is a **different origin** from the page — the shell serves the
 * app on one port and the job server answers on another — so an ordinary
 * `<img src>` sends no cookie: cross-origin image requests default to
 * `same-origin` credentials. On the owner's machine the request is loopback and
 * `isLocal` admits it anyway, so this was invisible until a family member opened
 * the archive over the network and got a grid, then a viewer, of broken images
 * with nothing on screen to explain them.
 *
 * `use-credentials` is the only value that both sends the cookie and keeps the
 * response CORS-clean, which the print export's canvas still needs.
 *
 * **Before `src`, always** — setting it afterwards has no effect on a load
 * already under way.
 */
function setSource(img: HTMLImageElement, url: string): void {
  const crossOrigin = thumbnailSource()?.crossOrigin;
  if (crossOrigin) img.crossOrigin = crossOrigin;
  img.src = url;
}

/** Bumped on every open and every switch, so a slow load cannot paint over what replaced it. */
let token = 0;

/** The full-size object URL on screen, held so it can be revoked on close. */
let openObjectUrl: string | null = null;

interface Session {
  photos: PhotoRecord[];
  index: number;
  highlight: Highlight | null;
}
let session: Session | null = null;

// --- Copying ---------------------------------------------------------------

/**
 * Whether this page can put a photograph on the clipboard at all.
 *
 * Asked once: an insecure origin — the archive read over the home network as
 * plain http — has no `navigator.clipboard`, and a browser without PNG
 * clipboard support cannot gain it while the page is open. When it is false the
 * control is not rendered at all: a button that can never work is a permanent
 * question with no answer.
 */
const copySupported = canCopyImage();

/** What the copy button is saying, and the timer that puts it back. */
type CopyState = "idle" | "working" | "done" | "failed";
let copyState: CopyState = "idle";
let copyTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Resolves when the photograph on screen is the original rather than the
 * preview, or when waiting for it has stopped being worth it.
 *
 * The viewer paints the `large` thumbnail first and swaps the original in
 * behind it. Copying inside that window would hand over an 800px preview of a
 * 12-megapixel photograph and still say "copied" — a downgrade the reader
 * cannot see, and the one failure worth engineering against. So the copy waits
 * for the swap, bounded by something long enough for a cold original to arrive
 * over the network; past that, what is on screen is what gets copied.
 */
const FULL_WAIT_MS = 10_000;
let fullReady: Promise<void> = Promise.resolve();
let settleFull: (() => void) | null = null;

/** Starts the wait afresh for the photograph about to be shown. */
function resetFullWait(): void {
  settleFull = null;
  fullReady = new Promise<void>((resolve) => {
    settleFull = resolve;
  });
}

function setCopyState(state: CopyState): void {
  copyState = state;
  const { copy } = dom();
  copy.dataset.state = state;
  copy.querySelector(".lightbox-copy-label")!.textContent =
    state === "working"
      ? ui.viewer.copying
      : state === "done"
        ? ui.viewer.copied
        : state === "failed"
          ? ui.viewer.copyFailed
          : ui.viewer.copy;
  // Disabled while working: a second click would start a second encode of the
  // same photograph, and the label is the only thing that says so.
  copy.disabled = state === "working";
  if (copyTimer) {
    clearTimeout(copyTimer);
    copyTimer = null;
  }
  // Back to the plain label on its own. A toast would be the obvious
  // alternative, but the toast stack sits at z-index 60 under a lightbox at
  // 1000 — the confirmation has to happen where the click did.
  if (state === "done" || state === "failed") {
    copyTimer = setTimeout(() => setCopyState("idle"), state === "done" ? 1600 : 2600);
  }
}

/** Waits for the original to replace the preview, but never forever. */
function waitForOriginal(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, FULL_WAIT_MS);
  });
  return Promise.race([fullReady, bound]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Copies the photograph the viewer is showing. */
async function copyCurrent(): Promise<void> {
  if (!session || copyState === "working") return;
  const photo = session.photos[session.index];
  if (!photo || photo.video) return;

  const mine = token;
  setCopyState("working");
  try {
    // The wait runs inside the clipboard item's promise rather than before the
    // write: the write has to happen while the click still counts as a gesture,
    // and a cold original can take longer than that. A reader who stepped on in
    // the meantime makes it reject instead of copying the wrong photograph.
    const original = waitForOriginal().then(() => {
      if (mine !== token) throw new Error("the viewer moved on");
    });
    await copyImage(dom().img, original);
    setCopyState("done");
  } catch (error) {
    // The label belongs to whatever is on screen now; `show` has already reset
    // it, and saying "couldn't copy" about a photograph the reader left would
    // be a lie about the one they are looking at.
    if (mine !== token) return;
    // A refused write (another app holding the clipboard, a document that lost
    // focus) and a tainted canvas both land here. Say so and leave it there.
    console.error("copying the photograph failed", error);
    setCopyState("failed");
  }
}

function dom() {
  return {
    lightbox: document.getElementById("lightbox")!,
    img: document.getElementById("lightbox-img") as HTMLImageElement,
    video: document.getElementById("lightbox-video") as HTMLVideoElement,
    spinner: document.getElementById("lightbox-spinner")!,
    cardPanel: document.getElementById("lightbox-card")!,
    photoPanel: document.getElementById("lightbox-photo")!,
    strip: document.getElementById("lightbox-strip")!,
    zoom: document.getElementById("lightbox-zoom")!,
    copy: document.getElementById("lightbox-copy") as HTMLButtonElement,
  };
}

function metaLine(photo: PhotoRecord): string {
  const parts: string[] = [];
  if (photo.takenAt) {
    parts.push(
      fmtDateTime(new Date(photo.takenAt), {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
        // A clock the archive does not trust is not shown. Phone sync on this
        // library shifts times by hours; the day is usually right, the hour not.
        hour: photo.timeSuspect ? undefined : "2-digit",
        minute: photo.timeSuspect ? undefined : "2-digit",
        // The camera's clock, unshifted. `takenAt` holds the wall-clock time
        // with UTC digits — EXIF and filename alike (27,458 of 27,645 EXIF
        // photos match their filename stamp to the minute) — and stop headings
        // slice it raw. Formatting it for the reader's zone made the same
        // photo read 12:49 under its stop and 13:49 here.
        timeZone: "UTC",
      }),
    );
  }
  if (photo.place) parts.push(photo.place);
  return parts.join(" · ");
}

/** Everything the *card* says: its title, its description, and its placard. */
function renderCardPanel(highlight: Highlight | null, byId: Record<string, PhotoRecord>): void {
  const { cardPanel } = dom();
  cardPanel.replaceChildren();
  if (!highlight) {
    cardPanel.hidden = true;
    return;
  }
  cardPanel.hidden = false;

  const title = document.createElement("h3");
  title.textContent = loc(highlight.title);
  cardPanel.appendChild(title);

  if (highlight.description) {
    const desc = document.createElement("p");
    desc.className = "viewer-desc";
    desc.textContent = loc(highlight.description);
    cardPanel.appendChild(desc);
  }

  // The English rendering of a placard, which is the useful half for an owner
  // who does not read the language it was written in.
  if (highlight.documentTranslation) {
    const quote = document.createElement("p");
    quote.className = "viewer-placard";
    quote.textContent = loc(highlight.documentTranslation);
    cardPanel.appendChild(quote);
  }

  const sources = highlight.documentPhotoIds
    .map((id) => byId[id])
    .filter((p) => p?.extractedText)
    .map((p) => p.extractedText as string);
  if (sources.length > 0) {
    const block = document.createElement("div");
    block.className = "viewer-block";
    const label = document.createElement("h4");
    label.textContent = ui.day.fromPlacards(sources.length);
    const body = document.createElement("div");
    const shown = transcript(sources);
    body.textContent = shown.shown;
    block.append(label, body);
    if (shown.original) block.appendChild(transcriptOriginal(shown.original, ui.day.originalText));
    cardPanel.appendChild(block);
  }
}

/** Everything *this photograph* says: its own caption, time, place and transcript. */
function renderPhotoPanel(photo: PhotoRecord): void {
  const { photoPanel } = dom();
  photoPanel.replaceChildren();

  const heading = document.createElement("h4");
  heading.className = "viewer-section-label";
  heading.textContent = ui.viewer.thisPhoto;
  photoPanel.appendChild(heading);

  if (photo.caption) {
    const cap = document.createElement("p");
    cap.className = "viewer-caption";
    cap.textContent = loc(photo.caption);
    photoPanel.appendChild(cap);
  }

  // The description of a withheld screenshot, in the place the caption would
  // be. It was written by a model on this machine and says only what kind of
  // screen the photograph is — nothing on it — so it is shown as the photo's
  // own words about itself, and only when this reader holds the passphrase.
  // The line fills itself in when the descriptions open, if they were not
  // open yet when this photo was opened.
  const screen = screenCaptionSlot(photo.id);
  screen.classList.add("viewer-caption");
  photoPanel.appendChild(screen);

  const meta = metaLine(photo);
  if (meta) {
    const line = document.createElement("p");
    line.className = "viewer-meta";
    line.textContent = meta;
    photoPanel.appendChild(line);
  }

  // The photo's tags, as chips. Each one searches for itself, which is the only
  // thing a tag is for — "show me the other Elizabeth line pictures" was
  // otherwise a query the reader had to type from the tag they could not see.
  if (photo.tags?.length) {
    const block = document.createElement("div");
    block.className = "viewer-block viewer-tags";
    const label = document.createElement("h4");
    label.textContent = ui.viewer.tags;
    const list = document.createElement("div");
    list.className = "tag-list";
    for (const tag of photo.tags) list.appendChild(tagChip(tag));
    block.append(label, list);
    photoPanel.appendChild(block);
  }

  // Re-render this panel rather than the whole archive: a correction is one
  // photo, and reloading between each of 123 of them closes the viewer.
  addPhotoTimeControl(photoPanel, photo, () => renderPhotoPanel(photo));

  if (photo.extractedText) {
    const block = document.createElement("div");
    block.className = "viewer-block viewer-transcript";
    const label = document.createElement("h4");
    label.textContent = ui.viewer.transcribed;
    const body = document.createElement("div");
    const shown = transcript([photo.extractedText]);
    body.textContent = shown.shown;
    block.append(label, body);
    if (shown.original) block.appendChild(transcriptOriginal(shown.original, ui.day.originalText));
    photoPanel.appendChild(block);
  }
}

/** The card's other photographs. Hidden when there is only one. */
/**
 * How many thumbnails the strip draws at once — as many as fit beside the
 * control bar, between 3 and 12.
 *
 * The archive's days hold a median of 3 photographs and a maximum of 382 (p90
 * 30, p99 238 over 2,076 days), and a stop's grid is similar. Drawing the whole
 * set meant 30,000px of horizontal scroll, one thumbnail request per
 * photograph, and a strip whose current frame was off screen — the reader was
 * looking at photograph 150 of 219 with the strip showing the first dozen.
 */
const STRIP_THUMB_STEP = 62;

function stripCapacity(): number {
  const strip = document.getElementById("lightbox-strip");
  const width = strip?.clientWidth ?? 324;
  return Math.max(2, Math.min(8, Math.floor((width - 8) / STRIP_THUMB_STEP)));
}

/** Where the current window starts, or -1 when it has to be chosen afresh. */
let stripStart = -1;
/** The session the window belongs to: a new one starts its own window. */
let stripSession: unknown = null;

function centreStrip(track: HTMLElement, offset: number): void {
  const current = track.children[offset] as HTMLElement | undefined;
  if (current) track.scrollLeft = current.offsetLeft - (track.clientWidth - current.offsetWidth) / 2;
}

function renderStrip(): void {
  const { strip } = dom();
  if (!session || session.photos.length < 2) {
    strip.hidden = true;
    strip.replaceChildren();
    stripStart = -1;
    return;
  }
  strip.hidden = false;

  const total = session.photos.length;
  const at = session.index;
  const windowSize = Math.min(total, stripCapacity());
  if (stripSession !== session) {
    stripSession = session;
    stripStart = -1;
  }
  // The window stays put while the reader steps inside it, and re-centres only
  // when they reach its edge: re-laying out a dozen thumbnails on every arrow
  // press would flash the whole strip to reload for one changed highlight.
  let start: number;
  if (total <= windowSize) {
    start = 0;
  } else if (stripStart < 0 || at < stripStart + 2 || at > stripStart + windowSize - 3) {
    start = Math.max(0, Math.min(total - windowSize, at - Math.floor(windowSize / 2)));
  } else {
    start = stripStart;
  }
  const end = Math.min(total, start + windowSize);

  const track = strip.querySelector<HTMLElement>(".strip-track");
  if (track && stripStart === start && track.childElementCount === end - start) {
    [...track.children].forEach((el, i) => el.classList.toggle("current", start + i === at));
    const count = strip.querySelector(".strip-count");
    if (count) count.textContent = `${at + 1} / ${total}`;
    centreStrip(track, at - start);
    return;
  }

  stripStart = start;
  strip.replaceChildren();
  const fresh = document.createElement("div");
  fresh.className = "strip-track";
  for (let i = start; i < end; i++) {
    const photo = session.photos[i];
    const thumb = document.createElement("img");
    thumb.src = BLANK;
    thumb.alt = loc(photo.caption) ?? "";
    thumb.className = i === at ? "current" : "";
    void loadLarge(photo.id).then((url) => {
      if (url) setSource(thumb, url);
    });
    thumb.addEventListener("click", (event) => {
      event.stopPropagation();
      void show(i);
    });
    fresh.appendChild(thumb);
  }
  // Which photograph of how many, above the strip and against its left edge, so
  // the count reads as a caption for the row rather than as one more item in it.
  // Left off when the window is the whole set: "2 / 2" is noise.
  if (total > windowSize) {
    const count = document.createElement("span");
    count.className = "strip-count";
    count.textContent = `${at + 1} / ${total}`;
    strip.appendChild(count);
  }
  strip.appendChild(fresh);

  // Centre the current frame once the row has been laid out, or the strip opens
  // scrolled to its left end whatever is on screen.
  centreStrip(fresh, at - start);
}

// --- Zoom ------------------------------------------------------------------

let scale = 1;
let panX = 0;
let panY = 0;

/** The photograph's size when fitted, measured once per image at 100%. */
let baseW = 0;
let baseH = 0;

function measureBase(): void {
  const { img } = dom();
  const r = img.getBoundingClientRect();
  if (r.width > 0) {
    baseW = r.width;
    baseH = r.height;
  }
}

/**
 * Zoom by changing the rendered size, not with `transform: scale()`.
 *
 * A scaled transform promotes the photo to a composited layer that is
 * rasterised once and stretched by the GPU, and its tile boundaries then show
 * as thin horizontal and vertical lines across the picture — clearly visible at
 * 506% on a 3072x4096 image. Giving the element a real width makes the browser
 * resample from the source instead, which removes the seams and is sharper at
 * high zoom, which is the whole point of zooming.
 *
 * Panning stays a transform, snapped to whole device pixels: a fractional
 * offset resamples across pixel boundaries and softens the image for no reason.
 */
function applyZoom(): void {
  const { img, zoom } = dom();
  const dpr = window.devicePixelRatio || 1;
  const snap = (v: number) => Math.round(v * dpr) / dpr;

  if (scale === 1) {
    img.style.width = "";
    img.style.height = "";
    img.style.maxWidth = "";
    img.style.maxHeight = "";
    img.style.transform = "";
  } else {
    if (baseW === 0) measureBase();
    img.style.maxWidth = "none";
    img.style.maxHeight = "none";
    img.style.width = `${Math.round(baseW * scale)}px`;
    img.style.height = `${Math.round(baseH * scale)}px`;
    img.style.transform = `translate3d(${snap(panX)}px, ${snap(panY)}px, 0)`;
  }

  img.style.cursor = scale > 1 ? "grab" : "";
  // The 4px radius is a mask, and once zoomed the stage clips the photo square
  // anyway — a rounded photo inside a square frame is just a mismatch.
  img.classList.toggle("zoomed", scale > 1);
  // Zoomed, the strip steps out of the way: the reader is inspecting pixels,
  // and 76px of thumbnails along the bottom is 76px not spent on the
  // photograph. Faded rather than hidden, so the stage grows and the layout
  // settles instead of the strip vanishing under the cursor.
  dom().lightbox.classList.toggle("is-zoomed", scale > 1);
  zoom.querySelector(".zoom-level")!.textContent = `${Math.round(scale * 100)}%`;
}

/**
 * `anchor` is a point on screen that should stay over the same part of the
 * photo — the cursor, for the wheel. Without it zoom grew from the centre, so
 * zooming in on a sign at the edge pushed the sign off the screen. The photo
 * is centred in the stage and grows evenly about its centre, so a point `d`
 * from that centre lands `d·k` from it; moving the pan by `d·(1-k)` puts it back.
 */
function setZoom(next: number, anchor?: { x: number; y: number }): void {
  const clamped = Math.min(6, Math.max(1, next));
  if (anchor && clamped > 1 && clamped !== scale) {
    const r = dom().img.getBoundingClientRect();
    const k = clamped / scale;
    panX += (anchor.x - (r.left + r.width / 2)) * (1 - k);
    panY += (anchor.y - (r.top + r.height / 2)) * (1 - k);
  }
  // Zooming in from the fitted view: measure it now rather than trusting a size
  // taken when the photograph loaded. The stage is taller while zoomed (the
  // strip has faded away) and different again after a window resize, so a base
  // measured once goes stale and the first zoom step jumps.
  if (scale === 1 && clamped > 1) measureBase();
  scale = clamped;
  // Snapping back to centre at 1x avoids the photo being stuck off-screen after
  // panning and then zooming out.
  if (scale === 1) {
    panX = 0;
    panY = 0;
  }
  applyZoom();
}

function initZoomControls(): void {
  const { zoom, img, copy } = dom();
  if (zoom.dataset.wired === "1") return;
  zoom.dataset.wired = "1";

  copy.title = ui.viewer.copyTitle;
  copy.setAttribute("aria-label", ui.viewer.copyTitle);

  zoom.addEventListener("click", (event) => {
    event.stopPropagation();
    const target = event.target as HTMLElement;
    // The copy button carries an icon, so the click often lands on the `<svg>`
    // rather than the button itself.
    if (target.closest("[data-copy]")) {
      void copyCurrent();
      return;
    }
    const action = target.dataset.zoom;
    if (action === "in") setZoom(scale * 1.5);
    if (action === "out") setZoom(scale / 1.5);
    if (action === "fit") setZoom(1);
  });

  // Wheel zoom, because that is what anyone tries first on a photograph.
  img.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      setZoom(scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15), { x: event.clientX, y: event.clientY });
    },
    { passive: false },
  );

  // The browser's own image drag fires first and hijacks the gesture: instead
  // of panning, it lifts a ghost of the photograph and offers to drop it
  // somewhere. Suppressed rather than worked around, since a photo inside a
  // viewer is not something to drag out.
  img.draggable = false;
  img.addEventListener("dragstart", (event) => event.preventDefault());

  let dragging = false;
  let startX = 0;
  let startY = 0;
  img.addEventListener("pointerdown", (event) => {
    if (scale <= 1) return;
    dragging = true;
    startX = event.clientX - panX;
    startY = event.clientY - panY;
    img.setPointerCapture(event.pointerId);
    img.style.cursor = "grabbing";
  });
  img.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    panX = event.clientX - startX;
    panY = event.clientY - startY;
    applyZoom();
  });
  const stop = () => {
    dragging = false;
    applyZoom();
  };
  img.addEventListener("pointerup", stop);
  img.addEventListener("pointercancel", stop);
}

// --- Showing one photo -----------------------------------------------------

/**
 * Whether this build can decode the video's codec — HEVC needs the platform
 * decoder, and on another machine the server will not serve it at all.
 */
function canPlayVideo(photo: PhotoRecord): boolean {
  if (!photo.video) return false;
  // The job server refuses /video to a remote reader — see backend.ts. Falling
  // back to the poster frame is what the caller already does for a codec this
  // build cannot decode, so an unreachable video takes the same path.
  if (!isLocalMachine) return false;
  const probe = document.createElement("video");
  const fourCC = (photo.video.fourCC ?? "").toUpperCase();
  const codecs =
    fourCC === "HEVC" ? ["hvc1.1.6.L93.B0", "hev1.1.6.L93.B0"] : ["avc1.42E01E", "hvc1.1.6.L93.B0"];
  return codecs.some((codec) => probe.canPlayType(`video/mp4; codecs="${codec}"`) !== "");
}

/** Tears the video down so the next photo does not inherit its src or audio. */
function hideVideo(): void {
  const { video } = dom();
  if (video.hidden) return;
  video.pause();
  video.removeAttribute("src");
  video.load();
  video.hidden = true;
}

/**
 * Play the video, or fall back to its poster.
 *
 * The fallback is the same frame `analyze` captioned, so an undecodable codec
 * costs a still picture rather than an empty player. Most of this library is
 * HEVC, which only plays when the platform decoder is present —
 * desktop/src/main.ts turns it on, and `canPlayType` is the honest probe of
 * whether it worked.
 */
async function showVideo(photo: PhotoRecord, mine: number): Promise<void> {
  const { img, video, spinner } = dom();
  spinner.hidden = true;

  const showPoster = () => {
    video.hidden = true;
    img.hidden = false;
    void loadLarge(photo.id).then((url) => {
      if (mine === token && url) setSource(img, url);
    });
  };

  if (!canPlayVideo(photo)) return showPoster();

  img.hidden = true;
  video.hidden = false;
  const url = await loadVideoUrl(photo.id);
  // A stream URL can fail when signed out; the poster is still better than black.
  if (mine !== token) return;
  if (!url) return showPoster();

  // The video route is loopback-only today, so no session is needed — but the
  // element carries the same cross-origin trap as the images if that ever
  // changes, and setting it costs nothing.
  const videoCrossOrigin = thumbnailSource()?.crossOrigin;
  if (videoCrossOrigin) video.crossOrigin = videoCrossOrigin;
  video.src = url;
  void video.play().catch(() => {
    /* Autoplay may be refused; the controls are there. */
  });
}

async function show(index: number): Promise<void> {
  if (!session) return;
  session.index = index;
  const photo = session.photos[index];
  const mine = ++token;
  // The address follows the photograph on screen, including a step through the
  // strip or an arrow key.
  replaceRoute(photo.id);

  const { img, spinner } = dom();
  setZoom(1);
  resetFullWait();
  setCopyState("idle");
  // Zoom/Fit act on the image only, so they are meaningless over a video — hide
  // them for any video, poster fallback included. Copy goes with them: there is
  // no still picture of this one to put on the clipboard.
  dom().zoom.hidden = Boolean(photo.video);
  dom().copy.hidden = !copySupported;
  renderPhotoPanel(photo);
  renderStrip();

  if (photo.video) {
    await showVideo(photo, mine);
    settleFull?.();
    return;
  }
  hideVideo();
  img.hidden = false;
  img.dataset.full = "0";
  spinner.hidden = false;

  // Preview first, and wait for it to paint. Both loaders return in
  // milliseconds now that images come from the local cache, so starting them
  // together let the full-size one win and the preview was never seen.
  const preview = await loadLarge(photo.id);
  if (mine !== token) return;
  if (preview) {
    setSource(img, preview);
    img.classList.add("preview");
    await img.decode().catch(() => {});
    if (mine !== token) return;
  }

  const url = await loadFullPhoto(photo.id);
  if (mine !== token) {
    if (url) releaseFullPhoto(url);
    return;
  }
  if (!url) {
    // No original to wait for: what the preview shows is the whole photograph
    // as far as this viewer can tell, and the copy should not sit on a wait
    // that will never end.
    spinner.hidden = true;
    settleFull?.();
    return;
  }

  // Load out of sight and swap. Assigning `img.src` blanks the element while it
  // downloads, which would throw away the preview it just painted.
  const loader = new Image();
  loader.addEventListener(
    "load",
    () => {
      if (mine !== token) return;
      setSource(img, url);
      img.dataset.full = "1";
      img.classList.remove("preview");
      spinner.hidden = true;
      // The fitted size is the basis every zoom level is computed from, and it
      // differs per photograph.
      measureBase();
      // A copy asked for during the preview has been waiting for exactly this.
      settleFull?.();
    },
    { once: true },
  );
  loader.addEventListener("error", () => {
    if (mine === token) {
      spinner.hidden = true;
      // The original will not arrive; the preview is what this viewer has.
      settleFull?.();
    }
  });
  // The loader only decodes; assigning its src has to carry the session too, or
  // this probe request is the one that 401s and the preview never swaps.
  const crossOrigin = thumbnailSource()?.crossOrigin;
  if (crossOrigin) loader.crossOrigin = crossOrigin;
  loader.src = url;
  openObjectUrl = url;
}

/** Opens a card at one of its photographs. */
export function openCard(
  highlight: Highlight,
  byId: Record<string, PhotoRecord>,
  startAt = 0,
): void {
  const photos = highlight.photoIds.map((id) => byId[id]).filter(Boolean);
  if (photos.length === 0) return;

  const at = Math.min(startAt, photos.length - 1);
  session = { photos, index: at, highlight };
  initZoomControls();
  renderCardPanel(highlight, byId);
  renderStrip();
  dom().lightbox.hidden = false;
  pushRoute(photos[at].id);
  void show(at);
}

/** Opens a single photograph, for grids and album months where there is no card. */
/**
 * Opens one photograph, with the grid it came from behind the arrow keys.
 *
 * `siblings` is what makes the viewer walkable: a session of one had nothing to
 * step to, so browsing a stop's collapsed grid meant closing and reopening the
 * viewer for every photograph — and correcting the times of 123 WhatsApp saves
 * meant doing that 123 times. A photo not in the list given, or no list at all,
 * still opens on its own.
 */
export function openPhoto(photo: PhotoRecord, siblings?: PhotoRecord[]): void {
  const at = siblings?.indexOf(photo) ?? -1;
  const photos = at >= 0 ? siblings! : [photo];
  session = { photos, index: at >= 0 ? at : 0, highlight: null };
  initZoomControls();
  renderCardPanel(null, {});
  renderStrip();
  dom().lightbox.hidden = false;
  pushRoute(photo.id);
  void show(session.index);
}

// --- The address -----------------------------------------------------------

/**
 * The viewer is a place, not an overlay.
 *
 * Opening pushes one entry on top of the view — `#trip/<id>/photo/<photoId>` —
 * so Back leaves the viewer instead of quietly redrawing the page underneath
 * while it stays on screen. Stepping through the strip replaces that entry:
 * a card of 33 photographs should not cost 33 presses of Back.
 */
let routeView = "";
let routeOwned = false;

function pushRoute(photoId: string): void {
  routeView = currentBaseView();
  history.pushState({ photo: photoId }, "", photoHash(routeView, photoId));
  routeOwned = true;
  closing = false;
}

function replaceRoute(photoId: string): void {
  if (!routeOwned) return;
  history.replaceState({ photo: photoId }, "", photoHash(routeView, photoId));
}

/**
 * Reconciles the viewer with the address. Called by the album after it has
 * drawn the view a hash names, and on every popstate.
 */
export async function syncPhotoRoute(photoId: string | null): Promise<void> {
  const { lightbox } = dom();
  if (!photoId) {
    hide();
    return;
  }
  closing = false;

  // Already showing it — a reload of the same address, or a forward step.
  if (session && session.photos[session.index]?.id === photoId) {
    lightbox.hidden = false;
    return;
  }
  // The same list, a different photograph: Back and Forward inside one session.
  const at = session?.photos.findIndex((p) => p.id === photoId) ?? -1;
  if (at >= 0) {
    lightbox.hidden = false;
    void show(at);
    return;
  }

  const resolved = await resolveSession(photoId);
  if (!resolved) {
    // The address names a photograph this view cannot find — a stale link, or
    // one opened from a page that spans the library. Leave the reader on the
    // page rather than on a viewer with nothing in it.
    hide();
    history.replaceState(null, "", currentBaseView());
    return;
  }

  // A cold load arrives with the photograph as the only entry. Rewriting it as
  // the view and pushing the photograph over it gives Back somewhere to go.
  routeView = currentBaseView();
  history.replaceState(null, "", routeView);
  history.pushState({ photo: photoId }, "", photoHash(routeView, photoId));
  routeOwned = true;

  session = { photos: resolved.photos, index: resolved.index, highlight: null };
  initZoomControls();
  renderCardPanel(null, {});
  renderStrip();
  lightbox.hidden = false;
  void show(resolved.index);
}

/**
 * Leaves the viewer. Anything that closes it by intent comes through here, so
 * the address goes with it: hiding without popping would leave `#…/photo/…`
 * naming a photograph that is no longer on screen.
 */
function requestClose(): void {
  if (dom().lightbox.hidden || closing) return;
  if (routeOwned && splitPhoto(location.hash).photoId) {
    // The pop lands in `syncPhotoRoute(null)`, which hides the viewer. Guarded
    // because the back button also bubbles into the backdrop handler, and two
    // `back()` calls would leave the reader on the view *before* this one.
    closing = true;
    history.back();
    return;
  }
  hide();
}

/** True while a pop we asked for is in flight. */
let closing = false;

function hide(): void {
  const { lightbox, img, spinner } = dom();
  if (lightbox.hidden) return;
  lightbox.hidden = true;
  // Invalidates anything still loading so it cannot paint into a viewer that
  // has been closed and reopened on something else.
  token++;
  session = null;
  routeOwned = false;
  closing = false;
  setCopyState("idle");

  img.removeAttribute("src");
  img.classList.remove("preview");
  img.style.transform = "";
  delete img.dataset.full;
  img.hidden = false;
  hideVideo();
  spinner.hidden = true;

  if (openObjectUrl) {
    releaseFullPhoto(openObjectUrl);
    openObjectUrl = null;
  }
}

function step(delta: number): void {
  if (!session || session.photos.length < 2) return;
  const next = (session.index + delta + session.photos.length) % session.photos.length;
  void show(next);
}

/**
 * Clicking the backdrop leaves the viewer.
 *
 * Which parts of the screen count as backdrop is the whole question. The
 * figure fills the window, so a handler on `#lightbox` alone could only be
 * reached from a 34px strip at the edges — and it was, which is why the only
 * ways out were Escape and the back button. The photograph, its text, its
 * strip and its controls are named here instead: everything else is empty
 * space and closes.
 *
 * Zoomed is the exception the reader would not forgive: once the picture is
 * larger than the stage, any empty stage area is there because the reader
 * panned the picture away from it. Closing on that click would undo the
 * inspection they just performed.
 */
document.getElementById("lightbox")?.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (target.closest("#lightbox-img, #lightbox-video, #lightbox-panel, #lightbox-strip, #lightbox-zoom, #lightbox-back")) {
    return;
  }
  if (scale > 1 && target.closest(".lightbox-stage")) return;
  requestClose();
});
document.getElementById("lightbox-back")?.addEventListener("click", () => requestClose());

/**
 * A tag was clicked; get out of the way so the search can be seen.
 *
 * The chip is inside the lightbox and the search box is on the page behind it,
 * so the viewer closes itself and lets the event carry on to the home page's
 * listener. Listening here rather than routing through the caller is what keeps
 * `tagChip` in `photoUi.ts` free of any knowledge of the viewer.
 *
 * Hidden and rewritten here rather than through `requestClose`: the search is
 * about to push an entry of its own, and a `history.back()` racing that push
 * would land the reader on whichever one won.
 */
document.addEventListener("tag-search", () => {
  if (document.getElementById("lightbox")?.hidden) return;
  hide();
  history.replaceState(null, "", currentBaseView());
});

document.addEventListener("keydown", (event) => {
  if (document.getElementById("lightbox")?.hidden) return;
  if (event.key === "Escape") requestClose();
  // Arrow keys move between the card's photographs, which is the whole reason
  // the strip exists. Not while the reader is typing: the panel holds a time
  // editor, and there the arrows belong to the field.
  const target = event.target;
  if (target instanceof Element && target.closest("input, textarea, [contenteditable='true']")) return;
  if (event.key === "ArrowRight") step(1);
  if (event.key === "ArrowLeft") step(-1);
});

/** Kept for the sign-in banner's "view this" path, which has a URL and no record. */
export function openLightbox(url: string): void {
  session = null;
  const { lightbox, img, spinner } = dom();
  renderCardPanel(null, {});
  dom().photoPanel.replaceChildren();
  dom().strip.hidden = true;
  setSource(img, url);
  img.classList.remove("preview");
  dom().zoom.hidden = false;
  // No record behind this URL and no `crossOrigin` on the element, so the
  // canvas would be tainted and the copy could only ever fail. The sign-in
  // banner's "view this" is the only caller.
  dom().copy.hidden = true;
  spinner.hidden = true;
  lightbox.hidden = false;
  openObjectUrl = url;
}
