import type { MonthSummary, PhotoRecord, PhotoShard } from "@travel-archive/shared";
import { loadIndex, loadShard, saveIndex, saveShard } from "../archiveStore.js";
import { getAccessToken } from "../auth.js";
import { renamePhoto } from "../graph.js";
import { withArchiveLock } from "../lock.js";
import { renameForTakenAt } from "../util.js";
import { assignDuplicates } from "../duplicates.js";
import { summarize } from "./scan.js";

/**
 * Giving a photo the day and time it was actually taken.
 *
 * WhatsApp saves carry no EXIF, so `takenAtOf` falls back to the filename —
 * which means the filename *is* the timestamp, and correcting it is a rename
 * rather than an override stored beside the record. That matters: an override
 * would have to be re-applied by every future scan and could silently disagree
 * with the file, while a rename is simply true afterwards. The archive's own
 * scan reads it back with no special case.
 *
 * The photos this exists for are the 125 in this library dated from their name,
 * which land at midnight — a fabricated hour that `stops.ts` refuses to place,
 * so they are appended to the end of the day instead of sitting in it.
 */

export interface SetTakenAtRequest {
  /** The shard the photo is in today, which is its *capture* month. */
  month: string;
  date: string;
  /** `HH:MM`, or null to leave the photo dated but untimed. */
  time: string | null;
}

export interface SetTakenAtResult {
  id: string;
  fileName: string;
  takenAt: string;
  dateSource: PhotoRecord["dateSource"];
  timeSuspect: boolean;
  /** The months whose shards changed — both of them, when the photo crossed one. */
  months: string[];
}

export interface BatchItem extends SetTakenAtRequest {
  id: string;
}

export interface BatchResult {
  results: SetTakenAtResult[];
  /** One entry per photo that was not changed, and why. The rest still went through. */
  errors: { id: string; error: string }[];
  /** Every month whose shard this batch rewrote. */
  months: string[];
}

/** Big enough for the whole backlog in one go; small enough that a runaway client cannot rename a library. */
export const MAX_BATCH = 200;
/** The same four the scan and thumbnail paths use against Graph. */
const RENAME_CONCURRENCY = 4;

function upsertMonth(months: MonthSummary[], summary: MonthSummary): MonthSummary[] {
  const next = months.filter((m) => m.month !== summary.month);
  // A month emptied by the move disappears rather than lingering with a count
  // for photos that are no longer in it — the ghost-month bug, in miniature.
  if (summary.photoCount > 0) next.push(summary);
  return next.sort((a, b) => a.month.localeCompare(b.month));
}

/** Why this photo cannot be retimed as asked, or its new name. */
function plan(record: PhotoRecord | undefined, item: BatchItem): { fileName: string } | { error: string } {
  if (!record) return { error: `No photo ${item.id} in ${item.month}.` };

  // EXIF wins in `takenAtOf`, so renaming such a photo changes the name and
  // moves nothing. Refusing is the honest answer; silently renaming would
  // leave a file whose name disagrees with the archive forever.
  if (record.dateSource === "exif") {
    return {
      error: `${record.fileName} takes its date from EXIF, which outranks the filename — renaming it would not move the photo.`,
    };
  }

  const fileName = renameForTakenAt(record.fileName, item.date, item.time);
  if (!fileName) {
    return { error: `${record.fileName} carries no date to rewrite, so there is nothing a rename can change.` };
  }
  if (fileName === record.fileName) {
    return { error: `${record.fileName} already says ${item.date}${item.time ? ` ${item.time}` : ""}.` };
  }
  return { fileName };
}

/**
 * Retimes many photos under one lock, with one read and one write of each file.
 *
 * This is the performance fix rather than a convenience. A single retime costs
 * two Graph downloads — the month's shard and the 3.4MB index, read from Graph
 * because this is a write path (docs/invariants.md) — plus the uploads, measured at 5-6
 * seconds a photo. Done one at a time, the 118-photo backlog is ten minutes of
 * waiting on the same two files; batched, it is one read of each and the
 * renames, which are small and run four at a time.
 *
 * Partial success is allowed and reported. The renames are independent writes
 * to the photo library, so one refused name must not strand the others — but
 * every rename that *did* happen is recorded in the archive before returning,
 * because a renamed file the archive does not know about would be undone by
 * nothing and contradicted by the viewer until the next scan.
 */
export async function setPhotosTakenAt(items: BatchItem[]): Promise<BatchResult> {
  if (items.length === 0) return { results: [], errors: [], months: [] };
  if (items.length > MAX_BATCH) throw new Error(`At most ${MAX_BATCH} photos at a time; got ${items.length}.`);

  return withArchiveLock("set photo time", async () => {
    const token = await getAccessToken();
    const shards = new Map<string, PhotoShard>();
    const shardFor = async (month: string): Promise<PhotoShard> => {
      let shard = shards.get(month);
      if (!shard) {
        shard = await loadShard(token, month);
        shards.set(month, shard);
      }
      return shard;
    };

    const errors: BatchResult["errors"] = [];
    const planned: { item: BatchItem; record: PhotoRecord; fileName: string }[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.id)) {
        errors.push({ id: item.id, error: "Listed twice in one request." });
        continue;
      }
      seen.add(item.id);
      const record = (await shardFor(item.month)).photos[item.id];
      const outcome = plan(record, item);
      if ("error" in outcome) errors.push({ id: item.id, error: outcome.error });
      else planned.push({ item, record: record!, fileName: outcome.fileName });
    }

    // OneDrive first. If the archive were written first and a rename then
    // failed, the next scan would read the old name and quietly undo it.
    const renamed: typeof planned = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < planned.length) {
        const entry = planned[cursor++];
        try {
          await renamePhoto(token, entry.item.id, entry.fileName);
          renamed.push(entry);
        } catch (err) {
          errors.push({ id: entry.item.id, error: (err as Error).message });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(RENAME_CONCURRENCY, planned.length) }, worker));

    if (renamed.length === 0) return { results: [], errors, months: [] };

    const results: SetTakenAtResult[] = [];
    const touched = new Set<string>();
    for (const { item, record, fileName } of renamed) {
      const takenAt = new Date(`${item.date}T${item.time ?? "00:00"}:00Z`).toISOString();
      const updated: PhotoRecord = {
        ...record,
        fileName,
        takenAt,
        dateSource: item.time ? "filename" : "filename-date",
        // Untimed stays suspect: a date with no clock is a real date and a
        // fabricated midnight, which is exactly what the flag means.
        timeSuspect: !item.time,
      };

      // Shards are keyed by capture month, so a photo moved across one moves
      // between files.
      const targetMonth = item.date.slice(0, 7);
      const months = [item.month];
      if (targetMonth !== item.month) {
        delete (await shardFor(item.month)).photos[item.id];
        months.push(targetMonth);
      }
      (await shardFor(targetMonth)).photos[item.id] = updated;
      for (const m of months) touched.add(m);

      results.push({ id: item.id, fileName, takenAt, dateSource: updated.dateSource, timeSuspect: updated.timeSuspect, months });
    }

    // Summaries rebuilt from the shards themselves rather than adjusted by
    // hand, so a count cannot drift.
    const index = await loadIndex(token);
    const before = JSON.stringify(index.months);
    for (const month of touched) {
      const shard = shards.get(month)!;
      // Duplicate groups are per shard and derived, as in scan. A group's
      // representative moved to another month left its copies here pointing
      // at a photo that was gone, and `analysisTargets` then skipped every one
      // of them until the next scan; a new time can also change a burst.
      assignDuplicates(Object.values(shard.photos));
      await saveShard(token, shard);
      index.months = upsertMonth(index.months, summarize(shard));
    }
    // Only when it actually changed. A time correction inside one month moves
    // no counts, so the summary is usually identical and the 3.4MB upload
    // would be for nothing.
    if (JSON.stringify(index.months) !== before) await saveIndex(token, index);

    return { results, errors, months: [...touched].sort() };
  });
}

/** One photo: the batch of one, failing loudly rather than reporting. */
export async function setPhotoTakenAt(id: string, req: SetTakenAtRequest): Promise<SetTakenAtResult> {
  const { results, errors } = await setPhotosTakenAt([{ id, ...req }]);
  if (errors.length) throw new Error(errors[0].error);
  return results[0];
}
