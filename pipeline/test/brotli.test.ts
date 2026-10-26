import { describe, expect, it } from "vitest";
import { assertNoBrotli } from "@travel-archive/shared";

/**
 * The guard for CVE-2026-111497. Node's Brotli decoder runs lazily when the
 * body is read, so refusing a response by its `content-encoding` — before any
 * read — keeps the decoder away from the bytes entirely.
 */
describe("assertNoBrotli", () => {
  const url = "https://graph.microsoft.com/v1.0/me/drive/items/abc/content";

  it("refuses br and cancels the body", () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel: () => void (cancelled = true) });
    const response = new Response(body, { headers: { "content-encoding": "br" } });
    expect(() => assertNoBrotli(response, url)).toThrow(/CVE-2026-111497/);
    expect(cancelled).toBe(true);
  });

  it("refuses br in a list of encodings", () => {
    const response = new Response("x", { headers: { "content-encoding": "gzip, br" } });
    expect(() => assertNoBrotli(response, url)).toThrow(/Brotli/);
  });

  it("accepts gzip, identity and no header", () => {
    for (const encoding of ["gzip", "deflate", "", null]) {
      const headers = encoding ? { "content-encoding": encoding } : undefined;
      const response = new Response("x", { headers });
      expect(() => assertNoBrotli(response, url)).not.toThrow();
    }
  });

  it("keeps the query string out of the message", () => {
    // OneDrive download URLs carry a pre-authenticated token in the query, and
    // the message lands in a job log the owner can open.
    const signed = "https://g.example.com/content?tempauth=SECRET-TOKEN&x=1";
    const response = new Response("x", { headers: { "content-encoding": "br" } });
    try {
      assertNoBrotli(response, signed);
    } catch (error) {
      expect((error as Error).message).not.toContain("SECRET-TOKEN");
      expect((error as Error).message).toContain("g.example.com/content");
    }
  });
});
