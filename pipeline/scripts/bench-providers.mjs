// A/B and cross-provider benchmark for the two model tasks the pipeline runs:
// photo captioning (analyze) and day summary (organize). Read-only against the
// archive: it downloads photo bytes from OneDrive to caption them, calls the
// provider, and writes nothing — no shard, no index, no index.json.
//
//   node scripts/bench-providers.mjs --provider gemini  [--n 6] [--days 1]
//   node scripts/bench-providers.mjs --provider deepseek [--n 6] [--days 1]
//
// Two questions at once:
//
//  1. **Does a venue hint help?** `CaptionContext.venue` has been dead since the
//     offline gazetteer replaced Nominatim (2ffeefe) — nothing writes
//     `photo.near`, so the prompt line `Nearest named place on the map…` never
//     fires. This reruns the same call with that field filled from the photo's
//     own OCR, which is a stand-in for what an OSM/GeoNames-POI source (option
//     B) would supply: same shape, honest ground truth, no external lookup.
//     Scored as "did the caption name the thing".
//  2. **Gemini vs DeepSeek** on both tasks. Run the script once per provider;
//     selection is data-driven and sorted, so both runs see identical inputs.
//
// Budget: cap the number of Gemini calls (see MAX_GEMINI_CALLS) and print the
// usage every call reports. Nothing here is logged anywhere else.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

/** Gemini must stay under ~£1 of spend; this is the hard stop. */
const MAX_GEMINI_CALLS = 40;

const providerName = arg("provider", process.env.AI_PROVIDER ?? "deepseek");
const n = Number(arg("n", "6"));
const days = Number(arg("days", "1"));

// Before anything that reads env: `env.ts` resolves AI_PROVIDER at import, and
// ESM hoists static imports — so dist must be imported dynamically from here.
process.env.AI_PROVIDER = providerName;
const { initProxyDispatcher } = await import("../dist/proxy.js");
const { getProvider } = await import("../dist/providers/index.js");
const { captionContextFor, contextSources } = await import("../dist/jobs/analyze.js");
const { getAccessToken } = await import("../dist/auth.js");
const { downloadPhotoBuffer } = await import("../dist/graph.js");

// Honour .env's PROXY_* (AI_MODE=system, GRAPH_MODE=direct) the way `serve.ts`
// does. Without it this script runs AI calls direct, which is a wall hit on
// generativelanguage.googleapis.com — DeepSeek passing proves nothing about
// that, its endpoint is domestic.
initProxyDispatcher();

const provider = getProvider();
console.log(`provider: ${providerName}  n=${n}  days=${days}`);

/* ---------- the local archive (read-only) -------------------------------- */

const dataDir = path.join(ROOT, "..", "data");
const index = JSON.parse(readFileSync(path.join(dataDir, "index.json"), "utf8"));
const sources = contextSources(index);

/** Photo record by id, across every month shard. */
const photos = new Map();
for (const f of readdirSync(path.join(dataDir, "photos")).filter((f) => f.endsWith(".json"))) {
  const shard = JSON.parse(readFileSync(path.join(dataDir, "photos", f), "utf8"));
  for (const [id, p] of Object.entries(shard.photos ?? {})) photos.set(id, p);
}

/** A proper noun from the photo's own OCR — the name a POI source would give. */
const STOPWORDS = new Set(
  "the and for with from this that are was were not you your photo picture image screenshot when what where which their there these those some more than about after before".split(
    /\s+/,
  ),
);
/**
 * First mid-sentence capitalised word of length ≥6 that the photo's existing
 * caption did not already name.
 *
 * Mid-sentence matters: the first pass picked up sentence-initial "What's" and
 * "English" as the "landmark", and no model is ever going to name those —
 * the test was measuring nothing. Excluding anything the caption already says
 * keeps the question honest: "the sign says X and the model did not; does it
 * now, with the hint?"
 */
function targetName(text, caption) {
  const c = (caption ?? "").toLowerCase();
  let previous = "";
  for (const m of text.matchAll(/\b([A-Z][A-Za-z'’-]{5,})\b/g)) {
    const word = m[1];
    const lc = word.toLowerCase();
    if (STOPWORDS.has(lc)) continue;
    if (c.includes(lc)) continue;
    // Sentence start: nothing before it, or it follows a terminator.
    if (previous === "" || /[.!?\n]/.test(previous)) {
      previous = m[0];
      continue;
    }
    return word;
  }
  return null;
}

function mediaType(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf.length >= 6 && buf.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  if (buf.length >= 12 && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "image/jpeg";
}

/** Words of a stop title worth looking for — a real name from a real trip. */
const TITLE_STOP = new Set(
  "the and of from to in at a by for with on its his her end day from transit to via over under around".split(/\s+/),
);
const titleWords = (t) => (t.match(/[A-Za-z'’-]{4,}/g) ?? []).filter((w) => !TITLE_STOP.has(w.toLowerCase()));

/** photoId → the day's stop it belongs to, straight out of index.json. */
const stopOf = new Map();
for (const section of index.sections) {
  const trip = section.kind === "trip" ? section.name : null;
  for (const day of section.days) {
    for (const seg of day.segments ?? []) {
      for (const id of seg.photoIds) {
        stopOf.set(id, { title: seg.title ?? "", date: day.date, place: day.place ?? null, trip });
      }
    }
  }
}

/**
 * Deterministic pick, now grounded in a real stop name rather than whatever
 * capitalised word the OCR happened to open a sentence with.
 *
 * Three conditions, in order of what makes the test answerable: the name must
 * be **visible in this photo's OCR** (ground truth), must **not already be in
 * the photo's caption** (or the without-arm wins by construction), and the
 * photo must be small enough to fetch.
 */
const byStop = [...photos.values()]
  .map((p) => ({ p, stop: stopOf.get(p.id) }))
  .filter(({ p, stop }) => {
    if (!p.caption || p.video || (p.bytes ?? 0) > 2_000_000) return false;
    if (!stop?.title) return false;
    const words = titleWords(stop.title);
    if (!words.length) return false;
    const ocr = (p.extractedText ?? "").toLowerCase();
    if (!words.some((w) => ocr.includes(w.toLowerCase()))) return false;
    const longest = [...words].sort((a, b) => b.length - a.length)[0];
    return !(p.caption ?? "").toLowerCase().includes(longest.toLowerCase());
  })
  .sort((a, b) => (a.p.takenAt ?? "").localeCompare(b.p.takenAt ?? "") || a.p.id.localeCompare(b.p.id));

const targets = byStop.slice(0, n);

console.log(`photos whose OCR carries their stop's name and whose caption does not: ${byStop.length}`);

/* ---------- stage 1: captioning, with and without a venue hint ---------- */

let geminiCalls = 0;
const spend = () => {
  if (providerName !== "gemini") return;
  if (++geminiCalls > MAX_GEMINI_CALLS) {
    console.error(`refusing: ${MAX_GEMINI_CALLS} gemini calls in one run (budget)`);
    process.exit(2);
  }
};

function mediaTypeOf(buf) {
  return mediaType(buf);
}

async function captionPhotoWith(record, venue) {
  let token;
  try {
    token = await tokenPromise;
  } catch (err) {
    console.error(`  cannot reach OneDrive: ${err.message}`);
    return null;
  }
  let bytes;
  try {
    bytes = await downloadPhotoBuffer(token, record.id);
  } catch (err) {
    console.error(`  download failed for ${record.id}: ${err.message}`);
    return null;
  }
  const context = captionContextFor(record, sources);
  const withVenue = context ? { ...context, venue } : { takenAt: null, trip: null, place: null, venue, street: null, dayNote: null, isVideo: false };
  spend();
  try {
    return await provider.captionPhoto({ imageBase64: bytes.toString("base64"), mediaType: mediaTypeOf(bytes), context: withVenue });
  } catch (err) {
    console.error(`  captionPhoto failed: ${err.message}`);
    return null;
  }
}

const tokenPromise = (() => {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("no cached pipeline token — run the pipeline once to sign in")), 45_000).unref(),
  );
  return Promise.race([getAccessToken(), timeout]);
})();

console.log("\n=== stage 1: photo captioning (with / without a venue hint) ===");
const rows = [];
for (const { p, stop } of targets) {
  const words = titleWords(stop.title);
  // Score on the *most distinctive* word only. "Any title word" let "museum"
  // count for "National Museum of China", and both arms win that trivially —
  // this is the word verified absent from the photo's existing caption.
  const key = [...words].sort((a, b) => b.length - a.length)[0];
  const without = await captionPhotoWith(p, null);
  // The venue hint is the stop's own name — exactly what an OSM/GeoNames-POI
  // source (option B) would have supplied at those coordinates.
  const withVenue = await captionPhotoWith(p, stop.title);
  const named = (r) => !!r?.caption && r.caption.toLowerCase().includes(key.toLowerCase());
  rows.push({ stop: stop.title, key, without: named(without), with: named(withVenue) });
  console.log(`  ${stop.title} (${stop.date}) → key="${key}"  without=${named(without)}  with=${named(withVenue)}`);
  if (without?.usage)
    console.log(
      `     usage: in=${without.usage.promptTokens} out=${without.usage.outputTokens} think=${without.usage.thoughtsTokens ?? 0}`,
    );
}

const changed = rows.filter((r) => r.without !== r.with);
console.log(
  `\n  named the thing:  without=${rows.filter((r) => r.without).length}/${rows.length}   with=${rows.filter((r) => r.with).length}/${rows.length}`,
);
console.log(
  changed.length
    ? `  verdict: ${changed.length} of ${rows.length} changed — a venue hint moves this sample`
    : `  verdict: 0 of ${rows.length} changed — a venue hint buys nothing on this sample`,
);

/* ---------- stage 2: day summary ---------------------------------------- */

/** The most recent day that actually has segments, so the input is non-trivial. */
const dayRecords = index.sections.flatMap((s) => s.days).filter((d) => (d.segments?.length ?? 0) > 0);
const chosen = dayRecords.sort((a, b) => b.date.localeCompare(a.date)).slice(0, days);

console.log("\n=== stage 2: day summary ===");
for (const day of chosen) {
  const input = {
    date: day.date,
    place: day.place ?? null,
    timeUncertain: false,
    placeFromMetadataOnly: false,
    note: day.note ?? null,
    stops: day.segments.map((seg) => ({
      id: seg.id,
      kind: seg.kind,
      startTime: seg.startTime,
      endTime: seg.endTime,
      photos: seg.photoIds
        .map((id) => photos.get(id))
        .filter((p) => p && p.caption)
        .map((p) => ({ id: p.id, caption: p.caption, tags: p.tags ?? [], contentType: p.contentType })),
    })),
  };
  if (!input.stops.some((s) => s.photos.length)) {
    console.log(`  ${day.date}: no captioned photos, skipped`);
    continue;
  }
  spend();
  try {
    const out = await provider.summarizeDay(input);
    console.log(`\n  ${day.date} · place=${input.place ?? "—"} · photos=${input.stops.reduce((n, s) => n + s.photos.length, 0)}`);
    console.log(`  --- ${providerName} summary ---`);
    console.log("  " + (out.summary ?? "").split("\n").join("\n  "));
    console.log(`  --- segments: ${out.segments.length} ---`);
    for (const s of out.segments) console.log(`  · ${s.title}: ${(s.summary ?? "").slice(0, 140)}`);
    if (out.usage) console.log(`  usage: in=${out.usage.promptTokens} out=${out.usage.outputTokens} think=${out.usage.thoughtsTokens ?? 0}`);
  } catch (err) {
    console.error(`  summarizeDay failed: ${err.message}`);
  }
}

if (providerName === "gemini") console.log(`\ngemini calls this run: ${geminiCalls} (cap ${MAX_GEMINI_CALLS})`);
