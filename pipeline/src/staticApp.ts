import { createServer, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import { createReadStream } from "node:fs";
import { existsSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

/**
 * Serves `app/dist` — the job server's half of the web server.
 *
 * Until now the page came only from the desktop shell: `serveApp` lived in
 * `desktop/src/static.ts` and ran inside Electron. Nothing ever required that
 * pairing — the module is pure `node:http`, and the app page only cares that
 * *someone* answers on this port — but the practical effect was that a
 * reboot left the API up (the login chain) and the page down until a window
 * was opened, so a remote reader could reach `/health` and nothing else. This
 * file lets the same login chain bring up both, with no window involved.
 *
 * The shell keeps its copy and keeps working: whichever of the two binds the
 * port first serves it, and the loser reports "adopted" through the
 * `servesThisApp` probe that was already there for `run-preview.ps1`. The two
 * copies are kept honest by `pipeline/test/staticApp.test.ts`, which asserts
 * their Content-Security-Policy strings are identical — a policy edited in one
 * file and not the other turns the suite red rather than the page.
 *
 * The behaviour notes below are the shell's, kept as written:
 *
 *  - **Everything unmatched falls back to `index.html`**, so the app is a
 *    single-page app rather than a set of files. Asset requests are excluded
 *    (see `targetFor`), so a missing script 404s instead of being served an
 *    HTML page.
 *
 * The MSAL bridge is an ordinary file — `/auth.html` (`src/msalConfig.ts`) —
 * so it needs no directory-index rule of its own: a real path is served as
 * itself by Vite's preview server, this one, and Capacitor alike.
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

  // Directory index, which is how `/` finds index.html.
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
 * The origins this machine can be reached at over the network.
 *
 * **Enumerated, not patterned.** A CSP source cannot express a range or a
 * wildcard in the middle of a host: `http://192.168.*:*` is not valid and the
 * browser discards it, which would leave the policy with loopback origins only
 * and every LAN request refused — an empty archive with no error the reader
 * could see. There is also no CIDR syntax. So the machine's own private IPv4
 * addresses are listed one at a time, and a CSP source can be a literal.
 *
 * Read at listen time rather than at import: the address can change between
 * launches (DHCP), and a stale list is the same failure again.
 */
function networkOrigins(exposed: boolean): string[] {
  if (!exposed) return [];
  const out: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      // Private ranges only, so a public address in the policy cannot happen
      // even if this host is somehow reachable from outside.
      if (!/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))\./.test(address.address)) continue;
      out.push(`http://${address.address}`, `http://${address.address}:*`);
    }
  }
  return out;
}

/** Whether this server answers beyond loopback — what the CSP's extra origins depend on. */
function isExposed(host: string): boolean {
  return host !== "127.0.0.1" && host !== "localhost" && host !== "::1";
}

/**
 * The policy for one server, given whether it is reachable beyond loopback.
 *
 * Kept byte-for-byte with `desktop/src/static.ts` — the parity test in
 * `pipeline/test/staticApp.test.ts` compares the two outputs, so edit both
 * files or watch it fail. The reasoning for each directive lives in the
 * shell's copy; it is the same browser, the same CSP, and the comments belong
 * where the policy was first written.
 */
export function contentSecurityPolicy(exposed: boolean): string {
  const extra = networkOrigins(exposed).map((o) => ` ${o}`).join("");
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https: http://127.0.0.1:* http://localhost:*${extra}`,
    `media-src 'self' blob: https: http://127.0.0.1:* http://localhost:*${extra}`,
    "font-src 'self' data:",
    `connect-src 'self' http://127.0.0.1:* http://localhost:*${extra} https://graph.microsoft.com https://login.microsoftonline.com https:`,
    "frame-src https://login.microsoftonline.com",
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ");
}

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
 * All three outcomes are normal here: the shell may have started first (it
 * serves the page itself), `run-preview.ps1` may own the port during
 * development, or this process wins and everyone else adopts. A busy port is
 * never fatal — the job server's job is the API, and a page somebody else
 * serves is a page the reader gets.
 */
export async function serveApp(root: string, port: number, host = "127.0.0.1"): Promise<ServeResult> {
  const started = await listen(root, port, host);
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

function listen(root: string, port: number, host: string): Promise<Server | null> {
  const rootPath = resolve(root);
  // Decided once per server: whether this one answers beyond loopback, which is
  // what the policy's extra origins depend on.
  const csp = contentSecurityPolicy(isExposed(host));

  const server = createServer(async (req, res) => {
    try {
      const target = await targetFor(rootPath, req.url ?? "/");
      if (!(await fileExists(target))) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("Not found");
      }
      res.writeHead(200, {
        "Content-Type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream",
        "Content-Security-Policy": csp,
        // The build changes whenever the app is rebuilt, and a cached
        // index.html would keep loading stale asset hashes.
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
    server.listen(port, host, () => resolvePromise(server));
  });
}

/** `index.html` inside `dir`, if the built app is there at all. */
export function appDistIndex(dir: string): string | null {
  try {
    const index = join(resolve(dir), "index.html");
    return existsSync(index) && statSync(index).isFile() ? index : null;
  } catch {
    return null;
  }
}
