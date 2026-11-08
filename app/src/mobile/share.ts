import type { PhotoRecord } from "@travel-archive/shared";
import { loadFullPhoto, loadLarge } from "../graphPhoto";
import { deviceFullUrl, deviceMediaId } from "./devicePhotos";
import { isPhoneSurface } from "./surface";
import { cardFileName } from "./shareCard";

/**
 * Sending a photograph out of the app: the original file, or a rendered card.
 *
 * Two routes, because the phone and the browser can do different things:
 *
 *  - **the installed app** has `SharePlugin` (`android/.../SharePlugin.java`).
 *    A photo this phone holds is handed over as its MediaStore uri — no copy —
 *    and anything else (a card always) goes across as bytes written to the
 *    app's cache.
 *  - **a browser**, including this page opened on the desktop, uses the Web
 *    Share API when it can take files and falls back to a download. That
 *    fallback is not decoration: it is how the card gets looked at while
 *    developing the layout.
 */

interface SharePlugin {
  share(options: { base64: string; fileName: string; mime: string }): Promise<void>;
  shareDevice(options: { id: number; mime: string }): Promise<void>;
}

let cachedPlugin: SharePlugin | null | undefined;

async function sharePlugin(): Promise<SharePlugin | null> {
  if (cachedPlugin !== undefined) return cachedPlugin;
  if (!isPhoneSurface) {
    cachedPlugin = null;
    return cachedPlugin;
  }
  // The bridge's own registry first: Capacitor has already resolved every
  // native plugin by the time the page's first script runs, and a dynamic
  // `import("@capacitor/core")` inside a bundled chunk is a second path to the
  // same object that can resolve to nothing at all.
  const bridged = (globalThis as { Capacitor?: { Plugins?: Record<string, SharePlugin> } }).Capacitor?.Plugins?.Share;
  if (bridged) {
    cachedPlugin = bridged;
    return cachedPlugin;
  }
  try {
    const { registerPlugin } = await import("@capacitor/core");
    cachedPlugin = registerPlugin<SharePlugin>("Share");
  } catch {
    cachedPlugin = null;
  }
  return cachedPlugin;
}

/** `image/jpeg` from the archive's own file name. */
export function mimeOf(fileName: string): string {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  switch (extension) {
    case "heic":
    case "heif":
      return "image/heic";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "mp4":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "dng":
      return "image/x-adobe-dng";
    default:
      return "image/jpeg";
  }
}

/**
 * Base64 without blowing the call stack.
 *
 * `btoa` over a `String.fromCharCode(...bytes)` spread dies somewhere around a
 * hundred thousand bytes, and an original can be twenty million.
 */
function toBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Bytes out through the plugin, or the browser's share sheet / a download. */
async function shareBytes(blob: Blob, fileName: string, mime: string): Promise<void> {
  const plugin = await sharePlugin();
  if (plugin) {
    await plugin.share({ base64: toBase64(new Uint8Array(await blob.arrayBuffer())), fileName, mime });
    return;
  }
  const file = new File([blob], fileName, { type: mime });
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean; share?: (data: ShareData) => Promise<void> };
  if (nav.canShare?.({ files: [file] }) && nav.share) {
    await nav.share({ files: [file] });
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The original file behind a record, from this phone, the job server or OneDrive. */
export async function shareOriginal(photo: PhotoRecord): Promise<void> {
  const plugin = await sharePlugin();
  const deviceId = deviceMediaId(photo.id);
  if (plugin && deviceId !== null) {
    await plugin.shareDevice({ id: deviceId, mime: mimeOf(photo.fileName) });
    return;
  }
  await shareBytes(await photoBytes(photo), photo.fileName, mimeOf(photo.fileName));
}

/**
 * The bytes of a photograph, preferring the copy on this phone.
 *
 * `loadFullPhoto` knows about the job server and OneDrive and nothing about
 * `/_device/`, so asking it first sent a photo sitting on this phone out over
 * mobile data to come straight back: measured on the device, the local copy
 * arrives in 49ms and the OneDrive download had not finished after twenty
 * seconds, with the share sheet still saying "Preparing…".
 */
async function photoBytes(photo: PhotoRecord): Promise<Blob> {
  const url = deviceFullUrl(photo.id) ?? (await loadFullPhoto(photo.id));
  if (!url) throw new Error("the photograph could not be fetched");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`the photograph could not be fetched (HTTP ${response.status})`);
  return await response.blob();
}

/**
 * The photograph as a bitmap for the card, preferring the copy on this phone.
 *
 * Decoded through `createImageBitmap` from bytes rather than drawn from the
 * `<img>` on screen, because a canvas is tainted by any image whose response
 * lacks CORS headers and a tainted canvas cannot produce a file at all.
 *
 * A HEIC original that is not on this phone cannot be decoded by the WebView at
 * all, so the card falls back to the archive's `large` JPEG rendition — softer,
 * and still a picture rather than a failure.
 */
export async function cardBitmap(photo: PhotoRecord): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(await photoBytes(photo));
  } catch {
    const url = await loadLarge(photo.id);
    if (!url) throw new Error("the photograph could not be decoded");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`the photograph could not be fetched (HTTP ${response.status})`);
    return await createImageBitmap(await response.blob());
  }
}

/** An already-rendered card, out through whichever route this surface has. */
export async function shareCardBlob(blob: Blob, photo: PhotoRecord): Promise<void> {
  await shareBytes(blob, cardFileName(photo.fileName), "image/jpeg");
}
