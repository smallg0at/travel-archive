/**
 * Health, diagnostics, configuration and notifications — what this install is,
 * rather than what the archive holds.
 */

import { isLoopback } from "../../access.js";
import { hasCachedAccount } from "../../auth.js";
import { isWritableKey, saveConfig } from "../../configStore.js";
import { diagnostics } from "../../diagnostics.js";
import { renderCapability } from "../../localThumb.js";
import { sendTestNotification } from "../../notify.js";
import { validateProvider } from "../../providers/index.js";
import { json, readJsonBody, type Route } from "../http.js";
import * as jobs from "../jobs.js";
import { warmingStatus } from "../media.js";
import type { RouteContext } from "./context.js";

/** The routes, in the order they were written; the dispatcher keeps looking after a method mismatch. */
export const systemRoutes = (ctx: RouteContext): Route[] => [
  [
    /^\/health$/,
    "GET",
    async (_req, res) => {
      // The cheap half first, and deliberately so: this is the endpoint the
      // app's banner polls, and it must answer even while a job is hogging the
      // loop — a pause in answering read as "the server died" during a shard
      // upload. Nothing here touches Graph, so it can come back immediately.
      // `render` is the local thumbnail capability (sharp / heic-decode /
      // ffmpeg): probed at most once a minute, and shown by the app so a
      // machine without ffmpeg says so instead of leaving videos blank.
      const body = {
        ok: true,
        signedIn: await hasCachedAccount(),
        running: jobs.runningJob(),
        lastFinished: jobs.lastFinished(),
        warming: warmingStatus(),
        render: await renderCapability(),
      };
      json(res, 200, body);
    },
  ],
  /**
   * What this build has: payload files, baked configuration, render
   * capabilities. Loopback only — the home path and the folder names are not
   * for a reader on the network, and neither is a support surface.
   */
  [
    /^\/diagnostics$/,
    "GET",
    async (req, res) => {
      if (!isLoopback(req.socket.remoteAddress)) {
        return json(res, 403, { error: "Diagnostics belong to the machine running the server" });
      }
      json(res, 200, await diagnostics());
    },
  ],

  [
    /^\/config$/,
    "POST",
    async (req, res) => {
      const body = await readJsonBody<Record<string, unknown>>(req);
      const patch: Record<string, string> = {};
      for (const [key, value] of Object.entries(body)) {
        if (typeof value !== "string") continue;
        // Unknown names are refused rather than ignored, so a typo in the form
        // is a visible error instead of a setting that silently never applies.
        if (!isWritableKey(key)) return json(res, 400, { error: `${key} is not a configurable setting` });
        patch[key] = value;
      }
      try {
        json(res, 200, await saveConfig(patch));
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    },
  ],
  /**
   * One toast on demand — the Settings "send a test" button.
   *
   * A POST, so the write rule already in force applies: this machine only. It
   * posts on the *server's* desktop, which is the point — a remote reader
   * ringing the owner's bell on request would be the wrong half of the
   * feature. The answer carries the reason when Windows refuses, because a
   * button that cannot fail cannot confirm anything.
   */
  [
    /^\/notify\/test$/,
    "POST",
    async (_req, res) => {
      try {
        await sendTestNotification();
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    },
  ],
  /**
   * Asks a provider one cheap question: does this key (or endpoint) work?
   *
   * Setup used to write any text a reader typed into `.env` and continue;
   * a typo surfaced minutes later as a failed job. `auth` (401/403) is a
   * wrong key, `unreachable` is no answer at all — the page blocks on
   * either. The key itself is never part of the response.
   */
  [
    /^\/config\/validate$/,
    "POST",
    async (req, res) => {
      if (!ctx.access.isLocal(req)) return json(res, 403, { error: "Local only" });
      const body = await readJsonBody<{ provider?: unknown; key?: unknown }>(req);
      if (typeof body.provider !== "string" || !body.provider)
        return json(res, 400, { error: "provider is required" });
      const key = typeof body.key === "string" ? body.key : undefined;
      return json(res, 200, await validateProvider(body.provider, key));
    },
  ],
];
