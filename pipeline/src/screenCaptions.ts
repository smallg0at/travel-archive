/**
 * What the local model said about a screenshot nobody has vouched for —
 * encrypted, and then treated like any other file in the archive.
 *
 * The first design kept this on the machine and never uploaded it. That dodged a
 * crypto dependency and cost a second data path: a file that exists on one
 * computer, is lost with it, and adds a branch to every reader. Partial sync plus
 * a separate store is maintenance debt, and the owner said so. So the
 * descriptions travel with the archive like everything else, and what keeps them
 * private is that they are **encrypted under a passphrase the archive does not
 * carry**: the OneDrive copy is opaque, and this server is the one thing that can
 * read it.
 *
 * AES-256-GCM over the whole file, key = `scrypt(passphrase, salt)`. The envelope
 * is what gets uploaded; the plaintext is never written to disk. The ciphertext
 * is authenticated against this file's identity as associated data, so one blob
 * cannot be swapped for another, and a wrong passphrase **fails loudly** rather
 * than reading as "nothing described yet" — silently starting over would destroy
 * hours of work, and it would look exactly like a fresh archive.
 *
 * Losing the passphrase costs a re-run, not the archive: the descriptions can be
 * made again. Losing the *file* costs the same. Neither is a reason to keep the
 * plaintext anywhere.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dataFile, dataDir } from "./paths.js";
import { downloadMetadataJson, fetchItemMeta, uploadMetadataJson } from "./graph.js";
import { env } from "./env.js";
import { readStoredPassphrase, writeStoredPassphrase } from "./screenKeyStore.js";
import { deriveKey, keyFingerprint } from "./screenKey.js";

/** One described screen. Coarse by construction — see `providers/screenshotPrompt.ts`. */
export interface ScreenCaptionEntry {
  /** The kind of screen, in one sentence. Never what it says. */
  caption: string;
  /** Coarse kind tags ("chat", "id-card"), the searchable handle. Never the subject. */
  tags: string[];
  /** The preset id that wrote it, so a re-run can tell one model's work from another's. */
  model: string;
  /** When it was written, ISO. */
  at: string;
}

export interface ScreenCaptions {
  version: 1;
  /** Keyed by photo id — the same id the shards use. */
  entries: Record<string, ScreenCaptionEntry>;
}

/** What is uploaded: unreadable without the passphrase. */
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
   * Which key this file wants, as `keyFingerprint`. Optional because envelopes
   * written before it existed are still valid — its absence means "try the
   * decryption and see", which is what every reader did until now.
   */
  fp?: string;
}

export const SCREEN_CAPTIONS_FILE = "screen-captions.enc";
const AAD = "travel-archive/screen-captions/v1";
/** `N` is the work factor: 2^15 costs about a tenth of a second here, once per load. */
const KDF = { N: 1 << 15, r: 8, p: 1 };

export const emptyScreenCaptions = (): ScreenCaptions => ({ version: 1, entries: {} });

/** The passphrase, from the machine's key store, or a message that says what to do. */
export async function screenshotPassphrase(): Promise<string> {
  const stored = await readStoredPassphrase().catch((err: Error) => {
    // Unwrapping failed — a different Windows account, or a restored file. Say
    // that, rather than let it read as "never set up", which is what starting
    // over on top of existing work would look like.
    throw new Error(
      `The stored passphrase could not be read on this account: ${err.message}. ` +
        `It is protected per Windows user, so a copy from another account or machine cannot open it.`,
    );
  });
  if (!stored) {
    throw new Error(
      "No passphrase is stored on this machine, so the encrypted screenshot descriptions cannot be read or written. " +
        "Set one in the Screens tab (it is kept in the Windows key store, not in .env).",
    );
  }
  return stored;
}

export function encryptScreenCaptions(file: ScreenCaptions, passphrase: string): ScreenCaptionsEnvelope {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const kdf = { ...KDF };
  const key = deriveKey(passphrase, salt, kdf);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(AAD));
  const ct = Buffer.concat([cipher.update(JSON.stringify(file), "utf-8"), cipher.final()]);
  return {
    v: 1,
    kdf: { salt: salt.toString("base64"), ...kdf },
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
    // The name of the key that opens this file, so another device can say "wrong
    // passphrase" instead of "corrupt or damaged".
    fp: keyFingerprint(key),
  };
}

export function decryptScreenCaptions(envelope: ScreenCaptionsEnvelope, passphrase: string): ScreenCaptions {
  const salt = Buffer.from(envelope.kdf.salt, "base64");
  const key = deriveKey(passphrase, salt, envelope.kdf);
  if (envelope.fp && envelope.fp !== keyFingerprint(key)) {
    throw new Error(
      `This passphrase is not the one ${SCREEN_CAPTIONS_FILE} was written with (it wants ${envelope.fp}, this derives ${keyFingerprint(key)}). ` +
        `Enter the passphrase that wrote it, or delete the file to start the descriptions over.`,
    );
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAAD(Buffer.from(AAD));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  try {
    const text = Buffer.concat([decipher.update(Buffer.from(envelope.ct, "base64")), decipher.final()]).toString("utf-8");
    const parsed = JSON.parse(text) as ScreenCaptions;
    return { version: 1, entries: parsed.entries ?? {} };
  } catch {
    // GCM cannot tell a wrong key from a flipped byte, and neither can we — but
    // "this is not the passphrase that wrote it" is the actionable half. (For
    // envelopes carrying `fp` that case is already caught above.)
    throw new Error(
      `Could not decrypt ${SCREEN_CAPTIONS_FILE}: it was written with a different SCREENSHOT_PASSPHRASE, or is damaged. ` +
        `Restore the passphrase, or delete the file to start the descriptions over.`,
    );
  }
}

async function fileMtime(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The descriptions, for a **write** path: the local mirror when it is provably
 * safe, Graph otherwise — the same rule `loadIndexForWriting` keeps, and for the
 * same reason (the mirror is trusted only when the remote is not clearly newer).
 * An absent file is an empty one: that is what a fresh archive looks like.
 */
export async function loadScreenCaptions(token: string): Promise<ScreenCaptions> {
  const passphrase = await screenshotPassphrase();
  const local = await readLocalEnvelope();
  if (local) {
    const meta = await fetchItemMeta(token, env.metadataFolder, SCREEN_CAPTIONS_FILE);
    const remote = meta?.lastModifiedDateTime ? Date.parse(meta.lastModifiedDateTime) : 0;
    if (remote <= local.mtime + 5000) return decryptScreenCaptions(local.envelope, passphrase);
  }
  const remote = await downloadMetadataJson<ScreenCaptionsEnvelope>(token, env.metadataFolder, SCREEN_CAPTIONS_FILE);
  return remote ? decryptScreenCaptions(remote, passphrase) : emptyScreenCaptions();
}

/** Encrypts, writes the local mirror, then uploads. A failed upload costs a re-upload, not the work. */
export async function saveScreenCaptions(
  token: string,
  file: ScreenCaptions,
  passphrase?: string,
): Promise<void> {
  const key = passphrase ?? (await screenshotPassphrase());
  const envelope = encryptScreenCaptions(file, key);
  await mkdir(dataDir(), { recursive: true });
  await writeFile(dataFile(SCREEN_CAPTIONS_FILE), `${JSON.stringify(envelope)}\n`, "utf-8");
  await uploadMetadataJson(token, env.metadataFolder, SCREEN_CAPTIONS_FILE, envelope);
}

/**
 * Set a new passphrase without losing what is already described.
 *
 * Load with the old one, store the new one, save with it. Without this, changing
 * the passphrase is indistinguishable from losing it: the entries become
 * unreadable, the only way forward is to delete the file, and hours of describing
 * are the price of a decision. The load also means a *wrong current* passphrase
 * cannot sail through — if the file cannot be read, nothing is re-encrypted and
 * the error says so.
 *
 * The new value is used explicitly rather than by re-reading the store, so what
 * gets written is exactly what was validated: storing it first and then
 * encrypting with "whatever the store says" could differ if the store cannot
 * hold it on this platform.
 */
export async function rekeyScreenCaptions(
  token: string,
  next: string,
): Promise<{ described: number; fingerprint: string }> {
  const file = await loadScreenCaptions(token);
  await writeStoredPassphrase(next);
  const envelope = encryptScreenCaptions(file, next);
  await mkdir(dataDir(), { recursive: true });
  await writeFile(dataFile(SCREEN_CAPTIONS_FILE), `${JSON.stringify(envelope)}\n`, "utf-8");
  await uploadMetadataJson(token, env.metadataFolder, SCREEN_CAPTIONS_FILE, envelope);
  return { described: Object.keys(file.entries).length, fingerprint: envelope.fp ?? "" };
}

async function readLocalEnvelope(): Promise<{ envelope: ScreenCaptionsEnvelope; mtime: number } | null> {
  try {
    const text = await readFile(dataFile(SCREEN_CAPTIONS_FILE), "utf-8");
    const mtime = (await fileMtime(dataFile(SCREEN_CAPTIONS_FILE))) ?? 0;
    return { envelope: JSON.parse(text) as ScreenCaptionsEnvelope, mtime };
  } catch {
    return null;
  }
}

/** Where the file lives — beside `.env`, in the mirrored `data/` tree. For tests and for the settings page to name. */
export const screenCaptionsFile = (): string => dataFile(SCREEN_CAPTIONS_FILE);

/** Test seam: forget nothing is cached here, but this keeps the old call site honest. */
export function forgetScreenCaptions(): void {
  /* no cache to drop */
}
