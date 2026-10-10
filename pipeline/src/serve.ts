import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { cachedSync, checkSync, protectedPaths, runSync, startSyncChecks, type ConflictChoice } from "./jobs/sync.js";
import { pins, readSync, removePin, setPin, writeSync } from "./syncStore.js";
import { readOobe, writeOobe } from "./oobeStore.js";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { get } from "node:http";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveHome, dataFile } from "./paths.js";
import { mirrorOutputToLog } from "./logFile.js";
import { originAllowed } from "./originCheck.js";
import { downloadPhotoBuffer, downloadThumbnailBuffer, fetchItemDownloadUrl, GraphError, listChildFolderNames, listFolderFileNames } from "./graph.js";
import { renderCapability } from "./localThumb.js";
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
import { getCachedAccessToken, getAccessToken, getPendingDeviceCode, hasCachedAccount } from "./auth.js";
import { makeAccess } from "./access.js";
import { loadIndex } from "./archiveStore.js";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { configStatus, isWritableKey, saveConfig } from "./configStore.js";
import { autostartStatus, runtimePath, setAutostart, warmAutostartCache } from "./autostart.js";
import { remoteAccessStatus, runningExposed, runningHost, runningPassword, setRemoteAccess } from "./remoteAccess.js";
import { appDistIndex, serveApp } from "./staticApp.js";
import { initProxyDispatcher } from "./proxy.js";
import { planAnalyze, runAnalyze } from "./jobs/analyze.js";
import { validateProvider } from "./providers/index.js";
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
import { defineTrip, deleteTrip, editTrip, renameTrip, runTrip } from "./jobs/trip.js";
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

/**
 * Which origins may talk to this server, and which may write to it.
 *
 * The rule itself lives in `originCheck.ts`: it is a security decision, so it
 * sits where it can be tested on its own. What used to be here matched private
 * *IP literals* against three ports — which quietly excluded every reader who
 * reached the machine by name instead of by address (`http://nas:17923`,
 * `http://desktop.local:17923`), for CORS on a read and a 403 on a write.
 */

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
  if (origin && originAllowed(origin, { exposed })) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  // The session cookie has to be allowed through for a remote reader, who signs
  // in on the shell's origin and then fetches thumbnails from this one.
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

/**
 * A request the server understands well enough to refuse precisely.
 *
 * Distinct from a failure: this is the caller's answer, and it has to reach
 * them as a 400 rather than being caught by the generic handler below and
 * reported as the server's own fault — which is what happened to the
 * content-type check on its first outing.
 */
class BadRequest extends Error {}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Nothing this API accepts is large; a body this big is a mistake or an abuse.
    if (size > 1_000_000) throw new BadRequest("Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {} as T;

  /**
   * The content type is the check, not a formality.
   *
   * `application/json` makes the browser preflight, and a preflight is where
   * `cors()` refuses an origin it does not know — so a page on the internet
   * cannot deliver a body at all. `text/plain` and the form types are "simple"
   * requests: sent without asking, answered without the attacker seeing the
   * answer, and **executed all the same**. Parsing whatever arrived meant the
   * origin rule protected the response and not the write.
   *
   * `canWrite` does not help: it is the socket address, and a browser reaching
   * 127.0.0.1 from any page *is* 127.0.0.1.
   *
   * An empty body is exempt — with nothing to parse there is nothing to do —
   * which keeps a bare `POST /jobs/analyze/collect` from a shell working.
   */
  const type = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    throw new BadRequest(`Expected Content-Type: application/json, got ${type || "none"}`);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T;
  } catch (err) {
    // The caller's body, so the caller's 400 — with the parser's own position,
    // which is the only part of the message worth having.
    throw new BadRequest(`Body is not valid JSON: ${(err as Error).message}`);
  }
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

/**
 * Whether this server's own health endpoint answers, without going through
 * the proxy layer.
 *
 * A plain `fetch` would be handed to the global dispatcher that
 * `initProxyDispatcher` installed for AI and Graph traffic, and a loopback URL
 * asking a system proxy to loop back is a question with two answers. `http.get`
 * touches neither, and this is the one probe that must not be clever.
 */
function answersHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = get(`http://127.0.0.1:${port}/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.setTimeout(1200, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

type RestartPlan = { ok: true; entry: string } | { ok: false; error: string };

/**
 * Whether a restart may happen, and what to start in this one's place.
 *
 * Refuses on a running job rather than killing it: a job stopped mid-write
 * leaves the archive lock held by a process that will never release it, and
 * that failure surfaces as "nothing works" at the next launch with no line on
 * screen to explain it.
 */
async function planRestart(): Promise<RestartPlan> {
  const running = jobs.runningJob();
  if (running) {
    return { ok: false, error: `A ${running.kind} job is running (${running.id}); wait for it or cancel it first.` };
  }
  const entry = process.argv[1];
  if (!entry || !isAbsolute(entry) || !existsSync(entry)) {
    return {
      ok: false,
      error:
        `This server was not started from a file on disk (${entry ?? "no entry point"}), ` +
        `so there is nothing to start again.`,
    };
  }
  return { ok: true, entry };
}

/**
 * Start a replacement and leave — only once it is answering.
 *
 * The order is the whole design:
 *
 *   1. **Close the listener first.** On Windows a replacement binding while
 *      this one still listens gets EADDRINUSE and dies, which would be a
 *      restart that removes the server. The port has to be free *before* the
 *      new process starts, not when it tries.
 *   2. **Spawn detached, from the same entry and env**, so it does not care
 *      whether it was the desktop shell, the sign-in launcher or a terminal
 *      that started this one. No supervisor is introduced — the dying process
 *      is the only thing that has to work, and it works the same in the
 *      background case where there is no shell to fall back on.
 *   3. **Wait for /health, up to 20 seconds, before exiting.** A replacement
 *      that failed to start must be followed by this one coming back up, not
 *      by nothing.
 *
 * The response has already been written by then: readers see a couple of
 * seconds in which `/health` does not answer, which the app's two-consecutive-
 * misses rule absorbs without drawing the offline banner.
 */
async function handOver(entry: string): Promise<void> {
  console.log(`restart: handing over to ${entry}`);

  // Wait for the listener to be *gone*, not merely closing. `server.close()`
  // releases the port only once its connections are finished, and on Windows a
  // replacement that binds before then gets EADDRINUSE — which is exactly what
  // the first attempt did, with the child's own error line lost along with it
  // because it died before a pipe flushed.
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections?.();
  const stragglers = setTimeout(() => server.closeAllConnections?.(), 1200);
  await Promise.race([closed, new Promise<void>((r) => setTimeout(r, 4000))]);
  clearTimeout(stragglers);

  // The page listener must go too, for the mirror-image reason: a replacement
  // that cannot bind the app port would come up API-only, and the archive
  // would answer /health with no way to open it. If this process never
  // served the page (the shell does), there is nothing to close.
  if (appServer) {
    const pageClosed = new Promise<void>((resolve) => appServer!.close(() => resolve()));
    appServer.closeIdleConnections?.();
    await Promise.race([pageClosed, new Promise<void>((r) => setTimeout(r, 2000))]);
    appServer = null;
  }

  let child: ReturnType<typeof spawn> | null = null;
  try {
    child = spawn(runtimePath(), [entry], {
      cwd: archiveHome(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      detached: true,
      // Not this process's stdout: the replacement writes `data/serve.log`
      // itself (logFile.ts), and handing it our stream as well would put every
      // line in twice — once through the launcher's redirect, once through
      // its own mirror.
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", (err) => console.error(`restart: could not start the replacement: ${err.message}`));
    child.unref();
  } catch (err) {
    console.error(`restart: failed to spawn the replacement: ${(err as Error).message}`);
  }

  if (child) {
    // A replacement that dies must be reported now, not after twenty seconds
    // of polling a port nobody is going to answer on.
    let died: string | null = null;
    child.once("exit", (code, signal) => {
      died = code !== null && code !== undefined ? String(code) : String(signal ?? "unknown");
    });

    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise((r) => setTimeout(r, 500));
      if (died !== null) {
        console.error(`restart: the replacement exited (${died}) before it answered`);
        break;
      }
      if (await answersHealth(env.servePort)) {
        console.log("restart: replacement is answering - exiting");
        // Not `process.exit` straight away: this process's stdout is a pipe
        // (the launcher redirects it), and a synchronous exit drops whatever
        // the pipe has not flushed - which is how the first attempt's report
        // went missing.
        setTimeout(() => process.exit(0), 150);
        return;
      }
    }
  }

  // Nothing came up. Take the listener back rather than leave the port held by
  // a process that is about to stop listening and then sit there.
  console.error("restart: no replacement answered within 20s - taking the listener back");
  server.listen(env.servePort, HOST, () => {
    console.log(`pipeline serve - back up on ${HOST} after a restart that did not complete`);
  });
  void startAppServer();
}

/**
 * Everything this process prints is also written to `data/serve.log` — the
 * banner, a job's error, and the reason a restart did or did not work. Called
 * before anything else runs, because a mirror installed after the first line
 * would miss the first line.
 */
mirrorOutputToLog();

// The Run key is read through `reg.exe`, so asking it once here — before
// anyone opens Settings — keeps that off the control's init path. See the
// cache in autostart.ts: populating a checkbox should not spawn a process.
warmAutostartCache();

const routes: [RegExp, string, Handler][] = [
  [
    /^\/health$/,
    "GET",
    async (_req, res) => {
      // The cheap half first, and deliberately so: this is the endpoint the
      // app's banner polls, and it must answer even while a job is hogging the
      // loop — a pause in answering read as "the server died" during a shard
      // upload. Nothing here touches Graph, so it can come back immediately.
      // `render` is the local thumbnail capability (sharp / heic-decode /
      // ffmpeg): probed at most once a minute, and shown by the app so a
      // machine without ffmpeg says so instead of leaving videos blank.
      const body = {
        ok: true,
        signedIn: await hasCachedAccount(),
        running: jobs.runningJob(),
        lastFinished: jobs.lastFinished(),
        warming: warmingStatus(),
        render: await renderCapability(),
      };
      json(res, 200, body);
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
   * Starting the job server at sign-in — the fact, and the switch.
   *
   * Reachable by anyone who can read, changed only by this machine: the write
   * check below is the socket address, and this writes a Run key and two files
   * under the archive home, which is exactly the kind of thing a remote reader
   * must not be able to do (the same rule `canWrite` applies to every editor).
   *
   * A failure to *enable* comes back as 400 rather than a half-done state: the
   * launcher is written before the key is registered, so if `reg add` fails the
   * files are there and the key is not, and the status says so.
   */
  /**
   * Sign-in start-up is asked only by the machine it applies to.
   *
   * The write was already local (`canWrite`); the read answered anyone holding
   * the shared password with absolute paths under the owner's home directory —
   * harmless, and none of a family reader's business. The UI never asks
   * remotely: the section lives in the writable block, so a remote Settings
   * page does not fetch this at all.
   */
  [
    /^\/settings\/autostart$/,
    "GET",
    async (req, res) => {
      if (!access.isLocal(req)) {
        return json(res, 403, { error: "Sign-in start-up belongs to the machine the server is running on" });
      }
      json(res, 200, await autostartStatus());
    },
  ],
  [
    /^\/settings\/autostart$/,
    "POST",
    async (req, res) => {
      const body = await readJsonBody<{ enabled?: unknown }>(req);
      if (typeof body.enabled !== "boolean") {
        return json(res, 400, { error: "enabled must be true or false" });
      }
      try {
        json(res, 200, await setAutostart(body.enabled));
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    },
  ],

  /**
   * Who may reach this server, as it is running and as it is saved.
   *
   * Readable by anyone who can read the archive — it says whether a password
   * exists, never what it is — and writable only by this machine, like every
   * other setting that changes what the server does. The password travels one
   * way: `null` or an empty string clears it, and neither is ever sent back.
   */
  [
    /^\/settings\/remote$/,
    "GET",
    async (req, res) => json(res, 200, await remoteAccessStatus(access.isLocal(req))),
  ],

  /**
   * What setup still needs, as the server sees it — plus the device code
   * while one is pending.
   *
   * Loopback only, and deliberately so: the code signs *this* machine's
   * archive into a Microsoft account, so a remote reader holding it could
   * link their own. `/health` keeps answering everyone with the boolean;
   * this route exists for the page that has to show a code.
   */
  [
    /^\/oobe$/,
    "GET",
    async (req, res) => {
      if (!access.isLocal(req)) return json(res, 403, { error: "Local only" });
      return json(res, 200, {
        signedIn: await hasCachedAccount(),
        deviceCode: getPendingDeviceCode(),
        photosFolderValidatedAt: (await readOobe()).photosFolderValidatedAt ?? null,
        neverScanned: !(await readSync()).lastScanAt,
        photosFolder: env.photosFolder,
      });
    },
  ],

  /**
   * Starts the device-code sign-in, if one is not already waiting.
   *
   * The flow blocks until a human enters the code, so the answer to this
   * request is only "the prompt is (re)starting": the page reads the actual
   * code from `GET /oobe`, which is loopback-only for the same reason this
   * one is.
   */
  [
    /^\/oobe\/signin$/,
    "POST",
    async (req, res) => {
      if (!access.isLocal(req)) return json(res, 403, { error: "Local only" });
      if (getPendingDeviceCode()) return json(res, 202, { pending: true });
      if (await hasCachedAccount()) return json(res, 200, { signedIn: true });
      void getAccessToken()
        .then(() => console.log("  setup: sign-in completed"))
        .catch((err) => console.warn(`  setup sign-in failed: ${(err as Error).message}`));
      return json(res, 202, { pending: true });
    },
  ],

  /**
   * Asks a provider one cheap question: does this key (or endpoint) work?
   *
   * Setup used to write any text a reader typed into `.env` and continue;
   * a typo surfaced minutes later as a failed job. `auth` (401/403) is a
   * wrong key, `unreachable` is no answer at all — the page blocks on
   * either. The key itself is never part of the response.
   */
  [
    /^\/config\/validate$/,
    "POST",
    async (req, res) => {
      if (!access.isLocal(req)) return json(res, 403, { error: "Local only" });
      const body = await readJsonBody<{ provider?: unknown; key?: unknown }>(req);
      if (typeof body.provider !== "string" || !body.provider)
        return json(res, 400, { error: "provider is required" });
      const key = typeof body.key === "string" ? body.key : undefined;
      return json(res, 200, await validateProvider(body.provider, key));
    },
  ],

  /**
   * Probes a photo folder; with `confirm`, stamps the configured one as agreed.
   *
   * A missing folder answers `not-found` with **200** — it is an answer, not a
   * transport failure, and the page has to be able to render it. Confirmation
   * writes `photosFolderValidatedAt`: the record that a human agreed to this
   * folder. It does **not** start anything — the first scan runs from the
   * wizard's own last page, because the folder can still be changed while
   * the wizard is open (see `scanIfDue`).
   * The path itself is never written here (it travels through `POST /config`,
   * so there stays one way to change a setting): `path` only *asks* about a
   * candidate, and the stamp is refused for anything but the folder that is
   * actually configured — validating `A` must never agree to `B`.
   */
  [
    /^\/oobe\/folder$/,
    "POST",
    async (req, res) => {
      if (!access.isLocal(req)) return json(res, 403, { error: "Local only" });
      const body = await readJsonBody<{ confirm?: unknown; path?: unknown }>(req);
      const target = typeof body.path === "string" && body.path.trim() ? body.path.trim() : env.photosFolder;
      const token = await getCachedAccessToken();
      if (!token) return json(res, 200, { state: "no-token", path: target });
      try {
        const names = await listFolderFileNames(token, target);
        const months = names.filter((n) => /^\d{4}-\d{2}$/.test(n) || /^\d{4}$/.test(n)).length;
        if (body.confirm === true && target === env.photosFolder) {
          await writeOobe({ photosFolderValidatedAt: new Date().toISOString() });
        }
        return json(res, 200, { state: "ok", path: target, count: names.length, months });
      } catch (err) {
        if (err instanceof GraphError && err.status === 404) {
          return json(res, 200, { state: "not-found", path: target });
        }
        return json(res, 502, { error: (err as Error).message });
      }
    },
  ],

  /** One level of sub-folders — the setup picker's list, folders only. */
  [
    /^\/oobe\/folders$/,
    "GET",
    async (req, res) => {
      if (!access.isLocal(req)) return json(res, 403, { error: "Local only" });
      const path = new URL(req.url ?? "/", "http://localhost").searchParams.get("path") ?? "";
      const token = await getCachedAccessToken();
      if (!token) return json(res, 200, { state: "no-token", path, folders: [] });
      try {
        const folders = await listChildFolderNames(token, path);
        return json(res, 200, { path, folders: folders.slice(0, 500), truncated: folders.length > 500 });
      } catch (err) {
        if (err instanceof GraphError && err.status === 404) {
          return json(res, 200, { state: "not-found", path, folders: [] });
        }
        return json(res, 502, { error: (err as Error).message });
      }
    },
  ],
  [
    /^\/settings\/remote$/,
    "POST",
    async (req, res) => {
      const body = await readJsonBody<{ exposed?: unknown; password?: unknown }>(req);
      if (body.exposed !== undefined && typeof body.exposed !== "boolean") {
        return json(res, 400, { error: "exposed must be true or false" });
      }
      if (body.password !== undefined && body.password !== null && typeof body.password !== "string") {
        return json(res, 400, { error: "password must be a string, null to clear, or absent to leave alone" });
      }
      // An empty box is the same intent as the clear button, not a password
      // nobody could type.
      const password = body.password === "" ? null : body.password;
      try {
        json(
          res,
          200,
          await setRemoteAccess({ exposed: body.exposed as boolean | undefined, password: password as string | null | undefined }),
        );
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    },
  ],

  /**
   * Restart — the only way a saved remote-access change, or a wedged server,
   * can be applied from where the reader is standing.
   *
   * Answered *before* anything closes: the response has to get out while the
   * listener is still listening, and the handover that follows is allowed to
   * take up to twenty seconds without the client waiting on it.
   */
  [
    /^\/server\/restart$/,
    "POST",
    async (_req, res) => {
      const plan = await planRestart();
      if (!plan.ok) return json(res, 409, plan);
      json(res, 200, { ok: true, restarting: true });
      setTimeout(() => void handOver(plan.entry), 300);
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

      let bytes: Buffer | null;
      try {
        bytes = await fetchAndCache(size as ThumbSize, itemId);
      } catch (err) {
        // "That item does not exist" is the archive's answer, not the server
        // breaking. The generic handler maps anything else to 500, which told
        // the reader a ghost month's worth of ids (TODO, #12) was a server
        // fault, and 500 is not the status the app reads as "no preview".
        if (err instanceof GraphError && err.status === 404) {
          return json(res, 404, { error: "No such item, or not signed in" });
        }
        throw err;
      }
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
      // A remote reader does not get video. It is the one route that hands out a
      // pre-authenticated OneDrive URL rather than fetching the bytes itself, so
      // the traffic is the owner's and the URL is a capability for anyone who
      // sees it; and the app hides its own video affordances on a remote
      // connection to match. Nothing here is worth that.
      if (!access.isLocal(_req)) return json(res, 404, { error: "No such route" });
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
   * The owner's own corrections to a trip's narrative or name, in whichever
   * language they are reading. Synchronous, one write, nothing spent — see
   * editTrip. `lang` picks the sidecar the text belongs to.
   */
  [
    /^\/trips\/([^/]+)\/edit$/,
    "POST",
    async (req, res, [id]) => {
      if (refuseIfBusy(res)) return;
      const body = await readJsonBody<{ narrative?: string | null; name?: string | null; lang?: string | null }>(req);
      try {
        const edits = await editTrip(decodeURIComponent(id), body);
        json(res, 200, { ok: true, edits });
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

  /**
   * A write may only come from a page this server would answer anyway.
   *
   * `cors()` refuses an origin by withholding `Access-Control-Allow-Origin`,
   * which stops a preflighted request and stops the attacker *reading* — not a
   * "simple" request (`text/plain`, form), which the browser sends without
   * asking and which `readJsonBody` used to parse regardless. This is the
   * other half: an origin we do not know may not write, whatever content type
   * it picked.
   *
   * Requests with no `Origin` — this machine, a shell script, the tests — are
   * not a browser and are left to the checks below. And `canWrite` still has
   * to pass: this refuses a *page*, not a *person*, and a page has an origin.
   */
  const origin = req.headers.origin;
  if (req.method !== "GET" && origin && !originAllowed(origin, { exposed })) {
    return json(res, 403, { error: `Origin ${origin} may not write to this server` });
  }

  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  /**
   * Who is asking, and what may they do.
   *
   * The rules are kinds, not accounts — see access.ts. Writes are this machine's
   * alone; reads need the shared password when the server is exposed and one is
   * set. The two sign-in routes are answered before the check, since they are
   * how a remote reader gets a cookie in the first place.
   */
  if (path === "/access") {
    if (req.method === "GET") {
      return json(res, 200, {
        gated: access.gated,
        exposed: access.gated,
        signedIn: access.canRead(req),
        // The server's own answer to "may this client write", so the UI can
        // offer nothing it would then 403 on. Decided here, where the socket
        // address is authoritative, rather than guessed from the page's
        // hostname.
        canWrite: access.canWrite(req),
      });
    }
    if (req.method === "POST") {
      const body = await readJsonBody<{ password?: string }>(req);
      if (!access.signIn(res, body.password)) return json(res, 401, { error: "Wrong password" });
      return json(res, 200, { ok: true });
    }
  }

  if (!access.canRead(req)) {
    return json(res, 401, { error: "Sign in first", signIn: "/access" });
  }
  if (req.method !== "GET" && !access.canWrite(req)) {
    return json(res, 403, { error: "This archive is read-only from another machine." });
  }

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
      // A `BadRequest` is the caller's own mistake — a body we refused to
      // parse, a content type we asked for and did not get — and reporting
      // that as a 500 says the server broke when it did not.
      if (!res.headersSent) json(res, err instanceof BadRequest ? 400 : 500, { error: (err as Error).message });
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

/**
 * The page half of the archive: `app/dist` on its own port, so the login
 * chain that starts this process brings up the API *and* a page someone can
 * open. The web server used to live only inside Electron, which meant a
 * reboot left `/health` answering while 17923 was dead until a window was
 * opened — a remote reader could reach the API and nothing else.
 *
 * The port is the same knob the shell reads (`DESKTOP_PORT`, default 17923):
 * one number on both sides, because adoption is a single door. A missing
 * build and a port somebody else owns are both "not our job", never a fault
 * — the shell, `run-preview.ps1` or a vite dev server may already be
 * serving, and the reader gets the page either way.
 */
let appServer: Server | null = null;

async function startAppServer(): Promise<void> {
  const port = Number(process.env.DESKTOP_PORT ?? 17923);
  const root =
    process.env.APP_DIST ?? join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "app", "dist");
  if (!appDistIndex(root)) {
    console.log(`app page: no built app at ${root} — the window will serve it`);
    return;
  }
  try {
    const result = await serveApp(root, port, HOST);
    if (result.kind === "serving") {
      appServer = result.server;
      console.log(`app page — ${exposed ? `${HOST}:${port}` : `127.0.0.1:${port} (loopback only)`}`);
    } else if (result.kind === "adopted") {
      console.log(`app page: ${port} is already serving this app — adopted`);
    } else {
      console.log(`app page: ${port} is held by something else (${result.by}) — not serving`);
    }
  } catch (err) {
    // Whatever the page server could not do, the API is up and jobs run.
    console.log(`app page: could not start — ${(err as Error).message}`);
  }
}

/**
 * The host the server listens on, and who it lets in.
 *
 * **Loopback by default.** `ARCHIVE_HOST=0.0.0.0` puts the archive on the
 * network so the family can read it; `ARCHIVE_PASSWORD` is the shared password
 * that then gates reading, and writes stay this machine's alone either way.
 * Exposing without a password is allowed and said out loud at startup, because
 * a silent open server is the failure worth preventing.
 *
 * All three come from `remoteAccess.ts`, which reads them once at startup —
 * that is what `makeAccess` and `listen` do, and what makes a saved-but-not-
 * restarted change reportable rather than half applied.
 */
const HOST = runningHost;
const exposed = runningExposed;
const access = makeAccess({ password: runningPassword ?? null, exposed });

server.listen(env.servePort, HOST, () => {
  const where = exposed ? `http://${HOST}:${env.servePort}` : `http://127.0.0.1:${env.servePort} (loopback only)`;
  console.log(`pipeline serve — ${where}`);
  if (exposed) {
    console.log(
      access.gated
        ? `  reachable on the network; reading needs the shared password, writing is local only`
        : `  !! reachable on the network with NO PASSWORD — anyone on it can read the archive`,
    );
  }
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

// The page half, after the API knows its own address — and never fatal to it.
// A fresh boot with a built app beside it answers on the app port with no
// window involved; everything else (no build, port in use) logs one line.
void startAppServer();

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

/**
 * Names what blocked the event loop, if anything did.
 *
 * The reader's banner calls the server "gone" when `/health` takes longer than
 * `HEALTH_TIMEOUT_MS`, and until now there was no way to tell a job that sat
 * on the loop from a packet lost on the Wi-Fi — "the cause is unclear" was the
 * end of it. This is the other half: an integer sample every 20ms, built into
 * Node (`perf_hooks`), no dependency and no I/O, and the histogram is reset
 * each time so the line names the *window* in which it stalled.
 *
 * Thresholded at 500ms because that is already large enough to be felt, small
 * enough to catch the stall before it reaches the 8s timeout that made the
 * banner say the server was dead.
 */
const loopLag = monitorEventLoopDelay({ resolution: 20 });
loopLag.enable();
const LAG_WARN_MS = 500;
setInterval(() => {
  const maxMs = loopLag.max / 1e6;
  loopLag.reset();
  if (!Number.isFinite(maxMs) || maxMs < LAG_WARN_MS) return;
  const job = jobs.runningJob();
  console.warn(`  event loop lagged ${Math.round(maxMs)}ms — ${job ? `${job.kind} job ${job.id}` : "no job running"}`);
}, 5_000);

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

    // The first scan belongs to setup's last page, not to a timer. This
    // gate used to open the moment page 2 stamped `photosFolderValidatedAt`
    // — an automatic scan could start while the wizard was still open, at
    // which point the reader could walk back (page 3's Back) and pick a
    // different folder: scanning before the choice is final is scanning
    // into a hole. There is no way past the wizard anymore (the quiet
    // escape link is gone), every fresh archive comes back to page 4, and
    // page 4 sets `lastScanAt` — so waiting here costs nothing.
    if (!lastScanAt) {
      console.log("scan check: first scan not run yet — waiting for setup to finish");
      return;
    }

    // And no folder survives a rename: probe before starting, so a missing
    // folder is one log line instead of a failing job. Without a cached
    // account there is nothing to ask with — and the only state that reaches
    // here without one is "confirmed in setup yet signed out", where the job
    // below is the thing that prompts (and now shows its code in Activity).
    const token = await getCachedAccessToken();
    if (token) {
      try {
        await listFolderFileNames(token, env.photosFolder);
      } catch (err) {
        if (err instanceof GraphError && err.status === 404) {
          console.warn(
            `scan check: photo folder not found: ${env.photosFolder} — set ONEDRIVE_PHOTOS_FOLDER, not scanning`,
          );
          return;
        }
        throw err;
      }
    }

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
