/**
 * Server-Sent Events for one job.
 *
 * Kept apart from the route table because the lifetime rules are fiddly and
 * worth reading on their own: one stream per client, the current record sent
 * immediately, a heartbeat so a quiet analyze month does not look dead, and a
 * stream that closes itself when the job reaches a terminal state — otherwise
 * `EventSource` reconnects forever to a job that finished.
 */

import type { ServerResponse } from "node:http";
import type { JobRecord } from "@travel-archive/shared";
import { json } from "./http.js";
import * as jobs from "./jobs.js";

export function streamJob(res: ServerResponse, id: string): void {
  const record = jobs.getJob(id);
  if (!record) return json(res, 404, { error: "No such job" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Node buffers small writes; without this a proxy or the client may hold
    // frames back until enough bytes accumulate.
    "X-Accel-Buffering": "no",
  });

  const send = (current: JobRecord) => {
    res.write(`data: ${JSON.stringify(current)}\n\n`);
    if (current.status !== "running" && current.status !== "queued") {
      unsubscribe();
      clearInterval(heartbeat);
      res.end();
    }
  };

  // A comment frame keeps intermediaries from timing out a quiet stream — an
  // analyze job can spend a minute inside one slow month without emitting.
  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
  const unsubscribe = jobs.subscribe(id, send);

  res.on("close", () => {
    unsubscribe();
    clearInterval(heartbeat);
  });

  send(record);
}
