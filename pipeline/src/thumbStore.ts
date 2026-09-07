import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "./paths.js";

/**
 * A thumbnail cache on disk, served by the local job server.
 *
 * The app's original cache lives in the browser's IndexedDB, which was the only
 * option when there was no backend and the phone was the target. On a desktop
 * with a local server that is the wrong place for it:
 *
 *  - it is per browser, so opening the archive in a second browser refetches
 *    the whole library — which is exactly what happened in Floorp;
 *  - a privacy-minded browser clears site data on close, and the app degrades
 *    to network-only *silently*;
 *  - every thumbnail costs a client-side Graph `$batch` call to mint a
 *    short-lived CDN link, because those links are never the same twice.
 *
 * A file per thumbnail under `data/thumbs/` fixes all three at once. The URL
 * the app requests is keyed on the OneDrive item id and never changes, so the
 * browser's ordinary HTTP cache works on top of this for free — the thing the
 * CDN links could never allow.
 *
 * The phone keeps the IndexedDB path: it has no backend by design, since the
 * server binds loopback and holds OneDrive credentials.
 */

export type ThumbSize = "medium" | "large";

/**
 * Disk is cheap in a way a browser origin's quota is not, so this is far larger
 * than the 400MB the IndexedDB cache allowed. At ~73KB a `large` thumbnail it
 * holds the whole 18,400-photo library several times over.
 */
const MAX_BYTES = Number(process.env.THUMB_CACHE_MAX_BYTES ?? 2 * 1024 * 1024 * 1024);
const EVICT_TARGET = 0.8;

/** Checking the whole directory on every write would serialise eviction against loading. */
const WRITES_BETWEEN_EVICTION_CHECKS = 200;
let writesSinceCheck = 0;

function thumbDir(size: ThumbSize): string {
  return join(dataDir(), "thumbs", size);
}

/**
 * OneDrive item ids contain characters that are legal in a filename on one
 * platform and not another (`!` most obviously), and they are long. Hashing
 * gives a fixed, portable name; nothing needs to map back from it.
 */
function fileFor(size: ThumbSize, itemId: string): string {
  const hash = createHash("sha256").update(itemId).digest("hex");
  return join(thumbDir(size), `${hash}.jpg`);
}

export async function readThumb(size: ThumbSize, itemId: string): Promise<Buffer | null> {
  const path = fileFor(size, itemId);
  try {
    const buf = await readFile(path);
    // Touch for LRU. Fire and forget: a lost timestamp costs eviction accuracy,
    // and awaiting it would put a write on the read path of every image.
    const now = new Date();
    void utimes(path, now, now).catch(() => {});
    return buf;
  } catch {
    return null;
  }
}

export async function writeThumb(size: ThumbSize, itemId: string, bytes: Buffer): Promise<void> {
  await mkdir(thumbDir(size), { recursive: true });
  await writeFile(fileFor(size, itemId), bytes);
  if (++writesSinceCheck >= WRITES_BETWEEN_EVICTION_CHECKS) {
    writesSinceCheck = 0;
    void evictIfNeeded().catch(() => {});
  }
}

/** Byte size of a cached thumbnail, or null when it is not cached. */
export async function thumbSize(size: ThumbSize, itemId: string): Promise<number | null> {
  try {
    return (await stat(fileFor(size, itemId))).size;
  } catch {
    return null;
  }
}

interface Entry {
  path: string;
  bytes: number;
  used: number;
}

async function entries(): Promise<Entry[]> {
  const all: Entry[] = [];
  for (const size of ["medium", "large"] as ThumbSize[]) {
    let names: string[];
    try {
      names = await readdir(thumbDir(size));
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(thumbDir(size), name);
      try {
        const s = await stat(path);
        all.push({ path, bytes: s.size, used: s.mtimeMs });
      } catch {
        // Raced with an eviction; it is gone either way.
      }
    }
  }
  return all;
}

/** Least-recently-used eviction, by file mtime. */
export async function evictIfNeeded(): Promise<void> {
  const all = await entries();
  let total = all.reduce((n, e) => n + e.bytes, 0);
  if (total <= MAX_BYTES) return;

  const target = MAX_BYTES * EVICT_TARGET;
  all.sort((a, b) => a.used - b.used);
  for (const entry of all) {
    if (total <= target) break;
    try {
      await unlink(entry.path);
      total -= entry.bytes;
    } catch {
      // Already gone, or in use; either way stop counting it.
    }
  }
}

export async function cacheStats(): Promise<{ count: number; bytes: number }> {
  const all = await entries();
  return { count: all.length, bytes: all.reduce((n, e) => n + e.bytes, 0) };
}
