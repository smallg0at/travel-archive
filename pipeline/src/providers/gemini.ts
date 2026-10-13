import { GoogleGenAI, MediaResolution, Type } from "@google/genai";
import { env } from "../env.js";
import type {
  AiProvider,
  CallUsage,
  CaptionPhotoInput,
  CaptionResult,
  DaySummaryResult,
  SegmentResult,
  SummarizeDayInput,
  SummarizeTripInput,
  TranslateInput,
  TranslateResult,
  TripSummaryResult,
} from "./types.js";
import { translatePrompt } from "./translatePrompt.js";
import { withAltFields } from "./altLanguage.js";
import { dayPrompt, tripPrompt, parseDaySummary, parseTripSummary } from "./summarise.js";
import { captionContextBlock } from "./captionContext.js";

// Written against @google/genai's documented structured-output shape
// (responseSchema + the Type enum, nullable fields) at the time this was
// added. The JS SDK's surface here has moved before — if this throws on your
// first run, check the current Gemini API docs for
// GenerateContentConfig.responseSchema before assuming the prompt or schema
// content itself is wrong.
// Built on first use and rebuilt when the key changes. The key can arrive at
// runtime from the Settings config form.
let genai: GoogleGenAI | null = null;
let genaiKey: string | undefined;

function ai(): GoogleGenAI {
  if (!genai || genaiKey !== env.geminiApiKey) {
    genaiKey = env.geminiApiKey;
    genai = new GoogleGenAI({ apiKey: genaiKey });
  }
  return genai;
}

/**
 * Retries a call that failed for a reason time can fix.
 *
 * Rate limits and 5xx are transient; a bad prompt or a bad key is not, and
 * retrying those just burns the window. Without this a burst of 429s during a
 * long unattended run marks every affected photo `failed` — recoverable, since
 * `analyzedAt` stays null and a re-run picks them up, but it would silently
 * turn an 80-minute run into a partial one.
 */
const RETRYABLE = /(429|500|502|503|504|RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED|INTERNAL|fetch failed|ECONNRESET|ETIMEDOUT)/i;
const MAX_ATTEMPTS = 5;

async function withRetry<T>(label: string, call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      if (attempt >= MAX_ATTEMPTS || !RETRYABLE.test(message)) throw err;
      // Exponential with jitter, so a pool of workers that all trip the limit
      // at once does not march back in lockstep and trip it again.
      const backoff = Math.min(30_000, 1500 * 2 ** (attempt - 1)) * (0.7 + Math.random() * 0.6);
      console.warn(`  ${label} retry ${attempt}/${MAX_ATTEMPTS - 1} in ${Math.round(backoff)}ms — ${message.slice(0, 120)}`);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}
// Model is a parameter rather than a module constant so a single run can
// compare models side by side (scripts/bakeoff.mjs) and so a future job can
// pick a model per task — a cheap one for bulk captioning, a stronger one for
// a trip narrative.

const TRANSLATE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { key: { type: Type.STRING }, text: { type: Type.STRING } },
        required: ["key", "text"],
      },
    },
  },
  required: ["items"],
};

/**
 * Existing text into another language — no images, so it costs a fraction of a
 * caption. Thinking is asked off; see `thinkingFor` on how far that is honoured.
 */
async function translate(model: string, input: TranslateInput): Promise<TranslateResult> {
  const response = await withRetry("translate", () => ai().models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: translatePrompt(input) }] }],
    config: {
      responseMimeType: "application/json",
      responseSchema: TRANSLATE_SCHEMA,
      ...thinkingFor("minimal"),
    },
  }));

  const text = response.text;
  if (!text) throw new Error(`Empty response from Gemini translate call — ${emptyReason(response)}`);
  const parsed = JSON.parse(text) as { items?: { key: string; text: string }[] };
  const meta = response.usageMetadata;
  return {
    items: parsed.items ?? [],
    usage: {
      promptTokens: meta?.promptTokenCount ?? 0,
      thoughtsTokens: meta?.thoughtsTokenCount ?? 0,
      outputTokens: meta?.candidatesTokenCount ?? 0,
    },
  };
}

const CAPTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    content_type: { type: Type.STRING, enum: ["scene", "document", "food", "landscape", "screenshot", "other"] },
    caption: { type: Type.STRING, description: "One plain sentence describing the photo." },
    tags: { type: Type.ARRAY, items: { type: Type.STRING }, description: "3-6 short lowercase tags." },
    extracted_text: {
      type: Type.STRING,
      nullable: true,
      description: "Full transcribed text if this is a sign, plaque, menu, or other document. Null otherwise.",
    },
    notable: {
      type: Type.BOOLEAN,
      description:
        "True if this photo deserves its own entry rather than being folded into the day's summary — a document, or a genuinely distinctive shot. False for routine/near-duplicate snapshots.",
    },
  },
  required: ["content_type", "caption", "tags", "extracted_text", "notable"],
};

/** Shared with the OpenAI-compatible providers; see `captionPrompt.ts` for why it lives in one file. */
import { briefFor, CAPTION_PROMPT } from "./captionPrompt.js";

/**
 * How much the model thinks is decided in `geminiConfig.ts`: Google retired
 * `thinking_budget` for `thinking_level`, and that file is the one place that
 * knows it, so no call site here can reintroduce the old field by accident.
 *
 * The cost observation that made it configurable still holds regardless:
 * thinking runs ~150 tokens a caption against ~1227 input — a few percent of
 * the bill — and on gemini-3.7-flash a budget of 0 measured not to stop it
 * anyway (84-114 thinking tokens a call).
 */
import { thinkingFor, type ThinkingLevel } from "./geminiConfig.js";

/**
 * Captions read the image at low resolution.
 *
 * Measured 2026-09-11, default against low, with the context block: on 24
 * photos from twelve named stops, input fell from 1,429 to 628 tokens a photo
 * (−56%) and the captions named places as often; on 10 documents with long
 * transcriptions, both matched the stored text at 97% word overlap. The one
 * visible loss was a little detail in a caption or two — "a printed food menu
 * from Stöckl im Park" where default listed its sections. Set this to
 * `MEDIA_RESOLUTION_UNSPECIFIED` for the model's default.
 */
const CAPTION_RESOLUTION = MediaResolution.MEDIA_RESOLUTION_LOW;

interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
}

/**
 * Says *why* a response came back with no text. Gemini returns HTTP 200 with an
 * empty body in several unrelated situations, so without this they all read as
 * a generic "empty response".
 *
 * Worth having: on the first real run the failures looked like a safety filter
 * (an art museum, classical nudes) and were in fact `RECITATION` — the model
 * suppressing output too close to memorised training text. Guessing would have
 * sent the fix in the wrong direction entirely.
 */
function emptyReason(response: {
  candidates?: { finishReason?: string; safetyRatings?: { category?: string; probability?: string }[] }[];
  promptFeedback?: { blockReason?: string };
}): string {
  const blocked = response.promptFeedback?.blockReason;
  if (blocked) return `prompt blocked: ${blocked}`;

  const candidate = response.candidates?.[0];
  if (!candidate) return "no candidates returned";

  const flagged = (candidate.safetyRatings ?? [])
    .filter((r) => r.probability && !["NEGLIGIBLE", "LOW"].includes(r.probability))
    .map((r) => `${r.category}=${r.probability}`);

  return `finishReason=${candidate.finishReason ?? "unknown"}${flagged.length ? ` (${flagged.join(", ")})` : ""}`;
}

function usageOf(response: { usageMetadata?: UsageMetadata }): CallUsage {
  const u = response.usageMetadata ?? {};
  return {
    promptTokens: u.promptTokenCount ?? 0,
    thoughtsTokens: u.thoughtsTokenCount ?? 0,
    outputTokens: u.candidatesTokenCount ?? 0,
  };
}

/** Where and when, as a prompt block — shared with the other provider. */
function captionContext(input: CaptionPhotoInput): string {
  return captionContextBlock(input.context);
}

async function captionPhoto(model: string, thinkingLevel: ThinkingLevel | undefined, input: CaptionPhotoInput): Promise<CaptionResult> {
  const response = await withRetry("caption", () => ai().models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [{ inlineData: { mimeType: input.mediaType, data: input.imageBase64 } }, { text: briefFor(input) + captionContext(input) }],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: CAPTION_SCHEMA,
      // This buys no reproducibility, and Google has retired it anyway:
      // sampling parameters have been fixed to the model's defaults since 3.6
      // Flash (a custom value had no effect), and soon they are an error. It
      // never bought much in the first place — the same image captioned three
      // times gives three different sentences even at temperature 0, and the
      // thinking-token count varies with them (150/116/104).
      //
      // Design around nondeterminism rather than fighting it: never re-analyze
      // a photo that already has a caption (analyze.ts gates on analyzedAt),
      // let duplicate copies inherit one caption rather than earning their own,
      // and leave unchanged days alone in organize.ts. Those three rules are
      // what keep the archive's prose stable between runs.
      mediaResolution: CAPTION_RESOLUTION,
      ...thinkingFor(thinkingLevel),
    },
  }));

  let text = response.text;

  // RECITATION means Gemini suppressed the output as too close to memorised
  // training text. In a museum that fires reliably: asking it to transcribe the
  // plaque of a famous artwork is asking it to reproduce something it has seen
  // many times. Measured over one trip here, 4 of 398 photos failed this way
  // and kept failing on retry.
  //
  // Retry once asking for description only. That gives up the transcription for
  // those few photos but keeps the caption, tags and classification, which is a
  // far better outcome than leaving the photo undescribed entirely.
  if (!text && response.candidates?.[0]?.finishReason === "RECITATION") {
    const retry = await withRetry("caption-recitation", () => ai().models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: input.mediaType, data: input.imageBase64 } },
            { text: `${CAPTION_PROMPT}

Describe this in your own words. Do not transcribe or quote any text in the image; set extracted_text to null.` },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: CAPTION_SCHEMA,
        mediaResolution: CAPTION_RESOLUTION,
        ...thinkingFor(thinkingLevel),
      },
    }));
    text = retry.text;
    if (text) {
      const reparsed = JSON.parse(text) as {
        content_type: CaptionResult["contentType"];
        caption: string;
        tags: string[];
        extracted_text: string | null;
        notable: boolean;
      };
      return {
        contentType: reparsed.content_type,
        caption: reparsed.caption,
        tags: reparsed.tags,
        extractedText: null,
        notable: reparsed.notable,
        usage: usageOf(retry),
      };
    }
  }

  if (!text) throw new Error(`Empty response from Gemini captioning call — ${emptyReason(response)}`);

  const parsed = JSON.parse(text) as {
    content_type: CaptionResult["contentType"];
    caption: string;
    tags: string[];
    extracted_text: string | null;
    notable: boolean;
  };

  return {
    contentType: parsed.content_type,
    caption: parsed.caption,
    tags: parsed.tags,
    extractedText: parsed.extracted_text,
    notable: parsed.notable,
    usage: usageOf(response),
  };
}

const DAY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: {
      type: Type.STRING,
      description: "2-4 sentence diary-style prose summary of the whole day. No headings, no bullet points.",
    },
    segments: {
      type: Type.ARRAY,
      description: "One entry per stop given, in the same order, reusing the same ids.",
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          title: {
            type: Type.STRING,
            description:
              "The venue or place, 1-4 words. For a transit stop, say how it moved: 'Train to the next city'.",
          },
          summary: {
            type: Type.STRING,
            nullable: true,
            description: "1-3 sentences on this stop. Null for a transit stop that needs no comment.",
          },
          highlights: {
            type: Type.ARRAY,
            description:
              "The things worth stopping on here, best first: 1 full + up to 2 half + up to 30 normal. Empty for a transit stop.",
            items: {
              type: Type.OBJECT,
              properties: {
                size: {
                  type: Type.STRING,
                  enum: ["full", "half", "normal"],
                  description:
                    "How much room it deserves here. 'full' spans the width — at most one per stop, and only for the thing that defines it. 'half' for a second-order highlight. 'normal' otherwise.",
                },
                title: { type: Type.STRING, description: "What it is — a work, a building, a dish." },
                description: {
                  type: Type.STRING,
                  nullable: true,
                  description:
                    "1-2 sentences. Where a placard or menu was photographed, use what it says rather than repeating the caption.",
                },
                photo_ids: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: "The thing itself: 1-3 photos of it.",
                },
                document_translation: {
                  type: Type.STRING,
                  nullable: true,
                  description:
                    "What the bound placards say, rendered in English. Null if they are already English or there are none.",
                },
                document_photo_ids: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description:
                    "Photos that only describe it — its placard, its menu, its sign. Folded into the highlight, never shown separately.",
                },
              },
              required: ["size", "title", "description", "photo_ids", "document_photo_ids", "document_translation"],
            },
          },
        },
        required: ["id", "title", "summary", "highlights"],
      },
    },
  },
  required: ["summary", "segments"],
};

async function summarizeDay(model: string, thinkingLevel: ThinkingLevel | undefined, input: SummarizeDayInput): Promise<DaySummaryResult> {
  const response = await withRetry("day-summary", () => ai().models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          { text: dayPrompt(input) },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: input.alsoIn ? withAltFields(DAY_SCHEMA, input.alsoIn) : DAY_SCHEMA,
      ...thinkingFor(thinkingLevel),
    },
  }));

  const text = response.text;
  if (!text) throw new Error(`Empty response from Gemini day-summary call — ${emptyReason(response)}`);

  return parseDaySummary(input, JSON.parse(text));
}

const TRIP_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    name: {
      type: Type.STRING,
      description: "A short name for the trip, 2-5 words. Use the given name verbatim if one was given.",
    },
    narrative: {
      type: Type.STRING,
      description:
        "3-6 paragraphs of diary-style prose covering the whole trip, separated by a blank line. No headings, no bullet points.",
    },
    places: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Cities or regions actually visited, in order. Exclude airports and places merely passed through.",
    },
  },
  required: ["name", "narrative", "places"],
};

async function summarizeTrip(
  model: string,
  thinkingLevel: ThinkingLevel | undefined,
  input: SummarizeTripInput,
): Promise<TripSummaryResult> {
  const response = await withRetry("trip-narrative", () => ai().models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          { text: tripPrompt(input) },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: input.alsoIn ? withAltFields(TRIP_SCHEMA, input.alsoIn) : TRIP_SCHEMA,
      ...thinkingFor(thinkingLevel),
    },
  }));

  const text = response.text;
  if (!text) throw new Error(`Empty response from Gemini trip-summary call — ${emptyReason(response)}`);

  return { ...parseTripSummary(input, JSON.parse(text)), usage: usageOf(response) };
}

/**
 * One caption request as the Batch API takes it: the same prompt, schema and
 * settings as `captionPhoto`, so a batched caption is the one an interactive
 * run would have asked for. Plain JSON, because it goes into a JSONL file
 * rather than through the SDK.
 *
 * No RECITATION fallback here — a batch cannot retry mid-flight. A photo that
 * comes back empty stays uncaptioned, and the next interactive run, which has
 * the fallback, picks it up.
 */
export function captionBatchRequest(input: CaptionPhotoInput): object {
  return {
    contents: [
      {
        role: "user",
        parts: [{ inlineData: { mimeType: input.mediaType, data: input.imageBase64 } }, { text: briefFor(input) + captionContext(input) }],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: CAPTION_SCHEMA,
      mediaResolution: CAPTION_RESOLUTION,
      ...thinkingFor(env.geminiThinkingLevel),
    },
  };
}

/** A caption response's JSON, read the way `captionPhoto` reads it. */
export function parseCaptionJson(text: string): Omit<CaptionResult, "usage"> {
  const parsed = JSON.parse(text) as {
    content_type: CaptionResult["contentType"];
    caption: string;
    tags: string[];
    extracted_text: string | null;
    notable: boolean;
  };
  return {
    contentType: parsed.content_type,
    caption: parsed.caption,
    tags: parsed.tags,
    extractedText: parsed.extracted_text,
    notable: parsed.notable,
  };
}

/** The client itself, for the batch and file calls that have no provider-neutral shape. */
export function geminiClient(): GoogleGenAI {
  return ai();
}

export function createGeminiProvider(
  model: string = env.geminiModel,
  thinkingLevel: ThinkingLevel | undefined = env.geminiThinkingLevel,
): AiProvider {
  return {
    captionPhoto: (input) => captionPhoto(model, thinkingLevel, input),
    summarizeDay: (input) => summarizeDay(model, thinkingLevel, input),
    summarizeTrip: (input) => summarizeTrip(model, thinkingLevel, input),
    // Its own model when set: bulk translation is the place for the cheapest one.
    translate: (input) => translate(env.translateModel ?? model, input),
  };
}

export const geminiProvider: AiProvider = createGeminiProvider();
