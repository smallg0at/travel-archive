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

/**
 * `full` is the original file rather than a rendered thumbnail. It shares this
 * store because the lightbox had no cache at any layer — every open cost a
 * Graph 302 plus a 4.4MB download, measured at ~1.6s — and because the phone
 * will eventually want originals available offline too.
 */
export type ThumbSize = "medium" | "large" | "full";

const SIZES: ThumbSize[] = ["medium", "large", "full"];

/**
 * Disk is cheap in a way a browser origin's quota is not, so this is far larger
 * than the 400MB the IndexedDB cache allowed. At ~73KB a `large` thumbnail it
 * holds the whole 18,400-photo library several times over.
 */
const MAX_BYTES = Number(process.env.THUMB_CACHE_MAX_BYTES ?? 2 * 1024 * 1024 * 1024);

/**
 * Originals get their own budget rather than sharing one.
 *
 * At ~4.4MB each against ~73KB for a `large`, a few hundred lightbox opens
 * would otherwise evict tens of thousands of thumbnails — the cheap, hot
 * things thrown out to hold the expensive, cold ones.
 */
const MAX_FULL_BYTES = Number(process.env.PHOTO_CACHE_MAX_BYTES ?? 4 * 1024 * 1024 * 1024);
const EVICT_TARGET = 0.8;

/**
 * Supplies the files eviction must not touch.
 *
 * Injected rather than imported: the pin list is derived from the archive index
 * by the sync job, and this module must not depend upward on that. Unset means
 * nothing is protected, which is correct before any pin exists.
 */
let protectedProvider: (() => Promise<Set<string>>) | null = null;

export function setProtectedProvider(fn: () => Promise<Set<string>>): void {
  protectedProvider = fn;
}

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
  return join(thumbDir(size), `${hash}.bin`);
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
    void (async () => evictIfNeeded(await protectedProvider?.()))().catch(() => {});
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

async function entries(sizes: ThumbSize[] = SIZES): Promise<Entry[]> {
  const all: Entry[] = [];
  for (const size of sizes) {
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

/**
 * Least-recently-used eviction, by file mtime. Thumbnails and originals are
 * budgeted separately — see MAX_FULL_BYTES.
 *
 * **Pinned items are never evicted.** A pin is the user saying "keep this on
 * this device"; browsing one large unpinned month would otherwise quietly
 * discard the trip they asked to keep, and they would only find out offline.
 */
export async function evictIfNeeded(protectedFiles?: Set<string>): Promise<void> {
  await evictGroup(["medium", "large"], MAX_BYTES, protectedFiles);
  await evictGroup(["full"], MAX_FULL_BYTES, protectedFiles);
}

async function evictGroup(sizes: ThumbSize[], cap: number, protectedFiles?: Set<string>): Promise<void> {
  const all = await entries(sizes);

  // Pinned files count towards the budget but are never the ones deleted.
  // Excluding them from the total instead was wrong: with 4,685 of 5,767 files
  // pinned, 386MB of cache measured as 70MB and nothing was ever evicted, so
  // the cap silently stopped applying.
  let total = all.reduce((n, e) => n + e.bytes, 0);
  if (total <= cap) return;

  const evictable = all.filter((e) => !protectedFiles?.has(e.path)).sort((a, b) => a.used - b.used);
  const target = cap * EVICT_TARGET;
  for (const entry of evictable) {
    if (total <= target) break;
    try {
      await unlink(entry.path);
      total -= entry.bytes;
    } catch {
      // Already gone, or in use; either way stop counting it.
    }
  }
  // Pinning more than the cap allows is legitimate — the user asked for it —
  // so falling short of the target here is not an error.
}

/**
 * Cached, because this walks the whole directory and `stat`s every file — 5,767
 * of them here, measured at most of a 2,773ms status check. The status endpoint
 * is polled, and a figure shown in Settings does not need to be to the byte.
 */
const STATS_TTL_MS = 30_000;
const statsCache = new Map<string, { at: number; value: { count: number; bytes: number } }>();

export async function cacheStats(
  sizes: ThumbSize[] = SIZES,
): Promise<{ count: number; bytes: number }> {
  const key = sizes.join(",");
  const hit = statsCache.get(key);
  if (hit && Date.now() - hit.at < STATS_TTL_MS) return hit.value;

  const all = await entries(sizes);
  const value = { count: all.length, bytes: all.reduce((n, e) => n + e.bytes, 0) };
  statsCache.set(key, { at: Date.now(), value });
  return value;
}

/** The on-disk path for an item, so callers can mark it protected from eviction. */
export function pathFor(size: ThumbSize, itemId: string): string {
  return fileFor(size, itemId);
}
