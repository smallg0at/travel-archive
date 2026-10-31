/**
 * Everything the server does when nobody asks it to: collecting finished
 * caption batches, scanning for new photos, listening for the errors that
 * arrive outside any job, and noticing when the event loop stalls.
 *
 * None of it is a route, and none of it answers a request — which is why it
 * lives apart from `serve.ts`, where the timers used to sit between the route
 * table and the listener.
 */

import { monitorEventLoopDelay } from "node:perf_hooks";
import { getCachedAccessToken } from "../auth.js";
import { env } from "../env.js";
import { fetchItemMeta, GraphError, listFolderFileNames } from "../graph.js";
import { readSync } from "../syncStore.js";
import { startSyncChecks } from "../jobs/sync.js";
import { autoSubmitDue, collectAnalyzeBatches, locateAhead, locateAheadDue, readyToCollect, submitAnalyzeBatch } from "../jobs/analyzeBatch.js";
import { resolveRange, runScan } from "../jobs/scan.js";
import * as jobs from "./jobs.js";

/**
 * Collects finished caption batches without anyone asking. A batch takes up to
 * a day and the point of it is that nobody waits, so the server checks every
 * ten minutes — and once shortly after starting, for a batch that finished
 * while it was down. Skipped while any job runs; the next tick comes soon.
 */
const COLLECT_EVERY_MS = 10 * 60 * 1000;

/**
 * Looks at the batches again shortly after this job ends, not at the next
 * tick: the automatic submit waits on a collect, and a submit that stopped at
 * the queue limit on the next one.
 */
export function checkBatchesAfter(jobId: string): void {
  const stop = jobs.subscribe(jobId, (record) => {
    if (record.status === "running" || record.status === "queued") return;
    stop();
    setTimeout(() => void collectIfReady(), 5_000);
  });
}

async function collectIfReady(): Promise<void> {
  try {
    if (jobs.runningJob()) return;
    if (await readyToCollect()) {
      console.log("  caption batch finished — collecting");
      const job = jobs.start({ kind: "collect", run: (onProgress, signal) => collectAnalyzeBatches(onProgress, signal) });
      checkBatchesAfter(job.id);
      return;
    }
    // A submit that stopped at Google's queue limit carries on once no batch is open.
    const next = await autoSubmitDue();
    if (next) {
      console.log("  batch queue has room — submitting the next caption batch");
      const job = jobs.start<object>({
        kind: "analyze",
        run: (onProgress, signal) => submitAnalyzeBatch(next, onProgress, signal),
      });
      // Straight on to locating the round after.
      checkBatchesAfter(job.id);
      return;
    }
    // While a batch is out, look up places for the next one — see locateAhead.
    if (await locateAheadDue()) {
      console.log("  batch out at Google — locating photos for the next one");
      jobs.start({ kind: "locate", run: (onProgress, signal) => locateAhead(onProgress, signal) });
    }
  } catch (err) {
    console.warn(`  batch check failed: ${(err as Error).message}`);
  }
}

/**
 * How stale the archive may get before the server looks for new photos itself.
 *
 * Adding photos to OneDrive did nothing until someone opened the app and
 * pressed Sync, so a week of photos could sit outside the archive while the
 * captioner worked through everything else. Six hours means a day's photos are
 * picked up the same evening.
 */
const SCAN_EVERY_MS = 6 * 60 * 60 * 1000;
/**
 * How often that staleness is checked.
 *
 * Deliberately far shorter than SCAN_EVERY_MS, because a check while any job
 * runs does nothing but wait for the next one. At 30 minutes, with the
 * captioner submitting batches back to back, the first build of this went a
 * whole evening without ever finding a free moment — every check landed on a
 * busy server and the scan never ran at all.
 */
const SCAN_CHECK_MS = 5 * 60 * 1000;

let archiveProbe: { value: boolean; at: number } | null = null;
const ARCHIVE_PROBE_MS = 60_000;

/**
 * Whether the metadata folder already holds an archive.
 *
 * The wizard decides whether this machine is a first run from `sync.json`,
 * which is per machine — so a reinstall, a second PC or a new Windows profile
 * reads as a first run even when the account's OneDrive already holds the whole
 * library. That mistake is not cosmetic: the wizard's last page runs the first
 * scan, which re-lists every month folder and rewrites `index.json` against an
 * archive that already exists, on a design that assumes exactly one writer.
 *
 * Asked only when everything local says fresh and somebody is signed in, and
 * cached for a minute, because `/oobe` is polled every two seconds while the
 * wizard is open. One item-metadata request, not the multi-megabyte download
 * (see `fetchItemMeta`). Unanswerable counts as "fresh" — the behaviour before
 * this existed.
 */
export async function archiveAlreadyExists(): Promise<boolean> {
  if (archiveProbe && Date.now() - archiveProbe.at < ARCHIVE_PROBE_MS) return archiveProbe.value;
  let value = false;
  try {
    const token = await getCachedAccessToken();
    if (token) value = (await fetchItemMeta(token, env.metadataFolder, "index.json")) !== null;
  } catch {
    value = false;
  }
  archiveProbe = { value, at: Date.now() };
  return value;
}

/**
 * An incremental scan when the last one has aged out. Listing only: it reads
 * folder metadata from Graph and downloads no photos, so it costs nothing but
 * time, and anything new it finds joins the next caption batch by itself.
 */
async function scanIfDue(): Promise<void> {
  try {
    if (jobs.runningJob()) return;
    const { lastScanAt } = await readSync();
    if (lastScanAt && Date.now() - Date.parse(lastScanAt) < SCAN_EVERY_MS) return;

    // The first scan belongs to setup's last page, not to a timer. This
    // gate used to open the moment page 2 stamped `photosFolderValidatedAt`
    // — an automatic scan could start while the wizard was still open, at
    // which point the reader could walk back (page 3's Back) and pick a
    // different folder: scanning before the choice is final is scanning
    // into a hole. There is no way past the wizard anymore (the quiet
    // escape link is gone), every fresh archive comes back to page 4, and
    // page 4 sets `lastScanAt` — so waiting here costs nothing.
    if (!lastScanAt) {
      console.log("scan check: first scan not run yet — waiting for setup to finish");
      return;
    }

    // And no folder survives a rename: probe before starting, so a missing
    // folder is one log line instead of a failing job. Without a cached
    // account there is nothing to ask with — and the only state that reaches
    // here without one is "confirmed in setup yet signed out", where the job
    // below is the thing that prompts (and now shows its code in Activity).
    const token = await getCachedAccessToken();
    if (token) {
      try {
        await listFolderFileNames(token, env.photosFolder);
      } catch (err) {
        if (err instanceof GraphError && err.status === 404) {
          console.warn(
            `scan check: photo folder not found: ${env.photosFolder} — set ONEDRIVE_PHOTOS_FOLDER, not scanning`,
          );
          return;
        }
        throw err;
      }
    }

    const range = await resolveRange("incremental", { from: null, to: null });
    console.log(`  looking for new photos (from ${range.from ?? "the beginning"})`);
    jobs.start({ kind: "scan", run: (onProgress, signal) => runScan(range, onProgress, signal) });
  } catch (err) {
    console.warn(`  scan check failed: ${(err as Error).message}`);
  }
}

/**
 * Switches the timers on. Called once, from `serve.ts`, after the listener is
 * up — a background scan that starts before the server can answer `/health`
 * looks, from the app, exactly like a server that failed to start.
 */
export function startBackgroundWork(): void {
  /**
   * Keeps the server up when an error arrives outside any job's `await`.
   *
   * undici emits a dropped connection on the request object, not at the call
   * site, so a stream reset mid-download reaches the process rather than the
   * job's catch. On 2026-09-17, on a mobile link, exactly that killed the server
   * in the middle of collecting a 4,000-photo batch and nothing restarted it.
   *
   * The running job cannot be trusted after this, so it is cancelled — which
   * also releases the archive lock it holds. The server itself keeps serving,
   * and the ten-minute check picks the work up again.
   */
  for (const event of ["uncaughtException", "unhandledRejection"] as const) {
    process.on(event, (err: unknown) => {
      console.error(`  ${event}: ${(err as Error)?.message ?? String(err)}`);
      const running = jobs.runningJob();
      if (running) {
        console.error(`  cancelling ${running.kind} ${running.id} after that error`);
        jobs.cancel(running.id);
      }
    });
  }

  /**
   * Names what blocked the event loop, if anything did.
   *
   * The reader's banner calls the server "gone" when `/health` takes longer than
   * `HEALTH_TIMEOUT_MS`, and until now there was no way to tell a job that sat
   * on the loop from a packet lost on the Wi-Fi — "the cause is unclear" was the
   * end of it. This is the other half: an integer sample every 20ms, built into
   * Node (`perf_hooks`), no dependency and no I/O, and the histogram is reset
   * each time so the line names the *window* in which it stalled.
   *
   * Thresholded at 500ms because that is already large enough to be felt, small
   * enough to catch the stall before it reaches the 8s timeout that made the
   * banner say the server was dead.
   */
  const loopLag = monitorEventLoopDelay({ resolution: 20 });
  loopLag.enable();
  const LAG_WARN_MS = 500;
  setInterval(() => {
    const maxMs = loopLag.max / 1e6;
    loopLag.reset();
    if (!Number.isFinite(maxMs) || maxMs < LAG_WARN_MS) return;
    const job = jobs.runningJob();
    console.warn(`  event loop lagged ${Math.round(maxMs)}ms — ${job ? `${job.kind} job ${job.id}` : "no job running"}`);
  }, 5_000);

  setInterval(() => void collectIfReady(), COLLECT_EVERY_MS);
  setTimeout(() => void collectIfReady(), 30_000);

  setInterval(() => void scanIfDue(), SCAN_CHECK_MS);
  // After the collect check, so a batch waiting to be merged is not held up by a
  // scan that has six hours of slack in it.
  setTimeout(() => void scanIfDue(), 60_000);

  // A job that was running when the last process died is not running now.
  void jobs.reapAbandoned().then((n) => {
    if (n) console.log(`${n} job(s) were interrupted when the server last stopped.`);
  });

  startSyncChecks(() => jobs.runningJob() !== null);
}
