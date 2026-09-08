import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Pin, SyncState } from "@travel-archive/shared";
import { dataDir, dataFile } from "./paths.js";

/**
 * What sync knows between runs: what is pinned, and where the replica stood
 * the last time it agreed with OneDrive.
 *
 * The eTag is the whole point. Deciding freshness by downloading `index.json`
 * costs 2.4MB and 1-3 seconds; comparing an eTag costs one small request. What
 * has to persist is the eTag *as it was when the two sides last matched*, so a
 * later mismatch means "someone else wrote" rather than "we do not know".
 */

const FILE = "sync.json";

interface SyncFile {
  pins: Pin[];
  /** eTag of index.json as it stood when local and remote last agreed. */
  syncedETag: string | null;
  syncedAt: string | null;
  checkedAt: string | null;
  /**
   * Written locally but not confirmed uploaded.
   *
   * `saveIndex` uploads on every write, so this is normally false the instant
   * after a job finishes. It exists for the cases where that is not true: an
   * upload that failed, and any future edit made locally without pushing.
   */
  dirty: boolean;
  /**
   * The state `checkSync` last computed, so Settings can paint an answer before
   * the Graph round trip that would confirm it. Persisted rather than derived:
   * "behind" and "conflict" cannot be re-derived from the fields above without
   * the remote eTag.
   */
  lastState: SyncState | null;
  /**
   * When a scan last completed. What "incremental" is measured from: the next
   * incremental run starts at this timestamp's month, so a month that was only
   * partly filled when it was scanned is covered again rather than skipped.
   *
   * Null means never scanned, which makes incremental fall back to a full run —
   * there is no sensible lower bound otherwise.
   */
  lastScanAt: string | null;
  autoSyncOnLaunch: boolean;
  /** Minutes between automatic checks while running. 0 means never. */
  intervalMinutes: number;
}

const DEFAULTS: SyncFile = {
  pins: [],
  syncedETag: null,
  syncedAt: null,
  checkedAt: null,
  dirty: false,
  lastState: null,
  lastScanAt: null,
  autoSyncOnLaunch: true,
  intervalMinutes: 0,
};

let cached: SyncFile | null = null;

export async function readSync(): Promise<SyncFile> {
  if (cached) return cached;
  try {
    cached = { ...DEFAULTS, ...(JSON.parse(await readFile(dataFile(FILE), "utf-8")) as Partial<SyncFile>) };
  } catch {
    // Absent or corrupt both mean "never synced", which is a legitimate state
    // rather than an error — a fresh install starts here.
    cached = { ...DEFAULTS };
  }
  return cached;
}

export async function writeSync(patch: Partial<SyncFile>): Promise<SyncFile> {
  const next = { ...(await readSync()), ...patch };
  cached = next;
  await mkdir(dataDir(), { recursive: true });
  await writeFile(dataFile(FILE), `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return next;
}

/** Marks the replica as holding something OneDrive does not. */
export async function markDirty(): Promise<void> {
  await writeSync({ dirty: true });
}

/** Records that local and remote now agree, at this eTag. */
export async function markSynced(etag: string | null): Promise<void> {
  const now = new Date().toISOString();
  await writeSync({ syncedETag: etag, syncedAt: now, checkedAt: now, dirty: false });
}

export async function pins(): Promise<Pin[]> {
  return (await readSync()).pins;
}

/**
 * Whether an item is kept on this device. Used by eviction, which must never
 * discard something the user explicitly asked to keep.
 */
export async function isPinned(kind: Pin["kind"], id: string): Promise<boolean> {
  return (await pins()).some((p) => p.kind === kind && p.id === id);
}

export async function setPin(pin: Pin): Promise<Pin[]> {
  const rest = (await pins()).filter((p) => !(p.kind === pin.kind && p.id === pin.id));
  return (await writeSync({ pins: [...rest, pin] })).pins;
}

export async function removePin(kind: Pin["kind"], id: string): Promise<Pin[]> {
  const rest = (await pins()).filter((p) => !(p.kind === kind && p.id === id));
  return (await writeSync({ pins: rest })).pins;
}
