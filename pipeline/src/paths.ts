import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";

/**
 * Where the pipeline keeps things, and the difference between the two kinds.
 *
 * This exists because packaging broke an assumption that was invisible while
 * everything ran from a git checkout: that the directory holding the code is
 * also writable, and is also where the user's configuration lives. Installed,
 * the code sits in Program Files (or inside an asar archive) and is read-only,
 * while the archive mirror, the token cache and `.env` all have to be
 * somewhere the user owns.
 *
 * So paths split in two:
 *
 *   **home**   — writable, per-user state: `.env`, `token-cache.json`,
 *                `redaction-terms.json`, and everything under `data/`.
 *                The desktop shell sets `ARCHIVE_HOME` to its userData
 *                directory; a checkout falls back to `pipeline/`, which is
 *                exactly where these already live, so nothing moves for
 *                anyone running from source.
 *
 *   **config**  — read-only files shipped alongside the code, currently just
 *                `screenshot-apps.json`. Resolved from the module, never from
 *                home, because it is policy that ships with the build rather
 *                than something the user maintains.
 *
 * The previous mix — some paths relative to `process.cwd()`, some to
 * `import.meta.url` — meant the two categories were interleaved by accident.
 * Under a packaged app the module-relative ones would have landed inside a
 * read-only archive, so sign-in would have failed on the first attempt to
 * write the token cache.
 */

/** `pipeline/` when running from a checkout: dist/paths.js -> up one. */
const MODULE_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

/**
 * The writable root. `ARCHIVE_HOME` wins so the desktop shell can point this
 * at a per-user directory without the pipeline knowing anything about Electron.
 */
export function archiveHome(): string {
  const override = process.env.ARCHIVE_HOME?.trim();
  return override ? resolve(override) : MODULE_ROOT;
}

/** A writable file directly under home — `.env`, `token-cache.json`. */
export function homeFile(name: string): string {
  return join(archiveHome(), name);
}

/** The archive mirror directory. */
export function dataDir(): string {
  return join(archiveHome(), "data");
}

/** A writable file under `data/` — shards, the lock, `trips.json`, `jobs/`. */
export function dataFile(...segments: string[]): string {
  return join(dataDir(), ...segments);
}

/** A read-only file that ships with the build. */
export function configFile(name: string): string {
  return join(MODULE_ROOT, name);
}

/** Any file directly beside the shipped code — `build-info.json`, the bundle. */
export function moduleFile(name: string): string {
  return join(MODULE_ROOT, name);
}

/**
 * A read-only data file that ships beside the code, under `data/`.
 *
 * The installer cannot run build scripts, so anything the runtime reads that
 * is generated at development time — the offline gazetteer, for one — has to
 * travel inside the package. `MODULE_ROOT` is `pipeline/` in a checkout and
 * `resources/pipeline` once installed, so this resolves in both.
 */
export function shippedDataFile(...segments: string[]): string {
  return join(MODULE_ROOT, "data", ...segments);
}

/**
 * Reads a data file that may be user state or shipped with the build.
 *
 * Home wins: a developer who rebuilt the gazetteer should get their version.
 * The shipped copy is the fallback an installed app depends on, because its
 * home starts empty and nothing on that machine can generate these files.
 */
export async function readDataFile(...segments: string[]): Promise<string> {
  try {
    return await readFile(dataFile(...segments), "utf-8");
  } catch {
    return readFile(shippedDataFile(...segments), "utf-8");
  }
}
