import { env } from "../env.js";
import { geminiProvider } from "./gemini.js";
import { createOpenAiCompatProvider, type OpenAiCompatConfig } from "./openaiCompatible.js";
import type { AiProvider } from "./types.js";

/**
 * Which model backend the AI layer talks to, and how each is configured.
 *
 * Two shapes are supported, and the difference is real rather than incidental:
 *
 *  - **`gemini`** — its own SDK and `responseSchema`. The structured-output
 *    constraint is enforced by the API, which is why day and trip pages come
 *    out reliably; and it is the only one with a Batch API (half price, a day
 *    later).
 *  - **`openai`** — anything speaking Chat Completions with `image_url` data
 *    URLs: DeepSeek, SiliconFlow, DashScope, Zhipu, Moonshot, OpenRouter, a
 *    local Ollama. Cheap, synchronous, and batched by this code.
 *
 * A new OpenAI-compatible service is an entry in the table below, not a module.
 * The two switches that genuinely differ between vendors — the token-limit
 * parameter's name, and whether JSON mode is a request field — live on the
 * entry.
 */

export interface ProviderPreset {
  id: string;
  /** What Settings calls it. */
  label: string;
  kind: "gemini" | "openai";
  /** OpenAI-compatible only. */
  baseUrl?: string;
  model: string;
  apiKeyEnv: string;
  /** OpenAI-compatible only: send `response_format`, or leave it to the prompt. */
  jsonMode?: "response_format" | "prompt";
  tokenParam?: "max_tokens" | "max_completion_tokens";
}

/**
 * The services Settings can switch between.
 *
 * `apiKeyEnv` names the variable holding the key, so the config form can write
 * it and `/config` can report whether it is set without ever returning it.
 * Everything but Gemini is OpenAI-compatible and shares one implementation.
 */
export const PRESETS: ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    // Image input lives on the Flash model; `deepseek-v4-flash` is text-only.
    model: "deepseek-flash",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    kind: "gemini",
    model: "gemini-3.7-flash",
    apiKeyEnv: "GEMINI_API_KEY",
  },
  {
    id: "siliconflow",
    label: "SiliconFlow (硅基流动)",
    kind: "openai",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "Qwen/Qwen3-VL-30B-A3B-Instruct",
    apiKeyEnv: "SILICONFLOW_API_KEY",
  },
  {
    id: "dashscope",
    label: "Alibaba DashScope (Qwen)",
    kind: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3-vl-plus",
    apiKeyEnv: "DASHSCOPE_API_KEY",
  },
  {
    id: "zhipu",
    label: "Zhipu (智谱 GLM)",
    kind: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-5.3-flash",
    apiKeyEnv: "ZHIPU_API_KEY",
  },
  {
    id: "moonshot",
    label: "Moonshot (Kimi)",
    kind: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k3",
    apiKeyEnv: "MOONSHOT_API_KEY",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "deepseek/deepseek-v4-flash",
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
  {
    id: "ollama",
    label: "Local (Ollama)",
    kind: "openai",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "gemma4:e4b",
    apiKeyEnv: "OLLAMA_API_KEY",
    // A local server has no key; the field exists only so the form has
    // something to write. Model and URL are the parts that matter here.
  },
  {
    // LM Studio is not Ollama with a different port: it speaks the same
    // Chat Completions shape but **answers 400 to OpenAI's
    // `response_format:{"type":"json_object"}`**, accepting only
    // `json_schema` or `text`. That difference lives on the entry
    // (`jsonMode`), which is exactly what the preset table is for, so it gets
    // its own row rather than being folded into `ollama` and breaking a real
    // Ollama. `prompt` sends no `response_format`; the caption and summary
    // prompts already demand one JSON object and `looseJson` unwraps a fenced
    // reply, so this costs nothing and is the difference between working and
    // every call failing.
    id: "lmstudio",
    label: "Local (LM Studio)",
    kind: "openai",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "google/gemma-4-e4b",
    apiKeyEnv: "LMSTUDIO_API_KEY",
    jsonMode: "prompt",
  },
];

export function presetById(id: string): ProviderPreset | null {
  return PRESETS.find((p) => p.id === id) ?? null;
}

/** A preset's key, from the environment. Undefined is a legitimate state. */
export function keyFor(preset: ProviderPreset): string | undefined {
  const value = process.env[preset.apiKeyEnv];
  return value ? value : undefined;
}

/** The base URL and model actually in force: an env override, or the preset's own. */
function openAiConfig(preset: ProviderPreset): OpenAiCompatConfig {
  const prefix = preset.id.toUpperCase();
  return {
    label: preset.label,
    baseUrl: process.env[`${prefix}_BASE_URL`] || preset.baseUrl || "",
    apiKey: keyFor(preset),
    model: process.env[`${prefix}_MODEL`] || preset.model,
    jsonMode: preset.jsonMode,
    tokenParam: preset.tokenParam,
  };
}

/**
 * The provider named by `AI_PROVIDER`, or Gemini when it is unset.
 *
 * Unknown names throw rather than silently falling back: a typo in `.env`
 * should say so, not quietly caption with the wrong service.
 */
export function getProvider(): AiProvider {
  const id = env.aiProvider;
  const preset = presetById(id);
  if (!preset) {
    throw new Error(`Unknown AI_PROVIDER: "${id}" (known: ${PRESETS.map((p) => p.id).join(", ")})`);
  }
  if (preset.kind === "gemini") return geminiProvider;
  return createOpenAiCompatProvider(openAiConfig(preset));
}

export type { AiProvider, CaptionResult, DaySummaryResult } from "./types.js";
