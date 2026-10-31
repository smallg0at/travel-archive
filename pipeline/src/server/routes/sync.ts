/**
 * The sync job, its pins, and the thumbnail cache it fills.
 */

import { cachedSync, checkSync, protectedPaths, runSync, startSyncChecks, type ConflictChoice } from "../../jobs/sync.js";
import { pins, removePin, setPin, writeSync } from "../../syncStore.js";
import { invalidateCacheStats, thumbSize } from "../../thumbStore.js";
import { json, readJsonBody, refuseIfBusy, type Route } from "../http.js";
import * as jobs from "../jobs.js";
import { beginWarm, clearCache, fetchAndCache, type ThumbSize } from "../media.js";
import type { RouteContext } from "./context.js";

/** The routes, in the order they were written; the dispatcher keeps looking after a method mismatch. */
export const syncRoutes = (_ctx: RouteContext): Route[] => [
  /**
   * `?cached=1` answers from disk with no Graph call, so Settings can paint
   * immediately; the page then asks again without it to get a checked answer.
   * The two differ only in `stale`.
   */
  [
    /^\/sync\/status$/,
    "GET",
    async (req, res) => {
      const cached = new URL(req.url ?? "", "http://localhost").searchParams.has("cached");
      json(res, 200, cached ? await cachedSync() : await checkSync());
    },
  ],
  /**
   * Run a sync. `checkOnly` reports without downloading (the automatic checks
   * call `checkSync` directly, not this — see `startSyncChecks`); `resolve` settles a conflict and is required when both
   * sides changed, since this never picks for the user.
   */
  [
    /^\/sync$/,
    "POST",
    async (req, res) => {
      if (refuseIfBusy(res)) return;
      const body = await readJsonBody<{ checkOnly?: boolean; resolve?: ConflictChoice }>(req);
      const opts = { checkOnly: body.checkOnly === true, resolve: body.resolve };
      json(
        res,
        202,
        jobs.start({
          kind: "sync",
          run: (onProgress, signal) => runSync(opts, onProgress, signal, fetchAndCache),
        }),
      );
    },
  ],

  /** What the reader keeps on this device, rather than leaving evictable. */
  [/^\/sync\/pins$/, "GET", async (_req, res) => json(res, 200, { pins: await pins() })],
  [
    /^\/sync\/pins$/,
    "POST",
    async (req, res) => {
      const body = await readJsonBody<{ kind?: "trip" | "month"; id?: string; originals?: boolean; pinned?: boolean }>(req);
      if (!body.kind || !body.id) return json(res, 400, { error: "kind and id are required" });
      const next =
        body.pinned === false
          ? await removePin(body.kind, body.id)
          : await setPin({ kind: body.kind, id: body.id, originals: body.originals === true });
      json(res, 200, { pins: next });
    },
  ],
  /**
   * Drop cached media. Pinned items are excluded — clearing a cache should not
   * silently undo "keep this on my device".
   */
  [
    /^\/sync\/clear$/,
    "POST",
    async (req, res) => {
      const body = await readJsonBody<{ category?: "thumbnails" | "originals" }>(req);
      const sizes: ThumbSize[] = body.category === "originals" ? ["full"] : ["medium", "large"];
      const removed = await clearCache(sizes, await protectedPaths());
      // Otherwise Settings redraws the figures it just invalidated, from a memo
      // that outlives the files by up to 30s.
      invalidateCacheStats();
      json(res, 200, { removed });
    },
  ],

  [
    /^\/sync\/settings$/,
    "POST",
    async (req, res) => {
      const body = await readJsonBody<{ autoSyncOnLaunch?: boolean; intervalMinutes?: number }>(req);
      const patch: Record<string, unknown> = {};
      if (typeof body.autoSyncOnLaunch === "boolean") patch.autoSyncOnLaunch = body.autoSyncOnLaunch;
      if (typeof body.intervalMinutes === "number") patch.intervalMinutes = Math.max(0, body.intervalMinutes);
      json(res, 200, await writeSync(patch));
    },
  ],
  /**
   * Fill the cache ahead of the browser.
   *
   * This is the actual fix for fast scrolling, and the measurement says why.
   * A cold thumbnail costs a Graph round trip — ~2.7s — and a browser will only
   * hold about six connections to one host on HTTP/1.1, so 169 requests issued
   * during one fast scroll took 28 seconds to drain, with a p90 of 22s. The
   * server itself is not the constraint: 30 requests fired straight at it
   * finished in 2.2s, 13.6 per second.
   *
   * So the answer is not faster requests but earlier ones. Warming at a
   * concurrency the browser cannot reach turns every later request into a 24ms
   * read from disk, at which point the six-connection limit stops mattering.
   *
   * Returns immediately with what it will do; the work continues in the
   * background. Already-cached ids are skipped without a Graph call.
   */
  [
    /^\/thumb\/warm$/,
    "POST",
    async (req, res) => {
      const body = await readJsonBody<{ size?: string; ids?: string[] }>(req);
      const size = (body.size === "medium" || body.size === "full" ? body.size : "large") as ThumbSize;
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 20000) : [];
      json(res, 202, await beginWarm(size, ids));
    },
  ],
  /**
   * Byte sizes for thumbnails already on disk, for callers that need to compare
   * against something they produced — the PDF export decides whether its
   * re-encode is actually smaller than the original. One request rather than a
   * HEAD per image, which at 1,292 images is the difference between a round
   * trip and a thousand of them. Never fetches: absent ids are simply omitted.
   */
  [
    /^\/thumb\/sizes$/,
    "POST",
    async (req, res) => {
      const body = await readJsonBody<{ size?: string; ids?: string[] }>(req);
      const size = body.size === "medium" ? "medium" : "large";
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 5000) : [];
      const sizes: Record<string, number> = {};
      await Promise.all(
        ids.map(async (id) => {
          const bytes = await thumbSize(size as ThumbSize, id);
          if (bytes !== null) sizes[id] = bytes;
        }),
      );
      json(res, 200, { sizes });
    },
  ],
];
