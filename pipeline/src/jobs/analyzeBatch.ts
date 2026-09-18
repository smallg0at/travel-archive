import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { AnalyzeBatchState, AnalyzeBatchStatus, AutoSubmitStatus, PhotoShard } from "@travel-archive/shared";
import { getAccessToken } from "../auth.js";
import { downloadThumbnailBuffer } from "../graph.js";
import { readThumb } from "../thumbStore.js";
import { loadIndex, loadShard, saveIndex, saveShard } from "../archiveStore.js";
import { buildSearchIndex } from "./searchIndex.js";
import { buildHomeIndex } from "./homeIndex.js";
import { dataFile } from "../paths.js";
import { env } from "../env.js";
import { isNetworkError, mediaTypeFor } from "../util.js";
import { captionBatchRequest, geminiClient, parseCaptionJson } from "../providers/gemini.js";
import {
  captionContextFor,
  contextSources,
  geocodeBeforeCaptioning,
  inheritToDuplicates,
  pooled,
  selectTargets,
  type AnalyzeOptions,
  type ProgressFn,
} from "./analyze.js";

/**
 * Captioning through the Gemini Batch API: half the price of the same calls
 * made one by one, in exchange for results within 24 hours (usually much
 * sooner). Worth it for a whole-library pass — 23,428 photos waited at the
 * time of writing — and not for a weekend's photos you want to read tonight,
 * which is why the interactive run stays.
 *
 * Two steps rather than one job, because nobody should hold the archive lock
 * for a day:
 *
 *  - **submit** does everything that needs the archive — locating the photos
 *    (the context the prompt carries), reading thumbnails, writing the
 *    requests — then uploads and hands over. The lock is released when it ends.
 *  - **collect** runs once Google has finished, merges the captions into the
 *    shards under the lock, and is started by the server on a timer, so no one
 *    has to come back and press anything.
 *
 * The record of what was submitted lives in `data/batches/analyze.json`, not in
 * memory: a batch is being paid for, and a restart of the server, the laptop or
 * the app must not lose the way back to it. It is written the moment each
 * batch is created, before anything else can fail.
 */

const BATCH_DIR = dataFile("batches");
const STATE_FILE = dataFile("batches", "analyze.json");

/**
 * Requests per batch file. Thumbnails average 63KB, 84KB as base64, so the
 * whole library is ~1.97GB — right at the 2GB file cap. 4,000 is ~340MB a
 * file, and one batch that fails or expires then costs a sixth of the run
 * rather than all of it.
 */
const PER_FILE = 4000;
/** Thumbnails fetched from Graph at once when the local cache does not have them. */
const DOWNLOADS_AT_ONCE = 8;

/**
 * Batch prices, US dollars per million tokens (ai.google.dev/gemini-api/docs/pricing,
 * read 2026-09-11) — half the standard rate. Output includes thinking. Google
 * doubles them from 2027-01-01, which `costOf` applies by the batch's date.
 */
const BATCH_PRICES: Record<string, { input: number; output: number }> = {
  "gemini-3.7-flash": { input: 0.375, output: 1.875 },
};

function costOf(batch: StoredBatch): number | null {
  const price = BATCH_PRICES[batch.model];
  if (!price || !batch.usage) return null;
  const factor = batch.createdAt >= "2027-01-01" ? 2 : 1;
  const { promptTokens, outputTokens, thoughtsTokens } = batch.usage;
  return (factor * (promptTokens * price.input + (outputTokens + thoughtsTokens) * price.output)) / 1e6;
}

interface StoredBatch extends Omit<AnalyzeBatchStatus, "costUsd"> {
  model: string;
  inputFile: string | null;
  /** [month, photo id] in request order; results come back in the same order. */
  refs: [string, string][];
  error: string | null;
  usage: { promptTokens: number; outputTokens: number; thoughtsTokens: number } | null;
}

/**
 * A submit that stopped at Google's queue limit, carried on by the server once
 * the queue has room. Tier 1 allows 3M tokens enqueued across all open batches
 * for Gemini 3.7 Flash, and one file of 4,000 photos is ~2.6M — so on that
 * tier the library goes one batch at a time, and nobody should have to come
 * back after each to press Submit again.
 */
interface AutoSubmit {
  from: string | null;
  to: string | null;
  /** What is left of the original limit. */
  limit: number;
  since: string;
  /** Network failures in a row; the chain stops at NETWORK_FAILURES_ALLOWED. */
  failures?: number;
}

interface StateFile {
  batches: StoredBatch[];
  autoSubmit?: AutoSubmit | null;
  /**
   * Set the first time Google refuses a batch for its queue limit. From then
   * on a submit stops after one file, and skips preparing at all while a batch
   * is open, instead of preparing and uploading a file (~330MB) only to have it
   * refused.
   */
  queueLimited?: boolean;
  /**
   * Photos a batch returned without a caption — RECITATION, a refusal. Left
   * out of later batches, or the automatic submit would send the same few
   * round after round forever; the interactive run's fallback is what gets
   * them captioned.
   */
  noCaption?: string[];
  /** The open batch `locateAhead` last finished for, so it runs once per round. */
  locatedAheadFor?: string | null;
}

/** Attempts at the request-file upload before the submit gives up. */
const UPLOAD_ATTEMPTS = 3;

/** Attempts at downloading a finished batch's results before the collect gives up. */
const DOWNLOAD_ATTEMPTS = 3;

/**
 * How long the results file may go without growing before the attempt is dead.
 *
 * The SDK's download either resolves or rejects; it does not notice a socket
 * that simply stops delivering. Observed 2026-09-18 on a weak connection: a
 * collect sat in "downloading" for 37 minutes with its partial file untouched
 * since the first second — holding the archive lock, blocking every other job,
 * and deaf to a cancel, because the retry loop only ever sees errors. Progress
 * is therefore watched from the outside.
 */
const DOWNLOAD_STALL_MS = 60_000;
/** How often the partial file is measured. Cheap: one stat of a local file. */
const STALL_CHECK_MS = 5_000;

/** Raised by the watchdog, and retried like any other broken connection. */
class DownloadStalled extends Error {
  constructor(seconds: number) {
    super(`no data for ${seconds}s`);
  }
}

/**
 * Rejects when `path` stops growing, or when the job is cancelled.
 *
 * Returned with its own `stop`, which the caller must call: this races against
 * a download that usually wins, and an unstopped interval would keep the
 * process awake and keep measuring a file nobody is writing.
 */
function watchProgress(
  path: string,
  label: string,
  onProgress: ProgressFn,
  signal?: AbortSignal,
): { promise: Promise<never>; stop: () => void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    let lastSize = -1;
    let lastGrewAt = Date.now();
    timer = setInterval(() => {
      if (signal?.aborted) return reject(new Error("Cancelled"));
      void stat(path)
        .then(({ size }) => {
          if (size !== lastSize) {
            lastSize = size;
            lastGrewAt = Date.now();
            // The measurement is taken anyway, so it may as well be shown:
            // this phase is otherwise a single line that sits there for
            // minutes with no sign of whether anything is arriving.
            onProgress({ phase: "downloading", message: `${label} — ${(size / 1e6).toFixed(1)}MB` });
            return;
          }
          const still = Date.now() - lastGrewAt;
          if (still >= DOWNLOAD_STALL_MS) reject(new DownloadStalled(Math.round(still / 1000)));
        })
        // The file does not exist until the first byte lands; that is not a stall.
        .catch(() => undefined);
    }, STALL_CHECK_MS);
  });
  return { promise, stop: () => clearInterval(timer) };
}

/**
 * One batch's results, retrying a connection that breaks or goes quiet.
 *
 * Each attempt writes to its own path: an abandoned download may still be
 * alive and writing, and two of them appending to one file would produce a
 * JSONL that parses as neither.
 */
async function downloadResults(
  ai: ReturnType<typeof geminiClient>,
  resultFile: string,
  basePath: string,
  label: string,
  onProgress: ProgressFn,
  signal?: AbortSignal,
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const path = attempt === 1 ? basePath : `${basePath}.${attempt}`;
    const watch = watchProgress(path, label, onProgress, signal);
    try {
      await Promise.race([ai.files.download({ file: resultFile, downloadPath: path }), watch.promise]);
      return path;
    } catch (err) {
      const stalled = err instanceof DownloadStalled;
      if (signal?.aborted || attempt >= DOWNLOAD_ATTEMPTS || !(stalled || isNetworkError(err))) throw err;
      onProgress({
        message: `Download ${stalled ? "stalled" : "failed"} (${(err as Error).message}) — trying again, attempt ${attempt + 1} of ${DOWNLOAD_ATTEMPTS}.`,
      });
      await rm(path, { force: true });
      await new Promise((resolve) => setTimeout(resolve, attempt * 15_000));
    } finally {
      watch.stop();
    }
  }
}

/** Network failures in a row before the automatic chain switches itself off. */
const NETWORK_FAILURES_ALLOWED = 3;

/** Google's "too much enqueued" answer — HTTP 429, RESOURCE_EXHAUSTED. */
function isQueueFull(err: unknown): boolean {
  return (err as { status?: number }).status === 429 || /RESOURCE_EXHAUSTED/.test((err as Error).message ?? "");
}

async function readState(): Promise<StateFile> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf-8")) as StateFile;
  } catch {
    return { batches: [] };
  }
}

async function writeState(state: StateFile): Promise<void> {
  await mkdir(BATCH_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 1), "utf-8");
  await rename(tmp, STATE_FILE);
}

const FAILED: AnalyzeBatchState[] = ["failed", "cancelled", "expired"];

/** Google's job states, folded into the ones the page shows. */
function stateOf(remote: string | undefined): AnalyzeBatchState {
  switch (remote) {
    case "JOB_STATE_RUNNING":
      return "running";
    case "JOB_STATE_SUCCEEDED":
    case "JOB_STATE_PARTIALLY_SUCCEEDED":
      return "succeeded";
    case "JOB_STATE_FAILED":
      return "failed";
    case "JOB_STATE_CANCELLED":
    case "JOB_STATE_CANCELLING":
      return "cancelled";
    case "JOB_STATE_EXPIRED":
      return "expired";
    default:
      return "pending";
  }
}

/** Still owed captions: not yet merged, and not given up on by Google. */
const isOpen = (b: StoredBatch) => !b.collectedAt && !FAILED.includes(b.state);

function requireGemini(): void {
  if (env.aiProvider !== "gemini") {
    throw new Error("Batch captioning uses the Gemini Batch API — set the AI provider to Gemini in Settings.");
  }
}

export interface BatchSubmitResult {
  submitted: number;
  batches: number;
  located: number;
  noThumbnail: number;
  alreadyQueued: number;
  /** 1 when it stopped at Google's queue limit and left the rest to the server's automatic submit. */
  queueFull: number;
}

interface OpenFile {
  path: string;
  stream: WriteStream;
  refs: [string, string][];
}

function closeStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => stream.end((err?: Error | null) => (err ? reject(err) : resolve())));
}

/**
 * Submits uncaptioned photos as batches of 4,000. On an account whose queue
 * holds one batch at a time it submits one, records the rest as `autoSubmit`,
 * and the server submits the next each time one has been collected.
 *
 * A cancel or a failure clears `autoSubmit`: a chain that has gone wrong must
 * stop rather than try again every ten minutes, uploading hundreds of
 * megabytes each time. The exception is a dropped connection, which the next
 * check may simply get through — three of those in a row still stops it.
 */
export async function submitAnalyzeBatch(
  opts: AnalyzeOptions,
  onProgress: ProgressFn,
  signal?: AbortSignal,
): Promise<BatchSubmitResult> {
  requireGemini();
  const state = await readState();
  try {
    return await submitBatches(state, opts, onProgress, signal);
  } catch (err) {
    // Read again: the submit writes the state as it goes, and `state` here may
    // be several batches out of date.
    const fresh = await readState();
    if (fresh.autoSubmit) {
      const failures = (fresh.autoSubmit.failures ?? 0) + 1;
      if (isNetworkError(err) && failures < NETWORK_FAILURES_ALLOWED) {
        fresh.autoSubmit.failures = failures;
        onProgress({
          message: `Network problem, ${failures} of ${NETWORK_FAILURES_ALLOWED} — the next check tries again.`,
        });
      } else {
        fresh.autoSubmit = null;
        onProgress({ message: "Automatic submit stopped." });
      }
      await writeState(fresh);
    }
    throw err;
  }
}

async function submitBatches(
  state: StateFile,
  opts: AnalyzeOptions,
  onProgress: ProgressFn,
  signal?: AbortSignal,
): Promise<BatchSubmitResult> {
  const result: BatchSubmitResult = { submitted: 0, batches: 0, located: 0, noThumbnail: 0, alreadyQueued: 0, queueFull: 0 };
  const carryOn = async (message: string) => {
    state.autoSubmit = {
      from: opts.from ?? null,
      to: opts.to ?? null,
      limit: opts.limit - result.submitted,
      since: state.autoSubmit?.since ?? new Date().toISOString(),
    };
    await writeState(state);
    onProgress({ phase: "done", message });
  };

  // Known to hold one batch at a time and one is out: preparing now would be
  // refused at the end, so hand straight over to the automatic submit.
  if (state.queueLimited && state.batches.some(isOpen)) {
    result.queueFull = 1;
    await carryOn("A batch is still with Google, and this account's queue holds one at a time. The rest is submitted automatically once it has been collected.");
    return result;
  }

  onProgress({ phase: "signing-in", message: "Signing in..." });
  const token = await getAccessToken();
  onProgress({ phase: "planning", message: "Loading index..." });
  const index = await loadIndex(token);
  const sources = contextSources(index);
  // A photo already in a batch that has not come back would be paid for twice;
  // one that came back empty would come back empty again.
  const queued = new Set([
    ...state.batches.filter(isOpen).flatMap((b) => b.refs.map(([, id]) => id)),
    ...(state.noCaption ?? []),
  ]);
  await mkdir(BATCH_DIR, { recursive: true });

  /** Set once no more files can go in this run; workers stop and the half-built file is dropped. */
  let full = false;
  let file = null as OpenFile | null;
  // Workers append concurrently; the chain keeps lines whole and a file's
  // rotation from racing another worker's write.
  let chain: Promise<void> = Promise.resolve();

  const finish = async () => {
    if (!file) return;
    const { path, stream, refs } = file;
    file = null;
    await closeStream(stream);
    const displayName = `analyze ${new Date().toISOString().slice(0, 16)} #${state.batches.length + 1}`;
    onProgress({ phase: "uploading", message: `Uploading ${refs.length} request(s) — ${displayName}` });
    const ai = geminiClient();
    // ~330MB over whatever connection is to hand. A reset half way through is
    // not a reason to throw away a file that took 10 minutes to prepare.
    let uploaded!: Awaited<ReturnType<typeof ai.files.upload>>;
    for (let attempt = 1; ; attempt++) {
      try {
        uploaded = await ai.files.upload({ file: path, config: { mimeType: "jsonl", displayName } });
        break;
      } catch (err) {
        if (signal?.aborted || attempt >= UPLOAD_ATTEMPTS || !isNetworkError(err)) throw err;
        onProgress({
          message: `Upload failed (${(err as Error).message}) — trying again, attempt ${attempt + 1} of ${UPLOAD_ATTEMPTS}.`,
        });
        await new Promise((resolve) => setTimeout(resolve, attempt * 15_000));
      }
    }
    const anyOpen = state.batches.some(isOpen);
    let job: Awaited<ReturnType<typeof ai.batches.create>>;
    try {
      job = await ai.batches.create({ model: env.geminiModel, src: uploaded.name!, config: { displayName } });
    } catch (err) {
      // With nothing open, a 429 is not the queue — it is spend or rate, and
      // waiting for a collect would not change it. That fails the job.
      if (!anyOpen || !isQueueFull(err)) {
        await rm(path, { force: true });
        throw err;
      }
      full = true;
      result.queueFull = 1;
      state.queueLimited = true;
      await ai.files.delete({ name: uploaded.name! }).catch(() => undefined);
      await rm(path, { force: true });
      onProgress({ message: `Google's batch queue is full — ${refs.length} request(s) held back for the next round.` });
      return;
    }
    state.batches.push({
      name: job.name!,
      displayName,
      createdAt: new Date().toISOString(),
      photos: refs.length,
      state: stateOf(job.state),
      collectedAt: null,
      applied: null,
      failed: null,
      model: env.geminiModel,
      inputFile: uploaded.name ?? null,
      refs,
      error: null,
      usage: null,
    });
    await writeState(state);
    await rm(path, { force: true });
    result.batches++;
    result.submitted += refs.length;
    onProgress({ message: `Submitted ${job.name} — ${refs.length} photo(s).` });
    // One at a time on this account: the next file would only be refused.
    if (state.queueLimited) full = true;
  };

  const append = (line: string, ref: [string, string]): Promise<void> => {
    chain = chain.then(async () => {
      if (full) return;
      if (!file) {
        const path = `${BATCH_DIR}/requests-${Date.now()}.jsonl`;
        file = { path, stream: createWriteStream(path, { encoding: "utf-8" }), refs: [] };
      }
      const open = file;
      if (!open.stream.write(`${line}\n`)) await new Promise<void>((r) => open.stream.once("drain", () => r()));
      open.refs.push(ref);
      if (open.refs.length >= PER_FILE) await finish();
    });
    return chain;
  };

  const months = index.months.filter(
    (m) => (!opts.from || m.month >= opts.from.slice(0, 7)) && (!opts.to || m.month <= opts.to.slice(0, 7)),
  );
  let budget = opts.limit;

  for (const summary of months) {
    if (signal?.aborted || full || budget <= 0) break;
    const shard = await loadShard(token, summary.month);
    const all = selectTargets(shard, opts);
    const fresh = all.filter((p) => !queued.has(p.id));
    result.alreadyQueued += all.length - fresh.length;
    const targets = fresh.slice(0, budget);
    if (targets.length === 0) continue;
    budget -= targets.length;

    onProgress({ phase: "geocoding", message: `${summary.month} — locating ${targets.length} photo(s)` });
    const located = await geocodeBeforeCaptioning(shard, targets, onProgress, signal);
    result.located += located;
    // Saved now: the lookups cost nothing but time, and a cancel keeps them.
    if (located > 0) await saveShard(token, shard);
    if (signal?.aborted) break;

    onProgress({ phase: "preparing", done: 0, total: targets.length, message: `${summary.month} — preparing ${targets.length} request(s)` });
    let prepared = 0;
    await pooled(targets, DOWNLOADS_AT_ONCE, async (target) => {
      if (signal?.aborted || full) return;
      let image: Buffer | null = null;
      try {
        // The server's own thumbnail cache first: the same Graph `large`
        // bytes, already on disk for anything browsed or synced.
        image = (await readThumb("large", target.id)) ?? (await downloadThumbnailBuffer(token, target.id));
      } catch {
        image = null;
      }
      if (!image) {
        result.noThumbnail++;
        onProgress({ message: `no thumbnail: ${target.fileName}` });
        return;
      }
      const photo = shard.photos[target.id] ?? target;
      const request = captionBatchRequest({
        imageBase64: image.toString("base64"),
        mediaType: mediaTypeFor(photo.fileName),
        context: captionContextFor(photo, sources),
      });
      await append(JSON.stringify({ key: `${summary.month}/${target.id}`, request }), [summary.month, target.id]);
      if (++prepared % 50 === 0) onProgress({ phase: "preparing", done: prepared, total: targets.length });
    });
  }

  await chain;
  if (signal?.aborted || full) {
    // Nothing in a half-written file has been sent, so nothing is lost by dropping it.
    if (file) {
      const open = file;
      file = null;
      await closeStream(open.stream);
      await rm(open.path, { force: true });
    }
  } else {
    await finish();
  }

  if (signal?.aborted) {
    // A cancel is a decision to stop, including the chain.
    if (state.autoSubmit) {
      state.autoSubmit = null;
      await writeState(state);
    }
    return result;
  }
  if (full) {
    await carryOn(
      `Submitted ${result.submitted} photo(s). This account's queue holds one batch at a time, so the rest is submitted automatically as each one is collected.`,
    );
    return result;
  }

  // Everything in range is submitted; the chain, if there was one, is done.
  if (state.autoSubmit) {
    state.autoSubmit = null;
    await writeState(state);
  }
  onProgress({
    phase: "done",
    message:
      result.submitted > 0
        ? `Submitted ${result.submitted} photo(s) in ${result.batches} batch(es). Results are collected automatically when Google finishes — usually within hours, at most a day.`
        : "Nothing to submit in that range.",
  });
  return result;
}

/** What the automatic submit will carry on with, for the Activity page; null when it is off. */
export async function autoSubmitStatus(): Promise<AutoSubmitStatus | null> {
  const state = await readState();
  if (!state.autoSubmit) return null;
  return { since: state.autoSubmit.since, from: state.autoSubmit.from, to: state.autoSubmit.to, waitingForBatch: state.batches.some(isOpen) };
}

/**
 * Looks up places for the photos the next automatic submit will send, while
 * the current batch is still at Google.
 *
 * Measured 2026-09-11: a round was ~1h of Nominatim lookups (one a second, and
 * 2024-25 had never been located) followed by 1-2h at Google, back to back,
 * because the lookups ran inside the submit. Done here instead they overlap
 * the wait, and the submit that follows only prepares and uploads — the one
 * whose months were already located took 11 minutes.
 *
 * Takes the same photos the submit will, in the same order, plus a margin for
 * the ones with no thumbnail that the submit skips. Saved month by month, so a
 * cancel keeps what was found.
 */
export async function locateAhead(onProgress: ProgressFn, signal?: AbortSignal): Promise<{ located: number; photos: number }> {
  const state = await readState();
  const open = state.batches.find(isOpen);
  const auto = state.autoSubmit;
  const result = { located: 0, photos: 0 };
  if (!auto || !open) return result;

  onProgress({ phase: "signing-in", message: "Signing in..." });
  const token = await getAccessToken();
  onProgress({ phase: "planning", message: "Loading index..." });
  const index = await loadIndex(token);
  const queued = new Set([
    ...state.batches.filter(isOpen).flatMap((b) => b.refs.map(([, id]) => id)),
    ...(state.noCaption ?? []),
  ]);
  const opts: AnalyzeOptions = { from: auto.from, to: auto.to, limit: auto.limit };
  const months = index.months.filter(
    (m) => (!opts.from || m.month >= opts.from.slice(0, 7)) && (!opts.to || m.month <= opts.to.slice(0, 7)),
  );
  let budget = Math.min(PER_FILE + 200, opts.limit);

  for (const summary of months) {
    if (signal?.aborted || budget <= 0) break;
    const shard = await loadShard(token, summary.month);
    const targets = selectTargets(shard, opts)
      .filter((p) => !queued.has(p.id))
      .slice(0, budget);
    if (targets.length === 0) continue;
    budget -= targets.length;
    result.photos += targets.length;
    onProgress({ phase: "geocoding", message: `${summary.month} — locating ${targets.length} photo(s) for the next batch` });
    const located = await geocodeBeforeCaptioning(shard, targets, onProgress, signal);
    if (located > 0) {
      await saveShard(token, shard);
      result.located += located;
    }
  }

  if (!signal?.aborted) {
    state.locatedAheadFor = open.name;
    await writeState(state);
  }
  onProgress({
    phase: "done",
    message: `Located ${result.located} of ${result.photos} photo(s) ahead of the next batch; its submit now only prepares and uploads.`,
  });
  return result;
}

/** Whether `locateAhead` has work: the chain is on, a batch is out, and this round is not yet located. */
export async function locateAheadDue(): Promise<boolean> {
  const state = await readState();
  const open = state.batches.find(isOpen);
  return Boolean(state.autoSubmit && open && state.locatedAheadFor !== open.name);
}

/** Options for the next automatic submit — only once no batch is open, since the queue holds one. */
export async function autoSubmitDue(): Promise<AnalyzeOptions | null> {
  const state = await readState();
  if (!state.autoSubmit || state.batches.some(isOpen)) return null;
  const { from, to, limit } = state.autoSubmit;
  return { from, to, limit };
}

/** Turns the automatic submit off. Batches already at Google are still collected. */
export async function stopAutoSubmit(): Promise<void> {
  const state = await readState();
  if (!state.autoSubmit) return;
  state.autoSubmit = null;
  await writeState(state);
}

interface ResultLine {
  key?: string;
  response?: {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  };
  error?: { message?: string };
}

export interface BatchCollectResult {
  collected: number;
  applied: number;
  failed: number;
  stale: number;
  stillWaiting: number;
  lost: number;
}

/**
 * Merges every finished batch into the archive.
 *
 * A caption is applied only to a photo that is still uncaptioned: one captioned
 * by an interactive run in the meantime keeps what it has, since the prompt
 * rules keep prose stable by never overwriting it. A photo that came back
 * without a caption — a refusal, RECITATION — stays uncaptioned and is picked
 * up by the next run. Saved batch by batch, so a failure part-way keeps what
 * was merged before it.
 */
export async function collectAnalyzeBatches(onProgress: ProgressFn, signal?: AbortSignal): Promise<BatchCollectResult> {
  requireGemini();
  const state = await readState();
  const result: BatchCollectResult = { collected: 0, applied: 0, failed: 0, stale: 0, stillWaiting: 0, lost: 0 };
  const ai = geminiClient();

  const ready: { batch: StoredBatch; resultFile: string }[] = [];
  for (const batch of state.batches.filter(isOpen)) {
    const job = await ai.batches.get({ name: batch.name });
    batch.state = stateOf(job.state);
    if (batch.state === "succeeded" && job.dest?.fileName) {
      ready.push({ batch, resultFile: job.dest.fileName });
    } else if (FAILED.includes(batch.state)) {
      batch.error = job.error?.message ?? batch.state;
      result.lost += batch.photos;
      onProgress({ message: `${batch.displayName}: ${batch.state} — its ${batch.photos} photo(s) go back in the queue.` });
    } else {
      result.stillWaiting += batch.photos;
    }
  }
  await writeState(state);

  if (ready.length === 0) {
    onProgress({
      phase: "done",
      message: result.stillWaiting ? `Nothing finished yet; ${result.stillWaiting} photo(s) still with Google.` : "No batches to collect.",
    });
    return result;
  }

  onProgress({ phase: "signing-in", message: "Signing in..." });
  const token = await getAccessToken();
  const index = await loadIndex(token);
  const shards = new Map<string, PhotoShard>();
  const noCaption = new Set(state.noCaption ?? []);

  for (const { batch, resultFile } of ready) {
    if (signal?.aborted) break;
    onProgress({ phase: "downloading", message: `Downloading ${batch.displayName}...` });
    const local = await downloadResults(
      ai,
      resultFile,
      `${BATCH_DIR}/results-${Date.now()}.jsonl`,
      `Downloading ${batch.displayName}`,
      onProgress,
      signal,
    );
    const lines = (await readFile(local, "utf-8")).split("\n").filter((l) => l.trim());

    const usage = { promptTokens: 0, outputTokens: 0, thoughtsTokens: 0 };
    const touched = new Set<string>();
    let applied = 0;
    let failed = 0;

    onProgress({ phase: "merging", done: 0, total: lines.length });
    for (const [i, line] of lines.entries()) {
      const row = JSON.parse(line) as ResultLine;
      // Keyed when Google echoes the key; by position otherwise, which the
      // API documents as the request order.
      const key = row.key ?? batch.refs[i]?.join("/");
      const slash = key?.indexOf("/") ?? -1;
      if (!key || slash < 0) {
        failed++;
        continue;
      }
      const month = key.slice(0, slash);
      const id = key.slice(slash + 1);

      const meta = row.response?.usageMetadata;
      usage.promptTokens += meta?.promptTokenCount ?? 0;
      usage.outputTokens += meta?.candidatesTokenCount ?? 0;
      usage.thoughtsTokens += meta?.thoughtsTokenCount ?? 0;

      const candidate = row.response?.candidates?.[0];
      const text = (candidate?.content?.parts ?? [])
        .filter((p) => !p.thought)
        .map((p) => p.text ?? "")
        .join("");
      let caption: ReturnType<typeof parseCaptionJson> | null = null;
      try {
        caption = text ? parseCaptionJson(text) : null;
      } catch {
        caption = null;
      }
      if (!caption) {
        failed++;
        noCaption.add(id);
        if (failed <= 5) onProgress({ message: `no caption for ${id}: ${row.error?.message ?? candidate?.finishReason ?? "empty"}` });
        continue;
      }

      let shard = shards.get(month);
      if (!shard) {
        shard = await loadShard(token, month);
        shards.set(month, shard);
      }
      const current = shard.photos[id];
      if (!current || current.analyzedAt) {
        result.stale++;
        continue;
      }
      const updated = {
        ...current,
        analyzedAt: new Date().toISOString(),
        contentType: caption.contentType,
        caption: caption.caption,
        tags: caption.tags,
        extractedText: caption.extractedText,
        notable: caption.notable,
      };
      shard.photos[id] = updated;
      inheritToDuplicates(shard, updated);
      touched.add(month);
      applied++;
      if (applied % 200 === 0) onProgress({ phase: "merging", done: i + 1, total: lines.length });
    }

    onProgress({ phase: "saving", message: `Saving ${touched.size} month(s)...` });
    for (const month of touched) {
      const shard = shards.get(month)!;
      await saveShard(token, shard);
      const summary = index.months.find((m) => m.month === month);
      if (summary) summary.analyzedCount = Object.values(shard.photos).filter((p) => p.analyzedAt).length;
    }
    if (touched.size > 0) await saveIndex(token, index);

    Object.assign(batch, { collectedAt: new Date().toISOString(), applied, failed, usage });
    state.noCaption = [...noCaption];
    await writeState(state);
    await rm(local, { force: true });
    result.collected++;
    result.applied += applied;
    result.failed += failed;
    onProgress({
      message: `${batch.displayName}: ${applied} captioned, ${failed} without a caption — ${usage.promptTokens} input, ${usage.outputTokens + usage.thoughtsTokens} output tokens.`,
    });
  }

  // Once, after every batch in this run: thousands of new captions are the
  // whole point of search, and rebuilding per batch would read the mirror twice.
  if (result.applied > 0) {
    await buildSearchIndex(token, index, onProgress);
    // New captions do not move photographs, but a collect is also the first
    // time newly scanned photos get their coordinates read, so the map index
    // is rebuilt on the same trigger.
    await buildHomeIndex(token, index, onProgress);
  }


  onProgress({
    phase: "done",
    message: `Collected ${result.collected} batch(es): ${result.applied} photo(s) captioned${result.failed ? `, ${result.failed} left for the next run` : ""}.`,
  });
  return result;
}

/**
 * Every batch and where it has got to. Asks Google about the open ones; spends
 * nothing, takes no lock, and writes nothing — the collect job owns the file.
 */
export async function listAnalyzeBatches(): Promise<AnalyzeBatchStatus[]> {
  const state = await readState();
  return Promise.all(
    state.batches.map(async (b) => {
      let current = b.state;
      if (isOpen(b)) {
        try {
          current = stateOf((await geminiClient().batches.get({ name: b.name })).state);
        } catch {
          // Offline, or no key: show the last state known.
        }
      }
      return {
        name: b.name,
        displayName: b.displayName,
        createdAt: b.createdAt,
        photos: b.photos,
        state: current,
        collectedAt: b.collectedAt,
        applied: b.applied,
        failed: b.failed,
        usage: b.usage,
        costUsd: costOf(b),
      };
    }),
  );
}

/** Whether a collect pass has anything to do — a batch that Google has finished with, either way. */
export async function readyToCollect(): Promise<boolean> {
  const open = (await readState()).batches.filter(isOpen);
  for (const b of open) {
    try {
      const current = stateOf((await geminiClient().batches.get({ name: b.name })).state);
      if (current !== "pending" && current !== "running") return true;
    } catch {
      // Unreachable now; the next check tries again.
    }
  }
  return false;
}
