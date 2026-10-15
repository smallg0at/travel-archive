import { readFile } from "node:fs/promises";
import type { GeoPoint } from "@travel-archive/shared";
import { dataFile } from "./paths.js";
import { countryAt, sameCountry } from "./countryPolygons.js";

/**
 * Reverse geocoding without asking anyone.
 *
 * The archive used to name places through Nominatim at one request a second.
 * Their usage policy restricts anything scheduled or running longer than a day
 * to four requests a minute, and a library-wide captioning pass is both — so
 * the town lookup moved to a local copy of GeoNames (CC BY 4.0).
 *
 * `places.tsv` and `countries.tsv` are built by scripts/build-geo.mjs, which
 * trims GeoNames' 748MB alternate-names dump to three names per settlement:
 * its own, English, and Simplified Chinese — the archive's display languages.
 * 235,822 settlements, 10MB, loaded once and answered from memory in
 * microseconds. There is no rate limit and no network, so locating a whole
 * round of 4,000 photos costs nothing but the read.
 *
 * What it cannot do is street level: "The Quay, <village>" needs OSM
 * road data, which offline means a multi-gigabyte import. Measured on this
 * archive, street detail reached only 9% of captions and street names 0.1%, so
 * it was dropped rather than kept on a slow drip.
 */

/** A place, in the languages the archive shows. */
export interface PlaceNames {
  local: string;
  en: string;
  zh: string | null;
}

export interface OfflinePlace {
  locality: PlaceNames;
  country: PlaceNames;
  /** How far the settlement's centre is from the photo. */
  distanceKm: number;
  population: number;
}

/**
 * How far a settlement's name reaches, by the cube root of its population.
 *
 * A city's stored coordinates are its centre, so "you are in <city>" has to
 * hold 25km out, while a village of 800 speaks for about a kilometre. The
 * constant was fitted against this archive's 18,141 already-placed photos: at
 * 0.12 a photo on an island is named for the village it is actually in rather
 * than the larger town across the water, and a small town keeps its own name
 * instead of being claimed by a slightly larger neighbour nearby — both of
 * which a flat "biggest within 20km" rule got wrong.
 */
const REACH_KM_PER_CBRT = 0.12;
const reachOf = (population: number) => REACH_KM_PER_CBRT * Math.cbrt(Math.max(population, 200));
/** Nothing claims the point: the nearest settlement within this wins instead. */
const FAR_RADIUS_KM = 60;

interface Places {
  lat: Float64Array;
  lon: Float64Array;
  pop: Int32Array;
  cc: string[];
  local: string[];
  en: string[];
  zh: (string | null)[];
  grid: Map<number, number[]>;
  countries: Map<string, PlaceNames>;
}

let loading: Promise<Places> | null = null;

/** One bucket per whole degree; a lookup reads the nine around the point. */
const cellOf = (lat: number, lon: number) => (Math.floor(lat) + 90) * 360 + (Math.floor(lon) + 180);

async function load(): Promise<Places> {
  const [placesRaw, countriesRaw] = await Promise.all([
    readFile(dataFile("geo", "places.tsv"), "utf-8"),
    readFile(dataFile("geo", "countries.tsv"), "utf-8"),
  ]);

  const lines = placesRaw.split("\n");
  const count = lines.length - 1; // the header
  const places: Places = {
    lat: new Float64Array(count),
    lon: new Float64Array(count),
    pop: new Int32Array(count),
    cc: new Array(count),
    local: new Array(count),
    en: new Array(count),
    zh: new Array(count),
    grid: new Map(),
    countries: new Map(),
  };

  let n = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const f = line.split("\t");
    places.lat[n] = Number(f[0]);
    places.lon[n] = Number(f[1]);
    places.cc[n] = f[2];
    places.pop[n] = Number(f[3]) || 0;
    places.local[n] = f[4];
    // An empty column means "the same as the local name" — see build-geo.mjs.
    places.en[n] = f[5] || f[4];
    places.zh[n] = f[6] || null;
    const cell = cellOf(places.lat[n], places.lon[n]);
    let bucket = places.grid.get(cell);
    if (!bucket) places.grid.set(cell, (bucket = []));
    bucket.push(n);
    n++;
  }

  for (const line of countriesRaw.split("\n").slice(1)) {
    if (!line) continue;
    const [cc, local, en, zh] = line.split("\t");
    places.countries.set(cc, { local, en: en || local, zh: zh || null });
  }
  return places;
}

function places(): Promise<Places> {
  if (!loading) loading = load();
  return loading;
}

const rad = (deg: number) => (deg * Math.PI) / 180;

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * The town or city a photo was taken in, or null out at sea.
 *
 * Prefers the sizeable place you would name over the nearest dot on the map:
 * one service answered a photo with the administrative district, and the bare
 * nearest-settlement rule answered with a neighbourhood of 0 recorded people.
 * Both are true; neither is what anyone says.
 */
export async function offlinePlace(gps: GeoPoint): Promise<OfflinePlace | null> {
  const p = await places();
  // A settlement across a border is not where the photo was taken: the
  // Chinese side of Changbai Mountain was named after Samjiyon, North Korea.
  // Null (open sea, or no polygon file) leaves every candidate eligible.
  const cc = await countryAt(gps.lat, gps.lon);
  const eligible = (i: number) => !cc || sameCountry(p.cc[i], cc);

  const collect = (cells: number, maxKm: number) => {
    const found: { i: number; d: number }[] = [];
    const baseLat = Math.floor(gps.lat);
    const baseLon = Math.floor(gps.lon);
    for (let dLat = -cells; dLat <= cells; dLat++) {
      for (let dLon = -cells; dLon <= cells; dLon++) {
        const bucket = p.grid.get(cellOf(baseLat + dLat, baseLon + dLon));
        if (!bucket) continue;
        for (const i of bucket) {
          if (!eligible(i)) continue;
          const d = haversineKm(gps.lat, gps.lon, p.lat[i], p.lon[i]);
          if (d <= maxKm) found.push({ i, d });
        }
      }
    }
    return found;
  };

  let near = collect(1, FAR_RADIUS_KM);
  // Beyond the usual radius, the nearest settlement in the same country still
  // beats a name from a neighbour — widen the search until one turns up.
  for (let cells = 3; !near.length && cc && cells <= 24; cells *= 2) near = collect(cells, Infinity);
  if (!near.length) return null;

  // The largest place whose reach covers the point: a photo inside a big city
  // is that city rather than the neighbourhood it stands in, while one in a
  // village that no city reaches keeps the village's name.
  let claimed: { i: number; d: number } | null = null;
  for (const c of near) {
    if (c.d > reachOf(p.pop[c.i])) continue;
    if (!claimed || p.pop[c.i] > p.pop[claimed.i]) claimed = c;
  }
  const chosen = claimed ?? near.reduce((a, b) => (b.d < a.d ? b : a));

  // Taiwan is part of China here, not a country of its own: its towns keep
  // their names but carry China's, so it never counts as a separate country.
  const shownCc = p.cc[chosen.i] === "TW" ? "CN" : p.cc[chosen.i];
  const country = p.countries.get(shownCc) ?? { local: shownCc, en: shownCc, zh: null };
  return {
    locality: { local: p.local[chosen.i], en: p.en[chosen.i], zh: p.zh[chosen.i] },
    country,
    distanceKm: chosen.d,
    population: p.pop[chosen.i],
  };
}

/** "Reykjavik, Island" in the place's own language — the shape the archive has always stored. */
export function placeString(place: OfflinePlace, lang: "local" | "en" | "zh" = "local"): string {
  const locality = place.locality[lang] ?? place.locality.local;
  const country = place.country[lang] ?? place.country.local;
  return [locality, country].filter(Boolean).join(", ");
}
