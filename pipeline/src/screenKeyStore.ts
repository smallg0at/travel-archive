/**
 * Where the passphrase lives now.
 *
 * It used to be a line in `.env` — plaintext, beside the API keys, which is
 * exactly wrong for this one secret. The whole point of encrypting the
 * descriptions is that the key does not sit next to the ciphertext, and `.env`
 * travels with any copy of this machine's files.
 *
 * What is stored instead: the canonical passphrase, wrapped by **DPAPI at user
 * scope**, in `data/screen-key.json`. DPAPI binds it to this Windows account on
 * this machine: copy the file to another account or another computer and it
 * unwraps to nothing. It is still *this account's* secret — the server has to
 * decrypt unattended, so it must be recoverable by whoever runs it. That is the
 * accepted trade, and it is why the old `.env` line is migrated away rather than
 * left in place.
 *
 * The file is **local only**. `data/` holds the mirror and this; the only thing
 * ever uploaded from it is `screen-captions.enc`, explicitly, in graph.ts. New
 * code must not add "upload the data directory" anywhere.
 *
 * DPAPI is reached by running a one-line PowerShell script — Node has no binding
 * for it, and a native module would be a dependency for one call in a blue moon.
 * `powershell.exe` (5.1, .NET Framework) has `ProtectedData` after
 * `Add-Type -AssemblyName System.Security`; `pwsh` needs a package and is not
 * guaranteed. Every call is hidden (`windowsHide`) and bounded, because a hung
 * helper would hang the server.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { dataDir, dataFile } from "./paths.js";
import { normalizePassphrase } from "./screenKey.js";
import { saveConfig } from "./configStore.js";

const KEY_FILE = "screen-key.json";
const PROTECTION = "dpapi-user";
const HELPER_TIMEOUT_MS = 20_000;

interface StoredKey {
  v: 2;
  protection: typeof PROTECTION;
  /** The passphrase in use, DPAPI-wrapped, then base64 for JSON. */
  current: string;
  /**
   * The previous one, present only while a rekey is in flight.
   *
   * A rotation writes two things — this file and the encrypted descriptions — and
   * there is no way to write both at once. For the moment between them, and for
   * the case where the second write fails outright, the *ring* is what keeps the
   * archive readable: reading tries `current` then `previous`, so whichever half
   * of the rotation landed, one of them opens the file. It is dropped as soon as
   * the new descriptions are uploaded, so the old passphrase stops working then,
   * which is the point of rotating at all.
   */
  previous?: string;
}

/** Wrap/unwrap raw bytes. Swapped in tests, because DPAPI is Windows-only and CI is not. */
export interface KeyWrapper {
  name: string;
  available(): boolean;
  wrap(plain: Buffer): Promise<Buffer>;
  unwrap(wrapped: Buffer): Promise<Buffer>;
}

function powershell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: HELPER_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`DPAPI helper failed: ${stderr.trim() || err.message}`));
        resolve(stdout.trim());
      },
    );
  });
}

/**
 * One line each way. The payload is base64, so it contains nothing that could
 * end the string or be read as PowerShell — no escaping, no here-string (a
 * multi-line `-Command` for this failed silently once; see docs/environment.md).
 */
export const dpapi: KeyWrapper = {
  name: PROTECTION,
  available: () => process.platform === "win32",
  async wrap(plain) {
    const out = await powershell(
      "Add-Type -AssemblyName System.Security; " +
        "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect(" +
        `[Convert]::FromBase64String('${plain.toString("base64")}'),$null,'CurrentUser'))`,
    );
    return Buffer.from(out, "base64");
  },
  async unwrap(wrapped) {
    const out = await powershell(
      "Add-Type -AssemblyName System.Security; " +
        "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect(" +
        `[Convert]::FromBase64String('${wrapped.toString("base64")}'),$null,'CurrentUser'))`,
    );
    return Buffer.from(out, "base64");
  },
};

let wrapper: KeyWrapper = dpapi;

/** Tests only: DPAPI exists on Windows, where CI does not run. */
export function useKeyWrapper(next: KeyWrapper): void {
  wrapper = next;
}

export const screenKeyFile = (): string => dataFile(KEY_FILE);

/** Whether this machine can keep a passphrase at all. */
export const canStorePassphrase = (): boolean => wrapper.available();

/**
 * The passphrases this machine holds, current first.
 *
 * A list rather than one value because of the rekey window the ring exists for —
 * see `StoredKey.previous`. An empty list means nothing is stored; a *failure* to
 * unwrap **throws** rather than returning an empty list, because "nothing stored"
 * and "cannot read what is stored" must not look the same: the first is a fresh
 * archive, the second is a key that belongs to another Windows account.
 */
export async function readStoredPassphrases(): Promise<string[]> {
  let stored: StoredKey & { wrapped?: string };
  try {
    stored = JSON.parse(await readFile(screenKeyFile(), "utf-8")) as StoredKey & { wrapped?: string };
  } catch {
    return [];
  }
  // `wrapped` is the v1 shape, before the ring existed: read it as the current
  // one. Installs written before this change keep working without a migration.
  const blobs = [stored?.current ?? stored?.wrapped, stored?.previous].filter((b): b is string => typeof b === "string");
  const out: string[] = [];
  for (const blob of blobs) {
    try {
      out.push(normalizePassphrase((await wrapper.unwrap(Buffer.from(blob, "base64"))).toString("utf-8")));
    } catch (err) {
      // Every blob failing is a real failure; one of two failing is not, as long
      // as the other opens the file.
      if (blobs.length === 1) throw err;
    }
  }
  if (blobs.length > 0 && out.length === 0) throw new Error(`no stored passphrase could be unwrapped by ${wrapper.name}`);
  return out;
}

/** The passphrase in use, or null when nothing is stored. */
export async function readStoredPassphrase(): Promise<string | null> {
  return (await readStoredPassphrases())[0] ?? null;
}

export async function hasStoredPassphrase(): Promise<boolean> {
  try {
    await readFile(screenKeyFile(), "utf-8");
    return true;
  } catch {
    return false;
  }
}

export async function writeStoredPassphrase(passphrase: string, options: { previous?: string } = {}): Promise<void> {
  if (!wrapper.available()) {
    throw new Error(
      `This machine has no key store (${wrapper.name} is Windows-only), so the passphrase cannot be kept here. ` +
        `Set SCREENSHOT_PASSPHRASE in pipeline/.env before starting the server, or run the server on Windows.`,
    );
  }
  const wrapped = await wrapper.wrap(Buffer.from(normalizePassphrase(passphrase), "utf-8"));
  const stored: StoredKey = { v: 2, protection: PROTECTION, current: wrapped.toString("base64") };
  if (options.previous && normalizePassphrase(options.previous) !== normalizePassphrase(passphrase)) {
    stored.previous = (await wrapper.wrap(Buffer.from(normalizePassphrase(options.previous), "utf-8"))).toString("base64");
  }
  await mkdir(dataDir(), { recursive: true });
  await writeFile(screenKeyFile(), `${JSON.stringify(stored)}\n`, "utf-8");
}

export async function forgetStoredPassphrase(): Promise<void> {
  await unlink(screenKeyFile()).catch(() => {});
}

/**
 * Move a passphrase out of `.env` and into the key store, once.
 *
 * Called at startup so an existing install becomes DPAPI-protected without
 * anyone being asked to do anything, and the plaintext line stops being the
 * thing that protects 2,000 descriptions. The environment is re-read from the
 * file rather than trusted from `process.env`, so this sees what is on disk now.
 */
export async function importLegacyPassphrase(): Promise<{ migrated: boolean; legacy: boolean }> {
  const stored = await hasStoredPassphrase();
  const fromFile = await legacyValue();
  if (!stored && fromFile) {
    await writeStoredPassphrase(fromFile);
    // Only `null` is accepted for this key — it is no longer writable through
    // /config, and the value now lives in the key store.
    await saveConfig({ SCREENSHOT_PASSPHRASE: null });
    console.log("screen passphrase: moved out of .env into the Windows key store (DPAPI, this user)");
    return { migrated: true, legacy: false };
  }
  if (stored && fromFile) {
    // Both present: the store wins, and the plaintext line is a leftover. Remove
    // it rather than leave a stale copy of the secret on disk.
    await saveConfig({ SCREENSHOT_PASSPHRASE: null });
    console.log("screen passphrase: the key store wins; removed the leftover .env line");
    return { migrated: false, legacy: false };
  }
  return { migrated: false, legacy: !stored && !fromFile && !!process.env.SCREENSHOT_PASSPHRASE };
}

/** The passphrase as it still appears in `.env`, if it does. */
async function legacyValue(): Promise<string | null> {
  try {
    const text = await readFile(dataFile("../.env"), "utf-8");
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*SCREENSHOT_PASSPHRASE\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const raw = match[1].trim().replace(/^(['"])(.*)\1$/, "$2");
      if (raw) return normalizePassphrase(raw);
    }
  } catch {
    /* no .env, or no access — either way there is nothing to migrate */
  }
  return null;
}
