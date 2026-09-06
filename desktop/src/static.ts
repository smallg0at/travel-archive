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
 * Starts the static server, or resolves null when the port is already taken.
 *
 * A busy port is the normal case during development — `run-preview.ps1` or a
 * Vite dev server already owns 4173 — so it is treated as "somebody is already
 * serving this" and the window simply loads it, rather than as a fatal error.
 */
export function serveApp(root: string, port: number): Promise<Server | null> {
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
