import type { PhotoRecord } from "@travel-archive/shared";
import { registerPlugin } from "@capacitor/core";
import { App } from "@capacitor/app";
import { setThumbnailSource, thumbnailSource, type ThumbnailSource } from "../photoSource";
import { loadLarge, loadThumbnail } from "../graphPhoto";
import { isNative } from "./native";

/**
 * Photographs served from this phone instead of from OneDrive.
 *
 * Most of the archive was taken on this phone and never left it. Measured on
 * the owner's: 24,110 of 31,721 photos, 79GB of 103GB, present byte for byte —
 * and over 90% of everything since 2021. Downloading those back to look at
 * them costs data, battery and a wait, for bytes already on the disk.
 *
 * **Matched on file name and exact byte size.** Both, because the same library
 * holds 1,898 names whose archived copy is a different encoding — 235KB in the
 * archive against 2.6MB on the phone — and showing one for the other would be
 * showing a different picture from the one the archive describes. A miss is
 * not a problem: `thumbnail()` in graphPhoto.ts falls back to OneDrive
 * whenever a source answers null, which is also what happens for the photos
 * that were never on this phone.
 *
 * The plugin only lists the library (name, size, id). The bytes are served by
 * MainActivity's WebViewClient from `/_device/…`, so an <img> gets an ordinary
 * same-origin URL and the WebView caches and decodes it as usual — see
 * LocalPhotosPlugin.java.
 */

interface LocalPhotosPlugin {
  status(): Promise<{ granted: boolean; canAsk: boolean }>;
  request(): Promise<{ granted: boolean; canAsk: boolean }>;
  index(): Promise<{ rows: string; count: number }>;
}

const LocalPhotos = registerPlugin<LocalPhotosPlugin>("LocalPhotos");

/** "name|bytes" (name lowercased) → MediaStore id. */
let library: Map<string, string> | null = null;
let building: Promise<void> | null = null;
/** Archive item id → "name|bytes", for photos seen in a shard. */
const keys = new Map<string, string>();

const keyOf = (photo: PhotoRecord) => `${photo.fileName.toLowerCase()}|${photo.bytes}`;

/**
 * Remembers what the archive says a photo is, so it can be recognised on disk.
 * Called for each shard as it loads: an id alone says nothing about a file.
 */
export function rememberPhotos(photos: Iterable<PhotoRecord>): void {
  if (!isNative) return;
  for (const photo of photos) if (photo.fileName) keys.set(photo.id, keyOf(photo));
}

async function buildLibrary(): Promise<void> {
  const { rows } = await LocalPhotos.index();
  const found = new Map<string, string>();
  // "<id>\t<bytes>\t<name>" a line. Split by hand rather than with a regex:
  // 26,000 rows, and this runs while the first screen is drawing.
  let at = 0;
  while (at < rows.length) {
    const end = rows.indexOf("\n", at);
    if (end < 0) break;
    const firstTab = rows.indexOf("\t", at);
    const secondTab = rows.indexOf("\t", firstTab + 1);
    if (firstTab > 0 && secondTab > firstTab && secondTab < end) {
      const id = rows.slice(at, firstTab);
      const bytes = rows.slice(firstTab + 1, secondTab);
      const name = rows.slice(secondTab + 1, end).toLowerCase();
      found.set(`${name}|${bytes}`, id);
    }
    at = end + 1;
  }
  library = found;
}

/** Whether this phone's own photos are being used, and how many it has. */
export function deviceLibrarySize(): number | null {
  return library ? library.size : null;
}

/** The MediaStore id and the size the archive expects, or null when unmatched. */
function deviceFile(itemId: string): { id: string; bytes: string } | null {
  const key = keys.get(itemId);
  if (!key) return null;
  const id = library?.get(key);
  return id ? { id, bytes: key.slice(key.lastIndexOf("|") + 1) } : null;
}

/** The original file on this phone, for "full resolution" — or null to fetch it. */
export function deviceFullUrl(itemId: string): string | null {
  const file = deviceFile(itemId);
  return file ? `/_device/full/${file.id}?b=${file.bytes}` : null;
}

/**
 * Sized for the phone's screen rather than the archive's names: `medium` is a
 * grid square on a 3x display, `large` fills the viewer. Android's own
 * thumbnail cache answers both without decoding the original.
 */
const PX: Record<string, number> = { medium: 420, large: 1280 };

const deviceSource: ThumbnailSource = {
  name: "this phone",
  url: async (itemId, size) => {
    // A thumbnail may be asked for before the library has been read; that is
    // one short wait on first paint, not a network round trip.
    if (building) await building;
    const file = deviceFile(itemId);
    // `b` is the size the archive recorded: the native side refuses to serve a
    // file that no longer has it, so an edit made while the app was open can
    // never be shown in place of what the archive describes.
    return file ? `/_device/thumb/${file.id}?px=${PX[size] ?? 420}&b=${file.bytes}` : null;
  },
};

/**
 * Turns the phone's own photos on, if the reader has allowed it. Never asks
 * here: permission is asked for from Settings, where there is room to say why.
 */
export async function initDevicePhotos(): Promise<boolean> {
  if (!isNative) return false;
  const { granted } = await LocalPhotos.status().catch(() => ({ granted: false }));
  if (!granted) return false;
  building = buildLibrary().catch((err) => {
    console.error("Photos on this phone could not be listed:", err);
    library = null;
  });
  setThumbnailSource(deviceSource);
  listenForChanges();
  return true;
}

let listening = false;
function listenForChanges(): void {
  if (listening) return;
  listening = true;

  // Photographs are taken, deleted and edited while this app is in the
  // background. The list is cheap to rebuild — one MediaStore query — and
  // doing it on every return keeps new photos showing from the phone and
  // deleted ones from being asked for.
  void App.addListener("resume", () => {
    building = buildLibrary().catch(() => {});
  });

  // A photo edited in the moments since the list was built is refused by the
  // native side (it checks the size again), and a deleted one is simply gone.
  // Either way the picture would be a blank square, so the match is dropped
  // and the photo fetched from OneDrive as if it had never been on the phone.
  document.addEventListener(
    "error",
    (event) => {
      const img = event.target as HTMLImageElement | null;
      if (!(img instanceof HTMLImageElement) || !img.src.includes("/_device/")) return;
      const itemId = img.dataset.photoId;
      if (!itemId) return;
      keys.delete(itemId);
      const size = img.dataset.loader === "large" ? loadLarge : loadThumbnail;
      void size(itemId).then((url) => {
        if (!url) return;
        // The fallback is a job-server URL, cross-origin from the page, so it
        // needs the session attached before it is assigned — see viewer.ts's
        // setSource.
        const crossOrigin = thumbnailSource()?.crossOrigin;
        if (crossOrigin) img.crossOrigin = crossOrigin;
        img.src = url;
      });
    },
    true, // capture: an <img> error does not bubble
  );
}

/** Asks Android for access, from a real tap. Returns whether it is now on. */
export async function allowDevicePhotos(): Promise<boolean> {
  if (!isNative) return false;
  const { granted } = await LocalPhotos.request().catch(() => ({ granted: false }));
  if (!granted) return false;
  return initDevicePhotos();
}

export async function deviceStatus(): Promise<{ granted: boolean; canAsk: boolean }> {
  if (!isNative) return { granted: false, canAsk: false };
  return LocalPhotos.status().catch(() => ({ granted: false, canAsk: false }));
}
