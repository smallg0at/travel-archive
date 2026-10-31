/**
 * Putting the photograph on screen into the clipboard.
 *
 * **PNG is the only format that can go there.** `ClipboardItem` accepts
 * `image/png` and nothing else in Chromium, while this library is mostly HEIC
 * and JPEG — so the picture is re-encoded from the pixels the browser already
 * decoded, not handed over as the file it came from.
 *
 * **Only in a secure context.** `navigator.clipboard` does not exist on a plain
 * http origin, which is exactly how the archive is read over the home network
 * (`http://<lan-ip>:17923`). The caller asks first and hides the control rather
 * than offering one that cannot work — the same rule as the encrypted screen
 * descriptions, which need `crypto.subtle` and are likewise absent there.
 */

const PNG = "image/png";

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
 * Copies what `img` is showing, at its own resolution.
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

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2d drawing context");
  context.drawImage(img, 0, 0, width, height);

  // A canvas drawn from an image this page did not load itself is tainted, and
  // `toBlob` is where that surfaces — as a rejection, not a silent empty blob.
  // The viewer never offers this for such an image (see `openLightbox`).
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, PNG));
  if (!blob) throw new Error("PNG encoding failed");
  return blob;
}
