import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Who may do what, once the server is reachable beyond this machine.
 *
 * The job server has always bound loopback, so none of this existed: every
 * request came from this machine and was this machine's own. Setting
 * `ARCHIVE_HOST=0.0.0.0` puts the archive on the home network, and then two
 * questions appear that the loopback assumption had answered for free —
 * **who can read** and **who can write**.
 *
 * **Read is the whole product; write is the owner's alone.** A shared password
 * gates reading, and anything that is not a read is refused to everyone but
 * this machine. That is a rule about *kind*, not about accounts: there are no
 * users, no roles and no session store, because a family reading a photo
 * archive does not need them and every one of them would be more code to get
 * wrong. A single cookie, signed with a secret generated at startup, is the
 * whole of the session.
 *
 * What is deliberately **not** here: the screenshot gate. It needs to know which
 * items are screenshots, which lives in the shards; see serve.ts's media routes.
 */

/** How long a sign-in lasts. Long, because the alternative is a family member
 *  retyping a password to look at holiday photos. */
const SESSION_DAYS = 30;

const COOKIE_NAME = "archive_access";

export interface AccessConfig {
  /** null when bound to loopback: nothing is gated, there is no outside. */
  password: string | null;
  /** True when the server answers on something other than loopback. */
  exposed: boolean;
}

export interface Access {
  /** Whether this request is the owner's own machine. */
  isLocal(req: IncomingMessage): boolean;
  /** Whether this request may read. Local is always true; remote needs the cookie. */
  canRead(req: IncomingMessage): boolean;
  /** Whether this request may write. Local only, always. */
  canWrite(req: IncomingMessage): boolean;
  /** Sets the session cookie for a correct password. False when it is wrong. */
  signIn(res: ServerResponse, offered: string | undefined): boolean;
  /** True when the given password is the configured one. */
  check(offered: string | undefined): boolean;
  /** Whether a password is configured at all — the shell reports this to the app. */
  readonly gated: boolean;
}

/**
 * `remoteAddress` is the only thing trusted here, and only because nothing
 * proxies this server: the owner's setup forces loopback traffic direct, so the
 * socket address is the real peer. Behind a proxy this would need `X-Forwarded-For`
 * and a trust list, which is exactly the kind of thing that gets done wrongly —
 * so it is not done at all.
 */
function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === "::1" || addr === "127.0.0.1" || addr === "::ffff:127.0.0.1";
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
  }
  return out;
}

/** Constant-time compare, on hashes so the lengths always match. */
function secretEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function makeAccess(cfg: AccessConfig): Access {
  // A fresh secret each start: it invalidates every cookie when the server
  // restarts, which is the honest behaviour for a token nobody can revoke.
  const secret = randomBytes(32);

  /** A session value bound to the secret, so a cookie cannot be forged. */
  const sessionFor = (): string => {
    const issued = Date.now().toString(36);
    const mac = createHash("sha256").update(`${issued}.${secret.toString("hex")}`).digest("hex");
    return `${issued}.${mac}`;
  };

  const sessionValid = (value: string | undefined): boolean => {
    if (!value) return false;
    const [issued, mac] = value.split(".");
    if (!issued || !mac) return false;
    const age = Date.now() - parseInt(issued, 36);
    if (!Number.isFinite(age) || age < 0 || age > SESSION_DAYS * 86_400_000) return false;
    const expected = createHash("sha256").update(`${issued}.${secret.toString("hex")}`).digest("hex");
    return secretEquals(mac, expected);
  };

  const check = (offered: string | undefined): boolean =>
    Boolean(cfg.password && offered !== undefined && secretEquals(offered, cfg.password));

  const isLocal = (req: IncomingMessage): boolean => isLoopback(req.socket.remoteAddress);

  return {
    isLocal,
    gated: Boolean(cfg.password),

    canWrite: (req) => isLocal(req),

    canRead: (req) => {
      // Bound loopback, or no password set: nothing to gate. The second case is
      // the owner's explicit choice — `ARCHIVE_HOST=0.0.0.0` with no
      // `ARCHIVE_PASSWORD` means "open on my network", and the startup line says
      // so in those words.
      if (!cfg.exposed || !cfg.password) return true;
      if (isLocal(req)) return true;
      return sessionValid(parseCookies(req.headers.cookie)[COOKIE_NAME]);
    },

    check,

    signIn: (res, offered) => {
      if (!check(offered)) return false;
      const value = sessionFor();
      res.setHeader(
        "Set-Cookie",
        `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; Max-Age=${SESSION_DAYS * 86_400}; HttpOnly; SameSite=Lax`,
      );
      return true;
    },
  };
}
