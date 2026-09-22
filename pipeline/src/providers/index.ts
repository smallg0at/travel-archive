import { env } from "../env.js";
import { geminiProvider } from "./gemini.js";
import type { AiProvider } from "./types.js";

/**
 * Gemini is the only provider today. The interface and this switch stay so a
 * second one is a new module plus a case, not a rewrite. Add one by
 * implementing AiProvider (see types.ts) and wiring it in here.
 */
export function getProvider(): AiProvider {
  switch (env.aiProvider) {
    case "gemini":
      return geminiProvider;
    default:
      throw new Error(`Unknown AI_PROVIDER: "${env.aiProvider}" (expected "gemini")`);
  }
}

export type { AiProvider, CaptionResult, DaySummaryResult } from "./types.js";
