import type { MonthSummary, PhotoRecord, PhotoShard } from "@travel-archive/shared";
import { getAccessToken } from "../auth.js";
import { listPhotoFolders, listPhotosInFolder, type PhotoFolder, type ScannedPhoto } from "../graph.js";
import { env } from "../env.js";
import { loadIndex, loadShard, saveIndex, saveShard } from "../archiveStore.js";
import { formatMonthLabel, monthKey } from "../util.js";
import { assignDuplicates, analysisTargets } from "../duplicates.js";
import { flagGpsOutliersByDay } from "../geo.js";
import { isScreenshot, loadScreenshotAllowlist, mayBeAnalyzed, screenshotPolicyFor } from "../screenshots.js";
import { readSync, writeSync } from "../syncStore.js";
import type { ProgressFn } from "./analyze.js";

/**
 * Indexes OneDrive into per-month shards using nothing but Graph listing
 * calls — no photo downloads, no AI, no tokens spent. This is what makes the
 * album usable over a whole library immediately; `analyze` fills in captions
 * later, and only for the photos you point it at.
 *
 * Callable by both the CLI (`../scan.ts`) and the job server, which is what
 * lets the app trigger a rescan without a terminal. The lock is **not** taken
 * here: the CLI wraps this in `withArchiveLock` and `server/jobs.ts` does the
 * same for every job it starts, so taking it here would deadlock against both.
 */

export interface ScanResult extends Record<string, number> {
  scanned: number;
  folders: number;
  undated: number;
  shards: number;
  indexed: number;
  analyzed: number;
  months: number;
}

/** Inclusive month bounds, `yyyy-mm`. Both null scans the whole library. */
export interface Range {
  from: string | null;
  to: string | null;
}

export type ScanMode = "full" | "range" | "incremental";

/**
 * Turns a mode into the range to scan.
 *
 * **Incremental starts at the month of the last completed scan**, not the month
 * after it: the month a scan ran in was still being added to, so starting after
 * it would skip whatever arrived later that month.
 *
 * Never scanned means there is no lower bound to be incremental from, so it
 * degrades to a full run rather than silently scanning nothing.
 *
 * The upper bound is left open. A closed `to` of "this month" would exclude a
 * photo whose capture date reads as next month, which happens with a wrong
 * camera clock — and those are exactly the records worth picking up.
 */
export async function resolveRange(mode: ScanMode, requested: Range): Promise<Range> {
  if (mode === "range") return requested;
  if (mode === "full") return { from: null, to: null };
  const { lastScanAt } = await readSync();
  return { from: lastScanAt ? lastScanAt.slice(0, 7) : null, to: null };
}

function bounded(range: Range): boolean {
  return Boolean(range.from || range.to);
}

function inRange(folder: PhotoFolder, range: Range): boolean {
  if (!bounded(range)) return true;

  // A folder with a month is compared directly. A loose-file folder is
  // compared on its year, so a bounded scan doesn't drag in a decade of
  // stray files. The library root has neither, so it's only scanned when
  // the run is unbounded — otherwise "2025 only" would pull in every loose
  // file at the top level.
  if (folder.month) {
    if (range.from && folder.month < range.from) return false;
    if (range.to && folder.month > range.to) return false;
    return true;
  }
  if (folder.year) {
    if (range.from && folder.year < range.from.slice(0, 4)) return false;
    if (range.to && folder.year > range.to.slice(0, 4)) return false;
    return true;
  }
  return false;
}

function toRecord(photo: ScannedPhoto, month: string, allowlist: string[]): PhotoRecord {
  return {
    id: photo.id,
    fileName: photo.name,
    oneDrivePath: photo.path,
    month,
    takenAt: photo.takenAt,
    dateSource: photo.dateSource,
    timeSuspect: photo.timeSuspect,
    width: photo.width,
    height: photo.height,
    bytes: photo.bytes,
    gps: photo.gps,
    place: null,
    gpsSuspect: false,
    duplicateGroupId: null,
    duplicateKind: null,
    isDuplicateRepresentative: false,
    analyzedAt: null,
    contentType: null,
    caption: null,
    tags: [],
    extractedText: null,
    notable: false,
    quality: null,
    visibility: null,
    screenshot: isScreenshot(photo.name) ? screenshotPolicyFor(photo.name, allowlist) : null,
    sensitive: null,
    inheritedFrom: null,
  };
}

/**
 * Carries forward everything the AI pass (and reverse geocoding) previously
 * derived, while refreshing the facts re-read from Graph. Rescanning a month
 * must never silently discard captions that cost tokens to produce.
 */
function merge(fresh: PhotoRecord, prior: PhotoRecord | undefined): PhotoRecord {
  if (!prior) return fresh;
  return {
    ...fresh,
    place: prior.place,
    // With the place, always. Carrying `place` alone stripped the English and
    // Chinese names from every photo in a month each time it was rescanned —
    // 1,650 in September 2026, which the six-hourly scan revisits as photos
    // land — and the map and search fell back to endonyms for all of them.
    placeNames: prior.placeNames,
    near: prior.near,
    analyzedAt: prior.analyzedAt,
    contentType: prior.contentType,
    caption: prior.caption,
    tags: prior.tags,
    extractedText: prior.extractedText,
    notable: prior.notable,
    quality: prior.quality,
    visibility: prior.visibility,
    sensitive: prior.sensitive ?? null,
    inheritedFrom: prior.inheritedFrom,
  };
}

export function summarize(shard: PhotoShard): MonthSummary {
  const photos = Object.values(shard.photos);
  const sorted = [...photos].sort((a, b) => (a.takenAt ?? "").localeCompare(b.takenAt ?? ""));
  return {
    month: shard.month,
    label: formatMonthLabel(shard.month),
    photoCount: photos.length,
    // What `analyze` actually has to pay for: duplicate copies inherit, and
    // screenshots from non-allowlisted apps are never sent anywhere.
    representativeCount: analysisTargets(photos).filter(mayBeAnalyzed).length,
    analyzedCount: photos.filter((p) => p.analyzedAt).length,
    coverPhotoId: sorted[0]?.id ?? null,
  };
}

/**
 * Whether a previously-stored record came from territory this run covered —
 * which is what makes it safe to treat its absence as a deletion.
 *
 * Compared on full paths, not folder names: with the nested `yyyy/mm` layout
 * the month folders are bare `01`..`12`, so matching on name alone would make
 * 2025/01 and 2026/01 indistinguishable. Recursive folders match by prefix
 * (they cover their subfolders); loose-file folders match only their own
 * immediate contents, since the scan deliberately didn't descend.
 */
function wasCovered(path: string, folders: PhotoFolder[]): boolean {
  const dir = path.slice(0, path.lastIndexOf("/"));
  return folders.some((f) => (f.recursive ? dir === f.path || dir.startsWith(`${f.path}/`) : dir === f.path));
}

export async function runScan(range: Range, onProgress: ProgressFn, signal?: AbortSignal): Promise<ScanResult> {
  const result: ScanResult = { scanned: 0, folders: 0, undated: 0, shards: 0, indexed: 0, analyzed: 0, months: 0 };

  onProgress({ phase: "signing-in", message: "Signing in..." });
  const token = await getAccessToken();

  const allowlist = await loadScreenshotAllowlist();
  onProgress({ message: `Screenshot allowlist: ${allowlist.length} app(s) approved for analysis.` });

  onProgress({ phase: "loading", message: "Loading index..." });
  const index = await loadIndex(token);

  onProgress({ phase: "listing", message: `Listing photo folders under ${env.photosFolder}...` });
  const allFolders = await listPhotoFolders(token, env.photosFolder);
  const folders = allFolders.filter((f) => inRange(f, range));
  result.folders = folders.length;

  const rangeLabel = bounded(range) ? ` (range ${range.from ?? "*"}..${range.to ?? "*"})` : "";
  onProgress({ message: `Found ${allFolders.length} folder(s), scanning ${folders.length}${rangeLabel}.` });
  if (folders.length === 0) {
    onProgress({
      phase: "done",
      message: "Nothing to scan. Check ONEDRIVE_PHOTOS_FOLDER — expected yyyy-mm or yyyy/mm subfolders.",
    });
    return result;
  }

  // Bucket by shard month first, then write each touched shard once: a folder
  // can contribute to a neighbouring month's shard when a photo's capture
  // date straddles the boundary, and loose-file folders contribute to
  // whichever months their photos turn out to belong to.
  const scannedByShard = new Map<string, ScannedPhoto[]>();

  onProgress({ phase: "listing", done: 0, total: folders.length, message: "Listing photos..." });
  for (const [i, folder] of folders.entries()) {
    if (signal?.aborted) break;
    const photos = await listPhotosInFolder(token, folder.path, folder.recursive);
    const label = folder.month ?? `${folder.year ?? "root"} (loose files)`;
    onProgress({
      phase: "listing",
      done: i + 1,
      total: folders.length,
      message: `[${i + 1}/${folders.length}] ${label} — ${photos.length} photo(s)`,
    });
    result.scanned += photos.length;

    for (const photo of photos) {
      // The shard is the capture month where we have one; the folder is the
      // fallback. A loose photo with no recoverable date has neither, so
      // there's nowhere to file it.
      const month = monthKey(photo.takenAt) ?? folder.month;
      if (!month) {
        result.undated++;
        continue;
      }
      const list = scannedByShard.get(month) ?? [];
      list.push(photo);
      scannedByShard.set(month, list);
    }
  }

  // A cancelled listing has only part of the library, and writing that would
  // read as "these photos were deleted from OneDrive" for every folder never
  // reached — see the deletion sweep below.
  if (signal?.aborted) {
    onProgress({ phase: "cancelled", message: "Cancelled while listing; nothing written." });
    return result;
  }

  const touched = [...scannedByShard.entries()].sort();
  onProgress({ phase: "saving", done: 0, total: touched.length, message: `Writing ${touched.length} shard(s)...` });
  const summaries = new Map(index.months.map((m) => [m.month, m] as const));

  for (const [i, [month, photos]] of touched.entries()) {
    const shard = await loadShard(token, month);

    // Drop records from territory this run covered that no longer exist —
    // i.e. photos deleted from OneDrive. Records sourced from outside the
    // scanned folders are left alone.
    const seen = new Set(photos.map((p) => p.id));
    for (const [id, record] of Object.entries(shard.photos)) {
      if (!seen.has(id) && wasCovered(record.oneDrivePath, folders)) {
        delete shard.photos[id];
      }
    }

    for (const photo of photos) {
      shard.photos[photo.id] = merge(toRecord(photo, month, allowlist), shard.photos[photo.id]);
    }

    // Both passes are derived, not stored input: they recompute from scratch
    // over the whole shard every scan, so adding or deleting a photo re-forms
    // the duplicate groups and re-evaluates the outliers around it. Neither
    // costs a download or a token.
    const records = Object.values(shard.photos);
    assignDuplicates(records);
    flagGpsOutliersByDay(records);

    await saveShard(token, shard);
    summaries.set(month, summarize(shard));
    onProgress({ phase: "saving", done: i + 1, total: touched.length, message: `Wrote ${month}` });
  }
  result.shards = touched.length;

  index.months = [...summaries.values()]
    .filter((m) => m.photoCount > 0)
    .sort((a, b) => a.month.localeCompare(b.month));
  await saveIndex(token, index);

  result.analyzed = index.months.reduce((n, m) => n + m.analyzedCount, 0);
  result.indexed = index.months.reduce((n, m) => n + m.photoCount, 0);
  result.months = index.months.length;

  // Only a run that reached here is a completed scan. Recording a cancelled or
  // failed one would move the incremental baseline past months never listed,
  // and those months would then never be scanned again.
  await writeSync({ lastScanAt: new Date().toISOString() });

  onProgress({
    phase: "done",
    done: touched.length,
    total: touched.length,
    message:
      `Scanned ${result.scanned} photo(s) across ${folders.length} folder(s). ` +
      (result.undated ? `Skipped ${result.undated} loose photo(s) with no recoverable date. ` : "") +
      `Archive now holds ${result.indexed} photo(s) in ${result.months} month(s); ${result.analyzed} analyzed.`,
  });
  return result;
}
