/**
 * The shareable card: a photograph with its caption underneath, as a JPEG.
 *
 * What a phone can usefully send someone is not always the original file — the
 * archive holds 7,249 HEIC photographs, which most chat apps will not render,
 * and "here is a picture, and what I wrote about it" is the thing worth
 * sending. The layout is deliberately plain: full-bleed photo, the caption in
 * the reader's language, one muted line of date and place. Every one of those
 * three pieces is a switch the reader owns (`CardOptions`), because a caption
 * someone wrote for themselves is not always for the person they are sending
 * the picture to.
 *
 * 2048 on the long edge at quality 0.9 is a deliberate ceiling: about 300-600KB
 * for a normal photograph, which WhatsApp and WeChat pass through without
 * recompressing, and which reads sharply on a phone at any zoom the card is
 * likely to be opened at.
 */

/** Which parts of the text block the card carries. */
export interface CardOptions {
  caption: boolean;
  date: boolean;
  place: boolean;
}

/** The three pieces, already localized by the caller. */
export interface CardText {
  caption: string | null;
  date: string | null;
  place: string | null;
}

export const CARD_WIDTH = 2048;
const CARD_QUALITY = 0.9;
/** A photograph taller than this is cropped around the middle rather than
 *  producing a card two screens tall for a panorama held sideways. */
const MAX_IMAGE_HEIGHT = Math.round(CARD_WIDTH * 1.3);

/**
 * Type sized for the phone the card is read on, not for the card's own pixels.
 *
 * The first pass set the caption at 54px on a 2048px card, which is a sane
 * ratio on paper and wrong on a phone: a chat app shows the card about 1080
 * physical pixels wide, so 54px lands at roughly 10px of text — legible in the
 * editor and unreadable in the message. Everything here is therefore measured
 * against that 1080 target: the caption is ~18px and the date line ~12px once
 * the card is on screen, which is body text and a footnote.
 */
const PAD = 120;
const CAPTION_SIZE = 96;
const CAPTION_LINE = 128;
const CAPTION_LINES = 5;
const FOOTER_SIZE = 62;
const FOOTER_LINE = 82;

const PAPER = "#fbfaf8";
const INK = "#141414";
const MUTED = "#6f6b66";
/** Android has no Noto Sans SC; the platform's own sans-serif falls back to it. */
const FONT = `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

const OPTIONS_KEY = "share-card-options";

/** The reader's last choice. Not a secret, so localStorage is the right place. */
export function loadCardOptions(): CardOptions {
  const fallback: CardOptions = { caption: true, date: true, place: true };
  try {
    const raw = localStorage.getItem(OPTIONS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<CardOptions>;
    return {
      caption: parsed.caption !== false,
      date: parsed.date !== false,
      place: parsed.place !== false,
    };
  } catch {
    return fallback;
  }
}

export function saveCardOptions(options: CardOptions): void {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
  } catch {
    // A full or refused store forgets the switches; the card still renders.
  }
}

/** Break text to lines at spaces, or anywhere for CJK, and ellipsize past `maxLines`. */
function wrap(context: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  let truncated = false;
  for (const character of Array.from(text)) {
    const candidate = line + character;
    if (line && context.measureText(candidate).width > maxWidth) {
      if (lines.length + 1 === maxLines) {
        truncated = true;
        break;
      }
      const space = line.lastIndexOf(" ");
      if (space > 0 && character !== " ") {
        // Break at the word boundary, carrying the partial word down.
        lines.push(line.slice(0, space));
        line = line.slice(space + 1) + character;
      } else {
        lines.push(line);
        line = character === " " ? "" : character;
      }
    } else {
      line = candidate;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (truncated) {
    let last = lines[lines.length - 1] ?? "";
    while (last && context.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
    lines[lines.length - 1] = `${last.trimEnd()}…`;
  }
  return lines;
}

/**
 * Draw the card and hand back its bytes.
 *
 * The photograph arrives as a decoded bitmap rather than an `<img>` because a
 * canvas drawn from an image the server sent without CORS headers is tainted,
 * and a tainted canvas cannot be exported at all — the failure would land on
 * the reader as "share failed" with no explanation. The caller fetches the
 * bytes and decodes them locally.
 */
export async function renderCard(bitmap: ImageBitmap, text: CardText, options: CardOptions): Promise<Blob> {
  const scale = CARD_WIDTH / bitmap.width;
  const drawnHeight = Math.min(Math.round(bitmap.height * scale), MAX_IMAGE_HEIGHT);
  const crop = drawnHeight < Math.round(bitmap.height * scale);

  const caption = options.caption ? text.caption?.trim() || null : null;
  const footer = [options.date ? text.date : null, options.place ? text.place : null].filter(Boolean).join(" · ") || null;

  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = `500 ${CAPTION_SIZE}px ${FONT}`;
  const captionLines = caption ? wrap(measure, caption, CARD_WIDTH - PAD * 2, CAPTION_LINES) : [];
  const footerLines = footer ? wrap(measure, footer, CARD_WIDTH - PAD * 2, 2) : [];

  const textHeight =
    (captionLines.length ? CAPTION_LINE * captionLines.length + PAD * 0.9 : 0) +
    (footerLines.length ? FOOTER_LINE * footerLines.length + (captionLines.length ? 30 : PAD * 0.9) : 0) +
    (captionLines.length || footerLines.length ? PAD : 0);

  const canvas = document.createElement("canvas");
  canvas.width = CARD_WIDTH;
  canvas.height = drawnHeight + textHeight;
  const context = canvas.getContext("2d")!;
  context.fillStyle = PAPER;
  context.fillRect(0, 0, canvas.width, canvas.height);

  // The source rectangle is the middle of the photograph when it is too tall
  // to fit the card's shape, so a portrait held sideways keeps its subject.
  const sourceHeight = crop ? Math.round(MAX_IMAGE_HEIGHT / scale) : bitmap.height;
  const sourceY = crop ? Math.round((bitmap.height - sourceHeight) / 2) : 0;
  context.drawImage(bitmap, 0, sourceY, bitmap.width, sourceHeight, 0, 0, CARD_WIDTH, drawnHeight);

  context.textBaseline = "alphabetic";
  let y = drawnHeight + PAD * 0.9;
  if (captionLines.length) {
    context.fillStyle = INK;
    context.font = `500 ${CAPTION_SIZE}px ${FONT}`;
    for (const line of captionLines) {
      y += CAPTION_LINE - 12;
      context.fillText(line, PAD, y);
    }
  }
  if (footerLines.length) {
    context.fillStyle = MUTED;
    context.font = `400 ${FOOTER_SIZE}px ${FONT}`;
    y += captionLines.length ? 30 : 0;
    for (const line of footerLines) {
      y += FOOTER_LINE - 12;
      context.fillText(line, PAD, y);
    }
  }

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("the card could not be encoded"))),
      "image/jpeg",
      CARD_QUALITY,
    );
  });
}

/** `IMG_20261030_092804.jpg` → `IMG_20261030_092804.card.jpg`. */
export function cardFileName(name: string): string {
  const base = name.replace(/\.[^.]+$/, "");
  return `${base || "photo"}.card.jpg`;
}
