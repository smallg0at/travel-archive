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
