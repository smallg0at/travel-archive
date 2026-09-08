export type ContentType = "scene" | "document" | "food" | "landscape" | "screenshot" | "other";

export interface GeoPoint {
  lat: number;
  lon: number;
}

/**
 * Bumped whenever the on-disk/OneDrive layout changes shape. The app checks
 * this so a stale index written by an older pipeline fails loudly instead of
 * rendering half-empty.
 *
 * v3 added burst grouping, byte sizes, curation and GPS-suspicion fields.
 * v4 added date provenance and clock-drift suspicion.
 * v5 replaced timestamp-window bursts with exact duplicate detection.
 * v6 added a local screenshot gate; v7 replaced it with an app allowlist.
 * v8 added redaction flags for identifiers found in transcribed text.
 * v9 recorded which photos a day summary was actually written from.
 * v10 added trip narratives.
 * v11 replaced the day's single layout with per-stop segments.
 * v12 dropped heroes in favour of sized highlight cards.
 * v13 added a per-stop card budget and English renderings of placard text.
 */
export const SCHEMA_VERSION = 13;

/** How much a photo should be surfaced. `hidden` still renders behind a "show more" toggle — never removed. */
export type Visibility = "feature" | "normal" | "hidden";

/** The model's read on whether a photo is technically usable. */
export type PhotoQuality = "good" | "poor";

/**
 * Where a photo's timestamp came from, in descending order of trust.
 * `filesystem` means OneDrive's own write time — which phone sync rewrites,
 * so it says when the file landed, not when the photo was taken.
 */
/**
 * Where a photo's capture time came from.
 *
 * `filename-date` is separate from `filename` because it carries a date but no
 * clock time: the stored time is a midnight nobody measured. Anything reasoning
 * about *when in the day* something happened must ignore it — see stops.ts.
 */
export type DateSource = "exif" | "filename" | "filename-date" | "filesystem" | "none";

/**
 * Why a photo is considered a redundant copy. `exact` is the same file
 stored twice (Windows/OneDrive " 1", " 2" suffixes); `burst` is a frame the
 * camera itself labelled `_BURSTn`. Both are exact signals — an earlier
 * timestamp-window heuristic was removed for grouping unrelated photos.
 */
export type DuplicateKind = "exact" | "burst";

/**
 * Whether a screenshot's source app is on the user's allowlist, and may
 * therefore be described by an AI model. Screenshots default to not analyzable:
 * they carry private messages, mail, tickets and banking, so only apps the user
 * has explicitly approved are ever sent anywhere. Not analyzable is not hidden —
 * the photo still appears in the album.
 */
export interface ScreenshotPolicy {
  /** Android package from the filename, or null when the name carries none. */
  sourceApp: string | null;
  analyzable: boolean;
}

/**
 * What kind of personal identifier was found in a photo's transcribed text.
 * `personal_term` is a literal string from the user's own list
 * (pipeline/redaction-terms.json) — their name, most usefully, which no
 * pattern can find generically.
 */
export type SensitiveKind =
  | "email_address"
  | "phone"
  | "card_number"
  | "passport_or_id"
  | "national_id"
  | "iban"
  | "booking_reference"
  | "personal_term";

/**
 * Set on a photo whose `extractedText` contains identifiers. Its only effect
 * is that the photo is withheld from day summaries, so nothing it says can be
 * paraphrased into generated prose. The photo, its caption and its transcript
 * all stay in the archive and still render in the album.
 *
 * Detection is regex-based and therefore fallible, so a hit is reviewable
 * rather than final: `samples` shows partially-masked excerpts of what matched,
 * and setting `dismissed` releases the photo without deleting the flag or
 * inviting the next `redact` run to re-raise it.
 */
export interface SensitiveFlag {
  kinds: SensitiveKind[];
  samples: string[];
  flaggedAt: string;
  dismissed: boolean;
}

export interface PhotoRecord {
  id: string;
  fileName: string;
  oneDrivePath: string;

  /**
   * Which shard this record lives in ("2025-04"). Derived from `takenAt`
   * where available, falling back to the `yyyy-mm` OneDrive folder the photo
   * was found in — so it's always set even when a screenshot has no EXIF
   * date at all, which is what makes it usable as the shard key.
   */
  month: string;

  takenAt: string | null;
  dateSource: DateSource;
  /**
   * The clock time is unreliable even if the date is roughly right. Set when
   * EXIF and the filename disagree by over an hour (something rewrote one),
   * or when the only timestamp available is the filesystem's. Phone sync is
   * known to shift times by a few hours on this library, so summaries must
   * not narrate a precise hour from a suspect timestamp.
   */
  timeSuspect: boolean;
  width: number | null;
  height: number | null;
  /** File size from Graph. Doubles as a free sharpness proxy — blurry frames compress smaller. */
  bytes: number;

  gps: GeoPoint | null;
  place: string | null;
  /**
   * GPS that contradicts the rest of its day (>100km from the day's median).
   * Phone location fixes go wrong often enough — and 92% of this library
   * carries GPS — that a single bad point would otherwise decide a whole
   * day's place. Suspect points are excluded from place derivation and the
   * model is told to trust photo content over coordinates.
   */
  gpsSuspect: boolean;

  /**
   * Redundant copies of another photo — 1.9% of this library, almost all of it
   * the same file saved two or three times. Detected exactly (filename copy
   * suffixes, or the camera's own `_BURSTn` label), never inferred from
   * timestamps. Only the representative is analyzed; the rest inherit its
   * description and collapse behind a "show more" toggle in the album.
   */
  duplicateGroupId: string | null;
  duplicateKind: DuplicateKind | null;
  isDuplicateRepresentative: boolean;

  /**
   * When the AI pass last described this photo, or null if it never has.
   * The scan pass (pipeline/src/scan.ts) writes records with this null and
   * every field below it empty; `analyze` fills them in and stamps this.
   * That split is what lets the album work over a full library before
   * spending a single token on it.
   */
  analyzedAt: string | null;
  contentType: ContentType | null;
  caption: string | null;
  tags: string[];
  extractedText: string | null;
  notable: boolean;
  quality: PhotoQuality | null;
  visibility: Visibility | null;
  /** Set for screenshots only; null for camera photos. */
  screenshot: ScreenshotPolicy | null;
  /** Identifiers found in `extractedText`; withholds the photo from summaries. Null until `redact` runs. */
  sensitive: SensitiveFlag | null;
  /** Set when a burst sibling inherited its description rather than being analyzed itself. */
  inheritedFrom: string | null;
}

/**
 * How much room a card takes.
 *
 * This is the only presentational choice the model makes, and it is really a
 * content judgement — *how much does this matter here* — with the renderer
 * deciding what each answer looks like. It replaces a separate row of hero
 * images: heroes and cards were two lists both answering "what is important
 * at this stop", so the same photo landed in both and rendered twice.
 */
export type HighlightSize = "full" | "half" | "normal";

/**
 * How many cards of each size a single stop may have.
 *
 * A budget, not a suggestion. Left to its own judgement the model produced four
 * cards for a 39-photo stop and dropped the other 35 into a collapsed grid,
 * which is the dump this design exists to avoid. The shape says: one thing
 * defined this place, a couple more nearly did, and a good number are worth
 * seeing at a glance — everything else collapses.
 */
export const CARD_BUDGET: Record<HighlightSize, number> = { full: 1, half: 2, normal: 30 };

/**
 * A key picture and what it is: an artwork, a building, a meal. Rendered as a
 * card — the picture, a title, a description — sized by how much it matters.
 *
 * A highlight owns its describing photos rather than sitting beside them. A
 * photographed museum label is not a highlight of a day; it is the caption for
 * the painting next to it, and shown separately it makes the page display the
 * same exhibit twice while calling the label the highlight. Same for a menu
 * against the meal it lists.
 */
export interface Highlight {
  size: HighlightSize;
  /** What it is: "Klimt's The Kiss", "a city Castle", "Halušky at the Slovak Pub". */
  title: string;
  description: string | null;
  /** The thing itself — usually one photo, sometimes a few angles of it. */
  photoIds: string[];
  /** Placards, menus and signs about it. Folded into the highlight, never listed alone. */
  documentPhotoIds: string[];
  /**
   * What the bound placards say, in English.
   *
   * The transcript is verbatim, so a Slovak museum label stays Slovak and a
   * German menu stays German — useful as evidence, unreadable as content to an
   * owner who reads neither. Null when the documents are already English, or
   * when there are none.
   */
  documentTranslation: string | null;
}

/**
 * One stop in a day: somewhere you were, or the travelling between.
 *
 * Stops are found deterministically from GPS and timestamps before any model
 * runs (pipeline/src/stops.ts); the model only names them, describes them, and
 * picks the highlights. A `transit` segment collapses to a single line — those
 * photos are part of the day but not a place in it.
 */
export interface DaySegment {
  id: string;
  kind: "place" | "transit";
  /** The venue or place — "Schönbrunn Palace", "the museum Museum". */
  title: string;
  summary: string | null;
  startTime: string;
  endTime: string;
  photoIds: string[];
  /** The key pictures worth describing, best first. Whatever is not here falls to the grid. */
  highlights: Highlight[];
}

export interface DayRecord {
  date: string;
  place: string | null;
  summary: string | null;
  photoIds: string[];
  /**
   * The day broken into stops. Empty for days written before v11, and for days
   * with nothing analyzed — the album still renders those as a plain grid.
   */
  segments: DaySegment[];
  /** The photos this summary was actually written from — see the note on staleness. */
  summarizedPhotoIds: string[];
}

/**
 * A nav section is either a real trip (a manually defined date range — see
 * pipeline/trips.json) or a month bucket, the fallback for everyday days.
 * Sections are produced by `organize` and are empty until it has run; the
 * album view works off `months` below regardless.
 */
export type SectionKind = "trip" | "month";

export interface TripRecord {
  id: string;
  kind: SectionKind;
  name: string;
  startDate: string;
  endDate: string;
  days: DayRecord[];
  /**
   * The trip's story, written from its day summaries. Null on month buckets
   * (a month is not a trip) and on any trip whose narrative has not been
   * generated — it costs a model call, so it is never produced as a side
   * effect of `organize`.
   */
  narrative: string | null;
  /**
   * Places actually visited, in order, as judged by the narrator. Airports and
   * stations passed through are deliberately excluded: the first and last days
   * of a trip are usually spent travelling, and their photos would otherwise
   * enter this list as destinations.
   */
  places: string[];
  narrativeGeneratedAt: string | null;
}

/** One month tab in the album, summarized. Cheap enough to hold every month. */
export interface MonthSummary {
  month: string;
  label: string;
  photoCount: number;
  /** How many of those `analyze` must actually pay for — duplicate copies inherit. */
  representativeCount: number;
  /** How many of those photos the AI pass has described. 0 until `analyze` runs. */
  analyzedCount: number;
  coverPhotoId: string | null;
}

/**
 * `photos/<month>.json` — the bulk of the archive, one file per month, so
 * neither the pipeline nor the app ever has to move the whole library to
 * touch one month of it.
 */
export interface PhotoShard {
  month: string;
  generatedAt: string;
  photos: Record<string, PhotoRecord>;
}

/**
 * `index.json` — everything needed to draw the nav and day headings, and
 * nothing else. Deliberately small (no PhotoRecords) so first paint is one
 * fast fetch no matter how large the library gets; photo records arrive
 * per-month, on demand, from PhotoShard files.
 */
export interface ArchiveIndexFile {
  schemaVersion: number;
  generatedAt: string;
  months: MonthSummary[];
  sections: TripRecord[];
}

/* --- Background jobs (pipeline serve) ---------------------------------- */

/**
 * Long passes the app can trigger and watch instead of the user running a
 * terminal command. `analyze` sends images to a model and can run for an hour;
 * `organize` is text-only and takes seconds to minutes.
 *
 * `trip` writes one trip's narrative from day summaries that already exist; it
 * is a single model call, so it finishes in seconds.
 */
export type JobKind = "scan" | "analyze" | "organize" | "trip" | "sync";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobProgress {
  /** Coarse stage, for a label: "planning", "analyzing", "geocoding", "saving"... */
  phase: string;
  done: number;
  /** 0 while the job is still working out how much there is to do. */
  total: number;
  message: string | null;
}

/**
 * A job's full state, and the payload of both `GET /jobs/:id` and every SSE
 * frame — so a client that reconnects after a reload sees exactly what a
 * client that stayed connected has.
 */
export interface JobRecord {
  id: string;
  kind: JobKind;
  status: JobStatus;
  startedAt: string;
  finishedAt: string | null;
  progress: JobProgress;
  /** Recent human-readable lines, oldest dropped past a cap. */
  log: string[];
  error: string | null;
  /** Counters the job chose to report, e.g. { analyzed, failed, geocoded }. */
  result: Record<string, number> | null;
}

/**
 * What an analyze run would cost, without spending anything. Shared because
 * both the CLI and the app show it before committing to a run — this is the
 * only step that costs money.
 */
export interface AnalyzePlan {
  total: number;
  months: { month: string; count: number }[];
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
}

export interface ArchiveStatus {
  signedIn: boolean;
  schemaVersion: number;
  months: { month: string; photoCount: number; representativeCount: number; analyzedCount: number }[];
  totals: { photos: number; analyzable: number; analyzed: number; days: number; sections: number };
}

/**
 * A thing kept on this device, in the sense OneDrive means it.
 *
 * Pinning a trip or a month fetches its thumbnails during sync and exempts them
 * from eviction. Everything unpinned stays on demand and is evictable, so the
 * pin is the user's answer to "what should still work when I am offline".
 */
export interface Pin {
  kind: "trip" | "month";
  /** A trip id, or a `yyyy-mm` month. */
  id: string;
  /** Originals as well as thumbnails. Off by default: they are megabytes each. */
  originals: boolean;
}

/**
 * The generation settings, as reported by the local server.
 *
 * **Never carries an API key back out** — `keys` says only whether each one is
 * set. Keys are write-only across this boundary.
 */
export interface ConfigStatus {
  /** Where `.env` lives, so the UI can name it. */
  path: string;
  exists: boolean;
  provider: string;
  /** Whether the *selected* provider has a key — what decides if generation works. */
  ready: boolean;
  keys: { anthropic: boolean; gemini: boolean };
  photosFolder: string;
  metadataFolder: string;
  geocodeContactEmail: string;
  anthropicModel: string;
  geminiModel: string;
  /**
   * Settings whose value comes from a real environment variable, which beats
   * `.env`. Saving one of these works now and is undone by the next restart.
   */
  shadowed: string[];
}

/** How the local replica stands against OneDrive. */
export type SyncState =
  | "in-sync"
  | "behind"
  /** Written locally but not yet uploaded — an upload that failed, normally. */
  | "ahead"
  /** Both changed since the last sync. Needs the user to choose; never resolved automatically. */
  | "conflict"
  | "never-synced"
  | "offline";

export interface SyncStatus {
  state: SyncState;
  /**
   * True when `state` is the last computed answer replayed from disk rather
   * than one just checked against OneDrive.
   *
   * The comparison costs a Graph round trip (measured 687-1,365ms), which is
   * too slow to open a page behind. Settings paints the stale answer at once
   * and replaces it when the real check lands, so this is what lets the UI say
   * "as of ten minutes ago" instead of asserting something it has not verified.
   */
  stale: boolean;
  /** When a scan last completed; null means never. */
  lastScanAt: string | null;
  /** When the eTag was last compared against OneDrive. */
  checkedAt: string | null;
  /** When metadata last actually moved in either direction. */
  syncedAt: string | null;
  localGeneratedAt: string | null;
  remoteLastModified: string | null;
  pins: Pin[];
  storage: {
    metadataBytes: number;
    thumbnails: { count: number; bytes: number };
    originals: { count: number; bytes: number };
  };
}
