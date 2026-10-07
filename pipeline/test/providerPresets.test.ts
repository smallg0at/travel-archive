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
 * measured 2026-10-07, see HANDOFF.md.
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
