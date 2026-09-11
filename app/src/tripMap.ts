import type { DayRecord, PhotoRecord, TripRecord } from "@travel-archive/shared";
import { loc } from "./contentLang";
import { ui } from "./i18n";

/**
 * The trip as a map: which cities, in what order.
 *
 * An overview, deliberately not a detail view — cities as circles, lines
 * between them, country outlines behind. Street-level context is out of scope,
 * which is what makes a bundled basemap viable at all.
 *
 * **Natural Earth 50m, shipped with the app** (public domain) rather than
 * Google or any tile service. No API key, no billing, no second external host
 * in a page that otherwise talks only to OneDrive, and it works offline.
 * Imported dynamically: nothing is fetched until a trip page is actually
 * opened, and the basemap is culled to the view so its detail costs almost
 * nothing to draw.
 *
 * Six layers, because fewer was not a map. The first version drew country
 * outlines alone and, zoomed to two cities inside Austria and Slovakia, was a
 * blank field with one faint line across it. What places a city is water and
 * neighbours: a city and a city are both on the Danube, and a city sits
 * against a border. So: land, lakes, rivers, borders, and grey labels for
 * nearby cities the trip did not visit. See geo/README.md and
 * scripts/build-basemap.mjs.
 */

const HEIGHT = 380;
/**
 * The viewBox height covering the whole Mercator square, so zooming out is
 * bounded by the world rather than by the trip.
 *
 * It was previously `home.h / 0.6` — 1.67x the fitted view — which on a
 * two-city trip meant you could not zoom out far enough to see the country the
 * cities are in.
 */
const WORLD_H = 1e5;
const MAX_SCALE = 400;

/**
 * Cities are grouped by their reverse-geocoded name, not by distance.
 *
 * The geocoder already runs at Nominatim zoom 10 and takes city/town/village,
 * so "a city, Österreich" and "a city, Slovensko" are distinct strings 55km
 * apart, and a city and a city would be too. A distance threshold cannot
 * express that reliably — it has to be under 26km to split a city from a city,
 * which then splits a single sprawling city into several. Names have no such
 * tension.
 *
 * Distance clustering is only the fallback for photos whose lookup fell through
 * to a country or county ("Nederland" from the airport, "a district"), where there is
 * no city name to group on.
 */
const FALLBACK_CLUSTER_KM = 15;

/**
 * A stop whose photos span further than this was a journey, not a place.
 *
 * `detectStops` classifies by photo count and duration, and photos without GPS
 * join whatever cluster is open — so a long train ride with sparse indoor
 * signal looks stationary and is classified as a place. On the map that became
 * a city at the midpoint of the journey, named after a town it passed:
 * "a city to a city by ICE" appeared as **a city**, 156km from a city,
 * plotted near a city. Two more sat exactly on top of a city under other
 * towns' names.
 */
const MAX_PLACE_SPAN_KM = 30;

/**
 * How much of a stop's located photos must agree on a place name before it is
 * used. A journey's photos are each geocoded to whatever town they passed, so
 * the most common one can win with a small plurality and name the stop after
 * somewhere it merely went through.
 */
const MIN_PLACE_AGREEMENT = 0.4;

interface City {
  /** The raw geocoder string, used to match a stop back to its city. */
  key: string;
  name: string;
  /** True when the geocoder only resolved a country, so `name` is a fallback. */
  coarse: boolean;
  lat: number;
  lon: number;
  photoCount: number;
  /** Where clicking the marker goes: the first stop of the first day here. */
  anchor: string | null;
  firstSeen: string;
}

interface Basemap {
  /** Coastlines as filled rings. */
  land: number[][][];
  lakes: number[][][];
  rivers: number[][][];
  /** Country borders on land, as open lines. */
  borders: number[][][];
  /** `[name, lon, lat, scalerank]` for cities the trip did not visit — orientation only. */
  places: [string, number, number, number][];
}

function haversineKm(a: [number, number], b: [number, number]): number {
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a[0] * Math.PI) / 180) * Math.cos((b[0] * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Web Mercator, normalised to the unit square. */
function project(lat: number, lon: number): [number, number] {
  const x = (lon + 180) / 360;
  const clamped = Math.max(-85.05, Math.min(85.05, lat));
  const rad = (clamped * Math.PI) / 180;
  const y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
  return [x, y];
}

export function anchorFor(date: string, segmentId: string): string {
  return `stop-${date}-${segmentId}`;
}

/**
 * One entry per city the trip visited, in the order first reached.
 *
 * A segment's city is the most common `place` among its photos, not the first —
 * a day trip begins at home, so first-wins labelled the whole a city day
 * "a city".
 */
function citiesOf(days: DayRecord[], photos: Record<string, PhotoRecord>): { cities: City[]; visits: string[] } {
  const byName = new Map<string, { pts: [number, number][]; count: number; anchor: string | null; first: string }>();
  const unnamed: { pt: [number, number]; count: number; anchor: string | null; first: string }[] = [];
  // Every stop in chronological order, by the key of the city it belongs to.
  // Cities are deduplicated for markers, but the *route* has to keep repeats or
  // an out-and-back journey loses its return leg: a city -> a city -> a city was
  // drawn as a single line to a city and nothing coming back.
  const visits: string[] = [];

  for (const day of days) {
    for (const segment of day.segments) {
      if (segment.kind !== "place") continue;
      const located = segment.photoIds
        .map((id) => photos[id])
        .filter((p): p is PhotoRecord => Boolean(p?.gps) && !p!.gpsSuspect);
      if (located.length === 0) continue;

      // Reject journeys misclassified as places before they can become cities.
      let span = 0;
      for (const a of located) {
        for (const b of located) {
          const km = haversineKm([a.gps!.lat, a.gps!.lon], [b.gps!.lat, b.gps!.lon]);
          if (km > span) span = km;
        }
        if (span > MAX_PLACE_SPAN_KM) break;
      }
      if (span > MAX_PLACE_SPAN_KM) continue;

      const counts = new Map<string, number>();
      for (const p of located) if (p.place) counts.set(p.place, (counts.get(p.place) ?? 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      const withPlace = [...counts.values()].reduce((n, v) => n + v, 0);
      // A bare plurality is not agreement — see MIN_PLACE_AGREEMENT.
      const resolved = top && withPlace > 0 && top[1] / withPlace >= MIN_PLACE_AGREEMENT ? top[0] : null;

      // Only a *city-level* result may group by name. Nominatim returns
      // "<city>, <country>" when it resolves one and a bare country when it
      // does not, and a country covers many places: grouping every "Nederland"
      // stop together put the airport and a the capital arrival into one city whose
      // position was the midpoint of the two — open countryside 20km from Den
      // Haag, which it then merged into. Country-level results go to the
      // distance clustering below, which is what it was written for.
      const name = resolved?.includes(",") ? resolved : null;

      const pt: [number, number] = [median(located.map((p) => p.gps!.lat)), median(located.map((p) => p.gps!.lon))];
      const anchor = anchorFor(day.date, segment.id);

      if (name) {
        const entry = byName.get(name);
        if (entry) {
          entry.pts.push(pt);
          entry.count += located.length;
        } else {
          byName.set(name, { pts: [pt], count: located.length, anchor, first: segment.startTime });
        }
        visits.push(name);
      } else {
        const near = unnamed.find((u) => haversineKm(u.pt, pt) <= FALLBACK_CLUSTER_KM);
        if (near) near.count += located.length;
        else unnamed.push({ pt, count: located.length, anchor, first: segment.startTime });
        const idx = unnamed.findIndex((u) => haversineKm(u.pt, pt) <= FALLBACK_CLUSTER_KM);
        visits.push(`#unnamed-${idx}`);
      }
    }
  }

  const cities: City[] = [];
  for (const [name, entry] of byName) {
    // Nominatim returns "<locality>, <country>" when it resolves a city and
    // bare "<country>" when it cannot — the airport comes back "Nederland", a
    // the capital departure "United Kingdom". Taking that as a city name drew
    // countries as places on the map and made the route look like it flew
    // between them. The comma is the signal.
    const coarse = !name.includes(",");
    cities.push({
      key: name,
      // "a city, Österreich" -> "a city". The country is on the basemap already.
      name: name.split(",")[0]!.trim(),
      coarse,
      lat: median(entry.pts.map((p) => p[0])),
      lon: median(entry.pts.map((p) => p[1])),
      photoCount: entry.count,
      anchor: entry.anchor,
      firstSeen: entry.first,
    });
  }
  for (const [i, u] of unnamed.entries()) {
    cities.push({
      key: `#unnamed-${i}`,
      name: "",
      coarse: true,
      lat: u.pt[0],
      lon: u.pt[1],
      photoCount: u.count,
      anchor: u.anchor,
      firstSeen: u.first,
    });
  }
  cities.sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
  return { cities, visits };
}

function svgEl(tag: string, attrs: Record<string, string | number> = {}): SVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** Path data for one ring or line, in unit-square coordinates scaled by 1e5. */
function trace(points: number[][], close: boolean): string {
  let d = "";
  for (const [i, [lon, lat]] of points.entries()) {
    const [x, y] = project(lat, lon);
    d += `${i === 0 ? "M" : "L"}${(x * 1e5).toFixed(1)},${(y * 1e5).toFixed(1)}`;
  }
  return close ? `${d}Z` : d;
}

export async function renderTripMap(
  trip: TripRecord,
  photos: Record<string, PhotoRecord>,
  onPick: (anchor: string) => void,
): Promise<HTMLElement | null> {
  const { cities, visits } = citiesOf(trip.days, photos);
  if (cities.length === 0) return null;

  const root = document.createElement("div");
  root.className = "trip-map";
  root.appendChild(Object.assign(document.createElement("div"), { className: "trip-map-loading", textContent: ui.map.loading }));

  // Dynamic, so the basemap is never fetched by a phone browsing the album and
  // never delays first paint.
  const basemap = ((await import("./geo/basemap.json")) as unknown as { default: Basemap }).default;

  // Points the geocoder could only place to a country need a name. Two steps,
  // and the order matters.
  //
  // First **merge** a coarse point into a real city beside it. Naming it
  // independently produced two markers for one place — a stop that geocoded to
  // "Nederland" was renamed "The Hague" from the basemap and sat next to the
  // properly geocoded "Den Haag", the exonym and the endonym as separate
  // cities. If a city is already known there, the coarse point is the same
  // visit seen worse.
  const MERGE_KM = 25;
  const NEAREST_TOWN_KM = 45;
  const merged = new Map<string, string>();

  for (const city of cities) {
    if (!city.coarse) continue;
    let host: City | null = null;
    let hostKm = Infinity;
    for (const other of cities) {
      if (other === city || other.coarse) continue;
      const km = haversineKm([city.lat, city.lon], [other.lat, other.lon]);
      if (km <= MERGE_KM && km < hostKm) {
        host = other;
        hostKm = km;
      }
    }
    if (host) {
      host.photoCount += city.photoCount;
      merged.set(city.key, host.key);
    }
  }

  const kept = cities.filter((c) => !merged.has(c.key));
  // Route legs must follow the merge, or the line still visits a marker that is
  // no longer drawn.
  const routeKeys = visits.map((k) => merged.get(k) ?? k);

  // Then name whatever coarse points survived, after the nearest real town.
  // Beyond that range the country name is at least honest, so it is kept rather
  // than invented over.
  for (const city of kept) {
    if (!city.coarse) continue;
    let best: { name: string; km: number } | null = null;
    for (const [name, lon, lat] of basemap.places) {
      const km = haversineKm([city.lat, city.lon], [lat, lon]);
      if (km <= NEAREST_TOWN_KM && (!best || km < best.km)) best = { name, km };
    }
    if (best) city.name = best.name;
  }

  cities.length = 0;
  cities.push(...kept);

  root.replaceChildren();
  const canvas = svgEl("svg", { class: "trip-map-svg", role: "img", "aria-label": ui.map.label(loc(trip.name)) });
  const world = svgEl("g");

  // Bounding boxes, computed once, so the basemap can be culled to the view.
  //
  // This is what makes detail affordable. Every ring is an SVG node the browser
  // re-rasterises on each pan frame — measured at 985 nodes the map pans at
  // ~47fps, at 5,272 it drops to ~23fps. But a trip map only ever looks at a
  // small region, so nearly every ring is off-screen: drawing only what
  // intersects the view keeps the node count low whatever the source detail.
  const boxed = <T extends number[][]>(rings: T[]) =>
    rings.map((ring) => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [lon, lat] of ring) {
        if (lon < minX) minX = lon;
        if (lon > maxX) maxX = lon;
        if (lat < minY) minY = lat;
        if (lat > maxY) maxY = lat;
      }
      return { ring, minX, minY, maxX, maxY };
    });

  const layers = {
    land: boxed(basemap.land),
    lakes: boxed(basemap.lakes),
    rivers: boxed(basemap.rivers),
    borders: boxed(basemap.borders),
  };

  const basemapGroup = svgEl("g", { class: "trip-map-basemap" });
  world.appendChild(basemapGroup);
  // Suppressed by *distance*, not name. Natural Earth uses exonyms while the
  // archive's geocoder returns endonyms, so matching on the string left a grey
  // "a city" label sitting under the trip's own "a city" marker. The same would
  // happen for Munich/München and a city/a city.
  const NEAR_VISITED_KM = 25;
  const isVisited = (name: string, lon: number, lat: number) =>
    cities.some(
      (c) => c.name.toLowerCase() === name.toLowerCase() || haversineKm([c.lat, c.lon], [lat, lon]) <= NEAR_VISITED_KM,
    );

  /**
   * How prominent a city has to be to earn a label at this width.
   *
   * Natural Earth ranks places 0 (world capitals) to 9 (small towns). Drawing
   * all 1,244 at world zoom produced a solid mat of overlapping text, so the
   * threshold tightens as the view widens — the same thing an atlas does.
   */
  const labelRankFor = (spanDegrees: number) =>
    spanDegrees > 90 ? 0 : spanDegrees > 30 ? 1 : spanDegrees > 10 ? 3 : spanDegrees > 3 ? 5 : 9;

  /** Redraws the basemap for a lon/lat window, in cartographic order. */
  const paint = (west: number, south: number, east: number, north: number) => {
    const frag = document.createDocumentFragment();
    const hits = <T extends { minX: number; minY: number; maxX: number; maxY: number }>(b: T) =>
      b.maxX >= west && b.minX <= east && b.maxY >= south && b.minY <= north;

    for (const b of layers.land) if (hits(b)) frag.appendChild(svgEl("path", { class: "trip-map-land", d: trace(b.ring, true) }));
    for (const b of layers.lakes) if (hits(b)) frag.appendChild(svgEl("path", { class: "trip-map-lake", d: trace(b.ring, true) }));
    for (const b of layers.rivers) if (hits(b)) frag.appendChild(svgEl("path", { class: "trip-map-river", d: trace(b.ring, false) }));
    for (const b of layers.borders) if (hits(b)) frag.appendChild(svgEl("path", { class: "trip-map-border", d: trace(b.ring, false) }));

    const maxRank = labelRankFor(east - west);
    for (const [name, lon, lat, placeRank] of basemap.places) {
      if (placeRank > maxRank) continue;
      if (lon < west || lon > east || lat < south || lat > north) continue;
      if (isVisited(name, lon, lat)) continue;
      const [x, y] = project(lat, lon);
      frag.appendChild(svgEl("circle", { class: "trip-map-place-dot", cx: x * 1e5, cy: y * 1e5 }));
      const label = svgEl("text", { class: "trip-map-place", x: x * 1e5, y: y * 1e5 });
      label.textContent = name;
      frag.appendChild(label);
    }
    basemapGroup.replaceChildren(frag);
  };

  const points = cities.map((c) => project(c.lat, c.lon));

  // The route follows the visits, not the marker list, so returning to a city
  // draws the leg back. Consecutive stops in the same city collapse — that is
  // moving about within a place, not travelling between them.
  const byKey = new Map(cities.map((c, i) => [c.key, i] as const));
  const legOrder: number[] = [];
  for (const key of routeKeys) {
    const index = byKey.get(key);
    if (index === undefined) continue;
    if (legOrder[legOrder.length - 1] !== index) legOrder.push(index);
  }
  if (legOrder.length > 1) {
    world.appendChild(
      svgEl("polyline", {
        class: "trip-map-route",
        points: legOrder.map((i) => `${(points[i][0] * 1e5).toFixed(1)},${(points[i][1] * 1e5).toFixed(1)}`).join(" "),
      }),
    );
  }

  const markers = svgEl("g", { class: "trip-map-cities" });
  const biggest = Math.max(...cities.map((c) => c.photoCount), 1);

  /**
   * Which labels can be shown without overlapping, busiest city first.
   *
   * Ten cities inside the Randstad produced one illegible stack — "United
   * Kingdom Hoek van Holland a city a city" written over each other. A
   * label is dropped when its box would collide with one already placed; the
   * marker and its tooltip stay, so nothing is lost, it just stops shouting.
   * Recomputed per repaint, so zooming in reveals the labels that were hidden.
   */
  const labelled = new Set<number>();
  const placeLabels = () => {
    labelled.clear();
    const taken: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const k = view.h / home.h;
    const charW = fontBase * k * 0.55;
    const lineH = fontBase * k * 1.25;

    const order = cities.map((c, i) => i).sort((a, b) => cities[b].photoCount - cities[a].photoCount);
    for (const i of order) {
      const name = cities[i].name;
      if (!name) continue;
      const [x, y] = points[i];
      const cx = x * 1e5;
      const cy = y * 1e5;
      const halfW = (name.length * charW) / 2;
      const box = { x0: cx - halfW, x1: cx + halfW, y0: cy - lineH * 1.6, y1: cy - lineH * 0.4 };
      if (taken.some((t) => box.x0 < t.x1 && box.x1 > t.x0 && box.y0 < t.y1 && box.y1 > t.y0)) continue;
      taken.push(box);
      labelled.add(i);
    }
    for (const [i, node] of labelNodes) node.style.display = labelled.has(i) ? "" : "none";
  };
  const labelNodes = new Map<number, SVGElement>();

  for (const [i, city] of cities.entries()) {
    const [x, y] = points[i];
    const group = svgEl("g", { class: "trip-map-city", tabindex: "0", role: "button" });
    // Sizes are set later, as fractions of the fitted view — see sizeFor(). A
    // fixed radius in viewBox units is meaningless here: the same number is a
    // dot across Europe and a disc that fills the frame across one city.
    const circle = svgEl("circle", { cx: x * 1e5, cy: y * 1e5 });
    circle.style.setProperty("--city-weight", (0.55 + 0.75 * Math.sqrt(city.photoCount / biggest)).toFixed(3));
    group.appendChild(circle);

    const label = svgEl("text", { x: x * 1e5, y: y * 1e5, "text-anchor": "middle" });
    label.textContent = city.name || ui.common.photos(city.photoCount);
    group.appendChild(label);
    labelNodes.set(i, label);

    const title = svgEl("title");
    title.textContent = `${city.name || ui.map.unnamed} — ${ui.common.photos(city.photoCount)}`;
    group.appendChild(title);

    if (city.anchor) {
      const go = () => onPick(city.anchor!);
      group.addEventListener("click", go);
      group.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Enter") go();
      });
    }
    markers.appendChild(group);
  }
  world.appendChild(markers);
  canvas.appendChild(world);
  root.appendChild(canvas);

  // --- viewport ---------------------------------------------------------
  // The visible window is a viewBox over the unit square scaled by 1e5.
  // Everything below moves that window; nothing re-projects, so pan and zoom
  // cost one attribute write.
  const pad = 0.12;
  const xsAll = points.map((p) => p[0]);
  const ysAll = points.map((p) => p[1]);
  const spanX = Math.max(...xsAll) - Math.min(...xsAll);
  const spanY = Math.max(...ysAll) - Math.min(...ysAll);
  const span = Math.max(spanX, spanY, 0.004) * (1 + pad * 2);
  const aspect = 1.9;

  const view = {
    w: span * aspect * 1e5,
    h: span * 1e5,
    x: ((Math.min(...xsAll) + Math.max(...xsAll)) / 2) * 1e5,
    y: ((Math.min(...ysAll) + Math.max(...ysAll)) / 2) * 1e5,
  };
  const home = { ...view };

  // Everything drawn on top of the basemap — strokes, city discs, labels — is
  // sized as a fraction of the *fitted* view, then multiplied by how far you
  // have zoomed. That keeps them a constant size on screen whatever the trip's
  // extent, whether it spans a continent or two neighbouring cities.
  const fontBase = home.h * 0.05;
  canvas.style.setProperty("--map-r", `${home.h * 0.028}px`);
  canvas.style.setProperty("--map-f", `${fontBase}px`);
  canvas.style.setProperty("--map-s", `${home.h * 0.0035}px`);

  /** Inverse Web Mercator, back from unit-square coordinates to lon/lat. */
  const unproject = (x: number, y: number): [number, number] => [
    x * 360 - 180,
    (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI,
  ];

  // The window last painted, in lon/lat, padded so ordinary panning stays
  // inside it and costs nothing. Repainting is only worth doing when the view
  // leaves what is already drawn.
  let painted = { west: 1, south: 1, east: -1, north: -1 };

  const repaintIfNeeded = () => {
    const [west, north] = unproject((view.x - view.w / 2) / 1e5, (view.y - view.h / 2) / 1e5);
    const [east, south] = unproject((view.x + view.w / 2) / 1e5, (view.y + view.h / 2) / 1e5);
    if (west >= painted.west && east <= painted.east && south >= painted.south && north <= painted.north) return;

    const padX = (east - west) * 0.6;
    const padY = (north - south) * 0.6;
    painted = { west: west - padX, east: east + padX, south: south - padY, north: north + padY };
    paint(painted.west, painted.south, painted.east, painted.north);
  };

  const apply = () => {
    canvas.setAttribute("viewBox", `${view.x - view.w / 2} ${view.y - view.h / 2} ${view.w} ${view.h}`);
    canvas.style.setProperty("--map-k", String(view.h / home.h));
    repaintIfNeeded();
    placeLabels();
  };
  canvas.setAttribute("viewBox", "0 0 1 1");
  canvas.setAttribute("preserveAspectRatio", "xMidYMid meet");
  canvas.setAttribute("height", String(HEIGHT));
  apply();

  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const factor = Math.exp((event as WheelEvent).deltaY * 0.0015);
    // Bounded by the world's *width*, not its height: the viewBox is wider than
    // it is tall, so clamping on height alone let you zoom out past the point
    // where the whole map fits and kept going into empty space.
    //
    // And capped at about a continent — a sixth of the world's width, or four
    // times the trip's own extent when the trip is wider than that. Zooming
    // out to the whole globe showed a speck; the country around a two-city
    // trip is still in reach, which is what the old 1.67x cap took away.
    const continentH = Math.max(home.h * 4, WORLD_H / 6 / aspect);
    const maxH = Math.min(WORLD_H, WORLD_H / aspect, continentH);
    const next = Math.min(maxH, Math.max(home.h / MAX_SCALE, view.h * factor));
    view.w *= next / view.h;
    view.h = next;
    apply();
  });

  let dragging: { x: number; y: number } | null = null;
  canvas.addEventListener("pointerdown", (event) => {
    dragging = { x: (event as PointerEvent).clientX, y: (event as PointerEvent).clientY };
    canvas.setPointerCapture((event as PointerEvent).pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const e = event as PointerEvent;
    const rect = canvas.getBoundingClientRect();
    view.x -= ((e.clientX - dragging.x) / rect.width) * view.w;
    view.y -= ((e.clientY - dragging.y) / rect.height) * view.h;
    dragging = { x: e.clientX, y: e.clientY };
    apply();
  });
  const endDrag = () => (dragging = null);
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // An in-page overlay rather than the Fullscreen API: the native one hands the
  // whole screen to the element and loses the page around it, which is more
  // than "let me actually see this map".
  const expand = document.createElement("button");
  expand.type = "button";
  expand.className = "trip-map-expand";
  expand.textContent = ui.map.expand;

  const setExpanded = (on: boolean) => {
    root.classList.toggle("is-expanded", on);
    document.body.classList.toggle("map-expanded", on);
    expand.textContent = on ? ui.common.close : ui.map.expand;
    // The container changes shape, so the fitted view has to be recomputed or
    // the map sits letterboxed inside its old aspect ratio.
    requestAnimationFrame(() => {
      const box = canvas.getBoundingClientRect();
      if (box.height > 0) {
        view.w = view.h * (box.width / box.height);
        home.w = home.h * (box.width / box.height);
      }
      apply();
    });
  };

  expand.addEventListener("click", () => setExpanded(!root.classList.contains("is-expanded")));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && root.classList.contains("is-expanded")) setExpanded(false);
  });
  root.appendChild(expand);

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "trip-map-reset";
  reset.textContent = ui.common.fit;
  reset.addEventListener("click", () => {
    Object.assign(view, home);
    apply();
  });
  root.appendChild(reset);

  return root;
}
