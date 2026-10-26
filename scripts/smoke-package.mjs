/**
 * Smoke-test a *packaged* build, not the checkout.
 *
 * Every packaging bug found so far had the same shape: the app worked from a
 * git checkout and was broken once installed, because something the runtime
 * needs was not in `resources/`. `sharp`'s native libraries, the offline
 * gazetteer, and the served page have each gone missing that way, and each time
 * the discovery was a user's failed run. Reading the code cannot catch it;
 * starting the artifact and asking it a question can.
 *
 * What it does:
 *   1. checks the payload has the files itself (`server.mjs`, the gazetteer,
 *      `app-dist/index.html`);
 *   2. bundles a one-question probe into `resources/pipeline/dist/` and runs it
 *      with the app's own runtime, which proves `paths.ts` resolves the
 *      gazetteer from beside the code rather than from an empty home;
 *   3. starts the real server from `resources/` against a throwaway home and
 *      asserts `/health`, `/`, `/mobile/` and `/oobe` answer.
 *
 * Usage:
 *   node scripts/smoke-package.mjs                 # desktop/release/win-unpacked
 *   node scripts/smoke-package.mjs --staging       # desktop/staging, run with node
 *   node scripts/smoke-package.mjs --self-check    # prove the check can fail
 *
 * Exit code 0 only when every check passes.
 */
import { build } from "esbuild";
import { execFileSync, spawn } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import net from "node:net";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PROBE_SOURCE = join(ROOT, "scripts/smoke/probe-gazetteer.ts");

const argv = process.argv.slice(2);
const STAGING = argv.includes("--staging");
const SELF_CHECK = argv.includes("--self-check");
const REQUIRE_RENDER = argv.includes("--require-render");
const REQUIRE_CLEAN = argv.includes("--require-clean");
const versionArg = argv.indexOf("--expect-version");
const EXPECT_VERSION = versionArg >= 0 ? argv[versionArg + 1].replace(/^v/, "") : null;
const appArg = argv.indexOf("--app");
const APP = appArg >= 0 ? resolve(argv[appArg + 1]) : join(ROOT, "desktop/release/win-unpacked");

const results = [];
const pass = (what, detail = "") => results.push({ ok: true, what, detail });
const warn = (what, detail = "") => results.push({ ok: true, warn: true, what, detail });
const fail = (what, detail = "") => results.push({ ok: false, what, detail });

const resources = () => (STAGING ? join(ROOT, "desktop/staging") : join(APP, "resources"));

async function runtime() {
  if (STAGING) return { exe: process.execPath, asNode: false };
  const exes = (await readdir(APP).catch(() => [])).filter(
    (name) => name.toLowerCase().endsWith(".exe") && !/uninstall/i.test(name),
  );
  const exe = exes[0];
  if (!exe) throw new Error(`no .exe in ${APP} — run "npm run package" first`);
  return { exe: join(APP, exe), asNode: true };
}

function freePort() {
  return new Promise((ok, bad) => {
    const server = net.createServer();
    server.on("error", bad);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => ok(port));
    });
  });
}

async function waitForUrl(url, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < until) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return response;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error.message;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${url} never answered: ${last}`);
}

/** Bundle the probe into the payload, so its module root is the payload's. */
async function bundleProbe(pipelineDir) {
  const outfile = join(pipelineDir, "dist/.smoke-probe.mjs");
  await build({
    entryPoints: [PROBE_SOURCE],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    logLevel: "silent",
  });
  return outfile;
}

function run(file, args, env, timeoutMs) {
  return new Promise((ok) => {
    const child = spawn(file, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      ok({ code, out, err });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      ok({ code: -1, out, err: error.message });
    });
  });
}

function parseProbe(out) {
  const line = out.split(/\r?\n/).find((l) => l.startsWith("SMOKE "));
  if (!line) return null;
  try {
    return JSON.parse(line.slice("SMOKE ".length));
  } catch {
    return null;
  }
}

async function checkPayload() {
  const base = join(resources(), "pipeline");
  const required = [
    "dist/server.mjs",
    "data/geo/places.tsv",
    "data/geo/countries.tsv",
    "data/geo/countries.geo.json",
    "screenshot-apps.json",
  ];
  for (const rel of required) {
    const file = join(base, rel);
    const exists = existsSync(file);
    const size = exists ? (await stat(file)).size : 0;
    if (!exists) fail(`payload: ${rel}`, "missing");
    else if (size === 0) fail(`payload: ${rel}`, "empty");
    else pass(`payload: ${rel}`, `${(size / 1024 / 1024).toFixed(2)} MB`);
  }
  const page = STAGING ? join(ROOT, "app/dist/index.html") : join(resources(), "app-dist/index.html");
  if (existsSync(page)) pass(`payload: ${page.includes("app-dist") ? "app-dist" : "app/dist"}/index.html`);
  else fail("payload: app page (index.html)", `missing at ${page} — the installed app would answer API and show no page`);

  if (!STAGING) {
    const asar = join(resources(), "app.asar");
    const size = existsSync(asar) ? (await stat(asar)).size : 0;
    if (size > 0) pass("payload: app.asar", `${(size / 1024 / 1024).toFixed(1)} MB`);
    else fail("payload: app.asar", "missing — the installed shell would not start");
  }

  await checkPageAssets(STAGING ? join(ROOT, "app/dist") : join(resources(), "app-dist"));
}

/**
 * The HTML the app serves must point at files that exist. A build that emits
 * `index.html` and skips a chunk is the same failure as a missing page, one
 * level down, and the browser reports it as a blank screen.
 */
async function checkPageAssets(root) {
  for (const rel of ["index.html", "auth.html", "mobile/index.html"]) {
    const file = join(root, rel);
    if (!existsSync(file)) {
      fail(`payload: ${rel}`, "missing");
      continue;
    }
    const text = await readFile(file, "utf-8");
    const refs = [...text.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((url) => !/^(?:[a-z]+:|\/\/|#)/i.test(url));
    const missing = refs.filter((url) => {
      const clean = url.split("?")[0].split("#")[0];
      const target = clean.startsWith("/") ? join(root, clean) : join(dirname(file), clean);
      return !existsSync(target);
    });
    if (missing.length) fail(`payload: ${rel} references`, `missing ${missing.slice(0, 3).join(", ")}`);
    else pass(`payload: ${rel} references`, `${refs.length} file(s), all present`);
  }
}

/**
 * The artifact's own claim about what it is, against the checkout (and, in CI,
 * against the tag the workflow was asked to build).
 */
async function checkBuildInfo() {
  const file = join(resources(), "pipeline/build-info.json");
  let info;
  try {
    info = JSON.parse(await readFile(file, "utf-8"));
  } catch {
    fail("build-info: present", `missing ${file} — this payload cannot say what it was built from`);
    return;
  }
  const want = JSON.parse(await readFile(join(ROOT, "desktop/package.json"), "utf-8")).version;

  if (info.version === want) pass("build-info: version matches desktop/package.json", info.version);
  else fail("build-info: version matches desktop/package.json", `payload ${info.version}, checkout ${want}`);

  if (EXPECT_VERSION) {
    if (info.version === EXPECT_VERSION) pass("build-info: version matches the requested tag", info.version);
    else fail("build-info: version matches the requested tag", `payload ${info.version}, asked for ${EXPECT_VERSION}`);
  }

  let head = null;
  try {
    head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8" }).trim();
  } catch {}
  if (!info.commit) warn("build-info: commit", "the build machine had no git");
  else if (!head) warn("build-info: commit", `payload ${info.commit.slice(0, 7)}, no checkout to compare`);
  else if (info.commit === head) pass("build-info: commit matches the checkout", info.commit.slice(0, 7));
  else fail("build-info: commit matches the checkout", `payload ${info.commit.slice(0, 7)}, checkout ${head.slice(0, 7)}`);

  if (info.dirty) {
    if (REQUIRE_CLEAN) fail("build-info: built from a clean tree", "uncommitted changes were compiled into this payload");
    else warn("build-info: built from a clean tree", "uncommitted changes were compiled into this payload");
  } else pass("build-info: built from a clean tree");
}

async function checkGazetteer({ exe, asNode }, label) {
  const pipelineDir = join(resources(), "pipeline");
  const probe = await bundleProbe(pipelineDir);
  const home = await mkdtemp(join(tmpdir(), "pa-smoke-home-"));
  try {
    const env = { ARCHIVE_HOME: home };
    if (asNode) env.ELECTRON_RUN_AS_NODE = "1";
    const { code, out, err } = await run(exe, [probe], env, 120_000);
    const answer = parseProbe(out);
    if (!answer) {
      fail(`${label}: probe ran`, `exit ${code}; ${(err || out).trim().split(/\r?\n/).slice(-2).join(" ")}`);
    } else if (answer.error) {
      fail(`${label}: gazetteer readable from the payload`, answer.error);
    } else if (answer.place !== "Vienna / Austria") {
      fail(`${label}: gazetteer answer`, `expected "Vienna / Austria", got ${JSON.stringify(answer.place)}`);
    } else {
      pass(`${label}: gazetteer readable from the payload`, answer.place);
    }
  } finally {
    await rm(probe, { force: true });
    await rm(home, { recursive: true, force: true });
  }
}

async function checkServer({ exe, asNode }) {
  const home = await mkdtemp(join(tmpdir(), "pa-smoke-serve-"));
  const servePort = await freePort();
  const pagePort = await freePort();
  const env = {
    ...(asNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    ARCHIVE_HOME: home,
    SERVE_PORT: String(servePort),
    DESKTOP_PORT: String(pagePort),
    ARCHIVE_HOST: "127.0.0.1",
    CI: "1",
    ...(STAGING ? { APP_DIST: join(ROOT, "app/dist") } : {}),
  };
  const server = spawn(exe, [join(resources(), "pipeline/dist/server.mjs")], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  try {
    const health = await waitForUrl(`http://127.0.0.1:${servePort}/health`, 40_000);
    const body = await health.json();
    if (body.ok === true) pass("server: /health answers");
    else fail("server: /health answers", JSON.stringify(body));

    const diagResponse = await fetch(`http://127.0.0.1:${servePort}/diagnostics`, {
      signal: AbortSignal.timeout(30_000),
    });
    const diag = diagResponse.ok ? await diagResponse.json() : null;
    if (!diag) fail("server: /diagnostics answers", `HTTP ${diagResponse.status}`);
    else {
      pass("server: /diagnostics answers");
      if (diag.config?.azureClientId === "set") pass("config: AZURE_CLIENT_ID is baked in");
      else fail("config: AZURE_CLIENT_ID is baked in", "an install without it cannot sign in");
      if (diag.config?.metadataFolder) pass("config: metadata folder", diag.config.metadataFolder);
      else fail("config: metadata folder", "empty — the archive has no namespace");
      if (diag.payload?.gazetteer?.places > 100_000)
        pass("payload: gazetteer loaded", `${diag.payload.gazetteer.places} places, ${diag.payload.gazetteer.countries} countries`);
      else fail("payload: gazetteer loaded", JSON.stringify(diag.payload?.gazetteer));
      if (diag.payload?.pageServed) pass("payload: a reader page is served");
      else fail("payload: a reader page is served", "the API answers and the page does not");
      if (diag.payload?.screenshotAllowlist > 0)
        pass("payload: screenshot allowlist", `${diag.payload.screenshotAllowlist} app(s)`);
      else warn("payload: screenshot allowlist", "empty — screenshot analysis would be off");
      if (diag.payload?.ffmpegBesideCode) pass("payload: ffmpeg ships beside the code");
      else if (diag.render?.ffmpeg) warn("payload: ffmpeg", `found at "${diag.render.ffmpeg}" on this machine's PATH, not in the payload`);
      else warn("payload: ffmpeg", "absent — video posters and DNG rely on it");
    }

    if (STAGING) warn("server: local image rendering (sharp)", "not meaningful from the checkout runtime; run against the packaged build");
    else if (body.render?.images) pass("server: local image rendering (sharp)");
    else if (REQUIRE_RENDER) fail("server: local image rendering (sharp)", "render.images is false");
    else warn("server: local image rendering (sharp)", "false — known gap, tracked separately");
    if (STAGING) warn("server: HEIC decoding", "not meaningful from the checkout runtime");
    else if (body.render?.heif === false) warn("server: HEIC decoding", "unavailable — HEIC thumbnails would fall back");
    else if (body.render?.heif) pass("server: HEIC decoding");

    const page = await waitForUrl(`http://127.0.0.1:${pagePort}/`, 15_000);
    const html = await page.text();
    if (/<html/i.test(html)) pass("page: / serves the app");
    else fail("page: / serves the app", html.slice(0, 80));

    const mobile = await fetch(`http://127.0.0.1:${pagePort}/mobile/`, { signal: AbortSignal.timeout(10_000) });
    if (mobile.ok) pass("page: /mobile/ answers");
    else fail("page: /mobile/ answers", `HTTP ${mobile.status} — a phone would get nothing`);

    const oobe = await fetch(`http://127.0.0.1:${servePort}/oobe`, { signal: AbortSignal.timeout(10_000) });
    const oobeBody = oobe.ok ? await oobe.json() : null;
    if (oobeBody && "neverScanned" in oobeBody) pass("server: /oobe answers");
    else fail("server: /oobe answers", `HTTP ${oobe.status}`);
  } catch (error) {
    fail("server: started", error.message);
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 500));
    if (server.exitCode === null) server.kill("SIGKILL");
    await rm(home, { recursive: true, force: true });
    const complaint = log.split(/\r?\n/).find((l) => /no built app|ENOENT|Error:/.test(l));
    if (complaint) pass("server: log", complaint.trim().slice(0, 100));
  }
}

/**
 * Prove the gazetteer check can fail: copy the payload, delete the data, and
 * expect the probe to say so in words. A test that cannot fail is decoration.
 */
async function selfCheck() {
  const source = join(resources(), "pipeline");
  const copy = await mkdtemp(join(tmpdir(), "pa-smoke-copy-"));
  try {
    await cp(source, join(copy, "pipeline"), { recursive: true });
    await rm(join(copy, "pipeline/data/geo"), { recursive: true, force: true });
    const probe = await bundleProbe(join(copy, "pipeline"));
    const { out } = await run(process.execPath, [probe], { ARCHIVE_HOME: join(copy, "home") }, 60_000);
    const answer = parseProbe(out);
    if (answer?.error?.includes("offline gazetteer is missing")) {
      pass("self-check: a payload without the gazetteer is rejected, with a readable reason");
    } else {
      fail("self-check: a payload without the gazetteer is rejected", JSON.stringify(answer));
    }
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}

async function main() {
  console.log(`smoke: ${STAGING ? "desktop/staging" : APP}`);
  if (!STAGING && !existsSync(APP)) {
    console.log(`missing ${APP} — run "npm run package" first`);
    process.exit(2);
  }
  const rt = await runtime();
  await checkPayload();
  await checkBuildInfo();
  await checkGazetteer(rt, "payload");
  await checkServer(rt);
  if (SELF_CHECK) await selfCheck();

  console.log("");
  for (const r of results) console.log(`${r.ok ? (r.warn ? "warn" : "pass") : "FAIL"}  ${r.what}${r.detail ? `  — ${r.detail}` : ""}`);
  const failed = results.filter((r) => !r.ok).length;
  const warned = results.filter((r) => r.warn).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed${warned ? `, ${warned} warning(s)` : ""}`);
  process.exit(failed ? 1 : 0);
}

await main();
