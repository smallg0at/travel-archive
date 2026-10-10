#!/usr/bin/env node
/**
 * Reproduce a reader that is **not this machine**, and ask what breaks.
 *
 * `pipeline/src/access.ts` calls a peer remote unless its socket address is
 * `::1`, `127.0.0.1` or `::ffff:127.0.0.1`, and that one test decides both the
 * read gate and `canWrite`. Connecting to `127.0.0.2` does NOT fool it: Windows
 * normalises the source address of a loopback connection to `127.0.0.1`
 * (measured 2026-10-10 — the connection was made to `127.0.0.2` and arrived as
 * `127.0.0.1`). So this runs a small forwarding proxy that dials upstream with
 * `localAddress: "127.0.0.2"`; the server then sees a remote peer while both
 * ends stay inside `127/8`, and nothing is exposed on the network.
 *
 * What it checks, over that proxy:
 *   - /access reports the peer as remote (`canWrite: false`)
 *   - a read with no session cookie is refused (401)
 *   - in a real browser, from a *different origin* than the API:
 *       fetch with `credentials: "include"`      answered
 *       fetch without credentials                refused
 *       `new EventSource(url)`                   error   <- sends no cookies
 *       `new EventSource(url, {withCredentials})` opens
 *
 * That last pair is the whole point, and it is how the remote-reader progress
 * bug was found on 2026-10-10: `backend.ts`'s `apiFetch` asks for credentials on
 * every read, but the job's progress stream opened a bare `EventSource`, which a
 * cross-origin request sends no cookies for — so `serve.ts` refused the stream
 * with 401 and the Activity panel painted one frame and froze. Locally it never
 * showed, because `canRead` is true without a cookie for a loopback peer.
 *
 * Two conditions come with the setup, both from access.ts: the throwaway must be
 * **exposed** (`ARCHIVE_HOST=0.0.0.0`) or reads are not gated at all and there is
 * nothing to reproduce, and an **empty** archive is enough — a job still starts
 * (it fails for want of a token), which is all a progress-stream test needs.
 *
 * Usage:
 *   node scripts/remote-reader-probe.mjs [--keep] [--browser <exe>]
 *
 *   --keep     leave the throwaway server and the proxy running afterwards and
 *              print their addresses, so the real app can be hand-driven through
 *              the remote facade. Ctrl-C stops everything.
 *   --browser  a Chromium binary; otherwise the usual Edge/Chrome locations are
 *              tried, then BROWSER_PATH.
 *
 * A manual diagnostic rather than part of the test suite: it needs a browser.
 * The archive it serves is empty and its reads are password-gated.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(REPO, "pipeline", "dist", "serve.js");

const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");
const argValue = (name) => (argv.indexOf(name) >= 0 ? argv[argv.indexOf(name) + 1] : null);

const BROWSERS = [
  argValue("--browser"),
  process.env.BROWSER_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
const BROWSER = BROWSERS.find((p) => existsSync(p)) ?? null;

const PASSWORD = "probe-" + Math.random().toString(36).slice(2, 10);
const HOME = mkdtempSync(join(tmpdir(), "remote-reader-probe-"));
const PROFILE = join(HOME, "browser-profile");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log(...a);

/** A port nothing is listening on, chosen by asking the OS rather than guessing. */
const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

let server;
let proxy;
let pageSrv;
let browserProc;

const stop = () => {
  for (const child of [browserProc, server]) {
    try {
      child?.kill();
    } catch {}
  }
  // http.Server has close(), not kill(); calling kill() on one silently does
  // nothing and leaves the listener holding the event loop open.
  for (const srv of [proxy, pageSrv]) {
    try {
      srv?.close();
    } catch {}
  }
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {}
};
process.on("SIGINT", () => {
  stop();
  process.exit(130);
});

try {
  if (!existsSync(SERVER)) {
    throw new Error(`${SERVER} is missing — build it first: npm run --workspace pipeline build`);
  }

  const SERVE_PORT = await freePort();
  const DESKTOP_PORT = await freePort();
  const PROXY_PORT = await freePort();
  const PAGE_PORT = await freePort();
  const DIRECT = `http://127.0.0.1:${SERVE_PORT}`;
  const VIA_PROXY = `http://127.0.0.1:${PROXY_PORT}`;

  // ---- the throwaway: exposed and gated, on an empty archive ----
  server = spawn(process.execPath, [SERVER], {
    cwd: HOME,
    env: {
      PATH: process.env.PATH,
      ARCHIVE_HOME: HOME,
      ARCHIVE_HOST: "0.0.0.0",
      ARCHIVE_PASSWORD: PASSWORD,
      SERVE_PORT: String(SERVE_PORT),
      DESKTOP_PORT: String(DESKTOP_PORT),
      AZURE_CLIENT_ID: "probe-dummy-client-id",
      ONEDRIVE_METADATA_FOLDER: "PROBE-NEVER-USE",
      GEOCODE_CONTACT_EMAIL: "probe@example.invalid",
      CI: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (d) => process.stderr.write("[serve!] " + d));

  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(500);
    try {
      up = (await fetch(`${DIRECT}/health`)).ok;
    } catch {}
  }
  if (!up) throw new Error("the throwaway server never answered /health");
  say(`throwaway job server up on ${SERVE_PORT} (exposed, password-gated, empty archive)`);

  // ---- the remote facade ----
  proxy = net.createServer((client) => {
    const up2 = net.connect({ port: SERVE_PORT, host: "127.0.0.1", localAddress: "127.0.0.2" });
    client.pipe(up2);
    up2.pipe(client);
    up2.on("error", () => client.destroy());
    client.on("error", () => up2.destroy());
  });
  await new Promise((r) => proxy.listen(PROXY_PORT, "127.0.0.1", r));
  say(`remote facade on ${VIA_PROXY} — the server sees this as 127.0.0.2, not loopback`);

  // ---- a job, so there is a progress stream to subscribe to (a write: direct) ----
  const started = await fetch(`${DIRECT}/jobs/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "full" }),
  });
  const job = await started.json();
  const JOB = job.id ?? job.job?.id;
  say(`job started for the stream: ${JOB}`);

  // ---- the server's half ----
  const access = await (await fetch(`${VIA_PROXY}/access`)).json();
  say("");
  say(`GET /access via the facade -> ${JSON.stringify(access)}`);
  const refused = await fetch(`${VIA_PROXY}/jobs/history`);
  say(`GET /jobs/history with no cookie -> ${refused.status}`);
  if (access.canWrite !== false) {
    say("!! the peer did NOT look remote — the facade is not doing its job, and nothing below means anything");
  }

  // ---- the browser's half, from an origin that is not the API's ----
  const results = {};
  if (!BROWSER) {
    say("");
    say("no Chromium binary found (pass --browser), so the browser half was skipped");
  } else {
    const PAGE = `<!doctype html><meta charset="utf-8"><title>probe</title><body><script>
const API = ${JSON.stringify(VIA_PROXY)};
const JOB = ${JSON.stringify(JOB)};
const PW = ${JSON.stringify(PASSWORD)};
const out = (k, v) => { new Image().src = "/beacon?k=" + encodeURIComponent(k) + "&v=" + encodeURIComponent(String(v)); };
const status = async (path, opts) => {
  try { return (await fetch(API + path, opts)).status; } catch (e) { return "throw:" + e.message; }
};
const watch = (opts) => new Promise((res) => {
  const es = new EventSource(API + "/jobs/" + JOB + "/events", opts);
  const t = setTimeout(() => { es.close(); res("timeout"); }, 5000);
  es.onopen = () => { clearTimeout(t); es.close(); res("open"); };
  es.onerror = () => { clearTimeout(t); es.close(); res("error"); };
});
(async () => {
  out("signin", await status("/access", { method: "POST", credentials: "include",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PW }) }));
  out("fetch_with_credentials", await status("/jobs/history", { credentials: "include" }));
  out("fetch_no_credentials", await status("/jobs/history"));
  out("eventsource_default", await watch());
  out("eventsource_withCredentials", await watch({ withCredentials: true }));
  out("done", "1");
})();
</script>`;

    pageSrv = createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/beacon") {
        results[url.searchParams.get("k")] = url.searchParams.get("v");
        res.writeHead(204).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
    });
    await new Promise((r) => pageSrv.listen(PAGE_PORT, "127.0.0.1", r));

    browserProc = spawn(BROWSER, [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${PROFILE}`,
      `http://127.0.0.1:${PAGE_PORT}/`,
    ], { stdio: "ignore" });

    for (let i = 0; i < 60 && !results.done; i++) await sleep(500);

    say("");
    say(`browser: page origin http://127.0.0.1:${PAGE_PORT}, API origin ${VIA_PROXY} (different origins, as a reader's are)`);
    for (const key of ["signin", "fetch_with_credentials", "fetch_no_credentials", "eventsource_default", "eventsource_withCredentials"]) {
      say(`  ${key.padEnd(30)} ${results[key] ?? "(no beacon)"}`);
    }
    say("");
    say("  expected: signin 200, fetch_with_credentials 200, fetch_no_credentials 401,");
    say("            eventsource_default error, eventsource_withCredentials open");
  }

  if (KEEP) {
    say("");
    say("--keep: leaving the throwaway and the facade up. Point the app at the facade:");
    say(`  page/API through   ${VIA_PROXY}     (a remote reader)`);
    say(`  API direct         ${DIRECT}        (this machine: canWrite true)`);
    say(`  password           ${PASSWORD}`);
    say("Ctrl-C to stop and clean up.");
    await new Promise(() => {});
  }
} catch (err) {
  say("probe error:", err.message);
  process.exitCode = 1;
} finally {
  if (!KEEP) {
    stop();
    say("");
    say("cleaned up");
  }
}
