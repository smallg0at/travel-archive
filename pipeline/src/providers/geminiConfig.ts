/**
 * How much Gemini thinks, in the vocabulary Google now accepts.
 *
 * `thinking_budget` is being retired: Gemini 3.x remapped it to a level
 * behind the scenes, and upcoming models return 400 INVALID_ARGUMENT instead.
 * `temperature`, `top_p` and `top_k` are going the same way — deprecated since
 * 3.6 Flash, where they have had no effect on output at all, and erroring
 * soon. This module is the one place that knows that, so a provider change
 * cannot reintroduce them by accident: nothing here emits anything but a
 * thinking level.
 *
 * Kept separate from gemini.ts so the mapping can be tested without importing
 * the SDK or the environment.
 */

import { ThinkingLevel as SdkLevel } from "@google/genai";

/** The levels the API accepts. A typo must not silently become the default. */
export const THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * Our spelling to the SDK's own enum.
 *
 * The SDK types `thinkingConfig.thinkingLevel` as that enum, whose members are
 * `"MINIMAL"`/`"LOW"`/..., while Google's notice quotes the lowercase form
 * `"high"`. Measured on gemini-3.7-flash: both are honoured — HIGH 3,342
 * thinking tokens against low's 726 and2,284 with no config at all — so this
 * maps to the typed one rather than casting around it.
 */
const SDK_LEVEL: Record<ThinkingLevel, SdkLevel> = {
  minimal: SdkLevel.MINIMAL,
  low: SdkLevel.LOW,
  medium: SdkLevel.MEDIUM,
  high: SdkLevel.HIGH,
};

/**
 * What the old budget meant, for a `.env` written before the change.
 *
 * The budgets were never calibrated against levels — they were a cost ceiling,
 * and on gemini-3.7-flash a budget of 0 was measured not to stop the thinking
 * anyway (84-114 thinking tokens a call). So this maps by intent rather than
 * by token count: zero means "as little as it will do", and each step up is a
 * guess at more.
 *
 * `-1` was AUTOMATIC, which is what omitting the field now means.
 */
export function levelFromBudget(budget: number): ThinkingLevel {
  if (!Number.isFinite(budget) || budget <= 0) return "minimal";
  if (budget <= 2048) return "low";
  if (budget <= 8192) return "medium";
  return "high";
}

/**
 * The retired budget knob, as the level it was asking for.
 *
 * Reads `GEMINI_THINKING_BUDGET`'s value rather than its number, so an empty
 * value means unset and one that is not a number is not silently mapped to
 * "minimal" — the difference between "no preference" and "the least thinking
 * there is".
 */
export function levelFromLegacyBudget(raw: string | undefined): ThinkingLevel | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const budget = Number(raw);
  return Number.isFinite(budget) ? levelFromBudget(budget) : undefined;
}

/** Reads a level from an environment value. Empty means unset; anything else is refused rather than dropped. */
export function parseThinkingLevel(raw: string | undefined): ThinkingLevel | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === "") return undefined;
  if ((THINKING_LEVELS as readonly string[]).includes(value)) return value as ThinkingLevel;
  throw new Error(`${raw} is not a thinking level; use one of ${THINKING_LEVELS.join(", ")}`);
}

/**
 * The whole of the thinking config: a level, or nothing.
 *
 * Nothing means the model's own default — which is the point of the migration:
 * the levels are per model and the default is the one Google tunes.
 */
export function thinkingFor(level: ThinkingLevel | undefined): { thinkingConfig?: { thinkingLevel: SdkLevel } } {
  return level === undefined ? {} : { thinkingConfig: { thinkingLevel: SDK_LEVEL[level] } };
}
