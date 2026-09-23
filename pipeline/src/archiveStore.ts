import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dataFile } from "./paths.js";
import { dirname } from "node:path";
import type { ArchiveIndexFile, HomeIndexFile, PhotoShard, SearchIndexFile, TranslationFile } from "@travel-archive/shared";
import { SCHEMA_VERSION } from "@travel-archive/shared";
import { downloadMetadataJson, fetchItemMeta, listFolderFileNames, uploadMetadataJson } from "./graph.js";
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
const SEARCH_FILE = "search.json";
const HOME_FILE = "home.json";
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

/** As writeLocal, without the indentation — for files that are read by machines only. */
async function writeLocalCompact(fileName: string, data: unknown): Promise<void> {
  const localPath = dataFile(fileName);
  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, JSON.stringify(data), "utf-8");
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

/**
 * The search index — derived data, so no dirty/synced bookkeeping: losing it
 * costs one rebuild, and marking the replica dirty for it would make every
 * collect look like an unsynced change. Returns the size written.
 */
export async function saveSearchIndex(token: string, file: SearchIndexFile): Promise<number> {
  await writeLocalCompact(SEARCH_FILE, file);
  await uploadMetadataJson(token, env.metadataFolder, SEARCH_FILE, file);
  return Buffer.byteLength(JSON.stringify(file));
}

/** The map index — derived data, same terms as the search index above. */
export async function saveHomeIndex(token: string, file: HomeIndexFile): Promise<number> {
  await writeLocalCompact(HOME_FILE, file);
  await uploadMetadataJson(token, env.metadataFolder, HOME_FILE, file);
  return Buffer.byteLength(JSON.stringify(file));
}

/**
 * A shard for a **write** path: the mirror when it is provably safe, Graph otherwise.
 *
 * `loadShard` downloads from OneDrive every time, which is the right default —
 * a mirror can be stale. But on a whole-library analyze, 913 photos spread over
 * 80 months cost 80 downloads *and* 80 uploads of shards holding one or two
 * changed photos, and that I/O dwarfs the model calls. This keeps the safety of
 * the Graph path while paying a fraction of it:
 *
 *   - no mirror copy, or no remote copy → Graph (nothing to trust);
 *   - remote `lastModifiedDateTime` **after** the mirror's own mtime → someone
 *     else wrote it, so Graph (this is the single-writer check that makes the
 *     shortcut safe);
 *   - otherwise the mirror is the newest copy and is used as-is.
 *
 * One small metadata request replaces one full download. Uploads still go to
 * Graph, so the remote stays authoritative.
 */
export async function loadShardForWriting(token: string, month: string): Promise<PhotoShard> {
  const local = await readLocal<PhotoShard>(shardFile(month));
  if (!local) return loadShard(token, month);

  const meta = await fetchItemMeta(token, env.metadataFolder, shardFile(month));
  // Gone from OneDrive, or never uploaded: the mirror is all there is.
  if (!meta) return local;

  const localMtime = await fileMtime(shardFile(month));
  const remote = meta.lastModifiedDateTime ? Date.parse(meta.lastModifiedDateTime) : 0;
  // Clock skew of a few seconds is normal; only a clear newer remote wins.
  if (!localMtime || remote > localMtime + 5000) return loadShard(token, month);
  return local;
}

/** The mirror file's own modification time, ms since epoch, or null when absent. */
async function fileMtime(fileName: string): Promise<number | null> {
  try {
    return (await stat(dataFile(fileName))).mtimeMs;
  } catch {
    return null;
  }
}

/** One month's photo records. Returns an empty shard if that month has never been scanned. */
export async function loadShard(token: string, month: string): Promise<PhotoShard> {
  const existing = await downloadMetadataJson<PhotoShard>(token, env.metadataFolder, shardFile(month));
  return existing ?? { month, generatedAt: new Date().toISOString(), photos: {} };
}

/**
 * One month's records, to the mirror and then OneDrive.
 *
 * `upload: false` writes the mirror and stops. `scan` uses it for a month whose
 * records came back identical: a full re-scan changes nothing in most months,
 * yet re-uploaded every shard — 143 of them — which is what made the write
 * phase of a whole-library scan crawl. The mirror is still refreshed, so the
 * read paths that trust it stay current.
 */
export async function saveShard(token: string, shard: PhotoShard, opts: { upload?: boolean } = {}): Promise<void> {
  shard.generatedAt = new Date().toISOString();
  await writeLocal(shardFile(shard.month), shard);
  if (opts.upload === false) return;
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

/* --- Content in a second language (see TranslationFile) ------------------ */

/** `index` for day and trip text; otherwise a `yyyy-mm` month of captions. */
const translationFile = (lang: string, part: string) =>
  part === "index" ? `i18n/${lang}/index.json` : `i18n/${lang}/photos/${part}.json`;

export function emptyTranslations(lang: string, part: string): TranslationFile {
  const file: TranslationFile = { lang, sourceLang: "en", generatedAt: new Date().toISOString(), entries: {} };
  if (part === "index") {
    file.parts = [];
    file.owner = {};
  }
  return file;
}

/** For write paths: from Graph, like `loadShard`. Empty when the file does not exist yet. */
export async function loadTranslations(token: string, lang: string, part: string): Promise<TranslationFile> {
  const existing = await downloadMetadataJson<TranslationFile>(token, env.metadataFolder, translationFile(lang, part));
  return existing ?? emptyTranslations(lang, part);
}

/** The mirror's copy alone, or null — for a read that must not cost a round trip per file. */
export async function readTranslationsLocal(lang: string, part: string): Promise<TranslationFile | null> {
  return readLocal<TranslationFile>(translationFile(lang, part));
}

/** Read-only load: the mirror if it has it, Graph if not. */
export async function loadTranslationsForReading(token: string, lang: string, part: string): Promise<TranslationFile> {
  return (await readTranslationsLocal(lang, part)) ?? (await loadTranslations(token, lang, part));
}

/** Local first, then upload — the same order as `saveShard`, so the mirror is never behind OneDrive. */
export async function saveTranslations(token: string, lang: string, part: string, file: TranslationFile): Promise<void> {
  file.generatedAt = new Date().toISOString();
  await writeLocal(translationFile(lang, part), file);
  await uploadMetadataJson(token, env.metadataFolder, translationFile(lang, part), file);
}

/**
 * The months that actually have a caption file for `lang`, from OneDrive and
 * the mirror together.
 *
 * `TranslationFile.parts` was an accumulated list a translate run carried
 * forward and only ever appended to. A run that started from an index without
 * the list — an upload that failed, a mirror re-created from scratch — wrote a
 * *shorter* list, and the months it dropped stopped loading in the app (118 of
 * 123 here; the app only fetches a month's captions when `parts` names it).
 * Deriving it from the files themselves is the only version that cannot lose
 * them.
 */
export async function translationParts(token: string, lang: string): Promise<string[]> {
  const months = new Set<string>();
  try {
    for (const name of await listFolderFileNames(token, `${env.metadataFolder}/i18n/${lang}/photos`)) {
      const match = /^(\d{4}-\d{2})\.json$/.exec(name);
      if (match) months.add(match[1]);
    }
  } catch {
    // OneDrive unreachable: the mirror below still answers.
  }
  try {
    for (const name of await readdir(dataFile(`i18n/${lang}/photos`))) {
      const match = /^(\d{4}-\d{2})\.json$/.exec(name);
      if (match) months.add(match[1]);
    }
  } catch {
    // No mirror folder yet.
  }
  return [...months].sort();
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
