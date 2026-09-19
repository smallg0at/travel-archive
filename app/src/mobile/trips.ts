import type { PhotoRecord, TripRecord } from "@travel-archive/shared";
import { loadMonth } from "../archiveData";
import { renderTripMap } from "../tripMap";
import { el } from "../photoUi";
import { loc, locDay } from "../contentLang";
import { ui } from "../i18n";
import { go } from "./router";
import { openDate } from "./day";
import {
  archive,
  coverIds,
  note,
  pageBar,
  paragraphs,
  photoCount,
  rangeLabel,
  screen,
  shortDate,
  thumb,
  titleWhenPast,
  tripCoverId,
  trips,
} from "./ui";

/**
 * Trips: the list, and a trip's own page.
 *
 * A trip page on the phone is the desktop's top half — title, narrative,
 * places, map — and then its days as rows rather than as the days themselves.
 * The narrative is the first thing to read (design brief: "This is the first
 * thing you read"); the pictures are a tap further, one day at a time. See
 * day.ts for why a whole trip is never one page here.
 */

/** A trip as a picture with its name on it. `compact` is the home page's sideways row. */
export function tripCard(trip: TripRecord, variant: "full" | "compact" = "full"): HTMLElement {
  const card = el<HTMLElement>(`
    <article class="m-trip-card is-${variant}">
      <div class="m-trip-cover"></div>
      <div class="m-trip-text"><h3></h3><p class="m-trip-range"></p><p class="m-trip-meta"></p></div>
    </article>
  `);
  const cover = tripCoverId(trip);
  if (cover) card.querySelector(".m-trip-cover")!.appendChild(thumb(cover, "large"));
  card.querySelector("h3")!.textContent = loc(trip.name);
  card.querySelector(".m-trip-range")!.textContent = rangeLabel(trip.startDate, trip.endDate);
  const meta = card.querySelector<HTMLElement>(".m-trip-meta")!;
  if (variant === "full") {
    meta.textContent = [ui.mobile.tripMeta(trip.days.length, photoCount(trip)), trip.places.slice(0, 4).map((p) => loc(p)).join(" · ")]
      .filter(Boolean)
      .join("\n");
  } else {
    meta.textContent = ui.mobile.tripMeta(trip.days.length, photoCount(trip));
  }
  card.addEventListener("click", () => go(`#/trip/${encodeURIComponent(trip.id)}`));
  return card;
}

export function renderTrips(): HTMLElement {
  const page = screen("m-trips");
  const head = el<HTMLElement>(`<header class="m-large-head"><h1></h1></header>`);
  head.querySelector("h1")!.textContent = ui.mobile.trips;
  page.appendChild(head);
  const list = trips();
  if (!list.length) {
    page.appendChild(note(ui.mobile.noTrips));
    return page;
  }
  const grid = el<HTMLElement>(`<div class="m-trip-list"></div>`);
  for (const trip of list) grid.appendChild(tripCard(trip));
  page.appendChild(grid);
  return page;
}

/**
 * The route map. It needs every photo's position, which lives in the month
 * shards, so it is the one part of the trip page that downloads them — after
 * the text is up, not before, and only the months the trip actually spans.
 */
async function fillMap(slot: HTMLElement, trip: TripRecord): Promise<void> {
  const months = [...new Set(trip.days.map((d) => d.date.slice(0, 7)))];
  const shards = await Promise.all(months.map((m) => loadMonth(m).catch(() => null)));
  const photos: Record<string, PhotoRecord> = {};
  for (const shard of shards) if (shard) Object.assign(photos, shard.photos);
  const map = await renderTripMap(trip, photos, (anchor) => {
    // "stop-2026-08-19-s3": the day, then the stop.
    const match = /^stop-(\d{4}-\d{2}-\d{2})-(.+)$/.exec(anchor);
    if (match) openDate(match[1], match[2]);
  });
  if (!slot.isConnected) return;
  if (!map) {
    slot.remove();
    return;
  }
  map.classList.add("m-map");
  slot.replaceWith(map);
}

function dayRow(trip: TripRecord, index: number): HTMLElement {
  const day = locDay(trip.days[index]);
  const row = el<HTMLElement>(`
    <article class="m-day-row">
      <div class="m-day-row-thumb"></div>
      <div class="m-day-row-text">
        <div class="m-day-row-head"><strong></strong><span></span></div>
        <div class="m-day-row-place"></div>
        <p></p>
      </div>
    </article>
  `);
  const [cover] = coverIds(day, 1);
  if (cover) row.querySelector(".m-day-row-thumb")!.appendChild(thumb(cover, "medium"));
  row.querySelector("strong")!.textContent = ui.mobile.dayN(index + 1);
  row.querySelector(".m-day-row-head span")!.textContent = shortDate(day.date);
  const place = row.querySelector<HTMLElement>(".m-day-row-place")!;
  if (day.place) place.textContent = day.place;
  else place.remove();
  const summary = row.querySelector("p")!;
  if (day.summary) summary.textContent = day.summary;
  else summary.textContent = ui.common.photos(day.photoIds.length);
  row.addEventListener("click", () => openDate(day.date));
  return row;
}

export function renderTrip(id: string): HTMLElement {
  const trip = archive().sections.find((s) => s.id === id);
  const page = screen("m-trip");
  if (!trip) {
    page.append(pageBar(ui.mobile.trips, "", { alwaysTitled: true }), note(ui.app.failedToLoad(id)));
    return page;
  }

  const bar = pageBar(loc(trip.name));
  page.appendChild(bar);

  const cover = tripCoverId(trip);
  if (cover) {
    const hero = el<HTMLElement>(`<div class="m-hero"></div>`);
    hero.appendChild(thumb(cover, "large"));
    page.appendChild(hero);
  }

  const head = el<HTMLElement>(`<header class="m-page-head"><h1></h1><p></p></header>`);
  head.querySelector("h1")!.textContent = loc(trip.name);
  head.querySelector("p")!.textContent = `${rangeLabel(trip.startDate, trip.endDate)} · ${ui.mobile.tripMeta(trip.days.length, photoCount(trip))}`;
  page.appendChild(head);
  titleWhenPast(bar, head.querySelector("h1")!);

  if (trip.narrative) {
    // Clamped with a "Read more": ~380 words is two screens on a phone, and
    // the days are what most visits come for. The first paragraph still
    // reads whole above the fold.
    const story = el<HTMLElement>(`<section class="m-narrative is-clamped"><div class="m-narrative-text"></div><button type="button" class="m-link"></button></section>`);
    story.querySelector(".m-narrative-text")!.appendChild(paragraphs(loc(trip.narrative)));
    const toggle = story.querySelector<HTMLButtonElement>(".m-link")!;
    toggle.textContent = ui.mobile.readMore;
    toggle.addEventListener("click", () => {
      const clamped = story.classList.toggle("is-clamped");
      toggle.textContent = clamped ? ui.mobile.readMore : ui.mobile.readLess;
    });
    page.appendChild(story);
  }

  if (trip.places.length) {
    const places = el<HTMLElement>(`<div class="m-chips m-place-chips"></div>`);
    places.setAttribute("aria-label", ui.mobile.places);
    for (const place of trip.places) places.appendChild(Object.assign(document.createElement("span"), { className: "m-chip is-static", textContent: loc(place) }));
    page.appendChild(places);
  }

  const mapSection = el<HTMLElement>(`<section class="m-section"><h2 class="m-section-title"></h2><div class="m-map-slot"></div></section>`);
  mapSection.querySelector("h2")!.textContent = ui.mobile.route;
  const slot = mapSection.querySelector<HTMLElement>(".m-map-slot")!;
  slot.textContent = ui.map.loading;
  page.appendChild(mapSection);
  void fillMap(slot, trip).catch(() => mapSection.remove());

  const days = el<HTMLElement>(`<section class="m-section"><h2 class="m-section-title"></h2><div class="m-day-list"></div></section>`);
  days.querySelector("h2")!.textContent = ui.mobile.days;
  const list = days.querySelector<HTMLElement>(".m-day-list")!;
  trip.days.forEach((_, i) => list.appendChild(dayRow(trip, i)));
  page.appendChild(days);

  return page;
}

