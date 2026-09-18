import type { ArchiveIndexFile, HomeIndexFile, HomePlace, PhotoShard } from "@travel-archive/shared";
import { loadAllShards, saveHomeIndex } from "../archiveStore.js";
import { withheldFromSummaries } from "../sensitive.js";
import type { ProgressFn } from "./analyze.js";

/**
 * Where this library has been, in one small file.
 *
 * The home page draws every place at once, and the coordinates to do it with
 * are spread over 30 shards totalling 38MB — `index.json` carries no GPS by
 * design, so there is nothing cheaper to read. Aggregating here costs one pass
 * that is already being made (the search index runs off the same shards) and
 * leaves the reader with ~100KB, which matters most to the reader who has no
 * server at all.
 *
 * Built beside the search index, from the same `shards` map, at the end of an
 * organize and after a collect.
 */

export const HOME_SCHEMA = 1;

/**
 * Photos are grouped by the place name the gazetteer gave them rather than by
 * distance. The names come from one offline pass over a fixed settlement list
 * (geocodeOffline.ts), so every photo in a town carries the *same* string —
 * clustering by coordinate would only rediscover that, less reliably and with
 * a threshold to argue about.
 */
interface Bucket {
  name: string;
  nameEn: string | null;
  nameZh: string | null;
  lats: number[];
  lons: number[];
  days: Set<string>;
  photoCount: number;
}

/**
 * The middle value, which is what a single wrong fix cannot move.
 *
 * A mean would: this library has GPS on 92% of its photos and a known habit of
 * bad fixes, which is what `gpsSuspect` exists for. Suspect points are dropped
 * before this, and the median then absorbs whatever slipped through.
 */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * "United Kingdom" from "a town, United Kingdom".
 *
 * Taken from the English name only. The endonym's last part is a country in a
 * language that varies by row — "Osterreich", "中国" — so counting distinct
 * values across them would count one country several times.
 */
function countryOf(nameEn: string | null): string | null {
  if (!nameEn) return null;
  const comma = nameEn.lastIndexOf(",");
  return comma === -1 ? nameEn : nameEn.slice(comma + 1).trim() || null;
}

export interface HomeIndexResult {
  places: number;
  placed: number;
  countries: number;
  bytes: number;
}

export async function buildHomeIndex(
  token: string,
  index: ArchiveIndexFile,
  onProgress?: ProgressFn,
  shards?: Map<string, PhotoShard>,
): Promise<HomeIndexResult> {
  onProgress?.({ phase: "saving", message: "Building the map index..." });
  const all = shards ?? (await loadAllShards(token, index));

  const buckets = new Map<string, Bucket>();
  let photos = 0;
  let placed = 0;

  for (const shard of all.values()) {
    for (const photo of Object.values(shard.photos)) {
      photos++;
      // Withheld on the same grounds as in the search index: a screenshot kept
      // out of the summaries should not reappear as a dot on a map of where
      // its owner has been.
      if (withheldFromSummaries(photo)) continue;
      // A duplicate is the same photograph in the same spot; counting it twice
      // would inflate a marker without adding a place.
      if (photo.duplicateGroupId && !photo.isDuplicateRepresentative) continue;
      if (!photo.gps || photo.gpsSuspect) continue;

      const name = photo.place;
      if (!name) continue;

      let bucket = buckets.get(name);
      if (!bucket) {
        bucket = {
          name,
          nameEn: photo.placeNames?.en ?? null,
          nameZh: photo.placeNames?.zh ?? null,
          lats: [],
          lons: [],
          days: new Set(),
          photoCount: 0,
        };
        buckets.set(name, bucket);
      }
      // A photo placed before `placeNames` existed has none; one placed after
      // has them for the whole bucket, so the first that carries them wins
      // rather than the first seen.
      bucket.nameEn ??= photo.placeNames?.en ?? null;
      bucket.nameZh ??= photo.placeNames?.zh ?? null;
      bucket.lats.push(photo.gps.lat);
      bucket.lons.push(photo.gps.lon);
      bucket.photoCount++;
      const day = photo.takenAt?.slice(0, 10);
      if (day) bucket.days.add(day);
      placed++;
    }
  }

  const places: HomePlace[] = [...buckets.values()]
    .map((b) => ({
      name: b.name,
      nameEn: b.nameEn,
      nameZh: b.nameZh,
      country: countryOf(b.nameEn ?? b.name),
      lat: Number(median(b.lats).toFixed(4)),
      lon: Number(median(b.lons).toFixed(4)),
      photoCount: b.photoCount,
      days: [...b.days].sort(),
    }))
    // Biggest first, so the map can draw the places that matter before the
    // long tail and a reader scanning the list sees them in that order.
    .sort((a, b) => b.photoCount - a.photoCount);

  const countries = new Set(places.map((p) => p.country).filter(Boolean)).size;
  const days = new Set(places.flatMap((p) => p.days)).size;

  const file: HomeIndexFile = {
    schemaVersion: HOME_SCHEMA,
    builtAt: new Date().toISOString(),
    places,
    totals: { placed, photos, days, countries },
  };

  const bytes = await saveHomeIndex(token, file);
  onProgress?.({
    message: `Map index: ${places.length} place(s) in ${countries} countr${countries === 1 ? "y" : "ies"}, ${placed} photo(s) placed — ${(bytes / 1e3).toFixed(0)}KB.`,
  });
  return { places: places.length, placed, countries, bytes };
}
