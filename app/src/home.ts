import type { ArchiveIndexFile, HomePlace, PhotoRecord } from "@travel-archive/shared";
import { dayMeta, loadHomeIndex, loadIndex, loadMonth } from "./archiveData";
import { coverFirst, el, hydrateAll, lazyImg } from "./photoUi";
import { ui } from "./i18n";
import { openDay } from "./album";
import { drawPlaceMap, loadBasemap } from "./tripMap";
import { homeMapOptions, homeMapPoints, homePlaceLabel } from "./homeMap";
import { mountSearch } from "./search";
import { openPhoto } from "./viewer";

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
/** Small photos under a card's cover. The rest are a count, and one click away in the viewer. */
const STRIP_PHOTOS = 4;
/**
 * When today's date has nothing, the window widens by this many days either
 * side rather than showing an empty page — on a library with 789 days, roughly
 * one date in four is empty, which would make an empty front page common.
 */
const NEAR_DAYS = 3;
/** Days listed when a place is chosen on the map. A home city has hundreds; this panel is a way in, not the album. */
const MAX_PLACE_DAYS = 24;

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

/**
 * A day's photos, the best cover first.
 *
 * The first photo of a day is usually its least interesting — the platform,
 * the queue, a screenshot of the ticket. The captioner already marks the
 * photos worth featuring (`visibility: "feature"`, `notable`), so the cover is
 * chosen from those, and screenshots, poor frames and duplicate copies go to
 * the back rather than out: the viewer still walks every photo.
 */
async function photosFor(date: string, ids: string[]): Promise<PhotoRecord[]> {
  const shard = await loadMonth(date.slice(0, 7)).catch(() => null);
  if (!shard) return [];
  return coverFirst(ids.map((id) => shard.photos[id]).filter(Boolean));
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
    onOpenPhoto: openPhoto,
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
    // Points and options shared with the phone's home map: see homeMap.ts.
    const { ordered, points } = homeMapPoints(home.places);
    const basemap = await loadBasemap();
    if (!root.isConnected) return;
    drawPlaceMap(root, basemap, points, {
      ...homeMapOptions(home.places),
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
  head.querySelector("strong")!.textContent = homePlaceLabel(place);
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
 * "On this day", as cards: one per day, led by a photograph.
 *
 * The first version was a list — a rule down the side, a year heading, the
 * place as body text and a row of 108px squares — and read as a log file. A
 * memory is a picture first, so each card leads with one large cover (the
 * captioner's pick, see photosFor), then the year, how long ago, the place and
 * the start of what the day summary says; a few more photos and a count sit
 * underneath.
 *
 * The owner's rule for the whole page: a photo opens the photo viewer, with
 * the rest of that day behind the arrow keys; only the words open the day in
 * the album.
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

  const cards: { date: string; card: HTMLElement }[] = [];
  const frag = document.createDocumentFragment();
  for (const date of dates.slice(0, MAX_DAYS)) {
    const meta = dayMeta(index, date);
    const card = el<HTMLElement>(`
      <article class="then-card">
        <div class="then-cover"></div>
        <button type="button" class="then-text">
          <span class="then-when"><span class="then-year"></span><span class="then-ago"></span></span>
          <span class="then-place"></span>
          <span class="then-summary"></span>
        </button>
        <div class="then-strip"></div>
      </article>
    `);
    card.querySelector(".then-year")!.textContent = exact ? date.slice(0, 4) : date;
    card.querySelector(".then-ago")!.textContent = ui.home.yearsAgo(today.getFullYear() - Number(date.slice(0, 4)));
    // The country is dropped: every card on a date in the capital saying "United
    // Kingdom" is noise, and the day itself shows it.
    const place = card.querySelector<HTMLElement>(".then-place")!;
    if (meta.place) place.textContent = meta.place.split(",")[0];
    else place.remove();
    const summary = card.querySelector<HTMLElement>(".then-summary")!;
    if (meta.summary) summary.textContent = meta.summary;
    else summary.remove();
    const text = card.querySelector<HTMLButtonElement>(".then-text")!;
    if (meta.section) text.addEventListener("click", () => void openDay(date, meta.section!));
    else text.disabled = true;
    cards.push({ date, card });
    frag.appendChild(card);
  }
  list.replaceChildren(frag);

  // Pictures after the words, as search does it: a month shard is a few
  // hundred KB, and the cards are readable while they arrive.
  for (const { date, card } of cards) {
    const photos = await photosFor(date, photoIdsOf(index, date));
    if (!card.isConnected) return;
    if (!photos.length) {
      card.classList.add("is-textonly");
      continue;
    }
    const open = (photo: PhotoRecord) => () => openPhoto(photo, photos);

    const cover = lazyImg(photos[0], "large", "then-cover-img");
    cover.title = photos[0].caption ?? "";
    cover.addEventListener("click", open(photos[0]));
    card.querySelector(".then-cover")!.appendChild(cover);

    const strip = card.querySelector<HTMLElement>(".then-strip")!;
    const rest = photos.slice(1, 1 + STRIP_PHOTOS);
    const images = [cover];
    const remaining = photos.length - 1 - rest.length;
    for (const [i, photo] of rest.entries()) {
      const img = lazyImg(photo, "medium", "then-thumb");
      img.title = photo.caption ?? "";
      images.push(img);
      // The last small photo carries the count of what is not shown, and
      // opens the viewer there — the rest are one arrow key away.
      if (i === rest.length - 1 && remaining > 0) {
        const more = el<HTMLButtonElement>(`<button type="button" class="then-more"></button>`);
        more.append(img, el(`<span class="then-more-count">+${remaining}</span>`));
        more.addEventListener("click", open(photo));
        strip.appendChild(more);
      } else {
        img.addEventListener("click", open(photo));
        strip.appendChild(img);
      }
    }
    if (!rest.length) strip.remove();
    void hydrateAll(images);
  }
}
