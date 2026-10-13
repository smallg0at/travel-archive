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
  // say how much is left rather than only what it did.
  const plan: { month: string; targets: PhotoRecord[] }[] = [];
  for (const summary of index.months) {
    if (signal?.aborted) break;
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

  const work = async (record: PhotoRecord): Promise<void> => {
    if (signal?.aborted) return;
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
      onProgress({ message: `failed ${record.fileName}: ${(err as Error).message}` });
    }
  };

  await pooled(queue, env.analyzeConcurrency, work);

  // One final save, so a cancel keeps whatever landed and a short run uploads
  // even when it never reached the per-50 threshold.
  onProgress({ phase: "saving", message: "Saving descriptions..." });
  await saveScreenCaptions(token, done);

  const left = waiting - result.described - result.deferred;
  onProgress({
    phase: "done",
    done: result.described,
    total,
    message:
      `Described ${result.described} screenshot(s)` +
      (result.failed ? `, ${result.failed} failed` : "") +
      (result.skipped ? `, ${result.skipped} with no thumbnail` : "") +
      `. ${left > 0 ? `${left} still waiting` : "Nothing left waiting"}. Nothing left this machine.`,
  });
  return result;
}
