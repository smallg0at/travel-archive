import { runScan, type Range } from "./jobs/scan.js";
import { ArchiveBusyError, releaseLockOnExit, withArchiveLock } from "./lock.js";
import { env } from "./env.js";

/**
 * CLI front end for the free indexing pass. The work itself lives in
 * jobs/scan.ts so that `pipeline serve` runs exactly the same code — see the
 * note there, and ./analyze.ts for the same split.
 *
 *   npm run --workspace pipeline scan
 *   npm run --workspace pipeline scan -- --from 2025-01 --to 2026-12
 *
 * Costs nothing: Graph listing calls only, no photo downloads and no model
 * calls. Rescanning never discards AI work — see `merge` in jobs/scan.ts.
 */

function parseArgs(): Range {
  const args = process.argv.slice(2);
  const valueOf = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
  };
  return {
    from: valueOf("--from") ?? env.scanFrom,
    to: valueOf("--to") ?? env.scanTo,
  };
}

async function runMain() {
  await runScan(parseArgs(), (p) => {
    if (p.message) console.log(p.message);
  });
}

/**
 * Refuses to start while another writer holds the archive — see lock.ts.
 * The whole command is one critical section: an interrupted half-write is
 * the failure this exists to prevent.
 */
async function main() {
  releaseLockOnExit();
  await withArchiveLock("scan (CLI)", runMain);
}

main().catch((err) => {
  // A busy archive is an expected outcome, not a crash: print the reason,
  // not a stack trace the user has to read past.
  if (err instanceof ArchiveBusyError) {
    console.error(`
${err.message}
`);
    process.exit(2);
  }
  console.error(err);
  process.exit(1);
});
