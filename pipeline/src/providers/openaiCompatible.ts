import type {
  AiProvider,
  CallUsage,
  CaptionPhotoInput,
  CaptionResult,
  DaySummaryResult,
  SummarizeDayInput,
  SummarizeTripInput,
  TranslateInput,
  TranslateResult,
  TripSummaryResult,
} from "./types.js";
import { captionContextBlock } from "./captionContext.js";
import { translatePrompt } from "./translatePrompt.js";
import { DAY_JSON_SHAPE, TRIP_JSON_SHAPE, dayPrompt, parseDaySummary, parseTripSummary, tripPrompt } from "./summarise.js";

/**
 * Any OpenAI-compatible Chat Completions endpoint — see `createOpenAiCompatProvider`
 * at the bottom for why this is one module instead of one per vendor.
 *
 * The reason it exists at all is the **video poster pass**: 894 videos whose
 * poster frames have to be captioned, at volume, where a cheap image-capable
 * model with no project spend cap is what makes the pass affordable.
 *
 * **Batching is the point.** `captionPhotos` sends several poster frames in one
 * request and asks for one JSON object per image in order, which is what turns
 * 877 calls into a few dozen.
 */

const MAX_ATTEMPTS = 5;
/** Fetches and DeepSeek's own 5xx/429s are worth a retry; a 400 is not. */
const RETRYABLE =
  /(429|500|502|503|504|RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED|INTERNAL|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up)/i;

/**
 * Images per request.
 *
 * Lowered from 12 after a real truncation: with reasoning counted into the
 * completion budget, a ten-image batch could spend most of `max_tokens` on
 * thinking and cut the JSON mid-object, losing every caption in it. Six keeps
 * the JSON small enough that the budget is never the constraint, and a batch
 * that still fails is only six photos to re-send.
 */
const BATCH_SIZE = 6;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ImagePart {
  type: "image_url";
  image_url: { url: string };
}
interface TextPart {
  type: "text";
  text: string;
}
type Part = TextPart | ImagePart;
interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | Part[];
}

/** The same cataloguing brief Gemini gets, so a switch of provider does not also switch what a caption means. */
const CAPTION_PROMPT = `You are cataloging a personal photo library that mixes travel photos, everyday snapshots, and phone screenshots. There are no people to identify — focus on place, subject, and content.
- content_type: scene, document (signs/plaques/menus/text-heavy), food, landscape, screenshot (a screen capture, not a camera photo), or other.
- caption: one plain sentence, no preamble.
- tags: 3-6 short lowercase tags.
- extracted_text: if this is primarily a sign, museum plaque, menu, or document, transcribe its text in full. Otherwise null.
- notable: true only if this photo should get its own write-up; false for routine snapshots that can be folded into a day summary.`;

const CAPTION_JSON = `Reply with ONE JSON object and nothing else:
{"content_type":"scene|document|food|landscape|screenshot|other","caption":"one plain sentence","tags":["3-6 short lowercase tags"],"extracted_text":"full transcribed text, or null","notable":true|false}`;

function dataUrl(input: CaptionPhotoInput): string {
  return `data:${input.mediaType};base64,${input.imageBase64}`;
}

function usageOf(body: { usage?: Record<string, unknown> }): CallUsage {
  const u = (body.usage ?? {}) as {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  const thoughts = u.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    promptTokens: u.prompt_tokens ?? 0,
    thoughtsTokens: thoughts,
    // DeepSeek counts reasoning inside completion_tokens; split it out the way
    // Gemini reports it so the two providers' usage lines mean the same thing.
    outputTokens: Math.max(0, (u.completion_tokens ?? 0) - thoughts),
  };
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  const header = Number(retryAfter);
  if (Number.isFinite(header) && header > 0) return header * 1000;
  return Math.min(30_000, 1500 * 2 ** (attempt - 1)) * (0.7 + Math.random() * 0.6);
}

/** Endpoint settings for one OpenAI-compatible service. */
export interface OpenAiCompatConfig {
  /** Shown in errors, e.g. "DeepSeek" or "SiliconFlow". */
  label: string;
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  /** `max_tokens` (DeepSeek, most) or `max_completion_tokens` (newer OpenAI). */
  tokenParam?: "max_tokens" | "max_completion_tokens";
  /** JSON mode: send OpenAI's `response_format`, or rely on the prompt alone. */
  jsonMode?: "response_format" | "prompt";
}

async function chat(
  cfg: OpenAiCompatConfig,
  messages: ChatMessage[],
  opts: { maxTokens: number },
): Promise<{ text: string; usage: CallUsage }> {
  if (!cfg.apiKey) {
    throw new Error(`${cfg.label}: no API key — add one in Settings, or set the matching *_API_KEY in pipeline/.env`);
  }
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      const payload: Record<string, unknown> = {
        model: cfg.model,
        messages,
        temperature: 0,
        [cfg.tokenParam ?? "max_tokens"]: opts.maxTokens,
      };
      // The prompts already say "one JSON object"; OpenAI keeps the rule that
      // json_object mode also needs the word JSON in the prompt, which they do.
      // Some endpoints reject the field outright, hence the switch.
      if ((cfg.jsonMode ?? "response_format") === "response_format") payload.response_format = { type: "json_object" };
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      if (attempt < MAX_ATTEMPTS && RETRYABLE.test(String(err))) {
        await sleep(backoffMs(attempt, null));
        continue;
      }
      throw err;
    }

    if (!res.ok) {
      const body = await res.text();
      if (attempt < MAX_ATTEMPTS && (res.status === 429 || res.status >= 500)) {
        await sleep(backoffMs(attempt, res.headers.get("retry-after")));
        continue;
      }
      throw new Error(`${cfg.label} ${res.status}: ${body.slice(0, 300)}`);
    }

    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: Record<string, unknown>;
    };
    const text = body.choices?.[0]?.message?.content ?? "";
    // JSON mode "may occasionally return empty content" (DeepSeek's own note).
    // That is a reason to ask again, not to fail a photo, so it retries like a
    // 5xx rather than throwing.
    if (!text) {
      if (attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs(attempt, null));
        continue;
      }
      throw new Error(`${cfg.label} returned an empty message`);
    }
    return { text, usage: usageOf(body) };
  }
}

/** The model's JSON as a `CaptionResult`, tolerant of a stray prose wrapper. */
function toCaption(raw: unknown): Omit<CaptionResult, "usage"> {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    contentType: (typeof r.content_type === "string" ? r.content_type : "other") as CaptionResult["contentType"],
    caption: typeof r.caption === "string" ? r.caption : "",
    tags: Array.isArray(r.tags) ? (r.tags as unknown[]).map(String) : [],
    extractedText: typeof r.extracted_text === "string" ? r.extracted_text : null,
    notable: Boolean(r.notable),
  };
}

/** Models sometimes wrap JSON in a ```json fence despite json_object mode. */
function looseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    const braced = /\{[\s\S]*\}/.exec(text);
    return JSON.parse(fenced?.[1] ?? braced?.[0] ?? text);
  }
}

async function captionPhoto(cfg: OpenAiCompatConfig, input: CaptionPhotoInput): Promise<CaptionResult> {
  const { text, usage } = await chat(
    cfg,
    [
      {
        role: "user",
        content: [
          { type: "text", text: `${CAPTION_PROMPT}${captionContextBlock(input.context)}\n\n${CAPTION_JSON}` },
          { type: "image_url", image_url: { url: dataUrl(input) } },
        ],
      },
    ],
    { maxTokens: 2048 },
  );
  return { ...toCaption(looseJson(text)), usage };
}

/**
 * Several posters in one call. The images are sent in order and the model is
 * asked for a `results` array in the same order; per-image context, where it
 * exists, is listed by number before the images so it lines up.
 */
async function captionPhotos(cfg: OpenAiCompatConfig, inputs: CaptionPhotoInput[]): Promise<CaptionResult[]> {
  if (inputs.length === 0) return [];
  if (inputs.length === 1) return [await captionPhoto(cfg, inputs[0])];

  const contexts = inputs
    .map((input, i) => {
      const block = captionContextBlock(input.context).trim();
      return block ? `Image ${i + 1}:\n${block}` : "";
    })
    .filter(Boolean)
    .join("\n\n");

  const content: Part[] = [
    {
      type: "text",
      text:
        `${CAPTION_PROMPT}\n\nYou are given ${inputs.length} images, in order. ` +
        `Reply with ONE JSON object: {"results":[ exactly ${inputs.length} objects, in the SAME order as the images, ` +
        `each {"content_type":...,"caption":...,"tags":[...],"extracted_text":...,"notable":...} ]}` +
        (contexts ? `\n\nPer-image context (use only to name what the image already shows):\n${contexts}` : ""),
    },
  ];
  for (const input of inputs) content.push({ type: "image_url", image_url: { url: dataUrl(input) } });

  /**
   * One request for the batch; **fall back to one per image** if it does not
   * come back as JSON.
   *
   * A reply that is truncated or malformed used to lose all N captions at once.
   * Sending the same images individually means only the genuinely bad one fails,
   * at the cost of a few extra calls — and a batch small enough to stay under
   * the output ceiling is the first line of defence anyway.
   */
  let parsed: { results?: unknown[] };
  let batchUsage: CallUsage | undefined;
  try {
    const { text, usage } = await chat(cfg, [{ role: "user", content }], { maxTokens: 8192 });
    batchUsage = usage;
    parsed = looseJson(text) as { results?: unknown[] };
    if (!Array.isArray(parsed.results) || parsed.results.length === 0) throw new Error("no results array");
  } catch (err) {
    console.warn(`  batch of ${inputs.length} did not parse (${(err as Error).message}); retrying one at a time`);
    const singles: CaptionResult[] = [];
    for (const input of inputs) singles.push(await captionPhoto(cfg, input));
    return singles;
  }
  // Charged once, on the first result; the rest carry none, so a caller summing
  // usage over a batch does not multiply the same call N times.
  return parsed.results.map((raw, i) => ({ ...toCaption(raw), usage: i === 0 ? batchUsage : undefined }));
}

async function translate(cfg: OpenAiCompatConfig, input: TranslateInput): Promise<TranslateResult> {
  const { text, usage } = await chat(
    cfg,
    [
      {
        role: "user",
        content: `${translatePrompt(input)}\n\nReply with ONE JSON object: {"items":[{"key":"...","text":"..."}]}`,
      },
    ],
    { maxTokens: 8192 },
  );
  const parsed = looseJson(text) as { items?: { key: string; text: string }[] };
  return { items: parsed.items ?? [], usage };
}

/** Day and trip summaries: no images, just the shared prompts plus a JSON shape the model is told to follow. */
async function summarizeDay(cfg: OpenAiCompatConfig, input: SummarizeDayInput): Promise<DaySummaryResult> {
  const { text } = await chat(
    cfg,
    [{ role: "user", content: `${dayPrompt(input)}\n\nReply with ONE JSON object:\n${DAY_JSON_SHAPE}` }],
    { maxTokens: 8192 },
  );
  return parseDaySummary(input, looseJson(text));
}

async function summarizeTrip(cfg: OpenAiCompatConfig, input: SummarizeTripInput): Promise<TripSummaryResult> {
  const { text, usage } = await chat(
    cfg,
    [{ role: "user", content: `${tripPrompt(input)}\n\nReply with ONE JSON object:\n${TRIP_JSON_SHAPE}` }],
    { maxTokens: 8192 },
  );
  return { ...parseTripSummary(input, looseJson(text)), usage };
}

/**
 * A provider over any OpenAI-compatible Chat Completions endpoint.
 *
 * This used to be `deepseek.ts`, with the endpoint settings read straight from
 * `env.deepseek*`. They are a parameter now, because the wire format is a
 * standard: the same code serves DeepSeek, SiliconFlow, DashScope, Zhipu,
 * Moonshot, OpenRouter, a local Ollama, and anything else that accepts
 * `image_url` data URLs. What differs between them is not the shape but small
 * switches — `tokenParam` and `jsonMode` below exist because those really do
 * vary — so a new service is a config entry rather than a new module.
 *
 * Every call in a run shares one `cfg`, so a change of model or base URL takes
 * effect on the next run without rebuilding a client.
 */
export function createOpenAiCompatProvider(cfg: OpenAiCompatConfig): AiProvider {
  return {
    captionPhoto: (input) => captionPhoto(cfg, input),
    captionPhotos: (inputs) => captionPhotos(cfg, inputs),
    batchSize: BATCH_SIZE,
    summarizeDay: (input) => summarizeDay(cfg, input),
    summarizeTrip: (input) => summarizeTrip(cfg, input),
    translate: (input) => translate(cfg, input),
  };
}
