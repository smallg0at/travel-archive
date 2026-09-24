import type { ArchiveIndexFile, SearchIndexFile } from "@travel-archive/shared";
import { dayMeta, loadIndex, loadMonth, loadSearchIndex } from "./archiveData";
import { el, hydrateAll, lazyImg } from "./photoUi";
import { loc } from "./contentLang";
import { ui } from "./i18n";
import { openPhoto } from "./viewer";
import { openDay } from "./album";

/**
 * The search bar in the title bar, and the panel its results land in.
 *
 * It lives on the window rather than in a page, which is the whole point: search
 * is a global capability, and while it sat inside the home page a tag clicked in
 * the viewer had nowhere to go — the page showing the tag was not the page with
 * the search box. Now every view has it, Task Manager's shape.
 *
 * The bar is created once and never replaced; results are rendered into a
 * sibling panel that floats over the content. Nothing here knows which page is
 * underneath, and no page knows this exists beyond `runSearch`.
 */

/** Below this a query matches most of the library; the panel waits instead. */
const MIN_QUERY = 2;
/** Days listed. Beyond this the answer is "narrow it down", not more scrolling. */
const MAX_DAYS = 40;
/** Thumbnails per day. The rest are reachable by opening the day. */
const MAX_PHOTOS_PER_DAY = 8;
/** Keystrokes settle before a scan, so holding a key down does not scan per character. */
const DEBOUNCE_MS = 120;

interface DayHit {
  date: string;
  photos: string[];
  summaryMatched: boolean;
}

let bar: HTMLDivElement | null = null;
let panel: HTMLDivElement | null = null;
let input: HTMLInputElement | null = null;
let clearButton: HTMLButtonElement | null = null;
let loaded: Promise<{ index: SearchIndexFile; archive: ArchiveIndexFile | null } | null> | null = null;
let timer = 0;
/** Bumped per query so a slow one cannot paint over a newer one. */
let run = 0;

function dom(): { bar: HTMLDivElement; panel: HTMLDivElement; input: HTMLInputElement; clear: HTMLButtonElement } {
  bar = bar ?? (document.getElementById("search-bar") as HTMLDivElement);
  panel = panel ?? (document.getElementById("search-results") as HTMLDivElement);
  input = input ?? (document.getElementById("search-input") as HTMLInputElement);
  clearButton = clearButton ?? (document.getElementById("search-clear") as HTMLButtonElement);
  return { bar: bar!, panel: panel!, input: input!, clear: clearButton! };
}

/** Every term must appear; terms are ANDed because that is how narrowing reads. */
function matches(text: string, terms: string[]): boolean {
  for (const term of terms) if (!text.includes(term)) return false;
  return true;
}

/**
 * A photo row's text and tags, from either schema version.
 *
 * v1 stored `caption + tags + place` as one string, so its fourth element is
 * absent and the tags are unseen — the row still searches as it always did.
 */
function rowParts(row: SearchIndexFile["photos"][number]): { text: string; tags: string } {
  return { text: row[2] ?? "", tags: row[3] ?? "" };
}

function search(
  index: SearchIndexFile,
  query: string,
): { days: { date: string; photoIds: string[]; summaryMatched: boolean }[]; trips: SearchIndexFile["trips"]; total: number } {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { days: [], trips: [], total: 0 };

  const byDate = new Map<string, DayHit>();
  const hit = (date: string): DayHit => {
    let entry = byDate.get(date);
    if (!entry) byDate.set(date, (entry = { date, photos: [], summaryMatched: false }));
    return entry;
  };

  let total = 0;
  for (const row of index.photos) {
    const { text, tags } = rowParts(row);
    if (!matches(`${text} ${tags}`, terms)) continue;
    total++;
    if (row[1]) hit(row[1]).photos.push(index.idPrefix + row[0]);
  }
  for (const [date, text] of index.days) {
    if (matches(text, terms)) hit(date).summaryMatched = true;
  }
  const trips = index.trips.filter(([, name]) => matches(name.toLowerCase(), terms));

  const days = [...byDate.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, MAX_DAYS)
    .map((d) => ({ date: d.date, photoIds: d.photos, summaryMatched: d.summaryMatched }));
  return { days, trips, total };
}

/** The photos of one day, as ids and the month to load them from. */
function shardFor(photoId: string): string {
  return photoId.slice(0, 7);
}

function hidePanel(): void {
  const { panel } = dom();
  panel.hidden = true;
  panel.replaceChildren();
}

function showPanel(nodes: Node[]): void {
  const { panel } = dom();
  panel.replaceChildren(...nodes);
  panel.hidden = false;
}

/** Close the panel and give the content back — Esc, or a click outside. */
export function closeSearch(): void {
  hidePanel();
  dom().bar.classList.remove("is-active");
  dom().input.blur();
}

/**
 * Runs a query from anywhere — the tag chips use this.
 *
 * Also makes the bar visible and focuses it, so a search started by clicking a
 * tag reads as the same thing as one typed by hand.
 */
export function runSearch(query: string): void {
  const { bar, input } = dom();
  bar.hidden = false;
  input.value = query;
  bar.classList.add("is-active");
  input.focus();
  void render(query);
}

async function render(query: string): Promise<void> {
  const mine = ++run;
  const { clear } = dom();
  clear.hidden = query.length === 0;

  if (query.trim().length < MIN_QUERY) {
    hidePanel();
    return;
  }

  loaded =
    loaded ??
    Promise.all([loadSearchIndex(), loadIndex().catch(() => null)]).then(([index, archive]) =>
      index ? { index, archive } : null,
    );
  const data = await loaded;
  if (mine !== run) return;
  if (!data) {
    showPanel([el(`<div class="loading">${ui.search.unavailable}</div>`)]);
    return;
  }

  const { days, trips, total } = search(data.index, query);
  if (mine !== run) return;

  if (!days.length && !trips.length) {
    showPanel([el(`<div class="loading">${ui.search.none}</div>`)]);
    return;
  }

  const nodes: Node[] = [];
  const archived = days.filter((d) => d.date).length;
  if (archived) {
    const line = el<HTMLDivElement>(`<div class="search-count"></div>`);
    line.textContent = ui.search.count(total, archived);
    nodes.push(line);
  }

  for (const day of days) {
    const section = el<HTMLDivElement>(`<div class="search-day"></div>`);
    const head = el<HTMLButtonElement>(`<button type="button" class="search-day-head"></button>`);
    head.textContent = `${day.date}${day.summaryMatched ? ` · ${ui.search.inSummary}` : ""}`;
    head.addEventListener("click", () => {
      closeSearch();
      const section = data.archive ? dayMeta(data.archive, day.date).section : null;
      if (section) void openDay(day.date, section);
    });
    section.appendChild(head);

    const host = el<HTMLDivElement>(`<div class="search-thumbs"></div>`);
    const images = await Promise.all(
      day.photoIds.slice(0, MAX_PHOTOS_PER_DAY).map(async (id) => {
        const shard = await loadMonth(shardFor(id)).catch(() => null);
        const photo = shard?.photos[id];
        if (!photo) return null;
        const thumb = lazyImg(photo, "medium", "search-thumb");
        thumb.title = loc(photo.caption) ?? "";
        thumb.addEventListener("click", () => {
          closeSearch();
          openPhoto(photo);
        });
        const cell = el<HTMLDivElement>(`<div class="search-cell"></div>`);
        cell.appendChild(thumb);
        host.appendChild(cell);
        return thumb;
      }),
    );
    void hydrateAll(images.filter((i): i is HTMLImageElement => i !== null));
    section.appendChild(host);
    nodes.push(section);
  }

  for (const [, name, start, end] of trips) {
    const tripBtn = el<HTMLButtonElement>(`<button type="button" class="search-trip"></button>`);
    tripBtn.textContent = name;
    tripBtn.addEventListener("click", () => closeSearch());
    const meta = el<HTMLDivElement>(`<div class="search-trip-meta"></div>`);
    meta.textContent = `${start} – ${end}`;
    nodes.push(tripBtn, meta);
  }

  showPanel(nodes);
}

/**
 * Mounts the bar once. Safe to call again — it wires the same elements.
 */
export function initSearch(): void {
  const { bar, input, clear } = dom();
  bar.hidden = false;

  input.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void render(input.value), DEBOUNCE_MS);
  });
  input.addEventListener("focus", () => {
    bar.classList.add("is-active");
    if (input.value.trim().length >= MIN_QUERY) void render(input.value);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeSearch();
    }
  });
  clear.addEventListener("click", () => {
    input.value = "";
    closeSearch();
    input.focus();
  });

  // A click anywhere else closes the panel. `mousedown` rather than `click`, so
  // it lands before a thumbnail's own handler would open the photo.
  document.addEventListener("mousedown", (event) => {
    const target = event.target as Node;
    if (!panel?.hidden && !panel?.contains(target) && !bar.contains(target)) hidePanel();
  });

  // Ctrl+K, the shape people expect a title-bar search to have.
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      input.focus();
      input.select();
    }
  });
}

// Kept out of every caller: the panel's own previews never need the archive.
