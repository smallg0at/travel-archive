import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { AnalyzeBatchState, AnalyzeBatchStatus, PhotoShard } from "@travel-archive/shared";
import { getAccessToken } from "../auth.js";
import { downloadThumbnailBuffer } from "../graph.js";
import { readThumb } from "../thumbStore.js";
import { loadIndex, loadShard, saveIndex, saveShard } from "../archiveStore.js";
import { dataFile } from "../paths.js";
import { env } from "../env.js";
import { mediaTypeFor } from "../util.js";
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

interface StoredBatch extends AnalyzeBatchStatus {
  model: string;
  inputFile: string | null;
  /** [month, photo id] in request order; results come back in the same order. */
  refs: [string, string][];
  error: string | null;
  usage: { promptTokens: number; outputTokens: number; thoughtsTokens: number } | null;
}

interface StateFile {
  batches: StoredBatch[];
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
}

interface OpenFile {
  path: string;
  stream: WriteStream;
  refs: [string, string][];
}

function closeStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => stream.end((err?: Error | null) => (err ? reject(err) : resolve())));
}

export async function submitAnalyzeBatch(
  opts: AnalyzeOptions,
  onProgress: ProgressFn,
  signal?: AbortSignal,
): Promise<BatchSubmitResult> {
  requireGemini();
  onProgress({ phase: "signing-in", message: "Signing in..." });
  const token = await getAccessToken();
  onProgress({ phase: "planning", message: "Loading index..." });
  const index = await loadIndex(token);
  const sources = contextSources(index);
  const state = await readState();
  // A photo already in a batch that has not come back would be paid for twice.
  const queued = new Set(state.batches.filter(isOpen).flatMap((b) => b.refs.map(([, id]) => id)));
  const result: BatchSubmitResult = { submitted: 0, batches: 0, located: 0, noThumbnail: 0, alreadyQueued: 0 };
  await mkdir(BATCH_DIR, { recursive: true });

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
    const uploaded = await ai.files.upload({ file: path, config: { mimeType: "jsonl", displayName } });
    const job = await ai.batches.create({ model: env.geminiModel, src: uploaded.name!, config: { displayName } });
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
  };

  const append = (line: string, ref: [string, string]): Promise<void> => {
    chain = chain.then(async () => {
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
    if (signal?.aborted || budget <= 0) break;
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
      if (signal?.aborted) return;
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
  if (signal?.aborted) {
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

  onProgress({
    phase: "done",
    message:
      result.submitted > 0
        ? `Submitted ${result.submitted} photo(s) in ${result.batches} batch(es). Results are collected automatically when Google finishes — usually within hours, at most a day.`
        : "Nothing to submit in that range.",
  });
  return result;
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

  for (const { batch, resultFile } of ready) {
    if (signal?.aborted) break;
    const local = `${BATCH_DIR}/results-${Date.now()}.jsonl`;
    onProgress({ phase: "downloading", message: `Downloading ${batch.displayName}...` });
    await ai.files.download({ file: resultFile, downloadPath: local });
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
    await writeState(state);
    await rm(local, { force: true });
    result.collected++;
    result.applied += applied;
    result.failed += failed;
    onProgress({
      message: `${batch.displayName}: ${applied} captioned, ${failed} without a caption — ${usage.promptTokens} input, ${usage.outputTokens + usage.thoughtsTokens} output tokens.`,
    });
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
