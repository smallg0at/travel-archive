import exifr from "exifr";
import type { GeoPoint } from "@travel-archive/shared";

export interface ExifResult {
  takenAt: string | null;
  gps: GeoPoint | null;
}

export async function extractExif(buffer: Buffer): Promise<ExifResult> {
  const [gps, tags] = await Promise.all([
    exifr.gps(buffer).catch(() => null),
    exifr.parse(buffer, ["DateTimeOriginal", "CreateDate"]).catch(() => null),
  ]);

  const rawDate = tags?.DateTimeOriginal ?? tags?.CreateDate ?? null;

  return {
    takenAt: rawDate ? new Date(rawDate).toISOString() : null,
    gps: gps ? { lat: gps.latitude, lon: gps.longitude } : null,
  };
}

