import type { ContentType } from "@travel-archive/shared";

export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface CaptionPhotoInput {
  imageBase64: string;
  mediaType: ImageMediaType;
  /**
   * Where and when — a hint for **naming**, never licence to describe what the
   * image does not show (see `captionContextBlock`). Null for a photo with
   * nothing known about it, which is the pre-context behaviour exactly.
   */
  context: CaptionContext | null;
}

/**
 * Only fields that can name something. The first version passed the town and
 * the six nearest captions, and on 20 photos of one museum none of them named
 * the museum, before or after: a town cannot name a museum, and neighbours
 * written without context cannot either. The neighbours
 * are gone — marginal in that test, +16% input on every photo, and impossible
 * in a batch, where every photo is sent before any caption exists.
 */
export interface CaptionContext {
  /** The camera's clock in words ("Tuesday 18 August 2026 at 11:12"), or the date alone when the clock is suspect. */
  takenAt: string | null;
  /** The trip this day falls in, by the owner's name for it. */
  trip: string | null;
  /** Reverse-geocoded town, so a hint rather than an observation. */
  place: string | null;
  /** The nearest named venue on the map at street level — a candidate name, often a neighbour. */
  venue: string | null;
  /** The street and district. */
  street: string | null;
  /** The owner's note for the day: the one field a person wrote. */
  dayNote: string | null;
  /** True when the image is a video's poster frame, so the caption must not describe motion it cannot see. */
  isVideo: boolean;
}

/**
 * Token counts for one call. Thinking tokens bill as output and are on by
 * default on Gemini 3.x, so a bulk pass is uncostable without them.
 */
export interface CallUsage {
  promptTokens: number;
  thoughtsTokens: number;
  outputTokens: number;
}

export interface CaptionResult {
  contentType: ContentType;
  caption: string;
  tags: string[];
  extractedText: string | null;
  notable: boolean;
  usage?: CallUsage;
}

export interface DayPhotoInput {
  id: string;
  caption: string;
  tags: string[];
  contentType: string;
}

/** One stop, already found by pipeline/src/stops.ts, for the model to name. */
export interface DayStopInput {
  id: string;
  kind: "place" | "transit";
  startTime: string;
  endTime: string;
  photos: DayPhotoInput[];
}

export interface SummarizeDayInput {
  date: string;
  place: string | null;
  stops: DayStopInput[];
  /**
   * At least one photo's clock is untrustworthy — phone sync on this library
   * shifts times by hours, and EXIF sometimes disagrees with the filename. The
   * day is usually right; the hour is not, so the summary must not narrate one.
   */
  timeUncertain: boolean;
  /**
   * `place` was derived from GPS alone, with nothing in the photos confirming
   * it. Coordinates go wrong often enough (4% of located photos here sit >100km
   * from their own day's median) that it should be treated as a hint.
   */
  placeFromMetadataOnly: boolean;
  /**
   * What the owner said about this day, in their own words.
   *
   * This outranks anything the model infers from the pictures: the captions are
   * guesses about what a photograph shows, and this is testimony from the person
   * who was there. It is also the only channel for things no photograph can
   * carry — that a stop is the transport museum, or that a morning was a write-off
   * and should not be dressed up as an activity.
   */
  note: string | null;
  /**
   * A second language to write the same page in, natively, in the same call —
   * see altLanguage.ts. Absent or null for English only.
   */
  alsoIn?: string | null;
}

export interface SegmentResult {
  id: string;
  title: string;
  summary: string | null;
  highlights: { size: "full" | "half" | "normal"; title: string; description: string | null; photoIds: string[]; documentPhotoIds: string[]; documentTranslation: string | null }[];
}

/**
 * Text the model wrote in a second language beside the English, as
 * (English, other) pairs — stored keyed by the English, like a translation.
 */
export interface NativeText {
  lang: string;
  pairs: [string, string][];
}

export interface DaySummaryResult {
  summary: string;
  segments: SegmentResult[];
  native?: NativeText | null;
}

/**
 * One day as the trip narrator sees it: the day summary already written for it,
 * plus enough movement to tell a travel day from a day spent somewhere.
 */
export interface TripDayInput {
  date: string;
  place: string | null;
  summary: string | null;
  /**
   * Whether this was a day of travelling rather than a day spent somewhere.
   *
   * **The kind, not the figures.** The prompt used to carry `movedFromPreviousKm`
   * and `spanKm` and ask the model to use them to tell the two apart — and it
   * narrated them instead: "because this day moved 19km from Bedford I count it
   * as travel". A distance is an input to a judgement, and once it is in the
   * text the model has something to quote. The judgement happens in trip.ts;
   * only its result travels.
   */
  isTravel: boolean;
  /** Titles of the places the day was spent at, transit excluded. */
  places: string[];
  /** Titles of what stood out — an exhibition, a building, a train. No descriptions. */
  highlights: string[];
  /** Kept for callers that still measure movement; never rendered into the prompt. */
  movedFromPreviousKm?: number | null;
  spanKm?: number | null;
}

export interface SummarizeTripInput {
  /** Null asks the model to propose one. */
  name: string | null;
  startDate: string;
  endDate: string;
  days: TripDayInput[];
  /** Free text the user pasted — typically an LLM trip-planning conversation. */
  notes: string | null;
  documents: { name: string; text: string }[];
  /** A second language to write the name, narrative and places in too. */
  alsoIn?: string | null;
}

export interface TripSummaryResult {
  /** The given name, or the model's proposal when none was given. */
  name: string;
  narrative: string;
  /** Places actually visited — transit stops excluded. */
  places: string[];
  usage?: CallUsage;
  native?: NativeText | null;
}

/** One text to translate. `kind` tells the model what it is — a caption, a title, a placard. */
export interface TranslateItem {
  key: string;
  text: string;
  kind: string;
}

export interface TranslateInput {
  sourceLang: string;
  targetLang: string;
  items: TranslateItem[];
  /**
   * The texts are in whatever language each was found in, not one source
   * language — a photographed label or sign often prints the same thing in two
   * or three languages at once. The prompt then asks for the meaning once, not
   * once per language (see translatePrompt.ts).
   */
  mixedSource?: boolean;
}

export interface TranslateResult {
  /** Keyed like the input. Anything missing is simply not translated this time. */
  items: { key: string; text: string }[];
  usage?: CallUsage;
}

/**
 * Everything the pipeline needs from a model provider. Implement this to
 * swap in a different vision/text model — see providers/gemini.ts for the
 * reference implementation, including the JSON schema and prompt each method
 * is expected to honor. providers/index.ts picks the implementation via the
 * AI_PROVIDER env var.
 */
export interface AiProvider {
  captionPhoto(input: CaptionPhotoInput): Promise<CaptionResult>;
  /**
   * Optional: caption several photos in **one** request, returning results in
   * input order. A provider that can do it (DeepSeek) gets a large cut in
   * request count over a bulk pass; the single-photo method above stays the
   * contract for one-off use. Callers must tolerate a shorter return — a result
   * the model omitted is left for the next run.
   */
  captionPhotos?(inputs: CaptionPhotoInput[]): Promise<CaptionResult[]>;
  /** Optional: how many `captionPhotos` wants per call. Ignored when absent. */
  batchSize?: number;
  summarizeDay(input: SummarizeDayInput): Promise<DaySummaryResult>;
  summarizeTrip(input: SummarizeTripInput): Promise<TripSummaryResult>;
  /** Text only, no images: the cheap way to put existing text into another language. */
  translate(input: TranslateInput): Promise<TranslateResult>;
}
