import type { JobProgress, PhotoRecord } from "@travel-archive/shared";
import { getAccessToken } from "../auth.js";
import { downloadThumbnailBuffer } from "../graph.js";
import { loadIndex, loadShard } from "../archiveStore.js";
import { analysisTargets } from "../duplicates.js";
import { mayBeAnalyzed } from "../screenshots.js";
import { env, settingNow } from "../env.js";
import { presetById, providerById } from "../providers/index.js";
import { SCREENSHOT_PROMPT } from "../providers/screenshotPrompt.js";
import { mediaTypeFor } from "../util.js";
import type { ProgressFn } from "./analyze.js";
import { pooled } from "./analyze.js";
import { loadScreenCaptions, saveScreenCaptions } from "../screenCaptions.js";

/**
 * The pass that describes the screenshots the allowlist keeps off the wire.
 *
 * 2,365 photographs in this archive are screenshots whose contents nobody has
 * vouched for — WeChat, mail, banking, games, browsers — and `screenshots.ts`
 * keeps every one of them away from the cloud model, which also keeps them out
 * of content search. This pass gives them a description from a model running on
 * this machine, on the explicit condition that the text never leaves it either:
 * it goes to `screen-captions.json` (see `screenCaptions.ts`), never to a shard
 * and never to `search.json`, both of which are uploaded.
 *
 * Three deliberate constraints:
 *
 *  - **A local provider, or nothing.** A cloud id here is refused with a message
 *    saying so, rather than quietly uploading the screens this pass exists for.
 *  - **The screenshot brief.** Name the kind of screen, transcribe nothing —
 *    `screenshotPrompt.ts`. It is passed through `CaptionPhotoInput.brief`, so the
 *    reply shape is the one the caption path already understands.
 *  - **No context.** A screenshot gets no place, no trip, no day note: those
 *    hints exist to help name a *place*, which is not the question here, and they
 *    would be the only archive data in the request.
 */

export interface ScreenCaptionsOptions {
  /** Stop after this many descriptions; 0 or absent means everything waiting. */
  limit?: number;
}

export interface ScreenCaptionsResult {
  described: number;
  failed: number;
  skipped: number;
  /** Targets this run did not reach because of `limit`. */
  deferred: number;
}

/**
 * The provider this pass may use: the configured one, and only if it runs on this
 * machine. Exported so the refusal is testable without a running model.
 */
export function screenProviderId(value = settingNow("SCREENSHOT_PROVIDER")): string {
  const id = value;
  if (!id) {
    throw new Error(
      "No local provider set for describing screenshots. Set SCREENSHOT_PROVIDER (e.g. lmstudio) in Settings or pipeline/.env — the pass refuses to send these screens to a cloud service.",
    );
  }
  const preset = presetById(id);
  if (!preset) throw new Error(`Unknown SCREENSHOT_PROVIDER: "${id}".`);
  if (preset.scope !== "local") {
    throw new Error(
      `SCREENSHOT_PROVIDER is "${id}", which is a cloud service. These screenshots are the ones the allowlist keeps off the wire, so this pass only runs on a service in this machine — point it at ollama or lmstudio.`,
    );
  }
  return id;
}

/**
 * The screenshots this run should describe: withheld from the cloud by the
 * allowlist, not yet described here, one per duplicate group, oldest first.
 * Exported because it is the rule that keeps the pass honest — a change that let
 * an allowlisted photo or a re-describe through would be a privacy or a cost
 * regression, and neither shows up in a type.
 */
export function screenTargets(photos: PhotoRecord[], described: Record<string, unknown>): PhotoRecord[] {
  return analysisTargets(photos)
    .filter((p) => !mayBeAnalyzed(p))
    .filter((p) => !described[p.id])
    .sort((a, b) => (a.takenAt ?? "").localeCompare(b.takenAt ?? ""));
}

export async function runScreenCaptions(
  opts: ScreenCaptionsOptions,
  onProgress: ProgressFn,
  signal?: AbortSignal,
): Promise<ScreenCaptionsResult> {
  const providerId = screenProviderId();
  const limit = opts.limit && opts.limit > 0 ? opts.limit : Number.POSITIVE_INFINITY;

  onProgress({ phase: "signing-in", message: "Signing in..." });
  const token = await getAccessToken();

  onProgress({ phase: "loading", message: "Loading index..." });
  const index = await loadIndex(token);
  const provider = providerById(providerId);
  const done = await loadScreenCaptions(token);

  // Plan first, so the total is known before the first model call and the run can
  // say how much is left rather than only what it did. Each month's shard comes
  // from Graph, so this phase is minutes long on a big archive — it says which
  // month it is on, or a reader (and their own author, once) reads the silence as
  // a hung job.
  const plan: { month: string; targets: PhotoRecord[] }[] = [];
  for (const [i, summary] of index.months.entries()) {
    if (signal?.aborted) break;
    onProgress({ phase: "loading", message: `Reading ${summary.month} (${i + 1}/${index.months.length})...` });
    const shard = await loadShard(token, summary.month);
    const targets = screenTargets(Object.values(shard.photos), done.entries);
    if (targets.length) plan.push({ month: summary.month, targets });
  }

  const waiting = plan.reduce((n, p) => n + p.targets.length, 0);
  const total = Math.min(waiting, limit);
  const result: ScreenCaptionsResult = { described: 0, failed: 0, skipped: 0, deferred: waiting - total };

  if (total === 0) {
    onProgress({
      phase: "done",
      done: 0,
      total: 0,
      message: waiting === 0 ? "Every screenshot already has a description." : "Nothing to do with that limit.",
    });
    return result;
  }

  onProgress({
    phase: "analyzing",
    done: 0,
    total,
    message: `${total} screenshot(s) with ${providerId} on this machine; ${waiting} waiting in all. Nothing is uploaded.`,
  });

  const queue: PhotoRecord[] = [];
  for (const { targets } of plan) {
    for (const record of targets) {
      if (queue.length >= total) break;
      queue.push(record);
    }
    if (queue.length >= total) break;
  }

  /**
   * How many failures in a row mean the engine is gone rather than these
   * photographs being bad. One bad call is ordinary — an odd image, a transient
   * 500 — and five in a row with two streams running is not.
   */
  const FAIL_STREAK_LIMIT = 5;
  let streak = 0;
  let aborted = false;

  const work = async (record: PhotoRecord): Promise<void> => {
    if (signal?.aborted || aborted) return;
    try {
      const image = await downloadThumbnailBuffer(token, record.id);
      if (!image) {
        result.skipped += 1;
        onProgress({ message: `no thumbnail: ${record.fileName}` });
        return;
      }
      const caption = await provider.captionPhoto({
        imageBase64: image.toString("base64"),
        mediaType: mediaTypeFor(record.fileName),
        context: null,
        brief: SCREENSHOT_PROMPT,
      });
      done.entries[record.id] = {
        caption: caption.caption,
        tags: caption.tags,
        model: providerId,
        at: new Date().toISOString(),
      };
      result.described += 1;
      streak = 0;
      // Uploaded every so often, not per photo: the envelope is the whole file,
      // and 2,365 round trips of it would cost more than the model calls do.
      // A cancel keeps whatever the last save caught, which is why this is a
      // counter and not a timer.
      if (result.described % 50 === 0) await saveScreenCaptions(token, done);
      if (result.described % 10 === 0 || result.described + result.failed + result.skipped === total) {
        onProgress({ phase: "analyzing", done: result.described, total });
      }
    } catch (err) {
      result.failed += 1;
      streak += 1;
      onProgress({ message: `failed ${record.fileName}: ${(err as Error).message}` });
      if (streak >= FAIL_STREAK_LIMIT) {
        // The engine being gone and these photographs being bad look the same one
        // call at a time, and they are not the same. On 2026-10-14 llama-server
        // died mid-run, every call after it answered "No models loaded", and the
        // pass went on marking the rest of the queue failed — 2,068 photographs
        // that had done nothing wrong. Stop instead, and say what to check: the
        // ones already described are saved and the rest stay waiting.
        aborted = true;
        throw new Error(
          `${FAIL_STREAK_LIMIT} failures in a row — the local service looks gone rather than these photos being bad. ` +
            `Last error: ${(err as Error).message}. Check that it is running with a model loaded (\`lms ps\` / \`ollama ps\`), then start again: ` +
            `nothing already described is repeated.`,
        );
      }
    }
  };

  await pooled(queue, env.analyzeConcurrency, work);

  // One final save, so a cancel keeps whatever landed and a short run uploads
  // even when it never reached the per-50 threshold.
  onProgress({ phase: "saving", message: "Saving descriptions..." });
  await saveScreenCaptions(token, done);

  // What is left is what the limit cut off — *not* what went wrong. A failure and
  // a missing thumbnail are both left out of the file on purpose, so they stay in
  // the queue and are picked up by the next run; counting them here as well made
  // the summary read "5 failed. 5 still waiting." and look like five more
  // photographs to worry about. They are the same five.
  const left = waiting - result.described - result.failed - result.skipped - result.deferred;
  onProgress({
    phase: "done",
    done: result.described,
    total,
    message:
      `Described ${result.described} screenshot(s)` +
      (result.failed ? `, ${result.failed} failed — they stay in the queue for the next run` : "") +
      (result.skipped ? `, ${result.skipped} with no thumbnail` : "") +
      `. ${left > 0 ? `${left} still waiting` : "Nothing left waiting"}. Nothing left this machine.`,
  });
  return result;
}
