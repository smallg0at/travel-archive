import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  THINKING_LEVELS,
  levelFromBudget,
  levelFromLegacyBudget,
  parseThinkingLevel,
  thinkingFor,
} from "../src/providers/geminiConfig.js";

/**
 * What Google's deprecation notice turned into code.
 *
 * Two of the four retired parameters were in use here — `thinking_budget` on
 * every translate call, `temperature` on all six — so the mapping is tested,
 * and the provider's own source is scanned for the ones that must never come
 * back. A request that carries them returns 400 INVALID_ARGUMENT on upcoming
 * models, which is a failure nobody sees until the archive stops generating.
 */
describe("thinking levels", () => {
  it("maps the retired budget by intent, not by token count", () => {
    expect(levelFromBudget(0)).toBe("minimal");
    expect(levelFromBudget(-1)).toBe("minimal");
    expect(levelFromBudget(1)).toBe("low");
    expect(levelFromBudget(2048)).toBe("low");
    expect(levelFromBudget(2049)).toBe("medium");
    expect(levelFromBudget(8192)).toBe("medium");
    expect(levelFromBudget(8193)).toBe("high");
    expect(levelFromBudget(100_000)).toBe("high");
  });

  it("reads the legacy env value, and treats what it cannot read as unset", () => {
    expect(levelFromLegacyBudget("0")).toBe("minimal");
    expect(levelFromLegacyBudget("512")).toBe("low");
    // Empty is "no preference", not "the least thinking there is"; a typo is
    // not a reason to send anything at all.
    expect(levelFromLegacyBudget("")).toBeUndefined();
    expect(levelFromLegacyBudget(undefined)).toBeUndefined();
    expect(levelFromLegacyBudget("lots")).toBeUndefined();
  });

  it("accepts the four levels, in any case, and refuses anything else", () => {
    for (const level of THINKING_LEVELS) expect(parseThinkingLevel(level)).toBe(level);
    expect(parseThinkingLevel(" High ")).toBe("high");
    expect(parseThinkingLevel("")).toBeUndefined();
    expect(parseThinkingLevel(undefined)).toBeUndefined();
    // Refused rather than dropped: a hand-edited `.env` with a typo would
    // otherwise fall back to the default and look like it had taken effect.
    expect(() => parseThinkingLevel("turbo")).toThrow(/thinking level/);
  });

  it("emits a level and nothing else", () => {
    expect(thinkingFor(undefined)).toEqual({});
    // The SDK's enum, not our lowercase spelling — see geminiConfig.ts for the
    // measurement that says both work and this is the one that type-checks.
    expect(thinkingFor("high")).toEqual({ thinkingConfig: { thinkingLevel: "HIGH" } });
    expect(thinkingFor("minimal")).toEqual({ thinkingConfig: { thinkingLevel: "MINIMAL" } });
    expect(JSON.stringify(thinkingFor("medium"))).not.toMatch(/Budget|budget/);
  });
});

describe("the Gemini provider's request shape", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/providers/gemini.ts", import.meta.url)), "utf8");

  it("sends no retired sampling parameter", () => {
    // Matched as a config key, not as prose: the caption comment still says
    // "even at temperature 0" because that measurement is why nothing sets it.
    expect(source).not.toMatch(/^\s*temperature\s*:/m);
    expect(source).not.toMatch(/^\s*topP\s*:/m);
    expect(source).not.toMatch(/^\s*topK\s*:/m);
    expect(source).not.toMatch(/^\s*top_p\s*:/m);
    expect(source).not.toMatch(/^\s*top_k\s*:/m);
  });

  it("sends no thinking budget — level only", () => {
    expect(source).not.toContain("thinkingBudget");
    expect(source).not.toContain("GEMINI_THINKING_BUDGET");
    // Every request goes through the one helper, batch included.
    expect(source).toContain("thinkingFor(");
    expect(source.match(/thinkingFor\(/g)!.length).toBeGreaterThanOrEqual(5);
  });
});
