/**
 * One authenticated Graph request, with the timeout every one of them owes.
 *
 * The rule the health path already lives by (backend.ts): anything that may
 * never resolve needs a timeout. A Graph fetch has two ways to hang — a CDN
 * connection that never finishes (a browser waits minutes at the TCP level
 * before giving up on a stalled socket) and whatever wedged upstream of it.
 * Measured 2026-10-17 on the phone: a cold start with no kept archive sat on
 * a bare spinner for over a minute because neither the token step nor the
 * first fetches had a bound. Absolute bounds, sized by kind:
 *
 * - queries — eTag lookups, folder listings, $batch — answer in a few hundred
 *   bytes and get `GRAPH_QUERY_TIMEOUT_MS`;
 * - downloads — the 3.7MB index, month shards, the 6.5MB search index — ride
 *   mobile links where 1Mbps is real, so they get `GRAPH_BYTES_TIMEOUT_MS`:
 *   long enough for a slow-but-working transfer, short enough that a dead one
 *   cannot hold the first screen.
 *
 * A timeout surfaces as a plain Error naming the bound, so `failedToLoad` and
 * the search view report something a reader can act on instead of a bare
 * `TimeoutError`.
 */

import { assertNoBrotli } from "@travel-archive/shared/brotli";
import { Capacitor, CapacitorHttp } from "@capacitor/core";

/** How long a small Graph call may take: lookups, listings, $batch. */
export const GRAPH_QUERY_TIMEOUT_MS = 20_000;

/** How long a download may take: the index, shards, the search index. */
export const GRAPH_BYTES_TIMEOUT_MS = 60_000;

export async function graphFetch(
  url: string,
  /** Null for a URL that carries its own credential — Graph's pre-authenticated CDN links. */
  token: string | null,
  timeoutMs: number,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  // Ask for gzip explicitly; the runtime's Brotli decoder is unpatched (see
  // shared/src/brotli.ts), and a service that compresses unasked can answer br.
  if (!headers.has("Accept-Encoding")) headers.set("Accept-Encoding", "gzip");
  try {
    const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
    assertNoBrotli(response, url);
    return response;
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error(`Graph did not answer within ${Math.round(timeoutMs / 1000)} s`);
    }
    throw err;
  }
}

/**
 * The bytes at `url`, fetched by the native HTTP stack when there is one.
 *
 * Why this exists: an `<img>` in the WebView (and a `fetch` inside it) is
 * subject to CORS, and OneDrive's download host stopped sending
 * `Access-Control-Allow-Origin` for the app's `https://archive.local` origin on
 * 2026-11-13. Every thumbnail and every original then failed inside the WebView
 * — measured in logcat, `blocked by CORS policy: No
 * 'Access-Control-Allow-Origin' header` — while the URL itself was fine. The
 * native request is not a browser request and has no origin to be refused for,
 * so the images keep working; the failure state stays as the honest fallback
 * for a genuine 401/timeout.
 *
 * The Web path is untouched: on the desktop the same call is an ordinary
 * `fetch`, and the local job server answers it.
 */
export async function fetchBytesNative(url: string, timeoutMs: number, token: string | null = null): Promise<Blob | null> {
  if (!Capacitor.isNativePlatform()) {
    const res = await graphFetch(url, token, timeoutMs);
    return res.ok ? await res.blob() : null;
  }

  const res = await Promise.race([
    CapacitorHttp.request({
      url,
      method: "GET",
      responseType: "blob",
      // A CDN link carries its own credential and must not be sent ours; a
      // Graph `/content` call needs the bearer token. One argument covers both.
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Graph did not answer within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs),
    ),
  ]);

  if (res.status < 200 || res.status >= 300) return null;
  const data = res.data as unknown;
  if (typeof data !== "string") return null;
  // `responseType: "blob"` arrives base64-encoded: it is the only way the
  // bridge can carry binary without re-encoding it as UTF-8 text.
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes]);
}
