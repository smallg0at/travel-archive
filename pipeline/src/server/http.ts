/**
 * HTTP plumbing shared by every route: the handler shape, JSON replies, body
 * reading, CORS, and the "one job at a time" refusal.
 *
 * These were the first 120 lines of `serve.ts`. They have no opinion about the
 * archive — only about HTTP — which is why they can leave before the routes do.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { originAllowed } from "../originCheck.js";
import * as jobs from "./jobs.js";

export type Handler = (req: IncomingMessage, res: ServerResponse, params: string[]) => Promise<void> | void;

/**
 * One entry in the route table: what it matches, the one method it answers, and
 * the handler. Anything else on that path is a 405 with this table as the
 * `Allow` header, which is why the method is a value here rather than a check
 * inside the handler.
 */
export type Route = [RegExp, string, Handler];

/**
 * Which origins may talk to this server, and which may write to it.
 *
 * The rule itself lives in `originCheck.ts`: it is a security decision, so it
 * sits where it can be tested on its own. What used to be here matched private
 * *IP literals* against three ports — which quietly excluded every reader who
 * reached the machine by name instead of by address (`http://nas:17923`,
 * `http://desktop.local:17923`), for CORS on a read and a 403 on a write.
 *
 * `exposed` is a parameter rather than an import because it is decided once at
 * startup, after this module is loaded.
 */
export function cors(req: IncomingMessage, res: ServerResponse, exposed: boolean): void {
  // **Always `Vary: Origin`, even with no Origin on the request.**
  //
  // Thumbnails are served `immutable, max-age=31536000`. Without this header a
  // response fetched *without* CORS is cached with no record that CORS mattered,
  // and the browser then satisfies a later CORS request from that same entry —
  // which has no `Access-Control-Allow-Origin`, so the check fails and the image
  // dies instantly. That presented as "some images load and some do not",
  // splitting on whichever URLs happened to be fetched no-CORS first, and it
  // survives clearing the *server's* cache because the poisoned copy is in the
  // browser's.
  res.setHeader("Vary", "Origin");
  const origin = req.headers.origin;
  if (origin && originAllowed(origin, { exposed })) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  // The session cookie has to be allowed through for a remote reader, who signs
  // in on the shell's origin and then fetches thumbnails from this one.
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/** A path segment from the URL, or null when its escapes are malformed. */
export function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

/**
 * A request the server understands well enough to refuse precisely.
 *
 * Distinct from a failure: this is the caller's answer, and it has to reach
 * them as a 400 rather than being caught by the generic handler below and
 * reported as the server's own fault — which is what happened to the
 * content-type check on its first outing.
 */
export class BadRequest extends Error {}

export async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Nothing this API accepts is large; a body this big is a mistake or an abuse.
    if (size > 1_000_000) throw new BadRequest("Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {} as T;

  /**
   * The content type is the check, not a formality.
   *
   * `application/json` makes the browser preflight, and a preflight is where
   * `cors()` refuses an origin it does not know — so a page on the internet
   * cannot deliver a body at all. `text/plain` and the form types are "simple"
   * requests: sent without asking, answered without the attacker seeing the
   * answer, and **executed all the same**. Parsing whatever arrived meant the
   * origin rule protected the response and not the write.
   *
   * `canWrite` does not help: it is the socket address, and a browser reaching
   * 127.0.0.1 from any page *is* 127.0.0.1.
   *
   * An empty body is exempt — with nothing to parse there is nothing to do —
   * which keeps a bare `POST /jobs/analyze/collect` from a shell working.
   */
  const type = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    throw new BadRequest(`Expected Content-Type: application/json, got ${type || "none"}`);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T;
  } catch (err) {
    // The caller's body, so the caller's 400 — with the parser's own position,
    // which is the only part of the message worth having.
    throw new BadRequest(`Body is not valid JSON: ${(err as Error).message}`);
  }
}

/** Refuses a second job rather than letting two writers race over index.json. */
export function refuseIfBusy(res: ServerResponse): boolean {
  const running = jobs.runningJob();
  if (!running) return false;
  json(res, 409, { error: "A job is already running", job: running });
  return true;
}

export function sendJsonText(res: ServerResponse, body: string): void {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    // Not immutable: a job rewrites these, and the app must see it on reload.
    "Cache-Control": "no-cache",
  });
  res.end(body);
}
