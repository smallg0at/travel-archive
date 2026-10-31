import { createServer, type Server } from "node:http";
import { protectedPaths, startSyncChecks } from "./jobs/sync.js";
import { pins, readSync } from "./syncStore.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mirrorOutputToLog } from "./logFile.js";
import { originAllowed, hostAllowed } from "./originCheck.js";
import { FailureThrottle, RateLimiter } from "./rateLimit.js";
import { fetchItemMeta, GraphError, listFolderFileNames } from "./graph.js";
import { setProtectedProvider } from "./thumbStore.js";
import { env } from "./env.js";
import { getCachedAccessToken } from "./auth.js";
import { makeAccess } from "./access.js";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { warmAutostartCache } from "./autostart.js";
import { runningExposed, runningHost, runningPassword } from "./remoteAccess.js";
import { appDistIndex, serveApp } from "./staticApp.js";
import { initProxyDispatcher } from "./proxy.js";
import { autoSubmitDue, collectAnalyzeBatches, locateAhead, locateAheadDue, readyToCollect, submitAnalyzeBatch } from "./jobs/analyzeBatch.js";
import { resolveRange, runScan } from "./jobs/scan.js";
import { importLegacyPassphrase } from "./screenKeyStore.js";
import { json, cors, readJsonBody, BadRequest, type Route } from "./server/http.js";
import type { RouteContext } from "./server/routes/context.js";
import { systemRoutes } from "./server/routes/system.js";
import { settingsRoutes } from "./server/routes/settings.js";
import { archiveRoutes } from "./server/routes/archive.js";
import { syncRoutes } from "./server/routes/sync.js";
import { jobRoutes } from "./server/routes/jobs.js";
import { tripRoutes } from "./server/routes/trips.js";
import { contentRoutes } from "./server/routes/content.js";
import { handOver, type RestartHost } from "./server/restart.js";

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

// An install from before the key store kept the passphrase in plaintext in .env,
// beside the ciphertext it protects. Move it into DPAPI now, so nobody has to be
// asked and the plaintext line stops existing. Deliberately not awaited into the
// banner: if it fails, the server still runs — it will say so when the pass is
// used.
void importLegacyPassphrase()
  .then(({ migrated, legacy }) => {
    if (legacy) {
      console.error(
        "screen passphrase: SCREENSHOT_PASSPHRASE is set in the environment, not in .env — nothing reads it any more. " +
          "Set the passphrase in the Screens tab, which keeps it in this machine's key store.",
      );
    }
    void migrated;
  })
  .catch((err: Error) => console.error(`screen passphrase migration: ${err.message}`));

const server = createServer(async (req, res) => {
  cors(req, res, exposed);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  /**
   * The Host header has to name this server.
   *
   * A page can point a public name at 127.0.0.1 (DNS rebinding) and then talk
   * to this server with `Host: evil.example`. The socket looks local, so
   * `canRead` says yes and `canWrite` says yes; the Origin check stops writes,
   * but not reads or the GET routes that cost Graph traffic. Refusing an
   * unknown name closes the whole class, and every legitimate caller — the
   * shell, a phone typing `http://192.168.1.9:17923`, the demo proxy — sends
   * a name this check already accepts.
   */
  if (!hostAllowed(req.headers.host, { exposed })) {
    return json(res, 421, { error: `Unrecognised Host header: ${req.headers.host ?? "(none)"}` });
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
        exposed: access.exposed,
        signedIn: access.canRead(req),
        // The server's own answer to "may this client write", so the UI can
        // offer nothing it would then 403 on. Decided here, where the socket
        // address is authoritative, rather than guessed from the page's
        // hostname.
        canWrite: access.canWrite(req),
      });
    }
    if (req.method === "POST") {
      const key = req.socket.remoteAddress ?? "unknown";
      const retry = signInThrottle.retryAfter(key);
      if (retry !== null) {
        res.setHeader("Retry-After", String(retry));
        return json(res, 429, { error: `Too many wrong passwords. Try again in ${retry}s.` });
      }
      const body = await readJsonBody<{ password?: string }>(req);
      if (!access.signIn(res, body.password)) {
        signInThrottle.fail(key);
        return json(res, 401, { error: "Wrong password" });
      }
      signInThrottle.succeed(key);
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
  const base = fileURLToPath(new URL(".", import.meta.url));
  // Two layouts, one build: a checkout keeps it at `app/dist` beside
  // `pipeline/`, and the installer puts the same files in `resources/app-dist`
  // (electron-builder's extraResources). The shell knows that and passes
  // `APP_DIST`; a server started by the login chain has no shell to tell it,
  // so it looks for both. Without the second path a packaged install answers
  // the API and has no page — exactly the state a phone cannot read.
  const candidates = [
    process.env.APP_DIST,
    join(base, "..", "..", "app", "dist"),
    join(base, "..", "..", "app-dist"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const root = candidates.find((candidate) => appDistIndex(candidate));
  if (!root) {
    console.log(`app page: no built app at ${candidates.join(" or ")} — the window will serve it`);
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

/**
 * Limits for the two paths an unauthenticated caller can make expensive.
 *
 * The bucket is per socket address and only counts cache misses: a phone
 * scrolling a month should be able to request a hundred thumbnails, but one
 * client asking for thousands is a different thing from a reader. Five wrong
 * passwords from one address buys five minutes of silence; a correct one
 * clears the record, so a household mistyping once is not locked out.
 */
const thumbLimiter = new RateLimiter(60, 4);
const signInThrottle = new FailureThrottle(5, 5 * 60_000, 5 * 60_000);

/**
 * The listeners `handOver` (server/restart.ts) has to take down and, if the
 * replacement never answers, put back. They belong to this file, so the
 * restart logic asks rather than reaches in.
 */
const restartHost: RestartHost = {
  closeApi: async () => {
    // Wait for the listener to be *gone*, not merely closing. `server.close()`
    // releases the port only once its connections are finished, and on Windows
    // a replacement that binds before then gets EADDRINUSE.
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections?.();
    const stragglers = setTimeout(() => server.closeAllConnections?.(), 1200);
    await Promise.race([closed, new Promise<void>((r) => setTimeout(r, 4000))]);
    clearTimeout(stragglers);
  },
  closeApp: async () => {
    if (!appServer) return;
    const pageClosed = new Promise<void>((resolve) => appServer!.close(() => resolve()));
    appServer.closeIdleConnections?.();
    await Promise.race([pageClosed, new Promise<void>((r) => setTimeout(r, 2000))]);
    appServer = null;
  },
  reopen: () => {
    server.listen(env.servePort, HOST, () => {
      console.log(`pipeline serve - back up on ${HOST} after a restart that did not complete`);
    });
    void startAppServer();
  },
};

/**
 * Every route, in the order they are tried. Split by subject into
 * `server/routes/`, because this file is about starting the server rather
 * than about what it serves: the table alone was most of its length.
 */
const routeContext: RouteContext = {
  access,
  exposed,
  thumbLimiter,
  restartHost,
  archiveAlreadyExists,
  checkBatchesAfter,
};

const routes: Route[] = [
  ...systemRoutes(routeContext),
  ...settingsRoutes(routeContext),
  ...archiveRoutes(routeContext),
  ...syncRoutes(routeContext),
  ...jobRoutes(routeContext),
  ...tripRoutes(routeContext),
  ...contentRoutes(routeContext),
];

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
  console.log(`  POST /notify/test         one toast on this machine, for the Settings button`);
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

let archiveProbe: { value: boolean; at: number } | null = null;
const ARCHIVE_PROBE_MS = 60_000;

/**
 * Whether the metadata folder already holds an archive.
 *
 * The wizard decides whether this machine is a first run from `sync.json`,
 * which is per machine — so a reinstall, a second PC or a new Windows profile
 * reads as a first run even when the account's OneDrive already holds the whole
 * library. That mistake is not cosmetic: the wizard's last page runs the first
 * scan, which re-lists every month folder and rewrites `index.json` against an
 * archive that already exists, on a design that assumes exactly one writer.
 *
 * Asked only when everything local says fresh and somebody is signed in, and
 * cached for a minute, because `/oobe` is polled every two seconds while the
 * wizard is open. One item-metadata request, not the multi-megabyte download
 * (see `fetchItemMeta`). Unanswerable counts as "fresh" — the behaviour before
 * this existed.
 */
async function archiveAlreadyExists(): Promise<boolean> {
  if (archiveProbe && Date.now() - archiveProbe.at < ARCHIVE_PROBE_MS) return archiveProbe.value;
  let value = false;
  try {
    const token = await getCachedAccessToken();
    if (token) value = (await fetchItemMeta(token, env.metadataFolder, "index.json")) !== null;
  } catch {
    value = false;
  }
  archiveProbe = { value, at: Date.now() };
  return value;
}

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
