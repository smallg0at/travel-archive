import type { PhotoRecord } from "@travel-archive/shared";
import { loadThumbnail, loadLarge } from "./graphPhoto";
import { thumbnailSource } from "./photoSource";

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
        // Before `src`, always: setting it afterwards has no effect on a load
        // already under way, and the whole point is that the bytes arrive with
        // CORS so the print export can read them back off a canvas.
        const crossOrigin = thumbnailSource()?.crossOrigin;
        if (crossOrigin) img.crossOrigin = crossOrigin;
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

