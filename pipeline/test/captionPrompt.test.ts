import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CAPTION_JSON, CAPTION_PROMPT } from "../src/providers/captionPrompt.js";
import { SCREENSHOT_PROMPT, SCREENSHOT_VERDICT_PROMPT } from "../src/providers/screenshotPrompt.js";

const source = (file: string) => readFileSync(fileURLToPath(new URL(`../src/providers/${file}`, import.meta.url)), "utf8");

/**
 * Two briefs, and the point is that they stay apart.
 *
 * The ordinary caption brief describes camera photos and the allowlisted travel
 * screens: naming places and transcribing plaques, menus and timetables is what
 * it is for. The screenshot brief describes the screens the allowlist keeps off
 * the wire, where the content may be private, so it names the kind of screen and
 * transcribes nothing.
 *
 * The privacy wording was in the ordinary brief for part of 2026-10-13 and cost
 * more than it gave, measured on the same seed and pool: naming 42% → 25%,
 * transcription 0.88 → 0.73 of the cloud's with one document suppressed
 * outright, and per-call time 24 s → 32-37 s. It also fired on innocent material
 * — a train ticket screen came back with no text at all — because the model
 * applies such a rule to the whole page. Hence the split, and hence this test.
 */
describe("the captioning brief", () => {
  it("lives in one place, and both providers use that place", () => {
    for (const file of ["openaiCompatible.ts", "gemini.ts"]) {
      const src = source(file);
      expect(src, `${file} must import the brief`).toContain('from "./captionPrompt.js"');
      // A second copy is how the two drifted apart; the shared import above is
      // the only way this file may obtain it.
      expect(src, `${file} must not declare its own brief`).not.toMatch(/const CAPTION_PROMPT\s*=/);
    }
  });

  it("keeps the transcription the archive searches on", () => {
    expect(CAPTION_PROMPT).toMatch(/sign, museum plaque, menu, or document, transcribe its text in full/);
    expect(CAPTION_JSON).toMatch(/full transcribed text, or null/);
  });

  it("sends one script, not a look-alike", () => {
    // A Chinese screen came back with a Hangul syllable in place of 舒适; the
    // cloud's Chinese text has no such substitution in 32,831 photos.
    expect(CAPTION_PROMPT).toMatch(/Chinese stays Chinese/);
    expect(CAPTION_PROMPT).toMatch(/never look-alike Japanese kana or Korean Hangul/);
    expect(CAPTION_PROMPT).toMatch(/leave it out rather than substituting/);
  });

  it("keeps the form of the characters, not just the script", () => {
    // Measured 2026-10-13 on the doc pool: the local model wrote a Simplified
    // school notice as 活動教室 / 體能 / 護膚 / 藝術 where the cloud wrote
    // 活动教室 / 体能 / 护肤 / 艺术. Correct for a Qing stele, a conversion for a
    // 2017 notice, and either way search cannot match one against the other.
    expect(CAPTION_PROMPT).toMatch(/never convert Simplified to Traditional/);
    expect(CAPTION_PROMPT).toMatch(/and in the form it is written in/);
  });

  it("does not carry the screenshot pass's privacy rules", () => {
    // Their home is screenshotPrompt.ts; here they cost more than they give.
    expect(CAPTION_PROMPT).not.toMatch(/never summarise, characterise, quote or transcribe/);
    expect(CAPTION_PROMPT).not.toMatch(/personal record/);
  });
});

describe("the screenshot brief", () => {
  it("names the kind of screen and nothing on it", () => {
    expect(SCREENSHOT_PROMPT).toMatch(/what kind of screen this is/);
    expect(SCREENSHOT_PROMPT).toMatch(/describe the screen itself and not its contents/);
    expect(SCREENSHOT_PROMPT).toMatch(/Never what it says/);
  });

  it("forbids summarising or transcribing personal correspondence", () => {
    expect(SCREENSHOT_PROMPT).toMatch(/never summarise, characterise, quote or transcribe/);
    expect(SCREENSHOT_PROMPT).toMatch(/a conversation, a message, an email, a notification/);
    expect(SCREENSHOT_PROMPT).toMatch(/always null/);
  });

  it("keeps the verdict question separate from the description", () => {
    // The verdict ranks what a person should look at; it must never release content.
    expect(SCREENSHOT_VERDICT_PROMPT).toMatch(/Do not transcribe any private content/);
    expect(SCREENSHOT_VERDICT_PROMPT).toMatch(/"sensitive":true\|false/);
    expect(SCREENSHOT_VERDICT_PROMPT).not.toMatch(/extracted_text/);
  });

  it("is not reachable from the ordinary caption path", () => {
    for (const file of ["openaiCompatible.ts", "gemini.ts"]) {
      expect(source(file), `${file} must not pull in the screenshot brief`).not.toContain("screenshotPrompt");
    }
  });
});
