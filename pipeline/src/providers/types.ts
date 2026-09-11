import type { ContentType } from "@travel-archive/shared";

export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface CaptionPhotoInput {
  imageBase64: string;
  mediaType: ImageMediaType;
  /**
   * Where and when, and what was photographed around it.
   *
   * The captioner used to see one image and a static prompt, which is why it
   * could not know that a blue carriage is in the the railway museum — the *day*
   * summarizer can, because it sees every caption, the place and the placard
   * OCR at once. This is that same context moved one step earlier, where it is
   * cheap: the fields already exist on the photo record.
   *
   * It is a hint for **naming**, never licence to describe what the image does
   * not show — the caution `placeFromMetadataOnly` already encodes for days.
   * Null throughout for a photo with no date, no location and no captioned
   * neighbours, which is the pre-context behaviour exactly.
   */
  context: CaptionContext | null;
}

export interface CaptionContext {
  /** ISO instant, or a date alone when the clock is not to be trusted. */
  takenAt: string | null;
  /** Reverse-geocoded from GPS, so a hint rather than an observation. */
  place: string | null;
  /**
   * Captions of the nearest photos in time from the same day, already written.
   *
   * The cheapest way to tell the model it is looking at one frame of a museum
   * visit rather than an isolated object. Deliberately few and short: this is
   * orientation, not a transcript, and every one is input tokens on every photo.
   */
  nearbyCaptions: string[];
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
   * carry — that a stop is the the railway museum, or that a morning was a write-off
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
  photoCount: number;
  /** Highlights across the day's stops — how much of it was worth describing. */
  notableCount: number;
  /**
   * How far the day's centre sits from the previous day's, and how far the day
   * itself ranged. Both from GPS the free scan pass already collected.
   *
   * These exist because a trip's first and last days are usually spent
   * travelling, and captions alone make an airport look like a destination —
   * the archive's own Sep 2 is nothing but the airport terminal shops and aerial
   * views, which reads as "a day in a city" unless you can see that the day
   * began 870km away. Null when the day carries no usable GPS.
   */
  movedFromPreviousKm: number | null;
  spanKm: number | null;
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
}

export interface TranslateResult {
  /** Keyed like the input. Anything missing is simply not translated this time. */
  items: { key: string; text: string }[];
  usage?: CallUsage;
}

/**
 * Everything the pipeline needs from a model provider. Implement this to
 * swap in a different vision/text model (Gemini, etc.) — see
 * providers/anthropic.ts for the reference implementation, including the
 * JSON schema and prompt each method is expected to honor, and
 * providers/gemini.ts for a second implementation of the same contract.
 * providers/index.ts picks between them via the AI_PROVIDER env var.
 */
export interface AiProvider {
  captionPhoto(input: CaptionPhotoInput): Promise<CaptionResult>;
  summarizeDay(input: SummarizeDayInput): Promise<DaySummaryResult>;
  summarizeTrip(input: SummarizeTripInput): Promise<TripSummaryResult>;
  /** Text only, no images: the cheap way to put existing text into another language. */
  translate(input: TranslateInput): Promise<TranslateResult>;
}
