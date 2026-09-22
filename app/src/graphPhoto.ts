import { getAccessToken, TokenRenewalError } from "./msAuth";
import { getCached, putThumb, releaseObjectUrls } from "./thumbCache";
import { thumbnailSource } from "./photoSource";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/**
 * Thumbnail loading is batched, and deliberately does NOT fetch image bytes
 * through JS.
 *
 * The obvious implementation — fetch each thumbnail with an Authorization
 * header, turn the blob into an object URL — costs one authenticated
 * round-trip per photo and puts every one of them in a JS-controlled queue.
 * Measured on a 4,998-photo month that crawled: ~18 thumbnails visible after
 * 15 seconds. It also leaks, since object URLs are never revoked.
 *
 * Instead we ask Graph for the thumbnail's *URL* — `/thumbnails/0/medium`
 * without `/content` returns JSON containing a short-lived pre-authenticated
 * CDN link — and those lookups go through Graph's `$batch` endpoint, 20 per
 * HTTP request rather than one round trip each.
 *
 * Bytes then land in our own persistent store (thumbCache.ts) keyed on the
 * item id, because those CDN URLs expire in about an hour and differ every
 * time they're issued — so the browser's HTTP cache can never hit across
 * sessions. Anything already in that store skips the network entirely.
 */

const MAX_BATCH = 20; // Graph's per-$batch request limit.
const BATCH_DELAY_MS = 40; // Long enough for a scroll burst to coalesce.
const MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 5000; // When Graph throttles without a Retry-After.

type Size = "medium" | "large";

interface QueueEntry {
  itemId: string;
  size: Size;
  retries: number;
  resolve: (url: string | null) => void;
}

const inFlight = new Map<string, Promise<string | null>>();
const queue: QueueEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function signInRequired(): void {
  window.dispatchEvent(new CustomEvent("signin-required"));
}

/**
 * Graph throttles hard, and scrolling a 5,000-photo month is exactly the
 * access pattern that trips it (confirmed live: HTTP 429). Two rules keep us
 * under the limit: only one batch is ever in flight — the first version
 * scheduled the next batch *before* awaiting the current one, so a fast scroll
 * could put hundreds of lookups on the wire at once — and a 429 parks the
 * whole queue until its Retry-After has elapsed instead of retrying blindly.
 */
let flushing = false;
let throttledUntil = 0;

function retryLater(entries: QueueEntry[]): void {
  // Back to the front: these are the thumbnails nearest the viewport.
  for (const entry of entries.reverse()) {
    if (entry.retries < MAX_RETRIES) queue.unshift({ ...entry, retries: entry.retries + 1 });
    else entry.resolve(null);
  }
}

function backoffFrom(res: Response): number {
  const header = Number(res.headers.get("Retry-After"));
  return Number.isFinite(header) && header > 0 ? header * 1000 : DEFAULT_BACKOFF_MS;
}

async function flush(): Promise<void> {
  flushing = true;
  const batch = queue.splice(0, MAX_BATCH);

  try {
    if (batch.length === 0) return;

    let token: string;
    try {
      token = await getAccessToken();
    } catch (err) {
      // Only a session that really has ended raises the banner. Thumbnails
      // are the app's most frequent Graph request by far, so a renewal that
      // merely timed out used to announce an expired session several times a
      // browsing session; the pictures simply stay blank instead.
      if (!(err instanceof TokenRenewalError)) signInRequired();
      for (const entry of batch) entry.resolve(null);
      return;
    }

    const res = await fetch(`${GRAPH_BASE}/$batch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: batch.map((entry, i) => ({
          id: String(i),
          method: "GET",
          url: `/me/drive/items/${entry.itemId}/thumbnails/0/${entry.size}`,
        })),
      }),
    });

    if (res.status === 429 || res.status === 503) {
      throttledUntil = Date.now() + backoffFrom(res);
      retryLater(batch);
      return;
    }
    if (!res.ok) {
      for (const entry of batch) entry.resolve(null);
      return;
    }

    const body = (await res.json()) as {
      responses: { id: string; status: number; headers?: Record<string, string>; body?: { url?: string } }[];
    };
    const byId = new Map(body.responses.map((r) => [r.id, r]));

    // Sub-requests are throttled individually too, so a batch can come back
    // 200 with some 429s inside it.
    const retry: QueueEntry[] = [];
    batch.forEach((entry, i) => {
      const response = byId.get(String(i));
      if (response?.status === 429 || response?.status === 503) {
        const after = Number(response.headers?.["Retry-After"]);
        throttledUntil = Date.now() + (Number.isFinite(after) && after > 0 ? after * 1000 : DEFAULT_BACKOFF_MS);
        retry.push(entry);
        return;
      }
      entry.resolve(response?.status === 200 ? (response.body?.url ?? null) : null);
    });
    retryLater(retry);
  } catch {
    for (const entry of batch) entry.resolve(null);
  } finally {
    flushing = false;
    if (queue.length > 0) scheduleFlush();
  }
}

function scheduleFlush(): void {
  if (flushing || flushTimer !== null) return;
  const delay = Math.max(BATCH_DELAY_MS, throttledUntil - Date.now());
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, delay);
}

/** Resolves the short-lived CDN link for one thumbnail, via the batch queue. */
function resolveCdnUrl(itemId: string, size: Size): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    queue.push({ itemId, size, retries: 0, resolve });
    scheduleFlush();
  });
}

async function thumbnail(itemId: string, size: Size): Promise<string | null> {
  // Ask the active source first — the local server on a desktop, and one day
  // the device's own camera folder on a phone, where fetching a photograph back
  // out of OneDrive when it is already on disk would be absurd. Everything
  // below is the built-in Graph source, and stays the fallback when there is
  // none: a browser with no backend, which is the phone today.
  const source = thumbnailSource();
  if (source) {
    const url = await source.url(itemId, size);
    if (url) return url;
  }

  const key = `${size}:${itemId}`;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const load = (async () => {
    const cached = await getCached(key);
    if (cached) return cached;

    const cdnUrl = await resolveCdnUrl(itemId, size);
    if (!cdnUrl) return null;

    // The CDN link is already authenticated — sending our bearer token here
    // would be both unnecessary and a leak of it to a different host.
    const res = await fetch(cdnUrl);
    if (!res.ok) return null;

    return putThumb(key, await res.blob());
  })();

  inFlight.set(key, load);
  // A failed load shouldn't be remembered as a permanent "no" — a token that
  // expired mid-scroll should retry once the user signs back in.
  load.then((url) => {
    if (url === null) inFlight.delete(key);
  });
  return load;
}

/** For grid thumbnails / notable-list previews — small transfer, fast. */
export function loadThumbnail(itemId: string): Promise<string | null> {
  return thumbnail(itemId, "medium");
}

/** For the hero-layout lead image — a larger pre-generated thumbnail, still far smaller than the original. */
export function loadLarge(itemId: string): Promise<string | null> {
  return thumbnail(itemId, "large");
}

/**
 * The actual original bytes, for "open full-res". Only ever called on an
 * explicit click, so a single authenticated fetch is the right shape here —
 * and unlike the batched thumbnails this one does produce an object URL, so
 * it's revoked once the lightbox is done with it (see releaseFullPhoto).
 */
export async function loadFullPhoto(itemId: string): Promise<string | null> {
  // Through the local cache when there is one. The lightbox previously had no
  // cache at any layer: a HAR of a single open showed a Graph 302 at 893ms
  // followed by a 4.4MB download at 682ms, repeated in full every time the same
  // photo was opened.
  const source = thumbnailSource();
  if (source?.fullUrl) return source.fullUrl(itemId);

  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    if (!(err instanceof TokenRenewalError)) signInRequired();
    return null;
  }

  const res = await fetch(`${GRAPH_BASE}/me/drive/items/${itemId}/content`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return URL.createObjectURL(await res.blob());
}

export function releaseFullPhoto(url: string): void {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}

/**
 * A streamable URL for a video's original bytes.
 *
 * Not turned into an object URL: the point is to let the `<video>` element do
 * range requests against the CDN and stream, so it is handed the URL directly
 * and never buffered through JS. Through the local server when there is one
 * (which 302s to the CDN), and straight to Graph otherwise — the phone's case.
 */
export async function loadVideoUrl(itemId: string): Promise<string | null> {
  const source = thumbnailSource();
  if (source?.videoUrl) return source.videoUrl(itemId);

  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    if (!(err instanceof TokenRenewalError)) signInRequired();
    return null;
  }

  const res = await fetch(`${GRAPH_BASE}/me/drive/items/${itemId}?$select=@microsoft.graph.downloadUrl`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as Record<string, string>;
  return body["@microsoft.graph.downloadUrl"] ?? null;
}

/**
 * Frees the current view's thumbnails. Call this — not `releaseObjectUrls`
 * directly — whenever the visible set of photos is replaced.
 *
 * Both caches have to be dropped together. `inFlight` memoizes the resolved
 * object URL for each thumbnail so a photo scrolled past twice isn't fetched
 * twice, but those URLs are exactly what `releaseObjectUrls` revokes. Clearing
 * only the blobs left `inFlight` handing out revoked `blob:` URLs forever
 * after, so revisiting a month rendered every image broken — and because the
 * loader marked images loaded on assignment rather than on the load event,
 * they showed as opaque alt text rather than staying hidden.
 */
export function releaseThumbnails(): void {
  inFlight.clear();
  releaseObjectUrls();
}
