/**
 * The day each described screenshot belongs to.
 *
 * A description says what *kind* of screen a photograph is. The day says when
 * it happened, and the day is what makes a description findable: the search
 * index is built by day, so a description with no date cannot be grouped under
 * one and does not come up in a search at all — it is shown on its
 * photograph's page and nowhere else.
 *
 * The date is not in the description because the description is written by a
 * model that was shown one picture and nothing else. It is in the
 * photograph's own record, in the month shard. So filling it in means walking
 * the shards once and matching ids: 2,352 lookups against 123 files, and
 * nothing else.
 *
 * This is a repair rather than a job. It writes the file it read, under the
 * same passphrase, with the same descriptions — it adds one field and leaves
 * everything else alone — and running it twice changes nothing the second
 * time. It exists because the descriptions were written before the field was,
 * and without it the descriptions already in the archive are the ones a search
 * cannot find.
 */
import { loadIndexForReading, readShardMirror } from "../archiveStore.js";
import { loadScreenCaptions, saveScreenCaptions } from "../screenCaptions.js";
import type { ProgressFn } from "./analyze.js";

export interface ScreenDatesResult {
  /** How many descriptions were given their day. */
  filled: number;
  /** How many descriptions there are in all. */
  total: number;
  /** How many months were read. */
  months: number;
  /** How many descriptions name a photograph this machine has no record of. */
  unmatched: number;
}

/**
 * Fill in the missing days, and save the file if anything changed.
 *
 * The shards come from the **mirror**, never from OneDrive: this is a lookup
 * over the whole library, and 123 sequential downloads would cost a minute and
 * a good chance of a 429 for data this machine has already written down. A
 * month the mirror does not have is a month this machine has never seen, so
 * its photographs are not the ones being looked for.
 */
export async function backfillScreenDates(token: string, onProgress?: ProgressFn): Promise<ScreenDatesResult> {
  const file = await loadScreenCaptions(token);
  const entries = Object.entries(file.entries);
  const wanted = new Set(entries.filter(([, entry]) => !entry.date).map(([id]) => id));
  if (wanted.size === 0) return { filled: 0, total: entries.length, months: 0, unmatched: 0 };

  const index = await loadIndexForReading(token);
  let filled = 0;
  for (const [i, summary] of index.months.entries()) {
    if (wanted.size === 0) break;
    onProgress?.({ phase: "loading", message: `Reading ${summary.month} (${i + 1}/${index.months.length})...` });
    const shard = await readShardMirror(summary.month);
    if (!shard) continue;
    for (const photo of Object.values(shard.photos)) {
      if (!wanted.has(photo.id)) continue;
      const entry = file.entries[photo.id];
      if (!entry || entry.date) continue;
      const date = photo.takenAt?.slice(0, 10) ?? null;
      if (!date) continue;
      entry.date = date;
      wanted.delete(photo.id);
      filled += 1;
    }
  }

  if (filled > 0) {
    onProgress?.({ phase: "saving", message: "Saving descriptions..." });
    await saveScreenCaptions(token, file);
  }
  return { filled, total: entries.length, months: index.months.length, unmatched: wanted.size };
}
