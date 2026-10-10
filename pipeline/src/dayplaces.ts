import type { PhotoRecord } from "@travel-archive/shared";
import { getAccessToken } from "./auth.js";
import { loadAllShards, loadIndex, saveIndex } from "./archiveStore.js";
import { withArchiveLock } from "./lock.js";
import { buildHomeIndex } from "./jobs/homeIndex.js";
import { buildSearchIndex } from "./jobs/searchIndex.js";

/**
 * Puts each day's place label back in step with its photos, without paying to
 * rewrite the day.
 *
 *   npm run --workspace pipeline dayplaces            dry run, writes nothing
 *   npm run --workspace pipeline dayplaces -- --apply
 *
 * Re-deriving photo places offline (replaceplaces.ts) and the border-aware
 * lookup after it changed what a day's dominant place is — a district resolved
 * to the city it belongs to, and a border town changed country. `organize`
 * treats that as a stale input and offers to rewrite those days, which is a
 * model call each.
 *
 * The owner asked for the cheap half: copy the new place onto the day so the
 * label is right and the day stops being offered for a paid rewrite. The
 * summary text is left exactly as it was, so a day whose prose names the old
 * place still names it. That is the bandage — a real fix is a rewrite, at the
 * owner's choosing, day by day.
 *
 * `summarizedPhotoIds` is not touched: it records what the summary was written
 * from, and it is the other half of the staleness test.
 */

/** The same rule organize uses to label a day: the place most of its photos carry. */
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

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const token = await getAccessToken();
  const index = await loadIndex(token);
  const shards = await loadAllShards(token, index);
  const photos: Record<string, PhotoRecord> = {};
  for (const shard of shards.values()) Object.assign(photos, shard.photos);

  let changed = 0;
  let cleared = 0;
  const examples: string[] = [];
  for (const section of index.sections) {
    for (const day of section.days) {
      const next = dominantPlace(day.photoIds.map((id) => photos[id]).filter(Boolean));
      if (next === day.place) continue;
      // A day whose photos now have no place at all: leaving the old string
      // would keep the label and the staleness test disagreeing forever.
      if (next === null) cleared++;
      changed++;
      if (examples.length < 25) examples.push(`${day.date}  ${day.place ?? "—"}  →  ${next ?? "—"}`);
      day.place = next;
    }
  }

  for (const line of examples) console.log(line);
  console.log("");
  console.log(`${changed} day(s) would take a different place; ${cleared} of them have no place now.`);
  if (!apply) {
    console.log("Dry run — nothing written. Re-run with --apply.");
    return;
  }
  if (!changed) return;
  await saveIndex(token, index);
  // Search matches day text and the map counts days per place, so neither is
  // right until it is rebuilt.
  const log = ({ message }: { message?: string | null }) => {
    if (message) console.log(message);
  };
  await buildSearchIndex(token, index, log);
  await buildHomeIndex(token, index, log);
  console.log(`${changed} day(s) written.`);
}

await withArchiveLock("day places", main);
