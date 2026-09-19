import type { Highlight, PhotoRecord } from "@travel-archive/shared";
import { loadFullPhoto, loadLarge, releaseFullPhoto } from "../graphPhoto";
import { el } from "../photoUi";
import { contentLanguage, loc } from "../contentLang";
import { fmtDateTime, ui } from "../i18n";
import { dismiss, openLayer } from "./overlay";
import { ICONS } from "./ui";

/**
 * The full-screen photo viewer.
 *
 * Swiping between photos is a horizontal scroll-snap track, not a gesture
 * handler: the WebView scrolls it on the compositor with its own momentum and
 * edge behaviour, which nothing written in JS here would match. Only the
 * current photo and its two neighbours are ever given a source — a card's
 * "more photos" grid can hand this 400 photos, and a `large` thumbnail is
 * roughly 60KB (TODO.md, 2026-09-11), so loading them all would be 24MB of
 * mobile data for a reader who looks at three.
 *
 * Zoom resizes the image inside its slide, which is itself a native scroller,
 * so a zoomed photo pans with ordinary momentum scrolling. It does not scale a
 * layer: the desktop viewer went that way first and got compositing seams
 * (see commit db914ff, "Zoom by resizing the photo, not by scaling a layer").
 */

/** What the photos are pictures *of*, when they came from a card. */
export interface CardContext {
  title: string;
  description: string | null;
  placard: string | null;
  originalText: string | null;
}

export function cardContext(highlight: Highlight, byId: Record<string, PhotoRecord>): CardContext {
  const docs = highlight.documentPhotoIds.map((id) => byId[id]).filter((d) => d?.extractedText);
  return {
    title: loc(highlight.title),
    description: loc(highlight.description),
    placard: loc(highlight.documentTranslation),
    originalText: docs.length ? docs.map((d) => d.extractedText).join("\n\n") : null,
  };
}

const MAX_SCALE = 4;
/** Two taps closer together than this are a double tap. */
const DOUBLE_TAP_MS = 280;
const DOUBLE_TAP_SCALE = 2.5;

function placeName(photo: PhotoRecord): string | null {
  const names = photo.placeNames;
  if (names) return contentLanguage() === "zh-Hans" ? (names.zh ?? names.en) : names.en;
  return photo.place;
}

export function openViewer(photos: PhotoRecord[], start: number, context?: CardContext): void {
  if (!photos.length) return;

  const root = el<HTMLDivElement>(`
    <div class="m-viewer" role="dialog" aria-modal="true">
      <div class="m-viewer-track"></div>
      <header class="m-viewer-top">
        <button type="button" class="m-icon-btn m-viewer-close">${ICONS.close}</button>
        <span class="m-viewer-count"></span>
        <button type="button" class="m-viewer-hd"></button>
        <button type="button" class="m-icon-btn m-viewer-info-btn">${ICONS.info}</button>
      </header>
      <footer class="m-viewer-caption"><p></p></footer>
      <section class="m-viewer-sheet" hidden><div class="m-sheet-handle"></div><div class="m-viewer-sheet-body"></div></section>
    </div>
  `);
  const track = root.querySelector<HTMLElement>(".m-viewer-track")!;
  const count = root.querySelector<HTMLElement>(".m-viewer-count")!;
  const caption = root.querySelector<HTMLElement>(".m-viewer-caption p")!;
  const sheet = root.querySelector<HTMLElement>(".m-viewer-sheet")!;
  const sheetBody = root.querySelector<HTMLElement>(".m-viewer-sheet-body")!;
  const hd = root.querySelector<HTMLButtonElement>(".m-viewer-hd")!;
  root.querySelector(".m-viewer-close")!.setAttribute("aria-label", ui.common.close);
  root.querySelector(".m-viewer-info-btn")!.setAttribute("aria-label", ui.mobile.info);
  hd.textContent = ui.mobile.fullResolution;

  const slides = photos.map(() => {
    const slide = el<HTMLDivElement>(`<div class="m-slide"><img alt="" draggable="false" /></div>`);
    track.appendChild(slide);
    return slide;
  });
  const fullUrls = new Map<number, string>();
  let current = -1;

  function ensure(i: number): void {
    const img = slides[i]?.querySelector("img");
    if (!img || img.dataset.state) return;
    img.dataset.state = "loading";
    void loadLarge(photos[i].id).then((url) => {
      // Full resolution may have landed first on a fast connection; do not
      // replace it with the smaller copy.
      if (url && img.dataset.state === "loading") {
        img.src = url;
        img.dataset.state = "large";
      }
    });
  }

  /* --- Zoom ---------------------------------------------------------- */

  let scale = 1;

  function zoomTo(i: number, next: number, cx: number, cy: number): void {
    const slide = slides[i];
    const img = slide.querySelector("img")!;
    const rect = slide.getBoundingClientRect();
    // The point under the fingers, as a fraction of the image, before resizing —
    // so that it can be put back under them after.
    const before = img.getBoundingClientRect();
    const fx = (cx - before.left) / before.width;
    const fy = (cy - before.top) / before.height;

    scale = Math.min(MAX_SCALE, Math.max(1, next));
    const zoomed = scale > 1.01;
    root.classList.toggle("is-zoomed", zoomed);
    slide.classList.toggle("is-zoomed", zoomed);
    if (!zoomed) {
      scale = 1;
      img.style.width = "";
      img.style.height = "";
      return;
    }
    // Fit first, then multiply: the fitted size is what "1x" means.
    const natural = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
    const fitW = Math.min(rect.width, rect.height * natural);
    img.style.width = `${fitW * scale}px`;
    img.style.height = `${(fitW * scale) / natural}px`;
    const after = img.getBoundingClientRect();
    slide.scrollLeft += after.left + fx * after.width - cx;
    slide.scrollTop += after.top + fy * after.height - cy;
  }

  // Pinch. Two fingers on a slide resize its image; the browser's own page
  // zoom is off for the viewer (touch-action in mobile.css), so these events
  // are ours alone.
  let pinch: { distance: number; scale: number } | null = null;
  const distance = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  track.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length === 2) pinch = { distance: distance(event.touches), scale };
    },
    { passive: true },
  );
  track.addEventListener(
    "touchmove",
    (event) => {
      if (!pinch || event.touches.length !== 2) return;
      event.preventDefault();
      const [a, b] = [event.touches[0], event.touches[1]];
      zoomTo(current, pinch.scale * (distance(event.touches) / pinch.distance), (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
    },
    { passive: false },
  );
  track.addEventListener("touchend", (event) => {
    if (event.touches.length < 2) pinch = null;
  });

  // One tap shows or hides the chrome; two zoom. The single tap has to wait out
  // the double-tap window, or every zoom would also flash the chrome.
  let lastTap = 0;
  let tapTimer: ReturnType<typeof setTimeout> | null = null;
  track.addEventListener("click", (event) => {
    const now = Date.now();
    if (now - lastTap < DOUBLE_TAP_MS) {
      if (tapTimer) clearTimeout(tapTimer);
      tapTimer = null;
      lastTap = 0;
      zoomTo(current, scale > 1 ? 1 : DOUBLE_TAP_SCALE, event.clientX, event.clientY);
      return;
    }
    lastTap = now;
    tapTimer = setTimeout(() => {
      tapTimer = null;
      root.classList.toggle("is-bare");
    }, DOUBLE_TAP_MS);
  });

  /* --- Which photo ---------------------------------------------------- */

  function describe(i: number): void {
    const photo = photos[i];
    count.textContent = photos.length > 1 ? ui.mobile.counter(i + 1, photos.length) : "";
    caption.textContent = context?.title ?? loc(photo.caption) ?? "";
    caption.parentElement!.hidden = !caption.textContent;
    hd.hidden = fullUrls.has(i);

    sheetBody.replaceChildren();
    if (context) {
      const card = el<HTMLElement>(`<section class="m-viewer-card"><h2></h2></section>`);
      card.querySelector("h2")!.textContent = context.title;
      if (context.description) card.appendChild(Object.assign(document.createElement("p"), { textContent: context.description }));
      if (context.placard) {
        const quote = document.createElement("blockquote");
        quote.textContent = context.placard;
        card.appendChild(quote);
      }
      if (context.originalText) {
        const details = el<HTMLDetailsElement>(`<details><summary></summary><pre></pre></details>`);
        details.querySelector("summary")!.textContent = ui.day.originalText;
        details.querySelector("pre")!.textContent = context.originalText;
        card.appendChild(details);
      }
      sheetBody.appendChild(card);
    }

    const own = el<HTMLElement>(`<section class="m-viewer-photo"><dl></dl></section>`);
    if (context) own.prepend(Object.assign(document.createElement("h3"), { textContent: ui.viewer.thisPhoto }));
    const text = loc(photo.caption);
    if (text) own.insertBefore(Object.assign(document.createElement("p"), { textContent: text }), own.querySelector("dl"));
    const dl = own.querySelector("dl")!;
    const row = (term: string, value: string | null) => {
      if (!value) return;
      dl.append(Object.assign(document.createElement("dt"), { textContent: term }), Object.assign(document.createElement("dd"), { textContent: value }));
    };
    row(
      ui.common.date,
      photo.takenAt
        ? fmtDateTime(new Date(photo.takenAt.slice(0, 19) + "Z"), {
            dateStyle: "medium",
            timeStyle: photo.timeSuspect ? undefined : "short",
            timeZone: "UTC",
          })
        : null,
    );
    row(ui.mobile.places, placeName(photo));
    if (photo.extractedText) {
      const details = el<HTMLDetailsElement>(`<details><summary></summary><pre></pre></details>`);
      details.querySelector("summary")!.textContent = ui.viewer.transcribed;
      details.querySelector("pre")!.textContent = photo.extractedText;
      own.appendChild(details);
    }
    sheetBody.appendChild(own);
  }

  function settle(): void {
    const width = track.clientWidth;
    if (!width) return; // not laid out — nothing can be said about position
    const i = Math.max(0, Math.min(photos.length - 1, Math.round(track.scrollLeft / width)));
    if (i === current) return;
    if (current >= 0 && scale > 1) zoomTo(current, 1, 0, 0);
    current = i;
    ensure(i);
    ensure(i + 1);
    ensure(i - 1);
    describe(i);
  }
  track.addEventListener("scroll", () => requestAnimationFrame(settle), { passive: true });

  hd.addEventListener("click", async () => {
    const i = current;
    hd.disabled = true;
    hd.textContent = ui.viewer.loadingFull;
    const url = await loadFullPhoto(photos[i].id);
    hd.disabled = false;
    hd.textContent = ui.mobile.fullResolution;
    if (!url) return;
    fullUrls.set(i, url);
    const img = slides[i].querySelector("img")!;
    img.dataset.state = "full";
    img.src = url;
    if (i === current) hd.hidden = true;
  });

  root.querySelector(".m-viewer-info-btn")!.addEventListener("click", () => {
    sheet.hidden = !sheet.hidden;
  });
  sheet.querySelector(".m-sheet-handle")!.addEventListener("click", () => (sheet.hidden = true));
  root.querySelector(".m-viewer-close")!.addEventListener("click", () => void dismiss());

  function close(): void {
    root.remove();
    document.body.classList.remove("m-locked");
    for (const url of fullUrls.values()) releaseFullPhoto(url);
  }

  document.body.appendChild(root);
  document.body.classList.add("m-locked");
  openLayer(close);

  // The start photo is chosen outright, then the track is moved to it — not
  // the other way round. Deriving it from the scroll position loaded photo 1
  // and 2 as well whenever the track had not been laid out yet (width 0 puts
  // every photo at scrollLeft 0), which is 120KB of the wrong pictures.
  current = start;
  ensure(start);
  ensure(start + 1);
  ensure(start - 1);
  describe(start);
  track.scrollLeft = start * track.clientWidth;
}
