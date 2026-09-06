import { env } from "../env.js";
import { anthropicProvider } from "./anthropic.js";
import { geminiProvider } from "./gemini.js";
import type { AiProvider } from "./types.js";

/**
 * Only the provider named by AI_PROVIDER is actually invoked, but both
 * modules are imported eagerly — cheap for two small files, and it means a
 * missing GEMINI_API_KEY only breaks the run if you've actually selected
 * "gemini". Add a new provider by implementing AiProvider (see types.ts)
 * and adding a case here.
 */
export function getProvider(): AiProvider {
  switch (env.aiProvider) {
    case "gemini":
      return geminiProvider;
    case "anthropic":
      return anthropicProvider;
    default:
      throw new Error(`Unknown AI_PROVIDER: "${env.aiProvider}" (expected "anthropic" or "gemini")`);
  }
}

export type { AiProvider, CaptionResult, DaySummaryResult } from "./types.js";
