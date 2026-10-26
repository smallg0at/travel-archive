import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { makeAccess } from "../src/access.js";

/**
 * A remote client controls its own `Cookie` header, including its escapes.
 * `decodeURIComponent("%")` throws, and the call sites sit in the request
 * handler: the throw became an unhandled rejection instead of a 401, so a
 * malformed cookie hung the connection and filled the log. Garbage must be
 * answered like a wrong credential — that is a decision, not an exception.
 */

function request(remoteAddress: string, cookie?: string): IncomingMessage {
  return {
    socket: { remoteAddress },
    headers: cookie ? { cookie } : {},
  } as unknown as IncomingMessage;
}

const REMOTE = "192.168.1.40";
const LOCAL = "127.0.0.1";

describe("access", () => {
  const access = makeAccess({ password: "hunter2", exposed: true });

  it("treats a malformed escape as an invalid session, not a crash", () => {
    expect(() => access.canRead(request(REMOTE, "archive_access=%"))).not.toThrow();
    expect(access.canRead(request(REMOTE, "archive_access=%"))).toBe(false);
    expect(access.canRead(request(REMOTE, "archive_access=%ZZ"))).toBe(false);
  });

  it("still accepts a well-formed signed cookie", () => {
    const cookies: string[] = [];
    const res = {
      setHeader: (name: string, value: string) => {
        if (name.toLowerCase() === "set-cookie") cookies.push(value);
      },
    } as unknown as Parameters<typeof access.signIn>[0];

    expect(access.signIn(res, "hunter2")).toBe(true);
    const pair = cookies[0].split(";")[0];
    expect(access.canRead(request(REMOTE, pair))).toBe(true);
  });

  it("reports exposure separately from whether a password is set", () => {
    // The open-on-my-network case: exposed, not gated. `/access` used to
    // report `exposed: gated`, so this state claimed it was not exposed.
    const open = makeAccess({ password: null, exposed: true });
    expect(open.exposed).toBe(true);
    expect(open.gated).toBe(false);

    const loopback = makeAccess({ password: null, exposed: false });
    expect(loopback.exposed).toBe(false);
  });

  it("keeps writes to this machine", () => {
    expect(access.canWrite(request(LOCAL))).toBe(true);
    expect(access.canWrite(request(REMOTE))).toBe(false);
  });
});
