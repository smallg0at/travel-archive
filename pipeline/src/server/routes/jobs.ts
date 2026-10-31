/**
 * Starting, watching and cancelling pipeline work.
 */

import { planAnalyze, runAnalyze } from "../../jobs/analyze.js";
import { autoSubmitStatus, collectAnalyzeBatches, listAnalyzeBatches, stopAutoSubmit, submitAnalyzeBatch } from "../../jobs/analyzeBatch.js";
import { planOrganize, runOrganize } from "../../jobs/organize.js";
import { resolveRange, runScan, type ScanMode } from "../../jobs/scan.js";
import { runScreenCaptions } from "../../jobs/screenCaptions.js";
import { parseTranslateOptions, planTranslate, runTranslate } from "../../jobs/translate.js";
import { runTrip } from "../../jobs/trip.js";
import { json, readJsonBody, refuseIfBusy, type Route } from "../http.js";
import * as jobs from "../jobs.js";
import { streamJob } from "../jobStream.js";
import type { RouteContext } from "./context.js";

/** The routes, in the order they were written; the dispatcher keeps looking after a method mismatch. */
export const jobRoutes = (ctx: RouteContext): Route[] => [
  [/^\/jobs$/, "GET", (_req, res) => json(res, 200, jobs.listJobs())],
  /** Newest first, including jobs from before the last restart — the Activity page's history. */
  [/^\/jobs\/history$/, "GET", async (_req, res) => json(res, 200, await jobs.jobHistory())],

  [
    /^\/jobs\/analyze\/plan$/,
    "POST",
    async (req, res) => {
      const body = await readJsonBody<{ from?: string; to?: string; limit?: number }>(req);
      const opts = {
        from: body.from ?? null,
        to: body.to ?? null,
        limit: body.limit ?? Number.MAX_SAFE_INTEGER,
      };
      json(res, 200, await planAnalyze(opts));
    },
  ],
  /**
   * Indexing, which the app previously had no way to trigger — Generate offered
   * only the three passes that cost money or depend on one that does, so adding
   * photos to OneDrive meant dropping to a terminal. Free: Graph listing only.
   */
  [
    /^\/jobs\/scan$/,
    "POST",
    async (req, res) => {
      if (refuseIfBusy(res)) return;
      const body = await readJsonBody<{ mode?: ScanMode; from?: string; to?: string }>(req);
      // Resolved on the server so that what "incremental" means lives next to
      // the deletion rule it interacts with, rather than in the page.
      const range = await resolveRange(body.mode ?? "full", { from: body.from ?? null, to: body.to ?? null });
      json(res, 202, jobs.start({ kind: "scan", run: (onProgress, signal) => runScan(range, onProgress, signal) }));
    },
  ],

  [
    // Describing the screenshots the allowlist keeps off the wire, on a model in
    // this machine. Its own route rather than a flag on /jobs/analyze: the two
    // jobs write to different places (the shards, which are uploaded, against a
    // local-only file), and a reader should have to mean this one.
    /^\/jobs\/screens$/,
    "POST",
    async (req, res) => {
      if (refuseIfBusy(res)) return;
      const body = await readJsonBody<{ limit?: number }>(req);
      json(
        res,
        202,
        jobs.start({
          kind: "screens",
          run: (onProgress, signal) => runScreenCaptions({ limit: body.limit }, onProgress, signal),
        }),
      );
    },
  ],

  [
    /^\/jobs\/analyze$/,
    "POST",
    async (req, res) => {
      if (refuseIfBusy(res)) return;
      const body = await readJsonBody<{ from?: string; to?: string; limit?: number; batch?: boolean }>(req);
      const opts = {
        from: body.from ?? null,
        to: body.to ?? null,
        limit: body.limit ?? Number.MAX_SAFE_INTEGER,
      };
      // `batch`: submit to the Batch API at half price instead of captioning
      // now. The job ends at submission; the timer below collects the results.
      const run = body.batch
        ? (onProgress: Parameters<typeof runAnalyze>[1], signal: AbortSignal) => submitAnalyzeBatch(opts, onProgress, signal)
        : (onProgress: Parameters<typeof runAnalyze>[1], signal: AbortSignal) => runAnalyze(opts, onProgress, signal);
      json(res, 202, jobs.start<object>({ kind: "analyze", run }));
    },
  ],

  /** Whether the server is carrying a batch submit on by itself — `autoSubmit` in analyzeBatch.ts. Null when off. */
  [/^\/jobs\/analyze\/auto$/, "GET", async (_req, res) => json(res, 200, await autoSubmitStatus())],

  [
    /^\/jobs\/analyze\/auto\/stop$/,
    "POST",
    async (_req, res) => {
      // The state file belongs to a running submit or collect; cancelling a
      // submit stops the chain as well.
      if (refuseIfBusy(res)) return;
      await stopAutoSubmit();
      json(res, 200, { ok: true });
    },
  ],

  [
    /^\/jobs\/analyze\/collect$/,
    "POST",
    async (_req, res) => {
      if (refuseIfBusy(res)) return;
      const job = jobs.start({ kind: "collect", run: (onProgress, signal) => collectAnalyzeBatches(onProgress, signal) });
      // A collect from the page frees the queue just as the timer's does.
      ctx.checkBatchesAfter(job.id);
      json(res, 202, job);
    },
  ],

  /** Submitted batches and their state. Asks Google about open ones; spends nothing, takes no lock. */
  [/^\/jobs\/analyze\/batches$/, "GET", async (_req, res) => json(res, 200, await listAnalyzeBatches())],
  /**
   * What an organize run would do, spending nothing. Same shape as the analyze
   * plan, and for the same reason: this is the step that costs money, so it
   * should be possible to look before paying.
   */
  [
    /^\/jobs\/organize\/plan$/,
    "POST",
    async (req, res) => {
      const body = await readJsonBody<{ only?: string; force?: boolean; days?: string[] }>(req);
      json(
        res,
        200,
        await planOrganize({ only: body.only ?? null, force: body.force === true, days: body.days ?? null }),
      );
    },
  ],

  [
    /^\/jobs\/organize$/,
    "POST",
    async (req, res) => {
      if (refuseIfBusy(res)) return;
      const body = await readJsonBody<{ only?: string; force?: boolean; days?: string[] }>(req);
      const opts = { only: body.only ?? null, force: body.force === true, days: body.days ?? null };
      json(
        res,
        202,
        jobs.start({ kind: "organize", run: (onProgress, signal) => runOrganize(opts, onProgress, signal) }),
      );
    },
  ],

  [
    /^\/jobs\/trip$/,
    "POST",
    async (req, res) => {
      if (refuseIfBusy(res)) return;
      const body = await readJsonBody<{
        startDate?: string;
        endDate?: string;
        name?: string;
        notes?: string;
        documents?: { name: string; text: string }[];
        allowMissingSummaries?: boolean;
      }>(req);

      if (!body.startDate || !body.endDate) {
        return json(res, 400, { error: "startDate and endDate are required (the range is chosen, not inferred)" });
      }
      const opts = {
        startDate: body.startDate,
        endDate: body.endDate,
        name: body.name?.trim() || null,
        notes: body.notes ?? null,
        documents: body.documents ?? [],
        allowMissingSummaries: body.allowMissingSummaries === true,
      };
      json(res, 202, jobs.start({ kind: "trip", run: (onProgress, signal) => runTrip(opts, onProgress, signal) }));
    },
  ],
  /**
   * Existing text into a second language. The plan spends nothing; the run is
   * text-only model calls, far cheaper than analyze, but still the owner's to
   * start — never a side effect of another job.
   */
  [
    /^\/jobs\/translate\/plan$/,
    "POST",
    async (req, res) => {
      const opts = parseTranslateOptions(await readJsonBody<{ lang?: string; scope?: string; only?: string }>(req));
      if ("error" in opts) return json(res, 400, opts);
      json(res, 200, await planTranslate(opts));
    },
  ],

  [
    /^\/jobs\/translate$/,
    "POST",
    async (req, res) => {
      if (refuseIfBusy(res)) return;
      const opts = parseTranslateOptions(await readJsonBody<{ lang?: string; scope?: string; only?: string }>(req));
      if ("error" in opts) return json(res, 400, opts);
      json(res, 202, jobs.start({ kind: "translate", run: (onProgress, signal) => runTranslate(opts, onProgress, signal) }));
    },
  ],

  [
    /^\/jobs\/([\w-]+)\/events$/,
    "GET",
    (_req, res, [id]) => streamJob(res, id),
  ],
  [
    /^\/jobs\/([\w-]+)\/cancel$/,
    "POST",
    (_req, res, [id]) => {
      const ok = jobs.cancel(id);
      json(res, ok ? 200 : 409, ok ? jobs.getJob(id) : { error: "Job is not running" });
    },
  ],

  [
    /^\/jobs\/([\w-]+)$/,
    "GET",
    (_req, res, [id]) => {
      const record = jobs.getJob(id);
      record ? json(res, 200, record) : json(res, 404, { error: "No such job" });
    },
  ],
];
