import type {
  AnalyzeBatchStatus,
  AnalyzePlan,
  AppPrefs,
  ArchiveStatus,
  ConfigStatus,
  JobRecord,
  OrganizePlan,
  Pin,
  PhotoRecord,
  SyncStatus,
} from "@travel-archive/shared";

/**
 * Client for `pipeline serve` — the local job server that runs analysis,
 * day summaries and trip narratives (pipeline/src/serve.ts).
 *
 * **Optional by design.** The archive itself is read straight from OneDrive, so
 * everything except *generating* works with no backend at all. When the server
 * is absent — which is always the case on the phone, since it binds 127.0.0.1
 * and holds OneDrive credentials — the app simply hides its generation controls
 * and stays a reader. That is the whole of the "mobile is view-only" design: no
 * separate build, no separate code path, just a failed health check.
 */

const BACKEND = import.meta.env.VITE_PIPELINE_URL || "http://127.0.0.1:18419";

/** Short: an absent backend is the normal case, and must not stall first paint. */
/**
 * How long `/health` may take before the app calls the server gone.
 *
 * 1.5s was too tight once jobs began writing shards: the server is one Node
 * process, and a month-end shard upload to OneDrive can occupy its event loop
 * for seconds — long enough for the poll to time out and show "the local server
 * stopped responding" while it was working perfectly. The banner is meant for a
 * server that is *gone*, so the question has to survive a busy one.
 */
const HEALTH_TIMEOUT_MS = 8000;

/** The latest thumbnail warm, as `/health` reports it. */
export interface ThumbWarming {
  size: string;
  total: number;
  done: number;
  failed: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface Health {
  ok: boolean;
  signedIn: boolean;
  running: JobRecord | null;
  /** Optional: a server built before the Activity page sends neither. */
  lastFinished?: Pick<JobRecord, "id" | "kind" | "status" | "finishedAt"> | null;
  warming?: ThumbWarming | null;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BACKEND}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((payload as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  return payload as T;
}

/**
 * Whether a backend is listening. Never throws: callers treat null as "no
 * backend", which is a supported state rather than an error.
 */
export async function checkHealth(): Promise<Health | null> {
  try {
    const res = await fetch(`${BACKEND}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return res.ok ? ((await res.json()) as Health) : null;
  } catch {
    return null;
  }
}

/**
 * A stable, cacheable address for one thumbnail.
 *
 * Stable is the whole point: Graph issues a different short-lived CDN link
 * every time, so the browser could never reuse one. This URL is keyed on the
 * item id, and the server marks it immutable — so a second view of a photo
 * costs neither a Graph call nor a request to the server.
 */
/**
 * Bumped when a cached response must be abandoned rather than reused.
 *
 * These URLs are served `immutable, max-age=31536000`, which is exactly what
 * makes them cheap — and also means a *bad* cached entry survives for a year
 * and cannot be fixed from the server. That happened: thumbnails fetched
 * before `Vary: Origin` was sent were cached with no record that CORS mattered,
 * so every later CORS request was answered from a copy carrying no
 * `Access-Control-Allow-Origin` and failed in ~4ms. Measured on this archive:
 * 63 of 200 images failed from cache while the same 200 succeeded with
 * `cache: "reload"`.
 *
 * Changing the URL changes the cache key, which retires every poisoned entry
 * at once instead of asking each person to clear their browser cache — and
 * clearing it *before* the server fix simply re-poisons on the next load, which
 * is the trap this avoids.
 */
const THUMB_CACHE_VERSION = 2;

export function localThumbUrl(itemId: string, size: "medium" | "large" | "full"): string {
  return `${BACKEND}/thumb/${size}/${encodeURIComponent(itemId)}?v=${THUMB_CACHE_VERSION}`;
}

/**
 * The server's video-stream route. It 302s to OneDrive's pre-authenticated URL
 * so the range requests, and the bytes, go straight to the CDN — this is what
 * keeps playback from downloading a whole original.
 */
export function localVideoUrl(itemId: string): string {
  return `${BACKEND}/video/${encodeURIComponent(itemId)}`;
}

/**
 * How the local replica stands against OneDrive, plus pins and disk use.
 *
 * `cached` skips the eTag comparison — a Graph round trip measured at
 * 687-1,365ms — and replays the last computed answer instead, marked `stale`.
 * Settings opens on that and then calls again without it.
 */
export async function syncStatus(opts: { cached?: boolean } = {}): Promise<SyncStatus | null> {
  try {
    const res = await fetch(`${BACKEND}/sync/status${opts.cached ? "?cached=1" : ""}`);
    return res.ok ? ((await res.json()) as SyncStatus) : null;
  } catch {
    return null;
  }
}

export type ConflictChoice = "upload-mine" | "replace-mine";

/** Starts a sync job. `resolve` is required only when the state is a conflict. */
export function startSync(body: { checkOnly?: boolean; resolve?: ConflictChoice } = {}): Promise<JobRecord> {
  return post<JobRecord>("/sync", body);
}

export function setPin(pin: Pin & { pinned?: boolean }): Promise<{ pins: Pin[] }> {
  return post<{ pins: Pin[] }>("/sync/pins", pin);
}

export function clearCache(category: "thumbnails" | "originals"): Promise<{ removed: number }> {
  return post<{ removed: number }>("/sync/clear", { category });
}

export function saveSyncSettings(body: {
  autoSyncOnLaunch?: boolean;
  intervalMinutes?: number;
}): Promise<unknown> {
  return post("/sync/settings", body);
}

/**
 * Archive metadata from the local server's mirror, or null when there is none.
 *
 * Short timeout and silent failure: an absent backend is the normal case on a
 * phone, and this sits in front of the very first thing the app does.
 */
export async function localArchiveJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BACKEND}/archive/${path}`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      // The mirror is rewritten by every job, and the server sends `no-cache`
      // with no validator — which the browser was answering from its own disk
      // cache anyway. Search kept reporting one match for 城市 against an index
      // that held 3,112, and the same staleness would hit any shard read after
      // a job. Nothing here is worth caching: it is a read from localhost.
      cache: "no-store",
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/**
 * Ask the server to fill its cache for these photos, ahead of the browser
 * needing them.
 *
 * Fire and forget: the response says only what will be fetched, and the point
 * is that by the time an image scrolls into view the bytes are already on disk.
 */
export async function warmThumbnails(ids: string[], size: "medium" | "large"): Promise<void> {
  try {
    await post("/thumb/warm", { ids, size });
  } catch {
    // Warming is an optimisation; a failure just means the normal path is slower.
  }
}

/** Byte sizes of thumbnails already on the server's disk. Absent ids are omitted. */
export async function localThumbSizes(
  ids: string[],
  size: "medium" | "large",
): Promise<Map<string, number>> {
  try {
    const { sizes } = await post<{ sizes: Record<string, number> }>("/thumb/sizes", { ids, size });
    return new Map(Object.entries(sizes));
  } catch {
    return new Map();
  }
}

export async function archiveStatus(): Promise<ArchiveStatus | null> {
  try {
    const res = await fetch(`${BACKEND}/archive/status`);
    return res.ok ? ((await res.json()) as ArchiveStatus) : null;
  } catch {
    return null;
  }
}

/** What an analyze run would cost. Spends nothing — shown before the user commits. */
export function planAnalyze(body: { from?: string; to?: string; limit?: number }): Promise<AnalyzePlan> {
  return post<AnalyzePlan>("/jobs/analyze/plan", body);
}

/**
 * Indexing. Free — Graph listing calls only, no downloads and no model calls —
 * which is why it has no plan/estimate step of its own.
 *
 * `mode` decides the range and the server resolves it; `from`/`to` (months,
 * `yyyy-mm`) are read only when the mode is "range".
 */
/**
 * The generation settings. Returns null with no backend, like the other reads —
 * a phone has nothing to configure, since generation needs the server anyway.
 */
export async function getConfig(): Promise<ConfigStatus | null> {
  try {
    const res = await fetch(`${BACKEND}/config`);
    return res.ok ? ((await res.json()) as ConfigStatus) : null;
  } catch {
    return null;
  }
}

/**
 * Writes generation settings and applies them to the running server.
 *
 * Keys travel in one direction only: they are sent here and never read back,
 * so the form shows "saved" rather than a value it could not have fetched.
 */
export function saveConfig(patch: Record<string, string>): Promise<ConfigStatus> {
  return post<ConfigStatus>("/config", patch);
}

/**
 * The interface preferences the server holds — theme, density, sidebar width,
 * content language, open nav groups. Null with no backend, which is the phone
 * and any plain browser: there `localStorage` is the whole story.
 */
export async function getPrefs(): Promise<AppPrefs | null> {
  try {
    const res = await fetch(`${BACKEND}/prefs`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS), cache: "no-store" });
    return res.ok ? ((await res.json()) as AppPrefs) : null;
  } catch {
    return null;
  }
}

/**
 * Saves the settings that changed. Fire and forget, and deliberately not
 * `post()`: `keepalive` is what makes the write survive the page going away,
 * and changing the content language reloads the page the instant after this is
 * called (see contentLang.ts). Without it that one save would be cancelled
 * mid-flight and the language would be the one setting that never persisted.
 */
export function savePrefs(patch: Partial<AppPrefs>): void {
  void fetch(`${BACKEND}/prefs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
    keepalive: true,
  }).catch(() => {
    // No backend, which is a supported state: the browser's own copy already
    // holds this, and that is all a phone ever had.
  });
}

export type ScanMode = "full" | "range" | "incremental";

export function startScan(body: { mode: ScanMode; from?: string; to?: string }): Promise<JobRecord> {
  return post<JobRecord>("/jobs/scan", body);
}

/** `batch`: half price through the Batch API; the server collects the results within a day. */
export function startAnalyze(body: { from?: string; to?: string; limit?: number; batch?: boolean }): Promise<JobRecord> {
  return post<JobRecord>("/jobs/analyze", body);
}

/** Submitted caption batches, newest last. Null with no backend. */
export async function listBatches(): Promise<AnalyzeBatchStatus[] | null> {
  try {
    const res = await fetch(`${BACKEND}/jobs/analyze/batches`);
    return res.ok ? ((await res.json()) as AnalyzeBatchStatus[]) : null;
  } catch {
    return null;
  }
}

/** Merges finished batches now instead of at the server's next ten-minute check. */
export function startCollect(): Promise<JobRecord> {
  return post<JobRecord>("/jobs/analyze/collect", {});
}

/** Whether the server is submitting caption batches by itself, one at a time. Null when off, or with no backend. */
export async function autoSubmitStatus(): Promise<import("@travel-archive/shared").AutoSubmitStatus | null> {
  try {
    const res = await fetch(`${BACKEND}/jobs/analyze/auto`);
    return res.ok ? ((await res.json()) as import("@travel-archive/shared").AutoSubmitStatus | null) : null;
  } catch {
    return null;
  }
}

/** Turns the automatic submit off; batches already at Google are still collected. */
export function stopAutoSubmit(): Promise<{ ok: boolean }> {
  return post<{ ok: boolean }>("/jobs/analyze/auto/stop", {});
}

/** Jobs newest first, including those from before the server last restarted. Null with no backend. */
export async function jobHistory(): Promise<JobRecord[] | null> {
  try {
    const res = await fetch(`${BACKEND}/jobs/history`);
    return res.ok ? ((await res.json()) as JobRecord[]) : null;
  } catch {
    return null;
  }
}

/**
 * What an organize run would rewrite, spending nothing.
 *
 * The counterpart to `planAnalyze`. Day summaries cost money per rewritten day,
 * and "0 day(s) summarized" cannot distinguish "nothing changed" from "nothing
 * here is analyzed yet" — this can.
 */
export function planOrganize(body: { only?: string; force?: boolean } = {}): Promise<OrganizePlan> {
  return post<OrganizePlan>("/jobs/organize/plan", body);
}

export function startOrganize(body: { only?: string; force?: boolean; days?: string[] }): Promise<JobRecord> {
  return post<JobRecord>("/jobs/organize", body);
}

type TranslateBody = { lang: string; scope: import("@travel-archive/shared").TranslateScope };

/** What a translate run would do. Spends nothing. */
export function planTranslate(body: TranslateBody): Promise<import("@travel-archive/shared").TranslatePlan> {
  return post("/jobs/translate/plan", body);
}

/** Existing text into the second language — text-only model calls. */
export function startTranslate(body: TranslateBody): Promise<JobRecord> {
  return post<JobRecord>("/jobs/translate", body);
}

/**
 * A correction, or a note for the summarizer. Spends nothing and answers
 * synchronously — unlike the jobs above, this is one field and one write.
 *
 * `undefined` leaves a field alone; an explicit `null` clears it. Send only
 * what changed, or saving a title erases the note.
 */
export interface DayPatch {
  note?: string | null;
  summary?: string | null;
  stops?: { anchorPhotoId: string; title?: string | null; summary?: string | null }[];
  /** The language the summary and stop edits are in; absent for the original. See the server's DayPatch. */
  lang?: string;
}

export interface DayEditResult {
  date: string;
  note: string | null;
  /** True when the next day-summaries run will rewrite this day. */
  stale: boolean;
}

export function editDay(date: string, patch: DayPatch): Promise<DayEditResult> {
  return post<DayEditResult>(`/days/${date}`, patch);
}

/**
 * Correcting when a photo was taken.
 *
 * A rename of the file in OneDrive, not a stored override — for a WhatsApp save
 * the filename *is* the timestamp, so this is the only correction that stays
 * true across a rescan. Refuses, rather than guessing, on a photo whose date
 * comes from EXIF.
 */
export interface SetTakenAtResult {
  id: string;
  fileName: string;
  takenAt: string;
  dateSource: PhotoRecord["dateSource"];
  timeSuspect: boolean;
  months: string[];
}

export function setPhotoTakenAt(
  id: string,
  body: { month: string; date: string; time: string | null },
): Promise<SetTakenAtResult> {
  return post<SetTakenAtResult>(`/photos/${encodeURIComponent(id)}/taken`, body);
}

export interface SetTakenAtBatchResult {
  results: SetTakenAtResult[];
  /** Photos left unchanged, and why. The others went through regardless. */
  errors: { id: string; error: string }[];
  months: string[];
}

/** Many photos in one request — one read and one write of each file on the server. */
export function setPhotosTakenAt(
  items: { id: string; month: string; date: string; time: string | null }[],
): Promise<SetTakenAtBatchResult> {
  return post<SetTakenAtBatchResult>("/photos/taken", { items });
}

export interface TripRequest {
  startDate: string;
  endDate: string;
  name?: string;
  notes?: string;
  documents?: { name: string; text: string }[];
  /** The server refuses when most days have no summary, unless this is set. */
  allowMissingSummaries?: boolean;
}

export function startTrip(body: TripRequest): Promise<JobRecord> {
  return post<JobRecord>("/jobs/trip", body);
}

/** Renames a trip; its id, and so its links and pins, stay. */
export function renameTrip(id: string, name: string): Promise<{ ok: boolean }> {
  return post<{ ok: boolean }>(`/trips/${encodeURIComponent(id)}/rename`, { name });
}

/** A trip proposed from where the nights were spent — see pipeline jobs/tripSuggest.ts. */
export interface TripSuggestion {
  startDate: string;
  endDate: string;
  nights: number;
  photoCount: number;
  farthestKm: number;
  places: { en: string; zh: string | null; photos: number }[];
  countries: { en: string; zh: string | null }[];
  name: { en: string; zh: string };
  home: { en: string | null; zh: string | null };
  unconfirmedNights: number;
}

/** Null when the server is too old to suggest, or unreachable. */
export async function tripSuggestions(): Promise<TripSuggestion[] | null> {
  try {
    const res = await fetch(`${BACKEND}/trips/suggestions`);
    return res.ok ? ((await res.json()) as TripSuggestion[]) : null;
  } catch {
    return null;
  }
}

export function dismissTripSuggestion(startDate: string, endDate: string): Promise<{ ok: boolean }> {
  return post<{ ok: boolean }>("/trips/suggestions/dismiss", { startDate, endDate });
}

/** Makes a range a trip without writing its story: free, and instant. */
export function defineTrip(startDate: string, endDate: string, name: string): Promise<{ id: string; name: string }> {
  return post<{ id: string; name: string }>("/trips/define", { startDate, endDate, name });
}

/** Deletes a trip's range and narrative; its days return to their months, no photo is touched. */
export function deleteTrip(id: string): Promise<{ ok: boolean }> {
  return post<{ ok: boolean }>(`/trips/${encodeURIComponent(id)}/delete`, {});
}

export function cancelJob(id: string): Promise<JobRecord> {
  return post<JobRecord>(`/jobs/${id}/cancel`, {});
}

export async function getJob(id: string): Promise<JobRecord | null> {
  try {
    const res = await fetch(`${BACKEND}/jobs/${id}`);
    return res.ok ? ((await res.json()) as JobRecord) : null;
  } catch {
    return null;
  }
}

/**
 * Subscribes to a job's progress. Returns a function that stops listening.
 *
 * The server sends the job's current state as the first frame and closes the
 * stream once the job reaches a terminal status, so this works identically for
 * a job just started and one already half-finished — which is what makes a
 * page reload mid-run reattach rather than lose the job.
 *
 * EventSource reconnects on its own if the connection drops. It also reconnects
 * when the server closes the stream deliberately, so the terminal frame has to
 * close it from this side too.
 */
export function watchJob(id: string, onUpdate: (job: JobRecord) => void): () => void {
  const source = new EventSource(`${BACKEND}/jobs/${id}/events`);

  source.addEventListener("message", (event) => {
    let job: JobRecord;
    try {
      job = JSON.parse((event as MessageEvent<string>).data) as JobRecord;
    } catch {
      return;
    }
    onUpdate(job);
    if (job.status !== "running" && job.status !== "queued") source.close();
  });

  // An error after the job finished is just the close being noticed; while it
  // is running, EventSource retries by itself, so there is nothing to do here
  // beyond not treating it as fatal.
  source.addEventListener("error", () => {
    if (source.readyState === EventSource.CLOSED) return;
  });

  return () => source.close();
}

/** The last job this tab started, so a reload can reattach to it. */
const LAST_JOB_KEY = "pipeline-last-job";

export function rememberJob(id: string): void {
  try {
    sessionStorage.setItem(LAST_JOB_KEY, id);
  } catch {
    // Storage blocked; the job still runs, it just will not be reattached.
  }
}

export function forgetJob(): void {
  try {
    sessionStorage.removeItem(LAST_JOB_KEY);
  } catch {
    // As above.
  }
}

export function rememberedJob(): string | null {
  try {
    return sessionStorage.getItem(LAST_JOB_KEY);
  } catch {
    return null;
  }
}
