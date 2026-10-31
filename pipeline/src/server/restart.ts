/**
 * Restarting the server from inside the server.
 *
 * The only way a saved remote-access change, or a wedged process, can be
 * applied from where the reader is standing. It is also the most dangerous
 * thing this process does to itself, so the ordering rules are written down
 * here rather than buried in a route handler.
 *
 * The listeners belong to `serve.ts`, so this module does not hold them: it
 * asks through `RestartHost`, and `serve.ts` stays the one place that knows
 * which ports are open.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { get } from "node:http";
import { isAbsolute } from "node:path";
import { archiveHome } from "../paths.js";
import { env, shellEnvironment } from "../env.js";
import { runtimePath } from "../autostart.js";
import * as jobs from "./jobs.js";

/**
 * Whether this server's own health endpoint answers, without going through
 * the proxy layer.
 *
 * A plain `fetch` would be handed to the global dispatcher that
 * `initProxyDispatcher` installed for AI and Graph traffic, and a loopback URL
 * asking a system proxy to loop back is a question with two answers. `http.get`
 * touches neither, and this is the one probe that must not be clever.
 */
function answersHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = get(`http://127.0.0.1:${port}/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.setTimeout(1200, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

/**
 * The listeners a restart has to take down, and put back if the replacement
 * never answers.
 */
export interface RestartHost {
  /** Close the API listener, and resolve once the port is genuinely free. */
  closeApi(): Promise<void>;
  /** Close the page listener, when this process is the one that serves it. */
  closeApp(): Promise<void>;
  /** Take the API listener back and restart the page server, after a failed handover. */
  reopen(): void;
}

export type RestartPlan = { ok: true; entry: string } | { ok: false; error: string };

/**
 * Whether a restart may happen, and what to start in this one's place.
 *
 * Refuses on a running job rather than killing it: a job stopped mid-write
 * leaves the archive lock held by a process that will never release it, and
 * that failure surfaces as "nothing works" at the next launch with no line on
 * screen to explain it.
 */
export async function planRestart(): Promise<RestartPlan> {
  const running = jobs.runningJob();
  if (running) {
    return { ok: false, error: `A ${running.kind} job is running (${running.id}); wait for it or cancel it first.` };
  }
  const entry = process.argv[1];
  if (!entry || !isAbsolute(entry) || !existsSync(entry)) {
    return {
      ok: false,
      error:
        `This server was not started from a file on disk (${entry ?? "no entry point"}), ` +
        `so there is nothing to start again.`,
    };
  }
  return { ok: true, entry };
}

/**
 * Start a replacement and leave — only once it is answering.
 *
 * The order is the whole design:
 *
 *   1. **Close the listener first.** On Windows a replacement binding while
 *      this one still listens gets EADDRINUSE and dies, which would be a
 *      restart that removes the server. The port has to be free *before* the
 *      new process starts, not when it tries.
 *   2. **Spawn detached, from the same entry, with the shell's environment
 *      rather than this process's**, so it does not care whether it was the
 *      desktop shell, the sign-in launcher or a terminal that started this one.
 *      Not this process's env: that carries `.env`'s values, `dotenv` will not
 *      override them, and the replacement would come back holding the very
 *      setting the reader just changed and asked to apply (`shellEnvironment`).
 *      No supervisor is introduced — the dying process is the only thing that
 *      has to work, and it works the same in the background case where there is
 *      no shell to fall back on.
 *   3. **Wait for /health, up to 20 seconds, before exiting.** A replacement
 *      that failed to start must be followed by this one coming back up, not
 *      by nothing.
 *
 * The response has already been written by then: readers see a couple of
 * seconds in which `/health` does not answer, which the app's two-consecutive-
 * misses rule absorbs without drawing the offline banner.
 */
export async function handOver(entry: string, host: RestartHost): Promise<void> {
  console.log(`restart: handing over to ${entry}`);

  // Wait for the listener to be *gone*, not merely closing. `server.close()`
  // releases the port only once its connections are finished, and on Windows a
  // replacement that binds before then gets EADDRINUSE — which is exactly what
  // the first attempt did, with the child's own error line lost along with it
  // because it died before a pipe flushed.
  await host.closeApi();

  // The page listener must go too, for the mirror-image reason: a replacement
  // that cannot bind the app port would come up API-only, and the archive
  // would answer /health with no way to open it. If this process never
  // served the page (the shell does), there is nothing to close.
  await host.closeApp();

  let child: ReturnType<typeof spawn> | null = null;
  try {
    child = spawn(runtimePath(), [entry], {
      cwd: archiveHome(),
      env: { ...shellEnvironment(), ELECTRON_RUN_AS_NODE: "1" },
      detached: true,
      // Not this process's stdout: the replacement writes `data/serve.log`
      // itself (logFile.ts), and handing it our stream as well would put every
      // line in twice — once through the launcher's redirect, once through
      // its own mirror.
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", (err) => console.error(`restart: could not start the replacement: ${err.message}`));
    child.unref();
  } catch (err) {
    console.error(`restart: failed to spawn the replacement: ${(err as Error).message}`);
  }

  if (child) {
    // A replacement that dies must be reported now, not after twenty seconds
    // of polling a port nobody is going to answer on.
    let died: string | null = null;
    child.once("exit", (code, signal) => {
      died = code !== null && code !== undefined ? String(code) : String(signal ?? "unknown");
    });

    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise((r) => setTimeout(r, 500));
      if (died !== null) {
        console.error(`restart: the replacement exited (${died}) before it answered`);
        break;
      }
      if (await answersHealth(env.servePort)) {
        console.log("restart: replacement is answering - exiting");
        // Not `process.exit` straight away: this process's stdout is a pipe
        // (the launcher redirects it), and a synchronous exit drops whatever
        // the pipe has not flushed - which is how the first attempt's report
        // went missing.
        setTimeout(() => process.exit(0), 150);
        return;
      }
    }
  }

  // Nothing came up. Take the listener back rather than leave the port held by
  // a process that is about to stop listening and then sit there.
  console.error("restart: no replacement answered within 20s - taking the listener back");
  host.reopen();
}
