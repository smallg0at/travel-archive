#!/usr/bin/env node
/**
 * Live preview of the app against the real archive, without building the
 * installer.
 *
 * The desktop shell serves a bundled copy of the app, so seeing a CSS change
 * meant `app build` + `desktop dist` + a silent install — about two minutes for
 * one padding value. Vite serves the same app at another origin, and the job
 * server already allows it (see pipeline/src/originCheck.ts: APP_PORTS), so the
 * dev server here is a full preview with hot reload: save a style and the pane
 * repaints.
 *
 *   node scripts/preview.mjs            # http://localhost:4173
 *   node scripts/preview.mjs --port 4173
 *
 * Reads pipeline/.env for the Azure ids, and the archive the installed app
 * uses unless ARCHIVE_HOME says otherwise. Port 5173 is Vite's default but sits
 * inside a Windows reserved range on this machine (netsh int ipv4 show
 * excludedportrange), where binding fails with EACCES.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1").replace(/\/$/, "");
const PORT = process.argv.includes("--port")
  ? process.argv[process.argv.indexOf("--port") + 1]
  : process.env.DESKTOP_PORT_PREVIEW || "4173";

/** `pipeline/.env` as environment, without letting it override a real one. */
function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (!process.env[match[1]]) process.env[match[1]] = value;
  }
}

loadEnvFile(join(ROOT, "pipeline", ".env"));

const installedHome = join(homedir(), "AppData", "Roaming", "Photo Archive");
process.env.ARCHIVE_HOME ??= existsSync(join(installedHome, "data", "index.json")) ? installedHome : ROOT;
process.env.SERVE_PORT ??= "18419";

if (!existsSync(join(ROOT, "pipeline", "dist", "serve.js"))) {
  console.error("pipeline/dist is missing — run: npm run --workspace pipeline build");
  process.exit(1);
}

const children = [];
function run(name, command, args, options = {}) {
  const child = spawn(command, args, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32", ...options });
  child.on("exit", (code) => {
    if (code && code !== 0) console.error(`[preview] ${name} exited with ${code}`);
  });
  children.push(child);
  return child;
}

const stop = () => {
  for (const child of children) if (!child.killed) child.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

/**
 * 18419 is fixed in the app's own code (backend.ts), so preview and the
 * installed app contend for it. Starting here while the installed app is
 * running silently took the port from it — and then the app's About pane
 * reported the repo's version, because it was answering. Reuse it instead.
 */
const already = await fetch(`http://127.0.0.1:${process.env.SERVE_PORT}/health`)
  .then((r) => r.ok)
  .catch(() => false);

console.log(`[preview] archive: ${process.env.ARCHIVE_HOME}`);
if (already) {
  console.log(`[preview] a server is already on ${process.env.SERVE_PORT} — using it, not starting another`);
} else {
  run("server", process.execPath, [join(ROOT, "pipeline", "dist", "serve.js")], { cwd: join(ROOT, "pipeline") });
}
run("vite", process.execPath, [
  // The app's own Vite (7.x), not whatever the repo root hoisted: the root has
  // 8.x and its config loader already warns about this config.
  join(ROOT, "app", "node_modules", "vite", "bin", "vite.js"),
  // Run from `app/` so the project root — and therefore index.html — is the
  // app, not the repo; passing --config alone made every request 404.
  "--host",
  "127.0.0.1",
  "--port",
  PORT,
  "--strictPort",
], { cwd: join(ROOT, "app") });
console.log(`[preview] open http://localhost:${PORT}/ — save a style and it repaints`);
