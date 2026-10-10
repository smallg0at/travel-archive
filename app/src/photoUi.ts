import type { PhotoRecord } from "@travel-archive/shared";
import { loadThumbnail, loadLarge } from "./graphPhoto";
import { thumbnailSource } from "./photoSource";
import { isLocalMachine } from "./backend";
import { loc } from "./contentLang";
import { ui } from "./i18n";

/** Builds an element from an HTML string. Used everywhere in place of a template engine. */
export function el<T extends HTMLElement>(html: string): T {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return template.content.firstElementChild as T;
}

/**
 * One tag, as a button that searches for itself.
 *
 * A tag exists to be followed — "show me the other Elizabeth line pictures" —
 * so it is a control rather than decoration. It does not search directly: the
 * search box lives on the home page and this chip is usually inside the
 * lightbox, so it raises an event the app routes (`tag-search`) instead of
 * reaching across modules. Closing the viewer and focusing the query is the
 * caller's job, since only it knows what is open.
 */
export function tagChip(tag: string): HTMLButtonElement {
  const chip = el<HTMLButtonElement>(`<button type="button" class="tag-chip"></button>`);
  chip.textContent = tag;
  chip.title = tag;
  chip.addEventListener("click", (event) => {
    event.stopPropagation();
    document.dispatchEvent(new CustomEvent("tag-search", { detail: tag }));
  });
  return chip;
}

/**
 * A photograph's transcript in the reader's language, with the verbatim kept.
 *
 * The text inside a photo — a label, a menu, a note — is evidence, so the
 * original is never discarded; but its translation is stored beside the archive
 * (`jobs/translate.ts`) and is what a reader who does not read the language
 * wants first. `original` is null when the text came back as written, so
 * callers add the toggle only when there is something behind it.
 *
 * The source text is verbatim, so it can be in any language, and a bilingual
 * label prints the same thing twice — the translation asks for the meaning once
 * (see translatePrompt.ts).
 */
export function transcript(originals: string[]): { shown: string; original: string | null } {
  const raw = originals.join("\n\n");
  const shown = originals.map((text) => loc(text)).join("\n\n");
  return { shown, original: shown === raw ? null : raw };
}

/** The nested "original text" toggle the transcript sites share. */
export function transcriptOriginal(original: string, label: string): HTMLDetailsElement {
  const details = el<HTMLDetailsElement>(`<details class="transcript-original"><summary></summary><pre></pre></details>`);
  details.querySelector("summary")!.textContent = label;
  details.querySelector("pre")!.textContent = original;
  return details;
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
 * Marks a cell whose picture does not exist anywhere: OneDrive will not
 * render it and this machine could not either.
 *
 * Without this the cell shimmers forever. The placeholder is a *loading*
 * animation, so a permanently unrenderable photo — an MP4 on a machine with
 * no ffmpeg, an item whose transform OneDrive failed years ago — read as a
 * request that never comes back, and every visit repeated the impression.
 * The cell keeps its shape and stays clickable: only the thumbnail is
 * missing, and the original still opens in the lightbox.
 */
function markMissing(img: HTMLImageElement): void {
  img.classList.add("thumb-missing");
  img.title = ui.album.noPreview;
}

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
      // Nothing to show, and not for want of trying: the local server answered
      // 404, or Graph had no link to give. Said so rather than left pending.
      if (!url) {
        markMissing(img);
        return;
      }
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
            markMissing(img);
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
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < images.length) {
      if (signal?.aborted) return;
      await hydrate(images[next++]);
      onProgress?.(++done, images.length);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(HYDRATE_CONCURRENCY, images.length) }, worker),
  );
}


/**
 * A day's photos, the best cover first.
 *
 * The first photo of a day is usually its least interesting — the platform,
 * the queue, a screenshot of the ticket. The captioner already marks what is
 * worth featuring (`visibility: "feature"`, `notable`), so a cover is chosen
 * from those, and screenshots, poor frames and duplicate copies go to the
 * back rather than out: the viewer still walks every photo.
 *
 * Shared by the home page's "on this day" cards and the album's day-out
 * cards, which would otherwise pick different covers for the same day.
 */
export function coverFirst(photos: PhotoRecord[]): PhotoRecord[] {
  const score = (p: PhotoRecord) =>
    (p.visibility === "feature" ? 4 : 0) +
    (p.notable ? 2 : 0) +
    (p.screenshot || p.contentType === "screenshot" ? -8 : 0) +
    // A placard, a menu, a museum label: photographed for what it says, not
    // for the look of it. A day out once led with an information board.
    (p.contentType === "document" ? -5 : 0) +
    (p.quality === "poor" ? -4 : 0) +
    (p.duplicateGroupId && !p.isDuplicateRepresentative ? -6 : 0) +
    (p.visibility === "hidden" ? -3 : 0);
  // Stable: equal scores keep the day's own order.
  return photos
    .map((p, i) => ({ p, i, s: score(p) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(({ p }) => p);
}

export function lazyImg(photo: PhotoRecord, size: "medium" | "large" = "medium", className = ""): HTMLImageElement {
  const img = document.createElement("img");
  img.src = BLANK_PIXEL;
  // Empty alt until the AI pass writes a real caption. A filename is not a
  // description — it tells a screen reader nothing useful, and it's what
  // sprawled across every cell whenever an image failed to load.
  img.alt = loc(photo.caption) ?? "";
  img.loading = "lazy";
  img.dataset.photoId = photo.id;
  // A video's poster is a still, so the grids cannot tell it from a photo
  // without a mark. Set here rather than at each call site, so every grid that
  // wraps its images in a positioned cell gets the badge from one CSS rule.
  // Not on another machine, where the server will not play it: a badge promising
  // video that opens a still is worse than no badge.
  if (photo.video && isLocalMachine) img.dataset.video = "";
  if (size === "large") img.dataset.loader = "large";
  if (className) img.className = className;
  thumbObserver.observe(img);
  return img;
}

