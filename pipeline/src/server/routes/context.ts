/**
 * What a route module needs from `serve.ts` that is not a module of its own.
 *
 * Almost everything a route touches — the job runner, the thumbnail cache, the
 * Graph mirror — is an import, so it does not appear here. What does appear is
 * the state that belongs to *this running server*: who may read it, how much
 * of it a stranger may cost, and the two hooks that only `serve.ts` can offer
 * (restarting itself, and the post-job bookkeeping that watches for finished
 * batches). `serve.ts` builds one of these at startup and hands it to every
 * route module.
 */

import type { makeAccess } from "../../access.js";
import type { RateLimiter } from "../../rateLimit.js";
import type { RestartHost } from "../restart.js";

export interface RouteContext {
  /** Who may read and write, from this socket — the password gate and local-only rule. */
  access: ReturnType<typeof makeAccess>;
  /** True when this server listens on the network rather than on loopback. */
  exposed: boolean;
  /** The budget a cache miss on `/thumb` costs, per socket address. */
  thumbLimiter: RateLimiter;
  /** Close the listeners and start a replacement — see `restart.ts`. */
  restartHost: RestartHost;
  /** Whether the account already holds an archive, for the first-run wizard. */
  archiveAlreadyExists(): Promise<boolean>;
  /** Look for finished analyze batches after a collect job starts. */
  checkBatchesAfter(jobId: string): void;
}
