import type { DayRecord, DaySegment, Highlight, PhotoRecord } from "@travel-archive/shared";
import { el, lazyImg } from "./photoUi";
import { openCard, openPhoto } from "./viewer";
import { anchorFor } from "./tripMap";
import { addStopControls } from "./dayEdit";

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
    images.appendChild(img);
  }

  // textContent throughout: titles, descriptions and OCR are all model output.
  card.querySelector(".card-title")!.textContent = highlight.title;
  const desc = card.querySelector(".card-desc") as HTMLElement;
  if (highlight.description) desc.textContent = highlight.description;
  else desc.remove();

  // The English rendering sits in the open; the verbatim transcript stays behind
  // the toggle. A Slovak museum label transcribed faithfully is evidence, but it
  // is not content to an owner who does not read Slovak.
  if (highlight.documentTranslation) {
    const translated = document.createElement("p");
    translated.className = "card-placard";
    translated.textContent = highlight.documentTranslation;
    card.querySelector(".card-body")!.appendChild(translated);
  }

  const documents = highlight.documentPhotoIds.map((id) => byId[id]).filter(Boolean);
  const withText = documents.filter((d) => d.extractedText);
  if (withText.length > 0) {
    const details = el<HTMLDetailsElement>(
      `<details class="card-source"><summary></summary><div class="card-source-text"></div></details>`,
    );
    details.querySelector("summary")!.textContent = highlight.documentTranslation
      ? "Original text"
      : withText.length === 1
        ? "From the placard"
        : `From ${withText.length} placards`;
    details.querySelector(".card-source-text")!.textContent = withText
      .map((d) => d.extractedText)
      .join("\n\n");
    card.querySelector(".card-body")!.appendChild(details);
  }

  return card;
}

function renderGrid(photos: PhotoRecord[]): HTMLElement {
  const grid = el<HTMLDivElement>(`<div class="stop-grid"></div>`);
  for (const photo of photos) {
    const img = lazyImg(photo, "large");
    // No card here: the collapsed "more photos" grid and the transit strips are
    // ordinary photographs, and the viewer shows just the photo's own panel.
    img.addEventListener("click", () => openPhoto(photo));
    grid.appendChild(img);
  }
  return grid;
}

/**
 * A transit stop: one line and a strip. These are real photos of a real part of
 * the day — a third of this archive's travel days are shot from trains — but
 * they are not a place, so they do not get a heading of their own.
 */
function renderTransit(segment: DaySegment, byId: Record<string, PhotoRecord>): HTMLElement {
  const photos = segment.photoIds.map((id) => byId[id]).filter(Boolean);
  const wrap = el<HTMLElement>(`
    <section class="transit">
      <details>
        <summary><span class="transit-title"></span><span class="transit-meta"></span></summary>
      </details>
    </section>
  `);
  wrap.querySelector(".transit-title")!.textContent = segment.title;
  wrap.querySelector(".transit-meta")!.textContent = `${timeRange(segment)} · ${photos.length} photos`;
  wrap.querySelector("details")!.appendChild(renderGrid(photos));
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
  section.querySelector(".stop-title")!.textContent = segment.title;
  // Anchored so a city on the trip map can scroll straight to it.
  section.id = anchorFor(date, segment.id);
  addStopControls(section.querySelector(".stop-head") as HTMLElement, section, date, segment);

  const all = segment.photoIds.map((id) => byId[id]).filter(Boolean);
  section.querySelector(".stop-meta")!.textContent = `${timeRange(segment)} · ${all.length} photos`;

  if (segment.summary) {
    const summary = el<HTMLParagraphElement>(`<p class="stop-summary"></p>`);
    summary.textContent = segment.summary;
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
    more.querySelector("summary")!.textContent = `${rest.length} more photo${rest.length === 1 ? "" : "s"}`;
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

  for (const segment of day.segments) {
    frag.appendChild(
      segment.kind === "transit" ? renderTransit(segment, photos) : renderPlace(segment, photos, day.date),
    );
  }
  return frag;
}
