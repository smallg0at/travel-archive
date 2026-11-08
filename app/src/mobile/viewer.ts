import type { Highlight, PhotoRecord } from "@travel-archive/shared";
import { loadFullPhoto, loadLarge, releaseFullPhoto } from "../graphPhoto";
import { thumbnailSource } from "../photoSource";
import { el, transcript, transcriptOriginal } from "../photoUi";
import { onScreenCaptions, screenCaptionFor, screenCaptionSlot } from "../screenCaptions";
import { contentLanguage, loc } from "../contentLang";
import { fmtDateTime, ui } from "../i18n";
import { dismiss, isTopLayer, openLayer } from "./overlay";
import { ICONS, leave, showToast } from "./ui";
import { overrideSystemBars } from "./native";
import { deviceFullUrl } from "./devicePhotos";
import { cardFileName, encodeCard, loadCardOptions, paintCard, saveCardOptions, type CardStyle, type CardText } from "./shareCard";
import { ensureCardFont } from "./shareCardFont";
import { cardBitmap, shareCardBlob, shareOriginal } from "./share";

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

/**
 * Point a slide's image at a job-server URL with the session attached.
 *
 * The mobile app is served by the same shell that serves the desktop page, so
 * its viewer talks to the job server on a second port — a different origin, and
 * a plain `<img src>` sends no cookie across origins. On the owner's machine
 * loopback is admitted without one; a family member over the network would see
 * broken images. See the desktop viewer's `setSource`, which is the same fix.
 */
function setSource(img: HTMLImageElement, url: string): void {
  const crossOrigin = thumbnailSource()?.crossOrigin;
  if (crossOrigin) img.crossOrigin = crossOrigin;
  img.src = url;
}

/** What the photos are pictures *of*, when they came from a card. */
export interface CardContext {
  title: string;
  description: string | null;
  placard: string | null;
  /** The placard photos' text: in the reader's language, with the verbatim behind it. */
  transcript: { shown: string; original: string | null } | null;
}

export function cardContext(highlight: Highlight, byId: Record<string, PhotoRecord>): CardContext {
  const docs = highlight.documentPhotoIds.map((id) => byId[id]).filter((d) => d?.extractedText);
  return {
    title: loc(highlight.title),
    description: loc(highlight.description),
    placard: loc(highlight.documentTranslation),
    transcript: docs.length ? transcript(docs.map((d) => d.extractedText as string)) : null,
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
        <button type="button" class="m-icon-btn m-viewer-hd" hidden>${ICONS.download}</button>
        <button type="button" class="m-icon-btn m-viewer-share-btn">${ICONS.share}</button>
        <button type="button" class="m-icon-btn m-viewer-info-btn">${ICONS.info}</button>
      </header>
      <footer class="m-viewer-caption"><p></p></footer>
      <section class="m-viewer-sheet" hidden><div class="m-sheet-handle"></div><div class="m-viewer-sheet-body"></div></section>
      <section class="m-viewer-sheet m-share-sheet" hidden>
        <div class="m-sheet-handle"></div>
        <h2 class="m-share-title"></h2>
        <div class="m-share-segment m-share-styles" role="radiogroup"></div>
        <div class="m-share-preview"><canvas class="m-share-canvas"></canvas></div>
        <p class="m-share-state"></p>
        <div class="m-share-segment m-share-sources" role="radiogroup"></div>
        <textarea class="m-share-custom" rows="2" hidden></textarea>
        <div class="m-share-switches"></div>
        <div class="m-share-actions"></div>
        <p class="m-share-progress" hidden><span class="m-share-progress-text"></span><button type="button" class="m-share-cancel"></button></p>
      </section>
    </div>
  `);
  const track = root.querySelector<HTMLElement>(".m-viewer-track")!;
  const count = root.querySelector<HTMLElement>(".m-viewer-count")!;
  const caption = root.querySelector<HTMLElement>(".m-viewer-caption p")!;
  const sheet = root.querySelector<HTMLElement>(".m-viewer-sheet")!;
  const sheetBody = root.querySelector<HTMLElement>(".m-viewer-sheet-body")!;
  const hd = root.querySelector<HTMLButtonElement>(".m-viewer-hd")!;
  const shareSheet = root.querySelector<HTMLElement>(".m-share-sheet")!;
  const shareCanvas = root.querySelector<HTMLCanvasElement>(".m-share-canvas")!;
  const shareState = root.querySelector<HTMLElement>(".m-share-state")!;
  const shareSwitches = root.querySelector<HTMLElement>(".m-share-switches")!;
  const shareActions = root.querySelector<HTMLElement>(".m-share-actions")!;
  const shareProgress = root.querySelector<HTMLElement>(".m-share-progress")!;
  const shareCancel = root.querySelector<HTMLButtonElement>(".m-share-cancel")!;
  root.querySelector(".m-viewer-close")!.setAttribute("aria-label", ui.common.close);
  root.querySelector(".m-viewer-info-btn")!.setAttribute("aria-label", ui.mobile.info);
  root.querySelector(".m-viewer-share-btn")!.setAttribute("aria-label", ui.mobile.share);
  hd.setAttribute("aria-label", ui.mobile.fullResolution);
  shareSheet.querySelector(".m-share-title")!.textContent = ui.mobile.shareTitle;
  shareCancel.textContent = ui.common.cancel;
  shareProgress.querySelector(".m-share-progress-text")!.textContent = ui.mobile.shareWorking;

  const slides = photos.map(() => {
    const slide = el<HTMLDivElement>(`<div class="m-slide"><img alt="" draggable="false" /></div>`);
    track.appendChild(slide);
    return slide;
  });
  const fullUrls = new Map<number, string>();
  let current = -1;

  /**
   * The phone's own copy of the photo being looked at, at its real size.
   *
   * Only the current slide: a 12MP JPEG decodes to about 48MB as a bitmap, and
   * doing that for both neighbours as well is how a WebView gets killed. They
   * keep the `large` copy, which is what a swipe shows for its first moment
   * anyway — and since the bytes are on disk, this upgrade costs no data and
   * no wait worth showing a spinner for.
   */
  function showDeviceOriginal(i: number): void {
    const img = slides[i]?.querySelector("img");
    if (!img || img.dataset.state === "full") return;
    const url = deviceFullUrl(photos[i].id);
    if (!url) return;
    setSource(img, url);
    img.dataset.state = "full";
    if (i === current) hd.hidden = true;
  }

  function ensure(i: number): void {
    const img = slides[i]?.querySelector("img");
    if (!img || img.dataset.state) return;
    img.dataset.state = "loading";
    void loadLarge(photos[i].id).then((url) => {
      // Full resolution may have landed first on a fast connection; do not
      // replace it with the smaller copy.
      if (url && img.dataset.state === "loading") {
        setSource(img, url);
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
    // With the info sheet up, the photo above it is the way out of it — the
    // tap closes the sheet and does nothing else.
    if (!sheet.hidden) {
      void closeSheet();
      return;
    }
    if (!shareSheet.hidden) {
      void closeShare();
      return;
    }
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
    // The caption's place, and the description is a caption: a photograph the
    // cloud model was never allowed to see has no caption of its own, so the
    // line under the picture says what kind of screen it is instead — and
    // nothing on it.
    caption.textContent = context?.title ?? loc(photo.caption) ?? screenCaptionFor(photo.id)?.caption ?? "";
    caption.parentElement!.hidden = !caption.textContent;
    // Nothing to offer when the original is already on screen from this phone.
    hd.hidden = fullUrls.has(i) || deviceFullUrl(photos[i].id) !== null;

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
      if (context.transcript) {
        const details = el<HTMLDetailsElement>(`<details><summary></summary><pre></pre></details>`);
        details.querySelector("summary")!.textContent = ui.viewer.transcribed;
        details.querySelector("pre")!.textContent = context.transcript.shown;
        if (context.transcript.original) {
          details.appendChild(transcriptOriginal(context.transcript.original, ui.day.originalText));
        }
        card.appendChild(details);
      }
      sheetBody.appendChild(card);
    }

    const own = el<HTMLElement>(`<section class="m-viewer-photo"><dl></dl></section>`);
    if (context) own.prepend(Object.assign(document.createElement("h3"), { textContent: ui.viewer.thisPhoto }));
    const text = loc(photo.caption);
    if (text) own.insertBefore(Object.assign(document.createElement("p"), { textContent: text }), own.querySelector("dl"));
    // The description of a withheld screenshot, in the place the caption would
    // be. It says only what kind of screen the photograph is — nothing on it —
    // and only this reader's passphrase opens it. The line fills itself in if
    // the descriptions open after this photo was opened.
    own.insertBefore(screenCaptionSlot(photo.id), own.querySelector("dl"));
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
      const shown = transcript([photo.extractedText]);
      const details = el<HTMLDetailsElement>(`<details><summary></summary><pre></pre></details>`);
      details.querySelector("summary")!.textContent = ui.viewer.transcribed;
      details.querySelector("pre")!.textContent = shown.shown;
      if (shown.original) details.appendChild(transcriptOriginal(shown.original, ui.day.originalText));
      own.appendChild(details);
    }
    sheetBody.appendChild(own);
    // The share sheet belongs to one photograph: swiping to the next one puts
    // it away rather than leaving it showing the previous picture's card.
    if (!shareSheet.hidden) void closeShare();
  }

  /* --- Share sheet ------------------------------------------------------ */

  // Its own screen, opened from the toolbar, because sending a photograph out
  // is an action rather than a fact about it — and because the card has to be
  // looked at before it goes. The canvas above the switches *is* the card: the
  // same drawing code fills it for the preview and is encoded once when the
  // reader presses Share. Encoding takes seconds on a phone (4.2s measured on
  // its own, 13.2s with the viewer holding its bitmaps), so a switch must only
  // repaint — about a tenth of a second — and never re-encode.

  const cardOptions = loadCardOptions();
  const shareStyles = root.querySelector<HTMLElement>(".m-share-styles")!;
  const shareSources = root.querySelector<HTMLElement>(".m-share-sources")!;
  const customCaptionBox = root.querySelector<HTMLTextAreaElement>(".m-share-custom")!;
  const styleChoices: Array<[CardStyle, string]> = [
    ["gallery", ui.mobile.cardGallery],
    ["editorial", ui.mobile.cardEditorial],
  ];
  shareStyles.setAttribute("aria-label", ui.mobile.cardStyle);
  for (const [value, label] of styleChoices) {
    const row = el<HTMLLabelElement>(`<label><input type="radio" name="card-style" /><span></span></label>`);
    const input = row.querySelector("input")!;
    input.value = value;
    input.checked = cardOptions.style === value;
    row.querySelector("span")!.textContent = label;
    input.addEventListener("change", () => {
      if (!input.checked) return;
      cardOptions.style = value;
      saveCardOptions(cardOptions);
      repaintCard();
    });
    shareStyles.appendChild(row);
  }

  type CaptionSource = "title" | "description" | "custom";
  let captionSource: CaptionSource = "description";
  let customCaption = "";

  const sourceChoices: Array<[CaptionSource, string]> = [
    ["title", ui.mobile.cardSourceTitle],
    ["description", ui.mobile.cardSourceCaption],
    ["custom", ui.mobile.cardSourceCustom],
  ];
  shareSources.setAttribute("aria-label", ui.mobile.cardTextSource);
  for (const [value, label] of sourceChoices) {
    const row = el<HTMLLabelElement>(`<label><input type="radio" name="card-source" /><span></span></label>`);
    const input = row.querySelector("input")!;
    input.value = value;
    input.checked = captionSource === value;
    // The title only exists when the viewer was opened from a day or trip.
    if (value === "title" && !context?.title) {
      row.hidden = true;
      input.disabled = true;
    }
    row.querySelector("span")!.textContent = label;
    input.addEventListener("change", () => {
      if (!input.checked) return;
      captionSource = value;
      customCaptionBox.hidden = value !== "custom";
      if (value === "custom" && !customCaption.trim()) {
        customCaption = descriptionCaption(photos[current]) ?? "";
        customCaptionBox.value = customCaption;
      }
      repaintCard();
    });
    shareSources.appendChild(row);
  }
  customCaptionBox.hidden = true;
  customCaptionBox.setAttribute("aria-label", ui.mobile.cardSourceCustom);
  customCaptionBox.addEventListener("input", () => {
    customCaption = customCaptionBox.value;
    repaintCard();
  });

  function descriptionCaption(photo: PhotoRecord | undefined): string | null {
    if (!photo) return null;
    return loc(photo.caption) ?? screenCaptionFor(photo.id)?.caption ?? null;
  }

  function captionFor(photo: PhotoRecord): string | null {
    if (captionSource === "title") return context?.title ?? null;
    if (captionSource === "custom") return customCaption.trim() || null;
    return descriptionCaption(photo);
  }

  const switchRows: Array<["caption" | "date" | "place", string]> = [
    ["caption", ui.mobile.cardCaption],
    ["date", ui.mobile.cardDate],
    ["place", ui.mobile.cardPlace],
  ];
  for (const [key, label] of switchRows) {
    const row = el<HTMLLabelElement>(`<label class="m-share-switch"><input type="checkbox" /><span></span></label>`);
    const input = row.querySelector("input")!;
    input.checked = cardOptions[key];
    row.querySelector("span")!.textContent = label;
    input.addEventListener("change", () => {
      cardOptions[key] = input.checked;
      saveCardOptions(cardOptions);
      repaintCard();
    });
    shareSwitches.appendChild(row);
  }

  function cardText(photo: PhotoRecord): CardText {
    return {
      caption: captionFor(photo),
      date: photo.takenAt
        ? fmtDateTime(new Date(photo.takenAt.slice(0, 19) + "Z"), {
            dateStyle: "medium",
            timeStyle: photo.timeSuspect ? undefined : "short",
            timeZone: "UTC",
          })
        : null,
      place: placeName(photo),
    };
  }

  let cardSource: { bitmap: ImageBitmap; index: number } | null = null;
  let previewToken = 0;
  let shareToken = 0;

  /** Redraw the preview from the bitmap already in hand: switches, not renders. */
  function repaintCard(): void {
    if (!cardSource || cardSource.index !== current) return;
    const source = cardSource;
    void ensureCardFont().then(() => {
      if (cardSource?.bitmap !== source.bitmap) return;
      paintCard(shareCanvas, source.bitmap, cardText(photos[source.index]), cardOptions);
    });
  }

  async function refreshCard(): Promise<void> {
    const index = current;
    if (index < 0) return;
    const token = ++previewToken;
    const photo = photos[index];
    if (cardSource?.index !== index) {
      cardSource?.bitmap.close();
      cardSource = null;
      shareState.textContent = ui.mobile.shareLoading;
      shareState.hidden = false;
      try {
        const bitmap = await cardBitmap(photo);
        if (token !== previewToken) {
          bitmap.close();
          return;
        }
        cardSource = { bitmap, index };
      } catch (error) {
        console.error("Card preview failed:", error);
        if (token === previewToken) shareState.textContent = ui.mobile.shareFailed;
        return;
      }
      if (token !== previewToken) return;
      shareState.textContent = "";
      shareState.hidden = true;
    }
    await ensureCardFont();
    if (token !== previewToken) return;
    paintCard(shareCanvas, cardSource!.bitmap, cardText(photo), cardOptions);
  }

  let progressTimer = 0;

  /**
   * Buttons go dead at once, the progress row only after a third of a second.
   *
   * Encoding a card usually takes seconds, but not always: a small photo
   * finishes before a painted line could be read, and the row appearing and
   * vanishing in one frame looks like a glitch rather than progress. So it is
   * deferred, and once shown it stays until the share sheet takes over.
   */
  function setSharing(busy: boolean): void {
    for (const button of shareActions.querySelectorAll("button")) button.disabled = busy;
    window.clearTimeout(progressTimer);
    if (!busy) {
      shareProgress.hidden = true;
      return;
    }
    progressTimer = window.setTimeout(() => {
      shareProgress.hidden = false;
    }, 300);
  }

  function failOver(error: unknown): void {
    console.error("Share failed:", error);
    const toast = showToast(ui.mobile.shareFailed);
    setTimeout(() => toast.close(), 3000);
  }

  async function shareCardNow(): Promise<void> {
    const index = current;
    if (index < 0 || cardSource?.index !== index) return;
    const token = ++shareToken;
    setSharing(true);
    try {
      // A card whose face arrived late would encode in the fallback: the preview
      // looks right and the sent file does not.
      await ensureCardFont();
      const blob = await encodeCard(shareCanvas);
      // Cancelled while the encoder was running: the work is finished, the
      // send is not.
      if (token !== shareToken) return;
      await shareCardBlob(blob, photos[index]);
    } catch (error) {
      if (token === shareToken) failOver(error);
    } finally {
      if (token === shareToken) setSharing(false);
    }
  }

  async function shareOriginalNow(): Promise<void> {
    const index = current;
    if (index < 0) return;
    try {
      await shareOriginal(photos[index]);
    } catch (error) {
      failOver(error);
    }
  }

  const cardButton = el<HTMLButtonElement>(`<button type="button" class="is-primary"></button>`);
  cardButton.textContent = ui.mobile.shareCard;
  cardButton.addEventListener("click", () => void shareCardNow());
  const originalButton = el<HTMLButtonElement>(`<button type="button"></button>`);
  originalButton.textContent = ui.mobile.shareOriginal;
  originalButton.addEventListener("click", () => void shareOriginalNow());
  shareActions.append(cardButton, originalButton);

  const hideShare = () => {
    previewToken++;
    shareToken++;
    shareSheet.hidden = true;
    shareSheet.style.transform = "";
  };
  const openShare = () => {
    if (!sheet.hidden) void closeSheet();
    setSharing(false);
    shareSheet.hidden = false;
    shareSheet.scrollTop = 0;
    void refreshCard();
    openLayer(hideShare, { nested: true });
  };
  const closeShare = () => (isTopLayer(hideShare) ? dismiss() : Promise.resolve(hideShare()));

  shareCancel.addEventListener("click", () => {
    shareToken++;
    setSharing(false);
  });
  root.querySelector(".m-viewer-share-btn")!.addEventListener("click", () => (shareSheet.hidden ? openShare() : void closeShare()));
  shareSheet.querySelector(".m-sheet-handle")!.addEventListener("click", () => void closeShare());

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
    showDeviceOriginal(i);
  }
  track.addEventListener("scroll", () => requestAnimationFrame(settle), { passive: true });

  hd.addEventListener("click", async () => {
    const i = current;
    hd.disabled = true;
    // The phone's own copy when it has one — the original bytes, with no
    // download. loadFullPhoto trusts a source's fullUrl without a fallback,
    // so the choice is made here rather than in photoSource.
    const url = deviceFullUrl(photos[i].id) ?? (await loadFullPhoto(photos[i].id));
    hd.disabled = false;
    if (!url) return;
    fullUrls.set(i, url);
    const img = slides[i].querySelector("img")!;
    img.dataset.state = "full";
    setSource(img, url);
    if (i === current) hd.hidden = true;
  });

  /* --- Info sheet ------------------------------------------------------ */

  // A layer of its own over the viewer's, so Back takes the sheet off and
  // leaves the photo. Four ways out: Back, a tap on the photo, a tap on the
  // handle, or dragging it down.
  const hideSheet = () => {
    sheet.hidden = true;
    sheet.style.transform = "";
  };
  const openSheet = () => {
    sheet.hidden = false;
    sheet.scrollTop = 0;
    openLayer(hideSheet, { nested: true });
  };
  const closeSheet = () => (isTopLayer(hideSheet) ? dismiss() : Promise.resolve(hideSheet()));

  root.querySelector(".m-viewer-info-btn")!.addEventListener("click", () => (sheet.hidden ? openSheet() : void closeSheet()));
  sheet.querySelector(".m-sheet-handle")!.addEventListener("click", () => void closeSheet());

  // Drag down to close — only from the top of the sheet's own scroll, so a
  // long transcription still scrolls back up rather than closing. Both sheets,
  // the same gesture.
  const draggable = (node: HTMLElement, close: () => Promise<void>) => {
    let drag: { y: number; dy: number } | null = null;
    node.addEventListener(
      "touchstart",
      (event) => {
        drag = node.scrollTop <= 0 && event.touches.length === 1 ? { y: event.touches[0].clientY, dy: 0 } : null;
      },
      { passive: true },
    );
    node.addEventListener(
      "touchmove",
      (event) => {
        if (!drag) return;
        drag.dy = event.touches[0].clientY - drag.y;
        if (drag.dy <= 0) {
          // Upward: the sheet's own scroll, not a drag.
          node.style.transform = "";
          drag = null;
          return;
        }
        event.preventDefault();
        node.style.transition = "none";
        node.style.transform = `translateY(${drag.dy}px)`;
      },
      { passive: false },
    );
    node.addEventListener("touchend", () => {
      if (!drag) return;
      const far = drag.dy > Math.min(120, node.offsetHeight / 4);
      drag = null;
      node.style.transition = "";
      if (far) void close();
      else node.style.transform = "";
    });
  };
  draggable(sheet, closeSheet);
  draggable(shareSheet, closeShare);

  root.querySelector(".m-viewer-close")!.addEventListener("click", async () => {
    if (!shareSheet.hidden) await closeShare();
    await closeSheet();
    await dismiss();
  });

  function close(): void {
    leave(root);
    overrideSystemBars(null);
    document.body.classList.remove("m-locked");
    for (const url of fullUrls.values()) releaseFullPhoto(url);
    cardSource?.bitmap.close();
    cardSource = null;
    stopWatching();
  }

  // The descriptions need a passphrase and a fetch, so they arrive after the
  // picture does. The line under it is drawn again when they land — otherwise
  // a photograph opened first would keep an empty line for the whole session.
  const stopWatching = onScreenCaptions((state) => {
    if (state.status !== "ready" || current < 0) return;
    describe(current);
  });

  document.body.appendChild(root);
  overrideSystemBars("#000000");
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
  showDeviceOriginal(start);
  track.scrollLeft = start * track.clientWidth;
}
