import type { ArchiveIndexFile, DayRecord, MonthSummary, PhotoRecord, TripRecord } from "@travel-archive/shared";
import { loadMonth, SignInRequiredError } from "./archiveData";
import { el, lazyImg, openFullPhoto } from "./photoUi";
import { renderDayBody } from "./render";
import { renderTripMap } from "./tripMap";
import { releaseThumbnails } from "./graphPhoto";
import { thumbnailSource } from "./photoSource";

/**
 * Ask the cache to fill itself for a whole view, before scrolling asks for any
 * of it.
 *
 * A browser holds ~6 connections to one host, so a cold cache turns a fast
 * scroll into a queue: 169 requests measured at a p90 of 22 seconds. The server
 * has no such limit — 30 at once finished in 2.2s — so the fix is to fetch
 * early at a concurrency the browser cannot reach, after which every request is
 * a read from disk.
 */
function warmView(photoIds: string[]): void {
  void thumbnailSource()?.warm?.(photoIds, "large");
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
    img.addEventListener("click", () => openFullPhoto(photo));
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
  releaseThumbnails();
  content.replaceChildren(el(`<div class="loading">Loading ${trip.name}…</div>`));

  const months = [...new Set(trip.days.map((d) => d.date.slice(0, 7)))];
  const photos: Record<string, PhotoRecord> = {};
  try {
    for (const month of months) Object.assign(photos, (await loadMonth(month)).photos);
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
  warmView(trip.days.flatMap((d) => d.photoIds));

  // After the page is on screen: the basemap is a ~750KB dynamic import, and
  // the trip should be readable before it lands.
  void renderTripMap(trip, photos, (anchor) => scrollToStop(anchor)).then((map) => {
    if (map) mapSlot.replaceChildren(map);
  });
}

async function showMonth(summary: MonthSummary, index: ArchiveIndexFile): Promise<void> {
  const content = document.getElementById("content")!;
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
  warmView(photos.map((p) => p.id));
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
      const link = el<HTMLButtonElement>(
        `<button class="month-link trip-link" type="button"><span class="month-name"></span><span class="month-count"></span></button>`,
      );
      link.querySelector(".month-name")!.textContent = trip.name;
      link.querySelector(".month-count")!.textContent = String(
        trip.days.reduce((n, d) => n + d.photoIds.length, 0),
      );
      link.addEventListener("click", () => {
        nav.querySelectorAll(".month-link").forEach((n) => n.classList.remove("active"));
        link.classList.add("active");
        void showTrip(trip);
      });
      nav.appendChild(link);
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

    const link = el<HTMLButtonElement>(`<button class="month-link" type="button"><span class="month-name"></span><span class="month-count"></span></button>`);
    // Month name without the year — the year is already the group heading above.
    link.querySelector(".month-name")!.textContent = formatMonthLabel(summary.month, false);
    link.querySelector(".month-count")!.textContent = String(summary.photoCount);
    link.addEventListener("click", () => {
      nav.querySelectorAll(".month-link").forEach((n) => n.classList.remove("active"));
      link.classList.add("active");
      link.scrollIntoView({ block: "nearest", inline: "nearest" });
      void showMonth(summary, index);
    });
    nav.appendChild(link);
  }
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
