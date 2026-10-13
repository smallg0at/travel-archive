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
  /**
   * Where it runs. Absent means `cloud` (over the network); a service on this
   * machine sets `"local"`, which is what Settings groups by.
   */
  scope?: "local" | "cloud";
  /** OpenAI-compatible only. */
  baseUrl?: string;
  model: string;
  apiKeyEnv: string;
  /** Where a key for this service is made; local services take none. */
  platformUrl?: string | null;
  /** OpenAI-compatible only: send `response_format`, or leave it to the prompt. */
  jsonMode?: "response_format" | "prompt";
  tokenParam?: "max_tokens" | "max_completion_tokens";
  /**
   * OpenAI-compatible only: what to ask a reasoning model for, sent as
   * `reasoning_effort`. The local services default to `"none"` — see
   * `resolveReasoningEffort` for the measurement behind that.
   */
  reasoningEffort?: string;
  /**
   * The path `validateProvider` probes to ask whether the key is real.
   * Default `models` — but only where `GET /models` is auth-bound: a
   * provider whose list is public (OpenRouter) would answer 200 to
   * anything, and the probe would say nothing about the key.
   */
  probePath?: string;
}

/**
 * The services Settings can switch between.
 *
 * `apiKeyEnv` names the variable holding the key, so the config form can write
 * it and `/config` can report whether it is set without ever returning it.
 * Everything but Gemini is OpenAI-compatible and shares one implementation.
 */
const RAW_PRESETS: ProviderPreset[] = [
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
    // `/models` here is public — it answered 200 to a garbage key (measured
    // 2026-10-10), so it judges reachability, not the key. `/key` is the
    // auth-bound one: 401 to garbage, and by their docs 200 with key info
    // for a real key (that half unverifiable on this machine, which has no
    // OpenRouter key — if a good key ever fails here, this is the field).
    probePath: "/key",
  },
  {
    id: "ollama",
    label: "Local (Ollama)",
    kind: "openai",
    scope: "local",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen3.5:9b",
    apiKeyEnv: "OLLAMA_API_KEY",
    // A local server has no key; the field exists only so the form has
    // something to write. Model and URL are the parts that matter here.
    reasoningEffort: "none",
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
    scope: "local",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "qwen/qwen3.5-9b",
    apiKeyEnv: "LMSTUDIO_API_KEY",
    jsonMode: "prompt",
    reasoningEffort: "none",
  },
];

/**
 * Where a key for each cloud service is made — console roots, not deep
 * links: vendors move their settings pages around, the root lasts. Read
 * 2026-10-10. The on-machine services take no key and have no platform.
 */
const PLATFORM_URLS: Record<string, string> = {
  deepseek: "https://platform.deepseek.com/api_keys",
  gemini: "https://aistudio.google.com/app/apikey",
  siliconflow: "https://cloud.siliconflow.cn",
  dashscope: "https://bailian.console.aliyun.com",
  zhipu: "https://open.bigmodel.cn",
  moonshot: "https://platform.moonshot.cn/console/api-keys",
  openrouter: "https://openrouter.ai/settings/keys",
};

export const PRESETS: ProviderPreset[] = RAW_PRESETS.map((p) => ({
  ...p,
  platformUrl: PLATFORM_URLS[p.id] ?? null,
}));

/**
 * One cheap request that says whether a key (or a local endpoint) works.
 *
 * The setup wizard used to accept any text as an API key, write it to
 * `.env` and continue — the typo surfaced minutes later as a failed job.
 * Three verdicts, so the page can act on each: `ok` (429 counts: rate
 * limited still means authenticated), `auth` (401/403 — a wrong key, fix
 * it), `unreachable` (no answer, no `/models` at that address, or the local
 * service is down — the reason spelled out). The key never appears in the
 * result. Read 2026-10-10; a vendor that drops `GET /models` shows up
 * here as a 404 with the URL in the message, not as a mystery failure.
 */
export async function validateProvider(
  id: string,
  typedKey?: string,
): Promise<{ ok: true } | { ok: false; kind: "auth" | "unreachable"; detail: string }> {
  const preset = presetById(id);
  if (!preset) return { ok: false, kind: "auth", detail: `unknown provider "${id}"` };
  const key = (typedKey ?? "").trim() || process.env[preset.apiKeyEnv] || "";
  const fail = (kind: "auth" | "unreachable", detail: string) => ({ ok: false as const, kind, detail });
  try {
    if (preset.kind === "gemini") {
      // The host the SDK talks to; listing models is free and needs only the
      // key as a query parameter.
      const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1${key ? `&key=${encodeURIComponent(key)}` : ""}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.ok || res.status === 429) return { ok: true };
      if (res.status === 400 || res.status === 401 || res.status === 403)
        return fail("auth", `Gemini rejected the key (${res.status})`);
      return fail("unreachable", `Gemini answered ${res.status} ${res.statusText}`);
    }
    const base = (process.env[`${preset.id.toUpperCase()}_BASE_URL`] || preset.baseUrl || "").replace(/\/+$/, "");
    if (!base) return fail("unreachable", "no base URL configured");
    // Tolerate either spelling of the path ("/key" reads better in the
    // preset; the URL is built here) — an unnormalized double slash 404s
    // and reads like a misconfigured base URL, which is a lie.
    const path = (preset.probePath ?? "models").replace(/^\/+/, "");
    const headers: Record<string, string> = preset.scope === "local" || !key ? {} : { authorization: `Bearer ${key}` };
    const res = await fetch(`${base}/${path}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (res.ok || res.status === 429) return { ok: true };
    if (res.status === 401 || res.status === 403) return fail("auth", `key rejected (${res.status})`);
    if (res.status === 404) return fail("unreachable", `no /${path} at ${base} (404) — check the base URL`);
    return fail("unreachable", `${res.status} ${res.statusText}`);
  } catch (err) {
    return fail("unreachable", (err as Error).message || "no answer");
  }
}

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
    reasoningEffort: resolveReasoningEffort(preset),
  };
}

/**
 * What to ask a reasoning model for, sent as `reasoning_effort`.
 *
 * Measured on the local Qwen3.5-9B (2026-10-13): thinking costs about 170 tokens
 * and 12-14 seconds on a question whose answer is the single word "ok". With
 * `reasoning_effort: "none"` the same call is 2 tokens and 0.6 seconds with zero
 * reasoning tokens — and the obvious alternatives are no-ops there: top-level
 * `enable_thinking`, `chat_template_kwargs`, `thinking`, `enable_reasoning`, and
 * `/no_think` in either a user or a system turn were all ignored. LM Studio's own
 * control for this is a per-model "Reasoning Budget" (0 = end thinking at once);
 * `reasoning_effort` is the same switch reachable over the API, which is what a
 * pipeline can set. Captioning is not a reasoning job, so the local presets ask
 * for none by default.
 *
 * Resolution: `<PROVIDER>_REASONING_EFFORT` wins (the literal "auto" means send
 * nothing), else the preset's own value, else nothing at all — so a cloud service
 * that never heard of the field is unaffected.
 */
export function resolveReasoningEffort(
  preset: ProviderPreset,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const override = (env[`${preset.id.toUpperCase()}_REASONING_EFFORT`] ?? "").trim().toLowerCase();
  if (override === "auto") return undefined;
  return override || preset.reasoningEffort;
}

/**
 * The provider named by `AI_PROVIDER`, or Gemini when it is unset.
 *
 * Unknown names throw rather than silently falling back: a typo in `.env`
 * should say so, not quietly caption with the wrong service.
 */
export function getProvider(): AiProvider {
  return providerById(env.aiProvider);
}

/**
 * The provider for one preset id, whatever `AI_PROVIDER` says.
 *
 * Two are in play at once when the local screenshot pass runs: the cloud model
 * describes the archive, and a service on this machine describes the screens the
 * allowlist keeps off the wire. Same table, same construction — the second one
 * just is not the default.
 */
export function providerById(id: string): AiProvider {
  const preset = presetById(id);
  if (!preset) {
    throw new Error(`Unknown AI_PROVIDER: "${id}" (known: ${PRESETS.map((p) => p.id).join(", ")})`);
  }
  if (preset.kind === "gemini") return geminiProvider;
  return createOpenAiCompatProvider(openAiConfig(preset));
}

export type { AiProvider, CaptionResult, DaySummaryResult } from "./types.js";
