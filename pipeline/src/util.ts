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
 * Pulls a capture date out of a filename. Returns an ISO string, or null if
 * the filename doesn't contain a valid-looking date. The time portion is
 * optional — a date alone is still enough to file the photo on the right day,
 * which is all the album needs.
 */
export function parseDateFromFileName(fileName: string): string | null {
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

  return date.toISOString();
}
