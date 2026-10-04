import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dataDir, dataFile } from "./paths.js";

/**
 * Writing this process's own output to a file, whatever console it has.
 *
 * It had no such file. The sign-in launcher redirected stdout to
 * `data/serve.log`, which looked like coverage and was not: PowerShell's
 * `$ErrorActionPreference = 'SilentlyContinue'` — put there to keep a hidden
 * window quiet — **discards a native command's stderr under redirection**, so
 * every `console.error` the server ever produced was dropped on the floor. The
 * restart that failed for twenty seconds reported its reason in exactly one
 * line, on stderr, and that line was the one that vanished.
 *
 * So the server writes the file itself, and the launcher no longer redirects:
 * one writer, both streams, and a log that does not depend on how the process
 * happened to be started — terminal, desktop shell, or the launcher at
 * sign-in.
 *
 * What this cannot cover is a failure *before* it loads (a broken build, a
 * missing dependency): nothing is running yet to write anything. That is the
 * one gap, and it is a build failure rather than a runtime one.
 *
 * Both streams keep writing outward as well: the desktop shell forwards them
 * to its console, and a terminal still shows them. The file is a second copy,
 * not a sink.
 */

/** One generation, kept when the log would otherwise grow without bound. */
const MAX_BYTES = 5 * 1024 * 1024;

let installed = false;

export function mirrorOutputToLog(): void {
  if (installed) return;
  installed = true;

  const path = dataFile("serve.log");
  try {
    // The mirror is the whole of `data/`, and on a fresh install nothing has
    // created it yet — a log that silently fails to open on day one would be
    // the one file the day-one diagnosis needs.
    mkdirSync(dataDir(), { recursive: true });
    // Rotate first: a log that only ever appends is one nobody dares open.
    // `serve.log.1` overwrites, so the size is bounded at twice the cap — the
    // recent history is what a failure needs, not the whole year.
    if (existsSync(path) && statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`);
  } catch {
    // A log we cannot rotate is still a log worth writing.
  }

  let stream: ReturnType<typeof createWriteStream>;
  try {
    stream = createWriteStream(path, { flags: "a" });
  } catch {
    // Read-only home, full disk: keep the console, lose the file.
    return;
  }
  stream.on("error", () => {
    // Never let a failure to log become a failure to serve.
  });

  // `write` is replaced rather than the stream swapped, because `console.*`
  // holds its own reference to stdout/stderr — patching the property is the
  // one hook that reaches both, and the original is called so nothing changes
  // for whoever is already reading.
  for (const out of [process.stdout, process.stderr] as const) {
    const target = out as unknown as { write: (chunk: unknown, ...rest: unknown[]) => boolean };
    const original = target.write.bind(out);
    target.write = (chunk: unknown, ...rest: unknown[]) => {
      try {
        stream.write(
          typeof chunk === "string"
            ? chunk
            : // A `Buffer` or `Uint8Array` on its way to the console. The cast
              // is for TypeScript's typed-array generics, not for the value.
              Buffer.from(chunk as unknown as ArrayLike<number>),
        );
      } catch {
        // ...and never let the file decide whether the console works.
      }
      return original(chunk, ...rest);
    };
  }
}
