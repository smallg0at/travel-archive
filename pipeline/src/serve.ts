import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { cachedSync, checkSync, protectedPaths, runSync, startSyncChecks, type ConflictChoice } from "./jobs/sync.js";
import { pins, readSync, removePin, setPin, writeSync } from "./syncStore.js";
import { readFile } from "node:fs/promises";
import { dataFile } from "./paths.js";
import { downloadPhotoBuffer, downloadThumbnailBuffer, fetchItemDownloadUrl } from "./graph.js";
import {
  invalidateCacheStats,
  readThumb,
  setProtectedProvider,
  thumbSize,
  writeThumb,
  type ThumbSize,
} from "./thumbStore.js";
import type { AppPrefs, ArchiveIndexFile, ArchiveStatus, JobRecord } from "@travel-archive/shared";
import { readPrefs, writePrefs } from "./prefsStore.js";
import { env } from "./env.js";
import { getCachedAccessToken } from "./auth.js";
import { loadIndex } from "./archiveStore.js";
import { configStatus, isWritableKey, saveConfig } from "./configStore.js";
import { initProxyDispatcher } from "./proxy.js";
import { planAnalyze, runAnalyze } from "./jobs/analyze.js";
import {
  autoSubmitDue,
  autoSubmitStatus,
  collectAnalyzeBatches,
  listAnalyzeBatches,
  locateAhead,
  locateAheadDue,
  readyToCollect,
  stopAutoSubmit,
  submitAnalyzeBatch,
} from "./jobs/analyzeBatch.js";
import { resolveRange, runScan, type ScanMode } from "./jobs/scan.js";
import { planOrganize, runOrganize } from "./jobs/organize.js";
import { editDay, type DayPatch } from "./jobs/dayEdit.js";
import { setPhotoTakenAt, setPhotosTakenAt } from "./jobs/photoTime.js";
import { defineTrip, deleteTrip, renameTrip, runTrip } from "./jobs/trip.js";
import { dismissTripSuggestion, listTripSuggestions } from "./jobs/tripSuggest.js";
import { parseTranslateOptions, planTranslate, runTranslate } from "./jobs/translate.js";
import * as jobs from "./server/jobs.js";

/**
 * A local HTTP server so the app can start pipeline work and watch it happen,
 * instead of the user running terminal commands and reading nothing until they
 * finish.
 *
 *   npm run --workspace pipeline serve
 *
 * **Bound to 127.0.0.1, never 0.0.0.0.** It holds OneDrive credentials and
 * starts jobs with no authentication of its own, so it must not be reachable
 * from the network. That constraint is also the reason the phone is a read-only
 * client: it reads the archive from OneDrive directly and never talks to this.
 *
 * Progress is Server-Sent Events rather than a WebSocket: it only ever flows
 * one way, `EventSource` is built into the browser, and it reconnects by
 * itself. `GET /jobs/:id` returns the same record a stream frame carries, so a
 * page reloaded mid-run reattaches by polling once and then subscribing.
 */

const ALLOWED_ORIGINS = new Set([
  // Vite dev and preview.
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  // The desktop shell, which serves the built app on its own port so it does
  // not compete with a preview server. Without this the window loads and the
  // archive renders from OneDrive, but every job request fails CORS and
  // generation silently looks unavailable.
  "http://localhost:17923",
  "http://127.0.0.1:17923",
]);

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[]) => Promise<void> | void;

function cors(req: IncomingMessage, res: ServerResponse): void {
  // **Always `Vary: Origin`, even with no Origin on the request.**
  //
  // Thumbnails are served `immutable, max-age=31536000`. Without this header a
  // response fetched *without* CORS is cached with no record that CORS mattered,
  // and the browser then satisfies a later CORS request from that same entry —
  // which has no `Access-Control-Allow-Origin`, so the check fails and the image
  // dies instantly. That presented as "some images load and some do not",
  // splitting on whichever URLs happened to be fetched no-CORS first, and it
  // survives clearing the *server's* cache because the poisoned copy is in the
  // browser's.
  res.setHeader("Vary", "Origin");
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Nothing this API accepts is large; a body this big is a mistake or an abuse.
    if (size > 1_000_000) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T;
}

/** Refuses a second job rather than letting two writers race over index.json. */
function refuseIfBusy(res: ServerResponse): boolean {
  const running = jobs.runningJob();
  if (!running) return false;
  json(res, 409, { error: "A job is already running", job: running });
  return true;
}

/**
 * Totals for the Settings page, from the local mirror.
 *
 * This used to call `loadIndex(token)`, which downloads the whole of
 * `index.json` from OneDrive — **2.5MB, measured at 1,043-1,762ms** — to report
 * five counts. `/archive/index` above already established that the mirror holds
 * identical bytes because this server is the only writer; the same reasoning
 * applies here, and reading it locally parses in **8-11ms**.
 *
 * `signedIn` still comes from the token, since it describes the session rather
 * than the archive, and it is a cache lookup (~2ms) rather than a round trip.
 * The Graph path stays as the fallback for a machine that has never scanned.
 */
async function archiveStatus(): Promise<ArchiveStatus> {
  const token = await getCachedAccessToken();
  if (!token) {
    return {
      signedIn: false,
      schemaVersion: 0,
      months: [],
      totals: { photos: 0, analyzable: 0, analyzed: 0, days: 0, sections: 0 },
    };
  }

  const local = await readLocalJson("index.json");
  const index = local ? (JSON.parse(local) as ArchiveIndexFile) : await loadIndex(token);
  const months = index.months.map((m) => ({
    month: m.month,
    photoCount: m.photoCount,
    representativeCount: m.representativeCount,
    analyzedCount: m.analyzedCount,
  }));

  return {
    signedIn: true,
    schemaVersion: index.schemaVersion,
    months,
    totals: {
      photos: months.reduce((n, m) => n + m.photoCount, 0),
      analyzable: months.reduce((n, m) => n + m.representativeCount, 0),
      analyzed: months.reduce((n, m) => n + m.analyzedCount, 0),
      days: index.sections.reduce((n, s) => n + s.days.length, 0),
      sections: index.sections.length,
    },
  };
}

/**
 * One SSE stream per client. The current record is sent immediately so a late
 * subscriber is not staring at a blank panel until the next progress tick, and
 * the stream closes itself once the job reaches a terminal state — otherwise
 * EventSource would reconnect forever to a job that finished.
 */
function streamJob(res: ServerResponse, id: string): void {
  const record = jobs.getJob(id);
  if (!record) return json(res, 404, { error: "No such job" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Node buffers small writes; without this a proxy or the client may hold
    // frames back until enough bytes accumulate.
    "X-Accel-Buffering": "no",
  });

  const send = (current: JobRecord) => {
    res.write(`data: ${JSON.stringify(current)}\n\n`);
    if (current.status !== "running" && current.status !== "queued") {
      unsubscribe();
      clearInterval(heartbeat);
      res.end();
    }
  };

  // A comment frame keeps intermediaries from timing out a quiet stream — an
  // analyze job can spend a minute inside one slow month without emitting.
  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
  const unsubscribe = jobs.subscribe(id, send);

  res.on("close", () => {
    unsubscribe();
    clearInterval(heartbeat);
  });

  send(record);
}

/**
 * Fetches one image and caches it, collapsing concurrent requests for the same
 * one.
 *
 * Without this, a browser asking for the same thumbnail twice — easy during a
 * fast scroll, and certain once warming runs alongside rendering — makes two
 * Graph round trips for bytes that are about to be identical.
 */
/**
 * Reads a file from the archive mirror without parsing it — the app is going to
 * parse it anyway, and `index.json` is 2.4MB.
 */
async function readLocalJson(relative: string): Promise<string | null> {
  try {
    return await readFile(dataFile(relative), "utf-8");
  } catch {
    return null;
  }
}

function sendJsonText(res: ServerResponse, body: string): void {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    // Not immutable: a job rewrites these, and the app must see it on reload.
    "Cache-Control": "no-cache",
  });
  res.end(body);
}

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
interface Warming {
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

function warmingStatus(): Warming | null {
  if (warming?.finishedAt && Date.now() - Date.parse(warming.finishedAt) > WARMING_SHOWN_FOR_MS) return null;
  return warming;
}

function fetchAndCache(size: ThumbSize, itemId: string): Promise<Buffer | null> {
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
async function clearCache(sizes: ThumbSize[], keep: Set<string>): Promise<number> {
  const { readdir, unlink } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { dataFile } = await import("./paths.js");
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
function imageType(bytes: Buffer): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  return "image/jpeg";
}

const routes: [RegExp, string, Handler][] = [
  [
    /^\/health$/,
    "GET",
    async (_req, res) => {
      const token = await getCachedAccessToken();
      json(res, 200, {
        ok: true,
        signedIn: token !== null,
        running: jobs.runningJob(),
        lastFinished: jobs.lastFinished(),
        warming: warmingStatus(),
      });
    },
  ],
  [/^\/archive\/status$/, "GET", async (_req, res) => json(res, 200, await archiveStatus())],

  /**
   * The generation settings, so a fresh install can be configured from the app
   * instead of being told to hand-write a `.env`.
   *
   * **The response never carries a key back out.** `keys` reports only whether
   * each one is set: a value that arrives here should be write-only, and a
   * readable-secrets endpoint on a server with no authentication of its own is
   * not worth the convenience.
   */
  [/^\/config$/, "GET", (_req, res) => json(res, 200, configStatus())],
  [
    /^\/config$/,
    "POST",
    async (req, res) => {
      const body = await readJsonBody<Record<string, unknown>>(req);
      const patch: Record<string, string> = {};
      for (const [key, value] of Object.entries(body)) {
        if (typeof value !== "string") continue;
        // Unknown names are refused rather than ignored, so a typo in the form
        // is a visible error instead of a setting that silently never applies.
        if (!isWritableKey(key)) return json(res, 400, { error: `${key} is not a configurable setting` });
        patch[key] = value;
      }
      try {
        json(res, 200, await saveConfig(patch));
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    },
  ],

  /**
   * The app's interface preferences — theme, thumbnail density, sidebar width,
   * content language, which nav groups are open.
   *
   * Nothing to do with the archive: no lock, no upload, no schema version. It
   * is here because this process is the one thing that is running whenever the
   * desktop shell is *and* writes to a disk that survives the renderer being
   * killed, which `localStorage` demonstrably did not — see prefsStore.ts.
   *
   * The app keeps its own `localStorage` copy regardless and falls back to it
   * when nothing answers here, because a browser reading OneDrive directly has
   * no server at all and must still remember a theme.
   */
  [/^\/prefs$/, "GET", async (_req, res) => json(res, 200, await readPrefs())],
  [
    /^\/prefs$/,
    "POST",
    async (req, res) => {
      // Validation is `writePrefs`'s, not this route's: the field rules belong
      // beside the file they are written to, and the app is not the only thing
      // that could post here.
      const body = await readJsonBody<Partial<AppPrefs>>(req);
      json(res, 200, await writePrefs(body));
    },
  ],

  /**
   * The archive metadata, from the local mirror.
   *
   * The app read `index.json` and every month shard straight from OneDrive on
   * every load — a **2.4MB** download for the index alone, measured between
   * 1,237ms and 3,289ms, and strictly blocking: the months a trip spans are
   * not known until it lands, so nothing else can even start.
   *
   * Every pipeline run already writes the identical content to `data/`, so the
   * bytes were sitting on the disk the whole time. Reading them locally is a
   * few milliseconds.
   *
   * Safe because the writer is singular: this server is the only thing that
   * ever writes the archive, and the phone is read-only by design. The mirror
   * can only be stale if the pipeline was run on a *different* machine, in
   * which case a `scan` here brings it back. The app still falls back to Graph
   * when no server is running, which is the phone's normal path.
   */
  [
    /^\/archive\/index$/,
    "GET",
    async (_req, res) => {
      const local = await readLocalJson("index.json");
      if (!local) return json(res, 404, { error: "No local index.json — run scan" });
      sendJsonText(res, local);
    },
  ],
  /** The searchable text of the whole archive — see jobs/searchIndex.ts. */
  [
    /^\/archive\/search$/,
    "GET",
    async (_req, res) => {
      const local = await readLocalJson("search.json");
      if (!local) return json(res, 404, { error: "No local search.json — run organize" });
      sendJsonText(res, local);
    },
  ],
  /** Where the library has been, for the home page — see jobs/homeIndex.ts. */
  [
    /^\/archive\/home$/,
    "GET",
    async (_req, res) => {
      const local = await readLocalJson("home.json");
      if (!local) return json(res, 404, { error: "No local home.json — run organize" });
      sendJsonText(res, local);
    },
  ],
  [
    /^\/archive\/shard\/(\d{4}-\d{2})$/,
    "GET",
    async (_req, res, [month]) => {
      const local = await readLocalJson(`photos/${month}.json`);
      if (!local) return json(res, 404, { error: `No local shard for ${month}` });
      sendJsonText(res, local);
    },
  ],
  /**
   * The second language's files, from the mirror, for the same reason as the
   * two above. The language pattern admits only a code — no dots, no slashes —
   * so the path cannot be walked out of `i18n/`.
   */
  [
    /^\/archive\/i18n\/([a-z]{2}(?:-[A-Za-z]{2,4})?)\/index$/,
    "GET",
    async (_req, res, [lang]) => {
      const local = await readLocalJson(`i18n/${lang}/index.json`);
      if (!local) return json(res, 404, { error: `No local ${lang} text` });
      sendJsonText(res, local);
    },
  ],
  [
    /^\/archive\/i18n\/([a-z]{2}(?:-[A-Za-z]{2,4})?)\/shard\/(\d{4}-\d{2})$/,
    "GET",
    async (_req, res, [lang, month]) => {
      const local = await readLocalJson(`i18n/${lang}/photos/${month}.json`);
      if (!local) return json(res, 404, { error: `No local ${lang} captions for ${month}` });
      sendJsonText(res, local);
    },
  ],

  /**
   * A thumbnail, from disk when it has been fetched before.
   *
   * The app used to mint a short-lived CDN link per image through a Graph
   * `$batch` and cache the bytes in IndexedDB. That is per-browser, vanishes
   * when a privacy-minded browser clears site data, and degrades silently when
   * it does. Serving from here instead makes the cache shared, durable and
   * independent of the browser.
   *
   * The URL is keyed on the item id and never changes, which is what lets it
   * be marked immutable — the CDN links it replaces were different every time,
   * so ordinary HTTP caching could never help. A cached image therefore costs
   * neither a Graph call nor a request to this server.
   */
  [
    /^\/thumb\/(medium|large|full)\/(.+)$/,
    "GET",
    async (_req, res, [size, encodedId]) => {
      const itemId = decodeURIComponent(encodedId);
      const sendImage = (bytes: Buffer) => {
        res.writeHead(200, {
          "Content-Type": imageType(bytes),
          "Content-Length": bytes.length,
          // No CORS header here: cors() has already set it with setHeader, and
          // headers passed to writeHead take precedence — repeating it would
          // overwrite a correct origin with an empty one.
          "Cache-Control": "public, max-age=31536000, immutable",
        });
        res.end(bytes);
      };

      const cached = await readThumb(size as ThumbSize, itemId);
      if (cached) return sendImage(cached);

      const bytes = await fetchAndCache(size as ThumbSize, itemId);
      if (!bytes) return json(res, 404, { error: "No image for that item, or not signed in" });
      sendImage(bytes);
    },
  ],

  /**
   * A video, streamed. The app points a `<video>` at this, and its range
   * requests are redirected to OneDrive — so only the part being watched
   * crosses the wire, the difference between a few MB and a 382MB original. A
   * 302 rather than a proxy because the pre-authenticated CDN URL already
   * speaks Range; this server never touches the bytes.
   */
  [
    /^\/video\/(.+)$/,
    "GET",
    async (_req, res, [encodedId]) => {
      const itemId = decodeURIComponent(encodedId);
      const token = await getCachedAccessToken();
      if (!token) return json(res, 404, { error: "Not signed in" });
      const url = await fetchItemDownloadUrl(token, itemId);
      if (!url) return json(res, 404, { error: "No video for that item" });
      res.writeHead(302, { Location: url, "Cache-Control": "no-store" });
      res.end();
    },
  ],


  /**
   * How the replica stands against OneDrive, plus what is pinned and what disk
   * it uses. Cheap: one eTag request, never a download.
   */
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

  /** Auto-sync on launch, and the optional timer. */
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

      const missing: string[] = [];
      for (const id of ids) if ((await thumbSize(size, id)) === null) missing.push(id);

      json(res, 202, { requested: ids.length, alreadyCached: ids.length - missing.length, warming: missing.length });

      // Deliberately after the response. Concurrency 4, not 8: this runs while
      // the user is browsing, and the thing it competes with is the app's own
      // Graph traffic, so being greedy here slows down the very load it is
      // meant to help.
      const generation = ++warmGeneration;
      if (missing.length === 0) return;
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
  [/^\/jobs$/, "GET", (_req, res) => json(res, 200, jobs.listJobs())],
  /** Newest first, including jobs from before the last restart — the Activity page's history. */
  [/^\/jobs\/history$/, "GET", async (_req, res) => json(res, 200, await jobs.jobHistory())],

  [
    /^\/jobs\/analyze\/plan$/,
    "POST",
    async (req, res) => {
      const body = await readJsonBody<{ from?: string; to?: string; limit?: number }>(req);
      const opts = {
        from: body.from ?? null,
        to: body.to ?? null,
        limit: body.limit ?? Number.MAX_SAFE_INTEGER,
      };
      json(res, 200, await planAnalyze(opts));
    },
  ],
  /**
   * Indexing, which the app previously had no way to trigger — Generate offered
   * only the three passes that cost money or depend on one that does, so adding
   * photos to OneDrive meant dropping to a terminal. Free: Graph listing only.
   */
  [
    /^\/jobs\/scan$/,
    "POST",
    async (req, res) => {
      if (refuseIfBusy(res)) return;
      const body = await readJsonBody<{ mode?: ScanMode; from?: string; to?: string }>(req);
      // Resolved on the server so that what "incremental" means lives next to
      // the deletion rule it interacts with, rather than in the page.
      const range = await resolveRange(body.mode ?? "full", { from: body.from ?? null, to: body.to ?? null });
      json(res, 202, jobs.start({ kind: "scan", run: (onProgress, signal) => runScan(range, onProgress, signal) }));
    },
  ],
  [
    /^\/jobs\/analyze$/,
    "POST",
    async (req, res) => {
      if (refuseIfBusy(res)) return;
      const body = await readJsonBody<{ from?: string; to?: string; limit?: number; batch?: boolean }>(req);
      const opts = {
        from: body.from ?? null,
        to: body.to ?? null,
        limit: body.limit ?? Number.MAX_SAFE_INTEGER,
      };
      // `batch`: submit to the Batch API at half price instead of captioning
      // now. The job ends at submission; the timer below collects the results.
      const run = body.batch
        ? (onProgress: Parameters<typeof runAnalyze>[1], signal: AbortSignal) => submitAnalyzeBatch(opts, onProgress, signal)
        : (onProgress: Parameters<typeof runAnalyze>[1], signal: AbortSignal) => runAnalyze(opts, onProgress, signal);
      json(res, 202, jobs.start<object>({ kind: "analyze", run }));
    },
  ],
  /** Whether the server is carrying a batch submit on by itself — `autoSubmit` in analyzeBatch.ts. Null when off. */
  [/^\/jobs\/analyze\/auto$/, "GET", async (_req, res) => json(res, 200, await autoSubmitStatus())],
  [
    /^\/jobs\/analyze\/auto\/stop$/,
    "POST",
    async (_req, res) => {
      // The state file belongs to a running submit or collect; cancelling a
      // submit stops the chain as well.
      if (refuseIfBusy(res)) return;
      await stopAutoSubmit();
      json(res, 200, { ok: true });
    },
  ],
  /** Merges finished batches now, rather than at the timer's next tick. */
  [
    /^\/jobs\/analyze\/collect$/,
    "POST",
    async (_req, res) => {
      if (refuseIfBusy(res)) return;
      const job = jobs.start({ kind: "collect", run: (onProgress, signal) => collectAnalyzeBatches(onProgress, signal) });
      // A collect from the page frees the queue just as the timer's does.
      checkBatchesAfter(job.id);
      json(res, 202, job);
    },
  ],
  /** Submitted batches and their state. Asks Google about open ones; spends nothing, takes no lock. */
  [/^\/jobs\/analyze\/batches$/, "GET", async (_req, res) => json(res, 200, await listAnalyzeBatches())],
  /**
   * What an organize run would do, spending nothing. Same shape as the analyze
   * plan, and for the same reason: this is the step that costs money, so it
   * should be possible to look before paying.
   */
  [
    /^\/jobs\/organize\/plan$/,
    "POST",
    async (req, res) => {
      const body = await readJsonBody<{ only?: string; force?: boolean; days?: string[] }>(req);
      json(
        res,
        200,
        await planOrganize({ only: body.only ?? null, force: body.force === true, days: body.days ?? null }),
      );
    },
  ],
  [
    /^\/jobs\/organize$/,
    "POST",
    async (req, res) => {
      if (refuseIfBusy(res)) return;
      const body = await readJsonBody<{ only?: string; force?: boolean; days?: string[] }>(req);
      const opts = { only: body.only ?? null, force: body.force === true, days: body.days ?? null };
      json(
        res,
        202,
        jobs.start({ kind: "organize", run: (onProgress, signal) => runOrganize(opts, onProgress, signal) }),
      );
    },
  ],
  [
    /^\/jobs\/trip$/,
    "POST",
    async (req, res) => {
      if (refuseIfBusy(res)) return;
      const body = await readJsonBody<{
        startDate?: string;
        endDate?: string;
        name?: string;
        notes?: string;
        documents?: { name: string; text: string }[];
        allowMissingSummaries?: boolean;
      }>(req);

      if (!body.startDate || !body.endDate) {
        return json(res, 400, { error: "startDate and endDate are required (the range is chosen, not inferred)" });
      }
      const opts = {
        startDate: body.startDate,
        endDate: body.endDate,
        name: body.name?.trim() || null,
        notes: body.notes ?? null,
        documents: body.documents ?? [],
        allowMissingSummaries: body.allowMissingSummaries === true,
      };
      json(res, 202, jobs.start({ kind: "trip", run: (onProgress, signal) => runTrip(opts, onProgress, signal) }));
    },
  ],
  /**
   * A trip renamed or deleted from its page. Synchronous like the day editor:
   * one write, nothing spent. Delete keeps every day and photo — see deleteTrip.
   */
  [
    /^\/trips\/([^/]+)\/rename$/,
    "POST",
    async (req, res, [id]) => {
      if (refuseIfBusy(res)) return;
      const body = await readJsonBody<{ name?: string }>(req);
      try {
        await renameTrip(decodeURIComponent(id), body.name ?? "");
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    },
  ],
  /**
   * Trips proposed from where the nights were spent (jobs/tripSuggest.ts).
   * Read-only; accepting one defines it without a narrative, which costs
   * nothing either.
   */
  [
    /^\/trips\/suggestions$/,
    "GET",
    async (_req, res) => {
      try {
        json(res, 200, await listTripSuggestions());
      } catch (err) {
        json(res, 500, { error: (err as Error).message });
      }
    },
  ],
  [
    /^\/trips\/suggestions\/dismiss$/,
    "POST",
    async (req, res) => {
      const body = await readJsonBody<{ startDate?: string; endDate?: string }>(req);
      if (!body.startDate || !body.endDate) return json(res, 400, { error: "startDate and endDate are required" });
      await dismissTripSuggestion(body.startDate, body.endDate);
      json(res, 200, { ok: true });
    },
  ],
  [
    /^\/trips\/define$/,
    "POST",
    async (req, res) => {
      if (refuseIfBusy(res)) return;
      const body = await readJsonBody<{ startDate?: string; endDate?: string; name?: string }>(req);
      try {
        json(res, 200, await defineTrip(body.startDate ?? "", body.endDate ?? "", body.name ?? ""));
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    },
  ],
  [
    /^\/trips\/([^/]+)\/delete$/,
    "POST",
    async (_req, res, [id]) => {
      if (refuseIfBusy(res)) return;
      try {
        await deleteTrip(decodeURIComponent(id));
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    },
  ],

  /**
   * Existing text into a second language. The plan spends nothing; the run is
   * text-only model calls, far cheaper than analyze, but still the owner's to
   * start — never a side effect of another job.
   */
  [
    /^\/jobs\/translate\/plan$/,
    "POST",
    async (req, res) => {
      const opts = parseTranslateOptions(await readJsonBody<{ lang?: string; scope?: string; only?: string }>(req));
      if ("error" in opts) return json(res, 400, opts);
      json(res, 200, await planTranslate(opts));
    },
  ],
  [
    /^\/jobs\/translate$/,
    "POST",
    async (req, res) => {
      if (refuseIfBusy(res)) return;
      const opts = parseTranslateOptions(await readJsonBody<{ lang?: string; scope?: string; only?: string }>(req));
      if ("error" in opts) return json(res, 400, opts);
      json(res, 202, jobs.start({ kind: "translate", run: (onProgress, signal) => runTranslate(opts, onProgress, signal) }));
    },
  ],

  /**
   * The owner's note for a day, and their corrections to what the model wrote.
   *
   * Not a job: it spends nothing and finishes in one write, so it answers
   * synchronously rather than handing back a job to poll. It still takes the
   * archive lock — the app is a reader and the server is the only writer.
   */
  [
    /^\/days\/(\d{4}-\d{2}-\d{2})$/,
    "POST",
    async (req, res, [date]) => {
      if (refuseIfBusy(res)) return;
      const body = await readJsonBody<DayPatch>(req);
      try {
        json(res, 200, await editDay(date, body));
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    },
  ],

  /**
   * The day and time a photo was taken, corrected by hand.
   *
   * A rename in OneDrive, not a stored override — see `renameForTakenAt`. Like
   * the day editor it answers synchronously and takes the archive lock; unlike
   * it, it writes to the photo library itself, so it refuses rather than
   * guesses whenever the filename is not the photo's real source of truth.
   */
  [
    /^\/photos\/([^/]+)\/taken$/,
    "POST",
    async (req, res, [id]) => {
      if (refuseIfBusy(res)) return;
      const body = await readJsonBody<{ month?: string; date?: string; time?: string | null }>(req);
      if (!body.month || !body.date) {
        return json(res, 400, { error: "month and date are required" });
      }
      try {
        json(res, 200, await setPhotoTakenAt(decodeURIComponent(id), {
          month: body.month,
          date: body.date,
          time: body.time?.trim() ? body.time.trim() : null,
        }));
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    },
  ],

  /**
   * Many photos at once — see `setPhotosTakenAt` for why this is the fast path
   * and not merely the convenient one. Partial success comes back as 200 with
   * the refusals listed, because the renames that went through are real.
   */
  [
    /^\/photos\/taken$/,
    "POST",
    async (req, res) => {
      if (refuseIfBusy(res)) return;
      const body = await readJsonBody<{
        items?: { id?: string; month?: string; date?: string; time?: string | null }[];
      }>(req);
      if (!Array.isArray(body.items) || body.items.some((i) => !i.id || !i.month || !i.date)) {
        return json(res, 400, { error: "items, each with id, month and date, are required" });
      }
      try {
        json(res, 200, await setPhotosTakenAt(body.items.map((i) => ({
          id: i.id!,
          month: i.month!,
          date: i.date!,
          time: i.time?.trim() ? i.time.trim() : null,
        }))));
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    },
  ],

  [/^\/jobs\/([\w-]+)\/events$/, "GET", (_req, res, [id]) => streamJob(res, id)],
  [
    /^\/jobs\/([\w-]+)\/cancel$/,
    "POST",
    (_req, res, [id]) => {
      const ok = jobs.cancel(id);
      json(res, ok ? 200 : 409, ok ? jobs.getJob(id) : { error: "Job is not running" });
    },
  ],
  [
    /^\/jobs\/([\w-]+)$/,
    "GET",
    (_req, res, [id]) => {
      const record = jobs.getJob(id);
      record ? json(res, 200, record) : json(res, 404, { error: "No such job" });
    },
  ],
];

const server = createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  // Path first, then method — and keep looking. Bailing out with 405 on the
  // first path match meant two routes could never share a pattern, so
  // `GET /sync/pins` shadowed `POST /sync/pins` entirely and the POST answered
  // "Use GET for /sync/pins".
  let pathMatched: string[] | null = null;
  const allowed: string[] = [];

  for (const [pattern, method, handler] of routes) {
    const match = pattern.exec(path);
    if (!match) continue;
    pathMatched = match.slice(1);
    allowed.push(method);
    if (req.method !== method) continue;
    try {
      await handler(req, res, match.slice(1));
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: (err as Error).message });
    }
    return;
  }

  if (pathMatched) {
    res.setHeader("Allow", allowed.join(", "));
    return json(res, 405, { error: `Use ${allowed.join(" or ")} for ${path}` });
  }
  json(res, 404, { error: `No route for ${req.method} ${path}` });
});

// Eviction must know what is pinned before it ever runs.
setProtectedProvider(protectedPaths);

// Initialize proxy dispatcher for global fetch (AI Provider / Graph)
initProxyDispatcher();

server.listen(env.servePort, "127.0.0.1", () => {
  console.log(`pipeline serve — http://127.0.0.1:${env.servePort} (loopback only)`);
  console.log(`  GET  /health`);
  console.log(`  GET  /archive/status`);
  console.log(`  GET  /config              generation settings; never returns keys`);
  console.log(`  POST /config              {AI_PROVIDER,GEMINI_API_KEY,...}`);
  console.log(`  GET  /prefs               the app's theme, density, sidebar width, language`);
  console.log(`  POST /prefs               {theme,density,sidebarWidth,contentLang,navOpenGroups}`);
  console.log(`  POST /jobs/scan           {mode,from,to}    free, Graph listing only`);
  console.log(`  POST /jobs/analyze/plan   {from,to,limit}   what it would cost, spends nothing`);
  console.log(`  POST /jobs/analyze        {from,to,limit,batch}   batch: half price, results within a day`);
  console.log(`  POST /jobs/analyze/collect                  merge finished batches now`);
  console.log(`  GET  /jobs/analyze/batches                  submitted batches and their state`);
  console.log(`  POST /jobs/organize/plan  {only,force}      what it would rewrite, spends nothing`);
  console.log(`  POST /jobs/organize       {only,force}`);
  console.log(`  POST /jobs/translate/plan {lang,scope}      what it would translate, spends nothing`);
  console.log(`  POST /jobs/translate      {lang,scope}      text only, into the second language`);
  console.log(`  POST /jobs/trip           {startDate,endDate,name?,notes?,documents?}`);
  console.log(`  GET  /jobs/:id/events     SSE progress`);
  console.log(`  POST /jobs/:id/cancel`);
});

/**
 * Collects finished caption batches without anyone asking. A batch takes up to
 * a day and the point of it is that nobody waits, so the server checks every
 * ten minutes — and once shortly after starting, for a batch that finished
 * while it was down. Skipped while any job runs; the next tick comes soon.
 */
const COLLECT_EVERY_MS = 10 * 60 * 1000;
/**
 * Looks at the batches again shortly after this job ends, not at the next
 * tick: the automatic submit waits on a collect, and a submit that stopped at
 * the queue limit on the next one.
 */
function checkBatchesAfter(jobId: string): void {
  const stop = jobs.subscribe(jobId, (record) => {
    if (record.status === "running" || record.status === "queued") return;
    stop();
    setTimeout(() => void collectIfReady(), 5_000);
  });
}
async function collectIfReady(): Promise<void> {
  try {
    if (jobs.runningJob()) return;
    if (await readyToCollect()) {
      console.log("  caption batch finished — collecting");
      const job = jobs.start({ kind: "collect", run: (onProgress, signal) => collectAnalyzeBatches(onProgress, signal) });
      checkBatchesAfter(job.id);
      return;
    }
    // A submit that stopped at Google's queue limit carries on once no batch is open.
    const next = await autoSubmitDue();
    if (next) {
      console.log("  batch queue has room — submitting the next caption batch");
      const job = jobs.start<object>({
        kind: "analyze",
        run: (onProgress, signal) => submitAnalyzeBatch(next, onProgress, signal),
      });
      // Straight on to locating the round after.
      checkBatchesAfter(job.id);
      return;
    }
    // While a batch is out, look up places for the next one — see locateAhead.
    if (await locateAheadDue()) {
      console.log("  batch out at Google — locating photos for the next one");
      jobs.start({ kind: "locate", run: (onProgress, signal) => locateAhead(onProgress, signal) });
    }
  } catch (err) {
    console.warn(`  batch check failed: ${(err as Error).message}`);
  }
}
/**
 * Keeps the server up when an error arrives outside any job's `await`.
 *
 * undici emits a dropped connection on the request object, not at the call
 * site, so a stream reset mid-download reaches the process rather than the
 * job's catch. On 2026-09-17, on a mobile link, exactly that killed the server
 * in the middle of collecting a 4,000-photo batch and nothing restarted it.
 *
 * The running job cannot be trusted after this, so it is cancelled — which
 * also releases the archive lock it holds. The server itself keeps serving,
 * and the ten-minute check picks the work up again.
 */
for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(event, (err: unknown) => {
    console.error(`  ${event}: ${(err as Error)?.message ?? String(err)}`);
    const running = jobs.runningJob();
    if (running) {
      console.error(`  cancelling ${running.kind} ${running.id} after that error`);
      jobs.cancel(running.id);
    }
  });
}

setInterval(() => void collectIfReady(), COLLECT_EVERY_MS);
setTimeout(() => void collectIfReady(), 30_000);

/**
 * How stale the archive may get before the server looks for new photos itself.
 *
 * Adding photos to OneDrive did nothing until someone opened the app and
 * pressed Sync, so a week of photos could sit outside the archive while the
 * captioner worked through everything else. Six hours means a day's photos are
 * picked up the same evening.
 */
const SCAN_EVERY_MS = 6 * 60 * 60 * 1000;
/**
 * How often that staleness is checked.
 *
 * Deliberately far shorter than SCAN_EVERY_MS, because a check while any job
 * runs does nothing but wait for the next one. At 30 minutes, with the
 * captioner submitting batches back to back, the first build of this went a
 * whole evening without ever finding a free moment — every check landed on a
 * busy server and the scan never ran at all.
 */
const SCAN_CHECK_MS = 5 * 60 * 1000;

/**
 * An incremental scan when the last one has aged out. Listing only: it reads
 * folder metadata from Graph and downloads no photos, so it costs nothing but
 * time, and anything new it finds joins the next caption batch by itself.
 */
async function scanIfDue(): Promise<void> {
  try {
    if (jobs.runningJob()) return;
    const { lastScanAt } = await readSync();
    if (lastScanAt && Date.now() - Date.parse(lastScanAt) < SCAN_EVERY_MS) return;
    const range = await resolveRange("incremental", { from: null, to: null });
    console.log(`  looking for new photos (from ${range.from ?? "the beginning"})`);
    jobs.start({ kind: "scan", run: (onProgress, signal) => runScan(range, onProgress, signal) });
  } catch (err) {
    console.warn(`  scan check failed: ${(err as Error).message}`);
  }
}
setInterval(() => void scanIfDue(), SCAN_CHECK_MS);
// After the collect check, so a batch waiting to be merged is not held up by a
// scan that has six hours of slack in it.
setTimeout(() => void scanIfDue(), 60_000);
// A job that was running when the last process died is not running now.
void jobs.reapAbandoned().then((n) => {
  if (n) console.log(`${n} job(s) were interrupted when the server last stopped.`);
});

startSyncChecks(() => jobs.runningJob() !== null);
