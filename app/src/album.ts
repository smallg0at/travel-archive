import type { ArchiveIndexFile, DayRecord, MonthSummary, PhotoRecord, TripRecord } from "@travel-archive/shared";
import { loadMonth, SignInRequiredError } from "./archiveData";
import { el, lazyImg } from "./photoUi";
import { openPhoto } from "./viewer";
import { renderDayBody } from "./render";
import { renderTripMap } from "./tripMap";
import { releaseThumbnails } from "./graphPhoto";
import { thumbnailSource } from "./photoSource";
import { checkHealth, setPin as savePin, syncStatus } from "./backend";
import { releaseSettings, showSettings } from "./settings";
import { showGenerate } from "./tripMode";
import { canPrint, printView } from "./print";

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
const DENSITY_LABEL: Record<Density, string> = { compact: "Small", comfortable: "Medium", spacious: "Large" };

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
  const wrap = el<HTMLDivElement>(`<div class="density-control" role="group" aria-label="Thumbnail size"></div>`);
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
  const button = el<HTMLButtonElement>(`<button class="page-export" type="button">Save as PDF</button>`);
  button.addEventListener("click", () => void printView());
  heading.appendChild(button);
}

function dayOf(photo: PhotoRecord): string {
  return photo.takenAt ? photo.takenAt.slice(0, 10) : UNDATED;
}

/**
 * Month labels are formatted here rather than read from `MonthSummary.label`,
 * which the pipeline bakes in as en-US. Day headings are formatted client-side
 * in the viewer's locale, so taking the month from the pipeline left the nav
 * reading "September" above a heading reading "2026年9月1日周二". Deriving both
 * from the raw `yyyy-mm` keeps them in one language — the viewer's.
 */
function formatMonthLabel(month: string, withYear = true): string {
  const [year, m] = month.split("-").map(Number);
  return new Date(Date.UTC(year, m - 1, 1)).toLocaleDateString(undefined, {
    month: "long",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
}

function formatDayHeading(date: string): string {
  if (date === UNDATED) return "Undated";
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** Every day `organize` has written, flattened across sections, keyed by date. */
function dayIndexOf(index: ArchiveIndexFile): Map<string, DayRecord> {
  return new Map(index.sections.flatMap((s) => s.days).map((d) => [d.date, d] as const));
}

function renderAlbumGrid(photos: PhotoRecord[]): HTMLElement {
  const grid = el<HTMLDivElement>(`<div class="album-grid"></div>`);
  for (const photo of photos) {
    const cell = el<HTMLDivElement>(`<div class="album-cell"></div>`);
    // Always "large" — see the Density comment above for why "medium" can't
    // render a tall photo crisply at any usable cell size.
    const img = lazyImg(photo, "large");
    img.addEventListener("click", () => openPhoto(photo));
    cell.appendChild(img);
    grid.appendChild(cell);
  }
  return grid;
}

function renderDaySection(
  date: string,
  photos: PhotoRecord[],
  day: DayRecord | undefined,
  byId: Record<string, PhotoRecord>,
): HTMLElement {
  const section = el<HTMLElement>(`<section class="day-page"></section>`);

  const header = el<HTMLDivElement>(`
    <div class="day-header">
      <div class="day-title"></div>
      <div class="day-meta"></div>
    </div>
  `);
  header.querySelector(".day-title")!.textContent = formatDayHeading(date);
  header.querySelector(".day-meta")!.textContent =
    `${photos.length} photo${photos.length === 1 ? "" : "s"}${day?.place ? ` · ${day.place}` : ""}`;

  if (day?.summary) {
    const summary = el<HTMLDivElement>(`<div class="day-summary"></div>`);
    summary.textContent = day.summary;
    header.appendChild(summary);
  }
  section.appendChild(header);

  // A day broken into stops renders as a page; everything else is a plain
  // chronological grid, which is the whole album before any tokens are spent.
  if (day?.segments?.length) {
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
  cancelLookAhead();
  releaseSettings();
  releaseThumbnails();
  content.replaceChildren(el(`<div class="loading">Loading ${trip.name}…</div>`));

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
      content.replaceChildren(el(`<div class="loading">Sign in to load ${trip.name}.</div>`));
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
  header.querySelector("h1")!.textContent = trip.name;
  const photoCount = trip.days.reduce((n, d) => n + d.photoIds.length, 0);
  header.querySelector("span")!.textContent =
    `${formatDayHeading(trip.startDate)} – ${formatDayHeading(trip.endDate)} · ${trip.days.length} days · ${photoCount} photos`;
  frag.appendChild(header);

  if (trip.narrative) {
    const narrative = el<HTMLDivElement>(`<div class="trip-narrative"></div>`);
    // Paragraph by paragraph as text nodes — this is model output and must
    // never be parsed as markup.
    for (const para of trip.narrative.split(/\n\s*\n/)) {
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
      chip.textContent = place;
      places.appendChild(chip);
    }
    frag.appendChild(places);
  }

  const mapSlot = el<HTMLDivElement>(`<div class="trip-map-slot"></div>`);
  frag.appendChild(mapSlot);

  for (const day of trip.days) {
    const dayPhotos = day.photoIds.map((id) => photos[id]).filter(Boolean);
    frag.appendChild(renderDaySection(day.date, dayPhotos, day, photos));
  }

  content.replaceChildren(frag);
  content.scrollTop = 0;
  addPinControl(header, "trip", trip.id);
  addExportButton(header);
  lookAhead(trip.days.flatMap((d) => d.photoIds));

  // After the page is on screen: the basemap is a ~750KB dynamic import, and
  // the trip should be readable before it lands.
  void renderTripMap(trip, photos, (anchor) => scrollToStop(anchor)).then((map) => {
    if (map) mapSlot.replaceChildren(map);
  });
}

async function showMonth(summary: MonthSummary, index: ArchiveIndexFile): Promise<void> {
  const content = document.getElementById("content")!;
  cancelLookAhead();
  releaseSettings();
  const label = formatMonthLabel(summary.month);

  // The outgoing month's thumbnails are about to be detached, so free their
  // blob URLs now rather than pinning every thumbnail decoded this session.
  // Coming back to this month re-reads from IndexedDB, not the network.
  releaseThumbnails();
  content.replaceChildren(el(`<div class="loading">Loading ${label}…</div>`));

  let shard;
  try {
    shard = await loadMonth(summary.month);
  } catch (err) {
    if (err instanceof SignInRequiredError) {
      window.dispatchEvent(new CustomEvent("signin-required"));
      content.replaceChildren(el(`<div class="loading">Sign in to load ${label}.</div>`));
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
    `${summary.photoCount} photo${summary.photoCount === 1 ? "" : "s"} · ${ordered.length} day${ordered.length === 1 ? "" : "s"}`;
  frag.appendChild(heading);

  for (const date of ordered) {
    frag.appendChild(renderDaySection(date, byDay.get(date)!, days.get(date), shard.photos));
  }

  content.replaceChildren(frag);
  content.scrollTop = 0;
  addPinControl(heading, "month", summary.month);
  addExportButton(heading);
  lookAhead(photos.map((p) => p.id));
}

function renderNav(index: ArchiveIndexFile): void {
  const nav = document.getElementById("month-nav")!;
  nav.replaceChildren();

  // Trips first: they are the things a person looks for by name. Months below
  // are the fallback for everything that was not part of one.
  const trips = index.sections.filter((s): s is TripRecord => s.kind === "trip");
  if (trips.length) {
    const label = el<HTMLDivElement>(`<div class="nav-year"></div>`);
    label.textContent = "Trips";
    nav.appendChild(label);

    for (const trip of [...trips].sort((a, b) => b.startDate.localeCompare(a.startDate))) {
      const row = navRow(
        trip.name,
        String(trip.days.reduce((n, d) => n + d.photoIds.length, 0)),
        "trip",
        trip.id,
        () => void showTrip(trip),
      );
      row.classList.add("trip-link");
      nav.appendChild(row);
    }
  }

  // Newest first — a photo library is browsed from the recent end.
  const months = [...index.months].sort((a, b) => b.month.localeCompare(a.month));
  let currentYear = "";

  for (const summary of months) {
    const year = summary.month.slice(0, 4);
    if (year !== currentYear) {
      currentYear = year;
      const label = el<HTMLDivElement>(`<div class="nav-year"></div>`);
      label.textContent = year;
      nav.appendChild(label);
    }

    // Month name without the year — the year is already the group heading above.
    const row = navRow(
      formatMonthLabel(summary.month, false),
      String(summary.photoCount),
      "month",
      summary.month,
      () => void showMonth(summary, index),
    );
    nav.appendChild(row);
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
    `<button class="month-link nav-tool" id="nav-generate" type="button" hidden><span class="month-name">Generate</span></button>`,
  );
  generate.addEventListener("click", () => {
    cancelLookAhead();
    releaseSettings();
    clearActive();
    generate.classList.add("active");
    showGenerate();
  });
  tools.appendChild(generate);

  const settings = el<HTMLButtonElement>(
    `<button class="month-link nav-tool" type="button"><span class="month-name">Settings</span></button>`,
  );
  settings.addEventListener("click", () => {
    // Leaving a view cancels its look-ahead. Without this, glancing at a trip
    // and clicking straight to Settings still fired the warm two seconds later
    // — the dwell delay only helps if every exit cancels it, not just the two
    // that happen to render a view.
    cancelLookAhead();
    clearActive();
    settings.classList.add("active");
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
       <span class="month-name"></span>
       <span class="month-count"></span>
     </button>`,
  );
  row.querySelector(".month-name")!.textContent = name;
  row.querySelector(".month-count")!.textContent = count;
  row.dataset.pinKind = kind;
  row.dataset.pinId = id;

  row.addEventListener("click", () => {
    clearActive();
    row.classList.add("active");
    row.scrollIntoView({ block: "nearest", inline: "nearest" });
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
      button.textContent = pinned ? "▣ Kept on this device" : "☁ Keep on this device";
      button.classList.toggle("pinned", pinned);
      button.title = pinned
        ? "Photos here are kept on this device and are never evicted to make room."
        : "Fetch these photos and keep them on this device.";
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
  const generate = document.getElementById("nav-generate");
  if (generate) generate.hidden = false;
}

export function renderAlbum(index: ArchiveIndexFile): void {
  const content = document.getElementById("content")!;
  applyDensity();

  if (index.months.length === 0) {
    content.replaceChildren(
      el(`<div class="loading">Archive is empty. Run <code>npm run --workspace pipeline scan</code> to index your photos.</div>`),
    );
    return;
  }

  renderNav(index);
  // Open the newest month automatically — the nav is sorted newest-first.
  (document.querySelector(".month-link") as HTMLButtonElement | null)?.click();
}
