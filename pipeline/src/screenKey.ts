/**
 * The one funnel every passphrase goes through: what a person typed → the bytes
 * that are actually used as a key.
 *
 * Why a funnel at all: a passphrase is *typed by a person*, and people paste
 * invisible things. A trailing space, a zero-width space copied out of a web
 * page, a combining accent composed on one device and decomposed on another, an
 * emoji some input methods write as two code points — each of those is a
 * passphrase that looks identical on screen and derives a different key. That
 * failure reads as "it works on the laptop and not on the phone", with nothing
 * anywhere to see. So the passphrase is never used raw; it is normalised here,
 * and every surface (this server, the phone, any future reader) does exactly
 * this.
 *
 * What it deliberately does **not** do: case folding, collapsing inner spaces,
 * stripping punctuation. Each would silently shrink the space of secrets and make
 * a passphrase two people believe they share fail in one direction only.
 *
 * Two invisible characters are *removed* rather than rejected, because the person
 * cannot retype what they cannot see: rejecting leaves them with a passphrase
 * they cannot reproduce. Everything else survives untouched.
 *
 * The file already on OneDrive keeps decrypting: its passphrase is ASCII with no
 * edge whitespace and no composed characters, so normalising it is the identity
 * transformation — asserted by a test against the real file's shape.
 */
import { createHash, scryptSync } from "node:crypto";

/** 256 characters is generous for something a human types, and bounds a paste. */
export const MAX_PASSPHRASE_CHARS = 256;
/** The rekey route's rule, kept here so the form and the server cannot disagree. */
export const MIN_PASSPHRASE_CHARS = 12;

/**
 * C0/C1 controls, DEL, line/paragraph separators, the zero-width, bidi and
 * word-joiner controls, and the BOM — invisible, and indistinguishable from each
 * other when retyped.
 */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** The canonical form. NFC first, so composition happens before anything is removed. */
export function normalizePassphrase(raw: string): string {
  return raw.normalize("NFC").replace(INVISIBLE, "").trim();
}

/** The canonical passphrase, or the reason it cannot be one. */
export function passphraseProblem(raw: string): string | null {
  const value = normalizePassphrase(raw);
  if (value.length < MIN_PASSPHRASE_CHARS) {
    return `The passphrase must be at least ${MIN_PASSPHRASE_CHARS} characters — it is the only thing protecting these descriptions.`;
  }
  if (value.length > MAX_PASSPHRASE_CHARS) {
    return `The passphrase must be at most ${MAX_PASSPHRASE_CHARS} characters.`;
  }
  return null;
}

/**
 * scrypt over the canonical passphrase. `maxmem` is raised because the default
 * 32 MiB is below what N=2^15, r=8 needs and scrypt refuses rather than
 * allocating.
 */
export function deriveKey(
  passphrase: string,
  salt: Buffer,
  params: { N: number; r: number; p: number },
): Buffer {
  const canonical = Buffer.from(normalizePassphrase(passphrase), "utf-8");
  return scryptSync(canonical, salt, 32, { ...params, maxmem: 128 * 1024 * 1024 });
}

/**
 * A short, stable name for a derived key: `ABCD-1234`.
 *
 * Two devices can compare this to know they hold the same passphrase *before*
 * trying to decrypt anything, which turns "this file will not open" into "these
 * are different passphrases". It is a hash of the key, not of the passphrase, and
 * it is safe to publish next to the ciphertext: an attacker's real test is
 * already "does this key decrypt the file", so this adds no new information.
 */
export function keyFingerprint(key: Buffer): string {
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 8).toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}
