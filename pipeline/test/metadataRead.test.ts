import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A metadata read that fails is not a metadata read that found nothing.
 *
 * On 2026-11-13 a content download failed five times, `downloadMetadataJson`
 * turned that into null, `loadIndex` turned null into an empty archive, and a
 * scan rewrote the index from the one month it had just walked — 33,059
 * records down to 109. Only the shrink guard stopped it. These two cases are
 * the contract that keeps that from being possible again.
 */
describe("downloadMetadataJson", () => {
  const original = process.env.ALLOW_LIVE_ONEDRIVE;

  beforeEach(() => {
    process.env.ALLOW_LIVE_ONEDRIVE = "1";
  });

  afterEach(() => {
    if (original === undefined) delete process.env.ALLOW_LIVE_ONEDRIVE;
    else process.env.ALLOW_LIVE_ONEDRIVE = original;
    vi.unstubAllGlobals();
  });

  it("returns null when the file really is absent", async () => {
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    const { downloadMetadataJson } = await import("../src/graph.js");
    await expect(downloadMetadataJson("tok", "metadata", "index.json")).resolves.toBeNull();
  });

  it("throws when the read failed for any other reason", async () => {
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));
    const { downloadMetadataJson } = await import("../src/graph.js");
    await expect(downloadMetadataJson("tok", "metadata", "index.json")).rejects.toThrow(/500/);
  });
});
