import { describe, expect, it } from "vitest";
import { PRESETS, presetById } from "../src/providers/index.js";
import { isWritableKey } from "../src/configStore.js";

/**
 * A guard for the one vendor difference that is invisible until every call
 * fails: LM Studio answers 400 to OpenAI's
 * `response_format:{"type":"json_object"}`, accepting only `json_schema` or
 * `text`. The caption and summary prompts already ask for one JSON object, so
 * the preset must opt out of the field (`jsonMode: "prompt"`). If that is ever
 * dropped the provider sends `json_object` by default and nothing generates —
 * measured 2026-10-07, see docs/history.md.
 */
describe("the local LM Studio preset", () => {
  it("opts out of response_format, which LM Studio rejects", () => {
    const preset = presetById("lmstudio");
    expect(preset).not.toBeNull();
    expect(preset!.kind).toBe("openai");
    expect(preset!.jsonMode).toBe("prompt");
    expect(preset!.baseUrl).toContain(":1234");
  });

  it("exposes its endpoint, model and key to the Settings form", () => {
    for (const key of ["LMSTUDIO_API_KEY", "LMSTUDIO_MODEL", "LMSTUDIO_BASE_URL"]) {
      expect(isWritableKey(key)).toBe(true);
    }
  });

  it("does not change the Ollama preset on its behalf", () => {
    // A real Ollama is a different service; the LM Studio difference lives on
    // its own row rather than being folded into this one.
    expect(presetById("ollama")!.jsonMode).toBeUndefined();
    expect(PRESETS.filter((p) => p.id === "lmstudio")).toHaveLength(1);
  });

  it("no longer advertises LM Studio on the Ollama row", () => {
    // The label used to read "Local (Ollama / LM Studio)", which invited a
    // reader to select a row that would fail on LM Studio. The server label is
    // the fallback for an untranslated id; the desktop translates it by id.
    expect(presetById("ollama")!.label).not.toMatch(/LM Studio/);
  });
});

/**
 * Settings groups the backends by `scope`, so a local service left unmarked
 * would quietly file itself under "Online services" — a reader would think a
 * call that never leaves the machine goes out to the network.
 */
describe("provider scope", () => {
  it("marks the on-machine services, and only those", () => {
    const local = PRESETS.filter((p) => p.scope === "local")
      .map((p) => p.id)
      .sort();
    expect(local).toEqual(["lmstudio", "ollama"]);
  });
});

/**
 * The setup wizard links a reader to where a key comes from, and one missing
 * link leaves that key box with no way out; a local service claiming one
 * invites a visit that cannot produce a key.
 */
describe("platform links", () => {
  it("names a platform for every cloud service, and none for the local ones", () => {
    for (const p of PRESETS) {
      if (p.scope === "local") expect(p.platformUrl, p.id).toBeNull();
      else expect(p.platformUrl, p.id).toMatch(/^https:\/\//);
    }
  });
});

/**
 * OpenRouter's `GET /models` is public: it answered 200 to a garbage key
 * (measured 2026-10-10), so the default probe would have passed any text a
 * reader typed. `/key` is the auth-bound endpoint. Dropping this field
 * silently restores the hole the third test round found.
 */
describe("key probe", () => {
  it("uses an auth-bound path at OpenRouter, and the default elsewhere", () => {
    expect(presetById("openrouter")!.probePath).toBe("/key");
    for (const p of PRESETS) {
      if (p.id !== "openrouter") expect(p.probePath, p.id).toBeUndefined();
    }
  });
});
