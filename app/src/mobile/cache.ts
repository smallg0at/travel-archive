import type { ArchiveIndexFile, HomeIndexFile, PhotoShard, TranslationFile } from "@travel-archive/shared";
import { loadHomeIndex, loadMonth } from "../archiveData";
import { SCHEMA_VERSION } from "@travel-archive/shared";
import { getAccessToken } from "../msAuth";
import { rememberPhotos } from "./devicePhotos";
import { contentLanguage, useIndexTranslations } from "../contentLang";

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
 * A month's photos, from OneDrive when it can be reached and from the copy
 * kept last time when it cannot — so a day or month already opened on this
 * phone can be read again offline. The thumbnails behind it are already kept
 * (thumbCache.ts); without this the pictures were on the phone and the page
 * that shows them was not.
 *
 * Network first, unlike the index: a shard is small enough to fetch whenever
 * it is opened, so there is no eTag to compare and nothing can go stale while
 * online. Any failure falls back, a sign-in failure included — offline, the
 * token cannot be renewed either, and that is not a reason to show nothing.
 * The Chinese captions `loadMonth` fetches alongside are not kept; offline, a
 * kept month reads in the language it was written in.
 */
export async function loadMonthKept(month: string): Promise<PhotoShard> {
  const key = `photos/${month}`;
  try {
    const shard = await loadMonth(month);
    // Only a real one: a month with no file comes back as an empty placeholder
    // (no generatedAt), and keeping it would overwrite a good kept copy with
    // nothing.
    if (shard.generatedAt) void run("readwrite", (s) => s.put(shard, key)).catch(() => {});
    rememberPhotos(Object.values(shard.photos));
    return shard;
  } catch (err) {
    const kept = await run<PhotoShard | undefined>("readonly", (s) => s.get(key)).catch(() => undefined);
    if (kept) {
      rememberPhotos(Object.values(kept.photos));
      return kept;
    }
    throw err;
  }
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
 * The reader's language for the archive's own words — trip names, places, day
 * summaries — applied from the copy kept last time when OneDrive cannot be
 * reached.
 *
 * Without this, a phone opening offline read half in Chinese: the interface
 * is compiled into the app and the archive's text is not, so the buttons
 * translated and the trips did not. Month captions still need the network
 * (see `loadMonthKept`); this is the index, which is what every list, heading
 * and card is drawn from.
 */
export async function applyTranslationsKept(): Promise<void> {
  const lang = contentLanguage();
  if (lang === "en") {
    useIndexTranslations(null);
    return;
  }
  const key = `i18n/${lang}/index.json`;
  let file = await graphJson<TranslationFile>(key).catch(() => null);
  if (file) void run("readwrite", (s) => s.put(file, key)).catch(() => {});
  else file = (await run<TranslationFile | undefined>("readonly", (s) => s.get(key)).catch(() => undefined)) ?? null;
  useIndexTranslations(file);
}
