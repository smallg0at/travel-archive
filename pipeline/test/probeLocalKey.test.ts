import { afterEach, describe, expect, it, vi } from "vitest";
import { validateProvider } from "../src/providers/index.js";

/**
 * LM Studio started requiring an API key for its own localhost server: on this
 * machine, `GET :12345/v1/models` answered 401 without one and 200 with it
 * (measured 2026-11-18). The probe used to treat `scope: "local"` as "never send
 * a key", so the setup wizard rejected a key that the server had issued itself.
 */
describe("the provider probe and a local key", () => {
  const seen: Array<Record<string, string>> = [];

  afterEach(() => {
    seen.length = 0;
    vi.unstubAllGlobals();
    delete process.env.LMSTUDIO_API_KEY;
    delete process.env.LMSTUDIO_BASE_URL;
  });

  const stubFetch = (status: number) => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seen.push((init.headers ?? {}) as Record<string, string>);
      return new Response("{}", { status });
    });
  };

  it("sends a configured key to a local endpoint", async () => {
    process.env.LMSTUDIO_API_KEY = "sk-local-test";
    process.env.LMSTUDIO_BASE_URL = "http://127.0.0.1:12345/v1";
    stubFetch(200);
    const verdict = await validateProvider("lmstudio");
    expect(verdict.ok).toBe(true);
    expect(seen[0]?.authorization).toBe("Bearer sk-local-test");
  });

  it("sends no authorization header when no key is configured", async () => {
    process.env.LMSTUDIO_BASE_URL = "http://127.0.0.1:12345/v1";
    stubFetch(200);
    await validateProvider("lmstudio");
    expect(seen[0]?.authorization).toBeUndefined();
  });

  it("still reads a 401 as a rejected key", async () => {
    process.env.LMSTUDIO_BASE_URL = "http://127.0.0.1:12345/v1";
    stubFetch(401);
    const verdict = await validateProvider("lmstudio");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe("auth");
  });
});
