import type { DayRecord, DaySegment, Highlight, PhotoRecord, TripRecord } from "@travel-archive/shared";
import { SignInRequiredError } from "../archiveData";
import { loadMonthKept } from "./cache";
import { anchorFor } from "../tripMap";
import { el, lazyImg } from "../photoUi";
import { loc, locDay } from "../contentLang";
import { num, ui } from "../i18n";
import { go, replace } from "./router";
import { cardContext, openViewer } from "./viewer";
import { dateOf, dayOutPlace, daysOut, ICONS, longDate, note, pageBar, screen, sectionFor, shortDate, spinner, timeRange, titleWhenPast } from "./ui";

/**
 * One day as a page: the phone's unit of reading.
 *
 * The desktop renders a whole trip as one document — 18 days, 125 places, 725
 * cards and 4,685 photos for the reference trip — and that is the page a phone
 * would choke on: every one of those is a DOM node with a grid layout, whether
 * or not its image has loaded. So on the phone a trip is an overview, and a day
 * is where the pictures are, with the previous and next day one tap away.
 *
 * The layout rules are the desktop's (render.ts), redrawn for one column:
 *  - a photo appears **once**. Cards claim theirs; the rest go behind "N more".
 *  - a photo that only describes another — a placard, a menu — never appears;
 *    its text is in the card and in the viewer.
 *  - transit collapses to one line.
 *
 * What changes is the card's shape. Four columns do not fit a phone, so size
 * becomes weight in a single column: `full` is a full-bleed picture, `half` a
 * shorter one, and `normal` — up to 30 of them at a busy museum — a list row
 * with a small square, which is what keeps a 28-card stop scrollable rather
 * than a wall of full-width images.
 */

/** Grids behind "N more" are built on first open: most are never opened. */
function lazyGrid(photos: PhotoRecord[]): HTMLElement {
  const grid = el<HTMLDivElement>(`<div class="m-grid"></div>`);
  photos.forEach((photo, i) => {
    const img = lazyImg(photo, "medium");
    img.addEventListener("click", () => openViewer(photos, i));
    grid.appendChild(img);
  });
  return grid;
}

/** A disclosure whose body is only built when it is first opened. */
function disclosure(summary: HTMLElement, build: () => HTMLElement, open = false): HTMLDetailsElement {
  const details = el<HTMLDetailsElement>(`<details class="m-more"></details>`);
  const head = document.createElement("summary");
  head.appendChild(summary);
  details.appendChild(head);
  let built = false;
  const fill = () => {
    if (built || !details.open) return;
    built = true;
    details.appendChild(build());
  };
  details.addEventListener("toggle", fill);
  details.open = open;
  fill();
  return details;
}

function images(photos: PhotoRecord[], onOpen: (i: number) => void): HTMLElement {
  if (photos.length === 1) {
    const img = lazyImg(photos[0], "large", "m-card-img");
    img.addEventListener("click", () => onOpen(0));
    return img;
  }
  // Several angles of one thing: swiped, not stacked. A counter says there
  // are more, since a swipeable row gives no other sign of it.
  const wrap = el<HTMLDivElement>(`<div class="m-carousel"><div class="m-carousel-track"></div><span class="m-carousel-count"></span></div>`);
  const track = wrap.querySelector<HTMLElement>(".m-carousel-track")!;
  const counter = wrap.querySelector<HTMLElement>(".m-carousel-count")!;
  photos.forEach((photo, i) => {
    const img = lazyImg(photo, "large", "m-card-img");
    img.addEventListener("click", () => onOpen(i));
    track.appendChild(img);
  });
  counter.textContent = ui.mobile.counter(1, photos.length);
  track.addEventListener(
    "scroll",
    () => {
      const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
      counter.textContent = ui.mobile.counter(i + 1, photos.length);
    },
    { passive: true },
  );
  return wrap;
}

function renderCard(highlight: Highlight, byId: Record<string, PhotoRecord>): HTMLElement | null {
  const photos = highlight.photoIds.map((id) => byId[id]).filter(Boolean);
  if (!photos.length) return null;
  const context = cardContext(highlight, byId);
  const open = (i: number) => openViewer(photos, i, context);

  if (highlight.size === "normal") {
    const row = el<HTMLElement>(`
      <article class="m-row-card">
        <div class="m-row-thumb"></div>
        <div class="m-row-text"><h4></h4><p></p></div>
      </article>
    `);
    const thumbHost = row.querySelector<HTMLElement>(".m-row-thumb")!;
    thumbHost.appendChild(lazyImg(photos[0], "medium"));
    if (photos.length > 1) {
      thumbHost.appendChild(Object.assign(document.createElement("span"), { className: "m-row-more", textContent: ui.mobile.moreInCard(photos.length - 1) }));
    }
    row.querySelector("h4")!.textContent = context.title;
    const desc = row.querySelector("p")!;
    if (context.description) desc.textContent = context.description;
    else desc.remove();
    // The whole row, not just the picture: it is a thumb-sized target otherwise.
    row.addEventListener("click", () => open(0));
    return row;
  }

  const card = el<HTMLElement>(`<article class="m-hl m-hl-${highlight.size}"><div class="m-hl-body"><h4></h4></div></article>`);
  card.prepend(images(photos, open));
  const body = card.querySelector<HTMLElement>(".m-hl-body")!;
  body.querySelector("h4")!.textContent = context.title;
  if (context.description) body.appendChild(Object.assign(document.createElement("p"), { textContent: context.description }));
  // The English of a placard in the open — it is content. The verbatim
  // transcript is evidence, and waits in the viewer's details.
  if (context.placard) {
    const quote = document.createElement("blockquote");
    quote.textContent = context.placard;
    body.appendChild(quote);
  }
  return card;
}

function renderStop(segment: DaySegment, byId: Record<string, PhotoRecord>, date: string): HTMLElement {
  const section = el<HTMLElement>(`
    <section class="m-stop">
      <header class="m-stop-head"><h3></h3><span></span></header>
    </section>
  `);
  section.id = anchorFor(date, segment.id);
  section.querySelector("h3")!.textContent = segment.title;
  const all = segment.photoIds.map((id) => byId[id]).filter(Boolean);
  section.querySelector("span")!.textContent = `${timeRange(segment)} · ${ui.common.photos(all.length)}`;
  if (segment.summary) section.appendChild(Object.assign(document.createElement("p"), { className: "m-stop-summary", textContent: segment.summary }));

  const claimed = new Set<string>();
  const cards = el<HTMLDivElement>(`<div class="m-cards"></div>`);
  for (const highlight of segment.highlights) {
    const card = renderCard(highlight, byId);
    if (!card) continue;
    for (const id of highlight.photoIds) claimed.add(id);
    for (const id of highlight.documentPhotoIds) claimed.add(id);
    cards.appendChild(card);
  }
  if (cards.childElementCount) section.appendChild(cards);

  const rest = all.filter((p) => !claimed.has(p.id));
  if (rest.length) {
    const label = Object.assign(document.createElement("span"), { textContent: ui.day.morePhotos(rest.length) });
    // Open when the grid is all the stop has, as on the desktop.
    section.appendChild(disclosure(label, () => lazyGrid(rest), segment.highlights.length === 0));
  }
  return section;
}

function renderTransit(segment: DaySegment, byId: Record<string, PhotoRecord>, date: string): HTMLElement {
  const photos = segment.photoIds.map((id) => byId[id]).filter(Boolean);
  const label = el<HTMLSpanElement>(`<span class="m-transit-label">${ICONS.transit}<span class="m-transit-title"></span><span class="m-transit-meta"></span></span>`);
  label.querySelector(".m-transit-title")!.textContent = segment.title;
  label.querySelector(".m-transit-meta")!.textContent = `${timeRange(segment)} · ${ui.common.photos(photos.length)}`;
  const details = disclosure(label, () => lazyGrid(photos));
  details.classList.add("m-transit");
  details.id = anchorFor(date, segment.id);
  return details;
}

/** The dates either side of this one, in its trip or month — or in its month's shard for a day never organized. */
function neighbours(date: string, section: TripRecord | null, shard: Record<string, PhotoRecord>): [string | null, string | null] {
  const dates = section
    ? section.days.map((d) => d.date)
    : [...new Set(Object.values(shard).map(dateOf).filter((d): d is string => d !== null))];
  dates.sort();
  const i = dates.indexOf(date);
  if (i < 0) return [null, null];
  return [dates[i - 1] ?? null, dates[i + 1] ?? null];
}

function dayNav(prev: string | null, next: string | null): HTMLElement {
  const nav = el<HTMLElement>(`<nav class="m-day-nav"></nav>`);
  for (const [date, label, cls] of [
    [prev, ui.mobile.previousDay, "prev"],
    [next, ui.mobile.nextDay, "next"],
  ] as const) {
    const button = el<HTMLButtonElement>(`<button type="button" class="m-day-nav-btn is-${cls}"><small></small><span></span></button>`);
    button.querySelector("small")!.textContent = label;
    if (date) {
      button.querySelector("span")!.textContent = shortDate(date);
      // Replace, not push: stepping through a trip day by day should not stack
      // eighteen pages for Back to unwind — Back returns to the trip.
      button.addEventListener("click", () => replace(`#/day/${date}`));
    } else {
      button.disabled = true;
    }
    nav.appendChild(button);
  }
  return nav;
}

async function fill(page: HTMLElement, date: string, stop: string | undefined, found: ReturnType<typeof sectionFor>): Promise<void> {
  const body = page.querySelector<HTMLElement>(".m-day-body")!;
  let shard: Record<string, PhotoRecord>;
  try {
    shard = (await loadMonthKept(date.slice(0, 7))).photos;
  } catch (err) {
    body.replaceChildren(note(err instanceof SignInRequiredError ? ui.mobile.sessionExpired : ui.app.failedToLoad((err as Error).message)));
    if (err instanceof SignInRequiredError) window.dispatchEvent(new CustomEvent("signin-required"));
    return;
  }

  const day: DayRecord | null = found ? locDay(found.day) : null;
  const trip = found?.section.kind === "trip" ? found.section : null;
  body.replaceChildren();

  const photos = day
    ? day.photoIds.map((id) => shard[id]).filter(Boolean)
    : Object.values(shard)
        .filter((p) => dateOf(p) === date)
        .sort((a, b) => (a.takenAt ?? "").localeCompare(b.takenAt ?? ""));

  const meta = page.querySelector<HTMLElement>(".m-day-meta")!;
  meta.textContent = [ui.common.photos(photos.length), day?.place ? loc(day.place) : null].filter(Boolean).join(" · ");

  // A day out is headed like a trip rather than like a day in a month: where
  // it went, in place of the date, with the date demoted to the line below.
  // The desktop settled on this (album.ts) after a version with a cover photo
  // repeated the date and the count that were already in the header.
  const excursion = (await daysOut())?.get(date);
  if (excursion) {
    page.classList.add("is-day-out");
    const kicker = el<HTMLElement>(`<p class="m-kicker"></p>`);
    kicker.textContent = ui.album.dayOut;
    const heading = page.querySelector<HTMLElement>(".m-page-head h1")!;
    heading.before(kicker);
    heading.textContent = dayOutPlace(excursion);
    meta.textContent = [longDate(date), ui.album.dayOutFar(num(excursion.awayKm)), ui.common.photos(photos.length)].join(" · ");
    page.querySelector(".m-bar-sub")?.replaceChildren(document.createTextNode(dayOutPlace(excursion)));
  }

  /**
   * How a written day out is shown: as a day with its stops and cards, or as
   * the plain grid. A reading habit rather than a property of the day, so it
   * is remembered across days and across the two apps — the desktop stores the
   * same choice under the same key.
   */
  const MODE_KEY = "day-out-mode";
  const written = Boolean(day?.segments?.length);
  const readMode = (): "trip" | "gallery" => {
    try {
      return localStorage.getItem(MODE_KEY) === "gallery" ? "gallery" : "trip";
    } catch {
      return "trip";
    }
  };
  let mode: "trip" | "gallery" = excursion && written ? readMode() : "trip";

  if (excursion && written) {
    const modes = el<HTMLElement>(`<nav class="m-seg"></nav>`);
    modes.setAttribute("aria-label", ui.album.dayMode.label);
    for (const value of ["trip", "gallery"] as const) {
      const button = el<HTMLButtonElement>(`<button type="button" class="m-seg-btn"></button>`);
      button.textContent = ui.album.dayMode[value];
      button.classList.toggle("is-active", value === mode);
      button.addEventListener("click", () => {
        if (mode === value) return;
        mode = value;
        try {
          localStorage.setItem(MODE_KEY, value);
        } catch {
          // Storage blocked: the choice still holds for this page.
        }
        for (const other of modes.querySelectorAll(".m-seg-btn")) other.classList.toggle("is-active", other === button);
        drawBody();
      });
      modes.appendChild(button);
    }
    page.querySelector(".m-page-head")!.appendChild(modes);
  }

  function drawBody(): void {
    body.replaceChildren();
    fillBody();
    const [prev, next] = neighbours(date, found?.section ?? null, shard);
    body.appendChild(dayNav(prev, next));
  }

  function fillBody(): void {
  if (!photos.length) {
    body.appendChild(note(ui.mobile.noPhotos));
  } else if (day?.segments?.length && mode === "trip") {
    // The stops as a row of chips under the heading: a day of eight places is
    // long on a phone, and this is the contents list the desktop keeps beside it.
    const places = day.segments.filter((s) => s.kind === "place");
    const chipFor = new Map<string, HTMLElement>();
    let chips: HTMLElement | null = null;
    if (places.length > 1) {
      chips = el<HTMLElement>(`<nav class="m-chips m-stop-chips"></nav>`);
      chips.setAttribute("aria-label", ui.mobile.stops);
      for (const segment of places) {
        const chip = el<HTMLButtonElement>(`<button type="button" class="m-chip"></button>`);
        chip.textContent = segment.title;
        chip.addEventListener("click", () => scrollToStop(anchorFor(date, segment.id)));
        chips.appendChild(chip);
        chipFor.set(segment.id, chip);
      }
      body.appendChild(chips);
    }
    const followed: { chip: HTMLElement; section: HTMLElement }[] = [];
    for (const segment of day.segments) {
      const section = segment.kind === "transit" ? renderTransit(segment, shard, date) : renderStop(segment, shard, date);
      body.appendChild(section);
      const chip = chipFor.get(segment.id);
      if (chip) followed.push({ chip, section });
    }
    if (chips) followStops(chips, followed);
  } else {
    body.appendChild(lazyGrid(photos));
  }
  }

  drawBody();

  if (trip) {
    const position = trip.days.findIndex((d) => d.date === date);
    page.querySelector(".m-bar-sub")?.replaceChildren(document.createTextNode(`${loc(trip.name)} · ${ui.mobile.dayOf(position + 1, trip.days.length)}`));
  }

  if (stop) requestAnimationFrame(() => scrollToStop(anchorFor(date, stop)));
}

/**
 * Brings a stop under the bar and the chip row. Once is enough here, unlike
 * the desktop's three passes (album.ts, scrollToStop): every image box on this
 * page has a fixed aspect ratio in mobile.css, so nothing above the stop grows
 * as its thumbnails arrive.
 *
 * The offset is the stop's `scroll-margin-top` in mobile.css, not a number
 * here: a fixed 64px put the heading under the chip row, which is sticky
 * beneath the bar and only exists on some days.
 */
function scrollToStop(anchor: string): void {
  document.getElementById(anchor)?.scrollIntoView({ block: "start", behavior: "smooth" });
}

/**
 * Marks the chip of the stop being read, and keeps it in view in its row —
 * a day with eight stops has more chips than fit across a phone, and a row
 * that does not follow along stops being a contents list after the third.
 */
function followStops(chips: HTMLElement, stops: { chip: HTMLElement; section: HTMLElement }[]): void {
  const bySection = new Map(stops.map((s) => [s.section, s.chip] as const));
  let current: HTMLElement | null = null;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const chip = bySection.get(entry.target as HTMLElement);
        if (!chip || chip === current) continue;
        current?.classList.remove("is-active");
        chip.classList.add("is-active");
        current = chip;
        chips.scrollTo({ left: chip.offsetLeft - 16, behavior: "smooth" });
      }
    },
    // A band just under the bar and chips: whichever stop's heading area is
    // passing through it is the one being read.
    { rootMargin: "-130px 0px -65% 0px" },
  );
  for (const { section } of stops) observer.observe(section);
}

export function renderDay(date: string, stop?: string): HTMLElement {
  const found = sectionFor(date);
  const trip = found?.section.kind === "trip" ? found.section : null;
  const page = screen("m-day");
  const bar = pageBar(shortDate(date), trip ? loc(trip.name) : "");
  page.appendChild(bar);

  const head = el<HTMLElement>(`<header class="m-page-head"><h1></h1><p class="m-day-meta"></p></header>`);
  head.querySelector("h1")!.textContent = longDate(date);
  page.appendChild(head);
  titleWhenPast(bar, head.querySelector("h1")!);

  const summary = found ? locDay(found.day).summary : null;
  if (summary) page.appendChild(Object.assign(document.createElement("p"), { className: "m-day-summary", textContent: summary }));

  const body = el<HTMLElement>(`<div class="m-day-body"></div>`);
  body.appendChild(spinner());
  page.appendChild(body);

  void fill(page, date, stop, found);
  return page;
}

/** For callers holding a date: search results, the home page, the map. */
export function openDate(date: string, stop?: string): void {
  go(stop ? `#/day/${date}/${stop}` : `#/day/${date}`);
}
