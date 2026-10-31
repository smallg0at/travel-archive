// One-off verification that /server/restart still hands over after the
// extraction into server/restart.ts. Starts a throwaway server, asks it to
// restart, and checks that something answers on the same port afterwards.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(tmpdir(), "restart-probe-"));
const port = "19578";
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
const started = Date.now();
const startedIso = new Date(started).toISOString();
const at = () => String(Date.now() - started).padStart(5) + "ms";

const first = spawn(process.execPath, [entry], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let firstOut = "";
first.stdout.on("data", (b) => (firstOut += b));
first.stderr.on("data", (b) => (firstOut += b));
let firstExited = false;
first.once("exit", (code) => {
  firstExited = true;
  firstOut += `\n[${at()}] original exited code=${code}\n`;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const health = async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { "Accept-Encoding": "gzip" } });
    return res.status;
  } catch {
    return null;
  }
};

const report = [];
let ok = false;
try {
  for (let i = 0; i < 40 && (await health()) === null; i++) await sleep(250);
  report.push(`${at()} before: ${await health()}`);
  const res = await fetch(`http://127.0.0.1:${port}/server/restart`, { method: "POST" });
  report.push(`${at()} restart answered ${res.status} ${JSON.stringify(await res.json())}`);
  const timeline = [];
  let everDown = false;
  let after = null;
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    after = await health();
    if (after !== 200) everDown = true;
    timeline.push(`${at()}:${after ?? "down"}`);
    if (after === 200 && firstExited) break;
  }
  report.push("health timeline: " + timeline.filter((_, i) => i % 4 === 0).join(" "));
  report.push(`${at()} after: ${after}, everDown: ${everDown}, original exited: ${firstExited}`);
  ok = after === 200 && firstExited && everDown;
} catch (err) {
  report.push(`probe failed: ${err.message}`);
} finally {
  report.push("--- server output ---");
  report.push(firstOut.slice(-2500).trim() || "(nothing)");
  try {
    report.push("--- data/serve.log (tail) ---");
    report.push(readFileSync(join(home, "data", "serve.log"), "utf8").slice(-2500).trim());
  } catch (err) {
    report.push(`(no serve.log: ${err.message})`);
  }
  if (!firstExited) first.kill();
  // The replacement is detached and deliberately survives its parent, so it has
  // to be found afterwards. Two marks identify it: the port it listens on, and
  // the entry it was started with, no earlier than this probe began.
  const kill = spawn(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; ` +
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*pipeline\\dist\\serve.js*' -and $_.CreationDate -ge [datetime]'${startedIso}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  await new Promise((r) => kill.once("exit", r));
  await sleep(1500);
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    report.push(`(left ${home} behind — still locked)`);
  }
  console.log(report.map((l) => "  " + l).join("\n"));
  console.log(ok ? "  PASS restart handed over" : "  FAIL restart did not come back");
  process.exit(ok ? 0 : 1);
}
