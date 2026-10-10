import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { DayRecord, PhotoRecord } from "@travel-archive/shared";
import { getAccessToken } from "../auth.js";
import { loadIndex, loadShard, loadIndexForReading, loadTranslations, saveIndex, saveTranslations } from "../archiveStore.js";
import type { TripEdits } from "@travel-archive/shared";
import { getProvider } from "../providers/index.js";
import { loadTripDefinitions, TRIPS_FILE, type TripDefinition } from "../tripDefs.js";
import { bucketDays } from "./sections.js";
import { runOrganize } from "./organize.js";
import type { ProgressFn } from "./analyze.js";
import { NATIVE_LANGUAGE, saveNativeText } from "./translate.js";
import type { TripDayInput } from "../providers/types.js";
import { withArchiveLock } from "../lock.js";
import { removePin } from "../syncStore.js";

/**
 * Writes the story of one trip over a date range the user chose.
 *
 * **The range is given, never inferred.** Detecting trips from GPS was tried and
 * abandoned: it needs a fixed "home" to measure distance from, and home moves —
 * across years, and in the future. Worse, no threshold separates a trip from a
 * day out. On this archive the real trip began 105km from home and an ordinary
 * local day sat at 87km, so any cutoff that caught the first day would have
 * swallowed the second. A range the user selects carries its own context and
 * needs none of that.
 */


export interface TripOptions {
  startDate: string;
  endDate: string;
  /** Null asks the model to propose one. */
  name: string | null;
  notes: string | null;
  documents: { name: string; text: string }[];
  /** Write the narrative even when most days have no summary. Off unless asked for. */
  allowMissingSummaries?: boolean;
}

export interface TripResult {
  days: number;
  narrativeChars: number;
  places: number;
}

/**
 * How far a day must have moved to count as a travel day rather than a day out.
 *
 * The judgement used to be the model's, with the kilometres handed to it — and
 * it narrated them back ("because this day moved 19km…"). 25km separates a day
 * that went somewhere new from one spent wandering a city.
 */
const TRAVEL_DAY_KM = 25;

function km(a: [number, number], b: [number, number]): number {
  const [la1, lo1] = a;
  const [la2, lo2] = b;
  const dLa = ((la2 - la1) * Math.PI) / 180;
  const dLo = ((lo2 - lo1) * Math.PI) / 180;
  const h =
    Math.sin(dLa / 2) ** 2 +
    Math.cos((la1 * Math.PI) / 180) * Math.cos((la2 * Math.PI) / 180) * Math.sin(dLo / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Where a day sat, and how far it moved.
 *
 * The median of a day's fixes rather than the mean, because one bad fix — 4% of
 * this library's located photos land >100km from their own day's median — would
 * otherwise drag the whole day's position with it. Suspect points are dropped
 * outright before that.
 *
 * `spanKm` is first fix to last fix in time order, which is what distinguishes
 * a day that ended somewhere else from a day that wandered and came back.
 */
function dayGeometry(photos: PhotoRecord[]): { centre: [number, number]; spanKm: number } | null {
  const located = photos
    .filter((p) => p.gps && !p.gpsSuspect && p.takenAt)
    .sort((a, b) => (a.takenAt ?? "").localeCompare(b.takenAt ?? ""));
  if (located.length === 0) return null;

  const centre: [number, number] = [
    median(located.map((p) => p.gps!.lat)),
    median(located.map((p) => p.gps!.lon)),
  ];
  const first: [number, number] = [located[0].gps!.lat, located[0].gps!.lon];
  const last: [number, number] = [located[located.length - 1].gps!.lat, located[located.length - 1].gps!.lon];
  return { centre, spanKm: km(first, last) };
}

/**
 * Adds or updates the range in pipeline/data/trips.json, so it survives the next
 * `organize`.
 *
 * Replaces anything **overlapping**, not merely anything sharing the id.
 * `findTripFor` takes the first range matching a date, so two definitions
 * covering the same days silently split the trip: the days attach to one id
 * while everything else refers to the other. That happened on the first real
 * run — a hand-written `trip-spring-2026-05` and a generated
 * `trip-spring-2026-05-01` with identical ranges — and the narrative
 * was attached to the empty one.
 */
async function upsertDefinition(def: TripDefinition): Promise<TripDefinition[]> {
  const existing = await loadTripDefinitions();
  const overlaps = (t: TripDefinition) => t.startDate <= def.endDate && t.endDate >= def.startDate;
  const next = existing.filter((t) => t.id !== def.id && !overlaps(t));
  next.push(def);
  next.sort((a, b) => a.startDate.localeCompare(b.startDate));
  await writeFile(TRIPS_FILE, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return next;
}

async function writeDefinitions(defs: TripDefinition[]): Promise<void> {
  await writeFile(TRIPS_FILE, `${JSON.stringify(defs, null, 2)}\n`, "utf-8");
}

/**
 * Renames a trip: its section in the index and its definition in trips.json.
 * The id stays — pins, links and the second language's text refer to it.
 * The index is written first, so a failure leaves the old name everywhere
 * rather than two names.
 */
export async function renameTrip(id: string, name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) throw new Error("A trip needs a name.");
  await withArchiveLock("rename trip", async () => {
    const defs = await loadTripDefinitions();
    const def = defs.find((d) => d.id === id);
    if (!def) throw new Error(`There is no trip "${id}".`);
    const token = await getAccessToken();
    // From the mirror: the index is ~9MB and reading it locally rather than
    // downloading costs nothing but the upload that follows, which is
    // unavoidable. Single-writer, like the translate pass — see
    // loadIndexForReading. A rename touched one field of one section.
    const index = await loadIndexForReading(token);
    const section = index.sections.find((s) => s.id === id);
    if (section) {
      section.name = clean;
      await saveIndex(token, index);
    }
    def.name = clean;
    await writeDefinitions(defs);
  });
}

/**
 * Records the owner's hand corrections to a trip's narrative or name.
 *
 * The same shape as the day editor: `lang` absent writes the **original** (onto
 * the section, `TripRecord.edits`), and a language code writes that language's
 * corrections into its sidecar (`TranslationFile.tripOwner`), where they sit
 * over the translation and are touched by neither a translate run nor a
 * regeneration. A null value clears that field's correction and hands the text
 * back to the model.
 *
 * **No staleness flag.** A day summary has consumers that read it — a trip
 * narrative, a search index — so editing one has to mark the day for rewrite.
 * A narrative is the end of the chain; an edit is the final word until somebody
 * asks for a new one, which is what Regenerate is for.
 */
export async function editTrip(
  id: string,
  patch: { narrative?: string | null; name?: string | null; lang?: string | null },
): Promise<TripEdits | null> {
  return withArchiveLock("edit trip", async () => {
    const lang = patch.lang?.trim() || null;
    const token = await getAccessToken();

    if (lang) {
      // This language's own corrections, in its own file.
      const file = await loadTranslations(token, lang, "index");
      file.tripOwner ??= {};
      const next: TripEdits = { ...(file.tripOwner[id] ?? {}) };
      if (patch.narrative !== undefined) next.narrative = patch.narrative ?? "";
      if (patch.name !== undefined) next.name = patch.name ?? "";
      const pruned = pruneTripEdits(next);
      if (pruned) file.tripOwner[id] = pruned;
      else delete file.tripOwner[id];
      await saveTranslations(token, lang, "index", file);
      return pruned;
    }

    const index = await loadIndexForReading(token);
    const section = index.sections.find((s) => s.id === id);
    if (!section) throw new Error(`There is no trip "${id}".`);
    const next: TripEdits = { ...(section.edits ?? {}) };
    if (patch.narrative !== undefined) next.narrative = patch.narrative ?? "";
    if (patch.name !== undefined) next.name = patch.name ?? "";
    const pruned = pruneTripEdits(next);
    section.edits = pruned;
    await saveIndex(token, index);
    return pruned;
  });
}

/** Drops fields that say nothing, so a cleared edit does not linger as an empty string. */
function pruneTripEdits(edits: TripEdits): TripEdits | null {
  const next: TripEdits = {};
  if (edits.narrative) next.narrative = edits.narrative;
  if (edits.name) next.name = edits.name;
  return next.narrative || next.name ? next : null;
}

/**
 * Deletes a trip — its date range and its narrative. Its days go back to
 * their months with their summaries intact, and no photo is touched. A pin on
 * the trip goes too, since it would name nothing.
 */
export async function deleteTrip(id: string): Promise<void> {
  await withArchiveLock("delete trip", async () => {
    const defs = await loadTripDefinitions();
    const rest = defs.filter((d) => d.id !== id);
    if (rest.length === defs.length) throw new Error(`There is no trip "${id}".`);
    const token = await getAccessToken();
    // From the mirror, for the same reason renameTrip is: ~9MB, read locally,
    // one upload after. See loadIndexForReading.
    const index = await loadIndexForReading(token);
    index.sections = bucketDays(
      index.sections.flatMap((s) => s.days),
      rest,
      index.sections,
    );
    await saveIndex(token, index);
    await writeDefinitions(rest);
    await removePin("trip", id).catch(() => undefined);
  });
}

/**
 * Makes a range a trip with no narrative: the days leave their months and
 * gather under the name, and nothing is spent. What accepting a suggestion
 * does — the narrative stays one click away in Generate, for the trips worth
 * one.
 *
 * Refuses an overlap instead of replacing it, unlike upsertDefinition: that
 * is for re-running a trip over its own range, and here a stale suggestion
 * would silently delete a trip the owner had named by hand.
 */
export async function defineTrip(startDate: string, endDate: string, name: string): Promise<TripDefinition> {
  const clean = name.trim();
  if (!clean) throw new Error("A trip needs a name.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || endDate < startDate) {
    throw new Error("A trip needs a start and an end date, in order.");
  }
  return withArchiveLock("define trip", async () => {
    const defs = await loadTripDefinitions();
    const clash = defs.find((t) => t.startDate <= endDate && t.endDate >= startDate);
    if (clash) throw new Error(`That overlaps "${clash.name}" (${clash.startDate} to ${clash.endDate}).`);
    const def: TripDefinition = { id: idFor({ startDate, endDate, name: clean, notes: null, documents: [] }), name: clean, startDate, endDate };
    const next = [...defs, def].sort((a, b) => a.startDate.localeCompare(b.startDate));
    const token = await getAccessToken();
    const index = await loadIndex(token);
    index.sections = bucketDays(
      index.sections.flatMap((s) => s.days),
      next,
      index.sections,
    );
    // The index first, as renameTrip does: a failure leaves no definition
    // pointing at days that never moved.
    await saveIndex(token, index);
    await writeDefinitions(next);
    return def;
  });
}

function idFor(opts: TripOptions): string {
  const slug = (opts.name ?? "trip")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `trip-${slug || "trip"}-${opts.startDate}`;
}

export async function runTrip(opts: TripOptions, onProgress: ProgressFn, signal?: AbortSignal): Promise<TripResult> {
  onProgress({ phase: "signing-in", message: "Signing in..." });
  const token = await getAccessToken();

  onProgress({ phase: "loading", message: "Loading index..." });
  const index = await loadIndex(token);

  const allDays = index.sections.flatMap((s) => s.days);
  let inRange = allDays
    .filter((d) => d.date >= opts.startDate && d.date <= opts.endDate)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (inRange.length === 0) {
    throw new Error(
      `No days between ${opts.startDate} and ${opts.endDate}. Run scan and organize for that range first.`,
    );
  }

  const missing = inRange.filter((d) => !d.summary);
  // Days with no summary are written **here**, before the narrative, rather
  // than warned about.
  //
  // This used to be the reader's problem: a range was ticked, the days were
  // skipped as too small, and the trip asked to be written anyway on nothing —
  // or refused. The work is one model call per day, and it is what makes the
  // range a trip at all: `organize` summarises a day of three photos when the
  // day belongs to a trip, and it did not when the trip was defined afterwards.
  //
  // The lock is already held by `runTrip`, and `runOrganize` does not take one,
  // so this is safe to call from inside it. Only the missing dates are passed,
  // so nothing already paid for is rewritten.
  if (missing.length > 0) {
    onProgress({
      phase: "summarizing",
      message: `${missing.length} day(s) in this range have no summary yet — writing them first (~${missing.length} model call(s)).`,
    });
    await runOrganize(
      { only: null, days: missing.map((d) => d.date), force: false },
      onProgress,
      signal,
    );
    // Reload the index, and **rebuild the day list from it**. The run above
    // wrote its summaries through `saveIndex`; carrying on with the copy read
    // before it would lose them twice over — the narrative would be written
    // from the empty days, and `bucketDays` at the end would write those empty
    // days back over what was just paid for. (Observed: "1 day summarized",
    // and the day still had no summary afterwards.)
    const refreshed = await loadIndex(token);
    const freshDays = refreshed.sections.flatMap((s) => s.days);
    // `inRange` is `let` for this: it is the same three days, with what the run
    // above filled in.
    inRange = freshDays
      .filter((d) => d.date >= opts.startDate && d.date <= opts.endDate)
      .sort((a, b) => a.date.localeCompare(b.date));
    // The end of this function re-sorts every day, so it has to see the new
    // ones too.
    allDays.length = 0;
    allDays.push(...freshDays);

    const stillMissing = inRange.filter((d) => !d.summary).length;
    if (stillMissing > 0 && stillMissing * 2 > inRange.length && !opts.allowMissingSummaries) {
      throw new Error(
        `${stillMissing} of ${inRange.length} day(s) still have no summary after writing them, so a narrative now would have little to go on.`,
      );
    }
  }

  // Only the shards the range actually spans; a trip is days, not years.
  onProgress({ phase: "loading", message: "Reading GPS for the range..." });
  const monthsNeeded = [...new Set(inRange.map((d) => d.date.slice(0, 7)))];
  const photosById: Record<string, PhotoRecord> = {};
  for (const month of monthsNeeded) {
    const shard = await loadShard(token, month);
    Object.assign(photosById, shard.photos);
  }

  let previousCentre: [number, number] | null = null;
  const dayInputs: TripDayInput[] = inRange.map((day: DayRecord) => {
    const dayPhotos = day.photoIds.map((id) => photosById[id]).filter(Boolean);
    const geometry = dayGeometry(dayPhotos);
    const moved = geometry && previousCentre ? km(previousCentre, geometry.centre) : null;
    if (geometry) previousCentre = geometry.centre;

    return {
      date: day.date,
      place: day.place,
      summary: day.summary,
      // The numbers decide the kind **here**, and only the kind travels on.
      // Handing the model "moved 19km, ranged 71km" and asking it to use them
      // produced prose that narrated the figures — "because this day moved
      // 19km from Bedford I count it as travel" — which is the prompt leaking
      // into the story. A day either was a travel day or was not; that is the
      // whole of what the narrative needs.
      movedFromPreviousKm: moved,
      spanKm: geometry?.spanKm ?? null,
      isTravel: moved !== null && moved >= TRAVEL_DAY_KM,
      // Titles only: a trip narrative wants to know an exhibition happened, and
      // has no use for a card's description or its placard translation.
      places: day.segments
        .filter((seg) => seg.title && !/^train|^flight|^drive|^transit/i.test(seg.title))
        .map((seg) => seg.title)
        .slice(0, 12),
      highlights: day.segments
        .flatMap((seg) => seg.highlights.filter((h) => h.title))
        .map((h) => h.title)
        .slice(0, 12),
    };
  });

  if (signal?.aborted) throw new Error("Cancelled before the narrative was written");

  onProgress({
    phase: "narrating",
    done: 0,
    total: 1,
    message: `Writing the narrative for ${inRange.length} day(s)...`,
  });

  const provider = getProvider();
  const summary = await provider.summarizeTrip({
    name: opts.name,
    startDate: opts.startDate,
    endDate: opts.endDate,
    days: dayInputs,
    notes: opts.notes,
    documents: opts.documents,
    alsoIn: NATIVE_LANGUAGE,
  });

  const def: TripDefinition = {
    id: idFor({ ...opts, name: opts.name ?? summary.name }),
    name: summary.name,
    startDate: opts.startDate,
    endDate: opts.endDate,
  };

  onProgress({ phase: "saving", message: `Saving "${summary.name}"...` });
  const defs = await upsertDefinition(def);

  // Re-sort every day against the updated definitions, so days joining this
  // trip leave the month buckets they were sitting in.
  index.sections = bucketDays(allDays, defs, index.sections);
  const section = index.sections.find((s) => s.id === def.id);
  if (!section) {
    // Loudly, because the first version of this quietly wrote `narrative: null`
    // and still printed a success line with a character count — the narrative
    // had been generated and paid for, and went nowhere.
    throw new Error(
      `Generated the narrative but found no section with id ${def.id} to attach it to. ` +
        `Check pipeline/data/trips.json for a competing range over ${opts.startDate}..${opts.endDate}.`,
    );
  }
  section.narrative = summary.narrative;
  section.places = summary.places;
  section.narrativeGeneratedAt = new Date().toISOString();
  await saveIndex(token, index);
  await saveNativeText(token, NATIVE_LANGUAGE, summary.native?.pairs ?? [], onProgress);

  onProgress({
    phase: "done",
    done: 1,
    total: 1,
    message: `"${summary.name}" — ${summary.narrative.length} chars over ${inRange.length} day(s); places: ${summary.places.join(", ") || "none listed"}.`,
  });

  return { days: inRange.length, narrativeChars: summary.narrative.length, places: summary.places.length };
}

/** Reads a local file for `--doc`; the server takes document text in its request body instead. */
export async function readDocument(path: string): Promise<{ name: string; text: string }> {
  return { name: path.split(/[\\/]/).pop() ?? path, text: await readFile(path, "utf-8") };
}
