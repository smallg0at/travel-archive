/**
 * Rewrites the basemap's `borders` layer to China's standard-map worldview.
 *
 *   node app/scripts/china-worldview.mjs --src <dir> [--diag]
 *
 * `--src` holds three Natural Earth GeoJSON files (public domain, from
 * github.com/nvkelso/natural-earth-vector/geojson), not kept in the repo:
 *   ne_10m_admin_0_countries_chn.geojson                      China-POV countries
 *   ne_50m_admin_0_countries.geojson                          default countries
 *   ne_50m_admin_0_boundary_lines_maritime_indicator_chn.geojson  nine-dash line
 *
 * What it does to app/src/geo/basemap.json:
 *  1. drops default border vertices that fall inside China-POV China (the
 *     lines that are internal under this worldview, e.g. the McMahon line);
 *  2. adds China-POV China's outline where it runs through territory the
 *     default map gives to a neighbour (South Tibet), which is the new border;
 *  3. adds the nine-dash line as dashed border lines (borders already render
 *     dashed, so the renderer needs no change).
 *
 * Taiwan needs nothing: the basemap draws land without a Taiwan Strait border.
 * Idempotent — re-running does not duplicate lines.
 */
import { readFileSync, writeFileSync } from "node:fs";

const arg = (n, f) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : f;
};
const SRC = arg("src", ".");
const OUT = arg("out", new URL("../src/geo/basemap.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const P = 3;
const load = (f) => JSON.parse(readFileSync(`${SRC}/${f}`, "utf8"));

const chn = load("ne_10m_admin_0_countries_chn.geojson");
const def = load("ne_50m_admin_0_countries.geojson");
const nine = load("ne_50m_admin_0_boundary_lines_maritime_indicator_chn.geojson");
const byA3 = (fc, a) => fc.features.find((f) => (f.properties.ADM0_A3 ?? f.properties.ADM0_A3_CN) === a).geometry;

const polysOf = (g) => (g.type === "Polygon" ? [g.coordinates] : g.coordinates);

function inRing(x, y, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function inside(x, y, g) {
  for (const poly of polysOf(g)) {
    if (!inRing(x, y, poly[0])) continue;
    if (poly.slice(1).some((h) => inRing(x, y, h))) continue;
    return true;
  }
  return false;
}
/** Inside with a margin, so points sitting on the polygon's edge do not count. */
const M = 0.03;
const deep = (x, y, g) =>
  inside(x, y, g) && inside(x + M, y, g) && inside(x - M, y, g) && inside(x, y + M, g) && inside(x, y - M, g);

const chnChina = byA3(chn, "CHN");
const defChina = byA3(def, "CHN");
const defNeighbours = ["IND", "BTN", "NPL", "PAK", "MMR"].map((a) => byA3(def, a));

if (process.argv.includes("--diag")) {
  const hits = [];
  for (let x = 72; x <= 100; x += 0.1)
    for (let y = 22; y <= 38; y += 0.1) if (inside(x, y, chnChina) && !inside(x, y, defChina)) hits.push([x, y]);
  const cell = new Map();
  for (const [x, y] of hits) {
    const k = `${Math.floor(x / 3) * 3},${Math.floor(y / 3) * 3}`;
    cell.set(k, (cell.get(k) ?? 0) + 1);
  }
  console.log("claimed-but-not-default grid cells (3° blocks: count of 0.1° samples):", [...cell]);
  process.exit(0);
}

const q = (p) => [Number(p[0].toFixed(P)), Number(p[1].toFixed(P))];
const key = (l) => JSON.stringify(l);

const basemap = JSON.parse(readFileSync(OUT, "utf8"));

// 1. Split default borders, dropping vertices now internal to China.
const kept = [];
let dropped = 0;
for (const line of basemap.borders) {
  let run = [];
  for (const p of line) {
    if (deep(p[0], p[1], chnChina)) {
      dropped++;
      if (run.length > 1) kept.push(run);
      run = [];
    } else run.push(p);
  }
  if (run.length > 1) kept.push(run);
}

// 2. China-POV outline where it runs through a default neighbour.
const added = [];
for (const poly of polysOf(chnChina)) {
  const ring = poly[0].map(q);
  const flag = ring.map((p) => defNeighbours.some((g) => deep(p[0], p[1], g)));
  for (let i = 0; i < ring.length; i++) {
    if (!flag[i]) continue;
    let s = i;
    while (flag[i + 1] && i + 1 < ring.length) i++;
    const run = ring.slice(Math.max(0, s - 1), Math.min(ring.length, i + 2));
    if (run.length > 1) added.push(run);
  }
}

// 3. Nine-dash line.
const dashes = [];
for (const f of nine.features) {
  const parts = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const part of parts) dashes.push(part.map(q));
}

const have = new Set(kept.map(key));
const fresh = [...added, ...dashes].filter((l) => !have.has(key(l)));
basemap.borders = [...kept, ...fresh];
writeFileSync(OUT, JSON.stringify(basemap));
console.log(`dropped ${dropped} vertices; kept ${kept.length} lines; added ${added.length} outline + ${dashes.length} nine-dash lines`);
