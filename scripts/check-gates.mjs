/**
 * Ask a built server the two security questions a unit test cannot:
 *
 *   1. Does a request whose `Host` is a public name get refused (DNS
 *      rebinding), while loopback and a private address are accepted?
 *   2. Does a sixth wrong password from one address return 429, and does the
 *      correct password stay blocked until the window passes?
 *
 * It starts `desktop/staging/pipeline/dist/server.mjs` (run
 * `npm run --workspace pipeline build && node desktop/scripts/bundle-pipeline.mjs`
 * first) against a throwaway home, on ports the OS chooses, with the server
 * exposed and a password set. No OneDrive, no credentials.
 *
 * Usage: node scripts/check-gates.mjs [--server path/to/server.mjs]
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import net from "node:net";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const arg = process.argv.indexOf("--server");
const SERVER =
  arg >= 0 ? resolve(process.argv[arg + 1]) : join(ROOT, "desktop/staging/pipeline/dist/server.mjs");

const PASSWORD = "correct-horse-battery";
const results = [];
const check = (ok, what, detail) => results.push({ ok, what, detail });

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

function request(port, method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitFor(port) {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await request(port, "GET", "/health")).status === 200) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const home = await mkdtemp(join(tmpdir(), "gates-"));
const servePort = await freePort();
const pagePort = await freePort();
const server = spawn(process.execPath, [SERVER], {
  env: {
    ...process.env,
    ARCHIVE_HOME: home,
    SERVE_PORT: String(servePort),
    DESKTOP_PORT: String(pagePort),
    ARCHIVE_HOST: "0.0.0.0",
    ARCHIVE_PASSWORD: PASSWORD,
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));

try {
  if (!(await waitFor(servePort))) {
    console.log(`server did not answer\n${log.split(/\r?\n/).slice(-6).join("\n")}`);
    process.exit(1);
  }

  const loopback = await request(servePort, "GET", "/health", { Host: `127.0.0.1:${servePort}` });
  check(loopback.status === 200, "Host: loopback is accepted", `${loopback.status}`);

  const privateAddress = await request(servePort, "GET", "/health", { Host: `192.168.1.9:${servePort}` });
  check(privateAddress.status === 200, "Host: a private address is accepted", `${privateAddress.status}`);

  const rebound = await request(servePort, "GET", "/health", { Host: `evil.example:${servePort}` });
  check(rebound.status === 421, "Host: a public name is refused", `${rebound.status}`);

  let last;
  for (let i = 0; i < 6; i++) {
    last = await request(
      servePort,
      "POST",
      "/access",
      { "Content-Type": "application/json" },
      JSON.stringify({ password: "wrong" }),
    );
  }
  check(last.status === 429, "six wrong passwords are throttled", `${last.status}`);

  const whileBlocked = await request(
    servePort,
    "POST",
    "/access",
    { "Content-Type": "application/json" },
    JSON.stringify({ password: PASSWORD }),
  );
  check(whileBlocked.status === 429, "the block also covers the right password", `${whileBlocked.status}`);
} finally {
  server.kill();
  await rm(home, { recursive: true, force: true });
}

for (const r of results) console.log(`${r.ok ? "pass" : "FAIL"}  ${r.what}  — ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} gate checks passed`);
process.exit(failed ? 1 : 0);
