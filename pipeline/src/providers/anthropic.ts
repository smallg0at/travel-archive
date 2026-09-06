import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env.js";
import type {
  AiProvider,
  CaptionPhotoInput,
  CaptionResult,
  DaySummaryResult,
  SegmentResult,
  SummarizeDayInput,
  SummarizeTripInput,
  TripSummaryResult,
} from "./types.js";

const client = new Anthropic(env.anthropicApiKey ? { apiKey: env.anthropicApiKey } : {});
const MODEL = env.anthropicModel;

const CAPTION_SCHEMA = {
  type: "object",
  properties: {
    content_type: { type: "string", enum: ["scene", "document", "food", "landscape", "screenshot", "other"] },
    caption: { type: "string", description: "One plain sentence describing the photo." },
    tags: { type: "array", items: { type: "string" }, description: "3-6 short lowercase tags." },
    extracted_text: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "Full transcribed text if this is a sign, plaque, menu, or other document. Null otherwise.",
    },
    notable: {
      type: "boolean",
      description:
        "True if this photo deserves its own entry rather than being folded into the day's summary — a document, or a genuinely distinctive shot. False for routine/near-duplicate snapshots.",
    },
  },
  required: ["content_type", "caption", "tags", "extracted_text", "notable"],
  additionalProperties: false,
} as const;

const CAPTION_PROMPT = `You are cataloging a personal photo library that mixes travel photos, everyday snapshots, and phone screenshots. There are no people to identify — focus on place, subject, and content.
- content_type: scene, document (signs/plaques/menus/text-heavy), food, landscape, screenshot (a screen capture, not a camera photo), or other.
- caption: one plain sentence, no preamble.
- tags: 3-6 short lowercase tags.
- extracted_text: if this is primarily a sign, museum plaque, menu, or document, transcribe its text in full. Otherwise null.
- notable: true only if this photo should get its own write-up; false for routine snapshots that can be folded into a day summary.`;

async function captionPhoto(input: CaptionPhotoInput): Promise<CaptionResult> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    thinking: { type: "disabled" },
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: CAPTION_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: input.mediaType, data: input.imageBase64 } },
          { type: "text", text: CAPTION_PROMPT },
        ],
      },
    ],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) throw new Error("No text block in captioning response");

  const parsed = JSON.parse(textBlock.text) as {
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

const DAY_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "2-4 sentence diary-style prose summary of the whole day." },
    segments: {
      type: "array",
      description: "One entry per stop given, in the same order, reusing the same ids.",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string", description: "The venue or place, 1-4 words." },
          summary: { anyOf: [{ type: "string" }, { type: "null" }] },
          highlights: {
            type: "array",
            description:
              "The things worth stopping on here, best first: 1 full + up to 2 half + up to 30 normal. Empty for a transit stop.",
            items: {
              type: "object",
              properties: {
                size: { type: "string", enum: ["full", "half", "normal"] },
                title: { type: "string" },
                description: { anyOf: [{ type: "string" }, { type: "null" }] },
                photo_ids: { type: "array", items: { type: "string" } },
                document_translation: { anyOf: [{ type: "string" }, { type: "null" }] },
                document_photo_ids: { type: "array", items: { type: "string" } },
              },
              required: ["size", "title", "description", "photo_ids", "document_photo_ids", "document_translation"],
              additionalProperties: false,
            },
          },
        },
        required: ["id", "title", "summary", "highlights"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "segments"],
  additionalProperties: false,
} as const;

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
      // A target, not just a cap — see the note on the same line in gemini.ts.
      const target = stop.kind === "transit" ? 0 : Math.max(1, Math.min(33, Math.round(stop.photos.length / 4)));
      const aim = target === 0 ? "" : `, aim for ~${target} cards`;
      return `STOP id=${stop.id} kind=${stop.kind} ${stop.startTime.slice(11, 16)}-${stop.endTime.slice(11, 16)} (${stop.photos.length} photos${aim})\n${photos}`;
    })
    .join("\n\n");
}

async function summarizeDay(input: SummarizeDayInput): Promise<DaySummaryResult> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    thinking: { type: "disabled" },
    output_config: { effort: "low", format: { type: "json_schema", schema: DAY_SCHEMA } },
    messages: [
      {
        role: "user",
        content: `Lay out one day of travel as a page: the day, the places in it, and what stood out at each.

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
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) throw new Error("No text block in day-summary response");

  const parsed = JSON.parse(textBlock.text) as {
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

  // Ids are validated against the stop they were offered for — see the note in
  // providers/gemini.ts on why a hallucinated id is worse than a missing one.
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
          .filter((h) => h.photoIds.length > 0),
      };
    });

  return { summary: parsed.summary.trim(), segments };
}


const TRIP_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "A short name for the trip, 2-5 words. Use the given name verbatim if one was given." },
    narrative: {
      type: "string",
      description:
        "3-6 paragraphs of diary-style prose covering the whole trip, separated by a blank line. No headings, no bullet points.",
    },
    places: {
      type: "array",
      items: { type: "string" },
      description: "Cities or regions actually visited, in order. Exclude airports and places merely passed through.",
    },
  },
  required: ["name", "narrative", "places"],
  additionalProperties: false,
} as const;

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

async function summarizeTrip(input: SummarizeTripInput): Promise<TripSummaryResult> {
  const naming = input.name
    ? `The traveller calls this trip "${input.name}". Use that name verbatim.`
    : `The traveller has not named this trip. Propose a short name from where they actually went.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    thinking: { type: "disabled" },
    output_config: { effort: "low", format: { type: "json_schema", schema: TRIP_SCHEMA } },
    messages: [
      {
        role: "user",
        content: `Write the story of one trip, from its day-by-day summaries.

${input.startDate} to ${input.endDate}, ${input.days.length} day(s).
${naming}

Write it as the traveller's own diary, looking back: what the trip was, where it went, what stood out. Prose only — no headings, no lists, no day-by-day recital. Break it into 3-6 paragraphs separated by a blank line. Do not invent anything the days below do not support.

The first and last days of a trip are usually spent travelling in and out, and they count as part of the trip. But an airport or a station passed through on the way is not a place visited: keep transit as travel, and leave it out of "places". Use the movement figures to tell the difference — a day that moved hundreds of kilometres is a travel day, however many photos it holds.

Days:

${tripDayLines(input)}${tripContext(input)}`,
      },
    ],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) throw new Error("No text block in trip-summary response");

  const parsed = JSON.parse(textBlock.text) as { name: string; narrative: string; places: string[] };
  return {
    name: (input.name ?? parsed.name).trim(),
    narrative: parsed.narrative.trim(),
    places: parsed.places ?? [],
  };
}

export const anthropicProvider: AiProvider = { captionPhoto, summarizeDay, summarizeTrip };
