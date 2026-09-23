import { hydrateAll } from "./photoUi";
import { cachedSizes } from "./thumbCache";
import { thumbnailSource } from "./photoSource";
import { ui } from "./i18n";

/**
 * Export the page as a document — a PDF via Chrome's "Save as PDF", or paper.
 *
 * The purpose is *sharing*, and that decides almost everything here. Printing
 * rasterises every image into the output file, so the result is self-contained:
 * whoever receives it needs no Microsoft account, no token and no network to
 * read it. That is the one export format this archive can produce that does not
 * require the reader to be the owner.
 *
 * Because it leaves the machine, the export is deliberately narrower than the
 * screen:
 *
 *  - **Only the cards.** The collapsed "N more photos" grids and the transit
 *    strips are never exported, whatever their state on screen. Those are the
 *    raw roll — unreviewed, and on this archive they hold 114 of the trip's 125
 *    screenshots. The cards are the part that has been curated into a summary,
 *    and a summary is what gets shared.
 *  - **Prose, not evidence.** A placard's English rendering prints; the
 *    verbatim OCR behind its toggle does not.
 *
 * Both rules are enforced in the print stylesheet rather than here, so they
 * hold even if this module is bypassed — expanding a grid by hand still cannot
 * put it in the file.
 */

const OVERLAY_ID = "print-progress";

/**
 * Resolution the exported images are rasterised at.
 *
 * Thumbnails arrive at Graph's `large` — an 800px box — which is the right size
 * for a screen and mostly wrong for a page. Measured against the print slots on
 * A4:
 *
 * | card | slot per image | 800px works out at |
 * |---|---|---|
 * | `full`   | ~95 x 85mm | 214 dpi |
 * | `half`   | ~46 x 52mm | 441 dpi |
 * | `normal` | ~52 x 52mm | 389 dpi |
 *
 * So `full` is about right and the other two — 1,050 of the trip's 1,292
 * exported images — carry four to five times the pixels they can print. Left
 * alone that produced a **95 MB** PDF, over both the 25MB most mail providers
 * accept and the 50MB Google AI Studio accepts, and it is also what made Chrome
 * take 45-60s to render.
 *
 * 200 dpi rather than 300: these are 800px thumbnails, not originals, so 300
 * would mean upscaling `full` cards to invent detail that was never there.
 */
const PRINT_DPI = 200;

/**
 * JPEG quality for the re-encode.
 *
 * Chosen against Google AI Studio's 50MB upload cap, measured over all 1,292
 * exported images of the the train trip (93.6MB of source thumbnails):
 *
 * | quality | export |
 * |---|---|
 * | 0.82 | 54.3 MB — over the cap |
 * | 0.75 | 47.0 MB — 6% margin, too close |
 * | **0.70** | **43.6 MB** — 13% margin |
 * | 0.62 | 38.2 MB |
 *
 * 0.70 rather than 0.75 because the cap applies to the finished PDF, which
 * carries 214 pages of text and structure on top of the images.
 */
const PRINT_QUALITY = 0.7;

const PX_PER_MM = PRINT_DPI / 25.4;

/** The printed content width, from the `@media print` block — the card table and the grid fallback both scale against it. */
const CONTENT_WIDTH_MM = 186;

/**
 * The printed size of one image, in mm, from the card it belongs to.
 *
 * These mirror the `@media print` block: content width 186mm, a two-track grid
 * (six tracks: full 6, half 3, normal 2) with a 6mm gutter, and `.card-images` splitting its card's width evenly
 * between however many photos the card holds.
 */
const CARD_SLOT_MM: Record<string, { w: number; h: number }> = {
  "card-full": { w: CONTENT_WIDTH_MM, h: 85 },
  "card-half": { w: 90, h: 52 },
  "card-normal": { w: 58, h: 34 },
};

function slotPxFor(img: HTMLImageElement): { w: number; h: number } | null {
  const card = img.closest(".card");
  if (card) {
    const size = [...card.classList].find((c) => c in CARD_SLOT_MM);
    if (!size) return null;

    const slot = CARD_SLOT_MM[size];
    const siblings = card.querySelectorAll(".card-images img").length || 1;
    // The 2px flex gap is a rounding error at print scale; treated as 0.5mm.
    const widthMm = (slot.w - 0.5 * (siblings - 1)) / siblings;
    return { w: Math.round(widthMm * PX_PER_MM), h: Math.round(slot.h * PX_PER_MM) };
  }

  // A grid layout — a month or a day — where the photograph's printed size is
  // whatever the on-screen cell is. Measured rather than assumed: the album's
  // cell size is a preference (`--album-cell`) and the grid is fluid, so no
  // table of millimetres can be written down for it. The print stylesheet keeps
  // the same cell aspect, so scaling the measured box by the content width is
  // the whole conversion.
  const rect = img.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  const scale = CONTENT_WIDTH_MM / rect.width;
  return { w: Math.round(rect.width * scale * PX_PER_MM), h: Math.round(rect.height * scale * PX_PER_MM) };
}

/**
 * Re-renders one image at the size it will actually print, cropped the way the
 * page crops it.
 *
 * The crop is the second saving and an easy one to miss: `.card-images img` is
 * `object-fit: cover`, so the parts of a photo outside its slot's aspect ratio
 * are already invisible on screen — but they are still embedded in the PDF at
 * full resolution. Cropping here removes pixels that could never have been
 * seen.
 *
 * Source pixels are only ever discarded, never invented: a slot that would need
 * more than the thumbnail has is left alone.
 */
function rasterise(img: HTMLImageElement, sourceBytes: number | undefined): string | null {
  const slot = slotPxFor(img);
  const sw = img.naturalWidth;
  const sh = img.naturalHeight;
  if (!slot || !sw || !sh) return null;

  // Never upscale — that costs bytes to add nothing.
  const scale = Math.min(1, Math.max(slot.w / sw, slot.h / sh));
  const dw = Math.round(Math.min(slot.w, sw * scale));
  const dh = Math.round(Math.min(slot.h, sh * scale));
  if (dw >= sw && dh >= sh) return null;

  // The `cover` crop: fill the slot, centre what spills.
  const cover = Math.max(dw / sw, dh / sh);
  const cw = sw * cover;
  const ch = sh * cover;

  const canvas = document.createElement("canvas");
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, (dw - cw) / 2, (dh - ch) / 2, cw, ch);

  // `toDataURL`, not `toBlob`, and this is not a style preference.
  //
  // `toBlob` delivers through a callback, and a background tab has its timers
  // throttled to roughly one per second — so an export started and then left
  // for another tab ran at 1 image/sec: 21 minutes instead of 8 seconds.
  // Measured on this machine: toBlob 1008ms in a hidden tab, toDataURL 6.3ms.
  // Synchronous encoding cannot be throttled, and starting a long export and
  // then switching away is the normal thing to do.
  //
  // The cost is base64's 33% overhead, which is memory only — it is decoded
  // again before it ever reaches the PDF.
  const encoded = canvas.toDataURL("image/jpeg", PRINT_QUALITY);

  // Never hand back something larger than what arrived.
  //
  // Re-encoding is not free even when the pixel count drops: Graph's thumbnails
  // are already well compressed, so a modest downscale plus a fresh encode can
  // cost more than it saves. Measured at quality 0.70, **41% of `full` card
  // images came out bigger** — a strictly worse image in a bigger file. They
  // only shrink 800px -> 669px, where `half` and `normal` drop to ~409px and
  // shrink reliably. Keeping the smaller of the two is worth 2.7MB across the
  // trip and, more to the point, makes the pass safe by construction.
  const encodedBytes = Math.round((encoded.length - "data:image/jpeg;base64,".length) * 0.75);
  if (sourceBytes !== undefined && encodedBytes >= sourceBytes) return null;
  return encoded;
}

/**
 * The progress toast, with a way out of it.
 *
 * Preparing a large export encodes every photograph and can run for tens of
 * seconds; there was no way to stop it once started — the toast was a bare text
 * node and nothing in the loops ever looked for an interruption. It carries a
 * cancel button now, whose signal the loops check.
 */
function overlay(onCancel: () => void): { box: HTMLElement; setText: (text: string) => void } {
  let node = document.getElementById(OVERLAY_ID);
  if (!node) {
    node = document.createElement("div");
    node.id = OVERLAY_ID;
    document.body.appendChild(node);
  }
  node.replaceChildren();
  const text = document.createElement("span");
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "print-cancel";
  cancel.textContent = ui.common.cancel;
  cancel.addEventListener("click", onCancel);
  node.append(text, cancel);
  node.hidden = false;
  return {
    box: node,
    setText: (value: string) => {
      text.textContent = value;
    },
  };
}

/**
 * The images that will actually appear in the output.
 *
 * Scoped to `.card-images` — the same rule the stylesheet enforces — so the
 * progress count matches what is being prepared, and so a print never spends
 * hundreds of Graph calls fetching photos it is about to hide.
 */
/**
 * Every photograph on the page worth exporting.
 *
 * **Not just the cards any more.** This looked only inside `.card-images`, which
 * is the trip page's layout — so on a month or a day, whose photographs sit in
 * `.album-grid`/`.stop-grid`, the list came back empty, `canPrint()` said no, and
 * the Save-as-PDF button silently never appeared. That is why the export had
 * "gone missing": the button was gated on a layout the reader was not looking at.
 */
function exportableImages(): HTMLImageElement[] {
  return [
    ...document.querySelectorAll<HTMLImageElement>(
      "#content :is(.card-images, .album-grid, .stop-grid) img[data-photo-id]",
    ),
  ];
}

/** True when the current view has something worth exporting. */
export function canPrint(): boolean {
  return exportableImages().length > 0;
}

/** What one image looked like before the print pass swapped it. */
interface Swapped {
  img: HTMLImageElement;
  original: string;
}

/**
 * Swaps every card image for a print-sized rendering, and hands back what is
 * needed to put the page back.
 */
async function rasteriseAll(
  images: HTMLImageElement[],
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Swapped[]> {
  const swapped: Swapped[] = [];

  // One batched lookup so the encode loop below can stay synchronous — see the
  // note on toDataURL for why that matters. A missing entry just means "no
  // opinion", and the image is re-encoded as normal.
  //
  // Asked of whichever source actually holds the bytes: with a local server the
  // browser cache is empty, so consulting IndexedDB alone would silently return
  // nothing and re-encode every image, including the ~14% that come out bigger.
  const ids = images.map((img) => img.dataset.photoId!).filter(Boolean);
  const source = thumbnailSource();
  const sizes = source?.sizes
    ? await source.sizes(ids, "large")
    : new Map(
        [...(await cachedSizes(ids.map((id) => `large:${id}`)))].map(([k, v]) => [
          k.replace(/^large:/, ""),
          v,
        ]),
      );

  for (const [i, img] of images.entries()) {
    if (signal?.aborted) break;
    const printUrl = rasterise(img, sizes.get(img.dataset.photoId!));
    if (printUrl) {
      swapped.push({ img, original: img.src });
      img.src = printUrl;
    }
    onProgress(i + 1, images.length);
    // Yield only when there is something to yield *for*. A hidden tab throttles
    // setTimeout to ~1/sec, so pausing every 20 images to repaint a progress
    // readout nobody can see would add minutes to an export left in the
    // background — the exact case the synchronous encode above exists for.
    if (!document.hidden && i % 20 === 19) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  // Every swapped image has a new src to decode before the page is printable.
  await Promise.all(
    swapped.map(({ img }) => (img.complete ? Promise.resolve() : img.decode().catch(() => {}))),
  );
  return swapped;
}

function restore(swapped: Swapped[]): void {
  for (const { img, original } of swapped) img.src = original;
}

export async function printView(name?: string): Promise<void> {
  const images = exportableImages();
  const controller = new AbortController();
  const { box, setText } = overlay(() => controller.abort());
  const signal = controller.signal;

  const label = (line: (done: number, total: number) => string) => (done: number, total: number) => {
    setText(line(done, total));
  };
  label(ui.print.preparing)(0, images.length);

  let swapped: Swapped[] = [];
  try {
    await hydrateAll(images, label(ui.print.preparing), signal);
    if (signal.aborted) return;

    // Downscaling before printing, not after: Chrome embeds whatever is in the
    // DOM when the dialog opens.
    swapped = await rasteriseAll(images, label(ui.print.sizing), signal);
    if (signal.aborted) return;

    setText(window.electronAPI ? ui.print.savingPdf : ui.print.openingPrint);
    // Two frames: one for the last decode to be painted, one for the layout it
    // changes to settle. Printing before this leaves the final cards blank.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (signal.aborted) return;

    // Hidden rather than removed, so a second export reuses the node — and so it
    // cannot appear in the printed output even if the stylesheet missed it.
    box.hidden = true;
    if (window.electronAPI?.printToPDF) {
      // The desktop shell: main process rasterises the same page straight to
      // a PDF file, with no dialog and no header/footer band. Awaited, same
      // as window.print() below, so restore() below only runs once the page
      // has actually been captured.
      const result = await window.electronAPI.printToPDF(name);
      if (!result.ok && result.error !== "cancelled") {
        box.hidden = false;
        setText(ui.print.exportFailed(result.error ?? ui.edit.unknownError));
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    } else {
      // Blocks until the dialog is dismissed, which is what makes it safe to
      // put the screen-sized images back on the next line.
      window.print();
    }
  } finally {
    // In `finally` so a cancelled or failed print still leaves the page as it
    // was found, rather than showing print-resolution images from then on.
    restore(swapped);
    box.hidden = true;
  }
}
