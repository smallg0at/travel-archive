import type { ArchiveIndexFile, PhotoShard, SearchIndexFile } from "@travel-archive/shared";
import { SCHEMA_VERSION } from "@travel-archive/shared";
import { getAccessToken } from "./msAuth";
import { localArchiveJson } from "./backend";
import type { TranslationFile } from "@travel-archive/shared";
import { contentLanguage, translatedMonths, useIndexTranslations, useMonthTranslations } from "./contentLang";

/**
 * Archive metadata is read straight from OneDrive at runtime, not bundled.
 *
 * The app already holds a Files.Read token to fetch photo bytes, so the
 * index and shards ride the same mechanism — which means a pipeline run
 * shows up in the app immediately, with no rebuild and no `cap sync`. It
 * also keeps the app bundle flat: only the month you actually open gets
 * downloaded, rather than a single multi-megabyte archive.json shipping
 * inside the binary.
 */

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const METADATA_FOLDER = import.meta.env.VITE_ONEDRIVE_METADATA_FOLDER || "Apps/DayArchive";

export class SignInRequiredError extends Error {
  constructor() {
    super("SIGN_IN_REQUIRED");
  }
}

const MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 5000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Graph throttles this app in normal use — browsing a large month issues
 * enough thumbnail lookups to earn a 429, and the penalty applies to the
 * whole app, metadata reads included. So an index or shard fetch that lands
 * during a penalty window has to wait it out rather than surfacing "failed to
 * load archive" over what is really just backpressure.
 */
async function fetchMetadataJson<T>(fileName: string, localPath: string): Promise<T | null> {
  // The local server keeps a byte-identical mirror of everything the pipeline
  // writes, so ask it first. `index.json` is 2.4MB and blocks the whole render
  // — the months a trip spans are unknown until it arrives — and over Graph it
  // measured between 1,237ms and 3,289ms against a few ms from disk.
  //
  // Tried before the health check rather than after, because loadIndex runs
  // first: an absent server refuses the connection immediately, which is the
  // phone's normal path and costs nothing.
  const local = await localArchiveJson<T>(localPath);
  if (local) return local;

  const path = encodeURI(`${METADATA_FOLDER}/${fileName}`);

  for (let attempt = 1; ; attempt++) {
    let token: string;
    try {
      token = await getAccessToken();
    } catch {
      throw new SignInRequiredError();
    }

    const res = await fetch(`${GRAPH_BASE}/me/drive/root:/${path}:/content`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 404) return null;
    if (res.ok) return (await res.json()) as T;

    if ((res.status === 429 || res.status === 503) && attempt < MAX_ATTEMPTS) {
      const after = Number(res.headers.get("Retry-After"));
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : DEFAULT_BACKOFF_MS * attempt);
      continue;
    }
    throw new Error(`Failed to load ${fileName}: ${res.status} ${res.statusText}`);
  }
}

export async function loadIndex(): Promise<ArchiveIndexFile> {
  const index = await fetchMetadataJson<ArchiveIndexFile>("index.json", "index");
  if (!index) {
    throw new Error(
      `No index.json in OneDrive:/${METADATA_FOLDER}. Run "npm run --workspace pipeline scan" to build it.`,
    );
  }
  if (index.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `Archive is schema v${index.schemaVersion} but this app expects v${SCHEMA_VERSION}. Re-run the pipeline.`,
    );
  }
  return index;
}

// Shards are held for the session so flipping back to a month tab is
// instant. They're a few hundred KB each; a browsing session touches a
// handful, so there's no need for eviction at this scale.
const shardCache = new Map<string, Promise<PhotoShard>>();

/**
 * Drops cached months so the next read sees what the server just wrote.
 *
 * The cache is what makes flipping between month tabs instant, and it is also
 * why a change written through the server does not show: reloading re-fetches
 * `index.json`, but a photo record lives in its month *shard*, which is still
 * the copy held from earlier in the session. Correcting a photo's time and
 * watching the old time stay put is that cache, not a failed write.
 *
 * Called with the months a write actually touched, rather than clearing the
 * lot, so a correction in one month does not throw away every other month a
 * long browsing session has loaded.
 */
export function forgetAllMonths(): void {
  shardCache.clear();
  translationCache.clear();
}

/**
 * Drops these months' cached shards. `forgetAllMonths` above is the same for a
 * job that does not report which months it touched — a batch collect writes
 * captions into thirty at once, and without this the reload after it fetched a
 * fresh index but kept serving the uncaptioned shards until a page refresh.
 */
export function forgetMonths(months: string[]): void {
  for (const month of months) {
    shardCache.delete(month);
    translationCache.delete(month);
  }
}

/**
 * The archive's searchable text (see pipeline/src/jobs/searchIndex.ts).
 *
 * ~5MB for 27,000 photos, fetched once and kept for the session: search is
 * typed at, and a fetch per keystroke — or even per visit — would make it
 * useless. Null when the archive has never been organized, which is not an
 * error: the search view says so rather than throwing.
 */
let searchIndex: Promise<SearchIndexFile | null> | null = null;

export function loadSearchIndex(): Promise<SearchIndexFile | null> {
  searchIndex ??= fetchMetadataJson<SearchIndexFile>("search.json", "search").catch(() => null);
  return searchIndex;
}

/** After a job that rewrote captions or summaries. */
export function forgetSearchIndex(): void {
  searchIndex = null;
}

/**
 * The second language's day and trip text, when the reader has chosen one.
 *
 * Loaded beside `index.json`, and again on every reload of it: a translate run
 * ends in exactly that reload, and the month caption files are dropped with it
 * so they are fetched fresh too. Missing is fine — the page shows the original.
 */
export async function loadContentTranslations(): Promise<void> {
  translationCache.clear();
  const lang = contentLanguage();
  if (lang === "en") {
    useIndexTranslations(null);
    return;
  }
  const file = await fetchMetadataJson<TranslationFile>(`i18n/${lang}/index.json`, `i18n/${lang}/index`).catch(
    () => null,
  );
  useIndexTranslations(file);
}

const translationCache = new Map<string, Promise<void>>();

/**
 * A month's captions in the reader's language. Only for months the language's
 * index lists: asking for the others would fall through to OneDrive for a file
 * that does not exist, once per month opened.
 */
function loadMonthTranslations(month: string): Promise<void> {
  const lang = contentLanguage();
  if (lang === "en" || !translatedMonths().includes(month)) return Promise.resolve();
  const cached = translationCache.get(month);
  if (cached) return cached;
  const pending = fetchMetadataJson<TranslationFile>(`i18n/${lang}/photos/${month}.json`, `i18n/${lang}/shard/${month}`)
    .then((file) => useMonthTranslations(month, file))
    .catch(() => {
      // Untranslated captions are a fine fallback; try again next time.
      translationCache.delete(month);
    });
  translationCache.set(month, pending);
  return pending;
}

/** A month's photos, with their captions in the reader's language when there are any. */
export function loadMonth(month: string): Promise<PhotoShard> {
  return Promise.all([loadShardFile(month), loadMonthTranslations(month)]).then(([shard]) => shard);
}

function loadShardFile(month: string): Promise<PhotoShard> {
  const cached = shardCache.get(month);
  if (cached) return cached;

  const pending = fetchMetadataJson<PhotoShard>(`photos/${month}.json`, `shard/${month}`).then(
    (shard) => shard ?? { month, generatedAt: "", photos: {} },
  );
  // Don't cache a rejection — a shard that failed because the token had
  // expired should be retried after the user signs back in.
  pending.catch(() => shardCache.delete(month));
  shardCache.set(month, pending);
  return pending;
}
