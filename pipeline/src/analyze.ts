import { planAnalyze, runAnalyze, type AnalyzeOptions } from "./jobs/analyze.js";
import { ArchiveBusyError, releaseLockOnExit, withArchiveLock } from "./lock.js";
import { env } from "./env.js";

/**
 * CLI front end for the AI pass. The work itself lives in jobs/analyze.ts so
 * that `pipeline serve` runs exactly the same code — see the note there.
 *
 *   npm run --workspace pipeline analyze -- --month 2025-04
 *   npm run --workspace pipeline analyze -- --from 2026-09-01 --to 2026-09-03
 *   npm run --workspace pipeline analyze -- --from 2026-09-01 --to 2026-09-03 --limit 20
 *
 * Ranges are inclusive and accept either a month (`2025-04`) or a day
 * (`2026-09-01`), so a trip can be analyzed without dragging in the rest of
 * its month.
 *
 * Re-running is safe: photos that already have a caption are skipped, and each
 * month's shard is written as soon as it finishes, so an interrupted run keeps
 * everything it completed.
 */

function parseArgs(): AnalyzeOptions & { yes: boolean } {
  const args = process.argv.slice(2);
  const valueOf = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
  };

  const month = valueOf("--month");
  return {
    from: month ?? valueOf("--from"),
    to: month ?? valueOf("--to"),
    limit: Number(valueOf("--limit") ?? Number.MAX_SAFE_INTEGER),
    yes: args.includes("--yes"),
  };
}

async function runMain() {
  const opts = parseArgs();
  console.log(`Provider: ${env.aiProvider} (${env.aiProvider === "gemini" ? env.geminiModel : env.anthropicModel})`);

  // Printed rather than silently spent: this is the only step that costs money.
  // No early return when the count is zero: runAnalyze still sweeps for photos
  // that have coordinates but no place, which is how one skipped as gpsSuspect
  // on an earlier run finally gets located.
  const plan = await planAnalyze(opts);
  if (plan.total > 0) {
    console.log(`\n${plan.total} photo(s) to analyze across ${plan.months.length} month(s).`);
    console.log(
      `Estimated ~${(plan.estimatedInputTokens / 1e6).toFixed(2)}M input, ~${(plan.estimatedOutputTokens / 1e6).toFixed(2)}M output tokens.`,
    );
    for (const m of plan.months) console.log(`  ${m.month}: ${m.count}`);
    console.log("");
  }

  let lastDone = -1;
  const result = await runAnalyze(opts, (p) => {
    if (p.message) console.log(`  ${p.message}`);
    // Only every 25th, to keep a 5,000-photo run readable in a terminal; the
    // job server takes the same events at their full rate.
    if (p.done !== undefined && p.done > 0 && p.done !== lastDone && p.done % 25 === 0) {
      lastDone = p.done;
      console.log(`  ${p.done}/${p.total}`);
    }
  });

  console.log(
    `\nAnalyzed ${result.analyzed} photo(s)${result.failed ? `, ${result.failed} failed` : ""} — ` +
      `${result.inherited} inherited by duplicates, ${result.geocoded} geocoded.`,
  );
  console.log(`Run "npm run --workspace pipeline organize" to fold them into day pages.`);
}

/**
 * Refuses to start while another writer holds the archive — see lock.ts.
 * The whole command is one critical section: an interrupted half-write is
 * the failure this exists to prevent.
 */
async function main() {
  releaseLockOnExit();
  await withArchiveLock("analyze (CLI)", runMain);
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
