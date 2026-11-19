import type { ArchiveIndexFile, DayExcursion, DayRecord, MonthSummary, PhotoRecord, TripRecord } from "@travel-archive/shared";
import { icon } from "./icons";
import { loadHomeIndex, loadMonth, SignInRequiredError } from "./archiveData";
import { el, lazyImg } from "./photoUi";
import { openPhoto, syncPhotoRoute } from "./viewer";
import { setBaseView, setIndex, splitPhoto } from "./photoRoute";
import { renderDayBody } from "./render";
import { addDayControls, isRetimable, setDayEditingAvailable } from "./dayEdit";
import { selectionClick } from "./retime";
import { contentLanguage, loc, locDay, locTrip } from "./contentLang";
import { renderTripMap } from "./tripMap";
import { releaseThumbnails } from "./graphPhoto";
import { thumbnailSource } from "./photoSource";
import { canWrite, checkHealth, setPin as savePin, servedByJobServer, serverCanFetch, syncStatus } from "./backend";
import { releaseSettings, showSettings } from "./settings";
import { showGenerate, whenGenerationReady } from "./tripMode";
import { canPrint, printView } from "./print";
import { fmtDate, num, ui } from "./i18n";
import { releaseActivity, showActivity, startActivityIndicator } from "./activity";
import { showHome } from "./home";
import { addTripControls } from "./dayEdit";
import { jumpTo, withContents, type ContentsEntry } from "./contents";
import { DENSITY_KEY, OPEN_GROUPS_KEY, rememberPref } from "./prefs";
import { closeSidebarIfOverlay } from "./chrome";

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
 * Grid density — how tightly the grid packs, from the control in Settings.
 *
 * Purely a CSS variable, so changing it reflows the existing grid without
 * refetching a single image — which only works because every grid thumbnail is
 * fetched at Graph's `large` size regardless of density.
 *
 * **This is not a thumbnail size.** It never changes which image is fetched;
 * it changes the cell, and `object-fit: cover` crops into it. It is named for
 * the spacing for that reason — it was called "thumbnail size" until
 * 2026-09-25, which promised a clarity and a bandwidth saving it has never
 * had.
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

const DENSITY_CELL_PX: Record<Density, number> = { compact: 78, comfortable: 120, spacious: 190 };
/** Read at use rather than captured here: the language can still be applied in place while the app starts. */
const densityLabel = (option: Density): string => ui.album.density[option];

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

/**
 * Re-reads the stored density. Called once at startup when the setting has
 * just come back from the server (see prefs.ts): this module read it while it
 * loaded, which was before the fetch could have answered.
 */
export function refreshDensity(): void {
  density = readDensity();
  applyDensity();
}

export function renderDensityControl(): HTMLElement {
  const wrap = el<HTMLDivElement>(`<div class="density-control" role="group" aria-label="${ui.album.gridDensity}"></div>`);
  for (const option of ["compact", "comfortable", "spacious"] as Density[]) {
    const button = el<HTMLButtonElement>(`<button type="button"></button>`);
    button.textContent = densityLabel(option);
    if (option === density) button.classList.add("active");
    button.addEventListener("click", () => {
      density = option;
      try {
        localStorage.setItem(DENSITY_KEY, option);
      } catch {
        // Not persisting is fine; the setting still applies for this session.
      }
      rememberPref({ density: option });
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
/**
 * The Save-as-PDF button.
 *
 * **Created unconditionally, then removed if the page ends up with nothing to
 * print.** It used to begin with `if (!canPrint()) return`, and `canPrint()`
 * counts the photographs in the DOM — but this runs while the header is being
 * built, before a single photograph has been appended. The count was always
 * zero, so the button never appeared on any page: the export had looked removed
 * for as long as the check had been there. Whether there is content is only
 * knowable after the view renders, hence the deferred re-check.
 */
function addExportButton(container: HTMLElement): void {
  const button = el<HTMLButtonElement>(`
    <button class="btn-action btn-export page-export" type="button" title="${ui.nav.savePdf}">
      ${icon("export", 13)}
      <span>${ui.nav.savePdf}</span>
    </button>
  `);
  button.addEventListener("click", () => {
    // Checked again on click, because a page can be emptied after it painted
    // (a month with no photos loads its shards asynchronously).
    if (!canPrint()) return;
    void printView(pageTitle);
  });
  container.appendChild(button);
  // The view is still being assembled at this point, and its photographs arrive
  // asynchronously (shards load, thumbnails attach). Look again over the next
  // moment and take the button away only if the page really has no pictures.
  let checks = 0;
  const verify = () => {
    if (!button.isConnected) return;
    if (canPrint()) return;
    if (++checks >= 5) {
      button.remove();
      return;
    }
    setTimeout(verify, 400);
  };
  setTimeout(verify, 400);
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
/** The element id of a day's section, wherever it is rendered. */
export const dayAnchor = (date: string) => `day-${date}`;

/**
 * Opens whichever page holds a date, then scrolls to that day.
 *
 * Search results are dates; the album is organised by trip and month. Rather
 * than teach search about sections, it asks for a date and this finds the nav
 * row that opens it — the same row a reader would click, so the view, the
 * highlight and the scroll memory all behave as usual.
 */
export async function openDay(date: string, section: { kind: "trip" | "month"; id: string }): Promise<void> {
  const row = rowFor(section);
  row?.click();
  // The page is built by the click's own async work; the day exists a frame or
  // two later, and thumbnails keep growing after that — jumpTo re-aligns.
  for (const wait of [0, 120, 400]) {
    await new Promise((resolve) => setTimeout(resolve, wait));
    const target = document.getElementById(dayAnchor(date));
    if (target) {
      jumpTo(target);
      return;
    }
  }
}

/** A day out's destination, in the reader's language. */
function excursionPlace(excursion: DayExcursion): string {
  return (contentLanguage() === "zh-Hans" ? excursion.nameZh : excursion.nameEn) ?? excursion.name;
}

/**
 * Which way a day out is read, remembered between visits.
 *
 * Trip mode is the summarized page — stops, cards, translated placards — and
 * is what a day out is for; gallery is the plain grid the month shows for
 * every other day. The choice is the reader's habit rather than a property of
 * the day, so it is one setting, not one per day.
 */
const DAY_MODE_KEY = "day-out-mode";
type DayMode = "trip" | "gallery";
function readDayMode(): DayMode {
  try {
    return localStorage.getItem(DAY_MODE_KEY) === "gallery" ? "gallery" : "trip";
  } catch {
    return "trip";
  }
}

/**
 * Trip or gallery, for a day that can be read both ways.
 *
 * Two buttons rather than a switch: which one is on has to be readable at a
 * glance, and a switch says only "on" and "off" of something unnamed.
 */
function modeToggle(mode: DayMode, onPick: (mode: DayMode) => void): HTMLElement {
  const wrap = el<HTMLDivElement>(`<div class="day-mode" role="group"></div>`);
  wrap.setAttribute("aria-label", ui.album.dayMode.label);
  for (const value of ["trip", "gallery"] as const) {
    const button = el<HTMLButtonElement>(`<button type="button"></button>`);
    button.textContent = ui.album.dayMode[value];
    button.dataset.mode = value;
    const mark = (on: boolean) => {
      button.classList.toggle("active", on);
      button.setAttribute("aria-pressed", String(on));
    };
    mark(value === mode);
    button.addEventListener("click", () => {
      if (button.classList.contains("active")) return;
      for (const other of wrap.querySelectorAll("button")) {
        other.classList.toggle("active", other === button);
        other.setAttribute("aria-pressed", String(other === button));
      }
      onPick(value);
    });
    wrap.appendChild(button);
  }
  return wrap;
}

function renderDaySection(
  date: string,
  photos: PhotoRecord[],
  day: DayRecord | undefined,
  byId: Record<string, PhotoRecord>,
  layout: "trip" | "album",
  excursion?: DayExcursion,
): HTMLElement {
  // In the reader's language, with their hand edits in it over the top — and
  // so the editors below open on the text they are actually looking at.
  day = day && locDay(day);
  const section = el<HTMLElement>(`<section class="day-page"></section>`);
  // So search results, and anything else holding only a date, can scroll to it.
  section.id = dayAnchor(date);

  // A day out is headed like a small trip — where it went, then the day
  // beneath it — rather than by its date. The owner's word for the first
  // version, a cover photo beside a block of text that repeated the heading
  // below it, was "sus": it said the date and the photo count twice.
  const header = el<HTMLDivElement>(
    excursion
      ? `
    <div class="day-header day-out-head">
      <span class="day-out-kicker"></span>
      <h2 class="day-out-place"></h2>
      <div class="day-meta"></div>
    </div>
  `
      : `
    <div class="day-header">
      <div class="day-title"></div>
      <div class="day-meta"></div>
    </div>
  `,
  );
  if (excursion) {
    header.querySelector(".day-out-kicker")!.textContent = ui.album.dayOut;
    header.querySelector(".day-out-place")!.textContent = excursionPlace(excursion);
    header.querySelector(".day-meta")!.textContent = [
      formatDayHeading(date),
      ui.album.dayOutFar(num(excursion.awayKm)),
      ui.common.photos(photos.length),
    ].join(" · ");
  } else {
    header.querySelector(".day-title")!.textContent = formatDayHeading(date);
    header.querySelector(".day-meta")!.textContent =
      `${ui.common.photos(photos.length)}${day?.place ? ` · ${day.place}` : ""}`;
  }

  if (day?.summary) {
    // Marked, not just shown: thirty days in two thousand have been written,
    // and scrolling a month gave no way to tell which without reading.
    section.classList.add("is-summarized");
    const summary = el<HTMLDivElement>(`<div class="day-summary"></div>`);
    summary.textContent = loc(day.summary);
    header.appendChild(summary);
  }
  // Only a day `organize` has actually written can be corrected — there is no
  // record to patch for a day that is still a plain grid.
  if (day) addDayControls(header, day);
  if (excursion) section.classList.add("is-day-out");
  section.appendChild(header);

  // In a trip, a day broken into stops renders as a page; everything else is a
  // plain chronological grid, which is the whole album before any tokens are
  // spent.
  if (layout === "trip" && day?.segments?.length) {
    section.appendChild(renderDayBody(day, byId));
  } else if (excursion && day?.segments?.length) {
    // A day out can be read either way, and the switch sits in its heading.
    // Only here: every other day in a month is a grid and has nothing to
    // switch to, and a trip's days are already pages.
    let mode = readDayMode();
    const box = el<HTMLDivElement>(`<div class="day-body"></div>`);
    const body = () => {
      box.replaceChildren(mode === "trip" ? renderDayBody(day, byId) : renderAlbumGrid(photos));
    };
    header.appendChild(
      modeToggle(mode, (next) => {
        mode = next;
        try {
          localStorage.setItem(DAY_MODE_KEY, next);
        } catch {
          // Private window: the choice lasts the visit instead.
        }
        body();
      }),
    );
    body();
    section.appendChild(box);
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
function scrollToStop(anchor: string): void {
  const target = document.getElementById(anchor);
  if (target) jumpTo(target);
}

/** "Wed 2 Sept" — the contents panel's day label, on the camera's calendar. */
function formatDayShort(date: string): string {
  if (date === UNDATED) return ui.album.undated;
  return fmtDate(new Date(`${date}T00:00:00Z`), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/** A day section as a contents entry: its date, its place, and its stops. */
function dayEntry(
  section: HTMLElement,
  date: string,
  day: DayRecord | undefined,
  excursion?: DayExcursion,
): ContentsEntry {
  return {
    target: section,
    label: formatDayShort(date),
    // A day out says where it went, in place of the day's own place: that is
    // what the row is for, and the two would otherwise be the same string.
    kicker: excursion ? ui.album.dayOut : undefined,
    meta: excursion ? excursionPlace(excursion) : (day && locDay(day).place) || undefined,
    stops: [...section.querySelectorAll<HTMLElement>("section.stop")].map((stop) => ({
      target: stop,
      label: stop.querySelector(".stop-title")?.textContent ?? "",
    })),
  };
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
  setTitle(locTrip(trip).name);
  cancelLookAhead();
  releaseSettings();
  releaseActivity();
  releaseThumbnails();
  content.replaceChildren(loadingNote(ui.common.loading(locTrip(trip).name)));

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
      if (serverCanFetch() || servedByJobServer()) {
        content.replaceChildren(loadingNote(ui.app.loadGap));
        return;
      }
      window.dispatchEvent(new CustomEvent("signin-required"));
      content.replaceChildren(loadingNote(ui.common.signInToLoad(locTrip(trip).name)));
      return;
    }
    // Anything else — Graph throttling, a token renewal that timed out — is a
    // failed load, and says so where the trip would have been. It used to be
    // rethrown into a floating rejection, which left this pane reading
    // "Loading…" for as long as the reader cared to wait.
    console.error(err);
    content.replaceChildren(loadingNote(ui.app.failedToLoad((err as Error).message)));
    return;
  }

  const frag = document.createDocumentFragment();
  const header = el<HTMLDivElement>(`
    <div class="month-heading trip-heading">
      <div class="heading-title-group">
        <h1></h1>
        <span class="heading-meta"></span>
      </div>
      <div class="heading-actions"></div>
    </div>
  `);
  header.querySelector("h1")!.textContent = locTrip(trip).name;
  const photoCount = trip.days.reduce((n, d) => n + d.photoIds.length, 0);
  header.querySelector(".heading-meta")!.textContent =
    `${formatDayHeading(trip.startDate)} – ${formatDayHeading(trip.endDate)} · ${ui.common.days(trip.days.length)} · ${ui.common.photos(photoCount)}`;
  frag.appendChild(header);
  const actions = header.querySelector<HTMLDivElement>(".heading-actions")!;
  addTripControls(header, actions, trip, trip.name);
  addPinControl(actions, "trip", trip.id);
  addExportButton(actions);

  const shown = locTrip(trip);
  if (shown.narrative) {
    const narrative = el<HTMLDivElement>(`<div class="trip-narrative"></div>`);
    // Paragraph by paragraph as text nodes — this is model output and must
    // never be parsed as markup.
    for (const para of shown.narrative.split(/\n\s*\n/)) {
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

  const mapSlot = el<HTMLDivElement>(`<div class="trip-map-slot"><div class="trip-map-loading"></div></div>`);
  mapSlot.firstElementChild!.textContent = ui.map.loading;
  frag.appendChild(mapSlot);

  const entries: ContentsEntry[] = [];
  for (const day of trip.days) {
    const dayPhotos = day.photoIds.map((id) => photos[id]).filter(Boolean);
    const section = renderDaySection(day.date, dayPhotos, day, photos, "trip");
    frag.appendChild(section);
    entries.push(dayEntry(section, day.date, day));
  }

  content.replaceChildren(withContents(frag, entries));
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
      // With the server signed in, "sign in" is a lie: the month is simply not
      // in the mirror yet. Say what is true instead — see backend.serverCanFetch.
      if (serverCanFetch() || servedByJobServer()) {
        content.replaceChildren(loadingNote(ui.app.loadGap));
        return;
      }
      window.dispatchEvent(new CustomEvent("signin-required"));
      content.replaceChildren(loadingNote(ui.common.signInToLoad(label)));
      return;
    }
    console.error(err);
    content.replaceChildren(loadingNote(ui.app.failedToLoad((err as Error).message)));
    return;
  }

  const photos = Object.values(shard.photos).sort((a, b) => (a.takenAt ?? "").localeCompare(b.takenAt ?? ""));
  const days = dayIndexOf(index);
  // Memoised and already fetched by the home page; a library with no map
  // index simply has no days out to draw.
  const home = await loadHomeIndex().catch(() => null);
  const excursions = new Map((home?.excursions ?? []).map((e) => [e.date, e] as const));

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
  const heading = el<HTMLDivElement>(`
    <div class="month-heading">
      <div class="heading-title-group">
        <h1></h1>
        <span class="heading-meta"></span>
      </div>
      <div class="heading-actions"></div>
    </div>
  `);
  heading.querySelector("h1")!.textContent = label;
  heading.querySelector(".heading-meta")!.textContent =
    `${ui.common.photos(summary.photoCount)} · ${ui.common.days(ordered.length)}`;
  frag.appendChild(heading);
  const actions = heading.querySelector<HTMLDivElement>(".heading-actions")!;
  addPinControl(actions, "month", summary.month);
  addExportButton(actions);

  const entries: ContentsEntry[] = [];
  for (const date of ordered) {
    const section = renderDaySection(date, byDay.get(date)!, days.get(date), shard.photos, "album", excursions.get(date));
    frag.appendChild(section);
    entries.push(dayEntry(section, date, days.get(date), excursions.get(date)));
  }

  content.replaceChildren(withContents(frag, entries));
  // After the heading's controls — see showTrip.
  content.scrollTop = restoreScrollTop ?? 0;
  restoreScrollTop = null;
  lookAhead(photos.map((p) => p.id));
}

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
  rememberPref({ navOpenGroups: [...open] });
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
 * Children do not repeat their parent's icon — a pin on a parent row and a
 * second pin under it said the same thing twice — but they still have to land on
 * that same axis, so `.month-link` indents its label by the icon-plus-gap
 * width its parent spent on an icon it doesn't have (see style.css).
 */
const GROUP_ICON = { trips: "trips", calendar: "calendar" } as const;

function navGroup(nav: HTMLElement, id: string, title: string, count: number, open: Set<string>): HTMLDivElement {
  const groupIcon = id === "trips" ? GROUP_ICON.trips : GROUP_ICON.calendar;
  const header = el<HTMLButtonElement>(
    `<button class="nav-year" type="button">
       ${icon(groupIcon, 0, "nav-year-icon")}
       <span class="nav-year-name"></span>
       <span class="nav-year-count"></span>
       ${icon("twisty", 12, "nav-year-twisty")}
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

  // First run opens the newest year only, keeping the nav tidy on first load.
  const open = storedOpenGroups() ?? new Set(years.slice(0, 1));

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
       ${icon("generate", 0, "nav-tool-icon")}
       <span class="nav-label">${ui.nav.generate}</span>
     </button>`,
  );
  generate.addEventListener("click", () => {
    closeSidebarIfOverlay();
    cancelLookAhead();
    releaseSettings();
    releaseActivity();
    clearActive();
    generate.classList.add("active");
    enter("#generate");
    setTitle(ui.nav.generate);
    showGenerate();
  });
  // A remote reader is not offered Generate at all — never appended, rather
  // than appended and then hidden. `revealBackendTools` would hide it anyway,
  // but that runs after this and after a health check; building the sidebar as
  // it should be for this client leaves no window where it exists.
  if (canWrite()) tools.appendChild(generate);

  const home = el<HTMLButtonElement>(
    `<button class="month-link nav-tool" id="nav-home" type="button">
       ${icon("home", 0, "nav-tool-icon")}
       <span class="nav-label">${ui.nav.home}</span>
     </button>`,
  );
  home.addEventListener("click", () => {
    closeSidebarIfOverlay();
    cancelLookAhead();
    releaseSettings();
    releaseActivity();
    clearActive();
    home.classList.add("active");
    enter("#home");
    setTitle(ui.nav.home);
    void showHome();
  });
  // Its own slot above the nav rather than among the tools at the bottom: it
  // is where the app starts. Search, which had its own entry here, is on the
  // home page itself now.
  document.getElementById("nav-top")!.replaceChildren(home);


  // Hidden until a backend answers, like Generate — see activity.ts.
  const activity = el<HTMLButtonElement>(
    `<button class="month-link nav-tool" id="nav-activity" type="button" hidden>
       ${icon("activity", 0, "nav-tool-icon")}
       <span class="nav-label">${ui.nav.activity}</span>
       <span class="nav-activity-status"></span>
     </button>`,
  );
  activity.addEventListener("click", () => {
    closeSidebarIfOverlay();
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
       ${icon("settings", 0, "nav-tool-icon")}
       <span class="nav-label">${ui.nav.settings}</span>
     </button>`,
  );
  settings.addEventListener("click", () => {
    closeSidebarIfOverlay();
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
    closeSidebarIfOverlay();
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
function addPinControl(container: HTMLElement, kind: "trip" | "month", id: string): void {
  // An empty slot, placed synchronously so it holds its position in the flex
  // row while the server is asked. Without it the button would arrive after
  // "Save as PDF" and land on the wrong side of it.
  const slot = el<HTMLSpanElement>(`<span class="page-pin-slot"></span>`);
  container.appendChild(slot);

  // `cached`, deliberately. Pins are local state — they live in sync.json — so
  // the eTag comparison the checked call makes is irrelevant to them, and it
  // costs a Graph round trip: measured 1,344ms against 181ms, on every month
  // and trip you open. Settings learned the same lesson the same way.
  void syncStatus({ cached: true }).then((status) => {
    if (!status) return;
    const button = el<HTMLButtonElement>(`
      <button class="btn-action btn-pin page-pin" type="button">
        ${icon("pin", 13, "pin-icon")}
        <span class="pin-label"></span>
      </button>
    `);
    let pinned = status.pins.some((p) => p.kind === kind && p.id === id);

    const cloudIcon = `<path fill="currentColor" fill-rule="evenodd" d="M5.5 17a4.5 4.5 0 0 1-1.44-8.765 4.5 4.5 0 0 1 8.302-3.046 3.5 3.5 0 0 1 4.504 4.272A4 4 0 0 1 15 17H5.5zm4.75-7.75a.75.75 0 0 0-1.5 0v3.19l-.72-.72a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l2-2a.75.75 0 1 0-1.06-1.06l-.72.72V9.25z" clip-rule="evenodd"/>`;
    const checkIcon = `<path fill="currentColor" fill-rule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5z" clip-rule="evenodd"/>`;

    const paint = () => {
      const labelText = pinned ? ui.nav.kept : ui.nav.keep;
      button.querySelector(".pin-label")!.textContent = labelText;
      button.querySelector(".pin-icon")!.innerHTML = pinned ? checkIcon : cloudIcon;
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
  // The server answering is not the same as *this* browser being allowed to
  // write to it: a remote reader is served by the very same server, and for
  // them every one of these controls would answer 403. `canWrite` is the
  // server's own answer (see backend.ts); the 403 stays as the backstop.
  const writable = canWrite();
  setDayEditingAvailable(writable);
  const generate = document.getElementById("nav-generate");
  if (generate) generate.hidden = !writable;
  // Activity stays — a reader may watch the job — but it is trimmed inside
  // (history, batches, the cancel button): see activity.ts.
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
type View =
  | { kind: "trip" | "month"; id: string }
  | { kind: "settings" }
  | { kind: "generate" }
  | { kind: "activity" }
  | { kind: "home" };

function viewFromHash(): View | null {
  // A photograph's address is its view plus `/photo/<id>`: the page under it is
  // the view, and the viewer reconciles itself with the tail separately.
  const hash = splitPhoto(location.hash).view;
  // A group inside Settings is part of its address (`#settings/sync`), so a
  // failed job's error can link straight to the pane that fixes it.
  if (/^#settings(?:\/|$)/.test(hash)) return { kind: "settings" };
  if (hash === "#generate") return { kind: "generate" };
  if (hash === "#activity") return { kind: "activity" };
  // Search moved onto the home page; an old #search link lands there.
  if (hash === "#search") return { kind: "home" };
  if (hash === "#home") return { kind: "home" };
  const match = /^#(trip|month)\/(.+)$/.exec(hash);
  return match ? { kind: match[1] as "trip" | "month", id: decodeURIComponent(match[2]) } : null;
}

/** The nav element that opens a view — a row, or a tool button. */
function rowFor(view: View | null): HTMLElement | null {
  if (!view) return null;
  if (view.kind === "settings") return document.getElementById("nav-settings");
  if (view.kind === "generate") return document.getElementById("nav-generate");
  if (view.kind === "activity") return document.getElementById("nav-activity");
  if (view.kind === "home") return document.getElementById("nav-home");
  return document.querySelector<HTMLElement>(
    `#month-nav .month-link[data-pin-kind="${view.kind}"][data-pin-id="${CSS.escape(view.id)}"]`,
  );
}

/**
 * Default view on startup: Home page first.
 */
function defaultRow(): HTMLElement | null {
  return (
    document.getElementById("nav-home") ??
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
  // A Settings group is part of the address (`#settings/sync`). Reopening
  // Settings — on load, after Back, after a re-render — must not strip it and
  // silently drop the reader on the first pane.
  const target = hash === "#settings" && location.hash.startsWith("#settings/") ? location.hash : hash;
  if (historyMode === "push" && location.hash !== target) history.pushState(null, "", target);
  else history.replaceState(null, "", target);
  currentHash = target;
  // The page a photograph would open over. Set here rather than read from the
  // address, which carries the photograph once the viewer is up.
  setBaseView(hash);
}

/**
 * The tab and history entry say what is open. Every tab read "Photo Archive"
 * whatever it showed, and so did every entry in the Back menu — which made the
 * history this file now keeps unreadable.
 */
let pageTitle = "";

function setTitle(page: string): void {
  pageTitle = page;
  // Read here rather than captured in a constant above: the language can still
  // be applied in place while the app starts, and a captured title would go on
  // saying "Photo Archive" for the life of the page.
  document.title = `${page} · ${ui.app.title}`;
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
    const { view: hash, photoId } = splitPhoto(location.hash);
    // The viewer follows the address in both directions: Back out of a
    // photograph closes it, Forward into one opens it.
    void syncPhotoRoute(photoId);
    // Same page underneath — closing the viewer, or a step that only replaced
    // the photograph. Redrawing it would throw away the scroll offset and, on a
    // trip, re-run the whole render for nothing.
    if (hash === currentHash) return;
    const view = viewFromHash();
    const row = rowFor(view);
    if (row && (view?.kind === "trip" || view?.kind === "month")) restoreScrollTop = storedScroll(hash);
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
  // A photograph's address is resolved against the index — its trip's days say
  // which month shard holds it.
  setIndex(index);
  // Read the address here, before anything rewrites it. Reopening the view
  // replaces the hash with the view's own, which drops a `#trip/<id>/photo/<id>`
  // tail — and the tail is what the last step of this function needs, so reading
  // it down there raced the view's own open and lost on a cold load.
  const photoId = splitPhoto(location.hash).photoId;
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
    restoreScrollTop = storedScroll(splitPhoto(location.hash).view);
  }
  reopen(row ?? defaultRow());

  // The address may name a photograph over this view — a shared link, a reload
  // with the viewer open, or Back into one.
  if (photoId) void syncPhotoRoute(photoId);
}
