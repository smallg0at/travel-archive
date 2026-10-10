import type { DayRecord, DaySegment, Highlight, PhotoRecord } from "@travel-archive/shared";
import { el, lazyImg, transcript, transcriptOriginal } from "./photoUi";
import { openCard, openPhoto } from "./viewer";
import { anchorFor } from "./tripMap";
import { addStopControls, isRetimable } from "./dayEdit";
import { selectionClick } from "./retime";
import { loc } from "./contentLang";
import { ui } from "./i18n";

/**
 * A day, laid out as a page rather than listed.
 *
 * The tree is Day > Place > { cards, grid }. A day is the stops it was spent
 * at; each stop shows the things worth describing, sized by how much they
 * matter, then everything else. That replaces the old single-layout-per-day approach,
 * which could only choose one shape for a whole day and so rendered a 490-photo
 * museum day exactly like a train journey.
 *
 * Three rules keep it a presentation instead of a dump:
 *  - a photo appears **once**. Cards claim theirs, the grid gets the rest. A
 *    separate hero row used to sit above the cards and both answered "what
 *    matters here", so the same photo rendered twice.
 *  - a photo that only describes another — a placard, a menu — never appears on
 *    its own; its text becomes the card's description.
 *  - transit stops collapse. They are part of the day, not places in it.
 */

function timeRange(segment: DaySegment): string {
  return `${segment.startTime.slice(11, 16)}–${segment.endTime.slice(11, 16)}`;
}

/**
 * One key picture and what it is.
 *
 * The transcribed text of any placard bound to it renders inside the card,
 * behind a toggle — it is often long, and it is evidence rather than prose.
 */
function renderCard(highlight: Highlight, byId: Record<string, PhotoRecord>): HTMLElement | null {
  const photos = highlight.photoIds.map((id) => byId[id]).filter(Boolean);
  if (photos.length === 0) return null;

  const card = el<HTMLElement>(`
    <article class="card card-${highlight.size ?? "normal"}">
      <div class="card-images"></div>
      <div class="card-body">
        <h4 class="card-title"></h4>
        <p class="card-desc"></p>
      </div>
    </article>
  `);

  const images = card.querySelector(".card-images") as HTMLElement;
  // The strip's aspect ratio is a multiple of how many photos share it, so that
  // each cell keeps the shape of a photograph however many there are — see the
  // note on `.card-images` in style.css.
  images.style.setProperty("--img-count", String(photos.length));
  for (const [i, photo] of photos.entries()) {
    const img = lazyImg(photo, "large");
    // Opening the *card*, at this image. A card is the unit the archive
    // curates — its description, its placard and its other photographs all
    // belong with the picture, and opening a lone image threw them away at the
    // moment someone was looking closest.
    img.addEventListener("click", () => openCard(highlight, byId, i));
    // The cell is the flex item and the positioning context, so a video's
    // poster can carry a badge.
    const cell = el<HTMLDivElement>(`<div class="card-cell"></div>`);
    cell.appendChild(img);
    images.appendChild(cell);
  }

  // textContent throughout: titles, descriptions and OCR are all model output.
  card.querySelector(".card-title")!.textContent = loc(highlight.title);
  const desc = card.querySelector(".card-desc") as HTMLElement;
  if (highlight.description) desc.textContent = loc(highlight.description);
  else desc.remove();

  // The English rendering sits in the open; the verbatim transcript stays behind
  // the toggle. A museum label transcribed faithfully in its own language is
  // evidence, but it is not content to an owner who does not read that language.
  if (highlight.documentTranslation) {
    const translated = document.createElement("p");
    translated.className = "card-placard";
    translated.textContent = loc(highlight.documentTranslation);
    card.querySelector(".card-body")!.appendChild(translated);
  }

  const documents = highlight.documentPhotoIds.map((id) => byId[id]).filter(Boolean);
  const withText = documents.filter((d) => d.extractedText);
  if (withText.length > 0) {
    const details = el<HTMLDetailsElement>(
      `<details class="card-source"><summary></summary><div class="card-source-text"></div></details>`,
    );
    details.querySelector("summary")!.textContent = highlight.documentTranslation
      ? ui.day.originalText
      : ui.day.fromPlacards(withText.length);
    const shown = transcript(withText.map((d) => d.extractedText as string));
    details.querySelector(".card-source-text")!.textContent = shown.shown;
    if (shown.original) details.appendChild(transcriptOriginal(shown.original, ui.day.originalText));
    card.querySelector(".card-body")!.appendChild(details);
  }

  return card;
}

function renderGrid(photos: PhotoRecord[]): HTMLElement {
  const grid = el<HTMLDivElement>(`<div class="stop-grid"></div>`);
  const imgs: HTMLImageElement[] = [];
  for (const [index, photo] of photos.entries()) {
    const img = lazyImg(photo, "large");
    if (isRetimable(photo)) img.dataset.retimable = "";
    // No card here: the collapsed "more photos" grid and the transit strips are
    // ordinary photographs, and the viewer shows just the photo's own panel.
    // Unless the click is picking photos to retime — see retime.ts.
    img.addEventListener("click", (event) => {
      if (!selectionClick(event, photos, imgs, index)) openPhoto(photo, photos);
    });
    imgs.push(img);
    const cell = el<HTMLDivElement>(`<div class="grid-cell"></div>`);
    cell.appendChild(img);
    grid.appendChild(cell);
  }
  return grid;
}

/**
 * A transit stop: one line and a strip. These are real photos of a real part of
 * the day — a third of this archive's travel days are shot from trains — but
 * they are not a place, so they do not get a heading of their own.
 */
function renderTransit(segment: DaySegment, byId: Record<string, PhotoRecord>, open = false): HTMLElement {
  const photos = segment.photoIds.map((id) => byId[id]).filter(Boolean);
  const wrap = el<HTMLElement>(`
    <section class="transit">
      <details>
        <summary><span class="transit-title"></span><span class="transit-meta"></span></summary>
      </details>
    </section>
  `);
  wrap.querySelector(".transit-title")!.textContent = loc(segment.title);
  wrap.querySelector(".transit-meta")!.textContent = `${timeRange(segment)} · ${ui.common.photos(photos.length)}`;
  wrap.querySelector("details")!.appendChild(renderGrid(photos));
  // Open when the transit *is* the day — a day with no place stop would
  // otherwise be a summary and a lone collapsed line, every photograph behind
  // it. With a place stop present the strip stays collapsed, which is the point
  // of it: most of a travel day's frames are shot from the train.
  wrap.querySelector("details")!.open = open;
  // Marked for the print stylesheet, which otherwise drops every transit strip
  // as part of the unreviewed roll (@media print in style.css). A transit-only
  // day has nothing else to print, so this one is let through rather than
  // exporting the day with no pictures at all.
  if (open) wrap.classList.add("is-the-day");
  return wrap;
}

function renderPlace(segment: DaySegment, byId: Record<string, PhotoRecord>, date: string): HTMLElement {
  const section = el<HTMLElement>(`
    <section class="stop">
      <div class="stop-head">
        <h3 class="stop-title"></h3>
        <span class="stop-meta"></span>
      </div>
    </section>
  `);
  section.querySelector(".stop-title")!.textContent = loc(segment.title);
  // Anchored so a city on the trip map can scroll straight to it.
  section.id = anchorFor(date, segment.id);
  addStopControls(section.querySelector(".stop-head") as HTMLElement, section, date, segment);

  const all = segment.photoIds.map((id) => byId[id]).filter(Boolean);
  section.querySelector(".stop-meta")!.textContent = `${timeRange(segment)} · ${ui.common.photos(all.length)}`;

  if (segment.summary) {
    const summary = el<HTMLParagraphElement>(`<p class="stop-summary"></p>`);
    summary.textContent = loc(segment.summary);
    section.appendChild(summary);
  }

  // Claimed once, in order of prominence — a photo must never appear twice on
  // the page, and a bound placard must never appear at all.
  const claimed = new Set<string>();

  const cards = el<HTMLDivElement>(`<div class="cards"></div>`);
  for (const highlight of segment.highlights) {
    const card = renderCard(highlight, byId);
    if (!card) continue;
    for (const id of highlight.photoIds) claimed.add(id);
    for (const id of highlight.documentPhotoIds) claimed.add(id);
    cards.appendChild(card);
  }
  if (cards.childElementCount > 0) section.appendChild(cards);

  const rest = all.filter((p) => !claimed.has(p.id));
  if (rest.length > 0) {
    const more = el<HTMLDetailsElement>(
      `<details class="stop-more"><summary></summary></details>`,
    );
    more.querySelector("summary")!.textContent = ui.day.morePhotos(rest.length);
    // Open by default when the grid *is* the stop — a place with no heroes and
    // no cards would otherwise render as a lone collapsed line.
    more.open = segment.highlights.length === 0;
    more.appendChild(renderGrid(rest));
    section.appendChild(more);
  }

  return section;
}

/** The body of a day that has been summarized — everything below its heading. */
export function renderDayBody(day: DayRecord, photos: Record<string, PhotoRecord>): DocumentFragment {
  const frag = document.createDocumentFragment();

  // A day whose only segment is transit has no place stop to carry the page, so
  // its strip opens: otherwise the whole day is a summary and one collapsed
  // line. A day with a place stop keeps its transit collapsed.
  const transitIsTheDay = !day.segments.some((segment) => segment.kind === "place");

  for (const segment of day.segments) {
    frag.appendChild(
      segment.kind === "transit" ? renderTransit(segment, photos, transitIsTheDay) : renderPlace(segment, photos, day.date),
    );
  }
  return frag;
}
