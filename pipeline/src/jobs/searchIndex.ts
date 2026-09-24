import type { ArchiveIndexFile, PhotoShard, SearchIndexFile } from "@travel-archive/shared";
import { loadAllShards, saveSearchIndex } from "../archiveStore.js";
import { mayBeAnalyzed } from "../screenshots.js";
import { withheldFromSummaries } from "../sensitive.js";
import type { ProgressFn } from "./analyze.js";

/**
 * The searchable text of the whole archive, in one file.
 *
 * Built here rather than in the app because the app may be a browser reading
 * OneDrive with no server at all, and because the text it needs — captions from
 * the shards, summaries from the index — is spread across 123 files totalling
 * 38MB. What comes out is ~4MB, which loads once and answers every keystroke
 * from memory.
 *
 * Rebuilt whenever captions or summaries change: at the end of a collect and at
 * the end of an organize. It is derived data — losing it costs one rebuild, so
 * it is never migrated, just written again.
 *
 * Withheld screenshots are left out on the same grounds they are kept from the
 * summarizer: they were never shown to a model, and a search box is another way
 * of reading them back.
 */

/**
 * Bumped to 2 when the row grew a tags field. The app tolerates v1 rows (a
 * missing fourth element reads as no tags) so an old index still searches; it
 * just has no chips to show until the next `organize` rebuilds it.
 */
export const SEARCH_SCHEMA = 2;

/** Text is stored lowercased: every query lowercases too, so neither side does it per keystroke. */
const clean = (parts: (string | null | undefined)[]): string =>
  parts
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

export interface SearchIndexResult {
  photos: number;
  days: number;
  trips: number;
  bytes: number;
}

export async function buildSearchIndex(
  token: string,
  index: ArchiveIndexFile,
  onProgress?: ProgressFn,
  shards?: Map<string, PhotoShard>,
): Promise<SearchIndexResult> {
  onProgress?.({ phase: "saving", message: "Building the search index..." });
  const all = shards ?? (await loadAllShards(token, index));

  // Every id in this archive is `<driveId>!<number>`; storing the drive id
  // 24,000 times would be a fifth of the file.
  let idPrefix = "";
  for (const shard of all.values()) {
    for (const id of Object.keys(shard.photos)) {
      const bang = id.indexOf("!");
      if (bang > 0) idPrefix = id.slice(0, bang + 1);
      break;
    }
    if (idPrefix) break;
  }

  const photos: SearchIndexFile["photos"] = [];
  for (const shard of all.values()) {
    for (const photo of Object.values(shard.photos)) {
      if (!mayBeAnalyzed(photo) || withheldFromSummaries(photo)) continue;
      const text = clean([photo.caption, photo.place, photo.placeNames?.en, photo.placeNames?.zh]);
      const tags = clean([...(photo.tags ?? [])]);
      if (!text && !tags) continue;
      const id = photo.id.startsWith(idPrefix) ? photo.id.slice(idPrefix.length) : photo.id;
      photos.push([id, photo.takenAt?.slice(0, 10) ?? "", text, tags]);
    }
  }

  const days: SearchIndexFile["days"] = [];
  const trips: SearchIndexFile["trips"] = [];
  for (const section of index.sections) {
    for (const day of section.days) {
      const segments = (day.segments ?? []).flatMap((s) => [s.title, s.summary]);
      const text = clean([day.summary, day.place, day.note, ...segments]);
      if (text) days.push([day.date, text]);
    }
    if (section.kind === "trip") {
      const dates = section.days.map((d) => d.date).sort();
      trips.push([section.id, section.name, dates[0] ?? "", dates[dates.length - 1] ?? ""]);
    }
  }

  const file: SearchIndexFile = {
    schemaVersion: SEARCH_SCHEMA,
    builtAt: new Date().toISOString(),
    idPrefix,
    photos,
    days,
    trips,
  };
  const bytes = await saveSearchIndex(token, file);
  onProgress?.({
    message: `Search index: ${photos.length} photo(s), ${days.length} day(s), ${trips.length} trip(s) — ${(bytes / 1e6).toFixed(1)}MB.`,
  });
  return { photos: photos.length, days: days.length, trips: trips.length, bytes };
}
