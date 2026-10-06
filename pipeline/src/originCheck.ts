import { hostname } from "node:os";

/**
 * Which page origin may talk to this server — and, for a write, which may ask.
 *
 * The old rule matched private IP literals against three ports. That covers
 * `http://192.168.x.y:17923` and nothing else, so a reader who typed the
 * machine's **name** instead of its address — `http://nas:17923`,
 * `http://desktop.local:17923` — got no `Access-Control-Allow-Origin` and, for
 * a POST, an outright 403.
 *
 * The tempting fix is to resolve the name and accept whatever is private. That
 * is the one thing not to do: **DNS rebinding** lets a public name answer with
 * 127.0.0.1 after the page has loaded, and by the time this check runs the
 * answer is the attacker's. `127.0.0.1.nip.io` is the standard demonstration.
 * So nothing here resolves anything. The rule is a literal comparison against
 * names we can be sure of: our own, `*.local` (which public DNS is not allowed
 * to hand out), single-label names (which public DNS cannot have either), and
 * private address literals.
 *
 * The shape follows who can reach us:
 *
 *   **Loopback names always pass.** The desktop shell serves the app from
 *   `localhost`, a preview from `localhost:4173`, and the phone's WebView is
 *   itself `https://localhost` — none of which depends on how the machine is
 *   named or on the port the page came from.
 *
 *   **A server bound to loopback accepts only loopback pages.** If nothing
 *   outside can reach the server, no page outside has any business calling it;
 *   allowing a LAN origin here would be granting reachability the network does
 *   not have. (Before this rule it did the opposite, and allowed LAN origins
 *   against a server only this machine could talk to.)
 *
 *   **An exposed server accepts the ways it is actually addressed**: private
 *   address literals, this machine's name and its mDNS form, single-label and
 *   `*.local` names, each on one of the app's own ports. Anything else —
 *   a public domain on any port, an odd port on a good name — is refused. An
 *   exposed server also has the shared password, whose cookie is `SameSite=Lax`
 *   and so is not carried into a cross-site request either.
 *
 * `ARCHIVE_EXTRA_HOSTS` (comma- or space-separated, in `.env`) names anything
 * else this install is reached by — a router alias, a DDNS label. There is no
 * way to tell an arbitrary legitimate name from an arbitrary hostile one, so
 * unknown names are not guessed at: they are configured.
 */

/** The ports the app itself is served on: the shell, and Vite's dev/preview. */
const APP_PORTS = new Set(["4173", "5173", "17923"]);

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

/** `[...]` is how a URL writes an IPv6 literal; brackets are not part of it. */
const bare = (host: string): string => host.replace(/^\[|\]$/g, "");

const isIpv4 = (host: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(host);

/** RFC 1918, plus carrier NAT and loopback for completeness. */
function isPrivateIpv4(host: string): boolean {
  const [a, b] = host.split(".").map(Number);
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** Unique-local `fc00::/7` and link-local `fe80::/10`. */
function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  return h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:");
}

/** This machine's own names: `DESKTOP-X` and the mDNS form of it. */
function ownNames(): string[] {
  const name = hostname();
  return [name.toLowerCase(), `${name.toLowerCase()}.local`];
}

/** Extra names this install is read by. Read per call so a `.env` edit counts without a restart. */
function extraNames(): string[] {
  return (process.env.ARCHIVE_EXTRA_HOSTS ?? "")
    .split(/[\s,;]+/)
    .map((n) => n.toLowerCase().replace(/^\[|\]$/g, ""))
    .filter(Boolean);
}

export interface OriginContext {
  /** Whether the server answers beyond loopback — `exposed` in remoteAccess.ts. */
  exposed: boolean;
}

export function originAllowed(origin: string, ctx: OriginContext): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  const host = bare(url.hostname).toLowerCase();

  // The shell, a preview, the phone's own WebView: reachable however this
  // machine is named, and whatever port the page came from.
  if (LOOPBACK.has(host)) return true;

  // Nothing outside can reach a loopback-bound server, so nothing outside
  // needs to be allowed to call it.
  if (!ctx.exposed) return false;

  if (!APP_PORTS.has(url.port)) return false;
  if (ownNames().includes(host) || extraNames().includes(host)) return true;
  // A literal address: private means "this network", as before.
  if (isIpv4(host)) return isPrivateIpv4(host);
  if (host.includes(":")) return isPrivateIpv6(host);
  // Single-label and `.local` are what mDNS and a home router hand out; the
  // public DNS namespace has neither, which is what makes them usable here.
  if (!host.includes(".")) return true;
  if (host.endsWith(".local")) return true;
  return false;
}
