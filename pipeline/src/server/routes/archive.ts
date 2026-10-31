/**
 * Reading the archive: the metadata the reader asks for, and the bytes behind
 * a thumbnail or a video.
 */

import { getCachedAccessToken } from "../../auth.js";
import { GraphError, fetchItemDownloadUrl } from "../../graph.js";
import { SCREEN_CAPTIONS_FILE } from "../../screenCaptions.js";
import { readThumb } from "../../thumbStore.js";
import { decodeSegment, json, sendJsonText, type Route } from "../http.js";
import { fetchAndCache, imageType, type ThumbSize } from "../media.js";
import { mirrorOrFetch, archiveStatus } from "../mirror.js";
import type { RouteContext } from "./context.js";

/** The routes, in the order they were written; the dispatcher keeps looking after a method mismatch. */
export const archiveRoutes = (ctx: RouteContext): Route[] => [
  /**
   * The archive metadata, from the local mirror.
   *
   * The app read `index.json` and every month shard straight from OneDrive on
   * every load — a **2.4MB** download for the index alone, measured between
   * 1,237ms and 3,289ms, and strictly blocking: the months a trip spans are
   * not known until it lands, so nothing else can even start.
   *
   * Every pipeline run already writes the identical content to `data/`, so the
   * bytes were sitting on the disk the whole time. Reading them locally is a
   * few milliseconds.
   *
   * Safe because the writer is singular: this server is the only thing that
   * ever writes the archive, and the phone is read-only by design. The mirror
   * can only be stale if the pipeline was run on a *different* machine, in
   * which case a `scan` here brings it back. The app still falls back to Graph
   * when no server is running, which is the phone's normal path.
   */
  [/^\/archive\/status$/, "GET", async (_req, res) => json(res, 200, await archiveStatus())],

  [
    /^\/archive\/index$/,
    "GET",
    async (_req, res) => {
      const body = await mirrorOrFetch("index.json");
      if (!body) return json(res, 404, { error: "No index.json, in the mirror or in OneDrive" });
      sendJsonText(res, body);
    },
  ],

  [
    /^\/archive\/search$/,
    "GET",
    async (_req, res) => {
      const body = await mirrorOrFetch("search.json");
      if (!body) return json(res, 404, { error: "No search.json, in the mirror or in OneDrive" });
      sendJsonText(res, body);
    },
  ],

  [
    /^\/archive\/home$/,
    "GET",
    async (_req, res) => {
      const body = await mirrorOrFetch("home.json");
      if (!body) return json(res, 404, { error: "No home.json, in the mirror or in OneDrive" });
      sendJsonText(res, body);
    },
  ],
  /**
   * The sealed screenshot descriptions, from the mirror.
   *
   * The same route as the other archive files, for the same reason: the file
   * the pipeline writes is on the disk, and asking OneDrive for it again costs
   * a round trip. What it carries is ciphertext — the page decrypts it, so the
   * plaintext never crosses this server.
   */
  [
    /^\/archive\/screens$/,
    "GET",
    async (_req, res) => {
      const body = await mirrorOrFetch(SCREEN_CAPTIONS_FILE);
      if (!body) return json(res, 404, { error: `No ${SCREEN_CAPTIONS_FILE}, in the mirror or in OneDrive` });
      sendJsonText(res, body);
    },
  ],

  [
    /^\/archive\/shard\/(\d{4}-\d{2})$/,
    "GET",
    async (_req, res, [month]) => {
      const body = await mirrorOrFetch(`photos/${month}.json`);
      if (!body) return json(res, 404, { error: `No shard for ${month}, in the mirror or in OneDrive` });
      sendJsonText(res, body);
    },
  ],
  /**
   * The second language's files, from the mirror, for the same reason as the
   * two above. The language pattern admits only a code — no dots, no slashes —
   * so the path cannot be walked out of `i18n/`.
   */
  [
    /^\/archive\/i18n\/([a-z]{2}(?:-[A-Za-z]{2,4})?)\/index$/,
    "GET",
    async (_req, res, [lang]) => {
      const body = await mirrorOrFetch(`i18n/${lang}/index.json`);
      if (!body) return json(res, 404, { error: `No ${lang} text, in the mirror or in OneDrive` });
      sendJsonText(res, body);
    },
  ],

  [
    /^\/archive\/i18n\/([a-z]{2}(?:-[A-Za-z]{2,4})?)\/shard\/(\d{4}-\d{2})$/,
    "GET",
    async (_req, res, [lang, month]) => {
      const body = await mirrorOrFetch(`i18n/${lang}/photos/${month}.json`);
      if (!body) return json(res, 404, { error: `No ${lang} captions for ${month}, in the mirror or in OneDrive` });
      sendJsonText(res, body);
    },
  ],
  /**
   * A thumbnail, from disk when it has been fetched before.
   *
   * The app used to mint a short-lived CDN link per image through a Graph
   * `$batch` and cache the bytes in IndexedDB. That is per-browser, vanishes
   * when a privacy-minded browser clears site data, and degrades silently when
   * it does. Serving from here instead makes the cache shared, durable and
   * independent of the browser.
   *
   * The URL is keyed on the item id and never changes, which is what lets it
   * be marked immutable — the CDN links it replaces were different every time,
   * so ordinary HTTP caching could never help. A cached image therefore costs
   * neither a Graph call nor a request to this server.
   */
  [
    /^\/thumb\/(medium|large|full)\/(.+)$/,
    "GET",
    async (req, res, [size, encodedId]) => {
      const itemId = decodeSegment(encodedId);
      if (!itemId) return json(res, 404, { error: "No such photo" });
      const sendImage = (bytes: Buffer) => {
        res.writeHead(200, {
          "Content-Type": imageType(bytes),
          "Content-Length": bytes.length,
          // No CORS header here: cors() has already set it with setHeader, and
          // headers passed to writeHead take precedence — repeating it would
          // overwrite a correct origin with an empty one.
          //
          // `public` only when the archive is open at all. With a password set
          // this response was authorised by a cookie, and a shared cache must
          // not be allowed to hand it to someone else; `private` keeps the
          // browser's own cache, which is where the speed came from anyway.
          "Cache-Control": ctx.access.gated
            ? "private, max-age=31536000, immutable"
            : "public, max-age=31536000, immutable",
        });
        res.end(bytes);
      };

      const cached = await readThumb(size as ThumbSize, itemId);
      if (cached) return sendImage(cached);

      // Only a miss costs a Graph request and a disk write. Loopback is the
      // owner's own machine and is not limited.
      if (!ctx.access.isLocal(req) && !ctx.thumbLimiter.take(req.socket.remoteAddress ?? "unknown")) {
        res.setHeader("Retry-After", "1");
        return json(res, 429, { error: "Too many thumbnails at once; slow down." });
      }

      let bytes: Buffer | null;
      try {
        bytes = await fetchAndCache(size as ThumbSize, itemId);
      } catch (err) {
        // "That item does not exist" is the archive's answer, not the server
        // breaking. The generic handler maps anything else to 500, which told
        // the reader a ghost month's worth of ids (TODO, #12) was a server
        // fault, and 500 is not the status the app reads as "no preview".
        if (err instanceof GraphError && err.status === 404) {
          return json(res, 404, { error: "No such item, or not signed in" });
        }
        throw err;
      }
      if (!bytes) return json(res, 404, { error: "No image for that item, or not signed in" });
      sendImage(bytes);
    },
  ],
  /**
   * A video, streamed. The app points a `<video>` at this, and its range
   * requests are redirected to OneDrive — so only the part being watched
   * crosses the wire, the difference between a few MB and a 382MB original. A
   * 302 rather than a proxy because the pre-authenticated CDN URL already
   * speaks Range; this server never touches the bytes.
   */
  [
    /^\/video\/(.+)$/,
    "GET",
    async (_req, res, [encodedId]) => {
      // A remote reader does not get video. It is the one route that hands out a
      // pre-authenticated OneDrive URL rather than fetching the bytes itself, so
      // the traffic is the owner's and the URL is a capability for anyone who
      // sees it; and the app hides its own video affordances on a remote
      // connection to match. Nothing here is worth that.
      if (!ctx.access.isLocal(_req)) return json(res, 404, { error: "No such route" });
      const itemId = decodeSegment(encodedId);
      if (!itemId) return json(res, 404, { error: "No such route" });
      const token = await getCachedAccessToken();
      if (!token) return json(res, 404, { error: "Not signed in" });
      const url = await fetchItemDownloadUrl(token, itemId);
      if (!url) return json(res, 404, { error: "No video for that item" });
      res.writeHead(302, { Location: url, "Cache-Control": "no-store" });
      res.end();
    },
  ],
];
