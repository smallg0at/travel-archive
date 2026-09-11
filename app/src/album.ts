import type { ArchiveIndexFile, DayRecord, MonthSummary, PhotoRecord, TripRecord } from "@travel-archive/shared";
import { loadMonth, SignInRequiredError } from "./archiveData";
import { el, lazyImg } from "./photoUi";
import { openPhoto } from "./viewer";
import { renderDayBody } from "./render";
import { addDayControls, isRetimable, setDayEditingAvailable } from "./dayEdit";
import { selectionClick } from "./retime";
import { loc, locDay } from "./contentLang";
import { renderTripMap } from "./tripMap";
import { releaseThumbnails } from "./graphPhoto";
import { thumbnailSource } from "./photoSource";
import { checkHealth, setPin as savePin, syncStatus } from "./backend";
import { releaseSettings, showSettings } from "./settings";
import { showGenerate, whenGenerationReady } from "./tripMode";
import { canPrint, printView } from "./print";
import { fmtDate, num, ui } from "./i18n";
import { releaseActivity, showActivity, startActivityIndicator } from "./activity";

/**
 * How long a view must be looked at before anything is fetched for it.
 *
 * Clicking the wrong trip and leaving immediately must cost nothing. The old
 * `warmView` fired *during* render, so a misclick downloaded a batch — for a
 * 4,998-photo month, a lot of Graph traffic bought by a wrong click.
 */
const DWELL_MS = 2000;

/**
 * How far ahead of the viewport to fetch. Bulk is sync's job now; this only
 * smooths the next screen or two of scrolling.
 */
const LOOK_AHEAD = 200;

let dwellTimer: ReturnType<typeof setTimeout> | null = null;

/** Cancels any pending look-ahead. Called whenever the view changes. */
function cancelLookAhead(): void {
  if (dwellTimer) clearTimeout(dwellTimer);
  dwellTimer = null;
}

/**
 * Fetch a bounded slice ahead, but only once the view has been kept.
 *
 * Deliberately not the whole view: `warmView` used to ask for every photo in a
 * trip or month on render, which is exactly the traffic that was competing with
 * the app's own metadata fetches and making loads slower.
 */
function lookAhead(photoIds: string[]): void {
  cancelLookAhead();
  const source = thumbnailSource();
  if (!source?.warm || photoIds.length === 0) return;
  dwellTimer = setTimeout(() => {
    dwellTimer = null;
    void source.warm!(photoIds.slice(0, LOOK_AHEAD), "large");
  }, DWELL_MS);
}

/**
 * The album: one tab per month, photos grouped by the day they were taken.
 *
 * Everything here works off the scan pass alone — no captions, no summaries,
 * no AI. When `organize` has since written a summary for a day, that day
 * renders with its chosen layout (render.ts) instead of the plain grid, so
 * the AI work layers on top without the album needing to know it happened.
 */

const UNDATED = "undated";

/**
 * Grid density. Purely a CSS variable, so changing it reflows the existing
 * grid without refetching a single image — which only works because every
 * grid thumbnail is fetched at Graph's `large` size regardless of density.
 *
 * `medium` isn't viable here even for the compact setting: it bounds the
 * *longest* edge at 176px, so a tall phone screenshot comes back 79px wide,
 * and a square-cropped cell on a DPR-2 screen needs ~197 device pixels from
 * that short edge — a 2.5x upscale, which is what "looks dirty" was.
 * Graph's custom `c<w>x<h>` sizes would have been the efficient answer but
 * aren't supported on this account, so `large` (800px box) is the only size
 * that renders crisp.
 */
type Density = "compact" | "comfortable" | "spacious";

const DENSITY_KEY = "album-density";
const DENSITY_CELL_PX: Record<Density, number> = { compact: 78, comfortable: 120, spacious: 190 };
const DENSITY_LABEL: Record<Density, string> = ui.album.density;

function readDensity(): Density {
  try {
    const stored = localStorage.getItem(DENSITY_KEY);
    if (stored === "compact" || stored === "comfortable" || stored === "spacious") return stored;
  } catch {
    // Storage blocked (private browsing) — fall through to the default.
  }
  return "comfortable";
}

let density: Density = readDensity();

function applyDensity(): void {
  document.documentElement.style.setProperty("--album-cell", `${DENSITY_CELL_PX[density]}px`);
}

export function renderDensityControl(): HTMLElement {
  const wrap = el<HTMLDivElement>(`<div class="density-control" role="group" aria-label="${ui.album.thumbnailSize}"></div>`);
  for (const option of ["compact", "comfortable", "spacious"] as Density[]) {
    const button = el<HTMLButtonElement>(`<button type="button"></button>`);
    button.textContent = DENSITY_LABEL[option];
    if (option === density) button.classList.add("active");
    button.addEventListener("click", () => {
      density = option;
      try {
        localStorage.setItem(DENSITY_KEY, option);
      } catch {
        // Not persisting is fine; the setting still applies for this session.
      }
      applyDensity();
      wrap.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      button.classList.add("active");
    });
    wrap.appendChild(button);
  }
  return wrap;
}

/**
 * Puts the export control in the page's own heading.
 *
 * It used to be a sidebar row, which meant it could be pressed while a trip was
 * still loading — and it would then export whatever half of the page had
 * rendered. Living in the heading, it cannot exist before the content it
 * exports does, because this is called after the page is built.
 */
function addExportButton(heading: HTMLElement): void {
  if (!canPrint()) return;
  const button = el<HTMLButtonElement>(`<button class="page-export" type="button">${ui.nav.savePdf}</button>`);
  button.addEventListener("click", () => void printView());
  heading.appendChild(button);
}

/** A placeholder line. Text, not markup: it can carry a trip's model-written name. */
function loadingNote(text: string): HTMLElement {
  const note = el<HTMLDivElement>(`<div class="loading"></div>`);
  note.textContent = text;
  return note;
}

function dayOf(photo: PhotoRecord): string {
  return photo.takenAt ? photo.takenAt.slice(0, 10) : UNDATED;
}

/**
 * Month labels are formatted here rather than read from `MonthSummary.label`,
 * which the pipeline bakes in as en-US. Taking the month from the pipeline
 * once left the nav reading "September" above a heading reading
 * "2026年9月1日周二". Deriving both from the raw `yyyy-mm` keeps them in one
 * language — the reader's, via `fmtDate`.
 */
export function formatMonthLabel(month: string, withYear = true): string {
  const [year, m] = month.split("-").map(Number);
  return fmtDate(new Date(Date.UTC(year, m - 1, 1)), {
    month: "long",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
}

function formatDayHeading(date: string): string {
  if (date === UNDATED) return ui.album.undated;
  const d = new Date(`${date}T00:00:00Z`);
  return fmtDate(d, { weekday: "short", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** Every day `organize` has written, flattened across sections, keyed by date. */
function dayIndexOf(index: ArchiveIndexFile): Map<string, DayRecord> {
  return new Map(index.sections.flatMap((s) => s.days).map((d) => [d.date, d] as const));
}

function renderAlbumGrid(photos: PhotoRecord[]): HTMLElement {
  const grid = el<HTMLDivElement>(`<div class="album-grid"></div>`);
  const imgs: HTMLImageElement[] = [];
  for (const [index, photo] of photos.entries()) {
    const cell = el<HTMLDivElement>(`<div class="album-cell"></div>`);
    // Always "large" — see the Density comment above for why "medium" can't
    // render a tall photo crisply at any usable cell size.
    const img = lazyImg(photo, "large");
    if (isRetimable(photo)) img.dataset.retimable = "";
    // Unless the click is picking photos to retime — see retime.ts.
    img.addEventListener("click", (event) => {
      if (!selectionClick(event, photos, imgs, index)) openPhoto(photo, photos);
    });
    imgs.push(img);
    cell.appendChild(img);
    grid.appendChild(cell);
  }
  return grid;
}

/**
 * One day: its heading, its summary, and its photos.
 *
 * Two layouts, chosen by the view rather than by the day. A trip is the
 * curated reading — stops, cards, placards — so it renders the day as a page.
 * The month album is the whole library by date, where the job is finding and
 * fixing photos, so every day is the summary and one chronological grid, even
 * a day `organize` has broken into stops. Cards hid their photos from that job:
 * a picture inside a card could not be selected, and a placard bound to one
 * did not appear at all.
 */
function renderDaySection(
  date: string,
  photos: PhotoRecord[],
  day: DayRecord | undefined,
  byId: Record<string, PhotoRecord>,
  layout: "trip" | "album",
): HTMLElement {
  // In the reader's language, with their hand edits in it over the top — and
  // so the editors below open on the text they are actually looking at.
  day = day && locDay(day);
  const section = el<HTMLElement>(`<section class="day-page"></section>`);

  const header = el<HTMLDivElement>(`
    <div class="day-header">
      <div class="day-title"></div>
      <div class="day-meta"></div>
    </div>
  `);
  header.querySelector(".day-title")!.textContent = formatDayHeading(date);
  header.querySelector(".day-meta")!.textContent =
    `${ui.common.photos(photos.length)}${day?.place ? ` · ${day.place}` : ""}`;

  if (day?.summary) {
    const summary = el<HTMLDivElement>(`<div class="day-summary"></div>`);
    summary.textContent = loc(day.summary);
    header.appendChild(summary);
  }
  // Only a day `organize` has actually written can be corrected — there is no
  // record to patch for a day that is still a plain grid.
  if (day) addDayControls(header, day);
  section.appendChild(header);

  // In a trip, a day broken into stops renders as a page; everything else is a
  // plain chronological grid, which is the whole album before any tokens are
  // spent.
  if (layout === "trip" && day?.segments?.length) {
    section.appendChild(renderDayBody(day, byId));
  } else {
    section.appendChild(renderAlbumGrid(photos));
  }

  return section;
}

/**
 * Scrolls a stop to the top of the pane, and keeps it there while the page
 * settles.
 *
 * Two things made the first attempts overshoot. `scrollIntoView` computes its
 * destination from the layout at the instant it is called, and this page is
 * still growing — every lazy thumbnail that lands above the target moves it.
 * And a *smooth* scroll is still animating when a correction arrives, so the
 * correction fights the animation and lands short of it.
 *
 * So: jump instantly, which cannot be interrupted mid-flight, then re-measure
 * on the next frame and again once images have had a moment. Three passes, not
 * a loop — continuing to adjust while thumbnails keep arriving would drag the
 * page around under the reader.
 */
const STOP_SCROLL_MARGIN = 16;

function scrollToStop(anchor: string): void {
  const content = document.getElementById("content");
  const target = document.getElementById(anchor);
  if (!content || !target) return;

  const align = () => {
    const offset = target.getBoundingClientRect().top - content.getBoundingClientRect().top + content.scrollTop;
    content.scrollTop = Math.max(0, offset - STOP_SCROLL_MARGIN);
  };

  align();
  requestAnimationFrame(align);
  window.setTimeout(align, 400);
}

/**
 * A trip page: its narrative, then its days.
 *
 * Trips are a second way into the same days, not a replacement for the month
 * tabs — the photos still appear under their month, because the album is the
 * whole library and a trip is a reading of part of it. A trip can straddle a
 * month boundary (this archive's first one runs 30 Aug to 2 Sep), so this loads
 * every shard the range touches rather than assuming one.
 */
async function showTrip(trip: TripRecord): Promise<void> {
  const content = document.getElementById("content")!;
  setTitle(loc(trip.name));
  cancelLookAhead();
  releaseSettings();
  releaseActivity();
  releaseThumbnails();
  content.replaceChildren(loadingNote(ui.common.loading(loc(trip.name))));

  const months = [...new Set(trip.days.map((d) => d.date.slice(0, 7)))];
  const photos: Record<string, PhotoRecord> = {};
  try {
    // In parallel, not one after another. A trip straddles two or three month
    // shards and each is a Graph round trip of well over a second, so awaiting
    // them in turn meant nothing rendered for four seconds — measured at
    // 1,479 + 1,335 + 1,207ms. They do not depend on each other.
    const shards = await Promise.all(months.map((month) => loadMonth(month)));
    for (const shard of shards) Object.assign(photos, shard.photos);
  } catch (err) {
    if (err instanceof SignInRequiredError) {
      window.dispatchEvent(new CustomEvent("signin-required"));
      content.replaceChildren(loadingNote(ui.common.signInToLoad(loc(trip.name))));
      return;
    }
    throw err;
  }

  const frag = document.createDocumentFragment();
  const header = el<HTMLDivElement>(`
    <div class="month-heading trip-heading">
      <h1></h1>
      <span></span>
    </div>
  `);
  header.querySelector("h1")!.textContent = loc(trip.name);
  const photoCount = trip.days.reduce((n, d) => n + d.photoIds.length, 0);
  header.querySelector("span")!.textContent =
    `${formatDayHeading(trip.startDate)} – ${formatDayHeading(trip.endDate)} · ${ui.common.days(trip.days.length)} · ${ui.common.photos(photoCount)}`;
  frag.appendChild(header);

  if (trip.narrative) {
    const narrative = el<HTMLDivElement>(`<div class="trip-narrative"></div>`);
    // Paragraph by paragraph as text nodes — this is model output and must
    // never be parsed as markup.
    for (const para of loc(trip.narrative).split(/\n\s*\n/)) {
      const p = document.createElement("p");
      p.textContent = para.trim();
      narrative.appendChild(p);
    }
    frag.appendChild(narrative);
  }

  if (trip.places.length) {
    const places = el<HTMLDivElement>(`<div class="trip-places"></div>`);
    for (const place of trip.places) {
      const chip = document.createElement("span");
      chip.textContent = loc(place);
      places.appendChild(chip);
    }
    frag.appendChild(places);
  }

  const mapSlot = el<HTMLDivElement>(`<div class="trip-map-slot"></div>`);
  frag.appendChild(mapSlot);

  for (const day of trip.days) {
    const dayPhotos = day.photoIds.map((id) => photos[id]).filter(Boolean);
    frag.appendChild(renderDaySection(day.date, dayPhotos, day, photos, "trip"));
  }

  content.replaceChildren(frag);
  addPinControl(header, "trip", trip.id);
  addExportButton(header);
  // Back where the reader was, when this render is a refresh of the same view.
  // After the heading's controls, not before: they can wrap the heading onto a
  // second line, and anything that grows above a restored offset is paid for
  // by scroll anchoring pushing the reader down by its height.
  content.scrollTop = restoreScrollTop ?? 0;
  restoreScrollTop = null;
  lookAhead(trip.days.flatMap((d) => d.photoIds));

  // After the page is on screen: the basemap is a ~750KB dynamic import, and
  // the trip should be readable before it lands.
  void renderTripMap(trip, photos, (anchor) => scrollToStop(anchor)).then((map) => {
    // The slot holds the map's height while it loads (see style.css); a trip
    // with nothing to map must give that space back rather than keep a gap.
    if (map) mapSlot.replaceChildren(map);
    else mapSlot.remove();
  });
}

async function showMonth(summary: MonthSummary, index: ArchiveIndexFile): Promise<void> {
  const content = document.getElementById("content")!;
  cancelLookAhead();
  releaseSettings();
  releaseActivity();
  const label = formatMonthLabel(summary.month);
  setTitle(label);

  // The outgoing month's thumbnails are about to be detached, so free their
  // blob URLs now rather than pinning every thumbnail decoded this session.
  // Coming back to this month re-reads from IndexedDB, not the network.
  releaseThumbnails();
  content.replaceChildren(loadingNote(ui.common.loading(label)));

  let shard;
  try {
    shard = await loadMonth(summary.month);
  } catch (err) {
    if (err instanceof SignInRequiredError) {
      window.dispatchEvent(new CustomEvent("signin-required"));
      content.replaceChildren(loadingNote(ui.common.signInToLoad(label)));
      return;
    }
    throw err;
  }

  const photos = Object.values(shard.photos).sort((a, b) => (a.takenAt ?? "").localeCompare(b.takenAt ?? ""));
  const days = dayIndexOf(index);

  const byDay = new Map<string, PhotoRecord[]>();
  for (const photo of photos) {
    const key = dayOf(photo);
    const list = byDay.get(key) ?? [];
    list.push(photo);
    byDay.set(key, list);
  }

  // Undated photos sort last regardless of the string comparison.
  const ordered = [...byDay.keys()].sort((a, b) =>
    a === UNDATED ? 1 : b === UNDATED ? -1 : a.localeCompare(b),
  );

  const frag = document.createDocumentFragment();
  const heading = el<HTMLDivElement>(`<div class="month-heading"><h1></h1><span></span></div>`);
  heading.querySelector("h1")!.textContent = label;
  heading.querySelector("span")!.textContent =
    `${ui.common.photos(summary.photoCount)} · ${ui.common.days(ordered.length)}`;
  frag.appendChild(heading);

  for (const date of ordered) {
    frag.appendChild(renderDaySection(date, byDay.get(date)!, days.get(date), shard.photos, "album"));
  }

  content.replaceChildren(frag);
  addPinControl(heading, "month", summary.month);
  addExportButton(heading);
  // After the heading's controls — see showTrip.
  content.scrollTop = restoreScrollTop ?? 0;
  restoreScrollTop = null;
  lookAhead(photos.map((p) => p.id));
}

const OPEN_GROUPS_KEY = "nav-open-groups";

/**
 * Which nav groups are expanded, remembered per browser.
 *
 * `null` means nothing has been stored yet, which is not the same as "nothing
 * is open" — the caller falls back to a sensible first-run set instead of
 * showing twelve collapsed years to someone who has never touched the pane.
 */
function storedOpenGroups(): Set<string> | null {
  try {
    const raw = localStorage.getItem(OPEN_GROUPS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    // Storage blocked, or a value from an older shape. The default set applies.
    return null;
  }
}

function rememberOpenGroups(open: Set<string>): void {
  try {
    localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify([...open]));
  } catch {
    // Not persisting is fine; the pane still works for this session.
  }
}

/**
 * One collapsible section of the nav: a sticky heading and the rows under it.
 *
 * Returns the body so the caller can fill it. The heading stays put while its
 * own rows scroll past, which is the other half of the problem — in a flat
 * list the year you are looking at scrolls off the top and the months below
 * are just numbers with no year attached.
 */
/**
 * How to expand a group without recording the choice.
 *
 * A group opened *for* you — because the row selected on load lives in it — is
 * not a group you chose to open, and writing it back would mean a collapsed
 * Trips section reopened itself on every reload, since the row opened
 * automatically is always a trip.
 */
const expanders = new WeakMap<HTMLElement, () => void>();

/**
 * Fluent's own Location20Regular and Calendar20Regular — the leading icon
 * every top-level group header carries: Trips gets the pin, a year gets the
 * calendar. Both group headers are peers in the same list, so both get an
 * icon — the two-icon compromise (Trips iconed, years bare) put "Trips" and
 * "2026" at different x positions for their label text, which broke the one
 * thing a reading axis needs: every header's text starting in the same place.
 *
 * Children do not repeat their parent's icon — a pin on Trips and a second
 * pin on a town said the same thing twice — but they still have to land on
 * that same axis, so `.month-link` indents its label by the icon-plus-gap
 * width its parent spent on an icon it doesn't have (see style.css).
 */
const GROUP_ICON = {
  trips: `<path d="M14.9498 4.05139C12.2162 1.31653 7.7841 1.31653 5.05043 4.05139C2.3168 6.78625 2.31681 11.2199 5.05043 13.9547L6.57094 15.4537L8.61391 17.4391L8.74672 17.5563C9.52149 18.1843 10.6565 18.1455 11.3864 17.4391L13.8219 15.069L14.9498 13.9547C17.6833 11.2199 17.6833 6.78621 14.9498 4.05139ZM5.75454 4.75647C8.09899 2.41099 11.9003 2.41099 14.2448 4.75647C16.5291 7.04181 16.5877 10.7107 14.4206 13.067L14.2448 13.2496L12.9235 14.5543L10.693 16.7223L10.6002 16.8024C10.2461 17.07 9.7542 17.0701 9.40004 16.8024L9.30727 16.7223L6.32582 13.817L5.75454 13.2496L5.57973 13.067C3.41265 10.7109 3.47055 7.04183 5.75454 4.75647ZM9.99965 6.24963C8.48115 6.24982 7.24985 7.48113 7.24965 8.99963C7.24965 10.5183 8.48103 11.7494 9.99965 11.7496C11.5184 11.7496 12.7497 10.5184 12.7497 8.99963C12.7495 7.48102 11.5183 6.24963 9.99965 6.24963ZM9.99965 7.24963C10.966 7.24963 11.7495 8.0333 11.7497 8.99963C11.7497 9.96613 10.9662 10.7496 9.99965 10.7496C9.03331 10.7494 8.24965 9.96602 8.24965 8.99963C8.24985 8.03342 9.03343 7.24982 9.99965 7.24963Z" />`,
  calendar: `<path d="M7 11C7.55228 11 8 10.5523 8 10C8 9.44771 7.55228 9 7 9C6.44772 9 6 9.44771 6 10C6 10.5523 6.44772 11 7 11ZM8 13C8 13.5523 7.55228 14 7 14C6.44772 14 6 13.5523 6 13C6 12.4477 6.44772 12 7 12C7.55228 12 8 12.4477 8 13ZM10 11C10.5523 11 11 10.5523 11 10C11 9.44771 10.5523 9 10 9C9.44771 9 9 9.44771 9 10C9 10.5523 9.44771 11 10 11ZM11 13C11 13.5523 10.5523 14 10 14C9.44771 14 9 13.5523 9 13C9 12.4477 9.44771 12 10 12C10.5523 12 11 12.4477 11 13ZM13 11C13.5523 11 14 10.5523 14 10C14 9.44771 13.5523 9 13 9C12.4477 9 12 9.44771 12 10C12 10.5523 12.4477 11 13 11ZM17 5.5C17 4.11929 15.8807 3 14.5 3H5.5C4.11929 3 3 4.11929 3 5.5V14.5C3 15.8807 4.11929 17 5.5 17H14.5C15.8807 17 17 15.8807 17 14.5V5.5ZM4 7H16V14.5C16 15.3284 15.3284 16 14.5 16H5.5C4.67157 16 4 15.3284 4 14.5V7ZM5.5 4H14.5C15.3284 4 16 4.67157 16 5.5V6H4V5.5C4 4.67157 4.67157 4 5.5 4Z" />`,
} as const;

function navGroup(nav: HTMLElement, id: string, title: string, count: number, open: Set<string>): HTMLDivElement {
  const icon = id === "trips" ? GROUP_ICON.trips : GROUP_ICON.calendar;
  const header = el<HTMLButtonElement>(
    `<button class="nav-year" type="button">
       <svg class="nav-year-icon" viewBox="0 0 20 20" aria-hidden="true">${icon}</svg>
       <span class="nav-year-name"></span>
       <span class="nav-year-count"></span>
       <svg class="nav-year-twisty" viewBox="0 0 12 12" aria-hidden="true">
         <path d="M2.14645 4.64645C2.34171 4.45118 2.65829 4.45118 2.85355 4.64645L6 7.79289L9.14645 4.64645C9.34171 4.45118 9.65829 4.45118 9.85355 4.64645C10.0488 4.84171 10.0488 5.15829 9.85355 5.35355L6.35355 8.85355C6.15829 9.04882 5.84171 9.04882 5.64645 8.85355L2.14645 5.35355C1.95118 5.15829 1.95118 4.84171 2.14645 4.64645Z" />
       </svg>
     </button>`,
  );
  header.querySelector(".nav-year-name")!.textContent = title;
  header.querySelector(".nav-year-count")!.textContent = num(count);

  const body = el<HTMLDivElement>(`<div class="nav-months"></div>`);
  body.dataset.group = id;

  const apply = () => {
    const isOpen = open.has(id);
    body.hidden = !isOpen;
    header.setAttribute("aria-expanded", String(isOpen));
    // The chevron is drawn in CSS off `aria-expanded`, so there is no glyph to
    // swap here — the state is announced once and styled from the same source.
  };
  apply();

  expanders.set(body, () => {
    open.add(id);
    apply();
  });

  header.addEventListener("click", () => {
    if (open.has(id)) open.delete(id);
    else open.add(id);
    apply();
    rememberOpenGroups(open);
  });

  // Each group is its own section rather than a flat run of siblings: sticky
  // positioning is bounded by the containing block, so with one shared parent
  // every heading would pin to the top of the nav and sit on top of the last.
  // Boxed, a heading is pushed out by the next section, which is the behaviour
  // people expect from a sticky list header.
  const section = el<HTMLElement>(`<section class="nav-group"></section>`);
  section.appendChild(header);
  section.appendChild(body);
  nav.appendChild(section);
  return body;
}

/**
 * Opens whichever group a row lives in, so a row reached in code — the month
 * opened automatically on load — is not selected inside a collapsed section.
 */
function revealRow(row: HTMLElement): void {
  const body = row.closest<HTMLDivElement>(".nav-months");
  if (body?.hidden) expanders.get(body)?.();
}

function renderNav(index: ArchiveIndexFile): void {
  const nav = document.getElementById("month-nav")!;
  nav.replaceChildren();

  const trips = index.sections.filter((s): s is TripRecord => s.kind === "trip");
  const years = [...new Set(index.months.map((m) => m.month.slice(0, 4)))].sort((a, b) => b.localeCompare(a));

  // First run opens the trips and the newest year only. Everything expanded is
  // how this pane got to 123 rows of scroll; everything collapsed would hide
  // the two things almost every visit wants.
  const open = storedOpenGroups() ?? new Set([...(trips.length ? ["trips"] : []), ...years.slice(0, 1)]);

  // Trips first: they are the things a person looks for by name. Months below
  // are the fallback for everything that was not part of one.
  if (trips.length) {
    const sorted = [...trips].sort((a, b) => b.startDate.localeCompare(a.startDate));
    const body = navGroup(
      nav,
      "trips",
      ui.nav.trips,
      sorted.reduce((n, t) => n + t.days.reduce((d, day) => d + day.photoIds.length, 0), 0),
      open,
    );

    for (const trip of sorted) {
      const row = navRow(
        loc(trip.name),
        num(trip.days.reduce((n, d) => n + d.photoIds.length, 0)),
        "trip",
        trip.id,
        () => void showTrip(trip),
      );
      body.appendChild(row);
    }
  }

  // Newest first — a photo library is browsed from the recent end.
  const months = [...index.months].sort((a, b) => b.month.localeCompare(a.month));

  for (const year of years) {
    const inYear = months.filter((m) => m.month.startsWith(year));
    const body = navGroup(
      nav,
      year,
      year,
      inYear.reduce((n, m) => n + m.photoCount, 0),
      open,
    );

    for (const summary of inYear) {
      // Month name without the year — the year is already the group heading above.
      body.appendChild(
        navRow(
          formatMonthLabel(summary.month, false),
          num(summary.photoCount),
          "month",
          summary.month,
          () => void showMonth(summary, index),
        ),
      );
    }
  }

  renderNavTools(index);
  void revealBackendTools();
}

/**
 * Generate, Save as PDF and Settings — in a strip below the scrolling list.
 *
 * They read as part of the same list but do not scroll with it: at 61 months
 * of navigation, entries at the end of the list are entries you cannot reach
 * without scrolling to the bottom, which is no better than the floating menu
 * they replaced.
 */
function renderNavTools(index: ArchiveIndexFile): void {
  void index;
  const tools = document.getElementById("nav-tools")!;
  tools.replaceChildren();

  const generate = el<HTMLButtonElement>(
    `<button class="month-link nav-tool" id="nav-generate" type="button" hidden>
       <svg class="nav-tool-icon" viewBox="0 0 20 20" aria-hidden="true">
         <path d="M7.39804 12.8088C7.57428 12.9331 7.78476 12.9997 8.00043 12.9993C8.21633 12.9995 8.42686 12.932 8.60243 12.8063C8.77993 12.6758 8.91464 12.4955 8.98943 12.2883L9.43643 10.9153C9.55086 10.571 9.74391 10.2581 10.0003 10.0014C10.2566 9.74467 10.5693 9.5512 10.9134 9.4363L12.3044 8.9853C12.4564 8.93095 12.5936 8.84214 12.7055 8.72586C12.8174 8.60957 12.9008 8.46896 12.9492 8.31503C12.9977 8.16111 13.0098 7.99806 12.9847 7.83867C12.9596 7.67927 12.8979 7.52786 12.8044 7.3963C12.6703 7.21038 12.4794 7.07314 12.2604 7.0053L10.8854 6.5583C10.5409 6.44407 10.2278 6.25111 9.97087 5.99472C9.71396 5.73833 9.52035 5.42558 9.40543 5.0813L8.95343 3.6933C8.88113 3.491 8.74761 3.31624 8.57143 3.1933C8.43877 3.09957 8.28607 3.03809 8.12548 3.01375C7.96489 2.9894 7.80083 3.00286 7.64636 3.05306C7.49188 3.10326 7.35125 3.18881 7.23564 3.3029C7.12004 3.417 7.03265 3.5565 6.98043 3.7103L6.52343 5.1103C6.40884 5.44513 6.21967 5.74954 5.97022 6.00055C5.72076 6.25157 5.41753 6.44263 5.08343 6.5593L3.69243 7.0073C3.54065 7.0617 3.40352 7.15048 3.29177 7.26669C3.18001 7.3829 3.09666 7.5234 3.04824 7.67719C2.99982 7.83097 2.98764 7.99388 3.01265 8.15315C3.03767 8.31243 3.0992 8.46376 3.19243 8.5953C3.32027 8.77475 3.50105 8.90972 3.70943 8.9813L5.08343 9.4263C5.52354 9.57278 5.90999 9.84713 6.19343 10.2143C6.35585 10.4249 6.4813 10.6616 6.56443 10.9143L7.01643 12.3053C7.08846 12.5086 7.22179 12.6845 7.39804 12.8088ZM7.48343 5.3943L8.01043 4.0173L8.44943 5.3943C8.61312 5.88745 8.88991 6.33546 9.25767 6.70253C9.62544 7.0696 10.074 7.34554 10.5674 7.5083L11.9734 8.0373L10.5914 8.4853C10.0987 8.6496 9.65095 8.92646 9.28382 9.29393C8.9167 9.66141 8.64026 10.1094 8.47643 10.6023L7.95343 11.9803L7.50443 10.6013C7.34335 10.108 7.06943 9.65913 6.70443 9.2903C6.3356 8.92226 5.88653 8.64467 5.39243 8.4793L4.01443 7.9573L5.40043 7.5073C5.88672 7.33867 6.32775 7.06051 6.68943 6.6943C7.04901 6.3266 7.32049 5.88211 7.48343 5.3943ZM13.5353 16.8513C13.6713 16.9475 13.8337 16.9992 14.0003 16.9993C14.1654 16.9994 14.3264 16.9484 14.4613 16.8533C14.6008 16.7548 14.7058 16.6149 14.7613 16.4533L15.0093 15.6913C15.0625 15.5329 15.1515 15.3888 15.2693 15.2703C15.3867 15.1518 15.5307 15.063 15.6893 15.0113L16.4613 14.7593C16.619 14.7048 16.7557 14.6024 16.8523 14.4663C16.9257 14.3633 16.9736 14.2444 16.9921 14.1193C17.0106 13.9942 16.9992 13.8665 16.9588 13.7467C16.9184 13.6268 16.8501 13.5183 16.7597 13.4299C16.6692 13.3415 16.5591 13.2759 16.4383 13.2383L15.6743 12.9893C15.5162 12.9368 15.3724 12.8481 15.2544 12.7305C15.1364 12.6128 15.0473 12.4693 14.9943 12.3113L14.7423 11.5383C14.6886 11.3805 14.586 11.2439 14.4493 11.1483C14.3473 11.0754 14.2295 11.0274 14.1056 11.0084C13.9816 10.9893 13.8549 10.9997 13.7357 11.0386C13.6164 11.0775 13.508 11.1439 13.4192 11.2325C13.3304 11.321 13.2636 11.4292 13.2243 11.5483L12.9773 12.3103C12.925 12.468 12.8375 12.6116 12.7213 12.7303C12.6066 12.8468 12.4667 12.9354 12.3123 12.9893L11.5393 13.2413C11.3803 13.2952 11.2422 13.3978 11.1447 13.5346C11.0472 13.6713 10.9952 13.8353 10.9961 14.0032C10.997 14.1712 11.0507 14.3346 11.1496 14.4703C11.2486 14.606 11.3877 14.7071 11.5473 14.7593L12.3103 15.0063C12.4692 15.0597 12.6136 15.149 12.7323 15.2673C12.8505 15.3856 12.939 15.5302 12.9903 15.6893L13.2433 16.4633C13.2981 16.6198 13.4001 16.7554 13.5353 16.8513ZM12.6223 14.0583L12.4433 13.9993L12.6273 13.9353C12.9291 13.8304 13.2027 13.6576 13.4273 13.4303C13.6537 13.2013 13.8248 12.9236 13.9273 12.6183L13.9853 12.4403L14.0443 12.6213C14.1463 12.928 14.3185 13.2067 14.5471 13.4352C14.7757 13.6636 15.0545 13.8356 15.3613 13.9373L15.5563 14.0003L15.3763 14.0593C15.0689 14.1615 14.7898 14.3342 14.5611 14.5636C14.3324 14.793 14.1606 15.0727 14.0593 15.3803L14.0003 15.5613L13.9423 15.3803C13.8409 15.0722 13.6687 14.792 13.4394 14.5625C13.2102 14.3329 12.9303 14.1602 12.6223 14.0583Z"/>
       </svg>
       <span class="nav-label">${ui.nav.generate}</span>
     </button>`,
  );
  generate.addEventListener("click", () => {
    cancelLookAhead();
    releaseSettings();
    releaseActivity();
    clearActive();
    generate.classList.add("active");
    enter("#generate");
    setTitle(ui.nav.generate);
    showGenerate();
  });
  tools.appendChild(generate);

  // Hidden until a backend answers, like Generate — see activity.ts.
  const activity = el<HTMLButtonElement>(
    `<button class="month-link nav-tool" id="nav-activity" type="button" hidden>
       <svg class="nav-tool-icon" viewBox="0 0 20 20" aria-hidden="true">
         <path fill-rule="evenodd" d="M10 2a8 8 0 1 1 0 16a8 8 0 0 1 0-16Zm0 1a7 7 0 1 0 0 14a7 7 0 0 0 0-14Zm-.5 3a.5.5 0 0 1 .5.5V10h2.5a.5.5 0 0 1 0 1h-3a.5.5 0 0 1-.5-.5v-4a.5.5 0 0 1 .5-.5Z" />
       </svg>
       <span class="nav-label">${ui.nav.activity}</span>
       <span class="nav-activity-status"></span>
     </button>`,
  );
  activity.addEventListener("click", () => {
    cancelLookAhead();
    releaseSettings();
    clearActive();
    activity.classList.add("active");
    enter("#activity");
    setTitle(ui.nav.activity);
    void showActivity();
  });
  tools.appendChild(activity);

  const settings = el<HTMLButtonElement>(
    `<button class="month-link nav-tool" id="nav-settings" type="button">
       <svg class="nav-tool-icon" viewBox="0 0 20 20" aria-hidden="true">
         <path d="M1.91099 7.38266C2.28028 6.24053 2.88863 5.19213 3.69133 4.30364C3.82707 4.15339 4.04002 4.09984 4.23069 4.16802L6.14897 4.85392C6.66905 5.03977 7.24131 4.76883 7.42716 4.24875C7.44544 4.19762 7.45952 4.14507 7.46925 4.09173L7.83471 2.08573C7.87104 1.88627 8.02422 1.7285 8.22251 1.6863C8.8027 1.5628 9.39758 1.5 10.0003 1.5C10.6026 1.5 11.1971 1.56273 11.7769 1.68607C11.9752 1.72824 12.1284 1.88591 12.1648 2.08529L12.5313 4.09165C12.6303 4.63497 13.1511 4.9951 13.6944 4.89601C13.7479 4.88627 13.8004 4.87219 13.8515 4.85395L15.7698 4.16802C15.9605 4.09984 16.1734 4.15339 16.3092 4.30364C17.1119 5.19213 17.7202 6.24053 18.0895 7.38266C18.1518 7.57534 18.0918 7.78658 17.9374 7.91764L16.3825 9.23773C15.9615 9.5952 15.9101 10.2263 16.2675 10.6473C16.3027 10.6887 16.3411 10.7271 16.3825 10.7623L17.9374 12.0824C18.0918 12.2134 18.1518 12.4247 18.0895 12.6173C17.7202 13.7595 17.1119 14.8079 16.3092 15.6964C16.1734 15.8466 15.9605 15.9002 15.7698 15.832L13.8515 15.1461C13.3315 14.9602 12.7592 15.2312 12.5733 15.7512C12.5551 15.8024 12.541 15.8549 12.5312 15.9085L12.1648 17.9147C12.1284 18.1141 11.9752 18.2718 11.7769 18.3139C11.1971 18.4373 10.6026 18.5 10.0003 18.5C9.39758 18.5 8.8027 18.4372 8.22251 18.3137C8.02422 18.2715 7.87104 18.1137 7.83471 17.9143L7.46926 15.9084C7.37018 15.365 6.8494 15.0049 6.30608 15.104C6.25265 15.1137 6.20011 15.1278 6.14906 15.1461L4.23069 15.832C4.04002 15.9002 3.82707 15.8466 3.69133 15.6964C2.88863 14.8079 2.28028 13.7595 1.91099 12.6173C1.84869 12.4247 1.90876 12.2134 2.06313 12.0824L3.61798 10.7623C4.03897 10.4048 4.09046 9.77373 3.73299 9.35274C3.69784 9.31135 3.65937 9.27288 3.618 9.23775L2.06313 7.91764C1.90876 7.78658 1.84869 7.57534 1.91099 7.38266ZM2.97154 7.37709L4.26523 8.47546C4.34803 8.54576 4.42496 8.62269 4.49526 8.70548C5.2102 9.54746 5.10721 10.8096 4.26521 11.5246L2.97154 12.6229C3.26359 13.4051 3.68504 14.1322 4.21648 14.7751L5.81246 14.2044C5.91473 14.1679 6.01982 14.1397 6.12667 14.1202C7.21332 13.922 8.25487 14.6423 8.45305 15.729L8.75702 17.3975C9.16489 17.4655 9.58024 17.5 10.0003 17.5C10.42 17.5 10.8351 17.4656 11.2427 17.3976L11.5475 15.7289C11.567 15.6221 11.5951 15.517 11.6317 15.4147C12.0034 14.3746 13.1479 13.8327 14.1881 14.2044L15.784 14.7751C16.3155 14.1322 16.7369 13.4051 17.029 12.6229L15.7353 11.5245C15.6525 11.4542 15.5756 11.3773 15.5053 11.2945C14.7903 10.4525 14.8933 9.1904 15.7353 8.47544L17.029 7.37709C16.7369 6.59486 16.3155 5.86783 15.784 5.22494L14.1881 5.79559C14.0858 5.83214 13.9807 5.8603 13.8738 5.87979C12.7872 6.07796 11.7456 5.3577 11.5475 4.27119L11.2427 2.60235C10.8351 2.53443 10.42 2.5 10.0003 2.5C9.58024 2.5 9.16489 2.53448 8.75702 2.60249L8.45304 4.27105C8.43355 4.37791 8.40539 4.48299 8.36884 4.58527C7.99714 5.62542 6.8526 6.1673 5.81237 5.79556L4.21648 5.22494C3.68504 5.86783 3.26359 6.59486 2.97154 7.37709ZM7.50026 10C7.50026 8.61929 8.61954 7.5 10.0003 7.5C11.381 7.5 12.5003 8.61929 12.5003 10C12.5003 11.3807 11.381 12.5 10.0003 12.5C8.61954 12.5 7.50026 11.3807 7.50026 10ZM8.50026 10C8.50026 10.8284 9.17183 11.5 10.0003 11.5C10.8287 11.5 11.5003 10.8284 11.5003 10C11.5003 9.17157 10.8287 8.5 10.0003 8.5C9.17183 8.5 8.50026 9.17157 8.50026 10Z"/>
       </svg>
       <span class="nav-label">${ui.nav.settings}</span>
     </button>`,
  );
  settings.addEventListener("click", () => {
    // Leaving a view cancels its look-ahead. Without this, glancing at a trip
    // and clicking straight to Settings still fired the warm two seconds later
    // — the dwell delay only helps if every exit cancels it, not just the two
    // that happen to render a view.
    cancelLookAhead();
    releaseActivity();
    clearActive();
    settings.classList.add("active");
    enter("#settings");
    setTitle(ui.nav.settings);
    void showSettings();
  });
  tools.appendChild(settings);
}

/** The selected row can now be in either container, so clear across both. */
function clearActive(): void {
  document.querySelectorAll(".month-link.active").forEach((n) => n.classList.remove("active"));
}

/**
 * One sidebar row, with the pin marker OneDrive uses.
 *
 * A filled marker means kept on this device; a cloud means fetched when needed.
 * The vocabulary is borrowed deliberately — the mental model is borrowed, so it
 * should look it.
 */
function navRow(
  name: string,
  count: string,
  kind: "trip" | "month",
  id: string,
  open: () => void,
): HTMLButtonElement {
  const row = el<HTMLButtonElement>(
    `<button class="month-link" type="button">
       <span class="nav-label"></span>
       <span class="month-count"></span>
     </button>`,
  );
  row.querySelector(".nav-label")!.textContent = name;
  row.querySelector(".month-count")!.textContent = count;
  row.dataset.pinKind = kind;
  row.dataset.pinId = id;

  row.addEventListener("click", () => {
    clearActive();
    row.classList.add("active");
    revealRow(row);
    row.scrollIntoView({ block: "nearest", inline: "nearest" });
    enter(`#${kind}/${encodeURIComponent(id)}`);
    open();
  });
  return row;
}

/**
 * The pin control, in the page heading rather than the sidebar row.
 *
 * It lived in the row so it lined up with the count, next to the OneDrive-style
 * marker. That put a per-item *action* in a list whose job is navigation: it
 * needed a click-target exception inside the row's own handler, it was a 16px
 * glyph with no label, and the thing it acted on was not the thing you were
 * looking at. Here it sits beside "Save as PDF", where the other page-level
 * actions are, and can afford to say what it does.
 *
 * The vocabulary is still OneDrive's — filled means kept on this device, cloud
 * means fetched when needed — because the mental model is borrowed.
 *
 * With no backend there is nothing to pin to, so the slot is simply left empty:
 * the phone reads the archive from OneDrive and caches in the browser, which is
 * a supported state rather than a failure.
 */
function addPinControl(heading: HTMLElement, kind: "trip" | "month", id: string): void {
  // An empty slot, placed synchronously so it holds its position in the flex
  // row while the server is asked. Without it the button would arrive after
  // "Save as PDF" and land on the wrong side of it.
  const slot = el<HTMLSpanElement>(`<span class="page-pin-slot"></span>`);
  heading.appendChild(slot);

  // `cached`, deliberately. Pins are local state — they live in sync.json — so
  // the eTag comparison the checked call makes is irrelevant to them, and it
  // costs a Graph round trip: measured 1,344ms against 181ms, on every month
  // and trip you open. Settings learned the same lesson the same way.
  void syncStatus({ cached: true }).then((status) => {
    if (!status) return;
    const button = el<HTMLButtonElement>(`<button class="page-pin" type="button"></button>`);
    let pinned = status.pins.some((p) => p.kind === kind && p.id === id);

    const paint = () => {
      button.textContent = pinned ? ui.nav.kept : ui.nav.keep;
      button.classList.toggle("pinned", pinned);
      button.title = pinned ? ui.nav.keptTitle : ui.nav.keepTitle;
    };
    paint();

    button.addEventListener("click", () => {
      const next = !pinned;
      pinned = next;
      paint();
      button.disabled = true;
      void savePin({ kind, id, originals: false, pinned: next })
        .catch(() => {
          // Put the marker back rather than showing a pin that was never saved.
          pinned = !next;
          paint();
        })
        .finally(() => (button.disabled = false));
    });

    slot.appendChild(button);
  });
}

/**
 * Reveals the Generate tool once a backend answers.
 *
 * `/health` rather than a status call: the question is only whether a server is
 * there, and health is a few milliseconds where a checked sync status is over a
 * second.
 */
async function revealBackendTools(): Promise<void> {
  if (!(await checkHealth())) return;
  setDayEditingAvailable(true);
  const generate = document.getElementById("nav-generate");
  if (generate) generate.hidden = false;
  const activity = document.getElementById("nav-activity");
  if (activity) {
    activity.hidden = false;
    startActivityIndicator(activity);
  }
}

let cachedIndex: ArchiveIndexFile | null = null;
/** For resolving an id (a trip, in a pin record) back to something a reader
 * recognizes — Settings needs the trip's name, not its slug, and has no
 * reason to fetch the whole index a second time just to get it. */
export function getCachedIndex(): ArchiveIndexFile | null {
  return cachedIndex;
}

/**
 * Where the reader was, so a re-render puts them back.
 *
 * `renderAlbum` runs again whenever a job finishes — a day rewritten from its
 * own page, an organize run from Generate — and it rebuilt the nav and clicked
 * the first row, which threw the reader back to the newest trip at the top.
 * Pressing "Rewrite this day" and landing somewhere else entirely is the
 * feature undoing itself.
 *
 * Module state on purpose: it has to survive the render that replaces every
 * element it could otherwise hang off.
 */
let restoreScrollTop: number | null = null;
let wantedView: { kind: string; id: string } | null = null;

/**
 * Where the reader is, kept across a *page* refresh as well.
 *
 * `captureView` only covers a re-render inside the running page. A browser
 * refresh starts this module from nothing, so it fell through to the default
 * and landed on the newest trip every time. The view goes in the URL hash — it
 * survives a refresh, and `#month/2026-09` opens that month from a link — and
 * the scroll offset in sessionStorage, keyed by that hash, because it is only
 * worth keeping for this tab.
 */
const SCROLL_KEY = "view-scroll";

/** Where the reader is: a nav row, or one of the two tool pages below the list. */
type View = { kind: "trip" | "month"; id: string } | { kind: "settings" } | { kind: "generate" } | { kind: "activity" };

function viewFromHash(): View | null {
  if (location.hash === "#settings") return { kind: "settings" };
  if (location.hash === "#generate") return { kind: "generate" };
  if (location.hash === "#activity") return { kind: "activity" };
  const match = /^#(trip|month)\/(.+)$/.exec(location.hash);
  return match ? { kind: match[1] as "trip" | "month", id: decodeURIComponent(match[2]) } : null;
}

/** The nav element that opens a view — a row, or a tool button. */
function rowFor(view: View | null): HTMLElement | null {
  if (!view) return null;
  if (view.kind === "settings") return document.getElementById("nav-settings");
  if (view.kind === "generate") return document.getElementById("nav-generate");
  if (view.kind === "activity") return document.getElementById("nav-activity");
  return document.querySelector<HTMLElement>(
    `#month-nav .month-link[data-pin-kind="${view.kind}"][data-pin-id="${CSS.escape(view.id)}"]`,
  );
}

/**
 * The newest thing — the nav is sorted newest-first — but only from a group
 * that is actually open. Picking the very first row would always land on a
 * trip and force the Trips section back open, which makes collapsing it look
 * broken.
 */
function defaultRow(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>("#month-nav .nav-months:not([hidden]) .month-link") ??
    document.querySelector<HTMLElement>("#month-nav .month-link")
  );
}

/**
 * Offsets per view, so Back returns to where you were in *that* view rather
 * than only remembering the last one. At most one entry per trip and month.
 */
function scrollMap(): Record<string, number> {
  try {
    const map = JSON.parse(sessionStorage.getItem(SCROLL_KEY) ?? "{}") as unknown;
    return map && typeof map === "object" ? (map as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function storedScroll(hash: string): number | null {
  const top = scrollMap()[hash];
  return typeof top === "number" ? top : null;
}

/**
 * The hash of the view on screen. Not `location.hash`: by the time `popstate`
 * fires the URL already names the view being *returned to*, and saving the
 * outgoing offset under it would overwrite the one about to be restored.
 */
let currentHash = "";
let scrollSaveTimer = 0;

function saveScroll(): void {
  const content = document.getElementById("content");
  if (!content || !/^#(trip|month)\//.test(currentHash)) return;
  try {
    const map = scrollMap();
    map[currentHash] = content.scrollTop;
    sessionStorage.setItem(SCROLL_KEY, JSON.stringify(map));
  } catch {
    // Storage blocked: the view still comes back from the hash, just at the top.
  }
}

/**
 * How the next open touches history. A reader's click adds an entry, so Back
 * works; reopening a view — on load, after a re-render, on Back itself — must
 * replace instead, or every refresh would add an entry that goes nowhere.
 */
let historyMode: "push" | "replace" = "push";

/** Called by every nav open, before the view renders. */
function enter(hash: string): void {
  window.clearTimeout(scrollSaveTimer);
  saveScroll(); // the view being left, under its own hash
  if (historyMode === "push" && location.hash !== hash) history.pushState(null, "", hash);
  else history.replaceState(null, "", hash);
  currentHash = hash;
}

/**
 * The tab and history entry say what is open. Every tab read "Photo Archive"
 * whatever it showed, and so did every entry in the Back menu — which made the
 * history this file now keeps unreadable.
 */
const APP_TITLE = ui.app.title;

function setTitle(page: string): void {
  document.title = `${page} · ${APP_TITLE}`;
}

/** Opens a view without adding a history entry. */
function reopen(row: HTMLElement | null): void {
  if (!row) return;
  historyMode = "replace";
  try {
    row.click();
  } finally {
    historyMode = "push";
  }
}

/**
 * Once per page: `#content` itself is never replaced, only its children.
 *
 * The offset is saved on scroll, debounced; on every navigation (`enter`); and
 * on `pagehide`. The debounce alone lost a refresh pressed within 250ms of
 * scrolling, and scroll events are only delivered while the page is being drawn
 * — the other two fire regardless, so they are the saves that cannot be missed.
 */
function watchNavigation(content: HTMLElement): void {
  if (content.dataset.scrollWatched) return;
  content.dataset.scrollWatched = "1";
  content.addEventListener(
    "scroll",
    () => {
      window.clearTimeout(scrollSaveTimer);
      scrollSaveTimer = window.setTimeout(saveScroll, 250);
    },
    { passive: true },
  );
  window.addEventListener("pagehide", saveScroll);
  window.addEventListener("popstate", () => {
    if (!cachedIndex) return;
    const view = viewFromHash();
    const row = rowFor(view);
    if (row && (view?.kind === "trip" || view?.kind === "month")) restoreScrollTop = storedScroll(location.hash);
    reopen(row ?? defaultRow());
  });
}

/**
 * Called before a reload begins, not during the render.
 *
 * `loadAndRender` shows "Loading archive…" first, and that replaces `#content`
 * — which resets its scroll to 0. Reading the offset inside `renderAlbum`
 * therefore always read 0, and restoring it did nothing. The nav survives that
 * far, so the *selection* could be read either side; the scroll offset cannot.
 */
export function captureView(): void {
  const active = document.querySelector<HTMLElement>(".month-link.active");
  wantedView = active?.dataset.pinKind
    ? { kind: active.dataset.pinKind, id: active.dataset.pinId ?? "" }
    : null;
  restoreScrollTop = wantedView ? (document.getElementById("content")?.scrollTop ?? null) : null;
}

export function renderAlbum(index: ArchiveIndexFile): void {
  cachedIndex = index;
  const content = document.getElementById("content")!;
  applyDensity();
  watchNavigation(content);
  // An in-page reload captured the view in memory; a page refresh did not, and
  // has only the URL to go on.
  const captured = wantedView;
  wantedView = null;

  if (index.months.length === 0) {
    content.replaceChildren(
      el(`<div class="loading">${ui.app.emptyArchiveHtml}</div>`),
    );
    return;
  }

  renderNav(index);

  // The view that was open wins over the default. Matched on kind and id rather
  // than on position: a rebuilt nav can reorder, and reopening whatever now
  // sits in that slot is not the same thing as staying put.
  const view: View | null = captured
    ? { kind: captured.kind as "trip" | "month", id: captured.id }
    : viewFromHash();

  if (view?.kind === "generate") {
    // Generate exists only once a backend has answered and its panel is built,
    // which on a refresh happens after this render — so wait for that, and
    // fall back to the default when there is no backend to generate with.
    void whenGenerationReady().then((ok) => reopen(ok ? rowFor(view) : defaultRow()));
    return;
  }

  const row = rowFor(view);
  if (!row) {
    // A stale hash (a trip since renamed) falls through to the default, and an
    // offset captured for the missing view means nothing there.
    restoreScrollTop = null;
  } else if (!captured && (view?.kind === "trip" || view?.kind === "month")) {
    restoreScrollTop = storedScroll(location.hash);
  }
  reopen(row ?? defaultRow());
}
