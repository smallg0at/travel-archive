import { mkdir, readFile, rename } from "node:fs/promises";

/**
 * Trips are defined manually, not auto-detected — a mixed photo+screenshot
 * library has no reliable signal (no gaps, no clean geo-cluster) to infer
 * them from. The intended workflow: tell an agent (a Claude Code session,
 * this one included) something like "look at photos from March 1-15 and
 * call that the Japan trip" — it inspects pipeline/data/archive.json for
 * that range and adds an entry here. Any day not covered by a range here
 * falls into a month bucket instead (see organize.ts).
 */
export interface TripDefinition {
  id: string;
  name: string;
  startDate: string; // YYYY-MM-DD, inclusive
  endDate: string; // YYYY-MM-DD, inclusive
}

/**
 * Lives under data/ with the rest of the archive, not at the pipeline root.
 *
 * It is the owner's travel history — trip names and exact date ranges — so it
 * belongs with the other things `.gitignore` keeps out of the repository, not
 * beside the source. Exported rather than redeclared: the writer in
 * jobs/trip.ts kept its own copy of this path, and two copies of a filename is
 * how a reader and a writer end up pointing at different files.
 */
export const TRIPS_FILE = new URL("../data/trips.json", import.meta.url);

/** Where it used to live, before it moved in with the rest of the data. */
const LEGACY_TRIPS_FILE = new URL("../trips.json", import.meta.url);

/**
 * Moves an old root-level trips.json into data/ the first time it is seen.
 *
 * Without this, moving the file silently empties the trip list: every day falls
 * back into a month bucket and the trips vanish from the app, with nothing to
 * say why.
 */
async function migrateLegacyFile(): Promise<void> {
  try {
    await readFile(TRIPS_FILE, "utf-8");
    return; // already in the new place
  } catch {
    /* not there yet — fall through */
  }
  try {
    await readFile(LEGACY_TRIPS_FILE, "utf-8");
  } catch {
    return; // nothing to migrate
  }
  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await rename(LEGACY_TRIPS_FILE, TRIPS_FILE);
  console.log("Moved trips.json into pipeline/data/ — it is archive data, not configuration.");
}

export async function loadTripDefinitions(): Promise<TripDefinition[]> {
  await migrateLegacyFile();
  try {
    const raw = await readFile(TRIPS_FILE, "utf-8");
    return JSON.parse(raw) as TripDefinition[];
  } catch {
    return [];
  }
}

/** First matching range wins if ranges overlap — keep pipeline/data/trips.json non-overlapping. */
export function findTripFor(date: string, defs: TripDefinition[]): TripDefinition | null {
  return defs.find((t) => date >= t.startDate && date <= t.endDate) ?? null;
}
