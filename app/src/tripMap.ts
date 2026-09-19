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
/** Widest view, in degrees of longitude, that still draws rivers — see paint(). */
const RIVERS_MAX_SPAN_DEG = 60;
/**
 * Space kept between two discs before they merge, in screen pixels.
 *
 * Places merge only when their discs would touch. The first rule merged
 * anything within 44px, and at world zoom that folded Europe into "the capital
 * +371" and "a city +9" — a disc labelled the capital standing for places in a
 * dozen countries. The owner's word was "too conclusive": it hid where the
 * library had been instead of summarising it.
 */
const CLUSTER_GAP_PX = 3;

/**
 * The map's control icons — the phone app's (mobile/ui.ts), so the two read
 * as one design, with plus and minus added.
 */
const MAP_ICONS = {
  plus: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  minus: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  expand: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  close: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  fit: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="12" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`,
};

function setIcon(button: HTMLButtonElement, icon: string, label: string): void {
  button.innerHTML = icon;
  button.title = label;
  button.setAttribute("aria-label", label);
}

/** "3.8k" for a badge that has to fit inside a disc. */
function shortCount(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

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

export interface Basemap {
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

/** A place as the map draws it. The trip page and the home page each reduce their own data to this. */
export interface MapPoint {
  key: string;
  name: string;
  lat: number;
  lon: number;
  photoCount: number;
  /**
   * What the point belongs to — the home page passes its country. A cluster
   * never spans two groups, so a disc never claims one country's places for
   * another's.
   */
  group?: string;
}

export interface PlaceMapOptions {
  /** The map's accessible name. */
  label: string;
  /** Point keys in the order visited, for the route line. Absent draws no route. */
  route?: string[];
  /** A marker was chosen, by index into the points. Absent leaves markers inert. */
  onPick?: (index: number) => void;
  /**
   * How far out the wheel may go. A trip stops at about a continent — the
   * whole globe around two cities showed a speck — while the home page's
   * subject is the world.
   */
  zoomOut?: "continent" | "world";
  /**
   * Merge places that crowd each other into one disc with a count, re-grouped
   * as the zoom changes. For the home page's 515 places; a trip has few enough
   * cities that every one should be seen.
   */
  cluster?: boolean;
  /** Label size relative to the trip map's. The home page's view is a world, not a trip, and wants smaller type. */
  fontScale?: number;
  /**
   * Label size on screen, in pixels, in place of `fontScale`; discs follow in
   * proportion. `fontScale` is a fraction of the frame's height, so one value
   * gave 14px labels in the desktop's 460px frame and 9px in the phone's
   * 300px one.
   */
  labelPx?: number;
  /** A group's display name, for a cluster that holds the whole of one (see MapPoint.group). */
  groupName?: (group: string) => string;
  /** A cluster's name: its biggest place, and how many more it holds. */
  clusterName?: (biggest: string, more: number) => string;
  /**
   * A cluster spanning several groups: their names, most photos first. Named
   * for its biggest place instead, one disc standing for five countries read
   * as a claim about the capital.
   */
  groupsName?: (groups: string[]) => string;
  /** A line describing what is in view, kept current as the map moves. */
  inView?: (photos: number, places: number) => string;
}

let basemapPromise: Promise<Basemap> | null = null;

/**
 * The bundled basemap, fetched on first use and kept for the session.
 *
 * Dynamic, so it is never fetched by a reader who opens no map, and never
 * delays first paint.
 */
export function loadBasemap(): Promise<Basemap> {
  basemapPromise ??= import("./geo/basemap.json").then((m) => (m as unknown as { default: Basemap }).default);
  return basemapPromise;
}

/**
 * Draws places on the basemap, with pan, pinch, wheel zoom, expand and fit.
 *
 * Shared by the trip map and the home page. They were two renderers for a
 * day, and the home page's copy had none of this — no zoom or pan, no rivers,
 * borders or reference towns, labels that overlapped. Everything particular to
 * a trip (grouping stops into cities, merging coarse points, the route order)
 * happens before this is called.
 */
export function drawPlaceMap(root: HTMLElement, basemap: Basemap, cities: MapPoint[], opts: PlaceMapOptions): void {
  root.replaceChildren();
  const canvas = svgEl("svg", { class: "trip-map-svg", role: "img", "aria-label": opts.label });
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
      return { ring, minX, minY, maxX, maxY, el: null as SVGElement | null };
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
  //
  // Decided once, not per repaint: it depends on nothing the view changes, and
  // with the home page's 515 places against the basemap's 1,244 towns it is
  // 640,000 distance checks — far too many to repeat on a pan.
  const suppressed = new Set<number>();
  for (const [index, [name, lon, lat]] of basemap.places.entries()) {
    const lower = name.toLowerCase();
    for (const c of cities) {
      if (c.name.toLowerCase() === lower || haversineKm([c.lat, c.lon], [lat, lon]) <= NEAR_VISITED_KM) {
        suppressed.add(index);
        break;
      }
    }
  }

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
  const paint = (west: number, south: number, east: number, north: number, rivers: boolean) => {
    const frag = document.createDocumentFragment();
    const hits = <T extends { minX: number; minY: number; maxX: number; maxY: number }>(b: T) =>
      b.maxX >= west && b.minX <= east && b.maxY >= south && b.minY <= north;

    // A path's data is in fixed world units — the view moves the viewBox, never
    // the geometry — so each element is built the first time it is needed and
    // re-attached after that. Rebuilding them was most of a repaint: at world
    // zoom on the home page that is 2,782 paths, and a zoom step cost 51ms.
    const draw = (b: (typeof layers.land)[number], cls: string, close: boolean) =>
      frag.appendChild((b.el ??= svgEl("path", { class: cls, d: trace(b.ring, close) })));

    for (const b of layers.land) if (hits(b)) draw(b, "trip-map-land", true);
    for (const b of layers.lakes) if (hits(b)) draw(b, "trip-map-lake", true);
    // Rivers only once the view is narrower than a large country. Across a
    // continent they are hairlines nobody can read, and 556 nodes at world
    // zoom — a fifth of what the browser would re-rasterise on every frame.
    if (rivers) for (const b of layers.rivers) if (hits(b)) draw(b, "trip-map-river", false);
    for (const b of layers.borders) if (hits(b)) draw(b, "trip-map-border", false);

    // One tier later on a clustered map. Its subject is where the library has
    // been, and at world zoom the capitals it would otherwise name — Los
    // Angeles, Mumbai, Sydney — are nearly all places it has not.
    const maxRank = labelRankFor(east - west) - (opts.cluster ? 1 : 0);
    for (const [index, [name, lon, lat, placeRank]] of basemap.places.entries()) {
      if (placeRank > maxRank) continue;
      if (lon < west || lon > east || lat < south || lat > north) continue;
      if (suppressed.has(index)) continue;
      const [x, y] = project(lat, lon);
      // Drawn at the origin of a group placed by transform — see placeMarkers.
      const group = svgEl("g", { class: "trip-map-ref" });
      group.dataset.x = String(x * 1e5);
      group.dataset.y = String(y * 1e5);
      group.appendChild(svgEl("circle", { class: "trip-map-place-dot", cx: 0, cy: 0 }));
      const label = svgEl("text", { class: "trip-map-place", x: 0, y: 0 });
      label.textContent = name;
      group.appendChild(label);
      frag.appendChild(group);
    }
    basemapGroup.replaceChildren(frag);
    refGroups = [...basemapGroup.querySelectorAll<SVGElement>(".trip-map-ref")];
    placeMarkers();
  };

  const points = cities.map((c) => project(c.lat, c.lon));

  // The route follows the visits, not the marker list, so returning to a city
  // draws the leg back. Consecutive stops in the same city collapse — that is
  // moving about within a place, not travelling between them.
  const byKey = new Map(cities.map((c, i) => [c.key, i] as const));
  const legOrder: number[] = [];
  for (const key of opts.route ?? []) {
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
  const clusterLayer = svgEl("g", { class: "trip-map-cities trip-map-clusters" });
  const biggest = Math.max(...cities.map((c) => c.photoCount), 1);
  const totalPhotos = Math.max(cities.reduce((sum, c) => sum + c.photoCount, 0), 1);

  /**
   * A disc's size as a multiple of the base radius.
   *
   * The trip map's square root against the busiest city works for a trip —
   * ten cities within one order of magnitude. Against the home page's the capital
   * (3,844 photos) it put nearly all 515 places within a few percent of the
   * floor, so a hub and a one-photo stopover looked the same. Clustered, the
   * scale is logarithmic against the whole library, which is what spans one
   * photo to fifteen thousand in a cluster over Europe.
   */
  const weightOf = opts.cluster
    ? (count: number) => 0.5 + 1.1 * (Math.log10(1 + count) / Math.log10(1 + totalPhotos))
    : (count: number) => 0.55 + 0.75 * Math.sqrt(count / biggest);

  /** Something drawn and labelled: a single place, or a cluster standing for several. */
  interface Item {
    x: number;
    y: number;
    count: number;
    weight: number;
    name: string;
    label: SVGElement;
  }

  /** Set once a press has travelled far enough to be a pan; the click that ends it is ignored. */
  let moved = false;

  const cityGroups: SVGElement[] = [];
  const cityItems: Item[] = [];
  for (const [i, city] of cities.entries()) {
    const [x, y] = points[i];
    const group = svgEl("g", { class: "trip-map-city", tabindex: "0", role: "button" });
    // Sizes are set in CSS, as fractions of the fitted view — see fontBase —
    // and drawn at the group's origin; placeMarkers() moves and scales the
    // group. A fixed radius in viewBox units is meaningless here: the same
    // number is a dot across Europe and a disc that fills the frame across one
    // city.
    const weight = weightOf(city.photoCount);
    const circle = svgEl("circle", { cx: 0, cy: 0 });
    circle.style.setProperty("--city-weight", weight.toFixed(3));
    group.appendChild(circle);

    const label = svgEl("text", { x: 0, y: 0, "text-anchor": "middle" });
    label.textContent = city.name || ui.common.photos(city.photoCount);
    group.appendChild(label);

    const title = svgEl("title");
    title.textContent = `${city.name || ui.map.unnamed} — ${ui.common.photos(city.photoCount)}`;
    group.appendChild(title);

    if (opts.onPick) {
      const go = () => opts.onPick!(i);
      group.addEventListener("click", () => {
        // A drag that happened to end on a city is a pan, not a choice.
        if (!moved) go();
      });
      group.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Enter") go();
      });
    }
    markers.appendChild(group);
    group.dataset.x = String(x * 1e5);
    group.dataset.y = String(y * 1e5);
    cityGroups.push(group);
    cityItems.push({ x: x * 1e5, y: y * 1e5, count: city.photoCount, weight, name: city.name, label });
  }

  let clusterGroups: SVGElement[] = [];
  let refGroups: SVGElement[] = [];
  /** How far in the view is zoomed against the fit; every marker is drawn at this scale. */
  let zoomScale = 1;

  /**
   * Places every marker for the current zoom: a translate to its point and a
   * scale that keeps it the same size on screen.
   *
   * This used to be one CSS variable, --map-k, that every size in the
   * stylesheet multiplied by. Changing an inherited custom property makes
   * the browser recompute style for every node beneath it — 4,500 on the home
   * page — and that alone cost 26ms a zoom step, measured with nothing else
   * changing. A transform attribute per marker is a few hundred cheap writes;
   * lines keep their width with `vector-effect: non-scaling-stroke` instead.
   */
  const placeMarkers = () => {
    const k = zoomScale.toFixed(5);
    for (const group of [...cityGroups, ...clusterGroups, ...refGroups]) {
      if (group.style.display === "none") continue;
      group.setAttribute("transform", `translate(${group.dataset.x} ${group.dataset.y}) scale(${k})`);
    }
  };

  /** What is drawn right now: every city, or — clustered — singles and clusters for this zoom. */
  let items: Item[] = cityItems;
  /** The zoom the clusters were built for, quantised, so a pan never regroups them. */
  let clusterBucket = Number.NaN;
  /**
   * The canvas's height in pixels, which the cluster gap is measured in.
   * Read once and again when the frame changes shape (expand), never per
   * regroup: reading it mid-zoom forced a synchronous layout, and was most of
   * why a zoom step went from 10ms to 31ms when clustering arrived.
   */
  let pixelHeight = 0;
  /** The frame's width over its height, read with pixelHeight and reset with it. */
  let frameAspect = 0;
  const setDisplay = (node: SVGElement, display: string) => {
    if (node.style.display !== display) node.style.display = display;
  };

  /**
   * Groups places whose discs would touch, biggest place first.
   *
   * Greedy and in screen space: the busiest ungrouped place takes every
   * ungrouped place of its own group whose disc would touch its own, and the
   * cluster sits on that place — a centroid lands in the sea as often as not.
   * Regrouped only when the zoom moves half a doubling, so panning never
   * reshuffles what you are looking at.
   */
  const groupSizes = new Map<string, number>();
  for (const c of cities) if (c.group) groupSizes.set(c.group, (groupSizes.get(c.group) ?? 0) + 1);
  const recluster = () => {
    if (!opts.cluster) return;
    // Per half-doubling of zoom: finer regrouped on nearly every wheel step.
    const bucket = Math.round(Math.log2(view.h) * 2);
    if (bucket === clusterBucket) return;
    clusterBucket = bucket;

    // clientHeight, not the bounding rect: the layout size, untouched by a CSS
    // transform — the phone scales the map in over 0.22s on expand, and the
    // rect read mid-animation is ~94% of it.
    //
    // The view's height as drawn, which is the frame's only when the frame is
    // at least as wide as the view: "meet" fits a 1.9:1 view to the width of a
    // narrower frame.
    if (!pixelHeight) pixelHeight = Math.min(canvas.clientHeight || HEIGHT, (canvas.clientWidth || Infinity) * (view.h / view.w));
    // A disc's radius at this zoom, in world units, is discBase * weight *
    // (view.h / home.h); see placeMarkers().
    const unitR = discBase * (view.h / home.h);
    const gap = CLUSTER_GAP_PX * (view.h / pixelHeight);
    const reach = (a: number, b: number) => unitR * (cityItems[a].weight + cityItems[b].weight) + gap;
    // Grid cells as wide as the furthest two discs can be and still touch.
    const maxWeight = Math.max(...cityItems.map((c) => c.weight));
    const radius = unitR * maxWeight * 2 + gap;
    const cellKey = (x: number, y: number) => Math.floor(x / radius) * 1_000_003 + Math.floor(y / radius);
    const grid = new Map<number, number[]>();
    for (const [i, item] of cityItems.entries()) {
      const key = cellKey(item.x, item.y);
      const bucketList = grid.get(key);
      if (bucketList) bucketList.push(i);
      else grid.set(key, [i]);
    }

    const grouped = new Uint8Array(cities.length);
    const order = cities.map((_, i) => i).sort((a, b) => cities[b].photoCount - cities[a].photoCount);
    const next: Item[] = [];
    const frag = document.createDocumentFragment();

    const clusters: { seed: number; members: number[]; count: number }[] = [];
    for (const seed of order) {
      if (grouped[seed]) continue;
      grouped[seed] = 1;
      const centre = cityItems[seed];
      const members = [seed];
      const cx = Math.floor(centre.x / radius);
      const cy = Math.floor(centre.y / radius);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          for (const j of grid.get(gx * 1_000_003 + gy) ?? []) {
            if (grouped[j]) continue;
            if (cities[j].group !== cities[seed].group) continue;
            if (Math.hypot(cityItems[j].x - centre.x, cityItems[j].y - centre.y) > reach(seed, j)) continue;
            grouped[j] = 1;
            members.push(j);
          }
        }
      }
      clusters.push({ seed, members, count: members.reduce((sum, m) => sum + cities[m].photoCount, 0) });
    }

    // Across a border only when one disc would hide the other's centre. Kept
    // apart, Europe at phone size was five country discs stacked on one
    // another, each count half under the next; merged only at that depth, a
    // country beside its neighbour still reads as its own.
    const clusterWeight = (c: (typeof clusters)[number]) =>
      c.members.length === 1 ? cityItems[c.seed].weight : Math.max(0.95, weightOf(c.count));
    for (let changed = true; changed; ) {
      changed = false;
      clusters.sort((a, b) => b.count - a.count);
      for (let i = 0; i < clusters.length; i++) {
        const a = clusters[i];
        for (let j = i + 1; j < clusters.length; j++) {
          const b = clusters[j];
          const distance = Math.hypot(cityItems[a.seed].x - cityItems[b.seed].x, cityItems[a.seed].y - cityItems[b.seed].y);
          if (distance >= unitR * Math.max(clusterWeight(a), clusterWeight(b))) continue;
          a.members.push(...b.members);
          a.count += b.count;
          clusters.splice(j--, 1);
          changed = true;
        }
      }
    }

    for (const { seed, members } of clusters) {
      const centre = cityItems[seed];
      if (members.length === 1) {
        setDisplay(cityGroups[seed], "");
        // placeMarkers() skips hidden groups; this one may have been hidden
        // at the zoom its transform was last written for.
        next.push(centre);
        continue;
      }
      for (const m of members) setDisplay(cityGroups[m], "none");

      const count = members.reduce((sum, m) => sum + cities[m].photoCount, 0);
      // Never smaller than a disc a two-digit badge fits in.
      const weight = Math.max(0.95, weightOf(count));
      const node = svgEl("g", { class: "trip-map-city is-cluster", tabindex: "0", role: "button" });
      node.dataset.x = String(centre.x);
      node.dataset.y = String(centre.y);
      const circle = svgEl("circle", { cx: 0, cy: 0 });
      circle.style.setProperty("--city-weight", weight.toFixed(3));
      node.appendChild(circle);
      const badge = svgEl("text", { x: 0, y: 0, class: "trip-map-count", "text-anchor": "middle" });
      badge.style.setProperty("--city-weight", weight.toFixed(3));
      badge.textContent = shortCount(count);
      node.appendChild(badge);
      // Named for what it is. The whole of a country is that country; part of
      // one is its biggest place "and N more" — "+371" read as bookkeeping,
      // and "the capital" alone as a claim about the capital.
      const group = cities[seed].group;
      const byGroup = new Map<string, number>();
      for (const m of members) {
        const g = cities[m].group;
        if (g) byGroup.set(g, (byGroup.get(g) ?? 0) + cities[m].photoCount);
      }
      const groups = [...byGroup.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
      const name =
        groups.length > 1 && opts.groupName && opts.groupsName
          ? opts.groupsName(groups.map(opts.groupName))
          : group && opts.groupName && members.length === groupSizes.get(group)
            ? opts.groupName(group)
            : (opts.clusterName ?? ((b: string, n: number) => `${b} +${n}`))(cities[seed].name, members.length - 1);
      const label = svgEl("text", { x: 0, y: 0, "text-anchor": "middle" });
      label.textContent = name;
      node.appendChild(label);
      const title = svgEl("title");
      title.textContent = `${name} — ${ui.common.photos(count)}`;
      node.appendChild(title);

      const open = () => zoomTo(members);
      node.addEventListener("click", () => {
        if (!moved) open();
      });
      node.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Enter") open();
      });
      frag.appendChild(node);
      next.push({ x: centre.x, y: centre.y, count, weight, name, label });
    }
    clusterLayer.replaceChildren(frag);
    clusterGroups = [...clusterLayer.children] as SVGElement[];
    items = next;
    placeMarkers();
  };

  /** Opens a cluster: fits its members, and always at least halves the view so it actually splits. */
  const zoomTo = (members: number[]) => {
    const xs = members.map((m) => cityItems[m].x);
    const ys = members.map((m) => cityItems[m].y);
    const aspectNow = view.w / view.h;
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    const fit = Math.max(spanY, spanX / aspectNow) * 1.5;
    view.h = Math.max(home.h / MAX_SCALE, Math.min(view.h / 2, fit));
    view.w = view.h * aspectNow;
    view.x = (Math.min(...xs) + Math.max(...xs)) / 2;
    view.y = (Math.min(...ys) + Math.max(...ys)) / 2;
    apply();
  };

  /**
   * Which labels can be shown without overlapping, busiest first.
   *
   * Ten cities inside the Randstad produced one illegible stack — "United
   * Kingdom Hoek van Holland a city a city" written over each other. A
   * label is dropped when its box would collide with one already placed; the
   * marker and its tooltip stay, so nothing is lost, it just stops shouting.
   * Recomputed per frame, so zooming in reveals the labels that were hidden.
   *
   * The basemap's reference towns go through the same test, last: Moscow or
   * Rome written across a place the library was actually photographed is the
   * wrong way round, so a reference label only shows where it clears
   * everything the map is about.
   */
  const labelled = new Set<SVGElement>();
  /** Where a label may sit relative to its dot, in order of preference. */
  const SIDES = ["above", "below", "right", "left"] as const;
  /** Sizes tried before a label is given up on, as fractions of the base. */
  const SCALES = [1, 0.82, 0.68];
  const placeLabels = () => {
    labelled.clear();
    // Placed boxes are bucketed on a grid so a candidate is checked against its
    // neighbours only. A flat list meant every candidate against every box —
    // at the home page's 515 cities, several million comparisons a frame, and
    // a pan cost 18ms before anything was drawn.
    type Box = { x0: number; y0: number; x1: number; y1: number };
    const k = view.h / home.h;
    /** The base font in view units; offsets are multiples of it, so they hold through a zoom. */
    const unit = fontBase * k;
    const cell = Math.max(unit * 4, 1e-6);
    const grid = new Map<number, Box[]>();
    const keysOf = (b: Box) => {
      const keys: number[] = [];
      for (let ix = Math.floor(b.x0 / cell); ix <= Math.floor(b.x1 / cell); ix++) {
        for (let iy = Math.floor(b.y0 / cell); iy <= Math.floor(b.y1 / cell); iy++) keys.push(ix * 1_000_003 + iy);
      }
      return keys;
    };
    const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
    // What the frame shows, which "meet" widens past the viewBox on whichever
    // axis the frame is longer. A label crossing it is tried on another side —
    // at the edge, "Harb…" and "Shangh…" were cut rather than flipped inward.
    if (!frameAspect) frameAspect = (canvas.clientWidth || 1) / (canvas.clientHeight || 1);
    const shownW = Math.max(view.w, view.h * frameAspect);
    const shownH = Math.max(view.h, view.w / frameAspect);
    const inset = unit * 0.3;
    const frame: Box = {
      x0: view.x - shownW / 2 + inset,
      x1: view.x + shownW / 2 - inset,
      y0: view.y - shownH / 2 + inset,
      y1: view.y + shownH / 2 - inset,
    };
    const inFrame = (b: Box) => b.x0 >= frame.x0 && b.x1 <= frame.x1 && b.y0 >= frame.y0 && b.y1 <= frame.y1;
    const reserve = (b: Box) => {
      for (const key of keysOf(b)) {
        const bucket = grid.get(key);
        if (bucket) bucket.push(b);
        else grid.set(key, [b]);
      }
    };
    const clashes = (b: Box) => {
      for (const key of keysOf(b)) if (grid.get(key)?.some((t) => overlaps(t, b))) return true;
      return false;
    };

    /** A disc's radius in view units, from the same expression the CSS sizes it with. */
    const discRadius = (item: Item) => discBase * item.weight * k;
    // The discs are reserved before any label is placed: a name written across
    // a neighbouring city's dot hides the very thing the map is drawing.
    for (const item of items) {
      const r = discRadius(item);
      reserve({ x0: item.x - r, x1: item.x + r, y0: item.y - r, y1: item.y + r });
    }

    const order = [...items].sort((a, b) => b.count - a.count);
    for (const item of order) {
      const { name, label: node } = item;
      if (!name) continue;
      // Clearance from the centre: the dot's own radius plus a gap, in font
      // units, which is what the CSS transform multiplies.
      const radius = ((discBase * item.weight) / fontBase) * 1.15;

      let placed: { dx: number; dy: number; anchor: string; scale: number } | null = null;
      // Size is the outer loop: a label at full size on its second-choice side
      // reads better than a shrunken one above.
      for (const scale of SCALES) {
        const size = unit * scale;
        const width = name.length * 0.55 * size;
        for (const side of SIDES) {
          const dx = side === "right" ? radius + 0.35 : side === "left" ? -(radius + 0.35) : 0;
          const dy = side === "above" ? -(radius + 0.55) : side === "below" ? radius + 0.95 : 0.32;
          const anchor = side === "right" ? "start" : side === "left" ? "end" : "middle";
          const baseX = item.x + dx * unit;
          const baseY = item.y + dy * unit;
          const x0 = anchor === "start" ? baseX : anchor === "end" ? baseX - width : baseX - width / 2;
          const box = { x0, x1: x0 + width, y0: baseY - size * 0.78, y1: baseY + size * 0.22 };
          if (!inFrame(box) || clashes(box)) continue;
          reserve(box);
          placed = { dx, dy, anchor, scale };
          break;
        }
        if (placed) break;
      }

      if (!placed) continue;
      // Written only when it changed: most labels keep their place from one
      // frame to the next, and each style write is a style recalculation.
      const signature = `${placed.dx}|${placed.dy}|${placed.scale}|${placed.anchor}`;
      if (node.dataset.placed !== signature) {
        node.dataset.placed = signature;
        node.style.setProperty("--label-dx", String(placed.dx));
        node.style.setProperty("--label-dy", String(placed.dy));
        node.style.setProperty("--label-scale", String(placed.scale));
        node.setAttribute("text-anchor", placed.anchor);
      }
      labelled.add(node);
    }
    for (const item of items) {
      const display = labelled.has(item.label) ? "" : "none";
      if (item.label.style.display !== display) item.label.style.display = display;
    }

    // Reference towns last. Their geometry mirrors `.trip-map-place` in the
    // stylesheet: 0.62 of the base size, nudged right and down of the dot.
    for (const group of refGroups) {
      const size = unit * 0.62;
      const x0 = Number(group.dataset.x) + unit * 0.34;
      const baseY = Number(group.dataset.y) + unit * 0.22;
      const box = { x0, x1: x0 + (group.textContent ?? "").length * 0.55 * size, y0: baseY - size * 0.78, y1: baseY + size * 0.22 };
      const hidden = clashes(box);
      if (!hidden) reserve(box);
      setDisplay(group, hidden ? "none" : "");
    }
  };

  world.appendChild(markers);
  world.appendChild(clusterLayer);
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
  /** The fit as first computed, before any container reshaped `home` (setExpanded). */
  const fitted = { w: home.w, h: home.h };
  /**
   * Where Fit goes. The same as `home` until the container changes shape; then
   * they part, since `home` is also the size reference for discs and labels
   * and has to follow the container's height, while Fit follows the places.
   */
  const fitView = { ...view };
  /** The places' own extent, padded the same way — what a refit must keep in view. */
  const extent = { w: Math.max(spanX, 0.004) * (1 + pad * 2) * 1e5, h: Math.max(spanY, 0.004) * (1 + pad * 2) * 1e5 };

  // Everything drawn on top of the basemap — strokes, city discs, labels — is
  // sized as a fraction of the *fitted* view, then multiplied by how far you
  // have zoomed. That keeps them a constant size on screen whatever the trip's
  // extent, whether it spans a continent or two neighbouring cities.
  //
  // labelPx pins the label to a size on screen instead, from the frame's
  // height as drawn; discs keep the proportion to labels the trip map has.
  // As in recluster(), the view's height as drawn: a narrow frame fits the
  // view to its width, and sizing from the frame's height halved the type.
  const framePx = Math.min(canvas.clientHeight || HEIGHT, (canvas.clientWidth || Infinity) * (home.h / home.w));
  const fontBase = opts.labelPx ? home.h * (opts.labelPx / framePx) : home.h * 0.05 * (opts.fontScale ?? 1);
  // Discs a little smaller against their labels than the trip map's: at world
  // zoom a clustered map has Europe's countries side by side, and at the trip
  // map's proportion their discs covered each other's counts.
  const discBase = opts.labelPx ? fontBase * 0.68 : home.h * 0.028;
  canvas.style.setProperty("--map-r", `${discBase}px`);
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
  let painted = { west: 1, south: 1, east: -1, north: -1, rivers: false };

  const repaintIfNeeded = () => {
    const [west, north] = unproject((view.x - view.w / 2) / 1e5, (view.y - view.h / 2) / 1e5);
    const [east, south] = unproject((view.x + view.w / 2) / 1e5, (view.y + view.h / 2) / 1e5);
    // Judged on the *visible* span, not the padded window paint() is handed —
    // that is 2.2x wider, and measuring it cut the rivers from the train.
    // Crossing the threshold forces a repaint: zooming in from the world view
    // never leaves the painted window, so rivers would otherwise never return.
    const rivers = east - west <= RIVERS_MAX_SPAN_DEG;
    const inside = west >= painted.west && east <= painted.east && south >= painted.south && north <= painted.north;
    if (inside && rivers === painted.rivers) return;

    const padX = (east - west) * 0.6;
    const padY = (north - south) * 0.6;
    painted = { west: west - padX, east: east + padX, south: south - padY, north: north + padY, rivers };
    paint(painted.west, painted.south, painted.east, painted.north, rivers);
  };

  const status = opts.inView ? document.createElement("div") : null;
  if (status) status.className = "trip-map-status";

  /** Photos and places inside the view, for the status line. A pass over 515 points, cheap enough per frame. */
  const updateStatus = () => {
    if (!status || !opts.inView) return;
    const x0 = view.x - view.w / 2;
    const x1 = view.x + view.w / 2;
    const y0 = view.y - view.h / 2;
    const y1 = view.y + view.h / 2;
    let photos = 0;
    let places = 0;
    for (const [i, item] of cityItems.entries()) {
      if (item.x < x0 || item.x > x1 || item.y < y0 || item.y > y1) continue;
      photos += cities[i].photoCount;
      places++;
    }
    const text = opts.inView(photos, places);
    if (status.textContent !== text) status.textContent = text;
  };

  const apply = () => {
    canvas.setAttribute("viewBox", `${view.x - view.w / 2} ${view.y - view.h / 2} ${view.w} ${view.h}`);
    zoomScale = view.h / home.h;
    repaintIfNeeded();
    recluster();
    placeLabels();
    // After the labels: they decide which groups are hidden, and only shown
    // ones are written.
    placeMarkers();
    updateStatus();
  };
  canvas.setAttribute("viewBox", "0 0 1 1");
  canvas.setAttribute("preserveAspectRatio", "xMidYMid meet");
  canvas.setAttribute("height", String(HEIGHT));
  apply();

  /** Zooms by `factor` (above 1 is out), keeping the point at (fx, fy) — fractions of the canvas — still. */
  const zoomBy = (factor: number, fx = 0.5, fy = 0.5) => {
    // Bounded by the world's *width*, not its height: the viewBox is wider than
    // it is tall, so clamping on height alone let you zoom out past the point
    // where the whole map fits and kept going into empty space.
    //
    // And capped at about a continent — a sixth of the world's width, or four
    // times the trip's own extent when the trip is wider than that. Zooming
    // out to the whole globe showed a speck; the country around a two-city
    // trip is still in reach, which is what the old 1.67x cap took away.
    //
    // The home page opts out of the continent cap: its subject is the world,
    // and its fitted view already spans the capital to Beijing.
    const continentH = opts.zoomOut === "world" ? Infinity : Math.max(home.h * 4, WORLD_H / 6 / aspect);
    const maxH = Math.min(WORLD_H, WORLD_H / aspect, continentH);
    const next = Math.min(maxH, Math.max(home.h / MAX_SCALE, view.h * factor));
    const ratio = next / view.h;
    // Anchored on the pointer rather than the centre, so the place being
    // zoomed into stays under the cursor or between the fingers.
    view.x += (fx - 0.5) * view.w * (1 - ratio);
    view.y += (fy - 0.5) * view.h * (1 - ratio);
    view.w *= ratio;
    view.h = next;
    apply();
  };

  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const e = event as WheelEvent;
    const rect = canvas.getBoundingClientRect();
    zoomBy(Math.exp(e.deltaY * 0.0015), (e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
  });

  // One pointer pans; two pinch. The map had wheel zoom only, which on a
  // touch screen meant no zoom at all.
  //
  // Capture waits until the pointer has actually moved: capturing on
  // pointerdown retargets the click to the canvas, so a tap on a city would
  // never reach the city.
  const pointers = new Map<number, { x: number; y: number }>();
  const DRAG_SLOP_PX = 4;
  let pressedAt: { x: number; y: number } | null = null;
  canvas.addEventListener("pointerdown", (event) => {
    const e = event as PointerEvent;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      pressedAt = { x: e.clientX, y: e.clientY };
      moved = false;
    }
  });
  canvas.addEventListener("pointermove", (event) => {
    const e = event as PointerEvent;
    const last = pointers.get(e.pointerId);
    if (!last) return;
    const rect = canvas.getBoundingClientRect();

    if (!moved && pointers.size === 1 && pressedAt && Math.hypot(e.clientX - pressedAt.x, e.clientY - pressedAt.y) < DRAG_SLOP_PX) return;
    if (!moved) {
      moved = true;
      for (const id of pointers.keys()) {
        try {
          canvas.setPointerCapture(id);
        } catch {
          // The browser no longer tracks that pointer (lifted between events).
          // The pan still works without capture; it just stops at the edge.
        }
      }
    }

    if (pointers.size === 2) {
      const [oa, ob] = [...pointers.values()];
      const before = Math.hypot(oa.x - ob.x, oa.y - ob.y);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = [...pointers.values()];
      const after = Math.hypot(a.x - b.x, a.y - b.y);
      if (before > 0 && after > 0) {
        const mx = ((a.x + b.x) / 2 - rect.left) / rect.width;
        const my = ((a.y + b.y) / 2 - rect.top) / rect.height;
        zoomBy(before / after, mx, my);
      }
      return;
    }

    view.x -= ((e.clientX - last.x) / rect.width) * view.w;
    view.y -= ((e.clientY - last.y) / rect.height) * view.h;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    apply();
  });
  const endDrag = (event: Event) => {
    pointers.delete((event as PointerEvent).pointerId);
    if (pointers.size === 0) pressedAt = null;
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // An in-page overlay rather than the Fullscreen API: the native one hands the
  // whole screen to the element and loses the page around it, which is more
  // than "let me actually see this map".
  const expand = document.createElement("button");
  expand.type = "button";
  expand.className = "trip-map-expand";
  setIcon(expand, MAP_ICONS.expand, ui.map.expand);

  /** The card's view when it was expanded, put back when it closes. */
  let beforeExpand: typeof view | null = null;
  const setExpanded = (on: boolean) => {
    // Untouched since the last fit: expanded, it fits again to the new frame
    // rather than containing the old view — which, in a portrait frame, was
    // mostly empty ocean above and below.
    const atFit = view.w === fitView.w && view.h === fitView.h && view.x === fitView.x && view.y === fitView.y;
    if (on) beforeExpand = { ...view };
    root.classList.toggle("is-expanded", on);
    document.body.classList.toggle("map-expanded", on);
    setIcon(expand, on ? MAP_ICONS.close : MAP_ICONS.expand, on ? ui.common.close : ui.map.expand);
    // The container changes shape, so the fitted view has to be recomputed or
    // the map sits letterboxed inside its old aspect ratio.
    //
    // Recomputed to *contain* what was in view, not to keep its height. For a
    // container wider than the view they are the same thing. For a narrower
    // one — the phone's full-screen map, portrait, 0.47:1 against the fitted
    // 1.9:1 — keeping the height cut the width to a quarter, so expanding, and
    // Fit after it, showed a sliver of the middle of the map.
    requestAnimationFrame(() => {
      const box = canvas.getBoundingClientRect();
      if (box.height > 0) {
        const shape = box.width / box.height;
        const contain = (b: { w: number; h: number }) =>
          shape >= b.w / b.h ? { w: b.h * shape, h: b.h } : { w: b.w, h: b.w / shape };
        // The size reference: the original fit contained. Discs and labels
        // scale by view.h / home.h, which this keeps at the size they were
        // drawn in the smaller frame; MAX_SCALE counts from it too.
        Object.assign(home, contain(fitted));
        // Fit contains the places themselves rather than the 1.9:1 box drawn
        // round them, which is padded for a landscape frame — in a portrait
        // one it left them across 40% of the width. Never closer than the
        // original fit, so a wide frame fits as it always did.
        const fit = contain(extent);
        Object.assign(fitView, fit.h < fitted.h ? { w: fitted.h * shape, h: fitted.h } : fit);
        // Closing puts the card back as it was. Containing the full-screen
        // view instead zoomed out ~2.7x per cycle on the phone: a tall view,
        // contained in a wide frame, has its height set the width.
        if (!on && beforeExpand) Object.assign(view, beforeExpand);
        else if (on && atFit) Object.assign(view, fitView);
        else Object.assign(view, contain(view));
      }
      clusterBucket = Number.NaN;
      pixelHeight = 0;
      frameAspect = 0;
      apply();
    });
  };

  expand.addEventListener("click", () => setExpanded(!root.classList.contains("is-expanded")));
  // Removed with the map: the home page is rebuilt on every visit, and one
  // listener per visit would pile up for the life of the page.
  const onEscape = (event: KeyboardEvent) => {
    if (!root.isConnected) return document.removeEventListener("keydown", onEscape);
    if (event.key === "Escape" && root.classList.contains("is-expanded")) setExpanded(false);
  };
  document.addEventListener("keydown", onEscape);

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "trip-map-reset";
  setIcon(reset, MAP_ICONS.fit, ui.common.fit);
  reset.addEventListener("click", () => {
    Object.assign(view, fitView);
    apply();
  });

  // One stack of round icon buttons, the phone's style, with zoom added: the
  // desktop had "Expand" and "Fit" in words and no way to zoom but the wheel,
  // which a trackpad without a scroll gesture does not have. The classes of
  // Fit and Expand are kept — the phone app hides these and clicks them from
  // its own controls (mobile/ui.ts phoneMapControls).
  const controls = document.createElement("div");
  controls.className = "trip-map-controls";
  for (const [cls, icon, label, factor] of [
    ["trip-map-zoom-in", MAP_ICONS.plus, ui.map.zoomIn, 1 / 1.8],
    ["trip-map-zoom-out", MAP_ICONS.minus, ui.map.zoomOut, 1.8],
  ] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = cls;
    setIcon(button, icon, label);
    button.addEventListener("click", () => zoomBy(factor));
    controls.appendChild(button);
  }
  controls.append(reset, expand);
  root.appendChild(controls);
  if (status) {
    root.appendChild(status);
    updateStatus();
  }

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
  const basemap = await loadBasemap();

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
  drawPlaceMap(root, basemap, cities, {
    label: ui.map.label(loc(trip.name)),
    route: routeKeys,
    onPick: (i) => {
      const anchor = cities[i].anchor;
      if (anchor) onPick(anchor);
    },
  });
  return root;
}
