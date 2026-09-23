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
 * Output ceilings, in tokens.
 *
 * These are **caps, not budgets** — nothing is charged for headroom that goes
 * unused, and JSON mode makes `max_tokens` a hard cut, so a ceiling set too low
 * does not save money; it truncates a reply and the whole call is wasted.
 * `deepseek-flash` accepts 384K of output, so these sit far above any reply
 * these prompts produce while staying nowhere near the model's own limit.
 */
const MAX_OUTPUT = {
  /** One image: a short JSON object plus reasoning. */
  captionOne: 16_384,
  /** A batch of images, one object each, plus reasoning. */
  captionBatch: 32_768,
  /** A day summary: up to 33 highlights per stop, so the longest reply here. */
  day: 65_536,
  trip: 65_536,
  /** A month of translation items. */
  translate: 32_768,
};

/**
 * Images per request.
 *
 * Not a token limit — that is above — but an alignment one: the more images a
 * single reply must keep in order, the likelier one slips. Six keeps the JSON
 * short and a bad batch cheap to re-send.
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

/**
 * Parses the model's JSON, repairing a truncation where it can.
 *
 * JSON mode makes `max_tokens` a hard cut, so a long reply — a day summary with
 * thirty highlights, a ten-image caption batch — can end mid-object. Throwing
 * there loses everything the model did write, so a truncated object is closed
 * and what completed is kept: a stop missing its last two highlights is worth
 * far more than no day at all, and the caller's validation drops anything
 * unfinished anyway.
 */
function looseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    const braced = /\{[\s\S]*\}/.exec(text);
    const candidate = fenced?.[1] ?? braced?.[0] ?? text;
    try {
      return JSON.parse(candidate);
    } catch {
      return JSON.parse(closeTruncated(candidate));
    }
  }
}

/**
 * Closes an object that stopped mid-stream.
 *
 * Walks the text tracking string state and bracket depth, drops a trailing
 * partial token (a half-written key, a value cut mid-word, a dangling comma),
 * then appends the brackets needed to balance what is open. Deliberately dumb:
 * it does not try to understand the schema, only to make the text parseable.
 */
function closeTruncated(text: string): string {
  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  let lastComplete = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      stack.pop();
      // A value or element ends here, so this is a safe place to cut.
      if (stack.length > 0) lastComplete = i;
    }
  }
  if (!inString && stack.length === 0) return text;

  // Cut back to the last point a value completed, then re-scan for depth.
  const cut = lastComplete >= 0 ? text.slice(0, lastComplete + 1) : text.slice(0, text.lastIndexOf(","));
  const trimmed = cut.replace(/[,:]\s*$/, "");
  const depth: string[] = [];
  let str = false;
  let esc = false;
  for (const ch of trimmed) {
    if (str) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') str = false;
    } else if (ch === '"') str = true;
    else if (ch === "{" || ch === "[") depth.push(ch);
    else if (ch === "}" || ch === "]") depth.pop();
  }
  if (str) return `${trimmed}"${depth.reverse().map((d) => (d === "{" ? "}" : "]")).join("")}`;
  return trimmed + depth.reverse().map((d) => (d === "{" ? "}" : "]")).join("");
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
    { maxTokens: MAX_OUTPUT.captionOne },
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
    const { text, usage } = await chat(cfg, [{ role: "user", content }], { maxTokens: MAX_OUTPUT.captionBatch });
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
    { maxTokens: MAX_OUTPUT.translate },
  );
  const parsed = looseJson(text) as { items?: { key: string; text: string }[] };
  return { items: parsed.items ?? [], usage };
}

/**
 * A day summary, with a fallback that sacrifices highlights rather than the day.
 *
 * The full reply — every stop's cards, each with a title, a description and a
 * placard translation — is the longest JSON these prompts ask for, and a
 * truncation in it used to lose the whole day. If the first attempt does not
 * parse, a second asks only for the prose: the day keeps its summary and stop
 * headings, and the cards are left for the next run. Half a day beats none.
 */
async function summarizeDay(cfg: OpenAiCompatConfig, input: SummarizeDayInput): Promise<DaySummaryResult> {
  const { text } = await chat(
    cfg,
    [{ role: "user", content: `${dayPrompt(input)}\n\nReply with ONE JSON object:\n${DAY_JSON_SHAPE}` }],
    { maxTokens: MAX_OUTPUT.day },
  );
  try {
    return parseDaySummary(input, looseJson(text));
  } catch (err) {
    console.warn(`  day summary JSON did not parse (${(err as Error).message}); retrying without cards`);
    const plain = await chat(
      cfg,
      [
        {
          role: "user",
          content:
            `${dayPrompt(input)}\n\nThe cards are omitted this time. Reply with ONE JSON object:\n` +
            `{"summary":"2-4 sentence prose summary of the whole day",` +
            `"segments":[{"id":"the stop id, exactly as given","title":"venue or place, 1-4 words","summary":"1-3 sentences or null","highlights":[]}]}`,
        },
      ],
      { maxTokens: MAX_OUTPUT.day },
    );
    return parseDaySummary(input, looseJson(plain.text));
  }
}

async function summarizeTrip(cfg: OpenAiCompatConfig, input: SummarizeTripInput): Promise<TripSummaryResult> {
  const { text, usage } = await chat(
    cfg,
    [{ role: "user", content: `${tripPrompt(input)}\n\nReply with ONE JSON object:\n${TRIP_JSON_SHAPE}` }],
    { maxTokens: MAX_OUTPUT.trip },
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
