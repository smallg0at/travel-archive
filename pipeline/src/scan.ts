import type { MonthSummary, PhotoRecord, PhotoShard } from "@travel-archive/shared";
import { ArchiveBusyError, releaseLockOnExit, withArchiveLock } from "./lock.js";
import { getAccessToken } from "./auth.js";
import { listPhotoFolders, listPhotosInFolder, type PhotoFolder, type ScannedPhoto } from "./graph.js";
import { env } from "./env.js";
import { loadIndex, loadShard, saveIndex, saveShard } from "./archiveStore.js";
import { formatMonthLabel, monthKey } from "./util.js";
import { assignDuplicates, analysisTargets } from "./duplicates.js";
import { flagGpsOutliersByDay } from "./geo.js";
import { isScreenshot, loadScreenshotAllowlist, mayBeAnalyzed, screenshotPolicyFor } from "./screenshots.js";

/**
 * Indexes OneDrive into per-month shards using nothing but Graph listing
 * calls — no photo downloads, no AI, no tokens spent. This is what makes the
 * album usable over a whole library immediately; `analyze` fills in captions
 * later, and only for the photos you point it at.
 *
 *   npm run --workspace pipeline scan
 *   npm run --workspace pipeline scan -- --from 2025-01 --to 2026-12
 */

interface Range {
  from: string | null;
  to: string | null;
}

function parseArgs(): Range {
  const args = process.argv.slice(2);
  const valueOf = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
  };
  return {
    from: valueOf("--from") ?? env.scanFrom,
    to: valueOf("--to") ?? env.scanTo,
  };
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

function summarize(shard: PhotoShard): MonthSummary {
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

async function runMain() {
  const range = parseArgs();

  console.log("Signing in...");
  const token = await getAccessToken();

  const allowlist = await loadScreenshotAllowlist();
  console.log(`Screenshot allowlist: ${allowlist.length} app(s) approved for analysis.`);

  console.log("Loading index...");
  const index = await loadIndex(token);

  console.log(`Listing photo folders under ${env.photosFolder}...`);
  const allFolders = await listPhotoFolders(token, env.photosFolder);
  const folders = allFolders.filter((f) => inRange(f, range));

  const rangeLabel = bounded(range) ? ` (range ${range.from ?? "*"}..${range.to ?? "*"})` : "";
  console.log(`Found ${allFolders.length} folder(s), scanning ${folders.length}${rangeLabel}.`);
  if (folders.length === 0) {
    console.log("Nothing to scan. Check ONEDRIVE_PHOTOS_FOLDER — expected yyyy-mm or yyyy/mm subfolders.");
    return;
  }

  // Bucket by shard month first, then write each touched shard once: a folder
  // can contribute to a neighbouring month's shard when a photo's capture
  // date straddles the boundary, and loose-file folders contribute to
  // whichever months their photos turn out to belong to.
  const scannedByShard = new Map<string, ScannedPhoto[]>();
  let total = 0;
  let undated = 0;

  for (const [i, folder] of folders.entries()) {
    const photos = await listPhotosInFolder(token, folder.path, folder.recursive);
    const label = folder.month ?? `${folder.year ?? "root"} (loose files)`;
    console.log(`[${i + 1}/${folders.length}] ${label} — ${photos.length} photo(s)`);
    total += photos.length;

    for (const photo of photos) {
      // The shard is the capture month where we have one; the folder is the
      // fallback. A loose photo with no recoverable date has neither, so
      // there's nowhere to file it.
      const month = monthKey(photo.takenAt) ?? folder.month;
      if (!month) {
        undated++;
        continue;
      }
      const list = scannedByShard.get(month) ?? [];
      list.push(photo);
      scannedByShard.set(month, list);
    }
  }

  console.log(`Writing ${scannedByShard.size} shard(s)...`);
  const summaries = new Map(index.months.map((m) => [m.month, m] as const));

  for (const [month, photos] of [...scannedByShard.entries()].sort()) {
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
  }

  index.months = [...summaries.values()]
    .filter((m) => m.photoCount > 0)
    .sort((a, b) => a.month.localeCompare(b.month));
  await saveIndex(token, index);

  const analyzed = index.months.reduce((n, m) => n + m.analyzedCount, 0);
  const indexed = index.months.reduce((n, m) => n + m.photoCount, 0);
  console.log(`\nScanned ${total} photo(s) across ${folders.length} folder(s).`);
  if (undated) console.log(`Skipped ${undated} loose photo(s) with no recoverable date.`);
  console.log(`Archive now holds ${indexed} photo(s) in ${index.months.length} month(s); ${analyzed} analyzed.`);
}

/**
 * Refuses to start while another writer holds the archive — see lock.ts.
 * The whole command is one critical section: an interrupted half-write is
 * the failure this exists to prevent.
 */
async function main() {
  releaseLockOnExit();
  await withArchiveLock("scan (CLI)", runMain);
}

main().catch((err) => {
  // A busy archive is an expected outcome, not a crash: print the reason,
  // not a stack trace the user has to read past.
  if (err instanceof ArchiveBusyError) {
    console.error(`
${err.message}
`);
    process.exit(2);
  }
  console.error(err);
  process.exit(1);
});
