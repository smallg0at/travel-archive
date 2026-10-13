import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PRESETS, presetById, resolveReasoningEffort } from "../src/providers/index.js";

/**
 * Captioning is not a reasoning job, and on a local engine thinking is what the
 * wall clock is made of. Measured on Qwen3.5-9B, 2026-10-13: a question whose
 * answer is "ok" cost 168-192 completion tokens of which 164-188 were reasoning,
 * 12-14 seconds, against 2 tokens and 0.6 seconds with `reasoning_effort: "none"`.
 *
 * The obvious alternatives do not work on that engine (all four measured): a
 * top-level `enable_thinking`, `chat_template_kwargs: {enable_thinking: false}`,
 * a top-level `thinking`/`enable_reasoning`, and `/no_think` in either the user
 * or the system turn were every one of them ignored. LM Studio exposes the same
 * switch to a person as a per-model "Reasoning Budget" (0 ends thinking at once);
 * `reasoning_effort` is the API-shaped version of it, so that is what the local
 * presets send.
 */
describe("reasoning effort", () => {
  const local = PRESETS.filter((p) => p.scope === "local");

  it("is asked for none on the local presets, which is where thinking hurts", () => {
    expect(local.length).toBeGreaterThan(0);
    for (const p of local) expect(p.reasoningEffort, `${p.id} should ask for none`).toBe("none");
  });

  it("is left out of the cloud presets, which set their own policy", () => {
    for (const p of PRESETS.filter((x) => x.scope !== "local")) {
      expect(p.reasoningEffort, `${p.id} must not send reasoning_effort unasked`).toBeUndefined();
    }
  });

  it("lets an env override win, and `auto` mean silence", () => {
    const studio = presetById("lmstudio");
    expect(studio).not.toBeNull();
    expect(resolveReasoningEffort(studio!, {})).toBe("none");
    expect(resolveReasoningEffort(studio!, { LMSTUDIO_REASONING_EFFORT: "high" })).toBe("high");
    expect(resolveReasoningEffort(studio!, { LMSTUDIO_REASONING_EFFORT: "AUTO" })).toBeUndefined();
    const deepseek = presetById("deepseek");
    expect(resolveReasoningEffort(deepseek!, {})).toBeUndefined();
    expect(resolveReasoningEffort(deepseek!, { DEEPSEEK_REASONING_EFFORT: "low" })).toBe("low");
  });

  it("sends the field only when there is something to send", () => {
    // An unconditional `reasoning_effort` would reach every cloud service, most
    // of which do not share the vocabulary. This is a source guard on purpose:
    // the payload is built inside a retry loop and is not worth exporting.
    const src = readFileSync(
      fileURLToPath(new URL("../src/providers/openaiCompatible.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toMatch(/if \(cfg\.reasoningEffort\) payload\.reasoning_effort = cfg\.reasoningEffort;/);
  });

  it("does not use the field names that were measured as no-ops", () => {
    // Keeping the dead ends out of the code is the point: each of these looks
    // like it should work, and each one silently did nothing on the engine we
    // actually run. Comments are stripped first — this file and the provider
    // both name the dead ends in prose, and mentioning them is not using them.
    const withoutComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const file of ["openaiCompatible.ts", "index.ts", "gemini.ts"]) {
      const src = withoutComments(
        readFileSync(fileURLToPath(new URL(`../src/providers/${file}`, import.meta.url)), "utf8"),
      );
      expect(src, `${file} must not send enable_thinking`).not.toMatch(/enable_thinking/);
      expect(src, `${file} must not use a /no_think turn`).not.toMatch(/no_think/);
      expect(src, `${file} must not send chat_template_kwargs`).not.toMatch(/chat_template_kwargs/);
    }
  });
});
