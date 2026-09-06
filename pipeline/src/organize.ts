import { runOrganize } from "./jobs/organize.js";
import { ArchiveBusyError, releaseLockOnExit, withArchiveLock } from "./lock.js";
import { env } from "./env.js";

/**
 * CLI front end for day summaries. The work lives in jobs/organize.ts so that
 * `pipeline serve` runs exactly the same code — see the note in jobs/analyze.ts.
 *
 *   npm run --workspace pipeline organize
 *   npm run --workspace pipeline organize -- --only 2026-09      # one month
 *   npm run --workspace pipeline organize -- --only 2026-09-01   # one day
 *   npm run --workspace pipeline organize -- --only 2026-09-01 --force
 *
 * Without `--only` every day is considered, but only days whose summarized
 * photo set actually changed are sent to the model, so re-running is cheap.
 */

function parseArgs(): { only: string | null; force: boolean } {
  const args = process.argv.slice(2);
  const i = args.indexOf("--only");
  return { only: i >= 0 && args[i + 1] ? args[i + 1] : null, force: args.includes("--force") };
}

async function runMain() {
  const opts = parseArgs();
  console.log(`Using AI provider: ${env.aiProvider}`);
  if (opts.only) console.log(`Restricted to ${opts.only}.`);
  if (opts.force) console.log("Forcing resummary — ignoring the unchanged check.");

  const result = await runOrganize(opts, (p) => {
    if (p.message) console.log(p.message);
  });

  console.log(
    `\nOrganized ${result.days} day(s) into ${result.trips} defined trip(s) and ${result.months} month bucket(s).`,
  );
  console.log(`${result.summarized} summarized this run, ${result.reused} left as they were.`);
  if (result.withheld > 0) console.log(`${result.withheld} photo(s) withheld from summaries by a redaction flag.`);
}

/**
 * Refuses to start while another writer holds the archive — see lock.ts.
 * The whole command is one critical section: an interrupted half-write is
 * the failure this exists to prevent.
 */
async function main() {
  releaseLockOnExit();
  await withArchiveLock("organize (CLI)", runMain);
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
