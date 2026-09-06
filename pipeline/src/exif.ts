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

const geocodeCache = new Map<string, string | null>();

/**
 * Reverse-geocodes via Nominatim (OpenStreetMap), free and no API key.
 * Results are cached per ~100m grid cell, and each *new* lookup is
 * throttled to respect Nominatim's 1 req/sec usage policy — set
 * GEOCODE_CONTACT_EMAIL so they can reach you if something's misbehaving.
 */
export async function reverseGeocode(gps: GeoPoint, contactEmail: string): Promise<string | null> {
  const key = `${gps.lat.toFixed(3)},${gps.lon.toFixed(3)}`;
  if (geocodeCache.has(key)) return geocodeCache.get(key)!;

  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(gps.lat));
  url.searchParams.set("lon", String(gps.lon));
  url.searchParams.set("zoom", "10");

  const res = await fetch(url, {
    headers: { "User-Agent": `travel-archive/0.1 (${contactEmail || "no-contact-set"})` },
  });

  let place: string | null = null;
  if (res.ok) {
    const body = (await res.json()) as { address?: Record<string, string> };
    const a = body.address ?? {};
    const locality = a.city ?? a.town ?? a.village ?? a.county ?? null;
    place = [locality, a.country].filter(Boolean).join(", ") || null;
  }

  geocodeCache.set(key, place);
  await new Promise((r) => setTimeout(r, 1100));
  return place;
}
