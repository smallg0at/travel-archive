import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CAPTION_JSON, CAPTION_PROMPT } from "../src/providers/captionPrompt.js";

/**
 * The captioning brief is one file now, and it has to keep saying one thing.
 *
 * It was copied into both providers before 2026-10-13, with a comment claiming
 * the two copies were the same brief — nothing checked that, so a change to one
 * would silently caption differently under the same field names.
 *
 * The private-content paragraph is the other half. Measured that day: a local
 * model captioned two real chat screenshots as "a humorous chat conversation
 * discussing voice assistants like Siri" and "a mobile messaging thread
 * discussing technology and making jokes about emergency numbers". Not a
 * transcription — a summary, the same leak by another door — and the pipeline's
 * own `detectSensitive` scan returned clean on both, because it looks for
 * identifying shapes rather than subject matter. So the brief is the guard, and
 * a test is what keeps the guard in place.
 */
describe("the captioning brief", () => {
  it("forbids summarising or transcribing personal correspondence", () => {
    expect(CAPTION_PROMPT).toMatch(/never summarise, characterise, quote or transcribe/i);
    expect(CAPTION_PROMPT).toMatch(/a conversation, a message, an email, a notification/i);
    expect(CAPTION_PROMPT).toMatch(/set extracted_text to null/i);
    // The kinds of personal record that are not a "message" but are just as private.
    expect(CAPTION_PROMPT).toMatch(/booking or ID number/i);
    // And it must not be escapable by calling the screen a document.
    expect(CAPTION_PROMPT).toMatch(/document included/i);
  });

  it("keeps transcription for the documents the archive searches on", () => {
    expect(CAPTION_PROMPT).toMatch(/sign, museum plaque, menu, ticket, timetable/i);
    expect(CAPTION_JSON).toMatch(/sign\/plaque\/menu\/ticket/);
    expect(CAPTION_JSON).toMatch(/never a message, a name or a number/);
  });

  it("lives in one place, and both providers use that place", () => {
    for (const file of ["openaiCompatible.ts", "gemini.ts"]) {
      const source = readFileSync(fileURLToPath(new URL(`../src/providers/${file}`, import.meta.url)), "utf8");
      expect(source, `${file} must import the brief`).toContain('from "./captionPrompt.js"');
      // A second copy is how the two drifted apart; the shared import above is
      // the only way this file may obtain it.
      expect(source, `${file} must not declare its own brief`).not.toMatch(/const CAPTION_PROMPT\s*=/);
    }
    // And the Gemini schema — a third expression of the same contract — has to
    // agree with the prompt rather than contradict it.
    const gemini = readFileSync(fileURLToPath(new URL("../src/providers/gemini.ts", import.meta.url)), "utf8");
    expect(gemini).toMatch(/always null for a conversation/);
  });
});
