import { localThumbSizes, localThumbUrl, localVideoUrl, warmThumbnails } from "./backend";

/**
 * Where thumbnail bytes come from.
 *
 * There are three answers, and the archive will eventually want all of them:
 *
 *  - **the local server** — a disk cache beside the archive, shared between
 *    browsers and durable across a browser clearing its site data. The desktop
 *    answer.
 *  - **Microsoft Graph** — batched CDN links plus an IndexedDB cache. The
 *    original, and still the answer for a browser with no backend.
 *  - **the device itself** — on a phone the photographs are usually already
 *    on disk in the camera folder, so fetching them back out of OneDrive is
 *    absurd. Not built yet; this interface exists so that it is an
 *    implementation rather than a rewrite.
 *
 * A source only has to turn an id into a URL. That is deliberately the whole
 * contract: it is what an `<img>` needs, and it is satisfiable by an http URL,
 * a `blob:` URL or a Capacitor `file://` conversion equally well.
 */

export type ThumbSize = "medium" | "large";

export interface ThumbnailSource {
  /** For logging and for the cache indicator in settings. */
  readonly name: string;
  /**
   * A URL for this thumbnail, or null when this source cannot supply it — in
   * which case the caller falls back. Must not block on a network round trip
   * where it can avoid one: this sits on the image loading path.
   */
  url(itemId: string, size: ThumbSize): Promise<string | null>;
  /**
   * Byte sizes for thumbnails this source already holds, for callers comparing
   * against something they produced (the PDF export). Optional: a source that
   * cannot answer cheaply should omit it rather than guess.
   */
  sizes?(ids: string[], size: ThumbSize): Promise<Map<string, number>>;
  /**
   * A URL for the original file, when this source can serve one. The lightbox
   * had no cache at any layer before this existed.
   */
  fullUrl?(itemId: string): string;
  /**
   * A URL for the original video, streamed with range requests. Separate from
   * `fullUrl`, which reads the whole file — fine for a photo, fatal for a
   * multi-hundred-MB video.
   */
  videoUrl?(itemId: string): string;
  /**
   * Fetch these ahead of time, if the source can. Optional because it only
   * makes sense where fetching is expensive and cached fetching is not.
   */
  warm?(ids: string[], size: ThumbSize): Promise<void>;
  /**
   * Set on the `<img>` before its `src`, when this source's URLs are
   * cross-origin *and* answer with CORS headers.
   *
   * **`use-credentials`, not `anonymous`.** Both make the response CORS-clean
   * so the PDF export's canvas is not tainted — that was the original reason
   * this exists, after thumbnails moved from same-origin `blob:` URLs onto the
   * job server's own port. But `anonymous` means *without credentials*, and the
   * job server gates reading on a session cookie: on the owner's machine the
   * request is loopback and passes anyway, while over the home network every
   * thumbnail came back **401 with no cookie attached**. The reader saw a grid
   * of broken images and no error, because an `<img>` that fails has nowhere to
   * report it.
   *
   * A cross-origin image request defaults to `same-origin` credentials, so this
   * attribute is the only thing that can make the cookie travel; the server
   * already answers with `Access-Control-Allow-Credentials: true` and echoes
   * the private origin.
   *
   * **Opt-in per source, never blanket.** Setting it on a source whose host
   * does not send `Access-Control-Allow-Origin` makes the image fail to load
   * outright, so the Graph path — whose CDN links are not ours to guarantee —
   * deliberately leaves it unset.
   */
  readonly crossOrigin?: "use-credentials";
}

/**
 * The local job server. Hands back an address and nothing else — the browser
 * does the fetching, and because the URL is keyed on the item id rather than
 * being a short-lived CDN link, the browser's own HTTP cache finally works.
 */
export const localServerSource: ThumbnailSource = {
  name: "local server",
  // A different origin from the page (port 18419 against the app's own), so the
  // canvas export needs the opt-in and a remote reader needs the cookie to go
  // with it — `use-credentials` is the one value that does both. serve.ts
  // answers with Access-Control-Allow-Origin for the page's origin and
  // Access-Control-Allow-Credentials: true.
  crossOrigin: "use-credentials",
  url: async (itemId, size) => localThumbUrl(itemId, size),
  sizes: (ids, size) => localThumbSizes(ids, size),
  fullUrl: (itemId) => localThumbUrl(itemId, "full"),
  videoUrl: (itemId) => localVideoUrl(itemId),
  warm: (ids, size) => warmThumbnails(ids, size as "medium" | "large"),
};

/**
 * The active source, or null for "use the built-in Graph path".
 *
 * Chosen once, from the same health check that reveals the generation
 * controls, rather than probed per image — an image loader must never await a
 * health check.
 */
let active: ThumbnailSource | null = null;

export function setThumbnailSource(source: ThumbnailSource | null): void {
  active = source;
}

export function thumbnailSource(): ThumbnailSource | null {
  return active;
}
