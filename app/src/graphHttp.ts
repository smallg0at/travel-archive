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
