/**
 * Thumbnail bytes: the in-flight map, the disk cache, and warming.
 *
 * Extracted from `serve.ts` — the memory here is process-wide state
 * (`inFlight`, `warming`, `warmGeneration`) rather than request-local, which is
 * easier to reason about in a module that does nothing else.
 */

import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getCachedAccessToken } from "../auth.js";
import { downloadPhotoBuffer, downloadThumbnailBuffer } from "../graph.js";
import { dataFile } from "../paths.js";
import { thumbSize, writeThumb, type ThumbSize } from "../thumbStore.js";

/**
 * Fetches one image and caches it, collapsing concurrent requests for the same
 * one.
 *
 * Without this, a browser asking for the same thumbnail twice — easy during a
 * fast scroll, and certain once warming runs alongside rendering — makes two
 * Graph round trips for bytes that are about to be identical.
 */
const inFlight = new Map<string, Promise<Buffer | null>>();

/**
 * Only the most recent warm run may continue.
 *
 * Warming competes with the app's own Graph calls — the month shards it needs
 * before it can render anything at all — and measurably so: with a previous
 * run still going, loading a trip took 5,745ms of shard fetches against
 * 4,021ms with the warm loop dead, one shard inflating from 1,335ms to
 * 3,313ms. A reload should supersede whatever the last page load started
 * rather than adding to it.
 */
let warmGeneration = 0;

/**
 * What the latest `/thumb/warm` is doing, for `/health` — the app's Activity
 * page shows it. Warming is not a job (it does not take the archive lock and
 * must not block one), so it has no record of its own; each request replaces
 * this, as it replaces the work.
 */
export interface Warming {
  size: ThumbSize;
  total: number;
  done: number;
  failed: number;
  startedAt: string;
  finishedAt: string | null;
}
let warming: Warming | null = null;
/** How long a finished warm stays in `/health`, so a page polling every 15 s still sees how it ended. */
const WARMING_SHOWN_FOR_MS = 10 * 60_000;

export function warmingStatus(): Warming | null {
  if (warming?.finishedAt && Date.now() - Date.parse(warming.finishedAt) > WARMING_SHOWN_FOR_MS) return null;
  return warming;
}

export function fetchAndCache(size: ThumbSize, itemId: string): Promise<Buffer | null> {
  const key = `${size}:${itemId}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const work = (async () => {
    const token = await getCachedAccessToken();
    if (!token) return null;
    const bytes =
      size === "full"
        ? await downloadPhotoBuffer(token, itemId)
        : await downloadThumbnailBuffer(token, itemId, size);
    if (bytes) await writeThumb(size, itemId, bytes);
    return bytes;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, work);
  return work;
}

/** Deletes cached files of these sizes, skipping anything pinned. */
export async function clearCache(sizes: ThumbSize[], keep: Set<string>): Promise<number> {
  let removed = 0;
  for (const size of sizes) {
    const dir = dataFile(`thumbs/${size}`);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (keep.has(path)) continue;
      try {
        await unlink(path);
        removed++;
      } catch {
        /* already gone */
      }
    }
  }
  return removed;
}

/** JPEG and PNG are the only things this library holds; sniffed, not assumed. */
export function imageType(bytes: Buffer): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  return "image/jpeg";
}

/**
 * Starts warming the ids that are not on disk yet, and answers immediately.
 *
 * A cold thumbnail costs a Graph round trip — ~2.7s — and a browser will only
 * hold about six connections to one host on HTTP/1.1, so 169 requests issued
 * during one fast scroll took 28 seconds to drain, with a p90 of 22s. The
 * server itself is not the constraint: 30 requests fired straight at it
 * finished in 2.2s, 13.6 per second. So the answer is not faster requests but
 * earlier ones.
 *
 * Concurrency 4, not 8: this runs while the user is browsing, and the thing it
 * competes with is the app's own Graph traffic, so being greedy here slows down
 * the very load it is meant to help.
 */
export async function beginWarm(
  size: ThumbSize,
  ids: string[],
): Promise<{ requested: number; alreadyCached: number; warming: number }> {
  const missing: string[] = [];
  for (const id of ids) if ((await thumbSize(size, id)) === null) missing.push(id);

  const answer = { requested: ids.length, alreadyCached: ids.length - missing.length, warming: missing.length };

  const generation = ++warmGeneration;
  if (missing.length === 0) return answer;

  const record: Warming = {
    size,
    total: missing.length,
    done: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  warming = record;
  void (async () => {
    let next = 0;
    const worker = async () => {
      while (next < missing.length && generation === warmGeneration) {
        const id = missing[next++];
        const bytes = await fetchAndCache(size, id).catch(() => null);
        if (bytes) record.done++;
        else record.failed++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, missing.length) }, worker));
    record.finishedAt = new Date().toISOString();
  })();
  return answer;
}
