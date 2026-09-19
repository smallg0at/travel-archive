import type { PhotoRecord } from "@travel-archive/shared";
import { getAccessToken } from "./auth.js";
import { loadAllShards, loadIndex, saveIndex } from "./archiveStore.js";
import { withArchiveLock } from "./lock.js";
import { mayBeAnalyzed } from "./screenshots.js";
import { withheldFromSummaries } from "./sensitive.js";
import { dayKey } from "./util.js";

/**
 * Accepts the summaries that already exist, so a handful of late captions does
 * not offer 306 written days for a paid rewrite.
 *
 *   npm run --workspace pipeline accept-days            dry run, writes nothing
 *   npm run --workspace pipeline accept-days -- --apply
 *
 * `organize` treats a day as stale when the set of captioned photos it was
 * written from has changed. The whole-library caption batch then landed a
 * photo or two on nearly every day already summarized — 2 of 59 on
 * 2026-08-16 — and each of those days became a rewrite the owner would pay
 * for, though its summary is perfectly good.
 *
 * This records the day's current captioned set as the set it was written
 * from. It writes no summary and calls no model: it says "this text stands",
 * which is the owner's judgement, not the pipeline's.
 *
 * Only days that already have a summary. A day with none has nothing to
 * stand, and must stay on offer.
 *
 * Afterwards a day is offered again only when its photos change again, so
 * this is a one-off for the batch that has already landed, not a policy. To
 * rewrite one of these days anyway, run organize over it with `force`.
 */

const isAnalyzed = (p: PhotoRecord) => Boolean(p.analyzedAt) && mayBeAnalyzed(p) && !withheldFromSummaries(p);

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const token = await getAccessToken();
  const index = await loadIndex(token);
  const shards = await loadAllShards(token, index);

  // Grouped by the date the photo was taken, as organize does it, not by the
  // day's own photoIds: those are the same set, but the staleness test is
  // computed from this one.
  const byDay = new Map<string, PhotoRecord[]>();
  for (const shard of shards.values()) {
    for (const photo of Object.values(shard.photos)) {
      const key = dayKey(photo.takenAt);
      const list = byDay.get(key) ?? [];
      list.push(photo);
      byDay.set(key, list);
    }
  }

  let accepted = 0;
  let added = 0;
  let removed = 0;
  const examples: string[] = [];
  for (const section of index.sections) {
    for (const day of section.days) {
      if (!day.summary || !day.summarizedPhotoIds) continue;
      const now = (byDay.get(day.date) ?? []).filter(isAnalyzed).map((p) => p.id);
      const prior = new Set(day.summarizedPhotoIds);
      const gained = now.filter((id) => !prior.has(id));
      const lost = day.summarizedPhotoIds.filter((id) => !now.includes(id));
      if (!gained.length && !lost.length) continue;
      accepted++;
      added += gained.length;
      removed += lost.length;
      if (examples.length < 20) {
        examples.push(`${day.date}  ${prior.size} → ${now.length} captioned  (+${gained.length} / -${lost.length})`);
      }
      day.summarizedPhotoIds = now;
    }
  }

  for (const line of examples) console.log(line);
  console.log("");
  console.log(`${accepted} written day(s) would be accepted as they stand; ${added} caption(s) gained, ${removed} lost since each was written.`);
  if (!apply) {
    console.log("Dry run — nothing written. Re-run with --apply.");
    return;
  }
  if (!accepted) return;
  // No search or map rebuild: no text, place or photo record changes here.
  await saveIndex(token, index);
  console.log(`${accepted} day(s) written.`);
}

await withArchiveLock("accept days", main);
