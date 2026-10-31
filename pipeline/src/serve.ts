import { createServer, type Server } from "node:http";
import { protectedPaths } from "./jobs/sync.js";
import { pins } from "./syncStore.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mirrorOutputToLog } from "./logFile.js";
import { originAllowed, hostAllowed } from "./originCheck.js";
import { FailureThrottle, RateLimiter } from "./rateLimit.js";
import { setProtectedProvider } from "./thumbStore.js";
import { env } from "./env.js";
import { makeAccess } from "./access.js";
import { warmAutostartCache } from "./autostart.js";
import { runningExposed, runningHost, runningPassword } from "./remoteAccess.js";
import { appDistIndex, serveApp } from "./staticApp.js";
import { initProxyDispatcher } from "./proxy.js";
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
import { archiveAlreadyExists, checkBatchesAfter, startBackgroundWork } from "./server/background.js";


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

void startBackgroundWork();
