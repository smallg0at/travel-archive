/**
 * The shareable card: a photograph with its caption underneath, as a JPEG.
 *
 * What a phone can usefully send someone is not always the original file — the
 * archive holds 7,249 HEIC photographs, which most chat apps will not render,
 * and "here is a picture, and what I wrote about it" is the thing worth
 * sending. The layout is a switch the reader owns (`CardOptions.style`):
 *
 *   gallery    dark, left aligned, one sans-serif voice and one muted line.
 *   editorial  paper-coloured, centred, a serif caption over a short rule.
 *
 * Every piece of text is separately switchable too, because a caption someone
 * wrote for themselves is not always for the person they are sending the
 * picture to.
 *
 * 2048 on the long edge at quality 0.9 is a deliberate ceiling: about 300-600KB
 * for a normal photograph, which WhatsApp and WeChat pass through without
 * recompressing, and which reads sharply on a phone at any zoom the card is
 * likely to be opened at.
 */

export type CardStyle = "gallery" | "editorial";

/** Which parts of the text block the card carries. */
export interface CardOptions {
  caption: boolean;
  date: boolean;
  place: boolean;
  style: CardStyle;
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
interface Theme {
  paper: string;
  ink: string;
  muted: string;
  rule: string;
  font: string;
  captionWeight: number;
  captionSize: number;
  captionLine: number;
  captionLines: number;
  pad: number;
  /** Vertical space between the caption block and the footer block. */
  gap: number;
  footerWeight: number;
  footerSize: number;
  footerLine: number;
  bottom: number;
  center: boolean;
  /** A short rule between caption and footer; the editorial card's only line. */
  ruleGap: number;
}

/**
 * The editorial card wants a real serif, and Android ships no Chinese one that
 * the WebView will pick for `serif`. `Noto Serif SC` is therefore shipped with
 * the app (see `shareCardFont.ts`) and named first; the rest are the desktop
 * fallbacks, and `SimSun` last is still better than a sans-serif.
 */
const SERIF = `"Noto Serif SC Archive", "Noto Serif SC", "Source Han Serif SC", "Songti SC", SimSun, serif`;
/** Android has no Noto Sans SC; the platform's own sans-serif falls back to it. */
const SANS = `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

const THEMES: Record<CardStyle, Theme> = {
  gallery: {
    paper: "#131313",
    ink: "#ededed",
    muted: "#8f8f8f",
    rule: "#333333",
    font: SANS,
    captionWeight: 400,
    captionSize: 96,
    captionLine: 154,
    captionLines: 5,
    pad: 120,
    gap: 56,
    footerWeight: 400,
    footerSize: 58,
    footerLine: 94,
    bottom: 128,
    center: false,
    ruleGap: 0,
  },
  editorial: {
    paper: "#f8f8f7",
    ink: "#2a2a2a",
    muted: "#9a9a96",
    rule: "#d9d7d2",
    font: SERIF,
    captionWeight: 600,
    captionSize: 92,
    captionLine: 152,
    captionLines: 6,
    pad: 150,
    gap: 72,
    footerWeight: 400,
    footerSize: 54,
    footerLine: 88,
    bottom: 140,
    center: true,
    ruleGap: 64,
  },
};

const OPTIONS_KEY = "share-card-options";

/** The reader's last choice. Not a secret, so localStorage is the right place. */
export function loadCardOptions(): CardOptions {
  const fallback: CardOptions = { caption: true, date: true, place: true, style: "gallery" };
  try {
    const raw = localStorage.getItem(OPTIONS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<CardOptions>;
    return {
      caption: parsed.caption !== false,
      date: parsed.date !== false,
      place: parsed.place !== false,
      style: parsed.style === "editorial" ? "editorial" : "gallery",
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

/** Han characters, the ones a synthetic italic genuinely ruins. */
const HAN = /\p{Script=Han}/u;

/**
 * Break text to lines at spaces, or anywhere for CJK, and ellipsize past `maxLines`.
 */
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
 * The same wrap, at a slightly narrower measure, when it evens the lines out.
 *
 * Centred text makes a short last line conspicuous — a lone 「下。」 floating in
 * the middle of the page is the classic consequence. Rewrapping a few percent
 * narrower costs nothing and usually moves one character up, so the block reads
 * as a rectangle rather than a paragraph that ran out.
 */
function balancedWrap(context: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const plain = wrap(context, text, maxWidth, maxLines);
  if (plain.length < 2 || plain.some((line) => line.endsWith("…"))) return plain;

  const widest = Math.max(...plain.map((line) => context.measureText(line).width));
  const narrowest = Math.min(...plain.map((line) => context.measureText(line).width));
  if (narrowest / widest > 0.6) return plain; // already even enough

  let best = plain;
  let bestScore = narrowest / widest;
  for (let factor = 0.98; factor >= 0.8; factor -= 0.02) {
    const candidate = wrap(context, text, Math.round(maxWidth * factor), maxLines);
    if (candidate.length !== plain.length) continue;
    const low = Math.min(...candidate.map((line) => context.measureText(line).width));
    const high = Math.max(...candidate.map((line) => context.measureText(line).width));
    const score = low / high;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Draw a line of mixed text with italic applied only where italic exists.
 *
 * Chinese has no italic face: asking for one makes the platform shear the
 * upright glyphs, which thickens the horizontals and leaves jagged diagonals.
 * So the date's digits may lean while the place name beside them stays upright.
 */
function fillMixed(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  uprightFont: string,
  italicFont: string,
  center: boolean,
): void {
  const runs: { text: string; italic: boolean }[] = [];
  for (const character of Array.from(text)) {
    const italic = !HAN.test(character) && character.trim() !== "";
    const last = runs[runs.length - 1];
    if (last && last.italic === italic) last.text += character;
    else runs.push({ text: character, italic });
  }
  let left = x;
  if (center) {
    let total = 0;
    for (const run of runs) {
      context.font = run.italic ? italicFont : uprightFont;
      total += context.measureText(run.text).width;
    }
    left = x - total / 2;
  }
  for (const run of runs) {
    context.font = run.italic ? italicFont : uprightFont;
    context.fillText(run.text, left, y);
    left += context.measureText(run.text).width;
  }
}

/**
 * Draw the card into a canvas the caller owns.
 *
 * The photograph arrives as a decoded bitmap rather than an `<img>` because a
 * canvas drawn from an image the server sent without CORS headers is tainted,
 * and a tainted canvas cannot be exported at all — the failure would land on
 * the reader as "share failed" with no explanation. The caller fetches the
 * bytes and decodes them locally.
 *
 * Drawing is kept separate from encoding because the same canvas is both the
 * preview and the thing that gets shared: a switch can repaint it in about a
 * tenth of a second, while encoding it to JPEG takes seconds on a phone.
 */
export function paintCard(canvas: HTMLCanvasElement, bitmap: ImageBitmap, text: CardText, options: CardOptions): void {
  const theme = THEMES[options.style] ?? THEMES.gallery;

  const scale = CARD_WIDTH / bitmap.width;
  const drawnHeight = Math.min(Math.round(bitmap.height * scale), MAX_IMAGE_HEIGHT);
  const crop = drawnHeight < Math.round(bitmap.height * scale);

  const caption = options.caption ? text.caption?.trim() || null : null;
  const footer = [options.date ? text.date : null, options.place ? text.place : null].filter(Boolean).join(" · ") || null;

  const block = CARD_WIDTH - theme.pad * 2;
  const measure = document.createElement("canvas").getContext("2d")!;
  const captionFont = `${theme.captionWeight} ${theme.captionSize}px ${theme.font}`;
  measure.font = captionFont;
  const captionLines = caption
    ? balancedWrap(measure, caption, block, theme.captionLines)
    : [];
  measure.font = `${theme.footerWeight} ${theme.footerSize}px ${theme.font}`;
  const footerLines = footer ? wrap(measure, footer, block, 2) : [];

  const captionBlock = captionLines.length ? captionLines.length * theme.captionLine : 0;
  const footerBlock = footerLines.length ? footerLines.length * theme.footerLine : 0;
  const ruleBlock = theme.ruleGap > 0 && captionBlock && footerBlock ? theme.ruleGap + 2 : 0;
  const textHeight =
    captionBlock +
    (captionBlock ? theme.gap : theme.pad) +
    ruleBlock +
    footerBlock +
    (captionBlock || footerBlock ? theme.bottom : 0);

  canvas.width = CARD_WIDTH;
  canvas.height = drawnHeight + textHeight;
  const context = canvas.getContext("2d")!;
  context.fillStyle = theme.paper;
  context.fillRect(0, 0, canvas.width, canvas.height);

  // The source rectangle is the middle of the photograph when it is too tall
  // to fit the card's shape, so a portrait held sideways keeps its subject.
  const sourceHeight = crop ? Math.round(MAX_IMAGE_HEIGHT / scale) : bitmap.height;
  const sourceY = crop ? Math.round((bitmap.height - sourceHeight) / 2) : 0;
  context.drawImage(bitmap, 0, sourceY, bitmap.width, sourceHeight, 0, 0, CARD_WIDTH, drawnHeight);

  const middle = CARD_WIDTH / 2;
  context.textAlign = "left";
  context.textBaseline = "middle";
  const top = drawnHeight + theme.pad;
  let y = top;

  if (captionLines.length) {
    context.fillStyle = theme.ink;
    context.font = captionFont;
    if (theme.center) context.textAlign = "center";
    captionLines.forEach((line, index) => {
      context.fillText(line, theme.center ? middle : theme.pad, y + index * theme.captionLine + theme.captionLine / 2);
    });
    context.textAlign = "left";
    y += captionBlock + theme.gap;
  }

  if (ruleBlock) {
    context.font = `${theme.footerWeight} ${theme.footerSize}px ${theme.font}`;
    const footerWidth = context.measureText(footer ?? "").width;
    // A rule as wide as the whole text block reads as a hard cut; one that
    // matches the footer, capped at a third of the block, reads as typography.
    const width = Math.min(footerWidth, block / 3);
    context.fillStyle = theme.rule;
    context.fillRect(middle - width / 2, y, width, 2);
    y += theme.ruleGap + 2;
  }

  if (footerLines.length) {
    context.fillStyle = theme.muted;
    const upright = `${theme.footerWeight} ${theme.footerSize}px ${theme.font}`;
    // Only the editorial card leans: in the gallery card the footer is a plain
    // line, and italic Latin beside Chinese is exactly the mixed voice the
    // style avoids. `fillMixed` still keeps hanzi upright when it does lean.
    const italic = theme.center ? `italic ${upright}` : upright;
    footerLines.forEach((line, index) => {
      const baseline = y + index * theme.footerLine + theme.footerLine / 2;
      fillMixed(context, line, theme.center ? middle : theme.pad, baseline, upright, italic, theme.center);
    });
  }
}

/** The canvas as a JPEG. Measured at 4.2s alone and 13.2s inside the viewer. */
export function encodeCard(canvas: HTMLCanvasElement): Promise<Blob> {
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
