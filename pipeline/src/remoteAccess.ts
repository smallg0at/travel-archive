import type { RemoteAccessStatus } from "@travel-archive/shared";
import { env } from "./env.js";
import { readSavedEnv, saveConfig } from "./configStore.js";

/**
 * Who can reach the job server: read from `.env`, written through Settings.
 *
 * Two things make this different from every other setting in the form. It is
 * **decided at startup** — `server.listen` takes the host and `makeAccess` the
 * password, both once — so a save is a save and not a change, and the status
 * says which of the two has happened. And it is the one setting whose mistake
 * is invisible until it matters: a host that cannot be bound is a server that
 * never starts again, so the value is chosen from two options rather than
 * typed (see `HOST_VALUES` in configStore.ts).
 */

const LOOPBACK = ["127.0.0.1", "localhost", "::1"];

export const isExposed = (host: string): boolean => !LOOPBACK.includes(host);

/**
 * The server's own answer, taken from `.env` **at startup**.
 *
 * Captured at module load rather than read when asked, because `saveConfig`
 * rewrites `process.env` and reloads the live `env` object the moment a form
 * is submitted — and the running server has not changed at that point. Reading
 * `env.archiveHost` later would report the *saved* answer as the running one,
 * which is precisely the lie `restartNeeded` exists to prevent.
 */
const RUNNING = { host: env.archiveHost, password: env.archivePassword ?? null };

export const runningHost = RUNNING.host;
export const runningExposed = isExposed(RUNNING.host);
export const runningPassword = RUNNING.password;

export async function remoteAccessStatus(): Promise<RemoteAccessStatus> {
  const saved = await readSavedEnv();
  // Absent means the default applies on the next start, not "cleared".
  const savedHost = saved.ARCHIVE_HOST ?? "127.0.0.1";
  const savedPassword = saved.ARCHIVE_PASSWORD ?? null;
  return {
    host: RUNNING.host,
    exposed: isExposed(RUNNING.host),
    hasPassword: Boolean(RUNNING.password),
    savedHost,
    savedHasPassword: Boolean(savedPassword),
    savedExposed: isExposed(savedHost),
    restartNeeded: savedHost !== RUNNING.host || Boolean(savedPassword) !== Boolean(RUNNING.password),
  };
}

export interface RemoteAccessPatch {
  /** True listens on 0.0.0.0, false back to loopback; absent leaves it alone. */
  exposed?: boolean;
  /** A string sets the shared password, null clears it, absent leaves it alone. */
  password?: string | null;
}

/**
 * Saves the form. Nothing here takes effect until the server restarts, which
 * the returned status says in its own words rather than leaving the reader to
 * discover it by being refused.
 */
export async function setRemoteAccess(patch: RemoteAccessPatch): Promise<RemoteAccessStatus> {
  const out: Partial<Record<"ARCHIVE_HOST" | "ARCHIVE_PASSWORD", string | null>> = {};
  if (typeof patch.exposed === "boolean") out.ARCHIVE_HOST = patch.exposed ? "0.0.0.0" : "127.0.0.1";
  if (patch.password !== undefined) out.ARCHIVE_PASSWORD = patch.password;
  await saveConfig(out);
  return remoteAccessStatus();
}
