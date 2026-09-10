import type { MonthSummary, PhotoRecord } from "@travel-archive/shared";
import { loadIndex, loadShard, saveIndex, saveShard } from "../archiveStore.js";
import { getAccessToken } from "../auth.js";
import { renamePhoto } from "../graph.js";
import { withArchiveLock } from "../lock.js";
import { renameForTakenAt } from "../util.js";
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

function upsertMonth(months: MonthSummary[], summary: MonthSummary): MonthSummary[] {
  const next = months.filter((m) => m.month !== summary.month);
  // A month emptied by the move disappears rather than lingering with a count
  // for photos that are no longer in it — the ghost-month bug, in miniature.
  if (summary.photoCount > 0) next.push(summary);
  return next.sort((a, b) => a.month.localeCompare(b.month));
}

export async function setPhotoTakenAt(id: string, req: SetTakenAtRequest): Promise<SetTakenAtResult> {
  return withArchiveLock("set photo time", async () => {
    const token = await getAccessToken();
    const source = await loadShard(token, req.month);
    const record = source.photos[id];
    if (!record) throw new Error(`No photo ${id} in ${req.month}.`);

    // EXIF wins in `takenAtOf`, so renaming such a photo changes the name and
    // moves nothing. Refusing is the honest answer; silently renaming would
    // leave a file whose name disagrees with the archive forever.
    if (record.dateSource === "exif") {
      throw new Error(
        `${record.fileName} takes its date from EXIF, which outranks the filename — renaming it would not move the photo.`,
      );
    }

    const fileName = renameForTakenAt(record.fileName, req.date, req.time);
    if (!fileName) {
      throw new Error(`${record.fileName} carries no date to rewrite, so there is nothing a rename can change.`);
    }
    if (fileName === record.fileName) {
      throw new Error(`${record.fileName} already says ${req.date}${req.time ? ` ${req.time}` : ""}.`);
    }

    // OneDrive first. If the archive were written first and the rename then
    // failed, the next scan would read the old name and quietly undo it.
    await renamePhoto(token, id, fileName);

    const takenAt = new Date(`${req.date}T${req.time ?? "00:00"}:00Z`).toISOString();
    const updated: PhotoRecord = {
      ...record,
      fileName,
      takenAt,
      dateSource: req.time ? "filename" : "filename-date",
      // Untimed stays suspect: a date with no clock is a real date and a
      // fabricated midnight, which is exactly what the flag means.
      timeSuspect: !req.time,
    };

    const targetMonth = req.date.slice(0, 7);
    const index = await loadIndex(token);
    const months = [req.month];
    const before = JSON.stringify(index.months);

    if (targetMonth === req.month) {
      source.photos[id] = updated;
      await saveShard(token, source);
      index.months = upsertMonth(index.months, summarize(source));
    } else {
      // Shards are keyed by capture month, so a photo moved across one moves
      // between files. Both summaries are rebuilt from the shards themselves
      // rather than adjusted by hand, so a count cannot drift.
      const target = await loadShard(token, targetMonth);
      delete source.photos[id];
      target.photos[id] = updated;
      await saveShard(token, source);
      await saveShard(token, target);
      index.months = upsertMonth(upsertMonth(index.months, summarize(source)), summarize(target));
      months.push(targetMonth);
    }

    // Only when it actually changed. A time correction inside one month moves
    // no counts — `photoCount`, `analyzedCount` and `representativeCount` are
    // all unaffected — so the summary is usually identical, and writing it
    // anyway uploaded 3.4MB of index.json for every photo. Measured at 6.5-8.7
    // seconds a photo against a library with 118 still to correct, which is the
    // difference between a batch job and an evening.
    if (JSON.stringify(index.months) !== before) await saveIndex(token, index);

    return {
      id,
      fileName,
      takenAt,
      dateSource: updated.dateSource,
      timeSuspect: updated.timeSuspect,
      months,
    };
  });
}
