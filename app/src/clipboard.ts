/**
 * Putting the photograph on screen into the clipboard.
 *
 * **PNG is the only format that can go there.** `ClipboardItem` accepts
 * `image/png` and nothing else in Chromium, while this library is mostly HEIC
 * and JPEG — so the picture is re-encoded from the pixels the browser already
 * decoded, not handed over as the file it came from.
 *
 * **And PNG of a photograph is enormous**, which is why the copy is capped.
 * Measured on two real originals: 4080×3072 encodes to **24.9 MB** and takes
 * 1175ms; 3072×4096 to **15.7 MB** / 1009ms. Pasting one of those into
 * Explorer produced a 20MB file on disk, which is what a reader notices. At a
 * 1600px long edge the same two are 4.7 MB / 140ms and 3.3 MB / 216ms — the
 * cap buys speed as well as size, because PNG's cost is the pixel count. The
 * budget below is the backstop for a photograph that is noisy enough to blow
 * past it at 1600.
 *
 * **Only in a secure context.** `navigator.clipboard` does not exist on a plain
 * http origin, which is exactly how the archive is read over the home network
 * (`http://<lan-ip>:17923`). The caller asks first and hides the control rather
 * than offering one that cannot work — the same rule as the encrypted screen
 * descriptions, which need `crypto.subtle` and are likewise absent there.
 */

const PNG = "image/png";

/** The long edge the copy is scaled to. Detail enough to paste into a document. */
const MAX_EDGE = 1600;
/** If a photograph still encodes past this, it is re-encoded smaller. */
const BUDGET_BYTES = 4 * 1024 * 1024;
/** The second and last attempt: 4080×3072 measured 2.7 MB here. */
const FALLBACK_EDGE = 1200;

/**
 * Whether this page can copy an image at all.
 *
 * Asked once at startup: none of these answers change while the page is open.
 * A missing `supports` is not a refusal — it is a browser old enough not to
 * have been asked, and the write itself will be the answer.
 */
export function canCopyImage(): boolean {
  if (!window.isSecureContext) return false;
  if (typeof ClipboardItem === "undefined") return false;
  if (typeof navigator.clipboard?.write !== "function") return false;
  return typeof ClipboardItem.supports !== "function" || ClipboardItem.supports(PNG);
}

/**
 * Copies what `img` is showing, scaled to a size a clipboard can carry.
 *
 * **`write` is called immediately, and everything slow happens in the promise
 * it is handed.** The click's user activation is what permits the write, and it
 * does not survive an `await`: measured here, waiting 10s for the original
 * photograph first made `write` fail with `NotAllowedError` even though the
 * document was focused and the permission granted. A promise that resolved 8s
 * later, by contrast, wrote correctly — so the wait for the original and the
 * PNG encode both live inside the `ClipboardItem`, and `whenReady` rejecting
 * (the reader moved to another photograph) makes the write fail instead of
 * copying the wrong picture.
 *
 * What lands on the clipboard is the decoded image, not the file: the browser
 * has already applied EXIF orientation, so a portrait photograph pastes
 * upright, and a zoomed or panned view copies the whole picture rather than the
 * visible crop. `naturalWidth`/`naturalHeight` is what makes the second half
 * true — the element's rendered size is whatever the zoom left it at.
 */
export async function copyImage(img: HTMLImageElement, whenReady: Promise<void>): Promise<void> {
  const png = whenReady.then(() => encodePng(img));
  await navigator.clipboard.write([new ClipboardItem({ [PNG]: png })]);
}

async function encodePng(img: HTMLImageElement): Promise<Blob> {
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (width === 0 || height === 0) throw new Error("the image has not decoded");

  const first = await drawPng(img, MAX_EDGE);
  if (first.size <= BUDGET_BYTES) return first;
  // A photograph noisy enough to be over budget at 1600 gets one smaller try
  // rather than being handed over at whatever size it came out.
  return drawPng(img, FALLBACK_EDGE);
}

/** The photograph, scaled so its long edge is at most `edge` pixels, as PNG. */
async function drawPng(img: HTMLImageElement, edge: number): Promise<Blob> {
  const natural = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = Math.min(1, edge / natural);
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2d drawing context");
  // Downscaling a 12-megapixel photograph by a third in one `drawImage` is
  // nearest-neighbour in effect and shows as jaggies on fine detail; the
  // `imageSmoothingQuality` hint asks for the better resampler.
  context.imageSmoothingQuality = "high";
  context.drawImage(img, 0, 0, width, height);

  // A canvas drawn from an image this page did not load itself is tainted, and
  // `toBlob` is where that surfaces — as a rejection, not a silent empty blob.
  // The viewer never offers this for such an image (see `openLightbox`).
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, PNG));
  if (!blob) throw new Error("PNG encoding failed");
  return blob;
}
