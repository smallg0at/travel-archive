import type { ArchiveIndexFile, HomeIndexFile, HomePlace, PhotoRecord } from "@travel-archive/shared";
import { dayMeta, loadHomeIndex, loadIndex, loadMonth } from "./archiveData";
import { el, hydrateAll, lazyImg } from "./photoUi";
import { contentLanguage } from "./contentLang";
import { ui } from "./i18n";
import { openDay } from "./album";

/**
 * The front page: everywhere this library has been, and what happened on this
 * date in other years.
 *
 * Two halves that answer different questions. The map answers "where have we
 * been", which nothing else in the app could show — the album is organised by
 * time, so a place visited four times over six years appears in four places
 * and nowhere together. "On this day" answers the one a photo library is
 * uniquely able to: it surfaces days nobody would have gone looking for.
 *
 * The map's coordinates come from `home.json`, built by the pipeline, because
 * GPS lives in 30 month shards totalling 38MB and `index.json` carries none.
 * "On this day" needs no such file: every date and summary is already in the
 * index this page has loaded, so it is computed here and cannot go stale.
 */

/** Places labelled on the map. Beyond this the labels overlap more than they inform. */
const LABELLED = 14;
/** Days shown under "on this day" before the list becomes a scroll. */
const MAX_DAYS = 8;
/** Thumbnails per day there. */
const MAX_PHOTOS = 6;
/**
 * When today's date has nothing, the window widens by this many days either
 * side rather than showing an empty page — on a library with 789 days, roughly
 * one date in four is empty, which would make an empty front page common.
 */
const NEAR_DAYS = 3;

/* --- The map ----------------------------------------------------------- */

/**
 * The world, trimmed.
 *
 * Antarctica is a fifth of a full Mercator sheet and has never been visited by
 * anyone in this library; the northern cut keeps Svalbard and Iceland. What is
 * left is close to 2:1, which is the shape a page wants.
 */
const NORTH = 80;
const SOUTH = -58;
const WIDTH = 1000;

/** Web Mercator, normalised to the unit square — the same projection the trip map uses. */
function project(lat: number, lon: number): [number, number] {
  const x = (lon + 180) / 360;
  const clamped = Math.max(-85.05, Math.min(85.05, lat));
  const rad = (clamped * Math.PI) / 180;
  const y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
  return [x, y];
}

const TOP = project(NORTH, 0)[1];
const BOTTOM = project(SOUTH, 0)[1];
const HEIGHT = Math.round(WIDTH * (BOTTOM - TOP));

function toPx(lat: number, lon: number): [number, number] {
  const [x, y] = project(lat, lon);
  return [x * WIDTH, ((y - TOP) / (BOTTOM - TOP)) * HEIGHT];
}

interface Basemap {
  land: number[][][];
  lakes: number[][][];
  rivers: number[][][];
  borders: number[][][];
  places: [string, number, number, number][];
}

/**
 * Rings smaller than this in square pixels are dropped.
 *
 * The trip map solves the same problem by culling to the viewport, which works
 * because a trip looks at one small region. A world view has no viewport to
 * cull to, so it culls by size instead — and at this scale the discarded rings
 * are sub-pixel anyway. The basemap's own note records 5,272 nodes for 50m
 * data drawn whole, at 43ms a pan frame; this leaves a few hundred.
 */
const MIN_RING_PX2 = 6;

function ringPath(ring: number[][]): string | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const points: string[] = [];
  for (const [lon, lat] of ring) {
    const [x, y] = toPx(lat, lon);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    // One decimal is a tenth of a pixel on a 1000-wide sheet, and halves the
    // size of the path data the browser has to parse.
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  if ((maxX - minX) * (maxY - minY) < MIN_RING_PX2) return null;
  return `M${points.join("L")}Z`;
}

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

/** The name to show, in the reader's language, falling back to what exists. */
function placeLabel(place: HomePlace): string {
  // The Chinese fallback is the endonym, never the English name: 349 of 515
  // places carry no separate Chinese name, and for Beijing that is because
  // `name` is already 城市 — falling back to `nameEn` printed "Beijing" in the
  // middle of a Chinese map.
  const name =
    contentLanguage() === "zh-Hans" ? (place.nameZh ?? place.name) : (place.nameEn ?? place.name);
  // The country is on the marker's title, not its label: at world scale the
  // label is there to say *which* dot this is, and "a city" does that alone.
  const comma = name.indexOf(",");
  return comma === -1 ? name : name.slice(0, comma);
}

/**
 * Marker radius from photo count, by area rather than by radius.
 *
 * A linear radius would make the home city a disc swallowing a continent: the
 * counts here span 1 to several thousand. The square root keeps the *area*
 * proportional, which is how a reader compares circles anyway.
 */
function radiusFor(count: number, max: number): number {
  const scaled = Math.sqrt(count / Math.max(1, max));
  return 2.5 + scaled * 11;
}

async function renderMap(home: HomeIndexFile, onPick: (place: HomePlace) => void): Promise<SVGElement> {
  const root = svg("svg", {
    class: "home-map",
    viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
    preserveAspectRatio: "xMidYMid meet",
    role: "img",
    "aria-label": ui.home.mapLabel,
  });

  // Dynamic, like the trip map's: 1.9MB that a reader who never opens this
  // page should not pay for, and that must not delay first paint.
  const basemap = ((await import("./geo/basemap.json")) as unknown as { default: Basemap }).default;

  const land = svg("g", { class: "home-land" });
  for (const ring of basemap.land) {
    const d = ringPath(ring);
    if (d) land.appendChild(svg("path", { d }));
  }
  root.appendChild(land);

  const lakes = svg("g", { class: "home-lakes" });
  for (const ring of basemap.lakes) {
    const d = ringPath(ring);
    if (d) lakes.appendChild(svg("path", { d }));
  }
  root.appendChild(lakes);

  const max = home.places.reduce((most, p) => Math.max(most, p.photoCount), 1);
  const markers = svg("g", { class: "home-markers" });

  // Smallest first, so a big city never covers a small one that sits inside
  // its radius — the reverse of the file's own order.
  for (const place of [...home.places].reverse()) {
    const [x, y] = toPx(place.lat, place.lon);
    const dot = svg("circle", {
      cx: x.toFixed(1),
      cy: y.toFixed(1),
      r: radiusFor(place.photoCount, max).toFixed(1),
      class: "home-marker",
      tabindex: 0,
      role: "button",
    });
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${placeLabel(place)} — ${ui.home.photos(place.photoCount)}`;
    dot.appendChild(title);
    dot.addEventListener("click", () => onPick(place));
    dot.addEventListener("keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      if (key === "Enter" || key === " ") {
        event.preventDefault();
        onPick(place);
      }
    });
    markers.appendChild(dot);
  }
  root.appendChild(markers);

  // Labels last and in one group, so they sit above every marker rather than
  // above only the ones drawn before them.
  const labels = svg("g", { class: "home-labels" });
  for (const place of home.places.slice(0, LABELLED)) {
    const [x, y] = toPx(place.lat, place.lon);
    const text = svg("text", {
      x: (x + radiusFor(place.photoCount, max) + 3).toFixed(1),
      y: (y + 3.5).toFixed(1),
      class: "home-label",
    });
    text.textContent = placeLabel(place);
    labels.appendChild(text);
  }
  root.appendChild(labels);

  return root;
}

/* --- On this day -------------------------------------------------------- */

/** `MM-DD` of a local date, which is what "today" means to a reader. */
function monthDay(date: Date): string {
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

interface Anniversary {
  date: string;
  /** True when it is this exact date in another year rather than one nearby. */
  exact: boolean;
}

/**
 * Days that share today's date in other years, newest first.
 *
 * Widened to a window only when the exact date has nothing: an anniversary is
 * a stronger thing than "around now", so the two are never mixed.
 */
function anniversaries(index: ArchiveIndexFile, today: Date): Anniversary[] {
  const dates = new Set<string>();
  for (const section of index.sections) for (const day of section.days) dates.add(day.date);

  const wanted = new Map<string, boolean>();
  wanted.set(monthDay(today), true);
  const exact = [...dates].filter((date) => date.slice(5) === monthDay(today));
  if (exact.length) return exact.sort((a, b) => b.localeCompare(a)).map((date) => ({ date, exact: true }));

  for (let offset = -NEAR_DAYS; offset <= NEAR_DAYS; offset++) {
    if (offset === 0) continue;
    const near = new Date(today);
    near.setDate(near.getDate() + offset);
    wanted.set(monthDay(near), false);
  }
  return [...dates]
    .filter((date) => wanted.has(date.slice(5)))
    .sort((a, b) => b.localeCompare(a))
    .map((date) => ({ date, exact: false }));
}

async function photosFor(date: string, ids: string[]): Promise<PhotoRecord[]> {
  const shard = await loadMonth(date.slice(0, 7)).catch(() => null);
  if (!shard) return [];
  return ids
    .slice(0, MAX_PHOTOS)
    .map((id) => shard.photos[id])
    .filter(Boolean);
}

/** The day's own photo ids, from the index — the home page never loads a shard to find them. */
function photoIdsOf(index: ArchiveIndexFile, date: string): string[] {
  for (const section of index.sections) {
    const day = section.days.find((d) => d.date === date);
    if (day) return day.photoIds;
  }
  return [];
}

/* --- The page ----------------------------------------------------------- */

export async function showHome(): Promise<void> {
  const content = document.getElementById("content")!;
  const page = el<HTMLDivElement>(`
    <div class="home-page">
      <header class="home-head">
        <h1 class="home-title"></h1>
        <p class="home-totals"></p>
      </header>
      <section class="home-map-box">
        <div class="home-map-loading"></div>
        <div class="home-place" hidden></div>
      </section>
      <section class="home-then">
        <h2 class="home-then-title"></h2>
        <div class="home-then-list"></div>
      </section>
    </div>
  `);
  page.querySelector(".home-title")!.textContent = ui.home.title;
  page.querySelector(".home-map-loading")!.textContent = ui.map.loading;
  content.replaceChildren(page);

  const [index, home] = await Promise.all([loadIndex().catch(() => null), loadHomeIndex()]);
  if (!index) return;

  // The two halves are independent: a library that has never been organized
  // has no home.json, and the anniversaries below are still worth showing.
  const mapBox = page.querySelector<HTMLElement>(".home-map-box")!;
  const totals = page.querySelector<HTMLElement>(".home-totals")!;
  if (home && home.places.length) {
    totals.textContent = ui.home.totals(home.totals.placed, home.places.length, home.totals.countries);
    const panel = page.querySelector<HTMLElement>(".home-place")!;
    const map = await renderMap(home, (place) => showPlace(panel, index, place));
    mapBox.querySelector(".home-map-loading")!.remove();
    mapBox.insertBefore(map, panel);
  } else {
    totals.textContent = ui.home.noMap;
    mapBox.remove();
  }

  await renderThen(page, index);
}

/** What one marker opens: its days, as links into the album. */
function showPlace(panel: HTMLElement, index: ArchiveIndexFile, place: HomePlace): void {
  panel.hidden = false;
  panel.replaceChildren();

  const head = el<HTMLElement>(`<div class="home-place-head"><strong></strong><span></span></div>`);
  head.querySelector("strong")!.textContent = placeLabel(place);
  head.querySelector("span")!.textContent = ui.home.placeMeta(place.photoCount, place.days.length);
  panel.appendChild(head);

  const list = el<HTMLElement>(`<div class="home-place-days"></div>`);
  // Newest first, and capped: a home city has hundreds of days and the point
  // of this panel is to get into the album, not to be the album.
  for (const date of [...place.days].reverse().slice(0, 24)) {
    const meta = dayMeta(index, date);
    const row = el<HTMLButtonElement>(`<button type="button" class="home-place-day"></button>`);
    row.textContent = date;
    if (meta.section) row.addEventListener("click", () => void openDay(date, meta.section!));
    else row.disabled = true;
    list.appendChild(row);
  }
  panel.appendChild(list);
}

async function renderThen(page: HTMLElement, index: ArchiveIndexFile): Promise<void> {
  const title = page.querySelector<HTMLElement>(".home-then-title")!;
  const list = page.querySelector<HTMLElement>(".home-then-list")!;
  const found = anniversaries(index, new Date());

  if (!found.length) {
    title.textContent = ui.home.thenTitle;
    list.textContent = ui.home.nothingToday;
    return;
  }
  title.textContent = found[0].exact ? ui.home.thenTitle : ui.home.thenNearTitle;

  const hosts: { date: string; host: HTMLElement }[] = [];
  const frag = document.createDocumentFragment();
  for (const { date } of found.slice(0, MAX_DAYS)) {
    const meta = dayMeta(index, date);
    const block = el<HTMLElement>(`
      <section class="home-then-day">
        <button type="button" class="home-then-head">
          <span class="home-then-date"></span>
          <span class="home-then-place"></span>
        </button>
        <p class="home-then-summary"></p>
        <div class="home-then-photos"></div>
      </section>
    `);
    block.querySelector(".home-then-date")!.textContent = `${date} · ${ui.home.yearsAgo(new Date().getFullYear() - Number(date.slice(0, 4)))}`;
    block.querySelector(".home-then-place")!.textContent = meta.place ?? "";
    const summary = block.querySelector<HTMLElement>(".home-then-summary")!;
    if (meta.summary) summary.textContent = meta.summary;
    else summary.remove();
    if (meta.section) block.querySelector(".home-then-head")!.addEventListener("click", () => void openDay(date, meta.section!));
    hosts.push({ date, host: block.querySelector<HTMLElement>(".home-then-photos")! });
    frag.appendChild(block);
  }
  list.replaceChildren(frag);

  // Shards after the text, exactly as search does it: the reader can read what
  // happened while the pictures of it arrive.
  for (const { date, host } of hosts) {
    const photos = await photosFor(date, photoIdsOf(index, date));
    if (!photos.length) continue;
    const meta = dayMeta(index, date);
    const images = photos.map((photo) => {
      const img = lazyImg(photo, "medium", "home-thumb");
      img.title = photo.caption ?? "";
      if (meta.section) img.addEventListener("click", () => void openDay(date, meta.section!));
      host.appendChild(img);
      return img;
    });
    void hydrateAll(images);
  }
}
