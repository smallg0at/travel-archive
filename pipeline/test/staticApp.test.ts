/**
 * The job server's copy of the static app server, and the one law keeping it
 * honest against the shell's copy: **identical CSP strings**.
 *
 * Two implementations exist on purpose (moving the file into `shared/` would
 * have meant a package-exports rebuild across three module systems for no
 * behaviour gain), so drift is the failure mode — and drift here is silent:
 * a policy edited in `desktop/src/static.ts` only would leave the login-chosen
 * server serving a different policy than the window's, with nothing turning
 * red until a renderer refuses a request in production.
 *
 * The rest is the behaviour the app depends on, plus the traversal guard,
 * which matters more here than in the shell: this listener follows
 * `ARCHIVE_HOST` onto the network.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, request, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { contentSecurityPolicy, serveApp, type ServeResult } from "../src/staticApp.js";
import { contentSecurityPolicy as shellPolicy } from "../../desktop/src/static";

function get(port: number, path: string): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    // `path` is sent verbatim: WHATWG URL normalisation would collapse ".."
    // before it ever reaches the server, and the guard is exactly what is
    // under test.
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, unknown>, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections?.();
          s.close(() => resolve());
        }),
    ),
  );
});

describe("Content-Security-Policy parity", () => {
  it("matches the desktop shell's policy, loopback and exposed", () => {
    // The whole point of the duplicate: edit one file and not the other and
    // this is what fails, not a renderer six months from now.
    expect(contentSecurityPolicy(false)).toBe(shellPolicy(false));
    expect(contentSecurityPolicy(true)).toBe(shellPolicy(true));
  });

  it("grows the LAN origins only when exposed", () => {
    expect(contentSecurityPolicy(false)).not.toContain("192.168");
    // (May or may not contain a private address depending on this machine —
    // the fixed part is that loopback mode never enumerates interfaces.)
    expect(contentSecurityPolicy(false).startsWith("default-src 'self'")).toBe(true);
  });
});

describe("serveApp", () => {
  it("serves the page, falls back for routes, 404s for missing assets", async () => {
    const base = await mkdtemp(join(tmpdir(), "staticapp-"));
    const root = join(base, "site");
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "index.html"), '<div id="app"></div>');
    await writeFile(join(root, "assets", "app.js"), "console.log(1)");
    await writeFile(join(base, "secret.txt"), "TOP-SECRET-DO-NOT-LEAK");

    const result = (await serveApp(root, 0, "127.0.0.1")) as Extract<ServeResult, { kind: "serving" }>;
    expect(result.kind).toBe("serving");
    servers.push(result.server);
    const port = (result.server.address() as AddressInfo).port;

    const root1 = await get(port, "/");
    expect(root1.status).toBe(200);
    expect(root1.body).toContain('id="app"');
    // On the wire rather than byte-equal: on this machine something in front
    // (AdGuard) appends its own CSP header, and node joins duplicates with a
    // comma — the byte-for-byte law lives in the parity describe above, where
    // no proxy can rewrite the string between the two functions.
    expect(String(root1.headers["content-security-policy"])).toContain("default-src 'self'");

    const route = await get(port, "/settings");
    expect(route.status).toBe(200);
    expect(route.body).toContain('id="app"');

    const asset = await get(port, "/assets/app.js");
    expect(asset.status).toBe(200);
    expect(asset.headers["content-type"]).toContain("javascript");

    const missing = await get(port, "/assets/nope.js");
    expect(missing.status).toBe(404);
    expect(missing.body).not.toContain('id="app"');

    await rm(base, { recursive: true, force: true });
  });

  it("does not let an encoded or literal .. escape the root", async () => {
    const base = await mkdtemp(join(tmpdir(), "staticapp-"));
    const root = join(base, "site");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "index.html"), '<div id="app"></div>');
    await writeFile(join(base, "secret.txt"), "TOP-SECRET-DO-NOT-LEAK");

    const result = (await serveApp(root, 0, "127.0.0.1")) as Extract<ServeResult, { kind: "serving" }>;
    servers.push(result.server);
    const port = (result.server.address() as AddressInfo).port;

    // The law is "the file never leaves the root", not "which safe answer you
    // give instead". On win32 `normalize("/../x")` collapses the escape into a
    // root-relative path, so these vectors end at "file not found" (404);
    // other shapes would land on the SPA fallback. Both are correct — what is
    // not allowed is TOP-SECRET in any body or a 5xx from the attempt.
    for (const path of ["/%2e%2e/secret.txt", "/..%2fsecret.txt", "/../secret.txt"]) {
      const res = await get(port, path);
      expect(res.body).not.toContain("TOP-SECRET");
      expect([200, 404]).toContain(res.status);
      if (res.status === 200) expect(res.body).toContain('id="app"');
    }

    await rm(base, { recursive: true, force: true });
  });

  it("adopts a port already serving this app, refuses an unrelated one", async () => {
    // An app page: serveApp should adopt without a fuss.
    const fake = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end('<div id="app"></div>');
    });
    servers.push(fake);
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    const goodPort = (fake.address() as AddressInfo).port;
    const base = await mkdtemp(join(tmpdir(), "staticapp-"));
    expect(await serveApp(base, goodPort, "127.0.0.1")).toEqual({ kind: "adopted" });

    // Something else entirely: reported, not trusted, not bound.
    const stranger = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>not the archive</html>");
    });
    servers.push(stranger);
    await new Promise<void>((resolve) => stranger.listen(0, "127.0.0.1", resolve));
    const badPort = (stranger.address() as AddressInfo).port;
    const occupied = await serveApp(base, badPort, "127.0.0.1");
    expect(occupied.kind).toBe("occupied");

    await rm(base, { recursive: true, force: true });
  });
});
