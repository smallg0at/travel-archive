/**
 * Turns the GeoNames dumps into one small file the pipeline can load at
 * startup: every settlement of 500+ people, with its name in its own language,
 * in English, and in Simplified Chinese — the archive's two display languages.
 *
 * Why this exists: reverse geocoding used to go to Nominatim, one request a
 * second, which their usage policy restricts to 4 a minute for anything that
 * runs on a schedule (operations.osmfoundation.org/policies/nominatim). A
 * library-wide pass is exactly that, so the lookup moved offline.
 *
 * Inputs, downloaded into pipeline/data/geo (see README there):
 *   cities500.txt          185k settlements: position, population, country
 *   alternateNamesV2.txt   every name in every language, with language codes
 *   countryInfo.txt        which languages a country actually speaks
 *
 * Output: places.tsv — about 10MB, which is the whole point of the trim: the
 * alternate-names dump is 1.4GB and 99% of it is languages nobody here reads.
 *
 * Run with: npm run geo:build --workspace pipeline
 */
import { createReadStream } from "node:fs";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const GEO = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "geo");
const CITIES = join(GEO, "cities500.txt");
const ALTERNATES = join(GEO, "alternateNamesV2.txt");
const COUNTRIES = join(GEO, "countryInfo.txt");
const OUT = join(GEO, "places.tsv");
const COUNTRIES_OUT = join(GEO, "countries.tsv");

/** Simplified Chinese, in the order we would rather have it. */
const ZH = ["zh-Hans", "zh-CN", "zh", "zh-SG"];

function countryLanguages() {
  const langs = new Map();
  const names = new Map();
  /** geonameid of the country itself -> its ISO code, so its own names can be picked up too. */
  const countryIds = new Map();
  for (const line of readFileSync(COUNTRIES, "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const f = line.split("\t");
    if (f.length < 17) continue;
    const [iso, , , , country] = f;
    names.set(iso, country);
    // "de-AT,hr,sl,hu" — the first is the one the place writes its own name in.
    const first = (f[15] ?? "").split(",")[0] ?? "";
    langs.set(iso, first.split("-")[0].toLowerCase());
    if (f[16]) countryIds.set(f[16], iso);
  }
  return { langs, names, countryIds };
}

function readCities() {
  const rows = new Map();
  for (const line of readFileSync(CITIES, "utf8").split("\n")) {
    if (!line) continue;
    const f = line.split("\t");
    rows.set(f[0], { lat: f[4], lon: f[5], cc: f[8], pop: Number(f[14]) || 0, name: f[1] });
  }
  return rows;
}

/** Keeps the best candidate per language: preferred beats short beats first seen. */
function better(current, rank) {
  return !current || rank < current.rank;
}

async function main() {
  const { langs, names, countryIds } = countryLanguages();
  const cities = readCities();
  console.log(`cities: ${cities.size}, countries: ${langs.size}`);
  console.log(`alternate names: ${(statSync(ALTERNATES).size / 1e9).toFixed(2)}GB — streaming`);

  const picked = new Map(); // geonameid -> {local, en, zh}
  let seen = 0;
  const rl = createInterface({ input: createReadStream(ALTERNATES, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (++seen % 5_000_000 === 0) console.log(`  ${(seen / 1e6).toFixed(0)}M rows`);
    const f = line.split("\t");
    const city = cities.get(f[1]);
    const countryIso = countryIds.get(f[1]);
    if (!city && !countryIso) continue;
    // 6 colloquial, 7 historic: a nickname or a name the place used to have is
    // not what a caption should call it.
    if (f[6] === "1" || f[7] === "1") continue;
    const iso = (f[2] ?? "").toLowerCase();
    if (!iso) continue;
    const value = f[3];
    if (!value) continue;
    // 4 preferred, 5 short. Countries put short first: GeoNames' preferred name
    // for Germany is "Bundesrepublik Deutschland", and a photo was taken in
    // Deutschland.
    const rank = countryIso
      ? f[5] === "1"
        ? 0
        : f[4] === "1"
          ? 1
          : 2
      : f[4] === "1"
        ? 0
        : f[5] === "1"
          ? 1
          : 2;

    let slot = picked.get(f[1]);
    if (!slot) picked.set(f[1], (slot = {}));
    const local = langs.get(city ? city.cc : countryIso);
    if (local && iso.split("-")[0] === local && better(slot.local, rank)) slot.local = { value, rank };
    if (iso.split("-")[0] === "en" && better(slot.en, rank)) slot.en = { value, rank };
    const zhIndex = ZH.findIndex((z) => z.toLowerCase() === iso);
    if (zhIndex >= 0 && better(slot.zh, zhIndex * 3 + rank)) slot.zh = { value, rank: zhIndex * 3 + rank };
  }

  const out = ["lat\tlon\tcc\tpop\tlocal\ten\tzh"];
  let withZh = 0;
  let withLocal = 0;
  for (const [id, city] of cities) {
    const slot = picked.get(id) ?? {};
    // GeoNames' own `name` is the English exonym more often than not, so it is
    // the fallback for both, and an empty column means "same as local".
    const local = slot.local?.value ?? city.name;
    const en = slot.en?.value ?? city.name;
    const zh = slot.zh?.value ?? "";
    if (slot.local) withLocal++;
    if (zh) withZh++;
    out.push([city.lat, city.lon, city.cc, city.pop, local, en === local ? "" : en, zh === local ? "" : zh].join("\t"));
  }
  writeFileSync(OUT, out.join("\n"), "utf8");
  console.log(`wrote ${OUT} — ${(statSync(OUT).size / 1e6).toFixed(1)}MB`);
  console.log(`  own-language name: ${withLocal}, Chinese name: ${withZh}, of ${cities.size}`);

  // Countries, the second half of every place string ("a city, Österreich").
  const countries = ["cc\tlocal\ten\tzh"];
  for (const [id, iso] of countryIds) {
    const slot = picked.get(id) ?? {};
    // countryInfo's own column, not the alternates: it is already the everyday
    // short form ("United Kingdom", "Germany"), where the alternates offer both
    // "Great Britain" and "Bundesrepublik Deutschland" and no way to rank them.
    const en = names.get(iso) ?? slot.en?.value ?? iso;
    // Where the country speaks English, that column is also its own name.
    const local = langs.get(iso) === "en" ? en : (slot.local?.value ?? en);
    countries.push([iso, local, en, slot.zh?.value ?? ""].join("\t"));
  }
  writeFileSync(COUNTRIES_OUT, countries.join("\n"), "utf8");
  console.log(`wrote ${COUNTRIES_OUT} — ${countryIds.size} countries`);
}

await main();
