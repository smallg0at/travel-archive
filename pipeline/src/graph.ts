import type { DateSource, GeoPoint } from "@travel-archive/shared";
import { parseDateFromFileName } from "./util.js";
import { getAccessToken } from "./auth.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/**
 * Facets Graph returns on an image driveItem. These are the reason the scan
 * pass is cheap: capture date, GPS and pixel dimensions all come back on the
 * *listing* response, so indexing a 10k-photo library downloads zero photo
 * bytes. (Only the AI pass in analyze.ts actually fetches image content.)
 */
export interface DriveItem {
  id: string;
  name: string;
  size: number;
  file?: { mimeType: string };
  folder?: { childCount: number };
  photo?: { takenDateTime?: string };
  image?: { width?: number; height?: number };
  location?: { latitude?: number; longitude?: number };
  fileSystemInfo?: { createdDateTime?: string };
}

interface ChildrenPage {
  value: DriveItem[];
  "@odata.nextLink"?: string;
}

// Explicit $select keeps the listing payload small and, more importantly,
// makes the facets above actually show up — Graph omits some of them from
// the default projection.
const PHOTO_SELECT = "id,name,size,file,folder,photo,image,location,fileSystemInfo";

async function graphFetch(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return graphFetchUrl(token, `${GRAPH_BASE}${path}`, init);
}

/** Like graphFetch, but takes a full URL — needed for @odata.nextLink, which
 * Graph returns as an absolute URL rather than a path to prepend GRAPH_BASE to. */
/** Attempts per request before a throttled call is treated as a real failure. */
const MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_MS = 4000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Graph throttles this account in normal use, and until now the pipeline did
 * not handle it at all — any 429 threw, which `analyze` caught and counted as a
 * failed photo. That was survivable only because four concurrent workers rarely
 * tripped the limit. It is the thing that would break first on raising
 * concurrency, so backoff belongs here rather than in the caller.
 *
 * Honours `Retry-After` when Graph sends one, since it knows how long the
 * penalty has left far better than any fixed guess.
 */
async function graphFetchUrl(initialToken: string, url: string, init: RequestInit = {}): Promise<Response> {
  let token = initialToken;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
    });
    if (res.ok) return res;

    // A Graph token lasts about an hour. `analyze` acquires one at the start of
    // a run that can last longer than that, so without this every request past
    // the expiry would 401 and every remaining photo would be recorded as
    // failed. Re-acquiring is cheap — auth.ts renews silently from the cached
    // refresh token — so it is done here rather than threaded through callers.
    if (res.status === 401 && attempt < MAX_ATTEMPTS) {
      token = await getAccessToken();
      continue;
    }

    const throttled = res.status === 429 || res.status === 503;
    if (throttled && attempt < MAX_ATTEMPTS) {
      const after = Number(res.headers.get("Retry-After"));
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : DEFAULT_BACKOFF_MS * attempt);
      continue;
    }
    throw new Error(`Graph API ${url} failed: ${res.status} ${res.statusText} — ${await res.text()}`);
  }
}

/** Drains every page of a /children listing, following @odata.nextLink. */
async function listChildren(token: string, folderPath: string, select: string): Promise<DriveItem[]> {
  const items: DriveItem[] = [];
  let nextUrl: string | undefined =
    `${GRAPH_BASE}/me/drive/root:/${encodeURI(folderPath)}:/children?$top=200&$select=${select}`;

  while (nextUrl) {
    const res: Response = await graphFetchUrl(token, nextUrl);
    const body = (await res.json()) as ChildrenPage;
    items.push(...body.value);
    nextUrl = body["@odata.nextLink"];
  }
  return items;
}

const FLAT_MONTH_FOLDER = /^\d{4}-\d{2}$/;
const YEAR_FOLDER = /^\d{4}$/;
const NESTED_MONTH_FOLDER = /^\d{1,2}$/;

export interface PhotoFolder {
  path: string;
  /** The month this folder implies ("2025-04"), or null when it just holds loose files. */
  month: string | null;
  /** Year for range-filtering a loose-file folder; null for the library root itself. */
  year: string | null;
  /** Whether to descend into subfolders. False for loose-file folders, whose subfolders are listed separately. */
  recursive: boolean;
}

/**
 * Finds the folders worth scanning, and what month each one implies. Knowing
 * the month up front is what makes a date-bounded scan cheap — we list only
 * the folders in range instead of walking the whole library and filtering.
 *
 * Two layouts are recognized, since either is a reasonable way to file a
 * library: flat `yyyy-mm` directly under the root, and nested `yyyy/mm` with
 * bare month names (`01`..`12`), which is what this library actually uses.
 *
 * Photos also sit loose in some year folders and in the root itself, so those
 * are returned as month-less, non-recursive entries — their shard comes from
 * each photo's own capture date instead of from the folder.
 */
export async function listPhotoFolders(token: string, rootPath: string): Promise<PhotoFolder[]> {
  const folders: PhotoFolder[] = [];

  for (const item of await listChildren(token, rootPath, "id,name,folder")) {
    if (!item.folder) continue;
    const path = `${rootPath}/${item.name}`;

    if (FLAT_MONTH_FOLDER.test(item.name)) {
      folders.push({ path, month: item.name, year: item.name.slice(0, 4), recursive: true });
      continue;
    }

    if (YEAR_FOLDER.test(item.name)) {
      const year = item.name;
      for (const sub of await listChildren(token, path, "id,name,folder")) {
        if (sub.folder && NESTED_MONTH_FOLDER.test(sub.name)) {
          folders.push({
            path: `${path}/${sub.name}`,
            month: `${year}-${sub.name.padStart(2, "0")}`,
            year,
            recursive: true,
          });
        }
      }
      folders.push({ path, month: null, year, recursive: false });
    }
  }

  folders.push({ path: rootPath, month: null, year: null, recursive: false });
  return folders.sort((a, b) => (a.month ?? a.year ?? "").localeCompare(b.month ?? b.year ?? ""));
}

export interface ScannedPhoto {
  id: string;
  name: string;
  path: string;
  takenAt: string | null;
  dateSource: DateSource;
  timeSuspect: boolean;
  width: number | null;
  height: number | null;
  /** Doubles as a free sharpness proxy when picking a burst's representative — see bursts.ts. */
  bytes: number;
  gps: GeoPoint | null;
}

function coordsOf(item: DriveItem): GeoPoint | null {
  const lat = item.location?.latitude;
  const lon = item.location?.longitude;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  // Null Island is what a camera writes when it has a GPS chip but no fix.
  if (lat === 0 && lon === 0) return null;
  return { lat, lon };
}

/**
 * Capture time, best effort, in descending order of trustworthiness:
 *  1. `photo.takenDateTime` — real EXIF, present on actual camera photos.
 *  2. The filename — screenshots and messaging-app saves usually have no
 *     EXIF at all but do encode the date (`Screenshot_20250412_143022.png`),
 *     and for a library that's "a big mix of screenshots, photos everyday"
 *     that covers a large slice of it.
 *  3. `fileSystemInfo.createdDateTime` — preserved from the source device
 *     when OneDrive has it, but degrades to the upload time for anything
 *     copied in, so it's the last resort rather than a peer of the others.
 */
function takenAtOf(item: DriveItem): { takenAt: string | null; dateSource: DateSource; timeSuspect: boolean } {
  const fromName = parseDateFromFileName(item.name);
  const exif = item.photo?.takenDateTime ?? null;

  // Both EXIF and the filename are stamped by the camera at capture and never
  // change afterwards, so when they disagree by more than an hour something
  // has rewritten one of them — which is exactly the phone-sync drift that
  // shifts times by a few hours. The date is still usable (the day is usually
  // right), but nothing downstream should treat the clock time as precise.
  let timeSuspect = false;
  if (exif && fromName) {
    const driftMs = Math.abs(Date.parse(exif) - Date.parse(fromName.iso));
    timeSuspect = Number.isFinite(driftMs) && driftMs > 60 * 60 * 1000;
  }

  if (exif) return { takenAt: exif, dateSource: "exif", timeSuspect };
  // A filename with a date but no clock time gives a midnight nobody measured.
  // Left unflagged it reads as a precise time — it renders as "01:00" to a
  // UTC+1 viewer, and stops.ts opens the day with a stop that never happened.
  // The day is still right, which is what the album files on.
  if (fromName) {
    return { takenAt: fromName.iso, dateSource: "filename", timeSuspect: timeSuspect || !fromName.hasTime };
  }

  // Last resort, and the one sync actually rewrites: a filesystem timestamp
  // reflects when OneDrive last wrote the file, not when the photo was taken.
  const fs = item.fileSystemInfo?.createdDateTime ?? null;
  if (fs) return { takenAt: fs, dateSource: "filesystem", timeSuspect: true };

  return { takenAt: null, dateSource: "none", timeSuspect: false };
}

/**
 * Every image in one folder. Pages are fully drained before recursing so a
 * paginated month never gets interleaved with its siblings. Non-image files
 * (this library has plenty of .mp4 alongside the photos) are skipped.
 */
export async function listPhotosInFolder(token: string, folderPath: string, recursive = true): Promise<ScannedPhoto[]> {
  const results: ScannedPhoto[] = [];
  const subfolders: string[] = [];

  for (const item of await listChildren(token, folderPath, PHOTO_SELECT)) {
    const itemPath = `${folderPath}/${item.name}`;
    if (item.folder) {
      if (recursive) subfolders.push(itemPath);
    } else if (item.file?.mimeType.startsWith("image/")) {
      results.push({
        id: item.id,
        name: item.name,
        path: itemPath,
        ...takenAtOf(item),
        width: item.image?.width ?? null,
        height: item.image?.height ?? null,
        bytes: item.size ?? 0,
        gps: coordsOf(item),
      });
    }
  }

  for (const sub of subfolders) {
    results.push(...(await listPhotosInFolder(token, sub)));
  }
  return results;
}

/**
 * A pre-rendered 800px thumbnail, which is what the AI pass actually sends.
 *
 * The bake-off compared both against real museum placards: at 800px Gemini
 * transcribed a bronze plaque as accurately as it did from the 7MB original,
 * only losing the line-break structure and, on one painting, a small secondary
 * title card. That is a ~60x reduction in upload for near-identical output —
 * and image token cost is set by the model's own tiling, not by how many
 * megabytes we ship, so the saving is bandwidth and latency rather than tokens.
 *
 * Returns null when Graph has no thumbnail for the item.
 */
export async function downloadThumbnailBuffer(
  token: string,
  itemId: string,
  size: "medium" | "large" = "large",
): Promise<Buffer | null> {
  const meta = await graphFetch(token, `/me/drive/items/${itemId}/thumbnails/0/${size}`);
  const { url } = (await meta.json()) as { url?: string };
  if (!url) return null;

  // The thumbnail URL is already pre-authenticated; sending our bearer token
  // to that host would leak it to a different origin.
  const res = await fetch(url);
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Original bytes for one item, via the authenticated content endpoint. Note
 * this deliberately doesn't use `@microsoft.graph.downloadUrl`: that
 * annotation disappears once you `$select` specific fields (which the scan
 * pass does), and it's a short-lived pre-authenticated URL that would be
 * stale by the time the AI pass got to it anyway.
 */
export async function downloadPhotoBuffer(token: string, itemId: string): Promise<Buffer> {
  const res = await graphFetch(token, `/me/drive/items/${itemId}/content`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Uploads (overwrites) a JSON file at metadataFolder/fileName. Written
 * minified: the local copy under pipeline/data/ is pretty-printed for
 * reading, but pretty-printing the uploaded copy inflated it ~40% for no
 * benefit, and this is re-uploaded in full on every run that touches it.
 *
 * Returns the new eTag so sync can record what it just wrote. Without that the
 * next freshness check cannot tell "someone else changed this" from "we changed
 * it ourselves a moment ago".
 */
export async function uploadMetadataJson(
  token: string,
  metadataFolder: string,
  fileName: string,
  data: unknown,
): Promise<string | null> {
  const path = `${metadataFolder}/${fileName}`;
  const res = await graphFetch(token, `/me/drive/root:/${encodeURI(path)}:/content`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const item = (await res.json().catch(() => null)) as { eTag?: string } | null;
  return item?.eTag ?? null;
}

/**
 * An item's eTag and modified time, without downloading it.
 *
 * This is what makes a freshness check cheap: the same question asked with
 * `/content` costs 2.4MB and measured 1,237-3,289ms for index.json alone.
 * Null when the file is not there — a fresh archive, not an error.
 */
export async function fetchItemMeta(
  token: string,
  metadataFolder: string,
  fileName: string,
): Promise<{ eTag: string | null; lastModifiedDateTime: string | null } | null> {
  const path = `${metadataFolder}/${fileName}`;
  try {
    const res = await graphFetch(
      token,
      `/me/drive/root:/${encodeURI(path)}:?$select=eTag,lastModifiedDateTime`,
    );
    const item = (await res.json()) as { eTag?: string; lastModifiedDateTime?: string };
    return { eTag: item.eTag ?? null, lastModifiedDateTime: item.lastModifiedDateTime ?? null };
  } catch {
    return null;
  }
}

/** Downloads a metadata JSON file previously written by uploadMetadataJson. Returns null if it doesn't exist yet. */
export async function downloadMetadataJson<T>(token: string, metadataFolder: string, fileName: string): Promise<T | null> {
  const path = `${metadataFolder}/${fileName}`;
  try {
    const res = await graphFetch(token, `/me/drive/root:/${encodeURI(path)}:/content`);
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
