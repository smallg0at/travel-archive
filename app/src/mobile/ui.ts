import type { ArchiveIndexFile, DayExcursion, DayRecord, DaySegment, PhotoRecord, TripRecord } from "@travel-archive/shared";
import { el, lazyImg } from "../photoUi";

import { contentLanguage } from "../contentLang";
import { fmtDate, ui } from "../i18n";
import { back } from "./router";
import { dismiss, isTopLayer, openLayer } from "./overlay";
import { loadHomeKept } from "./cache";

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

/* --- Days out ----------------------------------------------------------- */

/**
 * The days that left home and came back the same night (`home.json`,
 * `excursions`). The counterpart to a trip: no nights away, no page of its
 * own, but not an ordinary day in a month either.
 *
 * Three states, and the third matters. A file written by a server older than
 * the field has no `excursions` at all, and that is **unknown**, not "there
 * were none" — the desktop lost its days out that way when an older job server
 * rewrote home.json. Unknown leaves every day looking ordinary, which is the
 * safe way to be wrong; claiming a day out that no longer exists is not.
 */
let excursions: Map<string, DayExcursion> | null | undefined;

export async function daysOut(): Promise<Map<string, DayExcursion> | null> {
  if (excursions !== undefined) return excursions;
  const home = await loadHomeKept().catch(() => null);
  // No file (offline, signed out) or an older one without the field: unknown.
  excursions = home?.excursions ? new Map(home.excursions.map((e) => [e.date, e] as const)) : null;
  return excursions;
}

/** Where a day out went, in the reader's language. */
export function dayOutPlace(excursion: DayExcursion): string {
  return (contentLanguage() === "zh-Hans" ? excursion.nameZh : excursion.nameEn) ?? excursion.name;
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
  expand: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  fit: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="12" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  minus: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
};

/**
 * Removes a layer after its exit animation (`.is-leaving` in mobile.css), so
 * it goes the way it came rather than vanishing. The fallback timer covers
 * reduced motion, where no animation runs to end.
 */
export function leave(el: HTMLElement): void {
  if (el.classList.contains("is-leaving")) return;
  el.classList.add("is-leaving");
  const done = () => el.remove();
  el.addEventListener("animationend", (event) => event.target === el && done(), { once: true });
  setTimeout(done, 300);
}

/**
 * The phone's controls for a map drawn by tripMap.ts's `drawPlaceMap`.
 *
 * That map brings its own two buttons, sized for a mouse and labelled in
 * words, and an "expanded" state that is the desktop's inset overlay. Here
 * they are hidden (mobile.css) and driven from two round icon buttons, and
 * the expanded map fills the screen as a layer — so Back closes it, as it
 * does the viewer. The map's own buttons are clicked rather than copied, so
 * its refitting on expand stays in one place.
 */
export function phoneMapControls(root: HTMLElement): void {
  const own = (cls: string) => root.querySelector<HTMLButtonElement>(`.${cls}`);
  const controls = el<HTMLElement>(`
    <div class="m-map-controls">
      <button type="button" class="m-map-btn m-map-close">${ICONS.close}</button>
      <button type="button" class="m-map-btn m-map-zoom-in">${ICONS.plus}</button>
      <button type="button" class="m-map-btn m-map-zoom-out">${ICONS.minus}</button>
      <button type="button" class="m-map-btn m-map-fit">${ICONS.fit}</button>
      <button type="button" class="m-map-btn m-map-expand">${ICONS.expand}</button>
    </div>
  `);
  const [close, zoomIn, zoomOut, fit, expand] = [".m-map-close", ".m-map-zoom-in", ".m-map-zoom-out", ".m-map-fit", ".m-map-expand"].map(
    (s) => controls.querySelector<HTMLButtonElement>(s)!,
  );
  close.setAttribute("aria-label", ui.common.close);
  zoomIn.setAttribute("aria-label", ui.map.zoomIn);
  zoomOut.setAttribute("aria-label", ui.map.zoomOut);
  fit.setAttribute("aria-label", ui.common.fit);
  expand.setAttribute("aria-label", ui.map.expand);
  zoomIn.addEventListener("click", () => own("trip-map-zoom-in")?.click());
  zoomOut.addEventListener("click", () => own("trip-map-zoom-out")?.click());
  fit.addEventListener("click", () => own("trip-map-reset")?.click());
  expand.addEventListener("click", () => own("trip-map-expand")?.click());
  close.addEventListener("click", () => void dismiss());
  root.appendChild(controls);

  const expanded = () => root.classList.contains("is-expanded");
  const collapse = () => {
    if (expanded()) own("trip-map-expand")?.click();
  };
  new MutationObserver(() => {
    if (expanded() && !isTopLayer(collapse)) openLayer(collapse);
  }).observe(root, { attributes: true, attributeFilter: ["class"] });
}

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
