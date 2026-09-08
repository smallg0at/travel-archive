import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dataFile } from "./paths.js";
import { dirname } from "node:path";
import type { ArchiveIndexFile, PhotoShard } from "@travel-archive/shared";
import { SCHEMA_VERSION } from "@travel-archive/shared";
import { downloadMetadataJson, uploadMetadataJson } from "./graph.js";
import { env } from "./env.js";
import { markDirty, markSynced } from "./syncStore.js";

/**
 * The archive is split across files rather than kept in one archive.json:
 *
 *   index.json            nav + day structure only, no PhotoRecords (small)
 *   photos/<yyyy-mm>.json every PhotoRecord for that month
 *
 * At 10k photos a single archive.json runs ~7MB minified, and every run that
 * added a handful of photos re-uploaded all of it — plus the app had to pull
 * the whole thing before it could paint anything. Sharding by month means a
 * scan touches only the months it actually saw, and the app fetches one
 * ~200-400KB shard when you open a tab.
 */

const INDEX_FILE = "index.json";
const shardFile = (month: string) => `photos/${month}.json`;

function emptyIndex(): ArchiveIndexFile {
  return { schemaVersion: SCHEMA_VERSION, generatedAt: new Date().toISOString(), months: [], sections: [] };
}

/** Mirrors everything written to OneDrive under pipeline/data/, pretty-printed for reading. */
async function writeLocal(fileName: string, data: unknown): Promise<void> {
  const localPath = dataFile(fileName);
  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Brings an older index forward rather than making the user delete their
 * metadata to recover from a version bump.
 *
 * Every field added since v2 is either derived (recomputed by `scan` from the
 * shards) or defaulted, so migration is just filling in placeholders. Counts
 * for months this run doesn't rescan stay approximate until it next covers
 * them — harmless, since they only drive display and cost estimates. Shard
 * records need no migration at all: `scan`'s `merge()` already rebuilds each
 * record from fresh Graph data while preserving prior AI output.
 */
function migrate(index: ArchiveIndexFile): ArchiveIndexFile {
  return {
    ...index,
    schemaVersion: SCHEMA_VERSION,
    months: index.months.map((month) => ({
      ...month,
      representativeCount: month.representativeCount ?? month.photoCount,
    })),
  };
}

export async function loadIndex(token: string): Promise<ArchiveIndexFile> {
  const existing = await downloadMetadataJson<ArchiveIndexFile>(token, env.metadataFolder, INDEX_FILE);
  if (!existing) return emptyIndex();

  if (existing.schemaVersion > SCHEMA_VERSION) {
    throw new Error(
      `${env.metadataFolder}/${INDEX_FILE} is schema v${existing.schemaVersion}, newer than this build's v${SCHEMA_VERSION}. ` +
        `Update the pipeline rather than downgrading the archive.`,
    );
  }
  if (existing.schemaVersion < SCHEMA_VERSION) {
    console.log(`Migrating index from schema v${existing.schemaVersion} to v${SCHEMA_VERSION}...`);
    return migrate(existing);
  }
  return existing;
}

export async function saveIndex(token: string, index: ArchiveIndexFile): Promise<void> {
  index.schemaVersion = SCHEMA_VERSION;
  index.generatedAt = new Date().toISOString();
  await writeLocal(INDEX_FILE, index);
  // Local first, then upload, then record. If the upload throws, `dirty` is
  // left set and the next sync knows the replica holds something OneDrive does
  // not — which is the whole reason the flag exists, since writes normally
  // upload immediately and nothing would otherwise be out of step.
  await markDirty();
  const etag = await uploadMetadataJson(token, env.metadataFolder, INDEX_FILE, index);
  await markSynced(etag);
}

/** One month's photo records. Returns an empty shard if that month has never been scanned. */
export async function loadShard(token: string, month: string): Promise<PhotoShard> {
  const existing = await downloadMetadataJson<PhotoShard>(token, env.metadataFolder, shardFile(month));
  return existing ?? { month, generatedAt: new Date().toISOString(), photos: {} };
}

export async function saveShard(token: string, shard: PhotoShard): Promise<void> {
  shard.generatedAt = new Date().toISOString();
  await writeLocal(shardFile(shard.month), shard);
  await uploadMetadataJson(token, env.metadataFolder, shardFile(shard.month), shard);
}

/**
 * A metadata file from the local mirror, or null when it is not there.
 *
 * `saveIndex` and `saveShard` write local first and upload second, so anything
 * this machine has written is here — the same guarantee `/archive/index` in
 * serve.ts already relies on to serve the app. Used only on **read-only**
 * paths: a write path must keep going through Graph, because a mirror made
 * stale by a run on another machine would otherwise be merged onto and
 * uploaded over the newer copy.
 */
async function readLocal<T>(fileName: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(dataFile(fileName), "utf-8")) as T;
  } catch {
    return null;
  }
}

/** Read-only shard load: the mirror if it has it, Graph if not. */
export async function loadShardForReading(token: string, month: string): Promise<PhotoShard> {
  const local = await readLocal<PhotoShard>(shardFile(month));
  return local ?? (await loadShard(token, month));
}

/** Read-only index load: the mirror if it has it, Graph if not. */
export async function loadIndexForReading(token: string): Promise<ArchiveIndexFile> {
  const local = await readLocal<ArchiveIndexFile>(INDEX_FILE);
  return local ?? (await loadIndex(token));
}

/**
 * Every shard named in the index, loaded at once. Only for whole-archive
 * passes (organize) — the whole point of sharding is that scan and analyze
 * don't need this.
 *
 * **From the mirror, and in parallel.** This used to download all of them from
 * OneDrive one at a time: at 123 months that is 123 sequential round trips
 * before the pass could begin, which is what "Loading 123 month shard(s)..."
 * sat on for over a minute. Reading a shard locally is a few milliseconds
 * against ~650ms over the network.
 *
 * The count itself is not reducible: `organize` rebuilds `index.sections` from
 * the full set of days, so loading only the months in `--only` would drop every
 * other month's day pages from the index.
 */
const SHARD_READ_CONCURRENCY = 8;

export async function loadAllShards(token: string, index: ArchiveIndexFile): Promise<Map<string, PhotoShard>> {
  const shards = new Map<string, PhotoShard>();
  const months = index.months.map((m) => m.month);
  let next = 0;
  const worker = async () => {
    while (next < months.length) {
      const month = months[next++];
      shards.set(month, await loadShardForReading(token, month));
    }
  };
  await Promise.all(Array.from({ length: Math.min(SHARD_READ_CONCURRENCY, months.length) }, worker));
  return shards;
}
