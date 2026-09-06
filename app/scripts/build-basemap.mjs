/**
 * Turns Natural Earth 50m shapefiles into the one compact basemap the app ships.
 *
 *   node app/scripts/build-basemap.mjs --src <dir> [--rivers N] [--places N]
 *
 * Places carry `[name, lon, lat, scalerank]`.
 *
 * `--src` holds the *extracted* contents of Natural Earth's `50m_physical.zip`
 * and `50m_cultural.zip` (naturalearthdata.com, public domain). They are not in
 * the repo — this runs once and its output, app/src/geo/basemap.json, is what
 * ships.
 *
 * Defaults to **50m**. The app serves locally, so file size is not the binding
 * constraint — SVG node count is, and the renderer culls to the viewport (see
 * ../src/geo/README.md for the measurements). `--scale 110m` produces a file a
 * tenth the size if that ever matters.
 *
 * Emits bare coordinate arrays rather than GeoJSON: at this size the Feature
 * scaffolding is a real share of the bytes, and nothing here needs to be valid
 * GeoJSON.
 */
import { open } from "shapefile";
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const SRC = arg("src", ".");
const PHYS = arg("physical", `${SRC}/ne50m`);
const CULT = arg("cultural", `${SRC}/ne50c`);
/** Natural Earth names every file after its scale, so the layers follow --scale. */
const S = arg("scale", "50m");
const P = Number(arg("precision", 3));
const RIVER_RANK = Number(arg("rivers", 5));
const PLACE_RANK = Number(arg("places", 9));
const LAKE_RANK = Number(arg("lakes", 9));
const OUT = arg("out", new URL("../src/geo/basemap.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

/** Natural Earth's scalerank 0 is the MOST prominent tier, so `?? 99` — never `|| 99`. */
const rank = (props, keys) => {
  for (const k of keys) if (props[k] !== undefined && props[k] !== null) return Number(props[k]);
  return 99;
};

function quantise(ring) {
  const out = [];
  for (const [lon, lat] of ring) {
    const q = [Number(lon.toFixed(P)), Number(lat.toFixed(P))];
    if (!out.length || q[0] !== out[out.length - 1][0] || q[1] !== out[out.length - 1][1]) out.push(q);
  }
  return out;
}

async function read(dir, name, onFeature) {
  // Natural Earth's DBFs are UTF-8 (each ships a .cpg saying so) but the reader
  // defaults to Latin-1, which turns "Besançon" into "BesanÃ§on" — 71 of 1,244
  // place names on the first build.
  const source = await open(`${dir}/${name}.shp`, `${dir}/${name}.dbf`, { encoding: "utf-8" });
  for (let r = await source.read(); !r.done; r = await source.read()) onFeature(r.value);
}

/** Outer rings only — lake islands and inland detail are invisible at this scale. */
/** Bounding-box diagonal in degrees — used to drop specks too small to see. */
function extent(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Math.hypot(maxX - minX, maxY - minY);
}

function polygons(geometry, sink, minExtent = 0) {
  if (!geometry) return;
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  for (const poly of polys) {
    if (minExtent && extent(poly[0]) < minExtent) continue;
    const ring = quantise(poly[0]);
    if (ring.length >= 4) sink.push(ring);
  }
}

function lines(geometry, sink) {
  if (!geometry) return;
  const parts = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
  for (const part of parts) {
    const line = quantise(part);
    if (line.length > 1) sink.push(line);
  }
}

const land = [];
const lakes = [];
const rivers = [];
const borders = [];
const places = [];

await read(PHYS, `ne_${S}_land`, (f) => polygons(f.geometry, land));
await read(PHYS, `ne_${S}_lakes`, (f) => {
  if (rank(f.properties, ["scalerank"]) <= LAKE_RANK) polygons(f.geometry, lakes);
});
await read(PHYS, `ne_${S}_rivers_lake_centerlines`, (f) => {
  if (rank(f.properties, ["scalerank"]) <= RIVER_RANK) lines(f.geometry, rivers);
});
await read(CULT, `ne_${S}_admin_0_boundary_lines_land`, (f) => lines(f.geometry, borders));
await read(CULT, `ne_${S}_populated_places_simple`, (f) => {
  const p = f.properties;
  if (rank(p, ["SCALERANK", "scalerank"]) > PLACE_RANK) return;
  const [lon, lat] = f.geometry.coordinates;
  // Rank is kept so the renderer can thin labels out as the view widens —
  // 1,244 of them at world zoom is an unreadable smear.
  places.push([p.NAME ?? p.name ?? "", Number(lon.toFixed(P)), Number(lat.toFixed(P)), rank(p, ["SCALERANK", "scalerank"])]);
});

const basemap = { land, lakes, rivers, borders, places };
const json = JSON.stringify(basemap);
writeFileSync(OUT, json);

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
for (const [k, v] of Object.entries(basemap)) {
  console.log(`  ${k.padEnd(8)} ${String(v.length).padStart(5)} → ${kb(JSON.stringify(v).length)}`);
}
console.log(`\n  total    ${kb(json.length)} raw, ${kb(gzipSync(json).length)} gzipped  → ${OUT}`);
