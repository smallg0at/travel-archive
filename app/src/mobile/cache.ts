import type { ArchiveIndexFile, HomeIndexFile, PhotoShard, SearchIndexFile, TranslationFile } from "@travel-archive/shared";
import { loadHomeIndex, loadMonth } from "../archiveData";
import { SCHEMA_VERSION } from "@travel-archive/shared";
import { getAccessToken } from "../msAuth";
import { rememberPhotos } from "./devicePhotos";
import { contentLanguage, translatedMonths, useIndexTranslations, useMonthTranslations } from "../contentLang";

/**
 * The index, kept on the phone between launches.
 *
 * `index.json` is 3.7MB and nothing can be drawn until it has arrived — the
 * trips, the months and every day's photo ids are in it. Over Graph that
 * download measured 1,237–3,289ms on a desktop connection (TODO.md,
 * 2026-09-07); on mobile data it is the whole of the first impression, and it
 * was paid on every launch because nothing on the Graph path persisted.
 *
 * So the phone opens on the copy it kept last time, and then asks OneDrive
 * only for the file's eTag — a few hundred bytes — to learn whether that copy
 * is still current. When it is not, the new index is fetched in the
 * background and the reader is offered a refresh, rather than having the page
 * rebuilt under their thumb.
 *
 * Mobile-only, and deliberately outside archiveData.ts: the desktop reads the
 * local server's mirror in ~34ms and has no use for a second cache. Month
 * shards are kept here too — see `loadMonthKept` below.
 */

const DB_NAME = "m-archive";
const STORE = "files";
const INDEX_KEY = "index.json";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
// The same folder archiveData.ts reads from — it is an env setting there too.
const METADATA_FOLDER = import.meta.env.VITE_ONEDRIVE_METADATA_FOLDER || "Apps/DayArchive";

interface Kept {
  etag: string | null;
  index: ArchiveIndexFile;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = op(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/**
 * The kept index, or null — including when it was written by an older build
 * for an older schema, which must not be half-read any more than a fresh one.
 * Never throws: a phone with site storage blocked just starts cold.
 */
export async function keptIndex(): Promise<Kept | null> {
  try {
    const kept = await run<Kept | undefined>("readonly", (s) => s.get(INDEX_KEY));
    return kept && kept.index.schemaVersion === SCHEMA_VERSION ? kept : null;
  } catch {
    return null;
  }
}

export async function keepIndex(index: ArchiveIndexFile, etag: string | null): Promise<void> {
  try {
    await run("readwrite", (s) => s.put({ etag, index } satisfies Kept, INDEX_KEY));
  } catch {
    // Storage full or blocked: the next launch is simply a cold one.
  }
}

/**
 * The eTag OneDrive holds for `index.json` now, or null when it cannot be
 * asked — offline, or signed out. Null means "unknown", never "changed": the
 * caller keeps what it has.
 */
export async function currentEtag(): Promise<string | null> {
  try {
    const token = await getAccessToken();
    const path = encodeURI(`${METADATA_FOLDER}/${INDEX_KEY}`);
    const res = await fetch(`${GRAPH_BASE}/me/drive/root:/${path}?$select=eTag`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return ((await res.json()) as { eTag?: string }).eTag ?? null;
  } catch {
    return null;
  }
}

/* --- Month shards ------------------------------------------------------- */

/**
 * A kept shard and what it was when it was stored: the eTag OneDrive had for
 * it, so a later launch can tell whether it moved without downloading it
 * again, and its byte size for Settings.
 *
 * The eTag is written from the folder listing (`listRemoteShardEtags`) rather
 * than off the `/content` response: that response is served from a CDN and
 * carries the CDN's own validator, not OneDrive's item eTag.
 */
interface ShardMeta {
  month: string;
  etag: string | null;
  bytes: number;
  generatedAt: string;
}

const shardKey = (month: string) => `photos/${month}`;
const shardMetaKey = (month: string) => `meta/photos/${month}`;

async function readKeptShard(month: string): Promise<PhotoShard | null> {
  const kept = await run<PhotoShard | undefined>("readonly", (s) => s.get(shardKey(month))).catch(() => undefined);
  return kept ?? null;
}

/**
 * Every key under a prefix, in one range read. Used for the launch checks,
 * which would otherwise open a connection per month twice over.
 */
async function keysInRange(prefix: string): Promise<string[]> {
  const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
  const keys = await run<IDBValidKey[]>("readonly", (s) => s.getAllKeys(range)).catch(() => []);
  return (keys ?? []).map((key) => String(key));
}

/** Every value under a prefix, in one range read. */
async function recordsInRange<T>(prefix: string): Promise<T[]> {
  const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
  return (await run<T[]>("readonly", (s) => s.getAll(range)).catch(() => [])) ?? [];
}

async function writeShardMeta(month: string, meta: Omit<ShardMeta, "month">): Promise<void> {
  await run("readwrite", (s) => s.put({ ...meta, month }, shardMetaKey(month))).catch(() => {});
}

/**
 * Keeps a shard, with its size. `bytes` is passed when the raw text is already
 * in hand (the prefetch path); otherwise it is measured by serialising once,
 * which is cheap next to the fetch that just happened.
 */
async function writeKeptShard(month: string, shard: PhotoShard, etag: string | null, bytes?: number): Promise<number> {
  const size = bytes ?? JSON.stringify(shard).length;
  await run("readwrite", (s) => s.put(shard, shardKey(month))).catch(() => {});
  await writeShardMeta(month, { etag, bytes: size, generatedAt: shard.generatedAt });
  return size;
}

/** One month's photo records, straight from Graph, kept. Null on any failure. */
async function graphShard(month: string, etag: string | null, token: string): Promise<PhotoShard | null> {
  try {
    const path = encodeURI(`${METADATA_FOLDER}/photos/${month}.json`);
    const res = await fetch(`${GRAPH_BASE}/me/drive/root:/${path}:/content`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const text = await res.text();
    const shard = JSON.parse(text) as PhotoShard;
    await writeKeptShard(month, shard, etag, text.length);
    rememberPhotos(Object.values(shard.photos));
    return shard;
  } catch {
    return null;
  }
}

/**
 * A Graph access token, with a couple of retries.
 *
 * A silent renewal that failed on a flaky link or a throttled token endpoint
 * is exactly the transient case `TokenRenewalError` exists for, so it is worth
 * one or two more tries before a whole background pass gives up on it.
 * "SIGN_IN_REQUIRED" is not: no retry can produce an account that is not
 * signed in, and the caller has a banner for that.
 */
const TOKEN_ATTEMPTS = 3;

async function graphToken(): Promise<string> {
  let last: unknown;
  for (let attempt = 1; attempt <= TOKEN_ATTEMPTS; attempt++) {
    try {
      return await getAccessToken();
    } catch (err) {
      if ((err as Error)?.message === "SIGN_IN_REQUIRED") throw err;
      last = err;
      if (attempt < TOKEN_ATTEMPTS) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw last;
}

/** One item's eTag, without its bytes. Null when it cannot be asked. */
async function remoteShardEtag(month: string): Promise<string | null> {
  try {
    const token = await getAccessToken();
    const path = encodeURI(`${METADATA_FOLDER}/photos/${month}.json`);
    const res = await fetch(`${GRAPH_BASE}/me/drive/root:/${path}?$select=eTag`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return ((await res.json()) as { eTag?: string }).eTag ?? null;
  } catch {
    return null;
  }
}

/** A month's kept caption file in the reader's language, or null. */
async function readMonthTranslation(month: string): Promise<TranslationFile | null> {
  const lang = contentLanguage();
  if (lang === "en") return null;
  return (
    (await run<TranslationFile | undefined>("readonly", (s) => s.get(`i18n/${lang}/photos/${month}`)).catch(
      () => undefined,
    )) ?? null
  );
}

/**
 * A month's captions in the reader's language: the kept copy when there is one,
 * a fetch and a keep when there is not.
 *
 * The kept copy is what an offline month reads from; this is what fills it. It
 * runs whenever a month is opened rather than only in the background pass, so a
 * month opened by hand gets its captions even though the pass never reached it,
 * and a language chosen after the library was cached still reads in that
 * language — the pass skips a month whose shard is current, so it would never
 * have fetched the captions at all.
 */
async function ensureMonthTranslation(month: string): Promise<void> {
  const kept = await readMonthTranslation(month);
  if (kept) {
    useMonthTranslations(month, kept);
    return;
  }
  if (!translatedMonths().includes(month)) return;
  const token = await graphToken().catch(() => null);
  if (!token) return;
  const file = await fetchMonthTranslation(month, token);
  if (file) useMonthTranslations(month, file);
}

/**
 * A month's photos, from the copy kept last time when there is one, and from
 * OneDrive otherwise — so a month already opened (or prefetched) on this phone
 * opens at once, and works with no signal.
 *
 * Local first, unlike before: the copy is current as of the last background
 * check (`syncKeptShards`, run at launch), and serving it without a round trip
 * is the whole point of keeping it. A month with no kept copy goes to the
 * network, and a failure there is a real failure — there is nothing to fall
 * back to.
 *
 * The captions in the reader's language are ensured alongside: the kept copy
 * when there is one, a fetch and a keep when there is not.
 */
export async function loadMonthKept(month: string): Promise<PhotoShard> {
  const kept = await readKeptShard(month);
  if (kept) {
    await ensureMonthTranslation(month);
    rememberPhotos(Object.values(kept.photos));
    return kept;
  }

  const shard = await loadMonth(month);
  // Only a real one: a month with no file comes back as an empty placeholder
  // (no generatedAt), and keeping it would mean a permanent empty month.
  if (shard.generatedAt) {
    void writeKeptShard(month, shard, null).then(async (size) => {
      // Learn its eTag now so the next launch does not download it again just
      // to find out it never changed.
      const etag = await remoteShardEtag(month);
      if (etag) await writeShardMeta(month, { etag, bytes: size, generatedAt: shard.generatedAt });
    });
    // And the captions, which `loadMonth` fetched for this session only. Without
    // this the next open — the kept one, which is the normal one — reads
    // English.
    void ensureMonthTranslation(month);
  }
  rememberPhotos(Object.values(shard.photos));
  return shard;
}

/* --- What this phone has, and keeping the rest -------------------------- */

/** The months kept on this phone, ascending. */
export async function keptMonths(): Promise<string[]> {
  return (await keysInRange("photos/")).map((key) => key.slice("photos/".length)).sort();
}

/** How many months are kept, and roughly how many bytes of shard JSON. */
export async function keptStats(): Promise<{ months: number; bytes: number }> {
  const [months, metas] = await Promise.all([keptMonths(), recordsInRange<ShardMeta>("meta/photos/")]);
  return { months: months.length, bytes: metas.reduce((sum, meta) => sum + (meta.bytes ?? 0), 0) };
}

/**
 * Every shard's eTag, in one Graph listing of the `photos` folder.
 *
 * One request for the whole archive — 123 items fit a page or two — instead of
 * one per month. This is what tells a launch which kept months have moved
 * without downloading any of them, and it is free: a listing call, no bytes.
 * Null when the folder cannot be listed (offline, signed out).
 */
async function listShardEtags(token: string): Promise<Map<string, string> | null> {
  try {
    let url: string | undefined =
      `${GRAPH_BASE}/me/drive/root:/${encodeURI(`${METADATA_FOLDER}/photos`)}:/children?$top=200&$select=name,eTag`;
    const etags = new Map<string, string>();
    while (url) {
      const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return etags.size ? etags : null;
      const body = (await res.json()) as { value?: { name?: string; eTag?: string }[]; "@odata.nextLink"?: string };
      for (const item of body.value ?? []) {
        const match = /^(\d{4}-\d{2})\.json$/.exec(item.name ?? "");
        if (match && item.eTag) etags.set(match[1], item.eTag);
      }
      url = body["@odata.nextLink"];
    }
    return etags;
  } catch {
    return null;
  }
}

/**
 * Pulls the months whose eTag moved since this phone kept them, and only
 * those. One listing, then one download per changed month — the "if any shard
 * has changed, fetch it" half of the launch path.
 *
 * A month kept without a recorded eTag (stored on open, where there was no
 * listing in hand) counts as changed once and gets one extra download; after
 * that its eTag is recorded and it stays quiet.
 *
 * Returns the months that were replaced, so the caller can redraw a screen
 * showing one.
 */
export async function syncKeptShards(): Promise<string[]> {
  let token: string;
  try {
    token = await graphToken();
  } catch {
    return [];
  }
  const remote = await listShardEtags(token);
  if (!remote) return [];
  // Two range reads rather than two per month: what is held, and what eTag it
  // was stored under.
  const [heldKeys, metas] = await Promise.all([
    keysInRange("photos/"),
    recordsInRange<ShardMeta>("meta/photos/"),
  ]);
  const held = new Set(heldKeys.map((key) => key.slice("photos/".length)));
  const metaOf = new Map(metas.map((meta) => [meta.month, meta]));
  const changed: string[] = [];
  for (const [month, etag] of remote) {
    // Only months this phone already holds. A month never opened or
    // prefetched is left alone here — `cacheAllMonths` is what fills those,
    // and it is the one the reader can turn off. Otherwise every launch would
    // download the whole library behind a setting that says not to.
    if (!held.has(month)) continue;
    if (metaOf.get(month)?.etag === etag) continue;
    if (await graphShard(month, etag, token)) changed.push(month);
  }
  return changed;
}

/**
 * Downloads every month named, keeping it for offline use. Sequential on
 * purpose: one request at a time is gentle on a phone link and on Graph's
 * throttling, and it lets progress mean something.
 *
 * `shouldStop` is polled between months so a cancel takes effect after the
 * month in flight, never mid-write. A month already kept and unchanged is
 * skipped, so re-running this after an interrupted pass only pays for what is
 * missing.
 */
export interface CacheProgress {
  done: number;
  total: number;
  kept: number;
  failed: number;
  skipped: number;
}

export async function cacheAllMonths(
  months: string[],
  opts: { onProgress?: (p: CacheProgress) => void; shouldStop?: () => boolean } = {},
): Promise<CacheProgress> {
  const progress: CacheProgress = { done: 0, total: months.length, kept: 0, failed: 0, skipped: 0 };
  // The token once, for the whole pass: a silent renewal per month would be
  // 123 trips through MSAL for a credential that is valid for the hour this
  // takes, and the first failure would fail all 123 anyway.
  let token: string;
  try {
    token = await graphToken();
  } catch {
    progress.failed = months.length;
    return progress;
  }
  // No listing means no way to tell what is already current; downloading the
  // whole library to find out is exactly the cost this is meant to avoid.
  const remote = await listShardEtags(token);
  if (!remote) {
    progress.failed = months.length;
    return progress;
  }
  const metaOf = new Map((await recordsInRange<ShardMeta>("meta/photos/")).map((meta) => [meta.month, meta]));
  for (const month of months) {
    if (opts.shouldStop?.()) break;
    const etag = remote.get(month) ?? null;
    if (etag && metaOf.get(month)?.etag === etag) {
      progress.skipped++;
      progress.done++;
      opts.onProgress?.(progress);
      continue;
    }
    const shard = await graphShard(month, etag, token);
    if (shard) {
      progress.kept++;
      await fetchMonthTranslation(month, token);
    } else {
      progress.failed++;
    }
    progress.done++;
    opts.onProgress?.(progress);
  }
  return progress;
}

/** Fetches a month's caption file in the reader's language and keeps it. Null when there is none, or with no network. */
async function fetchMonthTranslation(month: string, token: string): Promise<TranslationFile | null> {
  const lang = contentLanguage();
  if (lang === "en") return null;
  try {
    const path = encodeURI(`${METADATA_FOLDER}/i18n/${lang}/photos/${month}.json`);
    const res = await fetch(`${GRAPH_BASE}/me/drive/root:/${path}:/content`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const file = (await res.json()) as TranslationFile;
    await run("readwrite", (s) => s.put(file, `i18n/${lang}/photos/${month}`)).catch(() => {});
    return file;
  } catch {
    // Captions fall back to English; the month's records are kept regardless.
    return null;
  }
}

/**
 * The index translations from the copy kept last time, with no network — the
 * part of the kept path that must not make the reader wait. `refreshTranslations`
 * follows in the background.
 */
export async function applyTranslationsKeptLocal(): Promise<void> {
  const lang = contentLanguage();
  if (lang === "en") {
    useIndexTranslations(null);
    return;
  }
  const file =
    (await run<TranslationFile | undefined>("readonly", (s) => s.get(`i18n/${lang}/index.json`)).catch(() => undefined)) ??
    null;
  useIndexTranslations(file);
}

/** Refetches the index translations, keeps them, and applies them. */
export async function refreshTranslations(): Promise<void> {
  const lang = contentLanguage();
  if (lang === "en") return;
  const file = await graphJson<TranslationFile>(`i18n/${lang}/index.json`).catch(() => null);
  if (!file) return;
  void run("readwrite", (s) => s.put(file, `i18n/${lang}/index.json`)).catch(() => {});
  useIndexTranslations(file);
}

/* --- The home index, and the reader's language -------------------------- */

/**
 * One metadata file from OneDrive, or null when it cannot be had. The same
 * request `currentEtag` makes, without archiveData's retries: these two
 * callers already fall back to a kept copy, so a retry would only make a
 * phone with no signal wait longer for the same answer.
 */
async function graphJson<T>(fileName: string): Promise<T | null> {
  const token = await getAccessToken();
  const path = encodeURI(`${METADATA_FOLDER}/${fileName}`);
  const res = await fetch(`${GRAPH_BASE}/me/drive/root:/${path}:/content`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok ? ((await res.json()) as T) : null;
}

/**
 * home.json, kept between launches like the shards are.
 *
 * The home page's map is drawn from its places, and the days out under the
 * trips from its excursions, so with no network the phone lost both: the map
 * section removed itself, because null there reads the same as "nothing has
 * been placed". The basemap behind it is bundled in the app, so the only
 * thing missing offline was this file.
 *
 * Network first, like a shard: it is ~100KB and changes whenever the library
 * is organized, so there is nothing to gain from serving a kept copy while
 * online.
 */
export async function loadHomeKept(): Promise<HomeIndexFile | null> {
  const key = "home.json";
  const home = await loadHomeIndex().catch(() => null);
  if (home) {
    void run("readwrite", (s) => s.put(home, key)).catch(() => {});
    return home;
  }
  return (await run<HomeIndexFile | undefined>("readonly", (s) => s.get(key)).catch(() => undefined)) ?? null;
}

/**
 * `search.json`, kept between launches like the shards.
 *
 * The file is ~6.5MB over Graph — the whole archive's searchable text — and
 * Search is a read, so a copy from last time answers the same question almost
 * always. Without this the phone downloaded it every time the Search tab was
 * opened, on mobile data, and could not search at all offline.
 *
 * Network first, because a summarize or analyze run rewrites it and the kept
 * copy would go stale; kept when the network has nothing, which is what makes
 * an offline phone able to search what it holds.
 */
/** This phone's copy of `search.json`, or null. */
async function readKeptSearch(): Promise<SearchIndexFile | null> {
  return (
    (await run<SearchIndexFile | undefined>("readonly", (s) => s.get("search.json")).catch(() => undefined)) ?? null
  );
}

export async function loadSearchKept(): Promise<SearchIndexFile | null> {
  let fresh: SearchIndexFile | null = null;
  let failure: unknown = null;
  try {
    fresh = await graphJson<SearchIndexFile>("search.json");
  } catch (err) {
    failure = err;
  }
  if (fresh) {
    const file = fresh;
    void run("readwrite", (s) => s.put(file, "search.json")).catch(() => {});
    return fresh;
  }
  const kept = await readKeptSearch();
  if (kept) return kept;
  // Nothing to read, so the reason is the only honest answer. Propagating *any*
  // failure here — not only "signed out" — is what lets the view distinguish
  // "try again in a moment" from "this archive has no search index".
  if (failure) throw failure;
  return null;
}

/**
 * Keeps `search.json` the moment a session makes it available.
 *
 * It was fetched only when the reader first opened Search, so a phone that had
 * never opened that tab had no copy — and every attempt afterwards, offline or
 * with a renewal failing, was told to sign in to a session it may well have
 * had. Runs in the background at launch and only when there is nothing to
 * read: one 6.5MB fetch for the life of an install, then Search's own load
 * keeps it fresh whenever it can.
 */
export async function ensureSearchKept(): Promise<void> {
  try {
    if (await readKeptSearch()) return;
  } catch {
    // Storage unreadable: the fetch below is harmless, and Search falls back
    // to whatever the network gives it.
  }
  await loadSearchKept().catch(() => {});
}

/**
 * Pulls any caption file in the reader's language this phone is missing.
 *
 * The background cache pass keeps a month's captions when it downloads the
 * month, which covers a fresh phone or a fresh language. It does not cover a
 * language chosen after the library was already cached: that pass skips every
 * month whose records are current, so it never looks at the captions at all.
 * This closes that gap — one range read to see what is missing, then one fetch
 * each, once.
 */
export async function fillMonthTranslations(): Promise<void> {
  const lang = contentLanguage();
  if (lang === "en") return;
  const months = translatedMonths();
  if (!months.length) return;
  const prefix = `i18n/${lang}/photos/`;
  const kept = new Set(await keysInRange(prefix));
  const missing = months.filter((month) => !kept.has(`${prefix}${month}`));
  if (!missing.length) return;
  const token = await graphToken().catch(() => null);
  if (!token) return;
  for (const month of missing) await fetchMonthTranslation(month, token);
}

/**
 * The reader's language for the archive's own words — trip names, places, day
 * summaries — applied from the copy kept last time when OneDrive cannot be
 * reached, refreshed from OneDrive, and then the month captions that are still
 * missing are fetched.
 *
 * Without this, a phone opening offline read half in Chinese: the interface
 * is compiled into the app and the archive's text is not, so the buttons
 * translated and the trips did not. Month captions are the other half — see
 * `fillMonthTranslations` — and the index has to be in hand first, because
 * `translatedMonths()` is what says which months even have a caption file.
 */
export async function applyTranslationsKept(): Promise<void> {
  await applyTranslationsKeptLocal();
  await refreshTranslations();
  await fillMonthTranslations();
}
