import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { downloadPhotoBuffer, downloadThumbnailBuffer } from "./graph.js";
import { readThumb, thumbSize, writeThumb, type ThumbSize } from "./thumbStore.js";
import type { ArchiveStatus, JobRecord } from "@travel-archive/shared";
import { env } from "./env.js";
import { getCachedAccessToken } from "./auth.js";
import { loadIndex } from "./archiveStore.js";
import { planAnalyze, runAnalyze } from "./jobs/analyze.js";
import { runOrganize } from "./jobs/organize.js";
import { runTrip } from "./jobs/trip.js";
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
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
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

  const index = await loadIndex(token);
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
const inFlight = new Map<string, Promise<Buffer | null>>();

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
      json(res, 200, { ok: true, signedIn: token !== null, running: jobs.runningJob() });
    },
  ],
  [/^\/archive\/status$/, "GET", async (_req, res) => json(res, 200, await archiveStatus())],

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

      // Deliberately after the response. Bounded well below what the analyze
      // pass uses against Graph, since this runs while the user is browsing and
      // must not provoke throttling that would slow the thing it is helping.
      void (async () => {
        let next = 0;
        const worker = async () => {
          while (next < missing.length) {
            const id = missing[next++];
            await fetchAndCache(size, id).catch(() => null);
          }
        };
        await Promise.all(Array.from({ length: Math.min(8, missing.length) }, worker));
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
  [
    /^\/jobs\/analyze$/,
    "POST",
    async (req, res) => {
      if (refuseIfBusy(res)) return;
      const body = await readJsonBody<{ from?: string; to?: string; limit?: number }>(req);
      const opts = {
        from: body.from ?? null,
        to: body.to ?? null,
        limit: body.limit ?? Number.MAX_SAFE_INTEGER,
      };
      json(res, 202, jobs.start({ kind: "analyze", run: (onProgress, signal) => runAnalyze(opts, onProgress, signal) }));
    },
  ],
  [
    /^\/jobs\/organize$/,
    "POST",
    async (req, res) => {
      if (refuseIfBusy(res)) return;
      const body = await readJsonBody<{ only?: string; force?: boolean }>(req);
      const opts = { only: body.only ?? null, force: body.force === true };
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
      };
      json(res, 202, jobs.start({ kind: "trip", run: (onProgress, signal) => runTrip(opts, onProgress, signal) }));
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

  for (const [pattern, method, handler] of routes) {
    const match = pattern.exec(path);
    if (!match) continue;
    if (req.method !== method) return json(res, 405, { error: `Use ${method} for ${path}` });
    try {
      await handler(req, res, match.slice(1));
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: (err as Error).message });
    }
    return;
  }

  json(res, 404, { error: `No route for ${req.method} ${path}` });
});

server.listen(env.servePort, "127.0.0.1", () => {
  console.log(`pipeline serve — http://127.0.0.1:${env.servePort} (loopback only)`);
  console.log(`  GET  /health`);
  console.log(`  GET  /archive/status`);
  console.log(`  POST /jobs/analyze/plan   {from,to,limit}   what it would cost, spends nothing`);
  console.log(`  POST /jobs/analyze        {from,to,limit}`);
  console.log(`  POST /jobs/organize       {only}`);
  console.log(`  POST /jobs/trip           {startDate,endDate,name?,notes?,documents?}`);
  console.log(`  GET  /jobs/:id/events     SSE progress`);
  console.log(`  POST /jobs/:id/cancel`);
});
