export type ContentType = "scene" | "document" | "food" | "landscape" | "screenshot" | "other";

export interface GeoPoint {
  lat: number;
  lon: number;
}

/**
 * What a street-level map lookup found at a photo's coordinates. A hint for the
 * captioner, never a location of record — `PhotoRecord.place` stays the town,
 * which is what days and the trip map group by.
 */
export interface NearPlace {
  /** The nearest named venue — a museum, a station, a castle — or null when the nearest thing was only a street. */
  venue: string | null;
  /** The street and district, e.g. "Paulusbrug, Binnenstad". */
  street: string | null;
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
export const SCHEMA_VERSION = 14;

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

/** Graph's `video` facet on a driveItem, reduced to what the archive uses. */
export interface VideoMeta {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fourCC: string | null;
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

  /**
   * Present only on a video. `analyze` captions the **poster frame** Graph
   * generates for the item, which is what lets a video run through the same
   * pipeline as a photo — but the prompt should know it is looking at one
   * frame, not the recording. Absent on everything indexed before video
   * support, and ignored by older readers.
   */
  video?: VideoMeta | null;

  gps: GeoPoint | null;
  place: string | null;
  /**
   * The same place in the app's display languages, from the offline gazetteer
   * (see pipeline/src/geocodeOffline.ts). `place` stays the endonym — what the
   * place calls itself, which is what a caption should use — while a reader in
   * 简体中文 can be shown 城市 for a city. Absent for photos placed before this
   * existed.
   */
  placeNames?: { en: string; zh: string | null } | null;
  /**
   * Street-level context from the same coordinates, looked up before the photo
   * is captioned. Undefined until looked up; null when there was nothing to
   * find. No schema bump: older readers ignore it.
   */
  near?: NearPlace | null;
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
 * A day outside any trip is summarized only when it holds more than this many
 * photos. A handful of everyday shots reads fine as a plain grid, and a model
 * call per ordinary day across the whole library is most of the organize bill
 * for very little. Trip days are always summarized: the trip narrative is
 * written from them. The owner's rule, 2026-09-11.
 */
export const SUMMARY_MIN_PHOTOS = 15;

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

/**
 * A correction the owner made by hand, which a re-run must not throw away.
 *
 * Stop edits are anchored to a **photo**, not to the segment id: ids are
 * positional (`s1`, `s2`…), so adding one photo can re-cluster the day and turn
 * `s2` into a different place — a title frozen by id would then reappear on
 * something it was never written about. The anchor is the first photo of the
 * stop as it stood when the edit was made, and a re-run reapplies the edit to
 * whichever stop now contains that photo. If the photo is gone, so is the edit.
 */
export interface StopEdit {
  anchorPhotoId: string;
  title?: string;
  summary?: string | null;
}

export interface DayEdits {
  summary?: string;
  stops?: StopEdit[];
}

export interface DayRecord {
  date: string;
  place: string | null;
  summary: string | null;
  photoIds: string[];
  /**
   * What the owner told the summarizer about this day — "this is the
   * the railway museum", "the morning was a write-off".
   *
   * Stored on the day rather than passed per run, because it is a fact about
   * the day and not about one invocation: it has to reach *every* future
   * summary, or it would need retyping each time the day is rewritten.
   */
  note?: string | null;
  /**
   * The note the stored summary was actually written from.
   *
   * Compared against `note` to decide staleness, exactly as `summarizedPhotoIds`
   * is compared against the current photo set. Absent on days written before
   * v14, which is why the comparison treats absent and null as the same — a
   * schema bump must not silently mark 545 days as needing a paid re-run.
   */
  summarizedNote?: string | null;
  /** Hand-written text that overwrites whatever the model produces. */
  edits?: DayEdits | null;
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
  /**
   * Which language the archive's own text is written in, and which others sit
   * beside it (see `TranslationFile`). Optional, and absent means English with
   * nothing beside it — so adding it needed no schema bump, and an older build
   * that ignores it still reads the archive.
   */
  languages?: { source: string; available: string[] };
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
export type JobKind = "scan" | "analyze" | "organize" | "trip" | "sync" | "translate" | "collect" | "locate";

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
/** Where a submitted caption batch has got to, in Google's terms simplified. */
export type AnalyzeBatchState = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "expired";

/**
 * One batch of caption requests sent to the Gemini Batch API — half price,
 * results within a day. The server collects finished ones on its own.
 */
export interface AnalyzeBatchStatus {
  name: string;
  displayName: string;
  createdAt: string;
  photos: number;
  state: AnalyzeBatchState;
  /** When its captions were merged into the archive; null until then. */
  collectedAt: string | null;
  applied: number | null;
  failed: number | null;
  /** Tokens Google reported for it, once collected. */
  usage: { promptTokens: number; outputTokens: number; thoughtsTokens: number } | null;
  /** What those tokens cost at batch prices, in US dollars — null until collected, or for a model with no known price. */
  costUsd: number | null;
}

/**
 * The server carrying on a batch submit by itself, one batch at a time, because
 * Google's queue for this account holds only one. Null from the server when off.
 */
export interface AutoSubmitStatus {
  since: string;
  from: string | null;
  to: string | null;
  /** True while a batch is out; the next is submitted once it has been collected. */
  waitingForBatch: boolean;
}

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
 * `home.json` — where this library has been, small enough to draw a world map
 * from.
 *
 * The map needs one coordinate per place and a count; the shards that hold
 * coordinates are 38MB across 30 files, and `index.json` carries no GPS at all
 * by design. So this is aggregated once by the pipeline, like `search.json`,
 * and for the same reason: the reader may be a phone with no server.
 *
 * "On this day" is deliberately **not** here. Every date and summary it needs
 * is already in `index.json`, which the app has loaded before the home page
 * opens, so prebuilding it would be a second copy that could go stale.
 *
 * Derived data: never migrated, just rebuilt.
 */
export interface HomeIndexFile {
  schemaVersion: number;
  builtAt: string;
  places: HomePlace[];
  totals: {
    /** Photos with a usable position — not the library's size; see `placedOf`. */
    placed: number;
    photos: number;
    days: number;
    countries: number;
  };
  /**
   * Days out — went somewhere and came home the same night. Absent in a file
   * built before they existed, which an older reader simply does not draw.
   */
  excursions?: DayExcursion[];
}

/**
 * One day that left home and came back the same night.
 *
 * Not a trip: it has no nights away, needs no definition and no page of its
 * own. The album gives the day a card in its month, so a day out reads as an
 * outing rather than as another heading over a grid.
 */
export interface DayExcursion {
  date: string;
  /** Where it went: the endonym of the place with most of the day's photos away from home. */
  name: string;
  nameEn: string | null;
  nameZh: string | null;
  /** How far the day reached, in km from home. */
  awayKm: number;
  /** Photos taken away from home that day. */
  photoCount: number;
}

/** One place, as the map draws it: a dot, a label, and what it opens. */
export interface HomePlace {
  /** The endonym, as `PhotoRecord.place` holds it — "a city, Osterreich". */
  name: string;
  /** English and Chinese, when the gazetteer had them. */
  nameEn: string | null;
  nameZh: string | null;
  /** The last comma-separated part of the English name, for grouping and the totals. */
  country: string | null;
  /** Median of the photos here, which a single bad fix cannot move. */
  lat: number;
  lon: number;
  photoCount: number;
  /** The dates with photos here, ascending. Short — a place is visited on few days. */
  days: string[];
}

/**
 * The app's interface preferences, held by the local server.
 *
 * These lived only in the browser's `localStorage`, which on the desktop shell
 * turned out not to survive a hard kill: Chromium's LevelDB store for
 * `http://localhost:17923` never commits, so each launch starts a fresh
 * `000003.log` and the previous session's (20KB, measured 2026-09-11) is
 * orphaned unrecovered. The owner therefore signed in again and reset the
 * theme, the density and the sidebar width on every launch. The server already
 * persists config to disk and is running whenever the shell is, so it is the
 * durable place for this — and it makes the settings the same in every window
 * talking to the same server, rather than per browser profile.
 *
 * **Every field is nullable, and null means "never set here".** That is what
 * lets a first launch after this change adopt whatever the browser already
 * holds rather than overwrite a working setup with defaults — the app pushes
 * its local value up for any field the server has none for. The browser keeps
 * its copy either way, because `localStorage` is still the whole story with no
 * server: a phone reading OneDrive directly has nowhere else to put this.
 */
export interface AppPrefs {
  theme: "light" | "dark" | "system" | null;
  density: "compact" | "comfortable" | "spacious" | null;
  /** Pixels. The app clamps to its own min/max; the server only rejects nonsense. */
  sidebarWidth: number | null;
  /** One setting for the archive's text and the interface around it — see app/src/contentLang.ts. */
  contentLang: "en" | "zh-Hans" | null;
  /** Which nav groups are expanded. A short list of group ids. */
  navOpenGroups: string[] | null;
}

export type ProxyCategoryMode = "system" | "direct" | "custom";

export interface ProxySettings {
  systemEnabled: boolean;
  systemDetected: string | null;
  aiMode: ProxyCategoryMode;
  aiUrl: string | null;
  graphMode: ProxyCategoryMode;
  graphUrl: string | null;
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
  keys: { gemini: boolean };
  photosFolder: string;
  metadataFolder: string;
  geocodeContactEmail: string;
  geminiModel: string;
  /**
   * Settings whose value comes from a real environment variable, which beats
   * `.env`. Saving one of these works now and is undone by the next restart.
   */
  shadowed: string[];
  proxy: ProxySettings;
}

/**
 * What an `organize` run would do, without doing any of it.
 *
 * Exists because "0 day(s) summarized" is the same message whether nothing
 * changed, nothing was in scope, or nothing in range has been analyzed yet —
 * and on an archive where 4,386 of 31,374 photos have captions, the last is by
 * far the most common and the least guessable.
 */
/**
 * Everything the archive holds in words, in one file the app can search
 * without asking the server — so search works the same in the desktop app and
 * in the browser build reading OneDrive directly.
 *
 * Deliberately not an inverted index. The whole corpus is 3.5MB of captions,
 * tags and places across 24,296 photos, which a browser scans in milliseconds;
 * and a substring scan finds 京都 in Chinese text, where a word-boundary index
 * would need a tokenizer to split a language that has no spaces.
 *
 * Rows are tuples rather than objects because the field names would otherwise
 * be two thirds of the file.
 */
export interface SearchIndexFile {
  schemaVersion: number;
  builtAt: string;
  /** Every photo id starts with the drive's own id; stored once. */
  idPrefix: string;
  /** [id without the prefix, date or "", caption + tags + place, lowercased]. */
  photos: [string, string, string][];
  /** [date, day summary + stop titles and summaries + place, lowercased]. */
  days: [string, string][];
  /** [section id, name, first date, last date]. */
  trips: [string, string, string, string][];
}

export interface OrganizePlan {
  /** Days that would be summarized, i.e. what this run would cost. */
  rewrite: number;
  /** Days kept as they are — unchanged, or outside the scope. */
  reuse: number;
  skippedNoAnalyzed: number;
  skippedOutOfScope: number;
  skippedUndated: number;
  /**
   * Days outside a trip with too few photos to summarize (SUMMARY_MIN_PHOTOS).
   * Optional because an older server does not send it.
   */
  skippedSmall?: number;
  /** The dates that would be rewritten. Capped; `truncated` says if there are more. */
  days: { date: string; analyzed: number }[];
  truncated: boolean;
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
  /** The automatic checks, as stored — Settings shows and changes them. */
  settings: { autoSyncOnLaunch: boolean; intervalMinutes: number };
  storage: {
    metadataBytes: number;
    thumbnails: { count: number; bytes: number };
    originals: { count: number; bytes: number };
  };
}

/* --- Content in a second language --------------------------------------- */

/** Languages the archive's text can be shown in besides its own. */
export const CONTENT_LANGUAGES = ["zh-Hans"] as const;
export type ContentLanguage = (typeof CONTENT_LANGUAGES)[number];

/**
 * One text in another language. `mt` is a machine translation of the original
 * and may be replaced by a later run; `native` was written in this language by
 * the summarizer itself, and a translation never replaces it.
 */
export interface TranslationEntry {
  t: string;
  via: "mt" | "native";
}

/**
 * `i18n/<lang>/index.json` (day, stop, card and trip text) and
 * `i18n/<lang>/photos/<yyyy-mm>.json` (that month's captions).
 *
 * Beside the archive rather than inside it. The base files stay exactly as they
 * were, so no schema bump and no older build broken; write paths, which all
 * download the 3.5MB index, download nothing extra; and the app fetches only
 * the language it is showing.
 *
 * Keyed by `textKey(original)`, not by record. Stop ids are positional and move
 * when a day re-clusters — the problem `StopEdit` documents — while a hash
 * follows the text itself: when a summary is rewritten its key stops matching,
 * the page falls back to the original, and the next run translates the new
 * text. Identical texts, duplicate captions included, are translated once.
 */
export interface TranslationFile {
  lang: string;
  sourceLang: string;
  generatedAt: string;
  entries: Record<string, TranslationEntry>;
  /**
   * Index file only: the months that have a caption file. Sync and the app read
   * this instead of asking for every month, which would be a OneDrive round
   * trip per month for files that mostly do not exist.
   */
  parts?: string[];
  /**
   * Index file only: the owner's hand edits in this language, by date. Same
   * shape and the same photo anchoring as `DayRecord.edits`, and never touched
   * by a translation or a summarizer run.
   */
  owner?: Record<string, DayEdits>;
}

export type TranslateScope = "day" | "captions" | "all";

/** What a translate run would do, spending nothing — the `OrganizePlan` idea. */
export interface TranslatePlan {
  lang: string;
  scope: TranslateScope;
  /** Distinct texts in scope. */
  strings: number;
  /** Of those, how many have no entry yet — what a run would pay for. */
  missing: number;
  missingChars: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  /** `index` for day and trip text, otherwise a month of captions. */
  parts: { part: string; strings: number; missing: number; missingChars: number }[];
}

/**
 * A short, stable key for a text — cyrb53, a 53-bit hash, in base 36.
 *
 * Synchronous on purpose: the app looks one up for every string it renders, and
 * `crypto.subtle.digest` is async. At the ~10K distinct texts this archive has,
 * the chance of any collision is around one in a billion.
 */
export function textKey(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * Puts the owner's corrections back over the model's text.
 *
 * Called for every day, not only rewritten ones, so that an edit made against a
 * stored summary survives a run that reuses it. Here rather than in organize so
 * the app applies an edit made in another language with the same rule.
 *
 * Stop edits find their target by photo rather than by segment id — see
 * `StopEdit`. An edit whose anchor photo is no longer in the day is dropped
 * silently here and reported by the caller: the alternative is reapplying a
 * title to whichever stop inherited the id, which is how a correction ends up
 * on the wrong place.
 */
export function applyEdits(
  summary: string | null,
  segments: DaySegment[],
  edits: DayEdits | null | undefined,
): { summary: string | null; segments: DaySegment[]; orphaned: number } {
  if (!edits) return { summary, segments, orphaned: 0 };

  let orphaned = 0;
  const next = segments.map((seg) => ({ ...seg }));

  for (const edit of edits.stops ?? []) {
    const target = next.find((seg) => seg.photoIds.includes(edit.anchorPhotoId));
    if (!target) {
      orphaned++;
      continue;
    }
    if (edit.title !== undefined) target.title = edit.title;
    if (edit.summary !== undefined) target.summary = edit.summary;
  }

  return { summary: edits.summary ?? summary, segments: next, orphaned };
}
