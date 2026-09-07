import { localThumbSizes, localThumbUrl } from "./backend";

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
}

/**
 * The local job server. Hands back an address and nothing else — the browser
 * does the fetching, and because the URL is keyed on the item id rather than
 * being a short-lived CDN link, the browser's own HTTP cache finally works.
 */
export const localServerSource: ThumbnailSource = {
  name: "local server",
  url: async (itemId, size) => localThumbUrl(itemId, size),
  sizes: (ids, size) => localThumbSizes(ids, size),
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
