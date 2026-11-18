import type { ArchiveIndexFile, DayExcursion, DayRecord, DaySegment, PhotoRecord, TripRecord } from "@travel-archive/shared";
import { icon } from "../icons";
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
  back: icon("back", 0),
  close: icon("close", 0),
  info: icon("info", 0),
  settings: icon("settings", 0),
  chevron: icon("chevron", 0),
  prev: icon("prev", 0),
  transit: icon("transit", 0),
  home: icon("globe", 0),
  trips: icon("trips", 0),
  library: icon("library", 0),
  search: icon("search", 0),
  expand: icon("expand", 0),
  fit: icon("fit", 0),
  plus: icon("plus", 0),
  minus: icon("minus", 0),
  share: icon("share", 0),
  download: icon("download", 0),
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

/**
 * A small bar low on the screen, above the tabs, that reports background work
 * without taking a tap or covering the page — caching months, mostly. One at a
 * time; a second caller reuses the element and replaces its text.
 *
 * `close` is the caller's to call: a download that ends in a sentence wants to
 * linger a moment, and one that is cancelled wants to go at once.
 */
let toastEl: HTMLElement | null = null;

export function showToast(text: string): { set(text: string): void; close(): void } {
  if (!toastEl) {
    toastEl = el<HTMLElement>(`<div class="m-toast" role="status" aria-live="polite"></div>`);
    document.body.appendChild(toastEl);
  }
  const element = toastEl;
  element.textContent = text;
  element.hidden = false;
  return {
    set(text: string) {
      if (element.isConnected) element.textContent = text;
    },
    close() {
      element.hidden = true;
    },
  };
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
