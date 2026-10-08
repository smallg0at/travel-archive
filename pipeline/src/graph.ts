import type { DateSource, GeoPoint } from "@travel-archive/shared";
import { isNetworkError, parseDateFromFileName } from "./util.js";
import { getAccessToken } from "./auth.js";
import { BOX, renderImageThumbnail, renderVideoPoster } from "./localThumb.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/**
 * CI / test safety latch — the only OneDrive write path goes through this
 * module, so guard it here rather than in every caller.
 *
 * Fresh CI checkouts have no `.env` / `token-cache.json` (both gitignored),
 * but a leaked secret or a copied home dir could still point a test run at
 * the real library. Fail closed: any Graph call under CI/Vitest throws
 * unless `ALLOW_LIVE_ONEDRIVE=1` is set explicitly for a hand-run integration
 * pass. Pure-function tests never touch this module, so they are unaffected.
 */
/** Thrown by guardLiveGraph. A distinct class so the degrade-to-null catches
 * below can rethrow it instead of swallowing it like a network failure. */
export class LiveGuardError extends Error {
  constructor() {
    super(
      "Refusing live Graph call in CI/test (ALLOW_LIVE_ONEDRIVE!=1). " +
        "Unit tests must use fixtures; run integration by hand with a bounded --from/--to.",
    );
  }
}

function guardLiveGraph(): void {
  if (
    (process.env.CI || process.env.GITHUB_ACTIONS || process.env.VITEST) &&
    process.env.ALLOW_LIVE_ONEDRIVE !== "1"
  ) {
    throw new LiveGuardError();
  }
}

/**
 * A non-2xx from Graph, with the status, URL and body kept as fields rather
 * than folded into `message`.
 *
 * The message reaches a reader: a failed job's `error` is shown in the app's
 * day editor and its activity list. It used to be the whole request —
 * `https://graph.microsoft.com/…` plus the raw response body on one line —
 * which is both unreadable and longer than the panel it lands in. The fields
 * keep the detail for the job log; the message says what Graph said, without
 * the URL or the JSON around it.
 */
export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly url: string,
    readonly body: string,
  ) {
    super(`Graph API ${status} ${statusText}${detailOf(status, body)}`);
    this.name = "GraphError";
  }
}

/** Graph's own explanation for a failure, or a hint when the body is not JSON. */
function detailOf(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
    const message = parsed.error?.message;
    if (message) return ` — ${parsed.error?.code ? `${parsed.error.code}: ` : ""}${message}`;
  } catch {
    // Not a JSON error body; fall through to the status hint.
  }
  if (status === 401) return " — the OneDrive sign-in has expired; sign in again";
  if (status === 403) return " — OneDrive refused this request";
  if (status === 404) return " — the file or folder was not found";
  return "";
}


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
  video?: { duration?: number; width?: number; height?: number; fourCC?: string };
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
const PHOTO_SELECT = "id,name,size,file,folder,photo,image,video,location,fileSystemInfo";

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
  guardLiveGraph();
  let token = initialToken;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...init.headers },
      });
    } catch (err) {
      // No answer at all — a dropped socket. Throttling is handled below by
      // status; this is the case where there is no status to read, and on a
      // weak link it must not end a job that has run for an hour.
      if (attempt >= MAX_ATTEMPTS || !isNetworkError(err)) throw err;
      await sleep(DEFAULT_BACKOFF_MS * attempt);
      continue;
    }
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

    // 429 is Graph's documented throttle and 503 its documented outage; 502
    // and 504 are the gateway in front of it timing out — measured 2026-10-08
    // as a single 504 on one large folder, which killed a scan that had
    // already walked 106 of 144. Same answer for all four: wait, ask again.
    const transient =
      res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
    if (transient && attempt < MAX_ATTEMPTS) {
      const after = Number(res.headers.get("Retry-After"));
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : DEFAULT_BACKOFF_MS * attempt);
      continue;
    }
    throw new GraphError(res.status, res.statusText, url, await res.text().catch(() => ""));
  }
}

/** Drains every page of a /children listing, following @odata.nextLink. */
async function listChildren(token: string, folderPath: string, select: string): Promise<DriveItem[]> {
  const items: DriveItem[] = [];
  // The root has no `root:/…:` addressing — an empty path means "the drive's
  // root", which is where the setup picker starts when the configured folder
  // is wrong or unknown.
  let nextUrl: string | undefined = folderPath
    ? `${GRAPH_BASE}/me/drive/root:/${encodeURI(folderPath)}:/children?$top=200&$select=${select}`
    : `${GRAPH_BASE}/me/drive/root/children?$top=200&$select=${select}`;

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

/** The file names directly under a folder, one paginated Graph listing. */
export async function listFolderFileNames(token: string, folderPath: string): Promise<string[]> {
  const items = await listChildren(token, folderPath, "name");
  return items.map((item) => item.name).filter((name): name is string => !!name);
}

/**
 * The **folder** names directly under a path — what the setup picker walks.
 *
 * Separate from the listing above on purpose: a picker that offers files as
 * destinations is a picker that produces a wrong path, and the setup flow has
 * enough ways to end up with one already.
 */
export async function listChildFolderNames(token: string, folderPath: string): Promise<string[]> {
  const items = await listChildren(token, folderPath, "name,folder");
  return items
    .filter((item) => item.folder)
    .map((item) => item.name)
    .filter((name): name is string => !!name);
}

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
  /** True for a `video/*` item. Its poster frame is what gets captioned. */
  isVideo: boolean;
  /** Graph's `video.duration`, milliseconds. Null on an image, or when Graph omits it. */
  durationMs: number | null;
  fourCC: string | null;
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
    return {
      takenAt: fromName.iso,
      dateSource: fromName.hasTime ? "filename" : "filename-date",
      timeSuspect: timeSuspect || !fromName.hasTime,
    };
  }

  // Last resort, and the one sync actually rewrites: a filesystem timestamp
  // reflects when OneDrive last wrote the file, not when the photo was taken.
  const fs = item.fileSystemInfo?.createdDateTime ?? null;
  if (fs) return { takenAt: fs, dateSource: "filesystem", timeSuspect: true };

  return { takenAt: null, dateSource: "none", timeSuspect: false };
}

/**
 * Every image or video in one folder. Pages are fully drained before recursing
 * so a paginated month never gets interleaved with its siblings. Anything that
 * is neither `image/*` nor `video/*` is skipped.
 *
 * **Videos are indexed like photos**, with Graph's `video` facet supplying
 * duration and dimensions. They cost nothing to index and, crucially, Graph
 * renders a **poster thumbnail** for them — so `analyze` can caption that one
 * frame through the same path as a photo without ever downloading the video.
 */
export async function listPhotosInFolder(token: string, folderPath: string, recursive = true): Promise<ScannedPhoto[]> {
  const results: ScannedPhoto[] = [];
  const subfolders: string[] = [];

  for (const item of await listChildren(token, folderPath, PHOTO_SELECT)) {
    const itemPath = `${folderPath}/${item.name}`;
    if (item.folder) {
      if (recursive) subfolders.push(itemPath);
      continue;
    }
    const mime = item.file?.mimeType ?? "";
    const isVideo = mime.startsWith("video/");
    if (!mime.startsWith("image/") && !isVideo) continue;
    results.push({
      id: item.id,
      name: item.name,
      path: itemPath,
      ...takenAtOf(item),
      width: item.image?.width ?? item.video?.width ?? null,
      height: item.image?.height ?? item.video?.height ?? null,
      bytes: item.size ?? 0,
      gps: coordsOf(item),
      isVideo,
      durationMs: item.video?.duration ?? null,
      fourCC: item.video?.fourCC ?? null,
    });
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
 * Returns null when Graph has no thumbnail for the item — and now, before it
 * gives up, when Graph *will not* render one. See `renderMissing` below.
 */
export async function downloadThumbnailBuffer(
  token: string,
  itemId: string,
  size: "medium" | "large" = "large",
): Promise<Buffer | null> {
  const meta = await graphFetch(token, `/me/drive/items/${itemId}/thumbnails/0/${size}`);
  const { url } = (await meta.json()) as { url?: string };

  if (url) {
    // The thumbnail URL is already pre-authenticated; sending our bearer token
    // to that host would leak it to a different origin.
    const res = await fetch(url);
    if (res.ok) {
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length) return bytes;
    }
    // A non-ok answer here is not "still processing". For a growing list of
    // items — HEIC, DNG, MP4, and JPEGs too — Graph hands back a transform URL
    // and the CDN answers 406 with a failure OneDrive cached months ago
    // (`Substitution Stream for ImageProcessingFailure found in slot`). Asking
    // again gets the same bytes of JSON forever, so the original is rendered
    // here instead: localThumb.ts.
  }

  return renderMissing(token, itemId, size);
}

/**
 * How long to wait before trying to render an item locally again.
 *
 * Without this, one cell the decoders also fail on re-downloads its original
 * — megabytes — on *every* request for as long as the page is open. The
 * result is remembered rather than written to the thumb store, because a
 * failure that outlives the process is exactly what installing ffmpeg or
 * fixing a broken `sharp` install must be able to clear.
 */
const RENDER_COOLDOWN_MS = 10 * 60_000;
const renderGaveUpAt = new Map<string, number>();

/**
 * The original, rendered here, for items OneDrive will not thumbnail.
 *
 * Two things this deliberately does **not** do: it never returns a placeholder
 * (a grey tile must not reach the model as a photograph — callers counting
 * "no thumbnail" depend on `null` meaning exactly that), and it never hides a
 * dropped connection behind a permanent "no" (`isNetworkError` is rethrown, so
 * the next run retries rather than recording a skip).
 *
 * Video takes a different route from the images: its bytes are never read into
 * memory. The pre-authenticated download URL is handed to ffmpeg, which seeks
 * with Range requests — a 382MB original costs one keyframe.
 */
async function renderMissing(token: string, itemId: string, size: "medium" | "large"): Promise<Buffer | null> {
  const gaveUp = renderGaveUpAt.get(itemId);
  if (gaveUp && Date.now() - gaveUp < RENDER_COOLDOWN_MS) return null;

  try {
    // No `$select`: Graph drops `@microsoft.graph.downloadUrl` whenever other
    // fields are selected on this item — measured 2026-10-07, the same MP4
    // returned it on a plain GET and omitted it under
    // `$select=file,@microsoft.graph.downloadUrl`. A few dozen extra bytes on a
    // path this rare is a cheaper trade than a second request.
    const res = await graphFetch(token, `/me/drive/items/${itemId}`);
    const item = (await res.json()) as { file?: { mimeType?: string }; "@microsoft.graph.downloadUrl"?: string };
    const box = BOX[size];
    const downloadUrl = item["@microsoft.graph.downloadUrl"] ?? null;

    const bytes = (item.file?.mimeType ?? "").startsWith("video/")
      ? downloadUrl
        ? await renderVideoPoster(downloadUrl, box)
        : null
      : await renderImageThumbnail(await downloadPhotoBuffer(token, itemId), box);

    if (bytes?.length) return bytes;
    renderGaveUpAt.set(itemId, Date.now());
    return null;
  } catch (err) {
    if (err instanceof LiveGuardError) throw err;
    if (isNetworkError(err)) throw err;
    renderGaveUpAt.set(itemId, Date.now());
    return null;
  }
}

/**
 * Original bytes for one item, via the authenticated content endpoint. Note
 * this deliberately doesn't use `@microsoft.graph.downloadUrl`: that
 * annotation disappears once you `$select` specific fields (which the scan
 * pass does), and it's a short-lived pre-authenticated URL that would be
 * stale by the time the AI pass got to it anyway.
 */
/**
 * Renames a file in OneDrive.
 *
 * The one place the pipeline writes to the photo library itself rather than to
 * its own metadata folder — see `renameForTakenAt` for why a rename is how a
 * photo's timestamp is corrected. Graph rejects a name that collides with a
 * sibling, which surfaces here as the error it is rather than silently
 * producing a second copy.
 */
export async function renamePhoto(token: string, itemId: string, name: string): Promise<void> {
  const res = await graphFetch(token, `/me/drive/items/${itemId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error(`Could not rename to "${name}": ${res.status} ${res.statusText} ${await res.text()}`.trim());
  }
}

export interface ItemHashes {
  id: string;
  name: string;
  size: number;
  /** The folder, as Graph reports it ("/drive/root:/Pictures/2026-09"). */
  folder: string | null;
  sha256?: string;
  sha1?: string;
  quickXor?: string;
}

/**
 * A file's content hashes, for `dedupe`. The archive keeps no hashes — its
 * duplicate groups are name, size and capture time — so deleting anything
 * waits on this: the bytes themselves must be shown identical. Null when the
 * item is gone.
 */
export async function fetchItemHashes(token: string, itemId: string): Promise<ItemHashes | null> {
  try {
    const res = await graphFetch(token, `/me/drive/items/${itemId}?$select=id,name,size,file,parentReference`);
    const item = (await res.json()) as {
      id?: string;
      name?: string;
      size?: number;
      file?: { hashes?: { sha256Hash?: string; sha1Hash?: string; quickXorHash?: string } };
      parentReference?: { path?: string };
    };
    if (!item.id) return null;
    const h = item.file?.hashes ?? {};
    return {
      id: item.id,
      name: item.name ?? "",
      size: item.size ?? 0,
      folder: item.parentReference?.path ?? null,
      sha256: h.sha256Hash,
      sha1: h.sha1Hash,
      quickXor: h.quickXorHash,
    };
  } catch (err) {
    if (err instanceof LiveGuardError) throw err;
    return null;
  }
}

/**
 * Deletes a file the way OneDrive's own Delete does: into the recycle bin,
 * where it can be restored for about 30 days. The only caller is `dedupe
 * --apply`, for copies whose bytes were just shown identical to a file kept.
 */
export async function recycleItem(token: string, itemId: string): Promise<void> {
  await graphFetch(token, `/me/drive/items/${itemId}`, { method: "DELETE" });
}

/**
 * The pre-authenticated CDN URL for an item's bytes, without fetching them.
 *
 * Used for video playback: a `<video>` pointed at this streams through HTTP
 * Range requests, so only the part actually watched crosses the wire rather
 * than a 382MB original. Contrast `downloadPhotoBuffer`, which reads the whole
 * file into memory.
 */
export async function fetchItemDownloadUrl(token: string, itemId: string): Promise<string | null> {
  const res = await graphFetch(token, `/me/drive/items/${itemId}?$select=@microsoft.graph.downloadUrl`);
  if (!res.ok) return null;
  const body = (await res.json()) as Record<string, string>;
  return body["@microsoft.graph.downloadUrl"] ?? null;
}

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
  } catch (err) {
    if (err instanceof LiveGuardError) throw err;
    return null;
  }
}

/** Downloads a metadata JSON file previously written by uploadMetadataJson. Returns null if it doesn't exist yet. */
export async function downloadMetadataJson<T>(token: string, metadataFolder: string, fileName: string): Promise<T | null> {
  const path = `${metadataFolder}/${fileName}`;
  try {
    const res = await graphFetch(token, `/me/drive/root:/${encodeURI(path)}:/content`);
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof LiveGuardError) throw err;
    return null;
  }
}
