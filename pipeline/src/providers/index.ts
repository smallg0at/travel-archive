import { env } from "../env.js";
import { deepseekProvider } from "./deepseek.js";
import { geminiProvider } from "./gemini.js";
import type { AiProvider } from "./types.js";

/**
 * Which model backend the AI layer talks to. Gemini is the default and the
 * reference; DeepSeek exists for the bulk caption passes, where its price and
 * its batched multi-image call matter more than anything else. Add another by
 * implementing AiProvider (see types.ts) and wiring a case here.
 */
export function getProvider(): AiProvider {
  switch (env.aiProvider) {
    case "gemini":
      return geminiProvider;
    case "deepseek":
      return deepseekProvider;
    default:
      throw new Error(`Unknown AI_PROVIDER: "${env.aiProvider}" (expected "gemini" or "deepseek")`);
  }
}

export type { AiProvider, CaptionResult, DaySummaryResult } from "./types.js";
