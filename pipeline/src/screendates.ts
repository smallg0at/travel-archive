import { getAccessToken } from "./auth.js";
import { backfillScreenDates } from "./jobs/screenDates.js";
import { withArchiveLock } from "./lock.js";

/**
 * Gives every described screenshot its day.
 *
 *   npm run --workspace pipeline screens:dates
 *
 * The descriptions say what kind of screen a photograph is; this adds the day
 * it belongs to, so a search can group it with the rest of that day. It reads
 * the shards from the mirror and rewrites one file — no model, no cost, and
 * nothing to undo if it is run twice.
 */
async function main(): Promise<void> {
  const token = await getAccessToken();
  const result = await backfillScreenDates(token, ({ message }) => {
    if (message) console.log(message);
  });
  console.log(
    `${result.filled} of ${result.total} description(s) given their day` +
      (result.unmatched ? `; ${result.unmatched} name a photograph this machine has no record of` : "") +
      ".",
  );
}

await withArchiveLock("screen dates", main);
