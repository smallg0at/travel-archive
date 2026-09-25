import { readFile } from "node:fs/promises";
import { dataFile } from "./paths.js";

/**
 * A size check before an archive file is overwritten.
 *
 * The failure this exists for is not a corrupt write — `saveIndex` and
 * `saveShard` write locally and then upload, so a crash leaves the older copy
 * cloud-side and the local mirror is merely behind. It is a **systematically
 * smaller** write: a bug that builds an index from the wrong input, a run that
 * swept the shards while the mirror was half-populated, a `--force` pointed at
 * something that had already been emptied. The old file is replaced wholesale by
 * one that is valid, readable and contains a fraction of what it held, and
 * nothing reports it because nothing is broken at the file level.
 *
 * The check is deliberately crude — **compare the count, refuse the drop, ask a
 * person** — because that is the layer of the problem it sits at. It is a
 * circuit breaker, not a validator: it cannot tell a correct shrink (the owner
 * really did delete a year) from a broken one, and it does not try. Both stop,
 * and the one that was intentional is let through by the person it belongs to.
 *
 * The hardware analogy is exact. A RAID controller that keeps serving after the
 * second disk drops is doing nothing wrong per disk; it is the *assembled state*
 * that has stopped being trustworthy, and only the controller can see that.
 */

/** Below this many records nothing is worth guarding: the early archive is small. */
const MIN_RECORDS = 50;

/**
 * How much smaller is "something went wrong". A tenth is well outside any
 * legitimate edit — a month of deleted photos is nowhere near it — and well
 * inside the kind of loss this is looking for.
 */
const ALLOWED_DROP = 0.1;

export interface SizeCheck {
  before: number;
  after: number;
}

/** Thrown when a write would remove more than `ALLOWED_DROP` of the records. */
export class ShrinkRefused extends Error {
  constructor(
    readonly file: string,
    readonly check: SizeCheck,
  ) {
    const lost = check.before - check.after;
    super(
      `Refusing to overwrite ${file}: it would drop from ${check.before} to ${check.after} records ` +
        `(a loss of ${lost}, ${Math.round((lost / check.before) * 100)}%). ` +
        `This is almost always a bug, not an edit — the previous file is untouched. ` +
        `If the shrink is intended, run with ALLOW_SHRINK=1.`,
    );
  }
}

/** Whether the owner has said, for this run, that a large drop is expected. */
export function shrinkAllowed(): boolean {
  return process.env.ALLOW_SHRINK === "1";
}

/**
 * Throws when `after` is much smaller than what is already on disk.
 *
 * The file is read rather than remembered: the caller may not be the process
 * that wrote it, and the mirror is the only copy that matters here. A file that
 * does not exist yet is a first write and nothing to compare against.
 */
export async function assertNotShrinking(fileName: string, after: number, count: (raw: unknown) => number): Promise<void> {
  if (shrinkAllowed()) return;

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(dataFile(fileName), "utf-8"));
  } catch {
    // No previous copy, or unreadable: nothing to protect.
    return;
  }

  const before = count(raw);
  if (before < MIN_RECORDS) return;
  if (after >= before * (1 - ALLOWED_DROP)) return;

  throw new ShrinkRefused(fileName, { before, after });
}

/** Records in an `index.json`: photos across every month. */
export const indexRecords = (raw: unknown): number => {
  const months = (raw as { months?: { photoCount?: number }[] }).months ?? [];
  return months.reduce((n, m) => n + (m.photoCount ?? 0), 0);
};

/** Records in a `photos/<month>.json`. */
export const shardRecords = (raw: unknown): number => {
  const photos = (raw as { photos?: Record<string, unknown> }).photos ?? {};
  return Object.keys(photos).length;
};
