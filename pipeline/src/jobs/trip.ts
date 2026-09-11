import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { DayRecord, PhotoRecord } from "@travel-archive/shared";
import { getAccessToken } from "../auth.js";
import { loadIndex, loadShard, saveIndex } from "../archiveStore.js";
import { getProvider } from "../providers/index.js";
import { loadTripDefinitions, TRIPS_FILE, type TripDefinition } from "../tripDefs.js";
import { bucketDays } from "./sections.js";
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
 * run — a hand-written `trip-vienna-bratislava-2026-08` and a generated
 * `trip-wien-bratislava-2026-08-30` with identical ranges — and the narrative
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
    const index = await loadIndex(token);
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
    const index = await loadIndex(token);
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
  const inRange = allDays
    .filter((d) => d.date >= opts.startDate && d.date <= opts.endDate)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (inRange.length === 0) {
    throw new Error(
      `No days between ${opts.startDate} and ${opts.endDate}. Run scan and organize for that range first.`,
    );
  }

  const missing = inRange.filter((d) => !d.summary);
  // Most of the trip unsummarized: the narrative would rest on place names and
  // little else, yet read as authoritative — and be paid for. A few missing
  // days only thin it, which the warning below says.
  if (missing.length * 2 > inRange.length && !opts.allowMissingSummaries) {
    throw new Error(
      `${missing.length} of ${inRange.length} day(s) have no summary yet, so a narrative written now would have little to go on. Write the day summaries for this range first, or tick "Write it anyway".`,
    );
  }
  if (missing.length > 0) {
    onProgress({
      message: `${missing.length} of ${inRange.length} day(s) have no summary yet (${missing.map((d) => d.date).join(", ")}) — the narrative will be thinner for them.`,
    });
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
      photoCount: day.photoIds.length,
      notableCount: day.segments.reduce((n, seg) => n + seg.highlights.length, 0),
      movedFromPreviousKm: moved,
      spanKm: geometry?.spanKm ?? null,
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
