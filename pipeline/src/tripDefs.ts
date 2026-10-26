import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dataDir, dataFile, homeFile } from "./paths.js";
import type { ArchiveIndexFile } from "@travel-archive/shared";

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
export const TRIPS_FILE = dataFile("trips.json");

/** Where it used to live, before it moved in with the rest of the data. */
const LEGACY_TRIPS_FILE = homeFile("trips.json");

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
  await mkdir(dataDir(), { recursive: true });
  await rename(LEGACY_TRIPS_FILE, TRIPS_FILE);
  console.log("Moved trips.json into pipeline/data/ — it is archive data, not configuration.");
}

/**
 * Trip definitions recovered from an index's trip sections.
 *
 * The index is shared (uploaded with the archive) and carries each trip's id,
 * name and range; `trips.json` is a local working copy. So the index can always
 * rebuild the definitions, while the reverse is not true. That matters because
 * losing the definitions is not a local inconvenience: every job that rebuilds
 * sections from them would upload an index with the trips gone.
 */
export function definitionsFromIndex(index: ArchiveIndexFile): TripDefinition[] {
  return index.sections
    .filter((section) => section.kind === "trip")
    .map((section) => ({
      id: section.id,
      name: section.name,
      startDate: section.startDate,
      endDate: section.endDate,
    }));
}

/** The mirrored index, if there is one. Absent or unreadable means no recovery. */
async function localIndex(): Promise<ArchiveIndexFile | null> {
  try {
    return JSON.parse(await readFile(dataFile("index.json"), "utf-8")) as ArchiveIndexFile;
  } catch {
    return null;
  }
}

/**
 * Loads the trip definitions, healing an empty or missing file from the index.
 *
 * This is a data-loss fix, not a convenience. On 2026-10-27 a first trip was
 * created in the packaged app, whose `data/trips.json` had never existed —
 * definitions had only ever lived in a development checkout. Creating the trip
 * rebuilt every section from an empty list, and the upload that followed erased
 * all sixteen trips from the archive. The index still carried them, so the list
 * was recoverable, but nothing had asked it.
 *
 * Two rules follow:
 *
 *  - A file that exists and cannot be parsed is an error, not an empty list. The
 *    old `catch { return [] }` turned a truncated write into "this archive has
 *    no trips", which is the worst possible reading of a broken file.
 *  - An empty or missing file is recovered from the index's trip sections before
 *    anyone can rebuild sections from it.
 */
export async function loadTripDefinitions(index?: ArchiveIndexFile): Promise<TripDefinition[]> {
  await migrateLegacyFile();
  let parsed: TripDefinition[] | null = null;
  try {
    parsed = JSON.parse(await readFile(TRIPS_FILE, "utf-8")) as TripDefinition[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `Could not read ${TRIPS_FILE}: ${(error as Error).message}. ` +
          `Refusing to treat a broken trip list as "no trips" — every index rebuild would drop them.`,
      );
    }
  }
  if (parsed && Array.isArray(parsed) && parsed.length > 0) return parsed;

  // Prefer the caller's index: a job has just loaded the authoritative copy,
  // while the local mirror may not exist yet on a fresh machine.
  const source = index ?? (await localIndex());
  const recovered = source ? definitionsFromIndex(source) : [];
  if (recovered.length) {
    await mkdir(dataDir(), { recursive: true });
    await writeFile(TRIPS_FILE, `${JSON.stringify(recovered, null, 2)}\n`, "utf-8");
    console.log(
      `Recovered ${recovered.length} trip definition(s) from index.json — trips.json was ` +
        `${parsed ? "empty" : "missing"}.`,
    );
    return recovered;
  }
  return [];
}

/** First matching range wins if ranges overlap — keep pipeline/data/trips.json non-overlapping. */
export function findTripFor(date: string, defs: TripDefinition[]): TripDefinition | null {
  return defs.find((t) => date >= t.startDate && date <= t.endDate) ?? null;
}
