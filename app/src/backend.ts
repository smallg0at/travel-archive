import type {
  AnalyzeBatchStatus,
  AnalyzePlan,
  AppPrefs,
  ArchiveStatus,
  AutostartStatus,
  ConfigStatus,
  JobRecord,
  OrganizePlan,
  Pin,
  PhotoRecord,
  RemoteAccessStatus,
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

/**
 * Where the job server is.
 *
 * Defaults to loopback — but **the same host the page was served from**, not a
 * literal `127.0.0.1`. That distinction is the whole of remote reading: a family
 * member opens `http://192.168.x.y:17923`, and `127.0.0.1` would then point at
 * *their* machine, where no server exists. The shell serves the page and the job
 * server sits on the same box, so the hostname is the answer in both cases.
 *
 * `VITE_PIPELINE_URL` still wins, for a setup where the two are separated.
 */
const BACKEND =
  import.meta.env.VITE_PIPELINE_URL ||
  `${location.protocol === "https:" ? "https:" : "http:"}//${location.hostname || "127.0.0.1"}:18419`;

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
  /**
   * What the server can render locally — sharp, heic-decode, ffmpeg — for the
   * thumbnails OneDrive refuses to produce. Absent on a server built before
   * this existed, so it stays optional like `lastFinished`.
   */
  render?: RenderCapability;
}

/** The same shape `/health` reports; declared here rather than imported from
 * the pipeline, which the browser bundle must not depend on. */
export interface RenderCapability {
  images: boolean;
  heif: boolean;
  ffmpeg: string | null;
}

/**
 * Every request to the job server, with the session cookie attached.
 *
 * `credentials: "include"` is what lets a remote reader's sign-in cookie travel:
 * the page is served from the shell's origin and the data comes from the job
 * server's, so a default `same-origin` fetch would drop it and every thumbnail
 * would 401. On loopback it changes nothing — there is no cookie and the request
 * is local anyway.
 *
 * One wrapper rather than `credentials` at each of a dozen call sites, so a new
 * endpoint cannot quietly forget it.
 */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BACKEND}${path}`, { ...init, credentials: "include" });
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((payload as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  return payload as T;
}

/**
 * Whether this browser is on the machine the archive lives on.
 *
 * The job server refuses `/video/...` to anyone else (see serve.ts), and the app
 * should not offer what it cannot play: a video tile that opens a black player
 * reads as broken, while a grid without them reads as a photo archive. The
 * hostname is the test — served from `localhost`/`127.0.0.1` this is the owner's
 * own window; served from a LAN address it is somebody else's.
 */
export const isLocalMachine = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(location.hostname || "localhost");

/** Whether the server wants a password, and whether this browser has given it. */
export interface AccessStatus {
  gated: boolean;
  signedIn: boolean;
  /** Whether the *server* allows this client to write — `canWrite(req)`, not a guess from the hostname. */
  canWrite: boolean;
}

let access: AccessStatus | null = null;

export async function accessStatus(): Promise<AccessStatus | null> {
  try {
    const res = await apiFetch("/access", { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const status = (await res.json()) as AccessStatus;
    access = status;
    return status;
  } catch {
    return null;
  }
}

/**
 * Whether this browser may write — asked once, at startup, from `/access`.
 *
 * Everything the app lets a reader do to the archive (the day, trip and place
 * editors, the photo-time control, Generate, cancelling a job) is keyed on this
 * so that a remote reader is never offered a control that answers 403. The
 * server still refuses regardless — this only decides what is drawn.
 *
 * Before `/access` has answered, it falls back to the hostname: `isLocalMachine`
 * is the same answer for a server that has not started, and it keeps the
 * owner's own window from painting its own tools hidden for a few milliseconds.
 */
export function canWrite(): boolean {
  if (access) return access.canWrite;
  return isLocalMachine;
}

/** Offers the shared password. Throws with the server's wording when it is wrong. */
export async function signInShared(password: string): Promise<void> {
  await post<{ ok: boolean }>("/access", { password });
}

/**
 * Whether a backend is listening. Never throws: callers treat null as "no
 * backend", which is a supported state rather than an error.
 */
export async function checkHealth(): Promise<Health | null> {
  const result = await healthResult();
  return result.ok ? result.health : null;
}

/** Why a health probe failed. Three cases, three different remedies. */
export type HealthFailure =
  /** 401/403: the shared-password session lapsed — the fix is typing it again. */
  | "auth"
  /** Timed out: listening, but did not answer in HEALTH_TIMEOUT_MS — gone, or busy. */
  | "no-answer"
  /** Anything else — connection refused, DNS, an aborted request. */
  | "error";

export type HealthResult = { ok: true; health: Health } | { ok: false; failure: HealthFailure };

/**
 * `/health`, saying *why* it failed when it did.
 *
 * `checkHealth` collapses all three to `null`, which is why the banner called
 * every one of them "stopped responding": a server that is gone, one whose
 * job has held the loop longer than `HEALTH_TIMEOUT_MS`, and one whose session
 * has merely expired all looked identical — and only the third is fixed by
 * typing the password rather than waiting. `serverStatus.ts` needs the
 * difference; everything else can keep using `checkHealth`.
 */
export async function healthResult(): Promise<HealthResult> {
  try {
    const res = await apiFetch(`/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (res.ok) return { ok: true, health: (await res.json()) as Health };
    return { ok: false, failure: res.status === 401 || res.status === 403 ? "auth" : "error" };
  } catch (err) {
    // `AbortSignal.timeout` rejects with `TimeoutError`; a refused socket comes
    // through as a TypeError. Only the first means "was listening, didn't
    // answer", which is the case a busy job and a lost packet share.
    const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { ok: false, failure: timeout ? "no-answer" : "error" };
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
    const res = await apiFetch(`/sync/status${opts.cached ? "?cached=1" : ""}`);
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
    const res = await apiFetch(`/archive/${path}`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      // The mirror is rewritten by every job, and the server sends `no-cache`
      // with no validator — which the browser was answering from its own disk
      // cache anyway. Search kept reporting one match for a place against an
      // index that held 3,112, and the same staleness would hit any shard read
      // after a job. Nothing here is worth caching: it is a read from localhost.
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
    const res = await apiFetch(`/archive/status`);
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
    const res = await apiFetch(`/config`);
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
 * Asks the server for one toast on its own machine.
 *
 * It rejects with the server's reason (no PowerShell, Windows refused, a
 * non-Windows host) rather than returning a flag, because the button exists to
 * *confirm* the machine will show one — "failed: <why>" is the only answer a
 * reader can act on, and a silent success would be the lie the button is meant
 * to prevent.
 */
export function testNotification(): Promise<{ ok: boolean }> {
  return post<{ ok: boolean }>("/notify/test", {});
}

/**
 * Whether the job server starts itself at sign-in (pipeline/src/autostart.ts).
 *
 * Null when there is no server to ask — the phone, or a browser — which is the
 * same case that hides this row from Settings entirely.
 */
export async function autostartStatus(): Promise<AutostartStatus | null> {
  try {
    const res = await apiFetch("/settings/autostart", { cache: "no-store" });
    return res.ok ? ((await res.json()) as AutostartStatus) : null;
  } catch {
    return null;
  }
}

/** What setup still needs, and the device code while one is pending. */
export interface OobeState {
  signedIn: boolean;
  deviceCode: { url: string; code: string; expiresAt: string } | null;
  photosFolderValidatedAt: string | null;
  /** True until a scan has saved an index — a fresh archive. */
  neverScanned: boolean;
  /** The configured value, whatever its source. */
  photosFolder: string;
}

/**
 * `GET /oobe` — the server's own answer to "what does setup still need".
 *
 * Null when there is no server, and also when the server refuses: the route
 * is loopback-only (a device code would let a remote reader link *their*
 * account to this archive), so a remote reader's 403 lands here as the same
 * harmless nothing as an absent server.
 */
export async function oobeState(): Promise<OobeState | null> {
  try {
    const res = await apiFetch("/oobe", { cache: "no-store" });
    return res.ok ? ((await res.json()) as OobeState) : null;
  } catch {
    return null;
  }
}

/** Starts the server's device-code sign-in. The code arrives via `oobeState`. */
export function oobeSignIn(): Promise<{ pending?: boolean; signedIn?: boolean }> {
  return post("/oobe/signin", {});
}

export interface FolderProbe {
  state: "ok" | "not-found" | "no-token";
  path: string;
  count?: number;
  months?: number;
}

/**
 * Probes a photo folder; `confirm` also records the configured one as agreed.
 *
 * `path` asks about a **candidate** — read-only, the page validates before it
 * writes anything, so a folder that 404s never reaches `POST /config`.
 *
 * A missing folder is an **answer** (`state: "not-found"`), not a failure —
 * null here means the request itself could not be made.
 */
export async function oobeFolder(confirm = false, path?: string): Promise<FolderProbe | null> {
  try {
    const res = await apiFetch("/oobe/folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(path === undefined ? { confirm } : { confirm, path }),
    });
    return res.ok ? ((await res.json()) as FolderProbe) : null;
  } catch (err) {
    // Never a bare swallow: this is the only surface where "the probe did not
    // even reach the server" shows up (it renders as "not confirmed yet").
    console.error("[setup] folder probe request failed:", err);
    return null;
  }
}

export type ProviderValidation =
  | { ok: true }
  | { ok: false; kind: "auth" | "unreachable"; detail: string };

/**
 * One cheap server-side check of a provider (and its key) before anything is
 * saved: `auth` = the provider rejected the key, `unreachable` = no answer.
 * The key itself never comes back — the response is only what happened.
 */
export async function validateGeneration(provider: string, key?: string): Promise<ProviderValidation> {
  try {
    const res = await apiFetch("/config/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, key }),
    });
    return res.ok
      ? ((await res.json()) as ProviderValidation)
      : { ok: false, kind: "unreachable", detail: `HTTP ${res.status}` };
  } catch (err) {
    console.error("[setup] validate request failed:", err);
    return { ok: false, kind: "unreachable", detail: (err as Error).message };
  }
}

/** One level of sub-folders for the setup picker. */
export async function oobeFolders(
  path: string,
): Promise<{ state?: string; path: string; folders: string[]; truncated?: boolean } | null> {
  try {
    const res = await apiFetch(`/oobe/folders?path=${encodeURIComponent(path)}`, { cache: "no-store" });
    return res.ok ? ((await res.json()) as { path: string; folders: string[]; truncated?: boolean }) : null;
  } catch {
    return null;
  }
}

/**
 * Turns sign-in start-up on or off.
 *
 * The server's own wording comes through in the rejection, because the one
 * failure that matters here is specific: "this server was not started from a
 * file on disk, so there is nothing to register" is not a message this side
 * could improve on.
 */
export function setAutostart(enabled: boolean): Promise<AutostartStatus> {
  return post<AutostartStatus>("/settings/autostart", { enabled });
}

/**
 * Who may reach the job server — as it runs and as it is saved
 * (pipeline/src/remoteAccess.ts). Null where there is no server to ask, which
 * is the same case that hides this section from Settings entirely.
 *
 * The password is never in here: the status says set-or-not, like every other
 * secret across this boundary.
 */
export async function remoteAccessStatus(): Promise<RemoteAccessStatus | null> {
  try {
    const res = await apiFetch("/settings/remote", { cache: "no-store" });
    return res.ok ? ((await res.json()) as RemoteAccessStatus) : null;
  } catch {
    return null;
  }
}

/**
 * Saves who may reach the server. **Nothing changes until it restarts** — the
 * returned `restartNeeded` says so, which is the form's job rather than the
 * reader's to work out when their new password is refused.
 */
export function setRemoteAccess(patch: { exposed?: boolean; password?: string | null }): Promise<RemoteAccessStatus> {
  return post<RemoteAccessStatus>("/settings/remote", patch);
}

/**
 * Asks the server to replace itself.
 *
 * The answer arrives *before* the handover begins, so `ok: true` means
 * accepted rather than done: the server is unreachable for a couple of seconds
 * afterwards, which is what the caller waits through.
 */
export function restartServer(): Promise<{ ok: boolean; restarting: boolean }> {
  return post<{ ok: boolean; restarting: boolean }>("/server/restart", {});
}

/**
 * The interface preferences the server holds — theme, density, sidebar width,
 * content language, open nav groups. Null with no backend, which is the phone
 * and any plain browser: there `localStorage` is the whole story.
 */
export async function getPrefs(): Promise<AppPrefs | null> {
  try {
    const res = await apiFetch(`/prefs`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS), cache: "no-store" });
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
  void apiFetch(`/prefs`, {
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
    const res = await apiFetch(`/jobs/analyze/batches`);
    return res.ok ? ((await res.json()) as AnalyzeBatchStatus[]) : null;
  } catch {
    return null;
  }
}

/**
 * How far the local screenshot pass has got, and whether it is ready to run.
 *
 * Deliberately no "waiting" count: that would mean walking 124 shards on a status
 * request, which is the job's own planning work. The job reports it when it
 * starts, and that is when the number is worth anything.
 */
export interface ScreensStatus {
  /** How many screens have a description in the encrypted file. */
  described: number;
  /** The service set for the pass, or null. */
  provider: string | null;
  /** Whether a passphrase is set — never the passphrase itself. */
  hasPassphrase: boolean;
  /** Set when the file could not be read: a changed passphrase, or damage. */
  error?: string;
  running: boolean;
}

export async function screensStatus(): Promise<ScreensStatus | null> {
  try {
    const res = await apiFetch("/screens/status", { cache: "no-store" });
    return res.ok ? ((await res.json()) as ScreensStatus) : null;
  } catch {
    return null;
  }
}

/** Describes the screenshots the allowlist keeps off the wire, on a service in this machine. */
export function startScreens(body: { limit?: number } = {}): Promise<JobRecord> {
  return post<JobRecord>("/jobs/screens", body);
}

/** Merges finished batches now instead of at the server's next ten-minute check. */
export function startCollect(): Promise<JobRecord> {
  return post<JobRecord>("/jobs/analyze/collect", {});
}

/** Whether the server is submitting caption batches by itself, one at a time. Null when off, or with no backend. */
export async function autoSubmitStatus(): Promise<import("@travel-archive/shared").AutoSubmitStatus | null> {
  try {
    const res = await apiFetch(`/jobs/analyze/auto`);
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
    const res = await apiFetch(`/jobs/history`);
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
    const res = await apiFetch(`/trips/suggestions`);
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

/**
 * The owner's own corrections to a trip's narrative or name.
 *
 * `lang` selects which language's copy is being edited — the current one, so a
 * correction made while reading Chinese lands in Chinese and leaves the English
 * alone. Omit it to edit the original.
 */
export function editTrip(
  id: string,
  patch: { narrative?: string | null; name?: string | null; lang?: string | null },
): Promise<{ ok: boolean }> {
  return post<{ ok: boolean }>(`/trips/${encodeURIComponent(id)}/edit`, patch);
}

/** The narrative model run itself, for a trip whose story should be written again. */

export function cancelJob(id: string): Promise<JobRecord> {
  return post<JobRecord>(`/jobs/${id}/cancel`, {});
}

export async function getJob(id: string): Promise<JobRecord | null> {
  try {
    const res = await apiFetch(`/jobs/${id}`);
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
  // `withCredentials` matters for a reader that is not this machine. The stream
  // sits behind the same gate as every other read (serve.ts), this page and the
  // API are different origins even on one machine, and a cross-origin
  // EventSource sends no cookies unless asked — so without this the stream
  // answers 401, and the panel paints its first frame and then never moves.
  // `apiFetch` asks for the same thing (see its note); this one did not.
  const source = new EventSource(`${BACKEND}/jobs/${id}/events`, { withCredentials: true });

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
