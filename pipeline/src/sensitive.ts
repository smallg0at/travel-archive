import { readFile } from "node:fs/promises";
import { homeFile } from "./paths.js";
import type { PhotoRecord, SensitiveFlag, SensitiveKind } from "@travel-archive/shared";

/**
 * Finds personal identifiers in text the AI pass transcribed off photos, and
 * flags those photos so day summaries never quote them.
 *
 * This is cleanup after the fact, not prevention. Screenshots are gated before
 * they are ever sent (screenshots.ts), but a *camera photo* of a passport,
 * boarding pass or bank letter looks like any other document, so it reaches the
 * provider and comes back with its text faithfully transcribed into
 * `extractedText`. That transcript then feeds the day summarizer, which is
 * where a passport number could end up written into readable prose.
 *
 * Flagging withholds the photo from summarization only. The photo, its caption
 * and its transcript all stay in the archive and the album — this exists to keep
 * identifiers out of generated narrative, not to hide the user's own photos
 * from them.
 *
 * **Why context keywords.** A first pass matched identifier *shapes* alone and
 * 3 of its 4 passport hits were false positives — a lounge floor map and an
 * assisted-travel sign, both of which happen to contain a letter followed by
 * digits. Shapes like `[A-Z]\d{7}` are far too common in ordinary signage to
 * mean anything by themselves. So the shape must appear near a word that says
 * what it is. Formats that are self-identifying (email addresses, IBANs,
 * Luhn-valid card numbers, Chinese national IDs) need no such corroboration.
 */

const TERMS_FILE = homeFile("redaction-terms.json");

/** How far from a matched number a corroborating keyword may sit. */
const CONTEXT_WINDOW = 48;

interface Pattern {
  kind: SensitiveKind;
  re: RegExp;
  /** When set, the match only counts if one of these appears within CONTEXT_WINDOW characters. */
  context?: RegExp;
  /** Extra validation on the matched text. */
  accept?: (match: string) => boolean;
}

/**
 * Dates and date-times are the single biggest source of false phone matches on
 * this archive — "21.08.2026 08:29" on a rail disruption notice, "1780. 1820"
 * on a history board. They are digits with separators in exactly the phone
 * shape, and no context test saves you because they sit in prose that talks
 * about services and contacts.
 */
const DATE_SHAPED = /^\s*\d{1,4}[.\-/]\s*\d{1,4}([.\-/]\s*\d{1,4})?(\s+\d{1,2}[:.]\d{2})?\s*$/;

/**
 * Card numbers pass a Luhn check before counting. Without it every 16-digit
 * run — flight numbers stacked in a table, a long reference code — reads as a
 * payment card. With it, false positives drop to roughly 1 in 10.
 */
function luhnValid(digits: string): boolean {
  const d = digits.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Chinese resident ID: 17 digits plus a checksum digit or X, weighted mod 11. */
function chineseIdValid(id: string): boolean {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const check = "10X98765432";
  if (!/^\d{17}[\dX]$/i.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += (id.charCodeAt(i) - 48) * weights[i];
  return check[sum % 11] === id[17].toUpperCase();
}

/**
 * Identity documents and payment instruments. A hit here withholds the photo,
 * because these identify *the archive's owner* and essentially never appear on
 * public signage — nobody prints a passport number on a museum plaque.
 *
 * Every context keyword is word-bounded. Without that, `tel` matched inside
 * "Darstellung" on a Vermeer label and corroborated three groups of OCR noise
 * as a phone number.
 */
const WITHHOLDING: Pattern[] = [
  // Self-identifying formats — no corroboration needed.
  { kind: "iban", re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g },
  { kind: "card_number", re: /\b(?:\d[ -]?){13,19}\b/g, accept: luhnValid },
  { kind: "national_id", re: /\b\d{17}[\dX]\b/gi, accept: chineseIdValid },

  // Shapes that are only meaningful next to a word saying what they are.
  {
    kind: "passport_or_id",
    re: /\b[A-Z]{1,2}\d{6,9}\b/g,
    context: /\b(passport|identity card|id no|id number|document no|nationality)\b|护照/i,
  },
  {
    kind: "booking_reference",
    re: /\b[A-Z0-9]{6}\b/g,
    context: /\b(booking|reference|confirmation|pnr|reservation)\b|订单|订票|预订/i,
  },
];

/**
 * Contact details — reported, but NOT withheld.
 *
 * They look like personal data and here they almost never are. Measured over
 * this archive's first 138 transcripts, every phone and email hit belonged to
 * somebody else's *business*: ÖBB's customer-service line on a disruption
 * notice, a council tourism office on a history board, an advertiser on a
 * subway platform. A travel archive is largely photographs of signage, so
 * withholding on contact details would quietly delete real content from
 * summaries in order to protect information published on a wall.
 *
 * They are still surfaced by `redact`, because a delivery label or a hotel
 * confirmation carrying the user's own number is a genuine case — just one a
 * human should judge. A number the user wants caught permanently goes in
 * redaction-terms.json, which does withhold.
 */
const NOTICE_ONLY: Pattern[] = [
  { kind: "email_address", re: /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/gi },
  {
    kind: "phone",
    re: /\+?\d[\d\s().-]{7,17}\d/g,
    context: /\b(tel|telephone|phone|mobile|contact)\b|电话|手机/i,
    accept: (m) => !DATE_SHAPED.test(m),
  },
];

interface TermsFile {
  terms?: string[];
}

/**
 * Literal strings the user considers identifying — their own name above all,
 * which no pattern can find generically. Missing or unreadable file yields an
 * empty list: this augments the patterns, so failing open here costs some
 * name matches rather than breaking detection outright.
 */
export async function loadRedactionTerms(): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(TERMS_FILE, "utf-8")) as TermsFile;
    return (parsed.terms ?? []).map((t) => t.trim()).filter((t) => t.length >= 3);
  } catch {
    return [];
  }
}

function hasContextNear(text: string, index: number, length: number, context: RegExp): boolean {
  const window = text.slice(Math.max(0, index - CONTEXT_WINDOW), index + length + CONTEXT_WINDOW);
  return context.test(window);
}

/** Keeps a hit reviewable without copying an identifier out in full. */
function redactSample(match: string): string {
  const trimmed = match.trim();
  if (trimmed.length <= 4) return trimmed;
  return `${trimmed.slice(0, 2)}${"*".repeat(Math.min(trimmed.length - 4, 12))}${trimmed.slice(-2)}`;
}

export interface Detection {
  /** Kinds that withhold the photo from summaries. */
  kinds: SensitiveKind[];
  samples: string[];
  /** Contact details seen but not acted on — reported for the user to judge. */
  notices: string[];
}

/**
 * Runs every pattern plus the user's term list over one transcript.
 * Returns null when nothing matched.
 */
function scan(text: string, patterns: Pattern[], onHit: (kind: SensitiveKind, value: string) => void): void {
  for (const pattern of patterns) {
    pattern.re.lastIndex = 0;
    for (const m of text.matchAll(pattern.re)) {
      const value = m[0];
      if (pattern.accept && !pattern.accept(value)) continue;
      if (pattern.context && !hasContextNear(text, m.index ?? 0, value.length, pattern.context)) continue;
      onHit(pattern.kind, value);
    }
  }
}

export function detectSensitive(text: string | null, terms: string[]): Detection | null {
  if (!text) return null;

  const kinds = new Set<SensitiveKind>();
  const samples: string[] = [];
  const notices: string[] = [];

  scan(text, WITHHOLDING, (kind, value) => {
    kinds.add(kind);
    if (samples.length < 6) samples.push(`${kind}: ${redactSample(value)}`);
  });
  scan(text, NOTICE_ONLY, (kind, value) => {
    if (notices.length < 4) notices.push(`${kind}: ${redactSample(value)}`);
  });

  const lower = text.toLowerCase();
  for (const term of terms) {
    if (lower.includes(term.toLowerCase())) {
      kinds.add("personal_term");
      if (samples.length < 6) samples.push(`personal_term: ${redactSample(term)}`);
    }
  }

  if (kinds.size === 0 && notices.length === 0) return null;
  return { kinds: [...kinds], samples, notices };
}

/**
 * Whether a photo's description must be kept out of generated summaries.
 * A dismissed flag means the user reviewed the hit and called it a false
 * positive, so it stops withholding without having to be deleted — and
 * `redact` leaves dismissed photos alone on later runs.
 */
export function withheldFromSummaries(photo: PhotoRecord): boolean {
  // Truthiness, not `!== null`: records written before schema v8 have no
  // `sensitive` key at all, and `undefined !== null` would have withheld every
  // photo in the archive from every summary, silently.
  return Boolean(photo.sensitive) && !photo.sensitive!.dismissed;
}

export function flagFor(detection: Detection, prior: SensitiveFlag | null): SensitiveFlag {
  return {
    kinds: detection.kinds,
    samples: detection.samples,
    flaggedAt: prior?.flaggedAt ?? new Date().toISOString(),
    dismissed: prior?.dismissed ?? false,
  };
}
