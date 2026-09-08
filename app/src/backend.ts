import type { AnalyzePlan, ArchiveStatus, ConfigStatus, JobRecord, Pin, SyncStatus } from "@travel-archive/shared";

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

const BACKEND = import.meta.env.VITE_PIPELINE_URL || "http://127.0.0.1:4319";

/** Short: an absent backend is the normal case, and must not stall first paint. */
const HEALTH_TIMEOUT_MS = 1500;

export interface Health {
  ok: boolean;
  signedIn: boolean;
  running: JobRecord | null;
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
export function localThumbUrl(itemId: string, size: "medium" | "large" | "full"): string {
  return `${BACKEND}/thumb/${size}/${encodeURIComponent(itemId)}`;
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

export type ScanMode = "full" | "range" | "incremental";

export function startScan(body: { mode: ScanMode; from?: string; to?: string }): Promise<JobRecord> {
  return post<JobRecord>("/jobs/scan", body);
}

export function startAnalyze(body: { from?: string; to?: string; limit?: number }): Promise<JobRecord> {
  return post<JobRecord>("/jobs/analyze", body);
}

export function startOrganize(body: { only?: string; force?: boolean }): Promise<JobRecord> {
  return post<JobRecord>("/jobs/organize", body);
}

export interface TripRequest {
  startDate: string;
  endDate: string;
  name?: string;
  notes?: string;
  documents?: { name: string; text: string }[];
}

export function startTrip(body: TripRequest): Promise<JobRecord> {
  return post<JobRecord>("/jobs/trip", body);
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
