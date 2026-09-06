import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ArchiveIndexFile, PhotoShard } from "@travel-archive/shared";
import { SCHEMA_VERSION } from "@travel-archive/shared";
import { downloadMetadataJson, uploadMetadataJson } from "./graph.js";
import { env } from "./env.js";

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
  const localPath = `data/${fileName}`;
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
  await uploadMetadataJson(token, env.metadataFolder, INDEX_FILE, index);
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
 * Every shard named in the index, loaded at once. Only for whole-archive
 * passes (organize) — the whole point of sharding is that scan and analyze
 * don't need this.
 */
export async function loadAllShards(token: string, index: ArchiveIndexFile): Promise<Map<string, PhotoShard>> {
  const shards = new Map<string, PhotoShard>();
  for (const summary of index.months) {
    shards.set(summary.month, await loadShard(token, summary.month));
  }
  return shards;
}
