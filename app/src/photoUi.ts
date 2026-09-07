import type { PhotoRecord } from "@travel-archive/shared";
import { loadThumbnail, loadLarge, loadFullPhoto, releaseFullPhoto } from "./graphPhoto";

/** Builds an element from an HTML string. Used everywhere in place of a template engine. */
export function el<T extends HTMLElement>(html: string): T {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return template.content.firstElementChild as T;
}

/**
 * A 1x1 transparent GIF.
 *
 * An <img> with no `src` draws the browser's missing-image glyph — the little
 * broken square that appeared in the corner of every pending cell. A
 * transparent pixel is a *successful* load, so no glyph, and the CSS background
 * shimmer shows through it. It decodes before any load listener is attached, so
 * it cannot be mistaken for the real photo arriving.
 */
const BLANK_PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

// The full-res blob currently on screen. Held so it can be revoked on close —
// originals are many megabytes each, and a browsing session that opened a few
// dozen would otherwise pin all of them for the lifetime of the page.
let openObjectUrl: string | null = null;

// Bumped on every open, so a slow download that finishes after the user has
// moved on cannot overwrite the photo now on screen.
let openToken = 0;

/**
 * Opens the viewer at once, on the thumbnail already in memory, and swaps in
 * the original when it arrives.
 *
 * The original is several megabytes and takes a moment over Graph. Waiting for
 * it before showing anything made a click look like it had failed — nothing
 * happened, then the screen changed. Showing the cached thumbnail immediately
 * makes the click feel instant and turns the download into a visible wait
 * instead of an invisible one.
 */
function stage(photo: PhotoRecord | null): {
  img: HTMLImageElement;
  spinner: HTMLElement;
  caption: HTMLElement;
} {
  const lightbox = document.getElementById("lightbox")!;
  const img = document.getElementById("lightbox-img") as HTMLImageElement;
  const spinner = document.getElementById("lightbox-spinner")!;
  const caption = document.getElementById("lightbox-caption")!;

  // Captions belong in the viewer, not only on photos the model called out.
  // Every photo that has been described has something to say about itself, and
  // the grid deliberately shows none of it.
  const parts: string[] = [];
  if (photo?.takenAt) {
    parts.push(
      new Date(photo.takenAt).toLocaleString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: photo.timeSuspect ? undefined : "2-digit",
        minute: photo.timeSuspect ? undefined : "2-digit",
      }),
    );
  }
  if (photo?.place) parts.push(photo.place);

  caption.replaceChildren();
  if (photo?.caption) {
    const text = document.createElement("div");
    text.className = "lightbox-caption-text";
    text.textContent = photo.caption;
    caption.appendChild(text);
  }
  if (parts.length > 0) {
    const meta = document.createElement("div");
    meta.className = "lightbox-caption-meta";
    meta.textContent = parts.join(" · ");
    caption.appendChild(meta);
  }
  if (photo?.extractedText) {
    // A plain block, not a <details>. It is always open now that it has a
    // column of its own, and Chrome lays a details' content out inside a
    // `::details-content` box — so a child of it is not a flex item of the
    // details, and the transcript refused to fill the height however it was
    // told to.
    const block = document.createElement("section");
    block.className = "lightbox-text";

    const label = document.createElement("h4");
    label.textContent = "Transcribed text";

    const body = document.createElement("div");
    body.textContent = photo.extractedText;

    block.append(label, body);
    caption.appendChild(block);
  }

  lightbox.hidden = false;
  return { img, spinner, caption };
}

export function openLightbox(url: string): void {
  const { img, spinner } = stage(null);
  img.src = url;
  img.classList.remove("preview");
  spinner.hidden = true;
  openObjectUrl = url;
}

export async function openFullPhoto(photo: PhotoRecord): Promise<void> {
  const token = ++openToken;
  const { img, spinner } = stage(photo);

  img.dataset.full = "0";
  spinner.hidden = false;

  // **Preview first, and wait for it to paint.**
  //
  // These used to be started together, which worked while the full-size photo
  // took seconds to download: the thumbnail always won. Served from the local
  // cache, `loadFullPhoto` returns an address rather than bytes and settles in
  // *fewer* microtask hops than `loadLarge`, so it won every time and the
  // preview was never seen — a click gave a black frame with a spinner for
  // three seconds. Sequencing them is what makes the preview reliable, and it
  // costs nothing: the thumbnail is already in the browser's cache from the
  // grid it was just clicked in.
  const preview = await loadLarge(photo.id);
  if (token !== openToken) return;
  if (preview) {
    img.src = preview;
    img.classList.add("preview");
    // Resolves once it is actually decoded, so the swap below cannot cancel a
    // load that never painted.
    await img.decode().catch(() => {});
    if (token !== openToken) return;
  }

  const url = await loadFullPhoto(photo.id);
  // A different photo was opened while this one was loading; drop it rather
  // than replacing what the user is now looking at.
  if (token !== openToken) {
    if (url) releaseFullPhoto(url);
    return;
  }
  if (!url) {
    spinner.hidden = true;
    return;
  }

  // **Load it out of sight, then swap.**
  //
  // Assigning `img.src` starts a download and blanks the element while it runs,
  // so pointing the visible image at the full-size URL threw the preview away
  // and left an empty frame for as long as the photo took — which is exactly
  // what the preview exists to prevent. Decoding into a detached Image keeps
  // the preview on screen throughout; the swap afterwards is instant because
  // the bytes are then in the browser's cache.
  //
  // The spinner is hidden on *that* load, not when the promise resolves.
  // Resolving used to mean the bytes had arrived; served from the local cache
  // it means only that an address is known.
  const loader = new Image();
  loader.addEventListener(
    "load",
    () => {
      if (token !== openToken) return;
      img.src = url;
      img.dataset.full = "1";
      img.classList.remove("preview");
      spinner.hidden = true;
    },
    { once: true },
  );
  loader.addEventListener(
    "error",
    () => {
      // Leave the preview on screen rather than blanking it.
      if (token === openToken) spinner.hidden = true;
    },
    { once: true },
  );
  loader.src = url;
  openObjectUrl = url;
}

function closeLightbox(): void {
  const lightbox = document.getElementById("lightbox")!;
  if (lightbox.hidden) return;
  lightbox.hidden = true;
  // Invalidates any download still in flight, so it cannot paint into a viewer
  // the user has already closed and then reopened on something else.
  openToken++;

  const img = document.getElementById("lightbox-img") as HTMLImageElement;
  img.removeAttribute("src");
  img.classList.remove("preview");
  delete img.dataset.full;
  document.getElementById("lightbox-spinner")!.hidden = true;

  if (openObjectUrl) {
    releaseFullPhoto(openObjectUrl);
    openObjectUrl = null;
  }
}

// Wired once at module load — closing on backdrop click or Escape. The caption
// stops propagation so that selecting its text, or opening the transcript,
// does not dismiss the photo being read about.
document.getElementById("lightbox")?.addEventListener("click", closeLightbox);
document.getElementById("lightbox-close")?.addEventListener("click", closeLightbox);
// The panel stops propagation so selecting transcript text, or scrolling it,
// does not dismiss the photo being read about. The figure does too now that it
// fills the screen: clicking beside a portrait photo used to close the viewer.
document.getElementById("lightbox-caption")?.addEventListener("click", (e) => e.stopPropagation());
document.querySelector(".lightbox-figure")?.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeLightbox();
});

/**
 * Thumbnails load only once the <img> comes near the viewport. This is the
 * difference between a month tab being usable and not: a busy month holds
 * several hundred photos and every thumbnail is its own authenticated Graph
 * call, so firing them all on render would stall the tab and burn the
 * request budget on images nobody scrolled to.
 */
const thumbObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) void hydrate(entry.target as HTMLImageElement);
    }
  },
  { rootMargin: "300px" },
);

/**
 * Fetches one thumbnail and swaps it in.
 *
 * Split out of the observer because scrolling is no longer the only reason an
 * image has to be present: printing needs every image on the page at once, and
 * an image that is never scrolled past would otherwise still be the blank
 * placeholder when the print snapshot is taken.
 *
 * Resolves once the image has actually decoded, so a caller can wait for a
 * whole page to be paintable rather than merely requested.
 */
function hydrate(img: HTMLImageElement): Promise<void> {
  thumbObserver.unobserve(img);
  // Two callers can reach the same image — the observer as it scrolls into
  // view, and a print pass walking the document — and the second must not
  // reset a src that is already correct.
  if (img.dataset.hydrated === "1") return Promise.resolve();
  img.dataset.hydrated = "1";

  const { photoId, loader } = img.dataset;
  const load = loader === "large" ? loadLarge : loadThumbnail;
  return load(photoId!)
    .then((url) => {
      if (!url) return;
      // `lazy` defers the *fetch* of whatever src is assigned, so an image far
      // below the fold could still be pending when print snapshots the page.
      // Nothing is deferred once we have decided to load it.
      img.loading = "eager";
      return new Promise<void>((resolve) => {
        // Reveal on the actual load event, never on assignment. A src that
        // fails to decode (a revoked blob URL, an expired CDN link) would
        // otherwise be faded in as a broken image showing its alt text
        // across the cell — which is precisely how that bug presented.
        img.addEventListener(
          "load",
          () => {
            img.classList.add("loaded");
            resolve();
          },
          { once: true },
        );
        // Back to the blank pixel, not to no src at all: removing it would
        // restore the browser's missing-image glyph in the corner of the cell.
        img.addEventListener(
          "error",
          () => {
            img.src = BLANK_PIXEL;
            resolve();
          },
          { once: true },
        );
        img.src = url;
      });
    })
    .catch((err) => {
      // A single unreachable photo must not abort a 1,300-image print pass.
      console.error(`Failed to load photo ${photoId}:`, err);
    });
}

/**
 * Loads every image in `images`, a few at a time, reporting progress.
 *
 * Bounded because these are authenticated Graph calls whenever the thumbnail
 * cache misses; firing 1,300 at once is how the tab stalls. Cache hits make it
 * near-instant, which is the usual case for a trip that has been browsed.
 */
const HYDRATE_CONCURRENCY = 8;

export async function hydrateAll(
  images: HTMLImageElement[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < images.length) {
      await hydrate(images[next++]);
      onProgress?.(++done, images.length);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(HYDRATE_CONCURRENCY, images.length) }, worker),
  );
}


export function lazyImg(photo: PhotoRecord, size: "medium" | "large" = "medium", className = ""): HTMLImageElement {
  const img = document.createElement("img");
  img.src = BLANK_PIXEL;
  // Empty alt until the AI pass writes a real caption. A filename is not a
  // description — it tells a screen reader nothing useful, and it's what
  // sprawled across every cell whenever an image failed to load.
  img.alt = photo.caption ?? "";
  img.loading = "lazy";
  img.dataset.photoId = photo.id;
  if (size === "large") img.dataset.loader = "large";
  if (className) img.className = className;
  thumbObserver.observe(img);
  return img;
}

