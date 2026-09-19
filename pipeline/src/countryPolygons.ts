import { readFile } from "node:fs/promises";
import { dataFile } from "./paths.js";

/**
 * Which country a point is in, from China-worldview outlines.
 *
 * `data/geo/countries.geo.json` is built by scripts/build-country-polygons.mjs.
 * Without it every lookup answers null and the geocoder behaves as it did
 * before country checks existed.
 */
interface Country {
  cc: string;
  bbox: [number, number, number, number];
  polys: number[][][][];
}

let loading: Promise<Country[]> | null = null;

function countries(): Promise<Country[]> {
  loading ??= readFile(dataFile("geo", "countries.geo.json"), "utf-8").then(
    (raw) => JSON.parse(raw) as Country[],
    () => [],
  );
  return loading;
}

function inRing(x: number, y: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** ISO 3166-1 alpha-2 of the country containing the point, or null at sea or without the data file. */
export async function countryAt(lat: number, lon: number): Promise<string | null> {
  for (const c of await countries()) {
    const [x0, y0, x1, y1] = c.bbox;
    if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
    for (const poly of c.polys) {
      if (inRing(lon, lat, poly[0]) && !poly.slice(1).some((h) => inRing(lon, lat, h))) return c.cc;
    }
  }
  return null;
}

/**
 * GeoNames files Taiwan, Hong Kong and Macao under their own codes while the
 * China-worldview outlines fold them into China, so compare through this.
 */
const REGION_OF: Record<string, string> = { TW: "CN", HK: "CN", MO: "CN" };
export const sameCountry = (a: string, b: string) => (REGION_OF[a] ?? a) === (REGION_OF[b] ?? b);
