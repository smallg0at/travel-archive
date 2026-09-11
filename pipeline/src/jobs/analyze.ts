import type { AnalyzePlan, JobProgress, PhotoRecord, PhotoShard } from "@travel-archive/shared";
import type { CaptionContext } from "../providers/types.js";
import { getAccessToken } from "../auth.js";
import { downloadThumbnailBuffer } from "../graph.js";
import { reverseGeocode } from "../exif.js";
import { getProvider } from "../providers/index.js";
import { env } from "../env.js";
import {
  loadIndex,
  loadIndexForReading,
  loadShard,
  loadShardForReading,
  saveIndex,
  saveShard,
} from "../archiveStore.js";
import { mediaTypeFor } from "../util.js";
import { analysisTargets } from "../duplicates.js";
import { mayBeAnalyzed } from "../screenshots.js";

/**
 * The AI pass, as a callable function rather than a script.
 *
 * The CLI (../analyze.ts) and the job server both run this, which is the point:
 * the awkward parts — the `analyzedAt`-null work queue, per-month shard saves
 * so an interrupt keeps what it finished, the concurrency pool, geocoding
 * rate-limited separately — took real effort to get right, and having two
 * copies of them drift apart would be the obvious way to lose that.
 *
 * Progress goes to a callback instead of `console.log`, so the CLI can print
 * it and the server can stream it to a browser.
 */

/**
 * Photos captioned between shard writes.
 *
 * Saving only at the end of a month was fine when a run was a few hundred
 * photos; a 17-day range puts ~2,900 in a single month, so a crash or a killed
 * terminal at photo 2,500 would discard an hour of paid work. Each save is one
 * upload of a few MB, so a checkpoint every 150 costs little against that.
 */
const SAVE_EVERY = 150;

/** Measured on this library: ~1227 input, ~250 output+thinking tokens per photo. */
const TOKENS_IN_PER_PHOTO = 1227;
const TOKENS_OUT_PER_PHOTO = 250;

export interface AnalyzeOptions {
  from: string | null;
  to: string | null;
  limit: number;
}

export interface AnalyzeResult {
  analyzed: number;
  failed: number;
  inherited: number;
  geocoded: number;
}

export type { AnalyzePlan };

export type ProgressFn = (progress: Partial<JobProgress> & { message?: string }) => void;

/**
 * Range bounds may be a month or a day. Comparing ISO strings by prefix makes
 * both work: "2026-09-01" >= "2026-09" is true, and a `to` of "2026-09-03"
 * must not exclude a photo taken at 14:22 that day, so the upper bound is
 * padded before comparison.
 */
function inRange(takenAt: string | null, from: string | null, to: string | null): boolean {
  if (!takenAt) return false;
  const day = takenAt.slice(0, 10);
  if (from && day < from.slice(0, 10)) return false;
  if (to && day.slice(0, to.length) > to) return false;
  return true;
}

/**
 * The photos this run should pay for, in order. Three filters, each of which
 * exists for its own reason:
 *  - not already analyzed, so re-runs are cheap
 *  - a duplicate representative, so three copies of one file cost one call
 *  - allowed by the screenshot policy, which is what keeps private screenshots
 *    (WeChat, mail, banking) off the wire entirely
 */
function selectTargets(shard: PhotoShard, opts: AnalyzeOptions): PhotoRecord[] {
  return analysisTargets(Object.values(shard.photos))
    .filter(mayBeAnalyzed)
    .filter((p) => !p.analyzedAt)
    .filter((p) => inRange(p.takenAt, opts.from, opts.to))
    .sort((a, b) => (a.takenAt ?? "").localeCompare(b.takenAt ?? ""));
}

/** Runs `worker` over `items` with a fixed number of workers pulling from a shared cursor. */
export async function pooled<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * Copies a representative's description onto the duplicate copies that were
 * never sent to the model. Without this, the siblings would stay uncaptioned
 * forever and the album would show blanks beside a described photo.
 */
function inheritToDuplicates(shard: PhotoShard, representative: PhotoRecord): number {
  if (!representative.duplicateGroupId) return 0;

  let count = 0;
  for (const photo of Object.values(shard.photos)) {
    if (photo.duplicateGroupId !== representative.duplicateGroupId) continue;
    if (photo.id === representative.id) continue;

    shard.photos[photo.id] = {
      ...photo,
      contentType: representative.contentType,
      caption: representative.caption,
      tags: representative.tags,
      extractedText: representative.extractedText,
      notable: representative.notable,
      quality: representative.quality,
      place: representative.place,
      inheritedFrom: representative.id,
    };
    count++;
  }
  return count;
}

/**
 * Reverse-geocodes after captioning rather than during it. Nominatim's usage
 * policy allows one request a second, which four concurrent workers would
 * breach immediately, so this runs serially over the photos that ended up
 * needing it. The lookup itself caches per ~100m grid cell, so a day spent in
 * one city costs a handful of requests rather than hundreds.
 *
 * Suspect coordinates are skipped: a fix that contradicts the rest of its day
 * would otherwise name the day after a place the user was never in.
 *
 * Scans the **whole shard**, not just the photos this run captioned. Anything
 * that ends this loop early — a cancel, a network failure, a crash — would
 * otherwise strand those photos forever: they now have `analyzedAt` set, so the
 * next run's target selection skips them and nothing ever comes back for their
 * place. Observed exactly that way, cancelling a run mid-flight left 8 photos
 * captioned with no location. Sweeping the shard makes the pass self-healing.
 */
async function geocodePending(
  shard: PhotoShard,
  onProgress: ProgressFn,
  signal?: AbortSignal,
): Promise<number> {
  const needing = Object.values(shard.photos).filter((p) => p.analyzedAt && p.gps && !p.gpsSuspect && !p.place);
  let count = 0;
  for (const [i, photo] of needing.entries()) {
    if (signal?.aborted) break;
    if (i % 20 === 0) onProgress({ phase: "geocoding", done: i, total: needing.length });
    const place = await reverseGeocode(photo.gps!, env.geocodeContactEmail);
    if (!place) continue;
    shard.photos[photo.id] = { ...shard.photos[photo.id], place };
    count++;
  }
  return count;
}

/**
 * What a run would cost, without spending anything. The server exposes this so
 * the app can show a confirmation before starting an hour-long job, and the CLI
 * prints it for the same reason — this is the only step that costs money.
 */
export async function planAnalyze(opts: AnalyzeOptions): Promise<AnalyzePlan> {
  const token = await getAccessToken();
  // Read-only, so it reads the mirror: this is the "what would it cost"
  // button, and it was downloading index.json plus one shard per month in
  // range from OneDrive to answer — 3.3s for a two-month range, 7.2s for nine,
  // and well over a minute for the whole library.
  const index = await loadIndexForReading(token);

  const months = index.months.filter(
    (m) => (!opts.from || m.month >= opts.from.slice(0, 7)) && (!opts.to || m.month <= opts.to.slice(0, 7)),
  );

  const counted: { month: string; count: number }[] = [];
  for (const summary of months) {
    const shard = await loadShardForReading(token, summary.month);
    const count = selectTargets(shard, opts).length;
    if (count > 0) counted.push({ month: summary.month, count });
  }

  // Capped cumulatively, so the per-month breakdown adds up to `total`. Without
  // this a `--limit 2` run reported "2 photo(s) to analyze" above a line
  // reading "2025-04: 25", which is the month's backlog rather than the plan.
  let budget = opts.limit;
  const capped: { month: string; count: number }[] = [];
  for (const m of counted) {
    if (budget <= 0) break;
    const count = Math.min(m.count, budget);
    budget -= count;
    capped.push({ month: m.month, count });
  }

  const total = capped.reduce((n, m) => n + m.count, 0);
  return {
    total,
    months: capped,
    estimatedInputTokens: total * TOKENS_IN_PER_PHOTO,
    estimatedOutputTokens: total * TOKENS_OUT_PER_PHOTO,
  };
}

/** How many neighbouring captions a photo is given. Orientation, not a transcript. */
const NEARBY_CAPTIONS = 6;
/** Trimmed so six of them stay a hint rather than a page. */
const NEARBY_CAPTION_CHARS = 140;

/**
 * Where and when this photo was taken, and what else was photographed near it.
 *
 * Read from the shard at call time, so a run picks up the captions it has
 * already written this pass as well as those from earlier runs — the first
 * photo of a museum visit has no neighbours, the hundredth has six.
 *
 * `timeSuspect` photos give the date without the clock. Their day is right and
 * their hour is not (phone clock drift, and filenames that carry a date only),
 * so offering "14:32" would be inventing precision the record does not have.
 */
export function captionContextFor(shard: PhotoShard, record: PhotoRecord): CaptionContext | null {
  const day = record.takenAt?.slice(0, 10) ?? null;

  const nearby = day
    ? Object.values(shard.photos)
        .filter((p) => p.id !== record.id && p.caption && p.takenAt?.slice(0, 10) === day)
        .sort(
          (a, b) =>
            Math.abs(Date.parse(a.takenAt!) - Date.parse(record.takenAt!)) -
            Math.abs(Date.parse(b.takenAt!) - Date.parse(record.takenAt!)),
        )
        .slice(0, NEARBY_CAPTIONS)
        .map((p) => p.caption!.slice(0, NEARBY_CAPTION_CHARS))
    : [];

  const takenAt = record.takenAt ? (record.timeSuspect ? record.takenAt.slice(0, 10) : record.takenAt) : null;
  const place = record.place ?? null;
  if (!takenAt && !place && nearby.length === 0) return null;
  return { takenAt, place, nearbyCaptions: nearby };
}

export async function runAnalyze(
  opts: AnalyzeOptions,
  onProgress: ProgressFn,
  signal?: AbortSignal,
): Promise<AnalyzeResult> {
  onProgress({ phase: "signing-in", message: "Signing in..." });
  const token = await getAccessToken();

  onProgress({ phase: "planning", message: "Loading index..." });
  const index = await loadIndex(token);
  const provider = getProvider();

  const months = index.months.filter(
    (m) => (!opts.from || m.month >= opts.from.slice(0, 7)) && (!opts.to || m.month <= opts.to.slice(0, 7)),
  );

  const plan: { month: string; targets: PhotoRecord[]; shard: PhotoShard }[] = [];
  for (const summary of months) {
    const shard = await loadShard(token, summary.month);
    const targets = selectTargets(shard, opts);
    if (targets.length) plan.push({ month: summary.month, targets, shard });
  }

  const total = Math.min(
    plan.reduce((n, p) => n + p.targets.length, 0),
    opts.limit,
  );

  const result: AnalyzeResult = { analyzed: 0, failed: 0, inherited: 0, geocoded: 0 };

  if (total === 0) {
    // Still sweep for missing places. The geocode pass is self-healing by
    // design — it looks for any analyzed photo with coordinates and no place —
    // but returning here made it unreachable exactly when it was needed. A
    // photo skipped as `gpsSuspect` during its original run, and later
    // un-flagged by a better outlier rule, has nothing left to caption and so
    // could never acquire a place. That is how the city airport stayed off the map.
    for (const summary of months) {
      if (signal?.aborted) break;
      const shard = await loadShard(token, summary.month);
      const found = await geocodePending(shard, onProgress, signal);
      if (found === 0) continue;
      result.geocoded += found;
      await saveShard(token, shard);
      onProgress({ message: `${summary.month}: ${found} place(s) filled in.` });
    }
    onProgress({
      phase: "done",
      done: 0,
      total: 0,
      message:
        result.geocoded > 0
          ? `Nothing to caption; filled in ${result.geocoded} missing place(s).`
          : "Nothing to analyze in that range — already done, or filtered out as duplicates/screenshots.",
    });
    return result;
  }

  onProgress({ message: `Captioning ${env.analyzeConcurrency} at a time.` });
  onProgress({
    phase: "analyzing",
    done: 0,
    total,
    message: `${total} photo(s) across ${plan.length} month(s); ~${((total * TOKENS_IN_PER_PHOTO) / 1e6).toFixed(2)}M input tokens.`,
  });

  for (const { month, targets, shard } of plan) {
    if (result.analyzed >= opts.limit || signal?.aborted) break;
    const batch = targets.slice(0, opts.limit - result.analyzed);
    onProgress({ phase: "analyzing", message: `${month} — ${batch.length} photo(s)` });

    const analyzed: PhotoRecord[] = [];
    let sinceSave = 0;

    // Guarded so two workers finishing together cannot start overlapping
    // uploads of the same shard.
    let saving: Promise<void> = Promise.resolve();
    const checkpoint = async () => {
      sinceSave = 0;
      const pending = saving.then(async () => {
        onProgress({ phase: "saving", message: `Checkpoint — ${result.analyzed} captioned so far.` });
        await saveShard(token, shard);
      });
      saving = pending.catch(() => {});
      await pending;
    };

    await pooled(batch, env.analyzeConcurrency, async (record) => {
      // Checked per photo rather than per month: a cancel during a 4,998-photo
      // month should stop in seconds, and everything already captioned is kept
      // by the save below.
      if (signal?.aborted) return;
      try {
        const image = await downloadThumbnailBuffer(token, record.id);
        if (!image) {
          result.failed++;
          onProgress({ message: `no thumbnail: ${record.fileName}` });
          return;
        }

        const caption = await provider.captionPhoto({
          imageBase64: image.toString("base64"),
          mediaType: mediaTypeFor(record.fileName),
          context: captionContextFor(shard, record),
        });

        const updated: PhotoRecord = {
          ...record,
          analyzedAt: new Date().toISOString(),
          contentType: caption.contentType,
          caption: caption.caption,
          tags: caption.tags,
          extractedText: caption.extractedText,
          notable: caption.notable,
        };
        shard.photos[record.id] = updated;
        analyzed.push(updated);
        result.inherited += inheritToDuplicates(shard, updated);

        result.analyzed++;
        if (result.analyzed % 5 === 0 || result.analyzed === total) {
          onProgress({ phase: "analyzing", done: result.analyzed, total });
        }
        if (++sinceSave >= SAVE_EVERY) await checkpoint();
      } catch (err) {
        result.failed++;
        onProgress({ message: `failed ${record.fileName}: ${(err as Error).message}` });
      }
    });

    if (analyzed.length === 0) continue;

    result.geocoded += await geocodePending(shard, onProgress, signal);

    // Saved even when cancelled — an interrupted run must keep what it paid for.
    onProgress({ phase: "saving", message: `Saving ${month}...` });
    await saveShard(token, shard);

    const summary = index.months.find((m) => m.month === month);
    if (summary) summary.analyzedCount = Object.values(shard.photos).filter((p) => p.analyzedAt).length;
    await saveIndex(token, index);
  }

  onProgress({
    phase: "done",
    done: result.analyzed,
    total,
    message: `Analyzed ${result.analyzed} photo(s)${result.failed ? `, ${result.failed} failed` : ""}.`,
  });
  return result;
}
