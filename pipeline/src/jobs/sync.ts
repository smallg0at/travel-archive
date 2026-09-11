import type { ArchiveIndexFile, Pin, SyncState, SyncStatus } from "@travel-archive/shared";
import { getCachedAccessToken } from "../auth.js";
import { fetchItemMeta } from "../graph.js";
import { downloadMetadataJson } from "../graph.js";
import { env } from "../env.js";
import { withArchiveLock } from "../lock.js";
import { dataFile } from "../paths.js";
import { markSynced, pins, readSync, writeSync } from "../syncStore.js";
import { cacheStats, pathFor, thumbSize, type ThumbSize } from "../thumbStore.js";
import type { ProgressFn } from "./analyze.js";

/**
 * Keeping the local replica and OneDrive in step, and keeping pinned media on
 * disk.
 *
 * This exists because six separate caches had grown up with no shared answer to
 * "is this fresh?" — the metadata mirror was being trusted without ever asking
 * OneDrive at all. It is one job rather than a background daemon so that it
 * reports progress, can be cancelled, and cannot run twice at once, all of
 * which server/jobs.ts already provides.
 */

const INDEX_FILE = "index.json";

/** Bytes of the local metadata mirror — index plus every month shard. */
async function metadataBytes(): Promise<number> {
  const { readdir, stat } = await import("node:fs/promises");
  let total = 0;
  try {
    total += (await stat(dataFile(INDEX_FILE))).size;
  } catch {
    /* never scanned */
  }
  try {
    const dir = dataFile("photos");
    for (const name of await readdir(dir)) {
      try {
        total += (await stat(`${dir}/${name}`)).size;
      } catch {
        /* raced with a write */
      }
    }
  } catch {
    /* no shards yet */
  }
  return total;
}

/**
 * Everything a status answer holds that does not require asking OneDrive.
 *
 * Split out so the cached and the checked answer are the same shape built by
 * the same code — the cached one is a real status with `state` replayed from
 * disk, not a reduced object the UI has to special-case.
 */
async function localStatus(): Promise<{ status: SyncStatus; local: ArchiveIndexFile | null }> {
  const state = await readSync();
  const local = await readLocalIndex();
  return {
    local,
    status: {
      state: "offline",
      stale: true,
      lastScanAt: state.lastScanAt,
      checkedAt: state.checkedAt,
      syncedAt: state.syncedAt,
      localGeneratedAt: local?.generatedAt ?? null,
      remoteLastModified: null,
      pins: state.pins,
      storage: {
        metadataBytes: await metadataBytes(),
        thumbnails: await cacheStats(["medium", "large"]),
        originals: await cacheStats(["full"]),
      },
    },
  };
}

/**
 * The last answer `checkSync` computed, with no Graph call at all.
 *
 * Opening Settings used to block on the eTag comparison below — measured at
 * 687-1,365ms, and seen as high as 10s on a slow link — before it could paint
 * anything. Nothing on the page needs that to render: the state was already
 * known, and `checkedAt` says how old it is. The page paints this and then
 * replaces it with the checked answer when it arrives.
 *
 * `state` is whatever was last *measured* rather than re-derived from `dirty`,
 * because "behind" and "conflict" are not knowable without the remote eTag and
 * guessing "in-sync" here would assert something no one checked.
 */
export async function cachedSync(): Promise<SyncStatus> {
  const { status, local } = await localStatus();
  const state = await readSync();
  if (!(await getCachedAccessToken())) return status;
  status.state = state.lastState ?? (local === null ? "never-synced" : "in-sync");
  return status;
}

/**
 * Compares the replica against OneDrive without downloading it.
 *
 * The whole design rests on this being cheap: the same question asked by
 * fetching `/content` costs 2.4MB and 1-3 seconds, which is why the app used to
 * spend that on every single page load.
 */
export async function checkSync(): Promise<SyncStatus> {
  const state = await readSync();

  const { status, local } = await localStatus();
  status.stale = false;

  const token = await getCachedAccessToken();
  if (!token) return status;

  const remote = await fetchItemMeta(token, env.metadataFolder, INDEX_FILE);
  if (!remote) {
    // Signed in but the file is not there: a fresh archive, or the wrong
    // metadata folder. Either way there is nothing to be behind.
    status.state = local ? "ahead" : "never-synced";
    await writeSync({ lastState: status.state });
    return status;
  }

  status.remoteLastModified = remote.lastModifiedDateTime;
  await writeSync({ checkedAt: new Date().toISOString() });
  status.checkedAt = new Date().toISOString();

  const remoteMoved = state.syncedETag !== null && remote.eTag !== state.syncedETag;

  if (state.syncedETag === null) {
    // No baseline yet. `saveIndex` writes local and uploads in the same call, so
    // an existing clean mirror is by construction the copy that was uploaded —
    // adopt the current eTag as the baseline rather than reporting a
    // disagreement that does not exist. Reporting "ahead" here was wrong: local
    // and remote timestamps matched to the second.
    if (!local) status.state = "never-synced";
    else if (state.dirty) status.state = "ahead";
    else {
      await markSynced(remote.eTag);
      status.state = "in-sync";
      status.syncedAt = new Date().toISOString();
    }
  } else if (state.dirty && remoteMoved) status.state = "conflict";
  else if (remoteMoved) status.state = "behind";
  else if (state.dirty) status.state = "ahead";
  else status.state = "in-sync";

  // Recorded so the next page open can paint this answer without paying for the
  // round trip that produced it.
  await writeSync({ lastState: status.state });
  return status;
}

async function readLocalIndex(): Promise<ArchiveIndexFile | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(dataFile(INDEX_FILE), "utf-8")) as ArchiveIndexFile;
  } catch {
    return null;
  }
}

/** Every photo id a pin covers, from the local index. */
async function pinnedPhotoIds(pin: Pin, index: ArchiveIndexFile): Promise<string[]> {
  if (pin.kind === "trip") {
    const trip = index.sections.find((s) => s.kind === "trip" && s.id === pin.id);
    return trip ? trip.days.flatMap((d) => d.photoIds) : [];
  }
  try {
    const { readFile } = await import("node:fs/promises");
    const shard = JSON.parse(await readFile(dataFile(`photos/${pin.id}.json`), "utf-8")) as {
      photos: Record<string, unknown>;
    };
    return Object.keys(shard.photos);
  } catch {
    return [];
  }
}

/**
 * Files that eviction must not touch, because the user pinned them.
 *
 * Computed from the pins rather than stored, so unpinning takes effect on the
 * next eviction with nothing to clean up.
 */
export async function protectedPaths(): Promise<Set<string>> {
  const index = await readLocalIndex();
  if (!index) return new Set();
  const out = new Set<string>();
  for (const pin of await pins()) {
    for (const id of await pinnedPhotoIds(pin, index)) {
      out.add(pathFor("large", id));
      if (pin.originals) out.add(pathFor("full", id));
    }
  }
  return out;
}

export type ConflictChoice = "upload-mine" | "replace-mine";

export interface SyncOptions {
  /** Report status only; download nothing. Used by the launch check. */
  checkOnly?: boolean;
  /** How to settle a conflict. Absent means stop and ask. */
  resolve?: ConflictChoice;
}

export interface SyncResult extends Record<string, number> {
  metadataPulled: number;
  mediaFetched: number;
  alreadyLocal: number;
}

/**
 * `fetchAndCache` lives in serve.ts, which owns the in-flight dedupe map. The
 * job takes it as a parameter rather than importing it, so that a warm started
 * by scrolling and one started by sync collapse into a single Graph call.
 */
export type FetchImage = (size: ThumbSize, itemId: string) => Promise<Buffer | null>;

export async function runSync(
  opts: SyncOptions,
  onProgress: ProgressFn,
  signal: AbortSignal | undefined,
  fetchImage: FetchImage,
): Promise<SyncResult> {
  const result: SyncResult = { metadataPulled: 0, mediaFetched: 0, alreadyLocal: 0 };

  onProgress({ phase: "checking", message: "Checking OneDrive..." });
  const status = await checkSync();
  onProgress({ message: `Status: ${status.state}` });

  if (opts.checkOnly) return result;

  if (status.state === "conflict" && !opts.resolve) {
    throw new Error(
      "Both this device and OneDrive changed since the last sync. Choose whether to " +
        "upload this device's copy or replace it with OneDrive's.",
    );
  }

  const shouldPull =
    status.state === "behind" || (status.state === "conflict" && opts.resolve === "replace-mine");

  if (shouldPull) {
    // The lock covers only this phase. It writes data/, so a CLI run must not
    // be mid-write — but holding it through media warming would block the CLI
    // for minutes over work that only touches the cache.
    await withArchiveLock("sync (metadata)", async () => {
      onProgress({ phase: "pulling", message: "Downloading archive metadata..." });
      const token = await getCachedAccessToken();
      if (!token) throw new Error("Not signed in");

      const index = await downloadMetadataJson<ArchiveIndexFile>(token, env.metadataFolder, INDEX_FILE);
      if (!index) throw new Error("No index.json in OneDrive");

      const { mkdir, writeFile } = await import("node:fs/promises");
      const { dataDir } = await import("../paths.js");
      await mkdir(dataDir(), { recursive: true });
      await writeFile(dataFile(INDEX_FILE), JSON.stringify(index, null, 2), "utf-8");
      result.metadataPulled++;

      // Shards follow the index: only the months it names can be reached.
      await mkdir(dataFile("photos"), { recursive: true });
      for (const [i, month] of index.months.entries()) {
        if (signal?.aborted) return;
        const shard = await downloadMetadataJson(token, env.metadataFolder, `photos/${month.month}.json`);
        if (!shard) continue;
        await writeFile(dataFile(`photos/${month.month}.json`), JSON.stringify(shard, null, 2), "utf-8");
        result.metadataPulled++;
        onProgress({ done: i + 1, total: index.months.length, message: `Pulled ${month.month}` });
      }

      // Text in a second language (jobs/translate.ts). Each language's index
      // file names the months that have caption files, so only those are
      // asked for — not a round trip per month for files that do not exist.
      const { CONTENT_LANGUAGES } = await import("@travel-archive/shared");
      for (const lang of CONTENT_LANGUAGES) {
        if (signal?.aborted) return;
        const text = await downloadMetadataJson<{ parts?: string[] }>(token, env.metadataFolder, `i18n/${lang}/index.json`);
        if (!text) continue;
        await mkdir(dataFile(`i18n/${lang}/photos`), { recursive: true });
        await writeFile(dataFile(`i18n/${lang}/index.json`), JSON.stringify(text, null, 2), "utf-8");
        result.metadataPulled++;
        for (const month of text.parts ?? []) {
          const part = await downloadMetadataJson(token, env.metadataFolder, `i18n/${lang}/photos/${month}.json`);
          if (!part) continue;
          await writeFile(dataFile(`i18n/${lang}/photos/${month}.json`), JSON.stringify(part, null, 2), "utf-8");
          result.metadataPulled++;
        }
      }

      const remote = await fetchItemMeta(token, env.metadataFolder, INDEX_FILE);
      await markSynced(remote?.eTag ?? null);
    });
  }

  if (status.state === "ahead" || (status.state === "conflict" && opts.resolve === "upload-mine")) {
    // Uploading is what saveIndex already does on every write, so the replica
    // being ahead means a previous upload failed. Re-running the archive's own
    // save path is deliberate: it is the one place that knows how to write.
    onProgress({ phase: "pushing", message: "Uploading this device's copy..." });
    const token = await getCachedAccessToken();
    const local = await readLocalIndex();
    if (token && local) {
      const { uploadMetadataJson } = await import("../graph.js");
      const etag = await uploadMetadataJson(token, env.metadataFolder, INDEX_FILE, local);
      await markSynced(etag);
    }
  }

  // Pinned media, last and outside the lock.
  const index = await readLocalIndex();
  if (index) {
    const wanted: { size: ThumbSize; id: string }[] = [];
    for (const pin of await pins()) {
      for (const id of await pinnedPhotoIds(pin, index)) {
        wanted.push({ size: "large", id });
        if (pin.originals) wanted.push({ size: "full", id });
      }
    }

    const missing: typeof wanted = [];
    for (const w of wanted) {
      if ((await thumbSize(w.size, w.id)) === null) missing.push(w);
      else result.alreadyLocal++;
    }

    if (missing.length > 0) {
      onProgress({ phase: "media", done: 0, total: missing.length, message: `Fetching ${missing.length} pinned photo(s)...` });
      let next = 0;
      let done = 0;
      const worker = async () => {
        while (next < missing.length && !signal?.aborted) {
          const w = missing[next++];
          await fetchImage(w.size, w.id).catch(() => null);
          result.mediaFetched++;
          if (++done % 25 === 0) onProgress({ done, total: missing.length });
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, missing.length) }, worker));
    }
  }

  onProgress({ phase: "done", message: "Sync complete." });
  return result;
}

export type { SyncState };
