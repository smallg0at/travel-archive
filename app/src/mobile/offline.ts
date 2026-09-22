import { App } from "@capacitor/app";
import { ui } from "../i18n";
import { archive, showToast } from "./ui";
import { cacheAllMonths, keptStats, syncKeptShards, type CacheProgress } from "./cache";
import { currentHashOrNull, rerender } from "./router";
import { isNative } from "./native";

/**
 * Keeping the archive on the phone, and keeping it current.
 *
 * Two jobs, both in the background so neither delays a screen:
 *
 *  - `startAutoCache` downloads every month's records once, so the whole
 *    library opens from local storage and works with no signal. It is opt-out
 *    (`auto-cache`), sequential, and resumes from wherever it stopped.
 *  - `syncAndRefresh` asks OneDrive once, in a listing, which months' shards
 *    have moved since this phone kept them, pulls only those, and redraws the
 *    month on screen if it was one of them.
 *
 * The launch that runs before this paints from the kept copy (cache.ts), so a
 * slow link costs freshness, never the first screen.
 */

const AUTO_KEY = "offline-auto-cache";

export function autoCacheEnabled(): boolean {
  try {
    // Absent means on: the point of the feature is that the reader should not
    // have had to know about it.
    return localStorage.getItem(AUTO_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setAutoCacheEnabled(on: boolean): void {
  try {
    localStorage.setItem(AUTO_KEY, on ? "1" : "0");
  } catch {
    // Storage blocked: the choice holds for this session only. Nothing else to
    // do — the server copy of prefs is not the place for an offline cache flag.
  }
}

let running: Promise<CacheProgress> | null = null;

export function isCaching(): boolean {
  return running !== null;
}

/**
 * Downloads every month named, showing progress in a toast. Concurrent calls
 * share the one run rather than racing each other over the same files.
 */
export function cacheAllNow(months: string[]): Promise<CacheProgress> {
  if (running) return running;
  const toast = showToast(ui.mobile.caching(0, months.length));
  const job = cacheAllMonths(months, {
    onProgress: (progress) => toast.set(ui.mobile.caching(progress.done, progress.total)),
  })
    .then((progress) => {
      const held = progress.kept + progress.skipped;
      toast.set(progress.failed ? ui.mobile.cachedStopped : ui.mobile.cachedDone(held));
      // The closing line lingers; a failure keeps its message only briefly too
      // — the reader can re-run it and the pass resumes.
      setTimeout(() => toast.close(), 3500);
      return progress;
    })
    .catch((): CacheProgress => {
      toast.close();
      return { done: 0, total: months.length, kept: 0, failed: months.length, skipped: 0 };
    })
    .finally(() => {
      running = null;
    });
  running = job;
  return job;
}

/** The background pass at launch, when the reader has left it on and is online. */
export function startAutoCache(months: string[]): void {
  if (running || !autoCacheEnabled() || !navigator.onLine) return;
  // Nothing to do if every month is already here — which is the steady state
  // after the first full pass, and avoids a toast that only says so.
  void keptStats().then(({ months: kept }) => {
    if (kept >= months.length) return;
    void cacheAllNow(months);
  });
}

/**
 * The month a hash reads, so a replaced shard only redraws a screen that shows
 * it. Trip pages are left alone: a trip's days come from the index, and a
 * changed shard changes its pictures, not its shape.
 */
function monthOfHash(hash: string): string | null {
  return /^#\/month\/(\d{4}-\d{2})$/.exec(hash)?.[1] ?? /^#\/day\/(\d{4}-\d{2})-\d{2}/.exec(hash)?.[1] ?? null;
}

/** Pulls changed shards, and redraws the month on screen if it was one. */
let syncing = false;
export async function syncAndRefresh(): Promise<void> {
  if (syncing || !navigator.onLine) return;
  syncing = true;
  try {
    const changed = await syncKeptShards();
    if (!changed.length) return;
    const hash = currentHashOrNull();
    const month = hash ? monthOfHash(hash) : null;
    if (month && changed.includes(month)) rerender();
  } finally {
    syncing = false;
  }
}

/** Every month the archive knows, for the cache pass and Settings. */
export function allMonths(): string[] {
  return archive().months.map((month) => month.month);
}

/**
 * Re-kicks the background work when the app comes back to the foreground, or
 * the network returns.
 *
 * A WebView that was backgrounded stops running timers, so a long cache pass
 * stalls with the screen and a silent token renewal can have failed while the
 * radio was asleep. Both are retried here, once per return, and both resume
 * from where they stopped — a month already kept is skipped.
 */
let rearming = false;
function rearm(): void {
  if (rearming || !navigator.onLine) return;
  rearming = true;
  const months = allMonths();
  void Promise.all([syncAndRefresh(), keptStats().then(({ months: kept }) => {
    if (kept < months.length) startAutoCache(months);
  })])
    .catch(() => {})
    .finally(() => {
      rearming = false;
    });
}

export function initOfflineResume(): void {
  if (isNative) void App.addListener("resume", rearm);
  window.addEventListener("online", rearm);
}
