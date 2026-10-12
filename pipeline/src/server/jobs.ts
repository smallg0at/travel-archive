import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dataFile } from "../paths.js";
import { withArchiveLock } from "../lock.js";
import { notifyJobFinished } from "../notify.js";
import { randomUUID } from "node:crypto";
import { GraphError } from "../graph.js";
import type { JobKind, JobProgress, JobRecord } from "@travel-archive/shared";

/**
 * The job registry: one running job's worth of state, its subscribers, and a
 * copy on disk.
 *
 * **One job at a time, by design.** Every job here writes to the same OneDrive
 * index.json, and two concurrent writers would silently clobber each other —
 * `saveIndex` reads nothing back before uploading. Rather than add locking for
 * a single-user tool, a second start is refused while one is running.
 *
 * State is mirrored to `pipeline/data/jobs/<id>.json` so that a browser
 * reloaded mid-run can reattach to a job it did not start, and so a finished
 * run leaves a record behind. The in-memory map is the source of truth while
 * the process lives; the files are for reading afterwards.
 */

const JOB_DIR = dataFile("jobs");
const MAX_LOG_LINES = 200;
/** Finished jobs kept in memory, so a reconnecting client can still read the outcome. */
const MAX_REMEMBERED = 20;

interface LiveJob {
  record: JobRecord;
  controller: AbortController;
  subscribers: Set<(record: JobRecord) => void>;
}

const jobs = new Map<string, LiveJob>();
let order: string[] = [];

export function getJob(id: string): JobRecord | null {
  return jobs.get(id)?.record ?? null;
}

export function listJobs(): JobRecord[] {
  return order.map((id) => jobs.get(id)!.record).filter(Boolean);
}

/** Log lines kept per job in the history list — a whole-library run writes 200. */
const HISTORY_LOG_LINES = 40;

/**
 * Jobs newest first: the ones this process remembers, plus the ones it has
 * forgotten or that ran before a restart, from their files in `data/jobs/`.
 * The Activity page's history — the in-memory list alone forgets everything
 * at the twentieth job and at every restart. A running job is only in memory
 * (its file is written when it ends), and the memory copy wins where both exist.
 */
export async function jobHistory(limit = 40): Promise<JobRecord[]> {
  const byId = new Map<string, JobRecord>();
  let names: string[] = [];
  try {
    names = (await readdir(JOB_DIR)).filter((n) => n.endsWith(".json"));
  } catch {
    // No job has ever finished here.
  }
  for (const name of names) {
    try {
      const record = JSON.parse(await readFile(`${JOB_DIR}/${name}`, "utf-8")) as JobRecord;
      byId.set(record.id, record);
    } catch {
      // A file caught mid-write is skipped; it is complete on the next read.
    }
  }
  for (const record of listJobs()) byId.set(record.id, record);
  return [...byId.values()]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit)
    .map((record) => ({ ...record, log: record.log.slice(-HISTORY_LOG_LINES) }));
}

/**
 * The job that ended most recently, as a stub. A client polling `/health` can
 * miss a job entirely — an empty collect is over in under a second — but not
 * this id changing, which is how the app notices it should reload its data.
 */
export function lastFinished(): Pick<JobRecord, "id" | "kind" | "status" | "finishedAt"> | null {
  let latest: JobRecord | null = null;
  for (const record of listJobs()) {
    if (record.finishedAt && (!latest || record.finishedAt > latest.finishedAt!)) latest = record;
  }
  return latest && { id: latest.id, kind: latest.kind, status: latest.status, finishedAt: latest.finishedAt };
}

export function runningJob(): JobRecord | null {
  return listJobs().find((j) => j.status === "running" || j.status === "queued") ?? null;
}

export function subscribe(id: string, listener: (record: JobRecord) => void): () => void {
  const job = jobs.get(id);
  if (!job) return () => {};
  job.subscribers.add(listener);
  return () => job.subscribers.delete(listener);
}

export function cancel(id: string): boolean {
  const job = jobs.get(id);
  if (!job || (job.record.status !== "running" && job.record.status !== "queued")) return false;
  job.controller.abort();
  return true;
}

async function persist(record: JobRecord): Promise<void> {
  try {
    await mkdir(JOB_DIR, { recursive: true });
    await writeFile(`${JOB_DIR}/${record.id}.json`, JSON.stringify(record, null, 2), "utf-8");
  } catch {
    // A job that cannot write its own bookkeeping should still finish the real
    // work; the in-memory record and the SSE stream are unaffected.
  }
}

/**
 * Marks jobs left "running" by a previous process as failed.
 *
 * A record used to be written only when a job ended, so a run killed with the
 * server — quitting the desktop app, or it restarting under an editor's
 * changes — disappeared with no trace at all, and a summarizing run that had
 * been going for minutes looked as though it had never happened. One is now
 * written when the job starts, and this settles whatever the last process
 * left behind.
 */
export async function reapAbandoned(): Promise<number> {
  let reaped = 0;
  try {
    for (const file of await readdir(JOB_DIR)) {
      if (!file.endsWith(".json")) continue;
      const record = JSON.parse(await readFile(`${JOB_DIR}/${file}`, "utf-8")) as JobRecord;
      if (record.status !== "running" && record.status !== "queued") continue;
      record.status = "failed";
      record.error = "The server stopped while this job was running.";
      record.log.push(`error: ${record.error}`);
      record.finishedAt = new Date().toISOString();
      await persist(record);
      reaped++;
    }
  } catch {
    // Bookkeeping: never worth failing a start over.
  }
  return reaped;
}

function emit(job: LiveJob): void {
  for (const listener of job.subscribers) {
    try {
      listener(job.record);
    } catch {
      // A dead SSE connection must not take the job down with it.
    }
  }
}

export interface StartOptions<R> {
  kind: JobKind;
  run: (
    onProgress: (p: Partial<JobProgress> & { message?: string }) => void,
    signal: AbortSignal,
  ) => Promise<R>;
}

/**
 * A log line's time, on this machine's clock.
 *
 * It used to be `new Date().toISOString().slice(11, 19)` — UTC — so every line
 * read eight hours early to an owner in UTC+8, and the timestamps down the log
 * disagreed with the `startedAt`/`finishedAt` the app formats in local time.
 * A job runs here; its clock is this machine's.
 */
function clockTime(now = new Date()): string {
  return [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/**
 * Starts a job and returns immediately with its record. The work runs detached;
 * callers watch it via `subscribe` or poll `getJob`.
 */
export function start<R extends object>(opts: StartOptions<R>): JobRecord {
  const id = randomUUID();
  const record: JobRecord = {
    id,
    kind: opts.kind,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    progress: { phase: "starting", done: 0, total: 0, message: null },
    log: [],
    error: null,
    result: null,
  };

  const job: LiveJob = { record, controller: new AbortController(), subscribers: new Set() };
  jobs.set(id, job);
  order.push(id);

  // Keep the map from growing without bound across a long session, but never
  // evict something still running.
  const finished = order.filter((jid) => {
    const s = jobs.get(jid)?.record.status;
    return s === "done" || s === "failed" || s === "cancelled";
  });
  for (const stale of finished.slice(0, Math.max(0, finished.length - MAX_REMEMBERED))) {
    jobs.delete(stale);
  }
  order = order.filter((jid) => jobs.has(jid));

  const onProgress = (p: Partial<JobProgress> & { message?: string }) => {
    record.progress = {
      phase: p.phase ?? record.progress.phase,
      done: p.done ?? record.progress.done,
      total: p.total ?? record.progress.total,
      message: p.message ?? null,
    };
    if (p.message) {
      record.log.push(`${clockTime()}  ${p.message}`);
      if (record.log.length > MAX_LOG_LINES) record.log.splice(0, record.log.length - MAX_LOG_LINES);
    }
    emit(job);
  };

  // Written before the work starts, so a job killed with the server leaves
  // evidence rather than nothing; `reapAbandoned` settles it on next launch.
  void persist(record);

  void (async () => {
    try {
      // Every job kind writes the same shards and index.json, so the lock goes
      // here rather than on each route — a new job kind is covered by default
      // instead of by remembering. Held only while the job runs: an idle server
      // must not lock the owner out of their own CLI.
      const result = await withArchiveLock(`serve (${opts.kind})`, () =>
        opts.run(onProgress, job.controller.signal),
      );
      // Job results are flat counter objects (AnalyzeResult, OrganizeResult).
      // They satisfy the shape but not the index signature TS wants, and
      // widening the field to `unknown` would just move the cast to every
      // client that reads it.
      record.result = result as unknown as Record<string, number>;
      record.status = job.controller.signal.aborted ? "cancelled" : "done";
    } catch (err) {
      record.status = "failed";
      // The reader sees `record.error` in the app's day editor and activity
      // list, so it holds the short message (`Graph API 401 Unauthorized — …`).
      // The full request — URL and response body — goes to the log, which is
      // where it is worth reading.
      record.error = (err as Error).message;
      record.log.push(`error: ${record.error}`);
      if (err instanceof GraphError) record.log.push(`graph: ${err.status} ${err.url} — ${err.body}`);
    } finally {
      record.finishedAt = new Date().toISOString();
      // This emit carries the terminal status, which is what tells each SSE
      // stream to send its last frame and close itself.
      emit(job);
      await persist(record);
      // After `persist`, never before: a toast announcing a job whose record is
      // not on disk yet would be a claim about work that could still be lost.
      // And never awaited — announcing a job is the softest thing this server
      // does, and it decides for itself what is worth saying (see notify.ts).
      notifyJobFinished(record, { watched: job.subscribers.size > 0 });
    }
  })();

  return record;
}
