import type { ContentType } from "@travel-archive/shared";

export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface CaptionPhotoInput {
  imageBase64: string;
  mediaType: ImageMediaType;
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
}

export interface SegmentResult {
  id: string;
  title: string;
  summary: string | null;
  highlights: { size: "full" | "half" | "normal"; title: string; description: string | null; photoIds: string[]; documentPhotoIds: string[]; documentTranslation: string | null }[];
}

export interface DaySummaryResult {
  summary: string;
  segments: SegmentResult[];
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
}

export interface TripSummaryResult {
  /** The given name, or the model's proposal when none was given. */
  name: string;
  narrative: string;
  /** Places actually visited — transit stops excluded. */
  places: string[];
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
}
