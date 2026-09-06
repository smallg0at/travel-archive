import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";

/**
 * One writer at a time across the whole pipeline.
 *
 * `serve` already refuses a second job, but that guard lives inside one process
 * and a CLI run walks straight past it. Both write the same month shards and
 * the same index.json, and neither reads the other's work first — so the second
 * to finish silently overwrites the first. **This happened on 2026-09-05**: a
 * CLI `analyze` was started while a server job was 525 photos into the same
 * shard.
 *
 * It matters more now that `serve` is wrapped in a desktop app. A terminal
 * window running the server is visible, and something you remember; a server
 * spawned by an app icon is not, so "is a job running right now?" stops being
 * answerable by looking.
 *
 * The lock is held for the duration of a *write*, never for the lifetime of the
 * server — an idle server must not lock the owner out of their own CLI.
 */

const LOCK_PATH = "data/.archive-lock";

interface LockFile {
  pid: number;
  owner: string;
  startedAt: string;
}

export class ArchiveBusyError extends Error {
  constructor(readonly holder: LockFile) {
    const held = new Date(holder.startedAt).toLocaleTimeString();
    super(
      `Another archive writer is running: ${holder.owner} (pid ${holder.pid}, since ${held}). ` +
        `Wait for it to finish, or stop it, rather than running both — they write the same files.`,
    );
    this.name = "ArchiveBusyError";
  }
}

/**
 * Whether a lock file describes a process that still exists.
 *
 * A crashed or force-killed writer leaves its lock behind, and a stale lock
 * that nothing can clear is worse than no lock: it makes the tool permanently
 * refuse to run. `kill(pid, 0)` sends no signal and only tests for existence.
 *
 * A pid can be reused, which would make a stale lock look live. The window is
 * small and the failure is conservative — a spurious refusal the user can
 * resolve by deleting one file — so it is not worth defending against.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else; that still
    // counts as alive. Only ESRCH — no such process — makes a lock stale.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLock(): Promise<LockFile | null> {
  try {
    const parsed = JSON.parse(await readFile(LOCK_PATH, "utf-8")) as LockFile;
    return typeof parsed?.pid === "number" ? parsed : null;
  } catch {
    // Absent, unreadable or corrupt all mean the same thing: nothing to honour.
    return null;
  }
}

/**
 * Runs `fn` while holding the archive lock, releasing it however `fn` ends.
 *
 * Throws `ArchiveBusyError` without running `fn` when another live process
 * holds it. Not reentrant: a job must not nest another locked call inside
 * itself, or it will refuse its own work.
 */
export async function withArchiveLock<T>(owner: string, fn: () => Promise<T>): Promise<T> {
  const existing = await readLock();
  if (existing && existing.pid !== process.pid && isAlive(existing.pid)) {
    throw new ArchiveBusyError(existing);
  }

  await mkdir("data", { recursive: true });
  const mine: LockFile = { pid: process.pid, owner, startedAt: new Date().toISOString() };

  // `wx` fails if the file appeared between the check above and here. Two
  // processes starting together is exactly the case this exists for, and the
  // check-then-write on its own has a gap wide enough to lose that race.
  try {
    await writeFile(LOCK_PATH, JSON.stringify(mine, null, 2), { encoding: "utf-8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // Lost the race, or the stale lock we meant to take over is still on disk.
    const current = await readLock();
    if (current && current.pid !== process.pid && isAlive(current.pid)) throw new ArchiveBusyError(current);
    // Stale: the previous holder is gone, so take it.
    await writeFile(LOCK_PATH, JSON.stringify(mine, null, 2), "utf-8");
  }

  try {
    return await fn();
  } finally {
    // Only ever remove our own lock — a slow release must not delete the lock
    // of whoever legitimately took over after us.
    const current = await readLock();
    if (current?.pid === process.pid) await unlink(LOCK_PATH).catch(() => {});
  }
}

/**
 * Best-effort release for abnormal exit.
 *
 * Ctrl-C is the normal way to stop a long analyze run, and `finally` does not
 * run when the process is signalled. Synchronous by necessity: an exit handler
 * cannot await.
 */
export function releaseLockOnExit(): void {
  const release = () => {
    try {
      // Deliberately sync — this runs during teardown, where the async
      // readLock/unlink pair above would never complete.
      const raw = readFileSync(LOCK_PATH, "utf-8");
      if ((JSON.parse(raw) as LockFile).pid === process.pid) unlinkSync(LOCK_PATH);
    } catch {
      /* no lock, not ours, or already gone */
    }
  };
  process.once("exit", release);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      release();
      process.exit(130);
    });
  }
}
