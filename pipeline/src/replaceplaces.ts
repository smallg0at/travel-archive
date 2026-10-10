import type { PhotoRecord } from "@travel-archive/shared";
import { getAccessToken } from "./auth.js";
import { loadIndex, loadShard, saveShard } from "./archiveStore.js";
import { offlinePlace, placeString } from "./geocodeOffline.js";
import { flagGpsOutliersByDay } from "./geo.js";
import { withArchiveLock } from "./lock.js";
import { buildHomeIndex } from "./jobs/homeIndex.js";
import { buildSearchIndex } from "./jobs/searchIndex.js";

/**
 * Re-derives every photo's place from the offline gazetteer.
 *
 *   npm run --workspace pipeline places            dry run, writes nothing
 *   npm run --workspace pipeline places -- --apply
 *
 * The archive's places were written by Nominatim over months, and Nominatim
 * answers with whatever administrative area covers the point: a district name
 * rather than the city people use, "Greater <City>" and a borough rather than
 * the city itself. The string then reads locality-then-country with the city
 * missing from the middle — the owner's observation, and the reason searching
 * for the city found one photo in a library with thousands taken there.
 *
 * The offline lookup already collapses districts into the city people name
 * (geocodeOffline.ts), so this applies that rule to what is already stored,
 * and attaches the English and Simplified Chinese names while it is there.
 *
 * Costs nothing and asks no service. Photos whose GPS contradicts their day
 * (`gpsSuspect`) are left alone, as they are everywhere else.
 *
 * Note for afterwards: a day whose *dominant* place changes is stale to
 * `organize`, so the next run rewrites those summaries. Measured before the
 * first apply: 21 days had a summary at all.
 */

interface Change {
  month: string;
  before: string;
  after: string;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const token = await getAccessToken();
  const index = await loadIndex(token);

  let seen = 0;
  let changed = 0;
  let unplaced = 0;
  let named = 0;
  let nowSuspect = 0;
  let nowTrusted = 0;
  const tally = new Map<string, number>();
  const touched: string[] = [];

  for (const summary of index.months) {
    const shard = await loadShard(token, summary.month);
    let dirty = false;

    // The outlier flags first, so the places below are derived from the
    // current rule. They are otherwise only recomputed when a month is
    // rescanned, which is how one day's bad fixes outlived the rule
    // that should have caught them.
    const photos = Object.values(shard.photos) as PhotoRecord[];
    const before = new Map(photos.map((p) => [p.id, p.gpsSuspect]));
    flagGpsOutliersByDay(photos);
    for (const photo of photos) {
      if (before.get(photo.id) === photo.gpsSuspect) continue;
      dirty = true;
      if (photo.gpsSuspect) {
        nowSuspect++;
        // A suspect point's place is wrong by definition: it is where the
        // phone imagined it was. Left in, it stays searchable ("India") and is
        // still read by captions.
        photo.place = null;
        photo.placeNames = null;
      } else nowTrusted++;
    }
    for (const photo of Object.values(shard.photos) as PhotoRecord[]) {
      if (!photo.gps || photo.gpsSuspect) continue;
      seen++;
      const found = await offlinePlace(photo.gps);
      if (!found) {
        unplaced++;
        continue;
      }
      const place = placeString(found);
      const zh = found.locality.zh ? placeString(found, "zh") : null;
      if (zh) named++;
      const before = photo.place ?? "(none)";
      if (photo.place === place && photo.placeNames?.zh === zh) continue;
      if (photo.place !== place) {
        changed++;
        const key = `${before}  ->  ${place}`;
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
      shard.photos[photo.id] = {
        ...photo,
        place,
        placeNames: { en: placeString(found, "en"), zh },
      };
      dirty = true;
    }
    if (dirty) {
      touched.push(summary.month);
      if (apply) await saveShard(token, shard);
    }
    process.stdout.write(`\r${summary.month} — ${seen} photo(s) seen, ${changed} renamed`);
  }

  console.log("");
  console.log(`${seen} photo(s) with usable GPS; ${changed} would get a different place name.`);
  console.log(`${named} carry a Chinese name; ${unplaced} had no settlement within 60km.`);
  console.log(`GPS outliers: ${nowSuspect} newly suspect (place cleared), ${nowTrusted} no longer suspect.`);
  console.log(`${touched.length} month shard(s) ${apply ? "written" : "would change"}.`);
  console.log("");
  for (const [what, count] of [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`${String(count).padStart(6)}  ${what}`);
  }
  if (!apply) {
    console.log("\nDry run — nothing written. Re-run with --apply.");
    return;
  }
  // Both indexes carry place text: the map is drawn from it, and search
  // matches it, so a place fixed here is not fixed until they are rebuilt.
  if (touched.length) {
    const log = ({ message }: { message?: string | null }) => {
      if (message) console.log(message);
    };
    await buildSearchIndex(token, index, log);
    await buildHomeIndex(token, index, log);
  }
}

// The lock, like every other write path: a shard rewritten underneath a
// running collect would lose that collect's captions.
await withArchiveLock("places", main);
