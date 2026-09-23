import type {
  DaySummaryResult,
  SegmentResult,
  SummarizeDayInput,
  SummarizeTripInput,
  TripSummaryResult,
} from "./types.js";
import { altInstructions, nativeText } from "./altLanguage.js";

/**
 * The day- and trip-summary prompts, and the parsing of what comes back.
 *
 * Shared by both providers for the same reason `translatePrompt.ts` is shared:
 * switching provider must not also switch what a summary is asked to do, or
 * what it is allowed to contain. Each provider only adds its own output
 * instruction (a responseSchema for Gemini, a JSON shape in the prompt for
 * DeepSeek) and its own model settings.
 */

/**
 * What the owner said about this day, placed where it outranks the captions.
 *
 * The captions are a model's guesses about single photographs; this is
 * testimony from the person who was there. It is also the only channel for
 * things no photograph carries — that a stop is the the railway museum, or that a
 * morning was a write-off and must not be dressed up into an activity.
 *
 * Framed as authority over naming and framing, not as licence to invent: the
 * same caution `placeFromMetadataOnly` already encodes. A note that says where
 * you were does not tell the model what the pictures show.
 */
function ownerNote(input: SummarizeDayInput): string {
  const note = input.note?.trim();
  if (!note) return "";
  return `

FROM THE ARCHIVE OWNER, about this day:
${note}

This is first-hand and outranks anything inferred from the captions — for naming stops, for what the day was, and for what to leave alone. It does not license describing anything the photos do not show.`;
}

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
      const target = stop.kind === "transit" ? 0 : Math.max(1, Math.min(33, Math.round(stop.photos.length / 4)));
      const aim = target === 0 ? "" : `, aim for ~${target} cards`;
      return `STOP id=${stop.id} kind=${stop.kind} ${stop.startTime.slice(11, 16)}-${stop.endTime.slice(11, 16)} (${stop.photos.length} photos${aim})\n${photos}`;
    })
    .join("\n\n");
}

/** The day-summary prompt, up to but not including the output instruction. */
export function dayPrompt(input: SummarizeDayInput): string {
  return `Lay out one day of travel as a page: the day, the places in it, and what stood out at each.

Date: ${input.date}
Location: ${input.place ?? "unknown"}${ownerNote(input)}

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

${stopBlocks(input)}${metadataCaveats(input)}${altInstructions(input.alsoIn)}`;
}

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

/** The trip-narrative prompt, up to but not including the output instruction. */
export function tripPrompt(input: SummarizeTripInput): string {
  const naming = input.name
    ? `The traveller calls this trip "${input.name}". Use that name verbatim.`
    : `The traveller has not named this trip. Propose a short name from where they actually went.`;

  return `Write the story of one trip, from its day-by-day summaries.

${input.startDate} to ${input.endDate}, ${input.days.length} day(s).
${naming}

Write it as the traveller's own diary, looking back: what the trip was, where it went, what stood out. Prose only — no headings, no lists, no day-by-day recital. Break it into 3-6 paragraphs separated by a blank line. Do not invent anything the days below do not support.

The first and last days of a trip are usually spent travelling in and out, and they count as part of the trip. But an airport or a station passed through on the way is not a place visited: keep transit as travel, and leave it out of "places". Use the movement figures to tell the difference — a day that moved hundreds of kilometres is a travel day, however many photos it holds.

Days:

${tripDayLines(input)}${tripContext(input)}${altInstructions(input.alsoIn)}`;
}

/** The shape both providers' day responses must have; Gemini via responseSchema, DeepSeek via the prompt. */
export const DAY_JSON_SHAPE = `{"summary":"2-4 sentence prose summary of the whole day, no headings or bullets","segments":[{"id":"the stop id, exactly as given","title":"venue or place, 1-4 words; for transit say how it moved","summary":"1-3 sentences, or null for transit","highlights":[{"size":"full|half|normal","title":"what it is","description":"1-2 sentences or null","photo_ids":["1-3 ids of the thing itself"],"document_photo_ids":["ids of its placard/menu/sign, or []"],"document_translation":"what the placards say in English, or null"}]}]}`;

/** Likewise for the trip response. */
export const TRIP_JSON_SHAPE = `{"name":"short trip name, 2-5 words","narrative":"3-6 paragraphs separated by a blank line, prose only","places":["cities or regions actually visited, in order"]}`;

/**
 * Validates and normalizes a day response. Every photo id is checked against
 * the stop it was offered for: a hallucinated id would otherwise become a
 * highlight that renders as a blank tile, or hide a real photo behind a
 * document that does not exist.
 */
export function parseDaySummary(input: SummarizeDayInput, parsed: unknown): DaySummaryResult {
  const p = parsed as {
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

  const byStop = new Map(input.stops.map((s) => [s.id, new Set(s.photos.map((ph) => ph.id))]));

  const segments: SegmentResult[] = (p.segments ?? [])
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

  return { summary: p.summary.trim(), segments, native: nativeText(input.alsoIn, p) };
}

/** Validates a trip response. Returns everything but `usage`, which the provider attaches. */
export function parseTripSummary(input: SummarizeTripInput, parsed: unknown): Omit<TripSummaryResult, "usage"> {
  const p = parsed as { name: string; narrative: string; places: string[]; name_alt?: string };
  // A given name is used verbatim, so pair its twin with that, not with
  // whatever the model echoed back.
  const namePair: [string, string][] = input.name && p.name_alt ? [[input.name.trim(), p.name_alt]] : [];
  return {
    name: (input.name ?? p.name).trim(),
    narrative: p.narrative.trim(),
    places: p.places ?? [],
    native: nativeText(input.alsoIn, p, namePair),
  };
}
