import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Which pipeline this is, for `/health`.
 *
 * A packaged build carries `build-info.json` beside its bundle (written by
 * `desktop/scripts/bundle-pipeline.mjs`); a working copy answers with its own
 * package.json version. "Installed build or repo checkout?" used to be
 * unanswerable from the running app.
 */
let cached: string | null | undefined;

export function pipelineVersion(): string | null {
  if (cached !== undefined) return cached;
  cached = null;
  // `fileURLToPath`, not `URL.pathname`: the install path is
  // `%LOCALAPPDATA%\Programs\Photo Archive\…`, and a pathname keeps the space
  // percent-encoded, so every read below missed and `/health` said nothing.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const base of [
    // `resources/pipeline/dist/server.mjs`, with `build-info.json` one level up.
    join(here, ".."),
    here,
    process.cwd(),
  ]) {
    try {
      const info = JSON.parse(readFileSync(join(base, "build-info.json"), "utf8")) as { version?: string; commit?: string };
      if (info.version) {
        cached = info.commit ? `${info.version} (${info.commit.slice(0, 7)})` : info.version;
        return cached;
      }
    } catch {
      // no build info here
    }
    try {
      const pkg = JSON.parse(readFileSync(join(base, "package.json"), "utf8")) as { version?: string };
      if (pkg.version) {
        cached = pkg.version;
        return cached;
      }
    } catch {
      // nor a package.json
    }
  }
  return cached;
}
