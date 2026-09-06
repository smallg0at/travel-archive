import { GoogleGenAI, Type } from "@google/genai";
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
  TripSummaryResult,
} from "./types.js";

// Written against @google/genai's documented structured-output shape
// (responseSchema + the Type enum, nullable fields instead of Claude-style
// anyOf) at the time this was added. The JS SDK's surface here has moved
// before — if this throws on your first run, check the current Gemini API
// docs for GenerateContentConfig.responseSchema before assuming the prompt
// or schema content itself is wrong.
const ai = new GoogleGenAI({ apiKey: env.geminiApiKey });

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

const CAPTION_PROMPT = `You are cataloging a personal photo library that mixes travel photos, everyday snapshots, and phone screenshots. There are no people to identify — focus on place, subject, and content.
- content_type: scene, document (signs/plaques/menus/text-heavy), food, landscape, screenshot (a screen capture, not a camera photo), or other.
- caption: one plain sentence, no preamble.
- tags: 3-6 short lowercase tags.
- extracted_text: if this is primarily a sign, museum plaque, menu, or document, transcribe its text in full. Otherwise null.
- notable: true only if this photo should get its own write-up; false for routine snapshots that can be folded into a day summary.`;

/**
 * Gemini 3.x enables dynamic thinking by default and thinking tokens bill as
 * output, so this exists to bound that cost.
 *
 * In practice the model appears to ignore it: a budget of 0 still produced
 * 84-114 thinking tokens per call on gemini-3.7-flash. It is kept because the
 * cost turned out not to matter anyway — thinking runs ~150 tokens per caption
 * against ~1227 input, a few percent of the bill.
 */
function thinkingFor(budget: number | undefined) {
  return budget === undefined ? {} : { thinkingConfig: { thinkingBudget: budget } };
}

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

async function captionPhoto(model: string, thinkingBudget: number | undefined, input: CaptionPhotoInput): Promise<CaptionResult> {
  const response = await withRetry("caption", () => ai.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [{ inlineData: { mimeType: input.mediaType, data: input.imageBase64 } }, { text: CAPTION_PROMPT }],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: CAPTION_SCHEMA,
      // Note this does NOT buy reproducibility, though it is still the right
      // default for a factual captioning task. Measured: the same image
      // captioned three times gives three different sentences at temperature 0,
      // and the thinking-token count varies too (150/116/104), so the reasoning
      // path itself is nondeterministic and the wording follows it.
      //
      // Design around it rather than fighting it: never re-analyze a photo that
      // already has a caption (analyze.ts gates on analyzedAt), let duplicate
      // copies inherit one caption rather than earning their own, and leave
      // unchanged days alone in organize.ts. Those three rules are what keep
      // the archive's prose stable between runs.
      temperature: 0,
      ...thinkingFor(thinkingBudget),
    },
  }));

  let text = response.text;

  // RECITATION means Gemini suppressed the output as too close to memorised
  // training text. In a museum that fires reliably: asking it to transcribe the
  // plaque of a famous artwork is asking it to reproduce something it has seen
  // many times. Measured on the a city trip, 4 of 398 photos failed this way
  // and kept failing on retry.
  //
  // Retry once asking for description only. That gives up the transcription for
  // those few photos but keeps the caption, tags and classification, which is a
  // far better outcome than leaving the photo undescribed entirely.
  if (!text && response.candidates?.[0]?.finishReason === "RECITATION") {
    const retry = await withRetry("caption-recitation", () => ai.models.generateContent({
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
        temperature: 0,
        ...thinkingFor(thinkingBudget),
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
              "The venue or place, 1-4 words. For a transit stop, say how it moved: 'Train to a city'.",
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

function metadataCaveats(input: SummarizeDayInput): string {
  const notes: string[] = [];
  if (input.timeUncertain) {
    notes.push(
      "Some timestamps for this day are unreliable (device clock drift). Do not state or imply a specific time of day.",
    );
  }
  if (input.placeFromMetadataOnly) {
    notes.push(
      "The location above comes from GPS metadata alone and is not confirmed by the photos. Treat it as a hint: if what the photos show contradicts it, trust the photos and do not name the location.",
    );
  }
  if (notes.length === 0) return "";
  return `\n\nIMPORTANT:\n${notes.map((n) => `- ${n}`).join("\n")}`;
}

/**
 * The stops, with their photos listed under them.
 *
 * Stops arrive already found — clustered from GPS and timestamps before any
 * model ran (pipeline/src/stops.ts). That split matters: working out where a
 * day was spent is a measurement, and asking a model to infer it from 490
 * captions is asking it to do arithmetic it is bad at. It names, describes and
 * chooses; it never has to work out where anything was.
 */
function stopBlocks(input: SummarizeDayInput): string {
  return input.stops
    .map((stop) => {
      const photos = stop.photos
        .map((p) => `  - id=${p.id} [${p.contentType}] ${p.caption} (tags: ${p.tags.join(", ")})`)
        .join("\n");
      // A target, not just a cap. Told only "up to twenty", the model returned
      // seven cards for a 145-photo stop and collapsed the other 126 — the same
      // under-use that made the first day pages read as a list plus a drawer.
      // Stating the number to aim for is what fixed layout choice earlier too.
      const target = stop.kind === "transit" ? 0 : Math.max(1, Math.min(33, Math.round(stop.photos.length / 4)));
      const aim = target === 0 ? "" : `, aim for ~${target} cards`;
      return `STOP id=${stop.id} kind=${stop.kind} ${stop.startTime.slice(11, 16)}-${stop.endTime.slice(11, 16)} (${stop.photos.length} photos${aim})\n${photos}`;
    })
    .join("\n\n");
}

async function summarizeDay(model: string, thinkingBudget: number | undefined, input: SummarizeDayInput): Promise<DaySummaryResult> {
  const response = await withRetry("day-summary", () => ai.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `Lay out one day of travel as a page: the day, the places in it, and what stood out at each.

Date: ${input.date}
Location: ${input.place ?? "unknown"}

The day is already divided into stops by where and when the photos were taken. Return one segment per stop, in order, reusing the given ids exactly.

- title: the venue or place. Be specific where the photos support it; never invent a name they do not.
- summary: 1-3 sentences on the stop. A transit stop may have a null summary.
- highlights: the key pictures worth describing, best first, up to 33. Each is a thing — an artwork, a building, a dish — not a category.
  - size: how much room it deserves, and there is a budget per stop — exactly one "full" for the single thing that defined this place, at most two "half" for the next best, and up to thirty "normal" for everything else worth a glance. Fill the budget. Each stop states how many cards to aim for — roughly one per four photos. A stop with 145 photos and seven cards is wrong; only genuinely unremarkable or repetitive shots belong in the collapsed grid.
  - photo_ids: the photos of the thing itself.
  - document_translation: what those placards say, in English. Museum labels here are usually German or Slovak — translate them; only leave this null if the text really is already English. The archive owner does not read Slovak or German, so a verbatim transcript alone is unreadable to them. Null if already English or there are none.
  - document_photo_ids: photos that only describe it. A museum label belongs to the artwork beside it; a menu belongs to the meal. Binding them here is what stops the page showing the same exhibit twice.
  - Leave highlights empty for a transit stop.

Use each photo at most once across the whole day — a photo already used by one highlight must not appear in another. Not every photo needs to be a highlight; the rest are still shown, in a grid under the stop.

Also write a 2-4 sentence summary of the day as a whole.

${stopBlocks(input)}${metadataCaveats(input)}`,
          },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: DAY_SCHEMA,
      temperature: 0,
      ...thinkingFor(thinkingBudget),
    },
  }));

  const text = response.text;
  if (!text) throw new Error(`Empty response from Gemini day-summary call — ${emptyReason(response)}`);

  const parsed = JSON.parse(text) as {
    summary: string;
    segments: {
      id: string;
      title: string;
      summary: string | null;
      highlights: {
        size: "full" | "half" | "normal";
        title: string;
        description: string | null;
        photo_ids: string[];
        document_photo_ids: string[];
        document_translation: string | null;
      }[];
    }[];
  };

  // Every photo id is checked against the stop it was offered for. A
  // hallucinated id would otherwise become a highlight that renders as a blank
  // tile, or hide a real photo behind a document that does not exist.
  const byStop = new Map(input.stops.map((s) => [s.id, new Set(s.photos.map((p) => p.id))]));

  const segments: SegmentResult[] = parsed.segments
    .filter((seg) => byStop.has(seg.id))
    .map((seg) => {
      const valid = byStop.get(seg.id)!;
      return {
        id: seg.id,
        title: seg.title.trim(),
        summary: seg.summary?.trim() || null,
        highlights: (seg.highlights ?? [])
          .map((h) => ({
            size: h.size === "full" || h.size === "half" ? h.size : ("normal" as const),
            title: h.title.trim(),
            description: h.description?.trim() || null,
            photoIds: (h.photo_ids ?? []).filter((id) => valid.has(id)).slice(0, 3),
            documentPhotoIds: (h.document_photo_ids ?? []).filter((id) => valid.has(id)),
            documentTranslation: h.document_translation?.trim() || null,
          }))
          // A highlight with no surviving photo of the thing is not a highlight.
          .filter((h) => h.photoIds.length > 0),
      };
    });

  return { summary: parsed.summary.trim(), segments };
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

/**
 * Turns each day into one line the narrator can reason over, with the movement
 * facts attached.
 *
 * A trip's first and last days are usually spent getting there and back, and
 * the day summaries alone do not make that obvious — this archive's Sep 2 reads
 * as a day of terminal shops and aerial views, which sounds like a day out in
 * a city until you can see the day started 870km from where it ended.
 */
function tripDayLines(input: SummarizeTripInput): string {
  return input.days
    .map((d) => {
      const moved = d.movedFromPreviousKm === null ? "" : ` moved ${Math.round(d.movedFromPreviousKm)}km from the previous day;`;
      const span = d.spanKm === null ? "" : ` ranged ${Math.round(d.spanKm)}km within the day;`;
      const place = d.place ? ` [${d.place}]` : "";
      return `${d.date}${place} — ${d.photoCount} photos, ${d.notableCount} notable;${moved}${span}\n  ${d.summary ?? "(no summary written for this day)"}`;
    })
    .join("\n\n");
}

function tripContext(input: SummarizeTripInput): string {
  const parts: string[] = [];
  if (input.notes?.trim()) parts.push(`Notes from the traveller:\n${input.notes.trim()}`);
  for (const doc of input.documents) {
    if (doc.text.trim()) parts.push(`Document "${doc.name}":\n${doc.text.trim()}`);
  }
  if (parts.length === 0) return "";
  return `\n\nSupporting material the traveller supplied. Use it for names, plans and intent, but the photos are the record of what actually happened — where the two disagree, trust the photos.\n\n${parts.join("\n\n")}`;
}

async function summarizeTrip(
  model: string,
  thinkingBudget: number | undefined,
  input: SummarizeTripInput,
): Promise<TripSummaryResult> {
  const naming = input.name
    ? `The traveller calls this trip "${input.name}". Use that name verbatim.`
    : `The traveller has not named this trip. Propose a short name from where they actually went.`;

  const response = await withRetry("trip-narrative", () => ai.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `Write the story of one trip, from its day-by-day summaries.

${input.startDate} to ${input.endDate}, ${input.days.length} day(s).
${naming}

Write it as the traveller's own diary, looking back: what the trip was, where it went, what stood out. Prose only — no headings, no lists, no day-by-day recital. Break it into 3-6 paragraphs separated by a blank line. Do not invent anything the days below do not support.

The first and last days of a trip are usually spent travelling in and out, and they count as part of the trip. But an airport or a station passed through on the way is not a place visited: keep transit as travel, and leave it out of "places". Use the movement figures to tell the difference — a day that moved hundreds of kilometres is a travel day, however many photos it holds.

Days:

${tripDayLines(input)}${tripContext(input)}`,
          },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: TRIP_SCHEMA,
      temperature: 0,
      ...thinkingFor(thinkingBudget),
    },
  }));

  const text = response.text;
  if (!text) throw new Error(`Empty response from Gemini trip-summary call — ${emptyReason(response)}`);

  const parsed = JSON.parse(text) as { name: string; narrative: string; places: string[] };
  return {
    name: (input.name ?? parsed.name).trim(),
    narrative: parsed.narrative.trim(),
    places: parsed.places ?? [],
    usage: usageOf(response),
  };
}

export function createGeminiProvider(
  model: string = env.geminiModel,
  thinkingBudget: number | undefined = env.geminiThinkingBudget,
): AiProvider {
  return {
    captionPhoto: (input) => captionPhoto(model, thinkingBudget, input),
    summarizeDay: (input) => summarizeDay(model, thinkingBudget, input),
    summarizeTrip: (input) => summarizeTrip(model, thinkingBudget, input),
  };
}

export const geminiProvider: AiProvider = createGeminiProvider();
