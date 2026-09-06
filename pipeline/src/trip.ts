import { runTrip, readDocument } from "./jobs/trip.js";
import { ArchiveBusyError, releaseLockOnExit, withArchiveLock } from "./lock.js";
import { env } from "./env.js";

/**
 * Writes the story of one trip over a date range you choose.
 *
 *   npm run --workspace pipeline trip -- --from 2026-08-30 --to 2026-09-02
 *   npm run --workspace pipeline trip -- --from 2026-08-30 --to 2026-09-02 --name "a city & a city"
 *   npm run --workspace pipeline trip -- --from ... --to ... --notes "flew out Saturday night"
 *   npm run --workspace pipeline trip -- --from ... --to ... --doc plan.md --doc tickets.txt
 *
 * Leave `--name` off and the model proposes one. The range is written to
 * pipeline/trips.json so `organize` keeps those days grouped afterwards.
 *
 * Run `organize` first: this reads day summaries, it does not create them.
 */

async function runMain() {
  const args = process.argv.slice(2);
  const valueOf = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
  };
  const allOf = (flag: string): string[] =>
    args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));

  const startDate = valueOf("--from");
  const endDate = valueOf("--to");
  if (!startDate || !endDate) {
    console.error("Usage: trip -- --from YYYY-MM-DD --to YYYY-MM-DD [--name ...] [--notes ...] [--doc file]");
    process.exit(1);
  }

  console.log(`Using AI provider: ${env.aiProvider}`);
  const documents = await Promise.all(allOf("--doc").map(readDocument));
  if (documents.length) console.log(`Loaded ${documents.length} document(s).`);

  const result = await runTrip(
    { startDate, endDate, name: valueOf("--name"), notes: valueOf("--notes"), documents },
    (p) => {
      if (p.message) console.log(p.message);
    },
  );

  console.log(`\n${result.days} day(s), ${result.narrativeChars} chars, ${result.places} place(s) listed.`);
}

/**
 * Refuses to start while another writer holds the archive — see lock.ts.
 * The whole command is one critical section: an interrupted half-write is
 * the failure this exists to prevent.
 */
async function main() {
  releaseLockOnExit();
  await withArchiveLock("trip (CLI)", runMain);
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
