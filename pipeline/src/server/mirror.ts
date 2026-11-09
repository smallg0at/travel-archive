/**
 * Reading the archive mirror, and topping it up from OneDrive when it is short.
 *
 * The invariant these functions exist for: this server is the archive's only
 * writer, so its `data/` mirror holds the same bytes as OneDrive. A read should
 * therefore go to disk, in milliseconds, rather than download 2.4MB to answer a
 * five-number question. The exception is a machine that has never scanned —
 * there the mirror is empty while the account's OneDrive holds a whole archive,
 * so one file at a time is fetched and written back.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ArchiveIndexFile, ArchiveStatus } from "@travel-archive/shared";
import { dataFile } from "../paths.js";
import { getCachedAccessToken } from "../auth.js";
import { downloadMetadataJson } from "../graph.js";
import { withArchiveLock } from "../lock.js";
import { env } from "../env.js";
import { loadIndex } from "../archiveStore.js";
import * as jobs from "./jobs.js";

/**
 * Totals for the Settings page, from the local mirror.
 *
 * This used to call `loadIndex(token)`, which downloads the whole of
 * `index.json` from OneDrive — **2.5MB, measured at 1,043-1,762ms** — to report
 * five counts. `/archive/index` below already established that the mirror holds
 * identical bytes because this server is the only writer; the same reasoning
 * applies here, and reading it locally parses in **8-11ms**.
 *
 * `signedIn` still comes from the token, since it describes the session rather
 * than the archive, and it is a cache lookup (~2ms) rather than a round trip.
 * The Graph path stays as the fallback for a machine that has never scanned.
 */
export async function archiveStatus(): Promise<ArchiveStatus> {
  const token = await getCachedAccessToken();
  if (!token) {
    return {
      signedIn: false,
      schemaVersion: 0,
      months: [],
      totals: { photos: 0, analyzable: 0, analyzed: 0, days: 0, sections: 0 },
    };
  }

  const local = await readLocalJson("index.json");
  const index = local ? (JSON.parse(local) as ArchiveIndexFile) : await loadIndex(token);
  const months = index.months.map((m) => ({
    month: m.month,
    photoCount: m.photoCount,
    representativeCount: m.representativeCount,
    analyzedCount: m.analyzedCount,
  }));

  return {
    signedIn: true,
    schemaVersion: index.schemaVersion,
    months,
    totals: {
      photos: months.reduce((n, m) => n + m.photoCount, 0),
      analyzable: months.reduce((n, m) => n + m.representativeCount, 0),
      analyzed: months.reduce((n, m) => n + m.analyzedCount, 0),
      days: index.sections.reduce((n, s) => n + s.days.length, 0),
      sections: index.sections.length,
    },
  };
}

/**
 * Reads a file from the archive mirror without parsing it — the app is going to
 * parse it anyway, and `index.json` is 2.4MB.
 */
export async function readLocalJson(relative: string): Promise<string | null> {
  try {
    return await readFile(dataFile(relative), "utf-8");
  } catch {
    return null;
  }
}

/**
 * A metadata file from the mirror — and when the mirror does not have it yet,
 * from OneDrive, written into the mirror on the way back.
 *
 * The mirror is filled by the pipeline, so a machine that has never run a scan
 * or a sync has an empty one even when the account's OneDrive holds a whole
 * archive. That state used to fall through to the *reader's* own Graph fetch,
 * which needs the reader's Microsoft sign-in: an install pointed at an existing
 * archive therefore asked the owner to sign in twice, with the server already
 * signed in and perfectly able to answer. Measured 2026-10-14 on the installed
 * build — empty mirror, `GET /archive/index` 404, the reader showed the sign-in
 * banner while `/health` said `signedIn: true`.
 *
 * Skipped while a job runs, because a job is the mirror's other writer, and the
 * write takes the archive lock so a CLI run sharing the home cannot be trodden
 * on. Any failure returns null, which is exactly what this route did before:
 * the reader falls back to Graph, and on a phone that is the normal path.
 */
export async function mirrorOrFetch(relative: string): Promise<string | null> {
  const local = await readLocalJson(relative);
  if (local) return local;
  if (jobs.runningJob()) return null;

  const token = await getCachedAccessToken();
  if (!token) return null;

  try {
    const doc = await downloadMetadataJson<unknown>(token, env.metadataFolder, relative);
    if (doc === null) return null;
    const text = JSON.stringify(doc, null, 2);
    await withArchiveLock(`mirror ${relative}`, async () => {
      await mkdir(dirname(dataFile(relative)), { recursive: true });
      await writeFile(dataFile(relative), text, "utf-8");
    });
    return text;
  } catch (err) {
    console.log(`mirror: ${relative} not fetched: ${(err as Error).message}`);
    return null;
  }
}
