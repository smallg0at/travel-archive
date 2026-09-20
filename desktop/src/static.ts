import { createServer, type Server } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

/**
 * Serves `app/dist` the way Vite's preview server does.
 *
 * Deliberately not a generic static handler, because the app depends on two
 * behaviours a naive one gets wrong — and both fail in ways that look like an
 * auth bug rather than a routing bug:
 *
 *  - **`/auth/` must serve `auth/index.html`.** MSAL's redirect URI is
 *    `${origin}/auth/`, and app/src/msalConfig.ts documents that the trailing
 *    slash is load-bearing: Vite resolves the directory index only for the
 *    exact path, and `/auth` without it falls through to the SPA fallback and
 *    serves the main app instead — which silently breaks the popup handoff,
 *    because the bridge page never runs.
 *  - **Everything unmatched falls back to `index.html`**, so the app is a
 *    single-page app rather than a set of files.
 */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Maps a URL path to a file inside `root`, or null when it escapes.
 *
 * The traversal check is not ceremony: this server is reachable from the
 * renderer, which runs remote-influenced content, and `..` in a request path
 * would otherwise read anything the user can read.
 */
function resolveWithin(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const candidate = resolve(join(root, normalize(decoded)));
  return candidate === root || candidate.startsWith(root + sep) ? candidate : null;
}

async function targetFor(root: string, urlPath: string): Promise<string> {
  const within = resolveWithin(root, urlPath);
  if (!within) return join(root, "index.html");

  // Directory index, which is what makes `/auth/` work.
  if (urlPath.endsWith("/")) {
    const index = join(within, "index.html");
    if (await fileExists(index)) return index;
  }

  if (await fileExists(within)) return within;

  // SPA fallback. Asset requests are excluded so a genuinely missing script
  // 404s instead of being served an HTML page, which would otherwise surface
  // as an opaque syntax error in the console.
  return extname(urlPath) ? within : join(root, "index.html");
}

/**
 * A Content-Security-Policy for the app the shell serves.
 *
 * Electron warns on every renderer that has none, and the warning was right:
 * there was no policy at all. It is deliberately loose where the app really
 * does reach outward and tight everywhere else.
 *
 * - `script-src` allows inline, because both pages bootstrap the theme from an
 *   inline `<script>` before the stylesheets paint, and a hash would have to
 *   be regenerated on every edit of that block. It does **not** allow
 *   `unsafe-eval`, which is the part Electron actually warns about.
 * - `img-src https:` because thumbnails come from whichever OneDrive CDN host
 *   Graph hands out that hour, and `blob:` for the ones the app builds itself.
 * - `connect-src` is Graph, the sign-in host, and the job server on loopback.
 * - `frame-src` is the sign-in host alone: MSAL renews tokens in a hidden
 *   iframe, and without this the session would die silently after an hour.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' http://127.0.0.1:* http://localhost:* https://graph.microsoft.com https://login.microsoftonline.com",
  "frame-src https://login.microsoftonline.com",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

/** What `serveApp` found: the server it started, or what already held the port. */
export type ServeResult =
  | { kind: "serving"; server: Server }
  /** Something else is on the port and it is serving this app — reuse it. */
  | { kind: "adopted" }
  /** Something else is on the port and it is not this app. */
  | { kind: "occupied"; by: string };

/**
 * Starts the static server, or reports what already holds the port.
 *
 * A busy port is the normal case during development — `run-preview.ps1` or a
 * Vite dev server already owns it — so it is treated as "somebody is already
 * serving this" and the window loads it, rather than as a fatal error. But
 * "somebody" used to be taken on trust: whatever answered that port had the
 * window pointed at it, and an unrelated service would have been shown to the
 * owner as their archive. It is now asked for the page first, and only adopted
 * if what comes back is this app.
 */
export async function serveApp(root: string, port: number): Promise<ServeResult> {
  const started = await listen(root, port);
  if (started) return { kind: "serving", server: started };
  return (await servesThisApp(port)) ? { kind: "adopted" } : { kind: "occupied", by: await describe(port) };
}

/** Whether whatever owns the port answers with this app's own page. */
async function servesThisApp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const html = await res.text();
    // The shell's own markup, and Vite's dev entry for the same page, both
    // carry this id; a stranger's page will not.
    return html.includes('id="app"') || html.includes("/src/main.ts");
  } catch {
    return false;
  }
}

/** A line about whatever holds the port, for the error the owner sees. */
async function describe(port: number): Promise<string> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    return `HTTP ${res.status} ${res.headers.get("content-type") ?? "unknown type"}`;
  } catch (err) {
    return (err as Error).message;
  }
}

function listen(root: string, port: number): Promise<Server | null> {
  const rootPath = resolve(root);

  const server = createServer(async (req, res) => {
    try {
      const target = await targetFor(rootPath, req.url ?? "/");
      if (!(await fileExists(target))) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("Not found");
      }
      res.writeHead(200, {
        "Content-Type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream",
        "Content-Security-Policy": CSP,
        // The shell serves a build that changes whenever the app is rebuilt,
        // and a cached index.html would keep loading stale asset hashes.
        "Cache-Control": "no-cache",
      });
      createReadStream(target).pipe(res);
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal error");
    }
  });

  return new Promise((resolvePromise, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") return resolvePromise(null);
      reject(err);
    });
    // 127.0.0.1, not 0.0.0.0: this serves the owner's archive viewer and has no
    // business being reachable from the LAN, for the same reason the job server
    // binds loopback only.
    server.listen(port, "127.0.0.1", () => resolvePromise(server));
  });
}
