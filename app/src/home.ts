import type { ArchiveIndexFile, HomePlace, PhotoRecord } from "@travel-archive/shared";
import { dayMeta, loadHomeIndex, loadIndex, loadMonth } from "./archiveData";
import { el, hydrateAll, lazyImg } from "./photoUi";
import { contentLanguage } from "./contentLang";
import { ui } from "./i18n";
import { openDay } from "./album";
import { drawPlaceMap, loadBasemap, type MapPoint } from "./tripMap";
import { mountSearch } from "./search";

/**
 * The front page: search, everywhere this library has been, and what happened
 * on this date in other years.
 *
 * The map answers "where have we been", which nothing else in the app could
 * show — the album is organised by time, so a place visited four times over
 * six years appears in four places and nowhere together. "On this day"
 * answers the one a photo library is uniquely able to: it surfaces days
 * nobody would have gone looking for. Search sits above both because it is
 * the other way in when you do know what you are looking for.
 *
 * The map is the trip map's renderer (`drawPlaceMap`), not a copy of it. The
 * first version was a copy and had none of that map's zoom, pan, labels or
 * reference layers.
 *
 * Its coordinates come from `home.json`, built by the pipeline, because GPS
 * lives in 30 month shards totalling 38MB and `index.json` carries none. "On
 * this day" needs no such file: every date and summary is already in the index
 * this page has loaded, so it is computed here and cannot go stale.
 */

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
/** Days listed when a place is chosen on the map. A home city has hundreds; this panel is a way in, not the album. */
const MAX_PLACE_DAYS = 24;

/** The name to show, in the reader's language, falling back to what exists. */
function placeLabel(place: HomePlace): string {
  // The Chinese fallback is the endonym, never the English name: 349 of 515
  // places carry no separate Chinese name, and for Beijing that is because
  // `name` is already 城市 — falling back to `nameEn` printed "Beijing" in the
  // middle of a Chinese map.
  const name =
    contentLanguage() === "zh-Hans" ? (place.nameZh ?? place.name) : (place.nameEn ?? place.name);
  // The country is on the tooltip, not the label: at world scale the label is
  // there to say *which* dot this is, and "a city" does that alone.
  const comma = name.indexOf(",");
  return comma === -1 ? name : name.slice(0, comma);
}

/* --- On this day -------------------------------------------------------- */

/** `MM-DD` of a local date, which is what "today" means to a reader. */
function monthDay(date: Date): string {
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Days that share today's date in other years, newest first — and whether they
 * do, or are only near it.
 *
 * Widened to a window only when the exact date has nothing: an anniversary is
 * a stronger thing than "around now", so the two are never mixed in one list.
 */
function anniversaries(index: ArchiveIndexFile, today: Date): { dates: string[]; exact: boolean } {
  const dates = new Set<string>();
  for (const section of index.sections) for (const day of section.days) dates.add(day.date);
  const newestFirst = (list: string[]) => list.sort((a, b) => b.localeCompare(a));

  const exact = [...dates].filter((date) => date.slice(5) === monthDay(today));
  if (exact.length) return { dates: newestFirst(exact), exact: true };

  const near = new Set<string>();
  for (let offset = -NEAR_DAYS; offset <= NEAR_DAYS; offset++) {
    const day = new Date(today);
    day.setDate(day.getDate() + offset);
    near.add(monthDay(day));
  }
  return { dates: newestFirst([...dates].filter((date) => near.has(date.slice(5)))), exact: false };
}

/** The day's own photo ids, from the index — the home page never loads a shard just to find them. */
function photoIdsOf(index: ArchiveIndexFile, date: string): string[] {
  for (const section of index.sections) {
    const day = section.days.find((d) => d.date === date);
    if (day) return day.photoIds;
  }
  return [];
}

async function photosFor(date: string, ids: string[]): Promise<PhotoRecord[]> {
  const shard = await loadMonth(date.slice(0, 7)).catch(() => null);
  if (!shard) return [];
  return ids
    .slice(0, MAX_PHOTOS)
    .map((id) => shard.photos[id])
    .filter(Boolean);
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
      <div class="home-search"></div>
      <div class="home-body">
        <div class="home-map-slot"></div>
        <div class="home-place" hidden></div>
        <section class="home-then">
          <h2 class="home-then-title"></h2>
          <div class="home-then-list"></div>
        </section>
      </div>
    </div>
  `);
  page.querySelector(".home-title")!.textContent = ui.home.title;
  const body = page.querySelector<HTMLElement>(".home-body")!;

  // Results replace the page rather than stacking under the map, where a
  // reader who has just typed would have to scroll past the world to see them.
  const search = mountSearch({
    lazy: true,
    onActive: (active) => (body.hidden = active),
    onOpenDay: (date, section) => void openDay(date, section),
  });
  search.classList.add("is-embedded");
  page.querySelector(".home-search")!.replaceWith(search);
  content.replaceChildren(page);

  const [index, home] = await Promise.all([loadIndex().catch(() => null), loadHomeIndex()]);
  if (!index || !page.isConnected) return;

  // The two halves are independent: a library that has never been organized
  // has no home.json, and its anniversaries are still worth showing.
  const slot = page.querySelector<HTMLElement>(".home-map-slot")!;
  const totals = page.querySelector<HTMLElement>(".home-totals")!;
  if (home && home.places.length) {
    totals.textContent = ui.home.totals(home.totals.placed, home.places.length, home.totals.countries);
    const panel = page.querySelector<HTMLElement>(".home-place")!;
    const root = el<HTMLDivElement>(`<div class="trip-map home-map"></div>`);
    root.textContent = ui.map.loading;
    slot.replaceWith(root);
    // Biggest drawn last, so on top. Discs keep a constant size on screen, so
    // at world zoom the capital's is covered by its own suburbs if they come later:
    // a tap on the dot labelled "the capital" opened a village. Zooming in separates
    // them, which is how the small ones are reached.
    const ordered = [...home.places].reverse();
    const points: MapPoint[] = ordered.map((place) => ({
      key: place.name,
      name: placeLabel(place),
      lat: place.lat,
      lon: place.lon,
      photoCount: place.photoCount,
    }));
    const basemap = await loadBasemap();
    if (!root.isConnected) return;
    drawPlaceMap(root, basemap, points, {
      label: ui.home.mapLabel,
      zoomOut: "world",
      onPick: (i) => showPlace(panel, index, ordered[i]),
    });
  } else {
    totals.textContent = ui.home.noMap;
    slot.remove();
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
  for (const date of [...place.days].reverse().slice(0, MAX_PLACE_DAYS)) {
    const meta = dayMeta(index, date);
    const row = el<HTMLButtonElement>(`<button type="button" class="home-place-day"></button>`);
    row.textContent = date;
    if (meta.section) row.addEventListener("click", () => void openDay(date, meta.section!));
    else row.disabled = true;
    list.appendChild(row);
  }
  panel.appendChild(list);
  panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/**
 * "On this day", one heading per year.
 *
 * Every entry shares the month and day, so the thing that tells them apart is
 * the year — which the first version buried at the start of a line of plain
 * button text ("2025-09-18 · a year ago") in the browser's default button
 * font. The year is the heading now, and the date under it only appears when
 * the window had to widen and the day is no longer the same one.
 */
async function renderThen(page: HTMLElement, index: ArchiveIndexFile): Promise<void> {
  const title = page.querySelector<HTMLElement>(".home-then-title")!;
  const list = page.querySelector<HTMLElement>(".home-then-list")!;
  const today = new Date();
  const { dates, exact } = anniversaries(index, today);

  title.textContent = exact || !dates.length ? ui.home.thenTitle : ui.home.thenNearTitle;
  if (!dates.length) {
    list.textContent = ui.home.nothingToday;
    return;
  }

  const hosts: { date: string; host: HTMLElement }[] = [];
  const frag = document.createDocumentFragment();
  let year = "";
  let group: HTMLElement | null = null;

  for (const date of dates.slice(0, MAX_DAYS)) {
    if (date.slice(0, 4) !== year) {
      year = date.slice(0, 4);
      group = el<HTMLElement>(`
        <section class="home-then-year">
          <h3 class="home-then-year-title"><span class="home-then-year-number"></span><span class="home-then-ago"></span></h3>
        </section>
      `);
      group.querySelector(".home-then-year-number")!.textContent = year;
      group.querySelector(".home-then-ago")!.textContent = ui.home.yearsAgo(today.getFullYear() - Number(year));
      frag.appendChild(group);
    }

    const meta = dayMeta(index, date);
    const block = el<HTMLElement>(`
      <article class="home-then-day">
        <button type="button" class="home-then-head">
          <span class="home-then-date"></span>
          <span class="home-then-place"></span>
        </button>
        <p class="home-then-summary"></p>
        <div class="home-then-photos"></div>
      </article>
    `);
    const dateNode = block.querySelector<HTMLElement>(".home-then-date")!;
    if (exact) dateNode.remove();
    else dateNode.textContent = date.slice(5);
    const place = block.querySelector<HTMLElement>(".home-then-place")!;
    place.textContent = meta.place ?? ui.home.openDay;
    const summary = block.querySelector<HTMLElement>(".home-then-summary")!;
    if (meta.summary) summary.textContent = meta.summary;
    else summary.remove();
    if (meta.section) block.querySelector(".home-then-head")!.addEventListener("click", () => void openDay(date, meta.section!));
    hosts.push({ date, host: block.querySelector<HTMLElement>(".home-then-photos")! });
    group!.appendChild(block);
  }
  list.replaceChildren(frag);

  // Shards after the text, exactly as search does it: the reader can read what
  // happened while the pictures of it arrive.
  for (const { date, host } of hosts) {
    const photos = await photosFor(date, photoIdsOf(index, date));
    if (!photos.length || !host.isConnected) continue;
    const section = dayMeta(index, date).section;
    const images = photos.map((photo) => {
      const img = lazyImg(photo, "medium", "home-thumb");
      img.title = photo.caption ?? "";
      if (section) img.addEventListener("click", () => void openDay(date, section));
      host.appendChild(img);
      return img;
    });
    void hydrateAll(images);
  }
}
