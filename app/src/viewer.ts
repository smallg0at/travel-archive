import type { Highlight, PhotoRecord } from "@travel-archive/shared";
import { loadFullPhoto, loadLarge, releaseFullPhoto } from "./graphPhoto";
import { el } from "./photoUi";
import { addPhotoTimeControl } from "./dayEdit";

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

function dom() {
  return {
    lightbox: document.getElementById("lightbox")!,
    img: document.getElementById("lightbox-img") as HTMLImageElement,
    spinner: document.getElementById("lightbox-spinner")!,
    cardPanel: document.getElementById("lightbox-card")!,
    photoPanel: document.getElementById("lightbox-photo")!,
    strip: document.getElementById("lightbox-strip")!,
    zoom: document.getElementById("lightbox-zoom")!,
  };
}

function metaLine(photo: PhotoRecord): string {
  const parts: string[] = [];
  if (photo.takenAt) {
    parts.push(
      new Date(photo.takenAt).toLocaleString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
        // A clock the archive does not trust is not shown. Phone sync on this
        // library shifts times by hours; the day is usually right, the hour not.
        hour: photo.timeSuspect ? undefined : "2-digit",
        minute: photo.timeSuspect ? undefined : "2-digit",
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
  title.textContent = highlight.title;
  cardPanel.appendChild(title);

  if (highlight.description) {
    const desc = document.createElement("p");
    desc.className = "viewer-desc";
    desc.textContent = highlight.description;
    cardPanel.appendChild(desc);
  }

  // The English rendering of a placard, which is the useful half for an owner
  // who does not read Slovak or German.
  if (highlight.documentTranslation) {
    const quote = document.createElement("p");
    quote.className = "viewer-placard";
    quote.textContent = highlight.documentTranslation;
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
    label.textContent = sources.length === 1 ? "From the placard" : `From ${sources.length} placards`;
    const body = document.createElement("div");
    body.textContent = sources.join("\n\n");
    block.append(label, body);
    cardPanel.appendChild(block);
  }
}

/** Everything *this photograph* says: its own caption, time, place and transcript. */
function renderPhotoPanel(photo: PhotoRecord): void {
  const { photoPanel } = dom();
  photoPanel.replaceChildren();

  const heading = document.createElement("h4");
  heading.className = "viewer-section-label";
  heading.textContent = "This photo";
  photoPanel.appendChild(heading);

  if (photo.caption) {
    const cap = document.createElement("p");
    cap.className = "viewer-caption";
    cap.textContent = photo.caption;
    photoPanel.appendChild(cap);
  }

  const meta = metaLine(photo);
  if (meta) {
    const line = document.createElement("p");
    line.className = "viewer-meta";
    line.textContent = meta;
    photoPanel.appendChild(line);
  }

  // Re-render this panel rather than the whole archive: a correction is one
  // photo, and reloading between each of 123 of them closes the viewer.
  addPhotoTimeControl(photoPanel, photo, () => renderPhotoPanel(photo));

  if (photo.extractedText) {
    const block = document.createElement("div");
    block.className = "viewer-block viewer-transcript";
    const label = document.createElement("h4");
    label.textContent = "Transcribed text";
    const body = document.createElement("div");
    body.textContent = photo.extractedText;
    block.append(label, body);
    photoPanel.appendChild(block);
  }
}

/** The card's other photographs. Hidden when there is only one. */
function renderStrip(): void {
  const { strip } = dom();
  strip.replaceChildren();
  if (!session || session.photos.length < 2) {
    strip.hidden = true;
    return;
  }
  strip.hidden = false;

  for (const [i, photo] of session.photos.entries()) {
    const thumb = document.createElement("img");
    thumb.src = BLANK;
    thumb.alt = photo.caption ?? "";
    thumb.className = i === session.index ? "current" : "";
    void loadLarge(photo.id).then((url) => {
      if (url) thumb.src = url;
    });
    thumb.addEventListener("click", (event) => {
      event.stopPropagation();
      void show(i);
    });
    strip.appendChild(thumb);
  }
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
  zoom.querySelector(".zoom-level")!.textContent = `${Math.round(scale * 100)}%`;
}

function setZoom(next: number): void {
  scale = Math.min(6, Math.max(1, next));
  // Snapping back to centre at 1x avoids the photo being stuck off-screen after
  // panning and then zooming out.
  if (scale === 1) {
    panX = 0;
    panY = 0;
  }
  applyZoom();
}

function initZoomControls(): void {
  const { zoom, img } = dom();
  if (zoom.dataset.wired === "1") return;
  zoom.dataset.wired = "1";

  zoom.addEventListener("click", (event) => {
    event.stopPropagation();
    const action = (event.target as HTMLElement).dataset.zoom;
    if (action === "in") setZoom(scale * 1.5);
    if (action === "out") setZoom(scale / 1.5);
    if (action === "fit") setZoom(1);
  });

  // Wheel zoom, because that is what anyone tries first on a photograph.
  img.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      setZoom(scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
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

async function show(index: number): Promise<void> {
  if (!session) return;
  session.index = index;
  const photo = session.photos[index];
  const mine = ++token;

  const { img, spinner, strip } = dom();
  setZoom(1);
  renderPhotoPanel(photo);
  strip.querySelectorAll("img").forEach((t, i) => {
    t.classList.toggle("current", i === index);
    // Keep the marked thumbnail in view: the strip scrolls now, so arrowing
    // through a long grid otherwise leaves the highlight somewhere off to the
    // right with no sign of where you are.
    if (i === index) t.scrollIntoView({ block: "nearest", inline: "nearest" });
  });

  img.dataset.full = "0";
  spinner.hidden = false;

  // Preview first, and wait for it to paint. Both loaders return in
  // milliseconds now that images come from the local cache, so starting them
  // together let the full-size one win and the preview was never seen.
  const preview = await loadLarge(photo.id);
  if (mine !== token) return;
  if (preview) {
    img.src = preview;
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
    spinner.hidden = true;
    return;
  }

  // Load out of sight and swap. Assigning `img.src` blanks the element while it
  // downloads, which would throw away the preview it just painted.
  const loader = new Image();
  loader.addEventListener(
    "load",
    () => {
      if (mine !== token) return;
      img.src = url;
      img.dataset.full = "1";
      img.classList.remove("preview");
      spinner.hidden = true;
      // The fitted size is the basis every zoom level is computed from, and it
      // differs per photograph.
      measureBase();
    },
    { once: true },
  );
  loader.addEventListener("error", () => {
    if (mine === token) spinner.hidden = true;
  });
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

  session = { photos, index: startAt, highlight };
  initZoomControls();
  renderCardPanel(highlight, byId);
  renderStrip();
  dom().lightbox.hidden = false;
  void show(Math.min(startAt, photos.length - 1));
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
  void show(session.index);
}

function close(): void {
  const { lightbox, img, spinner } = dom();
  if (lightbox.hidden) return;
  lightbox.hidden = true;
  // Invalidates anything still loading so it cannot paint into a viewer that
  // has been closed and reopened on something else.
  token++;
  session = null;

  img.removeAttribute("src");
  img.classList.remove("preview");
  img.style.transform = "";
  delete img.dataset.full;
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

document.getElementById("lightbox")?.addEventListener("click", close);
document.getElementById("lightbox-close")?.addEventListener("click", close);
// The figure fills the screen, so clicking inside it must not dismiss — beside
// a portrait photo is still "inside".
document.querySelector(".lightbox-figure")?.addEventListener("click", (e) => e.stopPropagation());

document.addEventListener("keydown", (event) => {
  if (document.getElementById("lightbox")?.hidden) return;
  if (event.key === "Escape") close();
  // Arrow keys move between the card's photographs, which is the whole reason
  // the strip exists.
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
  img.src = url;
  img.classList.remove("preview");
  spinner.hidden = true;
  lightbox.hidden = false;
  openObjectUrl = url;
}
