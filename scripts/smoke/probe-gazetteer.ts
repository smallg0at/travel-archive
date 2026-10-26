/**
 * Answers one question against a *packaged* payload: can this install read the
 * offline gazetteer that is supposed to ship beside it?
 *
 * It is bundled by scripts/smoke-package.mjs and written into
 * `resources/pipeline/dist/`, so at run time `paths.ts` resolves its module
 * root to `resources/pipeline` — the same root the real server sees. Bundling
 * from source (rather than importing a file that is not shipped) is what makes
 * this a test of the payload instead of a test of the checkout.
 */
import { offlinePlace } from "../../pipeline/src/geocodeOffline.js";

const root = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

try {
  const place = await offlinePlace({ lat: 48.2082, lon: 16.3738 });
  console.log(
    `SMOKE ${JSON.stringify({
      root,
      place: place ? `${place.locality.en} / ${place.country.en}` : null,
    })}`,
  );
} catch (error) {
  console.log(`SMOKE ${JSON.stringify({ root, error: (error as Error).message })}`);
}
