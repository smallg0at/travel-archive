import type { DayEdits, DayRecord, DaySegment, OrganizePlan, PhotoRecord } from "@travel-archive/shared";
import { CARD_BUDGET, SUMMARY_MIN_PHOTOS, applyEdits } from "@travel-archive/shared";
import { getAccessToken } from "../auth.js";
import { getProvider } from "../providers/index.js";
import { loadAllShards, loadIndexForReading, loadIndexForWriting, saveIndex } from "../archiveStore.js";
import { dayKey, sameIds } from "../util.js";
import { findTripFor, loadTripDefinitions } from "../tripDefs.js";
import { bucketDays } from "./sections.js";
import { buildSearchIndex } from "./searchIndex.js";
import { buildHomeIndex } from "./homeIndex.js";
import { detectStops } from "../stops.js";
import { mayBeAnalyzed } from "../screenshots.js";
import { withheldFromSummaries } from "../sensitive.js";
import type { ProgressFn } from "./analyze.js";
import { NATIVE_LANGUAGE, saveNativeText } from "./translate.js";

/**
 * Groups analyzed photos into days, breaks each day into the stops it was
 * spent at, writes a summary and highlights for every stop whose photo set
 * changed, and sorts those days into either a defined trip
 * (pipeline/trips.json — see tripDefs.ts for why trips are manual rather than
 * inferred) or a month bucket. Output lands in index.json's `sections`; the
 * photo shards aren't touched.
 *
 * Only days with at least one analyzed photo are summarized — there's nothing
 * for the model to work from otherwise — and, outside a trip, only days with
 * more than SUMMARY_MIN_PHOTOS photos. The album view renders every day
 * regardless, summary or not, so running this is purely additive.
 *
 * Callable by both the CLI and the job server; see ./analyze.ts for why.
 */

/**
 * The day's place is the one most of its photos were taken in, not the first
 * one seen.
 *
 * First-wins is wrong for exactly the days that matter: a day trip starts at
 * home. One day here has 263 photos in the place the day was really spent, 38
 * at home and 11 in a third place, and the first geotagged photo of the morning
 * is one of the home ones — so the whole day was labelled with home in the app
 * and handed to the summarizer as such.
 */
function dominantPlace(photos: PhotoRecord[]): string | null {
  const counts = new Map<string, number>();
  for (const photo of photos) {
    if (photo.place) counts.set(photo.place, (counts.get(photo.place) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [place, count] of counts) {
    if (count > bestCount) {
      best = place;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Enforces that a photo is used once across a day, and that a card never shows
 * the same shot twice.
 *
 * The prompt asks for both, but a prompt is not a guarantee and the failure is
 * visible: the first run put Čumil in a hero row and again in a card, and a
 * card titled "ÖBB Locomotive" showed two frames of the same locomotive side by
 * side. Duplicate *files* are already known from the scan pass, so siblings of
 * an already-used photo are dropped here too — `duplicateGroupId` is exact, not
 * a similarity guess.
 */
/** Seconds within which two same-sized shots inside one card are the same press, twice. */
const DOUBLE_TAP_SECONDS = 4;

/**
 * Two shots of the same thing, seconds apart at the same dimensions.
 *
 * `duplicateGroupId` cannot see these — it is deliberately exact-signal only
 * (filename copy suffixes, the camera's own `_BURSTn`), because a timestamp
 * heuristic once grouped an anime illustration with an unrelated sticker. But a
 * double-tapped shutter produces two genuinely different files that are the same
 * picture, and a card showing both side by side looks like a mistake.
 *
 * Applied **only inside a card**, where the model has already asserted the
 * photos show one thing. That is what makes a time-and-size rule safe here and
 * unsafe across a whole day.
 */
function sameShot(a: PhotoRecord, b: PhotoRecord): boolean {
  if (!a.takenAt || !b.takenAt) return false;
  if (a.width !== b.width || a.height !== b.height) return false;
  const gap = Math.abs(new Date(a.takenAt).getTime() - new Date(b.takenAt).getTime()) / 1000;
  return gap <= DOUBLE_TAP_SECONDS;
}

function claimOnce(segments: DaySegment[], photos: Record<string, PhotoRecord>): DaySegment[] {
  const usedPhotos = new Set<string>();
  const usedGroups = new Set<string>();

  const take = (ids: string[], dropRepeats: boolean): string[] => {
    const kept: PhotoRecord[] = [];
    for (const id of ids) {
      const photo = photos[id];
      if (!photo || usedPhotos.has(id)) continue;
      const group = photo.duplicateGroupId;
      if (group && usedGroups.has(group)) continue;
      if (dropRepeats && kept.some((k) => sameShot(k, photo))) continue;
      usedPhotos.add(id);
      if (group) usedGroups.add(group);
      kept.push(photo);
    }
    return kept.map((p) => p.id);
  };

  // The budget is enforced here rather than trusted to the prompt. Extra cards
  // are demoted rather than dropped — a stop that named five "full" highlights
  // still has five things worth showing.
  const budgetFor = (highlights: DaySegment["highlights"]) => {
    const remaining = { ...CARD_BUDGET };
    const out: DaySegment["highlights"] = [];
    for (const h of highlights) {
      let size = h.size;
      while (remaining[size] <= 0) {
        if (size === "full") size = "half";
        else if (size === "half") size = "normal";
        else break;
      }
      if (remaining[size] <= 0) break;
      remaining[size]--;
      out.push({ ...h, size });
    }
    return out;
  };

  return segments.map((segment) => ({
    ...segment,
    highlights: budgetFor(
      segment.highlights
        .map((h) => ({
          ...h,
          photoIds: take(h.photoIds, true),
          documentPhotoIds: take(h.documentPhotoIds, false),
        }))
        // A card whose picture was already spent elsewhere is not a card.
        .filter((h) => h.photoIds.length > 0),
    ),
  }));
}

/**
 * Whether stored segments match the shape this build writes.
 *
 * Every schema bump so far has caught me out the same way: the staleness check
 * saw a day whose photos were unchanged, reused it, and the app rendered the
 * old shape forever. v11 added segments, v12 added card sizes, and each time
 * the day looked "unchanged" while missing the new field.
 *
 * **Update this whenever DaySegment or Highlight gains a required field.** It
 * costs one re-summarize per affected day, which is the cheap direction.
 */
function segmentsAreCurrent(segments: DaySegment[] | undefined): boolean {
  if (!segments?.length) return false;
  return segments.every((seg) => seg.highlights.every((h) => h.size !== undefined && "documentTranslation" in h));
}

// `applyEdits` now lives in shared, so the app applies an edit made in another
// language by the same rule. Re-exported for anything that imported it here.
export { applyEdits };

/**
 * What a run would do with one day, and why.
 *
 * Factored out so the preview and the run cannot drift: both call this, so a
 * preview that says "3 days would be rewritten" is answering with the same rule
 * the run will apply. Reporting the *reason* is the point — "0 day(s)
 * summarized" is indistinguishable between "nothing changed", "not in scope"
 * and "nothing here has been analyzed", and the third is the common one on this
 * archive, where 4,386 of 31,374 photos have captions.
 */
export type DayOutcome = "rewrite" | "reuse" | "skip-out-of-scope" | "skip-no-analyzed" | "skip-undated" | "skip-small";

export interface DayDecision {
  date: string;
  outcome: DayOutcome;
  /** Photos that would actually be shown to the model. */
  analyzed: number;
}

function decideDay(args: {
  date: string;
  prior: DayRecord | undefined;
  analyzedCount: number;
  /** Every photo the day holds, analyzed or not — what the reader sees. */
  photoCount: number;
  inTrip: boolean;
  place: string | null;
  note: string | null;
  summarizedIds: string[];
  opts: OrganizeOptions;
}): DayOutcome {
  const { date, prior, analyzedCount, photoCount, inTrip, place, note, summarizedIds, opts } = args;
  const inScope = opts.days?.length ? opts.days.includes(date) : !opts.only || date.startsWith(opts.only);
  // Place is an input to the summary, not just a label, so a day whose place
  // changed is as stale as one whose photos changed — geocoding lands after
  // captioning, and the dominant-place fix above moved several days.
  //
  // A day that merely *gained a few photos* is deliberately not stale. The
  // check used to be set equality, so one new photo — a screenshot, a
  // duplicate, a late import — re-summarized the whole day for pay. A day's
  // summary is prose about what happened, and it does not change because two
  // more frames arrived; the new photos still appear in the grid. What does
  // make it stale is a photo *leaving* (the summary may still describe it) or
  // enough arriving to change the day's shape.
  const unchanged =
    !opts.force &&
    prior?.summarizedPhotoIds != null &&
    photosOnlyGrew(prior.summarizedPhotoIds, summarizedIds) &&
    prior.place === place &&
    // A note is an input to the summary like the photos are, so editing one
    // makes the day stale. `?? null` on both sides because days written before
    // v14 have no `summarizedNote` at all, and absent must compare equal to
    // "no note" — otherwise a schema bump alone marks 545 days for a paid
    // re-run.
    (prior.summarizedNote ?? null) === note &&
    segmentsAreCurrent(prior.segments);

  if (prior && (unchanged || !inScope)) return "reuse";
  if (!inScope) return "skip-out-of-scope";
  if (date === "unknown-date") return "skip-undated";
  if (analyzedCount === 0) return "skip-no-analyzed";
  // After the others, so a small day that also has nothing analyzed is still
  // reported as needing Analyze — that is the reason it would stay blank in a trip.
  if (!inTrip && photoCount <= SUMMARY_MIN_PHOTOS) return "skip-small";
  return "rewrite";
}

/**
 * Whether `next` is `prior` plus a few additions, with nothing removed.
 *
 * The tolerance is what keeps a late-arriving photo or two from re-running a
 * day, while still catching a genuine change: once additions pass a quarter of
 * the day (or three photos, whichever is larger) the day is treated as rewritten,
 * because at that point the summary may no longer describe what is there.
 */
function photosOnlyGrew(prior: string[], next: string[]): boolean {
  if (next.length < prior.length) return false;
  if (next.length === prior.length) return sameIds(prior, next);
  const before = new Set(prior);
  const added = next.filter((id) => !before.has(id)).length;
  const tolerance = Math.max(3, Math.floor(prior.length / 4));
  return added <= tolerance;
}

export interface OrganizeOptions {
  /** Restrict to one date (`2026-09-01`) or month (`2026-09`); null does the lot. */
  only: string | null;
  /**
   * An explicit set of dates to run, which wins over `only` when present.
   *
   * `only` is a single prefix, so naming nine particular days meant nine runs.
   * The app now previews the candidates and sends back the ones you ticked;
   * the CLI keeps `--only` because a prefix is the natural thing to type.
   */
  days?: string[] | null;
  /**
   * Resummarize even when nothing about the day's photos changed.
   *
   * The staleness check compares inputs it can see — the photo set, the place,
   * the stored shape. It cannot see the *prompt*, so tuning how days are written
   * left every day looking unchanged and silently produced nothing. Pair it with
   * `only`, since forcing the whole archive is 545 model calls.
   */
  force: boolean;
}

export interface OrganizeResult {
  days: number;
  summarized: number;
  reused: number;
  /** Days left unsummarized for having too few photos outside a trip. */
  small: number;
  withheld: number;
  /** Days the model could not write this run. Their old text, if any, is kept. */
  failed: number;
  trips: number;
  months: number;
}

/** Days listed by name in a plan before it just says "and N more". */
const PLAN_DAY_CAP = 300;

/**
 * What `runOrganize` would do, for the same options, spending nothing.
 *
 * Costs no tokens and makes no model calls — it stops at the decision. The
 * metadata it needs comes from the local mirror, so this is disk reads rather
 * than a round trip per month.
 */
export async function planOrganize(opts: OrganizeOptions): Promise<OrganizePlan> {
  const token = await getAccessToken();
  const index = await loadIndexForReading(token);
  const shards = await loadAllShards(token, index);
  const photos: Record<string, PhotoRecord> = {};
  for (const shard of shards.values()) Object.assign(photos, shard.photos);

  const existingDaysByDate = new Map(index.sections.flatMap((s) => s.days).map((d) => [d.date, d] as const));
  const tripDefs = await loadTripDefinitions();

  const byDay = new Map<string, PhotoRecord[]>();
  for (const photo of Object.values(photos)) {
    const key = dayKey(photo.takenAt);
    const list = byDay.get(key) ?? [];
    list.push(photo);
    byDay.set(key, list);
  }

  const plan: OrganizePlan = {
    rewrite: 0,
    reuse: 0,
    skippedNoAnalyzed: 0,
    skippedOutOfScope: 0,
    skippedUndated: 0,
    skippedSmall: 0,
    days: [],
    truncated: false,
  };

  for (const date of [...byDay.keys()].sort()) {
    const dayPhotos = byDay.get(date)!;
    const analyzed = dayPhotos.filter((p) => p.analyzedAt && mayBeAnalyzed(p) && !withheldFromSummaries(p));
    const outcome = decideDay({
      date,
      prior: existingDaysByDate.get(date),
      analyzedCount: analyzed.length,
      photoCount: dayPhotos.length,
      inTrip: findTripFor(date, tripDefs) !== null,
      place: dominantPlace(dayPhotos),
      note: existingDaysByDate.get(date)?.note ?? null,
      summarizedIds: analyzed.map((p) => p.id),
      opts,
    });

    if (outcome === "rewrite") {
      plan.rewrite++;
      if (plan.days.length < PLAN_DAY_CAP) plan.days.push({ date, analyzed: analyzed.length });
      else plan.truncated = true;
    } else if (outcome === "reuse") plan.reuse++;
    else if (outcome === "skip-no-analyzed") plan.skippedNoAnalyzed++;
    else if (outcome === "skip-out-of-scope") plan.skippedOutOfScope++;
    else if (outcome === "skip-small") plan.skippedSmall = (plan.skippedSmall ?? 0) + 1;
    else plan.skippedUndated++;
  }

  return plan;
}

export async function runOrganize(
  opts: OrganizeOptions,
  onProgress: ProgressFn,
  signal?: AbortSignal,
): Promise<OrganizeResult> {
  onProgress({ phase: "signing-in", message: "Signing in..." });
  const token = await getAccessToken();

  onProgress({ phase: "loading", message: "Loading index..." });
  // The mirror when it is provably current, Graph otherwise — see
  // `loadIndexForWriting`. A single-day rewrite runs this on every press, and a
  // full index download (plus the upload that follows) per press is what made
  // it look like it was hammering OneDrive.
  const index = await loadIndexForWriting(token);

  onProgress({ phase: "loading", message: `Loading ${index.months.length} month shard(s)...` });
  const shards = await loadAllShards(token, index);
  const photos: Record<string, PhotoRecord> = {};
  for (const shard of shards.values()) Object.assign(photos, shard.photos);

  const provider = getProvider();
  const tripDefs = await loadTripDefinitions();
  const existingDaysByDate = new Map(index.sections.flatMap((s) => s.days).map((d) => [d.date, d] as const));

  const byDay = new Map<string, string[]>();
  for (const photo of Object.values(photos)) {
    const key = dayKey(photo.takenAt);
    const list = byDay.get(key) ?? [];
    list.push(photo.id);
    byDay.set(key, list);
  }

  const dates = [...byDay.keys()].sort();
  const result: OrganizeResult = { days: 0, summarized: 0, reused: 0, small: 0, withheld: 0, failed: 0, trips: 0, months: 0 };
  const days: DayRecord[] = [];
  // What the summarizer wrote in the second language, saved with the index at
  // the end — and, like it, not at all if the run is cancelled.
  const nativePairs: [string, string][] = [];

  /**
   * Writes what has been summarized so far, part-way through the run.
   *
   * Everything used to be written at the end, so a 503 from the model on the
   * ninth day threw away the eight before it — paid for, and gone. Days not
   * reached yet are carried through unchanged, so the index is always whole.
   */
  let sinceCheckpoint = 0;
  const checkpoint = async () => {
    sinceCheckpoint = 0;
    const done = new Set(days.map((d) => d.date));
    const merged = [...days, ...[...existingDaysByDate.values()].filter((d) => !done.has(d.date))];
    index.sections = bucketDays(merged, tripDefs, index.sections);
    await saveIndex(token, index);
    // Keyed by the English text, so writing the running total again is a
    // no-op for what is already there.
    await saveNativeText(token, NATIVE_LANGUAGE, nativePairs, () => {});
    onProgress({ message: `Checkpoint — ${result.summarized} day(s) written so far.` });
  };
  /** Days written between checkpoints. Each is a paid model call; a handful is a tolerable loss. */
  const CHECKPOINT_EVERY = 5;
  /**
   * Consecutive failures that mean the service is down rather than one day
   * being awkward. The provider already retries a 503 five times with backoff,
   * so this is that many times over.
   */
  const GIVE_UP_AFTER = 3;
  let consecutiveFailures = 0;

  onProgress({ phase: "summarizing", done: 0, total: dates.length, message: "Summarizing changed days..." });

  for (const [i, date] of dates.entries()) {
    if (signal?.aborted) break;
    const photoIds = byDay.get(date)!;
    const dayPhotos = photoIds.map((id) => photos[id]);

    // Two exclusions, both about what may reach a model rather than what the
    // user may see. Withheld screenshots never went to one in the first place.
    // Redaction-flagged photos did — a camera photo of a passport looks like
    // any other document — so their transcripts are kept out of the summarizer
    // instead, where they would otherwise be paraphrased into readable prose.
    const analyzed = dayPhotos.filter((p) => p.analyzedAt && mayBeAnalyzed(p) && !withheldFromSummaries(p));
    const withheld = dayPhotos.filter(withheldFromSummaries).length;
    const place = dominantPlace(dayPhotos);
    result.withheld += withheld;

    // Compare what the model will be shown, not what the day holds — see
    // DayRecord.summarizedPhotoIds. A day summarized before v9 has no such
    // list, so it resummarizes once; that is the safe direction, since the
    // reason it might be missing is that something was withdrawn from it.
    const summarizedIds = analyzed.map((p) => p.id);
    const prior = existingDaysByDate.get(date);
    // Carried forward, never regenerated: the note and the hand-edits are the
    // owner's, and `organize` only ever reads them.
    const note = prior?.note ?? null;
    const edits = prior?.edits ?? null;
    const outcome = decideDay({
      date,
      prior,
      analyzedCount: analyzed.length,
      photoCount: dayPhotos.length,
      inTrip: findTripFor(date, tripDefs) !== null,
      place,
      note,
      summarizedIds,
      opts,
    });

    let summary: string | null = null;
    let segments: DaySegment[] = [];

    if (outcome === "reuse" && prior) {
      // Out of scope means "not this run's business" — keep whatever is there
      // rather than dropping a summary the user already paid for.
      summary = prior.summary;
      segments = prior.segments ?? [];
      result.reused++;
    } else if (outcome === "skip-small") {
      // No new summary, but one written before the rule stays: it was paid
      // for, and the day still reads better with it than without.
      summary = prior?.summary ?? null;
      segments = prior?.segments ?? [];
      result.small++;
    } else if (outcome === "rewrite") {
      onProgress({ phase: "summarizing", done: i, total: dates.length, message: `Summarizing ${date}...` });

      // Stops are measured, not inferred: GPS and timestamps decide where the
      // day was spent before a single token is spent naming it.
      const stops = detectStops(analyzed).map((stop, index) => ({
        id: `s${index + 1}`,
        kind: stop.kind,
        startTime: stop.startTime,
        endTime: stop.endTime,
        photos: stop.photos.map((p) => ({
          id: p.id,
          caption: p.caption ?? "",
          tags: p.tags,
          contentType: p.contentType ?? "other",
        })),
      }));

      let summarized;
      try {
        summarized = await provider.summarizeDay({
          date,
          place,
          note,
          alsoIn: NATIVE_LANGUAGE,
          // Both flags describe how much the model may lean on metadata; see
          // SummarizeDayInput. A day is time-uncertain if any of its photos is.
          timeUncertain: dayPhotos.some((p) => p.timeSuspect),
          placeFromMetadataOnly: place !== null && !analyzed.some((p) => p.contentType === "document"),
          stops,
        });
        consecutiveFailures = 0;
      } catch (err) {
        // One day the model would not write does not end the run, and does not
        // lose the day: its old text, if it had any, is kept and it stays
        // stale, so the next run offers it again.
        result.failed++;
        consecutiveFailures++;
        onProgress({ message: `${date}: not summarized — ${(err as Error).message}` });
        // The day as it stands, so the run's other days still write and this
        // one stays stale for the next.
        const keepAsItWas = () =>
          days.push({
            date,
            place,
            summary: prior?.summary ?? null,
            photoIds,
            segments: prior?.segments ?? [],
            summarizedPhotoIds: prior?.summarizedPhotoIds ?? [],
            note,
            summarizedNote: prior?.summarizedNote ?? null,
            edits,
          });
        if (consecutiveFailures >= GIVE_UP_AFTER) {
          onProgress({ message: `Stopping: ${consecutiveFailures} days in a row failed. What is written is kept.` });
          keepAsItWas();
          break;
        }
        keepAsItWas();
        continue;
      }

      summary = summarized.summary;
      if (summarized.native) nativePairs.push(...summarized.native.pairs);
      const bySegment = new Map(summarized.segments.map((seg) => [seg.id, seg] as const));
      segments = stops.map((stop) => {
        const written = bySegment.get(stop.id);
        return {
          id: stop.id,
          kind: stop.kind,
          // A stop the model skipped still renders — as a plain grid under a
          // time range, which is better than dropping its photos silently.
          title: written?.title ?? (stop.kind === "transit" ? "Travelling" : "Unnamed stop"),
          summary: written?.summary ?? null,
          startTime: stop.startTime,
          endTime: stop.endTime,
          photoIds: stop.photos.map((p) => p.id),
          highlights: written?.highlights ?? [],
        };
      });

      segments = claimOnce(segments, photos);

      result.summarized++;
      sinceCheckpoint++;
      if (withheld > 0) {
        onProgress({ message: `${date}: ${withheld} photo(s) withheld from the summary (redaction flag).` });
      }
    }

    // The overlay goes last, over both branches: a reused day keeps the edits
    // it already carries, and a rewritten day has the model's text replaced by
    // the owner's wherever they wrote some.
    const applied = applyEdits(summary, segments, edits);
    summary = applied.summary;
    segments = applied.segments;
    if (applied.orphaned > 0) {
      onProgress({
        message: `${date}: ${applied.orphaned} hand-edit(s) dropped — the photo they were anchored to is no longer in the day.`,
      });
    }

    days.push({
      date,
      place,
      summary,
      photoIds,
      segments,
      // A skipped small day keeps what its stored summary was written from, so
      // it is still seen as stale once it joins a trip or grows. A *reused* day
      // absorbs the photos it tolerated — otherwise the same few additions would
      // be seen as "new" on every run and the day would look stale forever
      // without ever being rewritten. A rewrite records exactly what it read.
      summarizedPhotoIds: outcome === "reuse" || outcome === "rewrite" ? summarizedIds : (prior?.summarizedPhotoIds ?? []),
      note,
      // Only a rewrite consumed the note; a reused day keeps whatever its
      // stored summary was actually written from, or the staleness check would
      // clear itself without the summary ever being redone.
      summarizedNote: outcome === "rewrite" ? note : (prior?.summarizedNote ?? null),
      edits,
    });
    // After the day is in `days`, never before it: a checkpoint taken
    // mid-day would write the index without the day just paid for.
    if (sinceCheckpoint >= CHECKPOINT_EVERY) await checkpoint();
  }

  // A cancelled run must not write a half-built `sections` — the days it never
  // reached would lose the summaries they already had.
  if (signal?.aborted) {
    onProgress({ phase: "cancelled", message: "Cancelled before writing; index left untouched." });
    return result;
  }

  onProgress({ phase: "saving", message: "Splitting into defined trips and month buckets..." });
  index.sections = bucketDays(days, tripDefs, index.sections);
  await saveIndex(token, index);
  await saveNativeText(token, NATIVE_LANGUAGE, nativePairs, onProgress);
  // The summaries just written are searchable text; rebuild rather than let
  // search go stale until the next collect.
  await buildSearchIndex(token, index, onProgress, shards);
  await buildHomeIndex(token, index, onProgress, shards);

  result.days = days.length;
  result.trips = index.sections.filter((s) => s.kind === "trip").length;
  result.months = index.sections.filter((s) => s.kind === "month").length;

  onProgress({
    phase: "done",
    done: days.length,
    total: dates.length,
    message:
      `${result.summarized} day(s) summarized, ${result.reused} unchanged, ${result.small} too small to summarize (${SUMMARY_MIN_PHOTOS} photos or fewer, not in a trip), across ${result.trips} trip(s) and ${result.months} month bucket(s).` +
      (result.failed ? ` ${result.failed} day(s) the model would not write — run again for those.` : ""),
  });
  return result;
}
