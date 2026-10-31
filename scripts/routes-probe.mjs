// Every route in `pipeline/src/server/routes/` has to still be reachable from
// the running server. The split into modules is mechanical, and the failure it
// can introduce is a route that nobody wired up — so ask each one for an
// answer, and accept anything except the dispatcher's own "no route" reply.
import { spawn } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../pipeline/src/server/routes/", import.meta.url));
const routes = [];
for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "context.ts")) {
  const lines = readFileSync(join(dir, file), "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    // Both shapes the table uses: `[regex, "METHOD", handler]` on one line, and
    // the entry spread over several. The first is how three routes were lost.
    const inline = /\[\s*(\/\^[^,]+?\/[a-z]*)\s*,\s*"(GET|POST)"/.exec(lines[i]);
    if (inline) {
      routes.push({ file, regex: inline[1], method: inline[2] });
      continue;
    }
    if (!/^\s{2}\[\s*$/.test(lines[i])) continue;
    const pattern = /^\s{4}(\/\^.*\/[a-z]*),?\s*$/.exec(lines[i + 1] ?? "");
    const method = /^\s{4}"(GET|POST)",?\s*$/.exec(lines[i + 2] ?? "");
    if (!pattern || !method) continue;
    routes.push({ file, regex: pattern[1].replace(/\/[a-z]*$/, ""), method: method[1] });
  }
}

/** Turn a route's regex into one concrete path. */
function concrete(regex) {
  return regex
    .replace(/^\/\^/, "")
    .replace(/\/[a-z]*$/, "")
    .replace(/\$$/, "")
    .replace(/\\\//g, "/")
    .replace("(\\d{4}-\\d{2}-\\d{2})", "2024-01-02")
    .replace("(\\d{4}-\\d{2})", "2024-01")
    .replace("([a-z]{2}(?:-[A-Za-z]{2,4})?)", "en")
    .replace("(medium|large|full)", "large")
    .replace("([^/]+)", "abc123")
    .replace("([\\w-]+)", "abc123")
    .replace("(.+)", "abc123");
}

const home = mkdtempSync(join(tmpdir(), "routes-probe-"));
const port = "19579";
const started = new Date().toISOString();
const env = {
  ...process.env,
  ARCHIVE_HOME: home,
  SERVE_PORT: port,
  AZURE_CLIENT_ID: "probe-client",
  AZURE_TENANT_ID: "common",
  ARCHIVE_HOST: "127.0.0.1",
  ELECTRON_RUN_AS_NODE: "1",
};
const entry = fileURLToPath(new URL("../pipeline/dist/serve.js", import.meta.url));
const logPath = join(home, "probe.log");
const child = spawn(process.execPath, [entry], {
  env,
  stdio: ["ignore", openSync(logPath, "w"), openSync(logPath, "a")],
  windowsHide: true,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `http://127.0.0.1:${port}`;

let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await sleep(250);
  try {
    ready = (await fetch(`${base}/health`)).ok;
  } catch {
    /* not up yet */
  }
}

const missing = [];
/**
 * Routes that must not be poked by a test, with the reason.
 *
 * `/settings/firewall/allow` is the one that taught this: calling it ran an
 * elevated PowerShell and put a Windows UAC consent dialog on screen, which is
 * both a decision for a person and a change to the machine's firewall. A probe
 * that proves a route exists must not exercise the ones that ask permission.
 */
const neverPoke = {
  "/server/restart": "scripts/restart-probe.mjs",
  "/settings/firewall/allow": "asks for UAC consent",
  "/notify/test": "puts a toast on the desktop",
};

const skipped = [];
const results = [];
if (ready) {
  for (const route of routes) {
    const path = concrete(route.regex);
    if (path.includes("(")) {
      skipped.push(`${route.method} ${path}`);
      continue;
    }
    if (neverPoke[path]) {
      skipped.push(`${route.method} ${path} (${neverPoke[path]})`);
      continue;
    }
    try {
      const res = await fetch(`${base}${path}`, {
        method: route.method,
        headers: { "Content-Type": "application/json" },
        body: route.method === "POST" ? "{}" : undefined,
      });
      const text = await res.text();
      // Two ways a route can be gone: nothing matched the path at all, or the
      // path matched but not this method — which is how a lost `GET /prefs`
      // hides behind a surviving `POST /prefs`.
      const routed = !text.includes("No route for") && !/^Use (GET|POST) for /.test(text.replace(/^\{"error":"/, ""));
      results.push(`${routed ? "pass" : "MISS"}  ${route.method.padEnd(4)} ${path.padEnd(46)} ${res.status}`);
      if (!routed) missing.push(`${route.method} ${path} (${route.file})`);
    } catch (err) {
      results.push(`ERR   ${route.method} ${path} — ${err.message}`);
      missing.push(`${route.method} ${path} (${route.file})`);
    }
  }
}

child.kill();
const kill = spawn(
  "powershell",
  [
    "-NoProfile",
    "-Command",
    `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; ` +
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*pipeline\\dist\\serve.js*' -and $_.CreationDate -ge [datetime]'${started}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  ],
  { windowsHide: true, stdio: "ignore" },
);
await new Promise((r) => kill.once("exit", r));
let serverLog = "";
try {
  serverLog = readFileSync(logPath, "utf8");
} catch {
  /* nothing written */
}
try {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
  /* left behind, harmless */
}

if (!ready) {
  console.log("  FAIL the server never answered /health");
  process.exit(1);
}
for (const line of results) console.log("  " + line);
const crashed = serverLog.trim().split(/\r?\n/).slice(-8).join("\n  ");
if (missing.length) console.log("--- server log tail ---\n  " + crashed);
for (const line of skipped) console.log(`  skip  ${line}`);
console.log(`  ${routes.length} routes, ${results.length} asked, ${skipped.length} skipped, ${missing.length} unreachable`);
process.exit(missing.length ? 1 : 0);
