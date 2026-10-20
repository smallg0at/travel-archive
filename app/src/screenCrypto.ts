/**
 * Opening the encrypted screenshot descriptions — in the reader, not on the server.
 *
 * The file `screen-captions.enc` travels with the archive like every other
 * file, encrypted under a passphrase the archive does not carry. The pipeline
 * writes it (`pipeline/src/screenCaptions.ts`); this is the other half, and it
 * is deliberately **decrypt only**: the app has no business encrypting
 * anything, because the app is a reader and the descriptions are written by a
 * job on the machine that holds the model.
 *
 * Why the client and not the server: the phone has no server. It reads
 * OneDrive directly, so a design where the server opens the file leaves the
 * phone unable to read the very thing the server was asked to protect. One
 * implementation, both surfaces, and the plaintext never crosses a network.
 *
 * Two facts about the envelope are fixed by the file that wrote it and are
 * therefore law here: the KDF is scrypt(N=2^15, r=8, p=1) and the ciphertext is
 * authenticated against the string `travel-archive/screen-captions/v1` as
 * associated data. Change either and every description in the archive becomes
 * unreadable — which is why they are constants, not options.
 *
 * scrypt is not in WebCrypto, so it comes from `scrypt-js`, a pure-JS
 * implementation. It agrees with Node's native scrypt to the byte (there is a
 * test that says so), and it costs about 200ms on a desktop — a second or two
 * on a phone, once per unlock, which is why the passphrase is asked for once
 * and then kept for the session rather than typed per read.
 */
import { scrypt } from "scrypt-js";

/**
 * One described screen. Coarse by construction — the prompt tells the model to
 * name the *kind* of screen and to transcribe nothing (see
 * `pipeline/src/providers/screenshotPrompt.ts`).
 */
export interface ScreenCaptionEntry {
  /** The kind of screen, in one sentence. Never what it says. */
  caption: string;
  /** Coarse kind tags ("chat", "id-card"), the searchable handle. Never the subject. */
  tags: string[];
  /** The preset id that wrote it, so a re-run can tell one model's work from another's. */
  model: string;
  /** When it was written, ISO. */
  at: string;
  /**
   * The day the screenshot was taken, `YYYY-MM-DD`.
   *
   * Optional because the files written before it existed do not carry it: the
   * date is what lets a description be grouped under its day in search, and
   * without it the description is still shown on the photograph's own day page
   * — it simply cannot be found by searching for it.
   */
  date?: string | null;
}

/** The plaintext of the file, once it is open. */
export interface ScreenCaptions {
  version: 1;
  /** Keyed by photo id — the same id the shards use. */
  entries: Record<string, ScreenCaptionEntry>;
}

/**
 * What is uploaded: unreadable without the passphrase.
 *
 * The same shape as `pipeline/src/screenCaptions.ts`, which is the other end of
 * this contract. `v` is the *envelope* version; the plaintext inside carries
 * its own `version`.
 */
export interface ScreenCaptionsEnvelope {
  v: 1;
  kdf: { salt: string; N: number; r: number; p: number };
  /** AES-GCM nonce, base64. */
  iv: string;
  /** GCM authentication tag, base64. */
  tag: string;
  /** Ciphertext, base64. */
  ct: string;
  /**
   * Which key this file wants, as `keyFingerprint`. Absent on envelopes
   * written before it existed — its absence means "try the decryption and
   * see", which is what every reader did until now.
   */
  fp?: string;
}

/** The associated data every v1 envelope is sealed with. Fixed by the file. */
const AAD = "travel-archive/screen-captions/v1";

/**
 * The failures this module reports, as a **code**.
 *
 * The codes are the pipeline's own (`pipeline/src/screenErrors.ts`), because
 * the same sentence has to be shown whether the server or the reader is the
 * one that failed — the app has one translation table for both.
 */
export type ScreenCryptoErrorCode =
  | "passphrase-too-short"
  | "passphrase-too-long"
  | "passphrase-too-common"
  | "passphrase-too-famous"
  | "passphrase-mismatch"
  | "descriptions-damaged"
  | "no-passphrase"
  | "no-crypto";

export class ScreenCryptoError extends Error {
  readonly code: ScreenCryptoErrorCode;
  readonly params: Record<string, string | number>;

  constructor(code: ScreenCryptoErrorCode, message: string, params: Record<string, string | number> = {}) {
    super(message);
    this.name = "ScreenCryptoError";
    this.code = code;
    this.params = params;
  }
}

/**
 * Whether this surface can decrypt anything at all.
 *
 * `crypto.subtle` exists only in a **secure context**: https, `localhost` and
 * `127.0.0.1` qualify, a LAN address over plain http does not (measured
 * 2026-10-14: `http://192.168.3.68:17923` has `crypto.subtle === undefined`).
 * That is the platform's rule, not ours, and it is a good one: a reader on the
 * home network is refused by the browser itself. The app hides the feature
 * there rather than pretending and failing later.
 */
export function cryptoAvailable(): boolean {
  return typeof globalThis.crypto?.subtle?.decrypt === "function";
}

/**
 * The canonical form of a passphrase.
 *
 * The same rule the pipeline applies (`pipeline/src/screenKey.ts`), and it has
 * to be the same rule to the character: a passphrase is typed by a person, and
 * people paste invisible things — a trailing space, a zero-width space, a
 * combining accent. Normalised here, they are not, the same passphrase derives
 * two different keys, and the failure reads as "it works on the laptop and not
 * on the phone" with nothing anywhere to see.
 *
 * Case is *not* folded and inner spaces are *not* collapsed: each would shrink
 * the space of secrets and make a passphrase two people believe they share
 * fail in one direction only. Invisible characters are removed rather than
 * rejected, because the person cannot retype what they cannot see.
 */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

export function normalizePassphrase(raw: string): string {
  return raw.normalize("NFC").replace(INVISIBLE, "").trim();
}

/** The shortest passphrase the server will accept — the same rule, kept in step. */
export const MIN_PASSPHRASE_CHARS = 12;
/** The longest, which also bounds a paste. */
export const MAX_PASSPHRASE_CHARS = 256;

/**
 * Passphrases that are long enough and still hopeless, plus the one that is
 * famously *good* and therefore famous. Same list as the server's, so the form
 * and the reader cannot disagree about what is acceptable.
 */
const TOO_COMMON = new Set([
  "password1234",
  "password12345",
  "passwordpassword",
  "123456789012",
  "1234567890123",
  "qwertyuiop12",
  "qwerty123456",
  "letmein12345",
  "iloveyou12345",
  "admin1234567",
  "welcome123456",
]);

const TOO_FAMOUS = new Set(["correct horse battery staple", "correcthorsebatterystaple"]);

/**
 * Whether a passphrase would be accepted, and why not.
 *
 * The rules are the server's, applied here so the reader can say "too short"
 * before the request is made rather than after it is refused.
 */
export function passphraseProblem(raw: string): ScreenCryptoError | null {
  const value = normalizePassphrase(raw);
  if (value.length < MIN_PASSPHRASE_CHARS) {
    return new ScreenCryptoError("passphrase-too-short", `The passphrase must be at least ${MIN_PASSPHRASE_CHARS} characters.`, {
      min: MIN_PASSPHRASE_CHARS,
    });
  }
  if (value.length > MAX_PASSPHRASE_CHARS) {
    return new ScreenCryptoError("passphrase-too-long", `The passphrase must be at most ${MAX_PASSPHRASE_CHARS} characters.`, {
      max: MAX_PASSPHRASE_CHARS,
    });
  }
  if (TOO_COMMON.has(value.toLowerCase()) || /^(.)\1+$/.test(value)) {
    return new ScreenCryptoError("passphrase-too-common", "That passphrase is one of the first ones anybody would try.");
  }
  if (TOO_FAMOUS.has(value.toLowerCase())) {
    return new ScreenCryptoError("passphrase-too-famous", "That is the most-quoted passphrase on the internet.");
  }
  return null;
}

/** base64 → bytes. Node's `Buffer.from(x, "base64")` is lenient; the browser's is not. */
function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, "");
  const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The key bytes for a passphrase, the way the server derived them.
 *
 * The passphrase is normalised first and then encoded as UTF-8 — the same two
 * steps, in the same order, as `deriveKey` in `pipeline/src/screenKey.ts`. A
 * different order here would derive a different key from the same passphrase,
 * and the only symptom would be "wrong passphrase" on a passphrase that is
 * right.
 */
export async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  params: { N: number; r: number; p: number },
): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(normalizePassphrase(passphrase));
  // `scrypt-js` takes its arguments positionally: (password, salt, N, r, p,
  // keyLength). It measures 300ms here and yields between blocks, so the page
  // stays alive while it works — which is what a browser wants, where the
  // library's timer is clamped and the whole thing takes a few seconds.
  return scrypt(bytes, salt, params.N, params.r, params.p, 32);
}

/**
 * A short, stable name for a derived key: `ABCD-1234`.
 *
 * A hash of the key, not of the passphrase, and safe to publish next to the
 * ciphertext: an attacker's real test is already "does this key decrypt the
 * file". Two devices can compare it to know they hold the same passphrase
 * *before* trying, which turns "this file will not open" into "these are
 * different passphrases".
 */
export async function keyFingerprint(key: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", key as unknown as BufferSource);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 8).toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}

/**
 * Open an envelope.
 *
 * A wrong passphrase **fails loudly** rather than reading as "nothing described
 * yet": silently starting over would destroy hours of work and would look
 * exactly like a fresh archive. So the two failures are told apart: the
 * fingerprint says "this is not the passphrase that wrote it", and anything
 * else says "the file is damaged".
 */
export async function decryptScreenCaptions(envelope: ScreenCaptionsEnvelope, passphrase: string): Promise<ScreenCaptions> {
  if (!cryptoAvailable()) {
    throw new ScreenCryptoError(
      "no-crypto",
      "This browser cannot decrypt: WebCrypto is only available in a secure context (https, or localhost).",
    );
  }
  const salt = fromBase64(envelope.kdf.salt);
  const key = await deriveKey(passphrase, salt, envelope.kdf);
  if (envelope.fp) {
    const derives = await keyFingerprint(key);
    if (envelope.fp !== derives) {
      throw new ScreenCryptoError(
        "passphrase-mismatch",
        `This passphrase is not the one the file was written with (it wants ${envelope.fp}, this derives ${derives}).`,
        { wants: envelope.fp, derives },
      );
    }
  }
  const iv = fromBase64(envelope.iv);
  const tag = fromBase64(envelope.tag);
  const ct = fromBase64(envelope.ct);
  // WebCrypto expects the authentication tag at the end of the ciphertext, and
  // the envelope keeps the two apart — so they are joined here, in that order.
  const sealed = new Uint8Array(ct.length + tag.length);
  sealed.set(ct, 0);
  sealed.set(tag, ct.length);
  try {
    const cryptoKey = await globalThis.crypto.subtle.importKey("raw", key as unknown as BufferSource, "AES-GCM", false, ["decrypt"]);
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource, additionalData: new TextEncoder().encode(AAD), tagLength: 128 },
      cryptoKey,
      sealed as unknown as BufferSource,
    );
    const parsed = JSON.parse(new TextDecoder().decode(plain)) as ScreenCaptions;
    return { version: 1, entries: parsed.entries ?? {} };
  } catch (err) {
    // GCM cannot tell a wrong key from a flipped byte, and neither can we — but
    // "this is not the passphrase that wrote it" is the actionable half, and
    // that case is already caught above by the fingerprint.
    throw new ScreenCryptoError(
      "descriptions-damaged",
      "The encrypted descriptions could not be decrypted: written with a different passphrase, or damaged.",
    );
  }
}
