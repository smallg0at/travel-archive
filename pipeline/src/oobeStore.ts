/**
 * What setup has confirmed about this archive — machine-level, beside
 * `sync.json` and `prefs.json`.
 *
 * Today only one fact lives here: that a human has laid eyes on the photo
 * folder and agreed it is the right one. It is what releases the first scan
 * (the timer refuses to start a fresh archive without it), so an archive that
 * has never been set up scans nothing and says so, instead of either looping
 * on a 404 or quietly building an index of the default path.
 *
 * The writer arrives with the setup wizard's folder step; until then the file
 * simply does not exist, which reads as "nothing confirmed" — the same
 * absent-is-legitimate contract `syncStore` keeps.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dataDir, dataFile } from "./paths.js";

const FILE = "oobe.json";

export interface OobeFile {
  /** ISO timestamp of the folder confirmation, or unset when none happened. */
  photosFolderValidatedAt?: string;
}

let cached: OobeFile | null = null;

export async function readOobe(): Promise<OobeFile> {
  if (cached) return cached;
  try {
    cached = JSON.parse(await readFile(dataFile(FILE), "utf-8")) as OobeFile;
  } catch {
    // Absent or corrupt both mean "nothing confirmed yet", which is where a
    // fresh install starts.
    cached = {};
  }
  return cached;
}

/** Records a confirmation. Written once per setup run; same shape as `writeSync`. */
export async function writeOobe(patch: Partial<OobeFile>): Promise<OobeFile> {
  const next = { ...(await readOobe()), ...patch };
  cached = next;
  await mkdir(dataDir(), { recursive: true });
  await writeFile(dataFile(FILE), `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return next;
}
