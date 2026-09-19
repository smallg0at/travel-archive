import type { MonthSummary, PhotoRecord } from "@travel-archive/shared";
import { loadMonth, SignInRequiredError } from "../archiveData";
import { el, lazyImg } from "../photoUi";
import { loc, locDay } from "../contentLang";
import { ui } from "../i18n";
import { go } from "./router";
import { openDate } from "./day";
import { openViewer } from "./viewer";
import { archive, dateOf, ICONS, longDate, monthLabel, note, pageBar, screen, sectionFor, spinner, thumb, titleWhenPast } from "./ui";

/**
 * The whole library by month: the phone's version of the desktop sidebar's
 * year and month groups, as a list you scroll rather than a column you keep.
 *
 * A month page is the album view — every photo by day, for finding things —
 * and it is the one screen on the phone that can hold thousands of pictures:
 * August 2026 has 4,998. So it renders a few days at a time as the reader
 * nears the end, instead of building every cell up front. Lazy image loading
 * alone does not solve that; the cells exist whether or not their image has
 * arrived, and on a phone the layout of 5,000 of them is the cost.
 */

/** Photos rendered per batch on a month page — a few screens of 3-across squares. */
const BATCH_PHOTOS = 180;

function monthRow(month: MonthSummary, tripNames: string[]): HTMLElement {
  const row = el<HTMLButtonElement>(`
    <button type="button" class="m-month-row">
      <span class="m-month-thumb"></span>
      <span class="m-month-text"><strong></strong><small></small></span>
      ${ICONS.chevron}
    </button>
  `);
  if (month.coverPhotoId) row.querySelector(".m-month-thumb")!.appendChild(thumb(month.coverPhotoId, "medium"));
  row.querySelector("strong")!.textContent = monthLabel(month.month);
  row.querySelector("small")!.textContent = [ui.common.photos(month.photoCount), ...tripNames].join(" · ");
  row.addEventListener("click", () => go(`#/month/${month.month}`));
  return row;
}

export function renderLibrary(): HTMLElement {
  const page = screen("m-library");
  const head = el<HTMLElement>(`<header class="m-large-head"><h1></h1></header>`);
  head.querySelector("h1")!.textContent = ui.mobile.tabs.library;
  page.appendChild(head);

  const index = archive();
  // Which trips touch each month, so a row can say "the train 1" — the name
  // a reader is actually looking for, which a month label alone never shows.
  const tripsByMonth = new Map<string, string[]>();
  for (const section of index.sections) {
    if (section.kind !== "trip") continue;
    for (const month of new Set(section.days.map((d) => d.date.slice(0, 7)))) {
      tripsByMonth.set(month, [...(tripsByMonth.get(month) ?? []), loc(section.name)]);
    }
  }

  const months = [...index.months].sort((a, b) => b.month.localeCompare(a.month));
  if (!months.length) {
    page.appendChild(note(ui.app.emptyArchiveHtml.replace(/<[^>]+>/g, "")));
    return page;
  }
  let year = "";
  let group: HTMLElement | null = null;
  for (const month of months) {
    if (month.month.slice(0, 4) !== year) {
      year = month.month.slice(0, 4);
      group = el<HTMLElement>(`<section class="m-section"><h2 class="m-year"></h2><div class="m-group"></div></section>`);
      group.querySelector("h2")!.textContent = year;
      page.appendChild(group);
    }
    group!.querySelector(".m-group")!.appendChild(monthRow(month, tripsByMonth.get(month.month) ?? []));
  }
  return page;
}

function daySection(date: string | null, photos: PhotoRecord[]): HTMLElement {
  const section = el<HTMLElement>(`
    <section class="m-album-day">
      <header class="m-album-day-head"><div><strong></strong><small></small></div></header>
    </section>
  `);
  const found = date ? sectionFor(date) : null;
  const day = found ? locDay(found.day) : null;
  section.querySelector("strong")!.textContent = date ? longDate(date) : ui.album.undated;
  section.querySelector("small")!.textContent = [ui.common.photos(photos.length), day?.place].filter(Boolean).join(" · ");

  // A day that has been written up has a better page than this grid; offer it.
  if (date && day?.segments?.length) {
    const open = el<HTMLButtonElement>(`<button type="button" class="m-link"></button>`);
    open.textContent = ui.home.openDay;
    open.addEventListener("click", () => openDate(date));
    section.querySelector("header")!.appendChild(open);
  }
  if (day?.summary) section.appendChild(Object.assign(document.createElement("p"), { className: "m-album-summary", textContent: day.summary }));

  const grid = el<HTMLDivElement>(`<div class="m-grid"></div>`);
  photos.forEach((photo, i) => {
    const img = lazyImg(photo, "medium");
    img.addEventListener("click", () => openViewer(photos, i));
    grid.appendChild(img);
  });
  section.appendChild(grid);
  return section;
}

async function fillMonth(page: HTMLElement, month: string): Promise<void> {
  const body = page.querySelector<HTMLElement>(".m-month-body")!;
  let photos: PhotoRecord[];
  try {
    photos = Object.values((await loadMonth(month)).photos);
  } catch (err) {
    body.replaceChildren(note(err instanceof SignInRequiredError ? ui.mobile.sessionExpired : ui.app.failedToLoad((err as Error).message)));
    if (err instanceof SignInRequiredError) window.dispatchEvent(new CustomEvent("signin-required"));
    return;
  }
  photos.sort((a, b) => (a.takenAt ?? "").localeCompare(b.takenAt ?? ""));

  const byDay = new Map<string | null, PhotoRecord[]>();
  for (const photo of photos) {
    const key = dateOf(photo);
    byDay.set(key, [...(byDay.get(key) ?? []), photo]);
  }
  // Undated last, as the album does.
  const days = [...byDay.keys()].sort((a, b) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)));
  page.querySelector(".m-month-meta")!.textContent = `${ui.common.photos(photos.length)} · ${ui.common.days(days.length)}`;
  body.replaceChildren();

  let next = 0;
  const sentinel = el<HTMLDivElement>(`<div class="m-sentinel"></div>`);
  const more = () => {
    let added = 0;
    while (next < days.length && added < BATCH_PHOTOS) {
      const list = byDay.get(days[next])!;
      body.insertBefore(daySection(days[next], list), sentinel);
      added += list.length;
      next++;
    }
    if (next >= days.length) {
      observer.disconnect();
      sentinel.remove();
    }
  };
  // Well ahead of the end, so a fast fling finds the next days already laid out.
  const observer = new IntersectionObserver((entries) => entries[0].isIntersecting && more(), { rootMargin: "1500px 0px" });
  body.appendChild(sentinel);
  more();
  if (sentinel.isConnected) observer.observe(sentinel);
}

export function renderMonth(month: string): HTMLElement {
  const page = screen("m-month");
  const label = monthLabel(month);
  const bar = pageBar(label);
  page.appendChild(bar);
  const head = el<HTMLElement>(`<header class="m-page-head"><h1></h1><p class="m-month-meta"></p></header>`);
  head.querySelector("h1")!.textContent = label;
  page.appendChild(head);
  titleWhenPast(bar, head.querySelector("h1")!);
  const body = el<HTMLElement>(`<div class="m-month-body"></div>`);
  body.appendChild(spinner());
  page.appendChild(body);
  void fillMonth(page, month);
  return page;
}
