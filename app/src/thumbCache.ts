/**
 * A dedicated, persistent thumbnail store — deliberately not the browser's
 * HTTP cache.
 *
 * Graph hands back short-lived pre-authenticated CDN links for thumbnails
 * (~1 hour), and issues a *different* URL each time you ask. That makes HTTP
 * caching useless across sessions: the URL is never the same twice, so every
 * reload refetches every thumbnail. Keying our own store on the OneDrive item
 * id instead means a month you've already browsed comes back from local disk,
 * offline, however long ago you last opened it.
 *
 * IndexedDB rather than the Cache API because thumbnails need a size cap —
 * ~12KB each puts the full 18k-photo library around 220MB, which is fine on
 * desktop but past what iOS WebKit will hold onto (~1GB/origin, evicted after
 * ~7 days unused). IndexedDB lets us store `bytes` and `lastUsed` alongside
 * each blob and run a real LRU; the Cache API gives no accounting to evict by.
 */

const DB_NAME = "photo-archive-thumbs";
const STORE = "thumbs";

/**
 * Evict down to EVICT_TARGET once past this. Grid thumbnails are Graph's
 * `large` size, measured at ~30-85KB each (a `medium` would be a tenth of
 * that but is too small to render crisply — see album.ts), so this holds
 * roughly 7,000 of them: several months of browsing before anything is
 * dropped, and re-fetching an evicted month costs bandwidth, not correctness.
 */
const MAX_BYTES = 400 * 1024 * 1024;
const EVICT_TARGET = 0.8;
/** Checking the total on every write would serialize eviction against loading. */
const WRITES_BETWEEN_EVICTION_CHECKS = 50;

interface ThumbRecord {
  key: string;
  blob: Blob;
  bytes: number;
  lastUsed: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** Opens at an explicit version, or at whatever version currently exists. */
function openAt(version?: number): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
    } catch {
      // Private browsing / storage disabled. Callers degrade to network-only.
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("lastUsed", "lastUsed");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

/**
 * Opens the store, repairing it if the database exists but the object store
 * doesn't.
 *
 * That state is reachable and was hit in practice: `indexedDB.open(name)` with
 * no version argument creates a missing database at version 1 with *no* object
 * stores. Any later open pinned to version 1 then finds the versions already
 * equal, never fires `onupgradeneeded`, and every transaction throws
 * `NotFoundError: One of the specified object stores was not found` — forever,
 * until the user clears site data by hand.
 *
 * So rather than pinning a version, open at whatever exists and check for the
 * store; if it's absent, reopen one version higher to force `onupgradeneeded`.
 * That both creates the store on a fresh install and repairs a database left
 * empty by something else. (A future schema change needs a migration check
 * here rather than a version bump.)
 */
function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;

  dbPromise = (async () => {
    const existing = await openAt();
    if (!existing) return null;
    if (existing.objectStoreNames.contains(STORE)) return existing;

    const nextVersion = existing.version + 1;
    existing.close();

    const upgraded = await openAt(nextVersion);
    if (!upgraded) return null;
    return upgraded.objectStoreNames.contains(STORE) ? upgraded : null;
  })();
  return dbPromise;
}

function promisify<T>(request: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

// Live object URLs, so the same thumbnail scrolled past twice doesn't mint a
// second one. Released wholesale when the view changes — see releaseObjectUrls.
const liveUrls = new Map<string, string>();

let totalBytes: number | null = null;
let writesSinceCheck = 0;

async function computeTotalBytes(db: IDBDatabase): Promise<number> {
  return new Promise((resolve) => {
    let sum = 0;
    let cursor: IDBRequest<IDBCursorWithValue | null>;
    try {
      cursor = db.transaction(STORE, "readonly").objectStore(STORE).openCursor();
    } catch {
      resolve(0);
      return;
    }
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return resolve(sum);
      sum += (c.value as ThumbRecord).bytes;
      c.continue();
    };
    cursor.onerror = () => resolve(sum);
  });
}

/** Drops least-recently-used entries until the store is back under the target. */
async function evictIfNeeded(db: IDBDatabase): Promise<void> {
  if (totalBytes === null) totalBytes = await computeTotalBytes(db);
  if (totalBytes <= MAX_BYTES) return;

  const target = MAX_BYTES * EVICT_TARGET;
  await new Promise<void>((resolve) => {
    let tx: IDBTransaction;
    let cursor: IDBRequest<IDBCursorWithValue | null>;
    try {
      tx = db.transaction(STORE, "readwrite");
      cursor = tx.objectStore(STORE).index("lastUsed").openCursor();
    } catch {
      resolve();
      return;
    }
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c || (totalBytes ?? 0) <= target) return resolve();
      totalBytes = (totalBytes ?? 0) - (c.value as ThumbRecord).bytes;
      c.delete();
      c.continue();
    };
    cursor.onerror = () => resolve();
    tx.oncomplete = () => resolve();
  });
}

/** An object URL for a cached thumbnail, or null if it isn't stored yet. */
export async function getCached(key: string): Promise<string | null> {
  const live = liveUrls.get(key);
  if (live) return live;

  const db = await openDb();
  if (!db) return null;

  // Every transaction() is guarded: the store can vanish under us mid-session
  // (eviction, another tab deleting the database), and a cache miss must
  // degrade to a network fetch rather than reject the image load.
  let record: ThumbRecord | null;
  try {
    record = await promisify<ThumbRecord>(
      db.transaction(STORE, "readonly").objectStore(STORE).get(key) as IDBRequest<ThumbRecord>,
    );
  } catch {
    return null;
  }
  if (!record) return null;

  // Touch for LRU. Fire-and-forget: a lost timestamp update only costs
  // accuracy in eviction ordering, and blocking the image on it would be
  // worse than that.
  try {
    db.transaction(STORE, "readwrite").objectStore(STORE).put({ ...record, lastUsed: Date.now() });
  } catch {
    /* store may be mid-eviction; ignore */
  }

  const url = URL.createObjectURL(record.blob);
  liveUrls.set(key, url);
  return url;
}

/**
 * Stored byte size for each key, for keys that are cached. Missing keys are
 * simply absent from the map.
 *
 * Read in one transaction rather than one per key — the print pass needs sizes
 * for well over a thousand images at once, and that costs ~60ms in a single
 * cursor pass. Sizes only, never blobs: the caller wants to compare against
 * what it just encoded, not to decode anything.
 */
export async function cachedSizes(keys: string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  const db = await openDb();
  if (!db) return sizes;

  const wanted = new Set(keys);
  try {
    const store = db.transaction(STORE, "readonly").objectStore(STORE);
    await Promise.all(
      [...wanted].map(async (key) => {
        const record = await promisify<ThumbRecord>(store.get(key) as IDBRequest<ThumbRecord>);
        if (record) sizes.set(key, record.bytes);
      }),
    );
  } catch {
    // Same contract as getCached: a vanished store degrades to "unknown",
    // which the caller treats as "no opinion", not as zero.
  }
  return sizes;
}

/** Stores freshly-fetched bytes and returns an object URL for them. */
export async function putThumb(key: string, blob: Blob): Promise<string> {
  const url = URL.createObjectURL(blob);
  liveUrls.set(key, url);

  const db = await openDb();
  if (db) {
    const record: ThumbRecord = { key, blob, bytes: blob.size, lastUsed: Date.now() };
    try {
      db.transaction(STORE, "readwrite").objectStore(STORE).put(record);
      if (totalBytes !== null) totalBytes += blob.size;
      if (++writesSinceCheck >= WRITES_BETWEEN_EVICTION_CHECKS) {
        writesSinceCheck = 0;
        void evictIfNeeded(db);
      }
    } catch {
      // Quota exceeded or store unavailable — the object URL still works for
      // this session, it just won't survive a reload.
    }
  }
  return url;
}

/**
 * Revokes every object URL handed out so far. Called when the visible month
 * changes: a session that browsed a dozen months would otherwise pin every
 * thumbnail blob it had ever decoded. Re-reads come straight back from
 * IndexedDB, so this costs a local lookup, not a network fetch.
 */
export function releaseObjectUrls(): void {
  for (const url of liveUrls.values()) URL.revokeObjectURL(url);
  liveUrls.clear();
}

export async function cacheStats(): Promise<{ count: number; bytes: number }> {
  const db = await openDb();
  if (!db) return { count: 0, bytes: 0 };
  try {
    const count = (await promisify(db.transaction(STORE, "readonly").objectStore(STORE).count())) ?? 0;
    if (totalBytes === null) totalBytes = await computeTotalBytes(db);
    return { count, bytes: totalBytes };
  } catch {
    return { count: 0, bytes: 0 };
  }
}
