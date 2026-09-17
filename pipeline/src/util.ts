import type { ImageMediaType } from "./providers/types.js";

const MEDIA_TYPE_BY_EXT: Record<string, ImageMediaType> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function mediaTypeFor(fileName: string): ImageMediaType {
  const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  return MEDIA_TYPE_BY_EXT[ext] ?? "image/jpeg";
}

export function dayKey(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "unknown-date";
}

export function monthKey(iso: string | null): string | null {
  return iso ? iso.slice(0, 7) : null;
}

export function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((id, i) => id === sb[i]);
}

/** "2024-04" -> "April 2024" */
export function formatMonthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

// Covers the shapes phone cameras and screenshot tools actually produce:
// IMG_20250412_143022, PXL_20250412_143022123, 20250412_143022,
// Screenshot_2025-04-12-14-30-22, "2025-04-12 14.30.22". Deliberately loose
// on separators and anchored on a plausible year so it doesn't latch onto
// arbitrary digit runs.
const FILENAME_DATE = /(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?:[-_.T ]?(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2}))?/;

/**
 * Pulls a capture date out of a filename.
 *
 * `hasTime` says whether the name actually carried a clock time, because when
 * it does not the returned ISO string reads `T00:00:00Z` — a real-looking
 * midnight that nothing invented. WhatsApp saves (`IMG-20260907-WA0012.jpg`)
 * are the common case: 138 photos in this archive carry that fabricated
 * midnight, it renders as "01:00" once a UTC+1 viewer formats it, and
 * `stops.ts` splits the day on it as though the day genuinely began there.
 * Callers must know the difference; see `takenAtOf` in graph.ts.
 */
/**
 * Rewrites the timestamp a filename carries, leaving everything else alone.
 *
 * This is how a photo is given a day, and a time within it. For a WhatsApp save
 * the filename *is* the timestamp — those files carry no EXIF, so `takenAtOf`
 * falls back to the name — which means renaming the file in OneDrive genuinely
 * moves the photo, through the ordinary scan path, with no override field on
 * the record to keep in step with it.
 *
 * Writing a time matters as much as the date. A name carrying a date alone
 * parses as `filename-date`, which is `timeSuspect` and lands the photo at
 * midnight, where `stops.ts` refuses to place it in the day and appends it to
 * the last stop instead. A name carrying both parses as `filename`, with a real
 * position in the day.
 *
 * Only the first timestamp run is touched and its separators are preserved:
 * `IMG-20260907-WA0012.jpg` with 14:00 becomes `IMG-20260906-140000-WA0012.jpg`,
 * which `parseDateFromFileName` reads straight back. Null when the name carries
 * no date at all — there is nothing to rewrite, and inventing a place to put one
 * risks a name the scanner reads differently.
 */
export function renameForTakenAt(fileName: string, date: string, time: string | null): string | null {
  const target = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!target) return null;
  const [, year, month, day] = target;

  const clock = time ? /^(\d{2}):(\d{2})$/.exec(time) : null;
  if (time && !clock) return null;
  const stamp = clock ? `${clock[1]}${clock[2]}00` : null;

  // Same shape as FILENAME_DATE, so whatever that would have matched is what
  // gets rewritten — the two must not disagree about which run is the date.
  const RUN = /(20\d{2})([-_.]?)(\d{2})([-_.]?)(\d{2})(?:([-_.T ]?)(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2}))?/;
  const match = RUN.exec(fileName);
  if (!match) return null;

  const [whole, , sepA, , sepB, , timeSep] = match;
  let replacement = `${year}${sepA}${month}${sepB}${day}`;
  if (stamp) {
    // Reuse the separator that already sat before the time; when the name had
    // no time, borrow whatever follows the date so the result reads like the
    // names this library already contains.
    const after = fileName.slice(match.index + whole.length);
    replacement += `${timeSep || (after[0] && /[-_.]/.test(after[0]) ? after[0] : "_")}${stamp}`;
  }

  return fileName.slice(0, match.index) + replacement + fileName.slice(match.index + whole.length);
}

/**
 * A dropped or refused connection, rather than an answer from the server.
 *
 * Worth telling apart from every other failure: it is the one kind a later
 * attempt, unchanged, may simply succeed at. On a mobile link it is also the
 * common one — on 2026-09-17 a single ECONNRESET mid-download killed the job
 * server outright, losing an hour of collecting.
 */
export function isNetworkError(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string }; message?: string };
  const code = e?.code ?? e?.cause?.code ?? "";
  return (
    /^(ECONNRESET|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ECONNREFUSED|UND_ERR_[A-Z_]+)$/.test(code) ||
    /fetch failed|socket hang up|network|timed? ?out|terminated/i.test(e?.message ?? "")
  );
}

export function parseDateFromFileName(fileName: string): { iso: string; hasTime: boolean } | null {
  const match = FILENAME_DATE.exec(fileName);
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);

  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (y > new Date().getFullYear() + 1) return null;

  const date = new Date(Date.UTC(y, mo - 1, d, Number(hour ?? 0), Number(minute ?? 0), Number(second ?? 0)));
  // Rejects things like 2025-02-31, which the constructor would silently roll over.
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;

  return { iso: date.toISOString(), hasTime: hour !== undefined };
}
