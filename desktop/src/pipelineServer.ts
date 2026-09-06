import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Runs `pipeline serve` as a child process, or adopts one already running.
 */

export interface PipelineServer {
  /** null when an already-running server was adopted rather than started here. */
  child: ChildProcess | null;
  adopted: boolean;
}

/** Whether something is already answering as the job server on this port. */
export async function isHealthy(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Resolves once the server answers, or false if it never does. */
export async function waitForHealthy(port: number, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy(port, 1000)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

export interface StartOptions {
  /** A writable directory to run in. */
  cwd: string;
  /** pipeline/dist/serve.js */
  entry: string;
  /**
   * Passed through as `ARCHIVE_HOME` — where the pipeline keeps `.env`, the
   * token cache and the `data/` mirror. Null when running from a checkout,
   * where the pipeline's own default is already the right place.
   */
  archiveHome: string | null;
  port: number;
  onOutput: (line: string) => void;
}

/**
 * Starts the job server, or adopts a healthy one.
 *
 * **Spawned through Electron's own Node, not `node`.** Node here is installed
 * via fnm, which puts it on `PATH` only for shells that have run its init — and
 * an app launched from an icon has run no shell at all. `process.execPath` with
 * `ELECTRON_RUN_AS_NODE` runs the same JavaScript on the Node that Electron
 * already bundles, so the shell depends on nothing outside itself. (This is
 * also why `run-preview.ps1` has to hardcode an absolute node path.)
 *
 * **`ARCHIVE_HOME` decides where state goes**, not the working directory. That
 * used to be the other way round — `.env` was read from `process.cwd()` and the
 * archive mirror was written relative to it, so spawning from the wrong
 * directory either refused to start for want of `AZURE_CLIENT_ID` or quietly
 * wrote a second archive somewhere else. Packaging forced the fix, since an
 * installed app has no checkout to be "in"; `cwd` is now only a fallback for
 * anything that still resolves relatively.
 */
export async function startPipelineServer(opts: StartOptions): Promise<PipelineServer> {
  if (await isHealthy(opts.port)) {
    opts.onOutput(`Adopted the job server already running on ${opts.port}.`);
    return { child: null, adopted: true };
  }

  if (!existsSync(opts.entry)) {
    throw new Error(
      `The pipeline is not built: ${opts.entry} does not exist. ` +
        `Run "npm run --workspace pipeline build" first.`,
    );
  }

  const child = spawn(process.execPath, [opts.entry], {
    cwd: opts.cwd,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ...(opts.archiveHome ? { ARCHIVE_HOME: opts.archiveHome } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const forward = (buf: Buffer) => {
    for (const line of buf.toString("utf-8").split(/\r?\n/)) {
      if (line.trim()) opts.onOutput(line);
    }
  };
  child.stdout?.on("data", forward);
  child.stderr?.on("data", forward);

  return { child, adopted: false };
}

/**
 * Matches the device-code prompt MSAL prints, so the shell can put it on screen.
 *
 * `pipeline/src/auth.ts` emits this with `console.log` and then blocks until
 * the user completes it. That is right for a CLI run somebody is watching, and
 * invisible here — with no terminal the first sign-in would simply appear to
 * hang forever. Matched on the URL rather than the wording, which MSAL has
 * changed before.
 */
export function isDeviceCodePrompt(line: string): boolean {
  return /microsoft\.com\/devicelogin/i.test(line) || /enter the code/i.test(line);
}

/** Stops a server this process started. An adopted one is left alone. */
export function stopPipelineServer(server: PipelineServer | null): void {
  if (!server?.child || server.adopted) return;
  if (server.child.exitCode !== null || server.child.signalCode !== null) return;
  server.child.kill();
}
