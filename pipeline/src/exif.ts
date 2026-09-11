import exifr from "exifr";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { GeoPoint, NearPlace } from "@travel-archive/shared";
import { dataDir, dataFile } from "./paths.js";

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

/**
 * Reverse geocoding via Nominatim (OpenStreetMap): free, no key, one request a
 * second by its usage policy — set GEOCODE_CONTACT_EMAIL so they can reach you.
 *
 * Two zooms, for two jobs. `zoom=10` gives the town, which is `place` and what
 * days and the trip map group by. `zoom=18` gives the nearest mapped object,
 * which is what can *name* a photo: measured on twelve named stops, it hit the
 * venue for five (Bratislavský hrad, the Deutsches Museum's shop, the café in
 * the Neues Museum, a Köln-Ehrenfeld platform, Seefeld station) and a nearby
 * street for the rest — once a waste basket beside Fulda Cathedral, which is
 * why only real venues count as one (`venueOf`).
 *
 * **Cached on disk** per ~100m cell and zoom. It used to be an in-memory map,
 * so every run started from nothing; a whole-library pass is ~3,500 cells a
 * zoom, about an hour each at the permitted rate, and should be paid once.
 * Failed requests are not cached, so they are retried next time.
 */
const CACHE_PATH = dataFile("geocode-cache.json");
const THROTTLE_MS = 1100;
const SAVE_EVERY = 25;

interface NominatimResult {
  name?: string;
  category?: string;
  type?: string;
  address?: Record<string, string>;
}

let cache: Map<string, NominatimResult | null> | null = null;
let unsaved = 0;
let lastRequestAt = 0;

async function loadCache(): Promise<Map<string, NominatimResult | null>> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await readFile(CACHE_PATH, "utf-8")) as Record<string, NominatimResult | null>;
    cache = new Map(Object.entries(raw));
  } catch {
    cache = new Map();
  }
  return cache;
}

/** Writes the cache if anything new was looked up. Called after every batch of lookups. */
export async function flushGeocodeCache(): Promise<void> {
  if (!cache || unsaved === 0) return;
  await mkdir(dataDir(), { recursive: true });
  // Written aside and renamed, so a crash mid-write cannot leave half a file
  // and throw away hours of lookups.
  const tmp = `${CACHE_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(Object.fromEntries(cache)), "utf-8");
  await rename(tmp, CACHE_PATH);
  unsaved = 0;
}

/**
 * One lookup, cached, and never faster than the policy allows. The gate is
 * shared by both zooms, since the limit is per client, not per kind of request.
 * Throws when Nominatim cannot be reached or refuses, so a caller can tell
 * "nothing there" from "did not find out".
 */
async function lookup(gps: GeoPoint, zoom: 10 | 18, contactEmail: string): Promise<NominatimResult | null> {
  const store = await loadCache();
  const key = `z${zoom}:${gps.lat.toFixed(3)},${gps.lon.toFixed(3)}`;
  if (store.has(key)) return store.get(key)!;

  const wait = lastRequestAt + THROTTLE_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();

  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(gps.lat));
  url.searchParams.set("lon", String(gps.lon));
  url.searchParams.set("zoom", String(zoom));
  const res = await fetch(url, {
    headers: { "User-Agent": `travel-archive/0.1 (${contactEmail || "no-contact-set"})` },
  });
  if (!res.ok) throw new Error(`Nominatim ${res.status} ${res.statusText}`);

  // An empty answer ("Unable to geocode" — open sea, say) is a real answer.
  const body = (await res.json()) as NominatimResult & { error?: string };
  const result = body.error ? null : { name: body.name, category: body.category, type: body.type, address: body.address };
  store.set(key, result);
  if (++unsaved >= SAVE_EVERY) await flushGeocodeCache();
  return result;
}

/** The town and country, e.g. "a city, Österreich". Null when there is none, or the lookup failed. */
export async function reverseGeocode(gps: GeoPoint, contactEmail: string): Promise<string | null> {
  try {
    const a = (await lookup(gps, 10, contactEmail))?.address ?? {};
    const locality = a.city ?? a.town ?? a.village ?? a.county ?? null;
    return [locality, a.country].filter(Boolean).join(", ") || null;
  } catch {
    return null;
  }
}

/**
 * Kinds of map object that name a place a photograph could be *of*. Anything
 * else near the coordinates — a road, a bench, a waste basket — is not a venue,
 * and offering it as one invites a caption about a waste basket.
 */
const VENUE_CATEGORIES = new Set([
  "tourism", "historic", "leisure", "amenity", "railway", "aeroway", "building", "shop",
  "public_transport", "natural", "waterway", "man_made", "place", "office", "craft",
]);
const NOT_A_VENUE = new Set([
  "waste_basket", "waste_disposal", "recycling", "bench", "toilets", "post_box", "vending_machine",
  "telephone", "drinking_water", "atm", "charging_station", "clock", "grit_bin", "parking",
  "parking_space", "parking_entrance", "bicycle_parking", "motorcycle_parking",
  "rail", "level_crossing", "crossing", "switch", "signal", "buffer_stop",
  "house", "postcode", "plot",
]);

function venueOf(result: NominatimResult): string | null {
  if (!result.name?.trim()) return null;
  if (!VENUE_CATEGORIES.has(result.category ?? "") || NOT_A_VENUE.has(result.type ?? "")) return null;
  return result.name.trim();
}

/**
 * The street-level place for a photo: the nearest named venue if there is one,
 * and the street. Throws when the lookup fails, so the caller leaves `near`
 * unset and tries again next run rather than recording that nothing is there.
 */
export async function nearPlace(gps: GeoPoint, contactEmail: string): Promise<NearPlace | null> {
  const result = await lookup(gps, 18, contactEmail);
  if (!result) return null;
  const a = result.address ?? {};
  const road = a.road ?? a.pedestrian ?? a.footway ?? a.square ?? null;
  const district = a.suburb ?? a.neighbourhood ?? a.quarter ?? a.city_district ?? null;
  const venue = venueOf(result);
  const street = [road, district].filter(Boolean).join(", ") || null;
  return venue || street ? { venue, street } : null;
}
