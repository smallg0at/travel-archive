import type { ArchiveIndexFile, DayRecord, DaySegment, PhotoRecord, TripRecord } from "@travel-archive/shared";
import { el, lazyImg } from "../photoUi";
import { fmtDate, ui } from "../i18n";
import { back } from "./router";

/* --- The archive, held for the session ---------------------------------- */

/**
 * The index every screen reads, set once at start — from the copy kept on the
 * phone when there is one (cache.ts), so it is not always what `loadIndex`
 * would return. Screens read it synchronously, which is what lets each one
 * draw its whole structure before any picture has loaded.
 */
let index: ArchiveIndexFile | null = null;

export function setArchive(value: ArchiveIndexFile): void {
  index = value;
}

export function archive(): ArchiveIndexFile {
  if (!index) throw new Error("Archive not loaded");
  return index;
}

export function trips(): TripRecord[] {
  return archive()
    .sections.filter((s) => s.kind === "trip")
    .sort((a, b) => b.startDate.localeCompare(a.startDate));
}

/**
 * The section a date is read in, preferring a trip.
 *
 * A trip is the curated reading of its days, so a day inside one opens there
 * — with the trip's name over it and its neighbours as the trip's other days —
 * rather than as a line in a month.
 */
export function sectionFor(date: string): { section: TripRecord; day: DayRecord } | null {
  let fallback: { section: TripRecord; day: DayRecord } | null = null;
  for (const section of archive().sections) {
    const day = section.days.find((d) => d.date === date);
    if (!day) continue;
    if (section.kind === "trip") return { section, day };
    fallback ??= { section, day };
  }
  return fallback;
}

/* --- Photos without a shard --------------------------------------------- */

/**
 * A lazily loaded thumbnail from nothing but an id.
 *
 * `lazyImg` reads only `id` and `caption` from its record, and the index
 * already carries the ids of every organized day's photos — so the home page,
 * the trip list and a trip's day list can all show pictures without
 * downloading a single month shard. A caption would only be alt text here,
 * and it is the shard that holds it.
 */
export function thumb(id: string, size: "medium" | "large" = "large", className = ""): HTMLImageElement {
  return lazyImg({ id, caption: null } as unknown as PhotoRecord, size, className);
}

/**
 * The photos that best stand for a day, from the index alone: its cards'
 * pictures, largest first, then its other photos in order. The model already
 * judged which pictures matter at each stop; the first photo of a day is
 * usually a station platform.
 */
export function coverIds(day: DayRecord, n: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (out.length < n && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  for (const size of ["full", "half", "normal"] as const) {
    for (const seg of day.segments ?? []) {
      for (const h of seg.highlights) if (h.size === size && h.photoIds[0]) add(h.photoIds[0]);
    }
  }
  for (const id of day.photoIds) add(id);
  return out;
}

export function tripCoverId(trip: TripRecord): string | null {
  // A day from the middle of the trip rather than the first: day one of most
  // trips is an airport or a station.
  const days = trip.days.filter((d) => d.photoIds.length);
  if (!days.length) return null;
  const middle = days[Math.floor(days.length / 2)];
  for (const day of [middle, ...days]) {
    const [id] = coverIds(day, 1);
    if (id) return id;
  }
  return null;
}

export function photoCount(trip: TripRecord): number {
  return trip.days.reduce((sum, d) => sum + d.photoIds.length, 0);
}

/* --- Dates ------------------------------------------------------------- */

// Dates in the archive are the camera's calendar date, not an instant, so they
// are formatted in UTC: a local zone west of Greenwich would print the day before.
const asDay = (date: string) => new Date(`${date}T00:00:00Z`);

export function longDate(date: string): string {
  return fmtDate(asDay(date), { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export function shortDate(date: string): string {
  return fmtDate(asDay(date), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

export function monthLabel(month: string): string {
  return fmtDate(asDay(`${month}-01`), { month: "long", year: "numeric", timeZone: "UTC" });
}

export function rangeLabel(start: string, end: string): string {
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" };
  return `${fmtDate(asDay(start), opts)} – ${fmtDate(asDay(end), opts)}`;
}

export function timeRange(segment: DaySegment): string {
  return `${segment.startTime.slice(11, 16)}–${segment.endTime.slice(11, 16)}`;
}

/** The calendar date a photo belongs to, as the album groups it. */
export function dateOf(photo: PhotoRecord): string | null {
  return photo.takenAt ? photo.takenAt.slice(0, 10) : null;
}

/* --- Chrome ------------------------------------------------------------ */

export const ICONS = {
  back: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 4.5 8 12l7.5 7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  close: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  info: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 11v6M12 7.5v.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.8v2.4M12 18.8v2.4M4.2 7.5l2 1.2M17.8 15.3l2 1.2M4.2 16.5l2-1.2M17.8 8.7l2-1.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  prev: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  transit: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="3" width="12" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6 11h12M9 20l-2 1.5M15 20l2 1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="9.5" cy="14" r="1" fill="currentColor"/><circle cx="14.5" cy="14" r="1" fill="currentColor"/></svg>`,
  home: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 12h17M12 3.5c2.6 2.4 3.8 5.3 3.8 8.5s-1.2 6.1-3.8 8.5c-2.6-2.4-3.8-5.3-3.8-8.5S9.4 5.9 12 3.5z" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`,
  trips: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19c3-1 3-5 7-6s5-5 7-8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-dasharray="0.1 3.4"/><circle cx="5" cy="19" r="2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="19" cy="5" r="2" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`,
  library: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`,
  search: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15.5 15.5 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
};

/**
 * A pushed page's top bar: back, a title, and an optional subtitle.
 *
 * The title starts hidden and fades in once the page's own heading has
 * scrolled under the bar — the usual phone pattern, and it means the name is
 * never shown twice at once on a page that has a big heading of its own.
 */
export function pageBar(title: string, subtitle = "", opts: { alwaysTitled?: boolean } = {}): HTMLElement {
  const bar = el<HTMLElement>(`
    <header class="m-bar">
      <button type="button" class="m-icon-btn m-bar-back">${ICONS.back}</button>
      <div class="m-bar-titles"><div class="m-bar-title"></div><div class="m-bar-sub"></div></div>
    </header>
  `);
  const backButton = bar.querySelector<HTMLButtonElement>(".m-bar-back")!;
  backButton.setAttribute("aria-label", ui.mobile.back);
  backButton.addEventListener("click", back);
  bar.querySelector(".m-bar-title")!.textContent = title;
  const sub = bar.querySelector<HTMLElement>(".m-bar-sub")!;
  if (subtitle) sub.textContent = subtitle;
  else sub.remove();
  if (opts.alwaysTitled) bar.classList.add("is-titled");
  return bar;
}

/**
 * Shows the bar's title once `heading` has gone under it. An observer rather
 * than a scroll listener: it costs nothing while the reader scrolls.
 */
export function titleWhenPast(bar: HTMLElement, heading: HTMLElement): void {
  const observer = new IntersectionObserver(
    ([entry]) => bar.classList.toggle("is-titled", !entry.isIntersecting && entry.boundingClientRect.top < 80),
    { rootMargin: "-64px 0px 0px 0px" },
  );
  observer.observe(heading);
}

export function screen(className: string): HTMLElement {
  return el<HTMLElement>(`<section class="m-screen ${className}"></section>`);
}

export function note(text: string, className = "m-note"): HTMLElement {
  const p = document.createElement("p");
  p.className = className;
  p.textContent = text;
  return p;
}

export function spinner(): HTMLElement {
  return el<HTMLElement>(`<div class="m-spinner" role="progressbar" aria-busy="true"><span></span></div>`);
}

/** Paragraphs from model prose, which separates them with blank lines. */
export function paragraphs(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const para of text.split(/\n\s*\n/)) {
    if (!para.trim()) continue;
    const p = document.createElement("p");
    p.textContent = para.trim();
    frag.appendChild(p);
  }
  return frag;
}
