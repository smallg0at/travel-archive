import { getAccessToken } from "./auth.js";
import { loadIndexForReading } from "./archiveStore.js";
import { buildHomeIndex } from "./jobs/homeIndex.js";
import { withArchiveLock } from "./lock.js";

/**
 * Builds `home.json` on its own.
 *
 *   npm run --workspace pipeline home
 *
 * The map index is normally written at the end of an organize, beside the
 * search index. But organize is the expensive pass — after a batch of new
 * captions it had 305 stale days to rewrite, and none of that is needed to
 * draw a map of coordinates that were read during the scan.
 *
 * So this exists for the two cases where the map should be rebuilt without
 * paying for anything: the first build, and any time shards have been
 * re-placed (`npm run places`) without summaries changing.
 *
 * Reads shards and writes one derived file, so it takes the lock like every
 * other pass that touches the archive.
 */
async function main(): Promise<void> {
  const token = await getAccessToken();
  // The index is read for its month list alone, and the shards come from the
  // mirror already (buildHomeIndex → loadAllShards), so read it from the mirror
  // too rather than pulling 3.7MB back out of OneDrive for a derived file.
  const index = await loadIndexForReading(token);
  const result = await buildHomeIndex(token, index, ({ message }) => {
    if (message) console.log(message);
  });
  console.log(`${result.places} place(s), ${result.countries} countries, ${result.placed} photo(s) placed.`);
}

await withArchiveLock("home", main);
