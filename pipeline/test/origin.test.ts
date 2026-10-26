import { describe, expect, it } from "vitest";
import { hostname } from "node:os";
import { hostAllowed, originAllowed } from "../src/originCheck.js";

/**
 * The rule that decides whether a page may talk to the server.
 *
 * Worth testing precisely because it is a security decision that a reader
 * cannot see: getting it wrong is either a reader who cannot load the archive
 * by name (the bug this replaced) or a page on the internet that can. Nothing
 * here resolves a name — see originCheck.ts for why DNS would be the wrong
 * answer.
 */
const EXPOSED = { exposed: true };
const LOOPBACK_ONLY = { exposed: false };
const own = hostname();

describe("loopback origins", () => {
  it("are allowed however the page was served, on any port", () => {
    // The shell is localhost:17923, a preview localhost:4173, and the phone's
    // WebView is itself https://localhost — none of which turns on how this
    // machine is named.
    for (const origin of [
      "http://localhost:17923",
      "http://localhost:4173",
      "http://localhost:5173",
      "https://localhost",
      "http://127.0.0.1:17923",
      "http://127.0.0.1:12345",
      "http://[::1]:17923",
    ]) {
      expect(originAllowed(origin, EXPOSED), origin).toBe(true);
      expect(originAllowed(origin, LOOPBACK_ONLY), origin).toBe(true);
    }
  });
});

describe("a server bound to loopback", () => {
  it("takes no page from the network", () => {
    // Nothing outside can reach it, so nothing outside needs to be allowed to
    // call it — which is stricter than this used to be.
    for (const origin of [
      "http://192.168.7.7:17923",
      `http://${own}:17923`,
      `http://${own}.local:17923`,
      "http://mypc:17923",
    ]) {
      expect(originAllowed(origin, LOOPBACK_ONLY), origin).toBe(false);
    }
  });
});

describe("an exposed server", () => {
  it("accepts every way it is addressed, on an app port", () => {
    for (const origin of [
      "http://192.168.7.7:17923",
      "http://10.1.2.3:5173",
      "http://172.20.10.2:4173",
      "http://169.254.7.7:17923",
      `http://${own}:17923`,
      `http://${own.toUpperCase()}:17923`,
      `http://${own}.local:17923`,
      "http://mypc:17923",
      "http://DESKTOP-KITCHEN:17923",
      "http://nas.local:17923",
      "http://[fd00::1]:17923",
      "http://[fe80::1]:17923",
    ]) {
      expect(originAllowed(origin, EXPOSED), origin).toBe(true);
    }
  });

  it("refuses a public name, a rebinding trick, or an unexpected port", () => {
    for (const origin of [
      "https://evil.com",
      "http://evil.com:17923",
      // The standard rebinding demonstration: a public name that answers with
      // 127.0.0.1, so the browser calls it same-origin after the page loads.
      "http://127.0.0.1.nip.io:17923",
      "http://localhost.localtest.eu:17923",
      "http://8.8.8.8:17923",
      "http://192.168.7.7:8080",
      "http://mypc:22",
      "null",
      "file:///etc/passwd",
      "javascript:alert(1)",
    ]) {
      expect(originAllowed(origin, EXPOSED), origin).toBe(false);
    }
  });

  it("takes extra names from ARCHIVE_EXTRA_HOSTS, read per call", () => {
    const previous = process.env.ARCHIVE_EXTRA_HOSTS;
    process.env.ARCHIVE_EXTRA_HOSTS = "router.example, othervm.local";
    try {
      expect(originAllowed("http://router.example:17923", EXPOSED)).toBe(true);
      expect(originAllowed("http://othervm.local:17923", EXPOSED)).toBe(true);
      expect(originAllowed("http://unknown.example:17923", EXPOSED)).toBe(false);
      // Reading it per call means a `.env` edit counts without a restart, and
      // clearing it takes the names back.
      process.env.ARCHIVE_EXTRA_HOSTS = "";
      expect(originAllowed("http://router.example:17923", EXPOSED)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.ARCHIVE_EXTRA_HOSTS;
      else process.env.ARCHIVE_EXTRA_HOSTS = previous;
    }
  });
});

describe("Host header", () => {
  it("accepts how this server is actually addressed", () => {
    for (const header of [
      "127.0.0.1:18419",
      "localhost:18419",
      "[::1]:18419",
      `192.168.1.9:17923`,
      "192.168.1.9",
      `${own}:17923`,
      `${own.toLowerCase()}.local:17923`,
    ]) {
      expect(hostAllowed(header, EXPOSED), header).toBe(true);
    }
  });

  it("refuses a public name, which is what DNS rebinding sends", () => {
    // The attacker's page resolves evil.example to 127.0.0.1 and then asks the
    // loopback server with this Host. The socket looks local; the name is not.
    expect(hostAllowed("evil.example:18419", EXPOSED)).toBe(false);
    expect(hostAllowed("evil.example", LOOPBACK_ONLY)).toBe(false);
    expect(hostAllowed("127.0.0.1.nip.io:18419", EXPOSED)).toBe(false);
  });

  it("refuses any name but loopback when not exposed", () => {
    expect(hostAllowed("192.168.1.9:18419", LOOPBACK_ONLY)).toBe(false);
    expect(hostAllowed("othervm.local:18419", LOOPBACK_ONLY)).toBe(false);
  });

  it("refuses a missing or malformed header", () => {
    expect(hostAllowed(undefined, EXPOSED)).toBe(false);
    expect(hostAllowed("", EXPOSED)).toBe(false);
    expect(hostAllowed("[::1:18419", EXPOSED)).toBe(false);
  });
});
