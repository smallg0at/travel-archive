/**
 * Builds data/geo/countries.geo.json — country outlines the offline geocoder
 * uses to ask which country a point is in.
 *
 *   node pipeline/scripts/build-country-polygons.mjs <ne_10m_admin_0_countries_chn.geojson>
 *
 * The input is Natural Earth's China-worldview admin-0 file (public domain,
 * github.com/nvkelso/natural-earth-vector/geojson), so the border at Changbai
 * Mountain and the treatment of Taiwan match the basemap's. Output is
 * `[{ cc, bbox, polys }]` with coordinates at 3 decimals (~100m).
 */
import { readFileSync, writeFileSync } from "node:fs";

const src = process.argv[2];
if (!src) throw new Error("usage: build-country-polygons.mjs <countries_chn.geojson>");
const out = new URL("../data/geo/countries.geo.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const q = (p) => [Number(p[0].toFixed(3)), Number(p[1].toFixed(3))];
const result = [];
for (const f of JSON.parse(readFileSync(src, "utf8")).features) {
  const cc = f.properties.ISO_A2_EH;
  if (!/^[A-Z]{2}$/.test(cc)) continue; // disputed slivers with no ISO code
  const polys = (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates).map((poly) =>
    poly.map((ring) => ring.map(q)),
  );
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of polys) for (const [x, y] of poly[0]) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  result.push({ cc, bbox: [minX, minY, maxX, maxY], polys });
}
const json = JSON.stringify(result);
writeFileSync(out, json);
console.log(`${result.length} countries, ${(json.length / 1024 / 1024).toFixed(1)} MB → ${out}`);
