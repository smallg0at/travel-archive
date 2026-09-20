import type { DayRecord, HomePlace } from "@travel-archive/shared";

import { drawPlaceMap, loadBasemap } from "../tripMap";
import { homeMapOptions, homeMapPoints } from "../homeMap";
import { el } from "../photoUi";
import { contentLanguage, loc, locDay } from "../contentLang";
import { ui } from "../i18n";
import { dismiss, openLayer } from "./overlay";
import { go, switchTab } from "./router";
import { openDate } from "./day";
import { tripCard } from "./trips";
import { loadHomeKept } from "./cache";
import { archive, coverIds, ICONS, leave, note, phoneMapControls, screen, sectionFor, shortDate, thumb, trips } from "./ui";

/**
 * The phone's front page. The desktop's home (src/home.ts) asks the same two
 * questions — where has this library been, and what happened on this date —
 * and this answers them in a column: the map, then the anniversaries, then
 * the latest trips, which are what a phone is most often opened to show
 * someone.
 */

/** Strips under "On this day" before the section ends. */
const MAX_DAYS = 6;
/** Pictures per strip: enough to see the day, few enough not to scroll sideways much. */
const STRIP = 8;
/** As the desktop: widen to a week when today's date has nothing. */
const NEAR_DAYS = 3;
const RECENT_TRIPS = 4;

const monthDay = (d: Date) => `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The same rule as the desktop's `anniversaries`, from the organized days in the index. */
function anniversaries(today: Date): { days: DayRecord[]; exact: boolean } {
  const byDate = new Map<string, DayRecord>();
  for (const section of archive().sections) for (const day of section.days) if (!byDate.has(day.date)) byDate.set(day.date, day);
  const newest = (list: DayRecord[]) => list.sort((a, b) => b.date.localeCompare(a.date));
  const all = [...byDate.values()];

  const exact = all.filter((d) => d.date.slice(5) === monthDay(today));
  if (exact.length) return { days: newest(exact), exact: true };
  const near = new Set<string>();
  for (let offset = -NEAR_DAYS; offset <= NEAR_DAYS; offset++) {
    const d = new Date(today);
    d.setDate(d.getDate() + offset);
    near.add(monthDay(d));
  }
  return { days: newest(all.filter((d) => near.has(d.date.slice(5)))), exact: false };
}

function dayStrip(day: DayRecord, exact: boolean, today: Date): HTMLElement {
  const shown = locDay(day);
  const item = el<HTMLElement>(`
    <article class="m-then">
      <header class="m-then-head"><strong></strong><span></span></header>
      <p class="m-then-summary"></p>
      <div class="m-strip"></div>
    </article>
  `);
  const years = today.getFullYear() - Number(day.date.slice(0, 4));
  item.querySelector("strong")!.textContent = exact ? day.date.slice(0, 4) : shortDate(day.date) + ` ${day.date.slice(0, 4)}`;
  item.querySelector(".m-then-head span")!.textContent = [ui.home.yearsAgo(years), shown.place].filter(Boolean).join(" · ");
  const summary = item.querySelector<HTMLElement>(".m-then-summary")!;
  if (shown.summary) summary.textContent = shown.summary;
  else summary.remove();
  const strip = item.querySelector<HTMLElement>(".m-strip")!;
  for (const id of coverIds(day, STRIP)) strip.appendChild(thumb(id, "medium"));
  item.addEventListener("click", () => openDate(day.date));
  return item;
}

function placeLabel(place: HomePlace): string {
  // As the desktop: the Chinese fallback is the endonym, never the English.
  const name = contentLanguage() === "zh-Hans" ? (place.nameZh ?? place.name) : (place.nameEn ?? place.name);
  return name;
}

/** A marker's days, as a bottom sheet over the map. */
function placeSheet(place: HomePlace): void {
  const sheet = el<HTMLElement>(`
    <div class="m-sheet-wrap">
      <div class="m-sheet-backdrop"></div>
      <section class="m-sheet" role="dialog" aria-modal="true">
        <div class="m-sheet-handle"></div>
        <h2></h2><p class="m-sheet-meta"></p>
        <div class="m-sheet-list"></div>
      </section>
    </div>
  `);
  sheet.querySelector("h2")!.textContent = placeLabel(place);
  sheet.querySelector(".m-sheet-meta")!.textContent = ui.home.placeMeta(place.photoCount, place.days.length);
  const list = sheet.querySelector<HTMLElement>(".m-sheet-list")!;
  for (const date of [...place.days].reverse()) {
    const found = sectionFor(date);
    const row = el<HTMLButtonElement>(`<button type="button" class="m-list-row"><span><strong></strong><small></small></span>${ICONS.chevron}</button>`);
    row.querySelector("strong")!.textContent = `${shortDate(date)} ${date.slice(0, 4)}`;
    row.querySelector("small")!.textContent = found?.section.kind === "trip" ? loc(found.section.name) : "";
    // Close the sheet first and navigate once its history step has gone, or
    // the pop would undo the push.
    row.addEventListener("click", () => void dismiss().then(() => openDate(date)));
    list.appendChild(row);
  }
  const close = () => leave(sheet);
  sheet.querySelector(".m-sheet-backdrop")!.addEventListener("click", () => void dismiss());
  sheet.querySelector(".m-sheet-handle")!.addEventListener("click", () => void dismiss());
  document.body.appendChild(sheet);
  openLayer(close);
}

async function fillMap(section: HTMLElement): Promise<void> {
  const home = await loadHomeKept();
  const totals = section.querySelector<HTMLElement>(".m-home-totals")!;
  const slot = section.querySelector<HTMLElement>(".m-home-map")!;
  if (!home?.places.length) {
    // Not the desktop's "run a scan" (ui.home.noMap): nothing on a phone can
    // run one, and null here is as often "could not load" — signed out,
    // offline — as "nothing placed". The rest of the page stands on its own.
    section.remove();
    return;
  }
  totals.textContent = ui.home.totals(home.totals.placed, home.places.length, home.totals.countries);

  // The desktop's home map exactly — points, clustering, labels and options
  // all come from homeMap.ts, which owns them for both. Only the controls,
  // the full-screen layer and the sheet a place opens are the phone's.
  const { ordered, points } = homeMapPoints(home.places);
  const basemap = await loadBasemap();
  if (!slot.isConnected) return;
  slot.replaceChildren();
  drawPlaceMap(slot, basemap, points, { ...homeMapOptions(home.places), onPick: (i) => placeSheet(ordered[i]) });
  phoneMapControls(slot);
}

export function renderHome(): HTMLElement {
  const page = screen("m-home");
  const head = el<HTMLElement>(`
    <header class="m-large-head">
      <h1></h1>
      <button type="button" class="m-icon-btn m-home-settings">${ICONS.settings}</button>
    </header>
  `);
  head.querySelector("h1")!.textContent = ui.app.title;
  const settings = head.querySelector<HTMLButtonElement>(".m-home-settings")!;
  settings.setAttribute("aria-label", ui.nav.settings);
  settings.addEventListener("click", () => go("#/settings"));
  page.appendChild(head);

  const mapSection = el<HTMLElement>(`
    <section class="m-section">
      <p class="m-home-totals"></p>
      <div class="trip-map home-map m-map m-home-map"></div>
      <p class="m-hint"></p>
    </section>
  `);
  mapSection.querySelector(".m-hint")!.textContent = ui.mobile.tapPlace;
  mapSection.querySelector(".m-home-map")!.textContent = ui.map.loading;
  page.appendChild(mapSection);
  void fillMap(mapSection);

  const today = new Date();
  const { days, exact } = anniversaries(today);
  const then = el<HTMLElement>(`<section class="m-section"><h2 class="m-section-title"></h2></section>`);
  then.querySelector("h2")!.textContent = exact || !days.length ? ui.home.thenTitle : ui.home.thenNearTitle;
  if (days.length) for (const day of days.slice(0, MAX_DAYS)) then.appendChild(dayStrip(day, exact, today));
  else then.appendChild(note(ui.home.nothingToday));
  page.appendChild(then);

  const recent = trips().slice(0, RECENT_TRIPS);
  if (recent.length) {
    const section = el<HTMLElement>(`
      <section class="m-section">
        <div class="m-section-head"><h2 class="m-section-title"></h2><button type="button" class="m-link"></button></div>
        <div class="m-hscroll"></div>
      </section>
    `);
    section.querySelector("h2")!.textContent = ui.mobile.trips;
    const all = section.querySelector<HTMLButtonElement>(".m-link")!;
    all.textContent = ui.mobile.seeAll;
    all.addEventListener("click", () => switchTab("trips"));
    const row = section.querySelector<HTMLElement>(".m-hscroll")!;
    for (const trip of recent) row.appendChild(tripCard(trip, "compact"));
    page.appendChild(section);
  }

  return page;
}
