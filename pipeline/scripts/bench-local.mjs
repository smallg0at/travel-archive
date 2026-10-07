#!/usr/bin/env node
/**
 * Local-model reliability bench: can an LM Studio model stand in for (or fill
 * in behind) the cloud model on the two tasks the pipeline runs — photo
 * captioning (`CaptionPhotoInput → CaptionResult`) and day summary
 * (`SummarizeDayInput → DaySummaryResult`)?
 *
 * **Read-only against the archive.** It reads `index.json` and the month
 * shards, pulls each photo's 800px `large` thumbnail from the on-disk cache
 * (`data/thumbs/`) or, when that misses, from Graph, calls the provider, and
 * writes only under `data/bakeoff/local-<date>/`. No shard, no index, no
 * `index.json` is written. The cloud baseline is the caption, OCR and day
 * summary **already stored in the archive**, so comparing against Gemini costs
 * nothing — no Gemini call is made at all.
 *
 *   node scripts/bench-local.mjs --provider lmstudio \
 *       --base-url http://127.0.0.1:1234/v1 --model google/gemma-4-e4b
 *
 *   node scripts/bench-local.mjs --n 12 --random 100 --days 3 --seed 20261007
 *   node scripts/bench-local.mjs --sets naming,doc      # resume subsets
 *
 * What it measures, each with its denominator and the cloud figure beside it:
 *
 *  - **caption schema** — ok / empty / errored, requests per photo (retries),
 *    `finish_reason` (a `length` is a truncation), median/p90 latency.
 *  - **naming** — photos whose own OCR carries a word from their day's stop
 *    title. Does the new caption name it, and how often did the cloud caption?
 *    (`--n`, default 12, of the whole pool.)
 *  - **document fidelity** — photos with cloud `extracted_text`. Word-set
 *    Jaccard of local vs cloud transcription, plus length ratio.
 *  - **random** — a seeded sample (`--random`, default 100): schema and style,
 *    plus a list of proper nouns the local caption introduced that are absent
 *    from the cloud caption, GPS place, stop title, OCR and tags — the
 *    hallucination candidates for a human to read.
 *  - **determinism** — the same thumbnail twice; caption/tag/content-type
 *    agreement.
 *  - **day summary** — `--days` days that already have a cloud summary,
 *    rewritten locally; register violations are grepped from the same
 *    forbidden list `summarise.ts` / `tripPrompt` encode.
 *
 * Raw responses are kept in full (`raw-caption.json`, `raw-day.json`,
 * `sample.json`) so a number can always be traced back to the text that
 * produced it.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};

const providerName = arg("provider", "lmstudio");
const baseUrl = arg("base-url", process.env[`${providerName.toUpperCase()}_BASE_URL`] ?? "http://127.0.0.1:1234/v1");
const model = arg("model", process.env[`${providerName.toUpperCase()}_MODEL`] ?? "google/gemma-4-e4b");
const nNamed = Number(arg("n", "12"));
const nDoc = Number(arg("doc", String(nNamed)));
const nRandom = Number(arg("random", "100"));
const nDays = Number(arg("days", "3"));
const seed = Number(arg("seed", "20261007"));
const detN = Number(arg("determinism", "8"));
const batchN = Number(arg("batch", "6"));
/** The context the local server actually loaded a model with. Caption calls fit easily; a big day summary does not. */
const maxContext = Number(arg("max-context", "8192"));
const sets = new Set((arg("sets", "naming,doc,random,determinism,batch,days")).split(",").map((s) => s.trim()).filter(Boolean));
const date = new Date().toISOString().slice(0, 10);
const OUT = arg("out", path.join(ROOT, "..", "data", "bakeoff", `local-${date}`));

// Before anything that reads env: `env.ts` resolves AI_PROVIDER at import, and
// ESM hoists static imports — so dist must be imported dynamically from here.
// The endpoint keys are set the way `openAiConfig` reads them (`<ID>_BASE_URL`,
// `<ID>_MODEL`, and the preset's `apiKeyEnv`).
process.env.AI_PROVIDER = providerName;
const PREFIX = providerName.toUpperCase();
process.env[`${PREFIX}_BASE_URL`] = baseUrl;
process.env[`${PREFIX}_MODEL`] = model;
if (!process.env[`${PREFIX}_API_KEY`]) process.env[`${PREFIX}_API_KEY`] = "local";

const imp = (p) => import(pathToFileURL(path.join(ROOT, "..", "dist", p)).href);
const { initProxyDispatcher } = await imp("proxy.js");
const { getProvider } = await imp("providers/index.js");
const { captionContextFor, contextSources } = await imp("jobs/analyze.js");
const { getAccessToken } = await imp("auth.js");
const { downloadThumbnailBuffer } = await imp("graph.js");
const { readThumb } = await imp("thumbStore.js");
initProxyDispatcher();

/**
 * Every `chat/completions` response is copied aside before the provider reads
 * it. `CaptionResult` alone cannot say whether a reply was truncated, wrapped
 * in a fence, or needed a retry — the raw `finish_reason` and content length
 * can, and this is the one place to see them without touching the pipeline's
 * source. Read-only: `clone()` tees the body, the provider still consumes the
 * original.
 */
const RAW = [];
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (url, init) => {
  const res = await realFetch(url, init);
  if (String(url).includes("/chat/completions")) {
    try {
      const body = await res.clone().json();
      const choice = body?.choices?.[0];
      RAW.push({
        at: Date.now(),
        status: res.status,
        finish: choice?.finish_reason ?? null,
        contentLen: (choice?.message?.content ?? "").length,
        reasoningLen: (choice?.message?.reasoning_content ?? "").length,
        usage: body?.usage ?? null,
      });
    } catch {
      RAW.push({ at: Date.now(), status: res.status, finish: null, contentLen: -1, reasoningLen: 0, usage: null });
    }
  }
  return res;
};

const provider = getProvider();
console.log(`provider: ${providerName}  baseUrl=${baseUrl}  model=${model}`);
console.log(`seed=${seed}  n=${nNamed}  doc=${nDoc}  random=${nRandom}  days=${nDays}  sets=${[...sets].join(",")}`);
console.log(`out: ${OUT}\n`);

/* ---------- archive, read-only ------------------------------------------- */

const dataDir = path.join(ROOT, "..", "data");
const index = JSON.parse(readFileSync(path.join(dataDir, "index.json"), "utf8"));
const sources = contextSources(index);

const photos = new Map();
for (const f of readdirSync(path.join(dataDir, "photos")).filter((f) => f.endsWith(".json"))) {
  const shard = JSON.parse(readFileSync(path.join(dataDir, "photos", f), "utf8"));
  for (const [id, p] of Object.entries(shard.photos ?? {})) photos.set(id, p);
}

const TITLE_STOP = new Set(
  "the and of from to in at a by for with on its his her end day transit via over under around".split(/\s+/),
);
const titleWords = (t) => (t.match(/[A-Za-z'’-]{4,}/g) ?? []).filter((w) => !TITLE_STOP.has(w.toLowerCase()));

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

/** OneDrive is only needed for a thumbnail the on-disk cache does not hold. */
const tokenPromise = (() => {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("no cached pipeline token within 30s")), 30_000).unref(),
  );
  return Promise.race([getAccessToken(), timeout]);
})();
let token = null;
try {
  token = await tokenPromise;
  console.log("OneDrive: signed in (thumbnail cache misses can be fetched)");
} catch (err) {
  console.log(`OneDrive: unavailable (${err.message}) — cache-only, photos without a cached thumbnail are skipped`);
}

const mediaTypeOf = (buf) => {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf.length >= 6 && buf.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  if (buf.length >= 12 && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "image/jpeg";
};

async function imageFor(id) {
  const cached = await readThumb("large", id);
  if (cached) return { bytes: cached, source: "cache" };
  if (!token) return null;
  try {
    const buf = await downloadThumbnailBuffer(token, id);
    return buf ? { bytes: buf, source: "graph" } : null;
  } catch {
    return null;
  }
}

/* ---------- deterministic sampling --------------------------------------- */

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(seed);
const shuffled = (list) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// Camera photos with a stored caption and a fetchable size — the same shape the
// bake-off uses. Screenshots are excluded on purpose (privacy, and no cloud
// baseline for the ones the policy withholds).
const camera = [...photos.values()].filter(
  (p) => !p.video && p.caption && p.takenAt && (p.bytes ?? 0) <= 2_000_000 && p.screenshot !== true,
);

const namingPool = camera
  .map((p) => {
    const stop = stopOf.get(p.id);
    if (!stop?.title) return null;
    const ocr = (p.extractedText ?? "").toLowerCase();
    const present = titleWords(stop.title).filter((w) => ocr.includes(w.toLowerCase()));
    if (!present.length) return null;
    const key = [...present].sort((a, b) => b.length - a.length)[0];
    return { p, stop, key };
  })
  .filter(Boolean)
  .sort((a, b) => (a.p.takenAt ?? "").localeCompare(b.p.takenAt ?? "") || a.p.id.localeCompare(b.p.id));

const docPool = camera
  .filter((p) => (p.extractedText ?? "").trim().length >= 20)
  .sort((a, b) => a.id.localeCompare(b.id));

const randomPool = [...camera].sort((a, b) => a.id.localeCompare(b.id));
const randomPick = shuffled(randomPool).slice(0, nRandom);
const namingPick = shuffled(namingPool).slice(0, nNamed);
const docPick = shuffled(docPool).slice(0, nDoc);

console.log(`pools: naming=${namingPool.length}  doc=${docPool.length}  random=${randomPool.length}`);

/* ---------- the run ------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One caption call, with the raw HTTP it produced attached. */
async function runCaption(p, label) {
  const img = await imageFor(p.id);
  if (!img) return { label, id: p.id, fileName: p.fileName, ok: false, error: "no image (no cached thumbnail, Graph unavailable)" };
  const context = captionContextFor(p, sources);
  const before = RAW.length;
  const t0 = Date.now();
  let out = null;
  let err = null;
  try {
    out = await provider.captionPhoto({ imageBase64: img.bytes.toString("base64"), mediaType: mediaTypeOf(img.bytes), context });
  } catch (e) {
    err = e.message;
  }
  const raw = RAW.slice(before);
  return {
    label,
    id: p.id,
    fileName: p.fileName,
    takenAt: p.takenAt,
    bytes: p.bytes,
    imageSource: img.source,
    context,
    ms: Date.now() - t0,
    ok: !err && Boolean(out?.caption?.trim()),
    error: err,
    local: out,
    raw,
  };
}

const cloudOf = (p) => ({
  caption: p.caption ?? null,
  contentType: p.contentType ?? null,
  tags: p.tags ?? [],
  extractedText: p.extractedText ?? null,
  notable: Boolean(p.notable),
});

const run = async (label, p) => {
  const r = await runCaption(p, label);
  return { ...r, cloud: cloudOf(p) };
};

const results = { naming: [], doc: [], random: [], determinism: [], batch: null, days: [] };
const report = [];
const log = (line) => {
  console.log(line);
  report.push(line);
};
/** A long run must not lose what it has already paid for — flush raw results as it goes. */
const checkpoint = () => {
  try {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(path.join(OUT, "raw-caption.json"), JSON.stringify(results, null, 2));
    writeFileSync(path.join(OUT, "raw-day.json"), JSON.stringify(results.days, null, 2));
  } catch {
    /* a checkpoint is best effort; the final write is what matters */
  }
};

/* naming ------------------------------------------------------------------ */
if (sets.has("naming")) {
  console.log("\n=== naming set (OCR names the day's stop; does the caption?) ===");
  for (const { p, stop, key } of namingPick) {
    const r = await run("naming", p);
    r.key = key;
    r.stop = stop.title;
    r.cloudHit = Boolean(r.cloud.caption?.toLowerCase().includes(key.toLowerCase()));
    r.localHit = Boolean(r.local?.caption?.toLowerCase().includes(key.toLowerCase()));
    // The secondary, more forgiving reading: did the caption name *any* word of
    // the stop title, not only the longest? The key word alone can be a weak
    // name ("Making" from "Museum of Making").
    const words = titleWords(stop.title);
    r.cloudAny = words.some((w) => r.cloud.caption?.toLowerCase().includes(w.toLowerCase()));
    r.localAny = words.some((w) => r.local?.caption?.toLowerCase().includes(w.toLowerCase()));
    results.naming.push(r);
    console.log(
      `  ${r.ok ? "ok " : "BAD"} ${stop.title} (${stop.date}) key="${key}" cloud=${r.cloudHit} local=${r.localHit} ${r.ms}ms`,
    );
    await sleep(50);
  }
  checkpoint();
}

/* documents --------------------------------------------------------------- */
const tokens = (s) => (s ? s.toLowerCase().match(/[a-z0-9\u00c0-\u024f]+/g) ?? [] : []);
const jaccard = (a, b) => {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
};
if (sets.has("doc")) {
  console.log("\n=== document set (cloud extracted_text non-empty; transcription fidelity) ===");
  for (const p of docPick) {
    const r = await run("doc", p);
    const ct = tokens(r.cloud.extractedText);
    const lt = tokens(r.local?.extractedText);
    r.tokenJaccard = jaccard(ct, lt);
    r.cloudLen = (r.cloud.extractedText ?? "").length;
    r.localLen = (r.local?.extractedText ?? "").length;
    results.doc.push(r);
    console.log(
      `  ${r.ok ? "ok " : "BAD"} ${p.fileName} jaccard=${r.tokenJaccard.toFixed(2)} cloudLen=${r.cloudLen} localLen=${r.localLen} ${r.ms}ms`,
    );
    await sleep(50);
  }
  checkpoint();
}

/* random ------------------------------------------------------------------ */
if (sets.has("random")) {
  console.log("\n=== random set (seeded; schema, style, hallucination candidates) ===");
  for (let i = 0; i < randomPick.length; i++) {
    const p = randomPick[i];
    const r = await run("random", p);
    results.random.push(r);
    if ((i + 1) % 10 === 0) {
      console.log(`  ${i + 1}/${randomPick.length} ...`);
      checkpoint();
    }
    await sleep(50);
  }
}

/* determinism ------------------------------------------------------------- */
if (sets.has("determinism")) {
  console.log("\n=== determinism (same thumbnail twice) ===");
  for (const p of randomPick.slice(0, detN)) {
    const a = await run("determinism", p);
    const b = await run("determinism", p);
    const tagsJ = jaccard(tokens((a.local?.tags ?? []).join(" ")), tokens((b.local?.tags ?? []).join(" ")));
    results.determinism.push({
      id: p.id,
      fileName: p.fileName,
      captionSame: a.local?.caption === b.local?.caption,
      contentTypeSame: a.local?.contentType === b.local?.contentType,
      extractedSame: a.local?.extractedText === b.local?.extractedText,
      tagsJaccard: tagsJ,
      a: a.local?.caption ?? null,
      b: b.local?.caption ?? null,
    });
    console.log(
      `  ${p.fileName}: captionSame=${a.local?.caption === b.local?.caption} typeSame=${a.local?.contentType === b.local?.contentType} tagsJ=${tagsJ.toFixed(2)}`,
    );
    await sleep(50);
  }
  checkpoint();
}

/* batch ------------------------------------------------------------------- */
if (sets.has("batch")) {
  console.log(`\n=== batch throughput (${batchN} images in one captionPhotos call) ===`);
  const picks = randomPick.slice(0, batchN);
  const inputs = [];
  for (const p of picks) {
    const img = await imageFor(p.id);
    if (img) inputs.push({ imageBase64: img.bytes.toString("base64"), mediaType: mediaTypeOf(img.bytes), context: captionContextFor(p, sources) });
  }
  if (inputs.length && provider.captionPhotos) {
    const before = RAW.length;
    const t0 = Date.now();
    let out = null;
    let err = null;
    try {
      out = await provider.captionPhotos(inputs);
    } catch (e) {
      err = e.message;
    }
    results.batch = {
      requested: inputs.length,
      returned: out?.length ?? 0,
      ms: Date.now() - t0,
      msPerImage: Math.round((Date.now() - t0) / Math.max(1, inputs.length)),
      error: err,
      requests: RAW.length - before,
      sampleCaptions: (out ?? []).map((c) => c.caption),
    };
    console.log(
      `  requested=${inputs.length} returned=${out?.length ?? 0} ms=${results.batch.ms} (${results.batch.msPerImage}/img) requests=${results.batch.requests} err=${err ?? "none"}`,
    );
  } else {
    results.batch = { requested: inputs.length, returned: 0, error: "no images or provider has no captionPhotos" };
    console.log(`  skipped: ${results.batch.error}`);
  }
  checkpoint();
}

/* day summaries ----------------------------------------------------------- */
/** The register rules `summarise.ts`/`tripPrompt` encode, as greps. */
function registerViolations(text, tripName) {
  const rules = [
    ["photo-count", /\b\d[\d,]*\s*(photos?|pictures?|images?|shots?|snaps?)\b/i],
    ["distance", /\b\d+(?:[.,]\d+)?\s*(km|kilomet(?:er|re)s?|miles?|mi\b)/i],
    ["figures", /\b\d+\s*(days?|nights?|hours?)\b/i],
    ["standout-count", /\b\d+\s*(stood out|were notable|of them were)\b/i],
    ["trip-name-in-body", tripName ? new RegExp(tripName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null],
  ];
  return rules.filter(([, re]) => re && re.test(text)).map(([name]) => name);
}

if (sets.has("days")) {
  console.log("\n=== day summary (days that already have a cloud summary) ===");
  const buildDayInput = (day) => ({
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
  });
  const eligible = index.sections
    .flatMap((s) => (s.kind === "trip" ? s.days.map((d) => ({ ...d, trip: s.name })) : s.days.map((d) => ({ ...d, trip: null }))))
    .filter(
      (d) =>
        (d.summary ?? "").trim().length > 40 &&
        (d.segments?.length ?? 0) > 0 &&
        d.segments.some((seg) => (seg.photoIds ?? []).some((id) => photos.get(id)?.caption)),
    )
    .sort((a, b) => a.date.localeCompare(b.date) || (a.trip ?? "").localeCompare(b.trip ?? ""));
  // `--dates 2026-04-29,...` pins the day set, for re-testing one date at a
  // different context without taking whatever the seed shuffle hands out.
  const onlyDates = new Set((arg("dates", "") || "").split(",").map((s) => s.trim()).filter(Boolean));
  const scoped = onlyDates.size ? eligible.filter((d) => onlyDates.has(d.date)) : eligible;
  /**
   * The loaded context is the binding constraint, not the model's ceiling:
   * LM Studio JIT-loads `google/gemma-4-e4b` at 8192 tokens by default while the
   * model supports 131072, so a whole day — every stop's every caption — does
   * not fit. Days are pre-sized here so the run measures the summary and not
   * the overflow; the skipped ones are counted and reported.
   */
  const fits = [];
  const tooBig = [];
  for (const day of scoped) {
    const input = buildDayInput(day);
    if (!input.stops.some((s) => s.photos.length)) continue;
    const estTokens = Math.round(JSON.stringify(input).length / 3.6) + 900;
    if (estTokens > maxContext - 1200) tooBig.push({ date: day.date, estTokens, photos: input.stops.reduce((n, s) => n + s.photos.length, 0) });
    else fits.push({ day, input, estTokens });
  }
  console.log(
    `  days that fit ${maxContext}-token context: ${fits.length}; too big to send: ${tooBig.length}` +
      (tooBig.length ? ` (smallest skipped ~${Math.min(...tooBig.map((t) => t.estTokens))} tokens)` : ""),
  );
  const chosen = shuffled(fits).slice(0, nDays);
  results.dayFit = {
    eligible: scoped.length,
    fits: fits.length,
    tooBig: tooBig.length,
    smallestSkippedTokens: tooBig.length ? Math.min(...tooBig.map((t) => t.estTokens)) : null,
    tooBigSample: tooBig.slice(0, 5),
  };
  for (const { day, input } of chosen) {
    const t0 = Date.now();
    let out = null;
    let err = null;
    try {
      out = await provider.summarizeDay(input);
    } catch (e) {
      err = e.message;
    }
    const ms = Date.now() - t0;
    const violations = out ? registerViolations(out.summary ?? "", day.trip) : [];
    results.days.push({
      date: day.date,
      trip: day.trip,
      place: day.place ?? null,
      photoCount: input.stops.reduce((n, s) => n + s.photos.length, 0),
      stopCount: input.stops.length,
      ms,
      error: err,
      cloud: {
        summary: day.summary,
        segmentTitles: (day.segments ?? []).map((s) => s.title),
        highlightCount: (day.segments ?? []).reduce((n, s) => n + (s.highlights?.length ?? 0), 0),
      },
      local: out,
      registerViolations: violations,
    });
    console.log(`\n  ${day.date}${day.trip ? ` · ${day.trip}` : ""} place=${day.place ?? "—"} photos=${results.days.at(-1).photoCount} ${ms}ms err=${err ?? "none"}`);
    console.log(`  cloud: ${(day.summary ?? "").slice(0, 220)}`);
    console.log(`  local: ${(out?.summary ?? "").split("\n").join(" ").slice(0, 220)}`);
    console.log(`  register violations: ${violations.length ? violations.join(", ") : "none"}`);
    checkpoint();
  }
}

/* ---------- metrics ------------------------------------------------------ */

function stats(list) {
  const ok = list.filter((r) => r.ok);
  const ms = ok.map((r) => r.ms).sort((a, b) => a - b);
  const requests = list.reduce((n, r) => n + (r.raw?.length ?? 0), 0);
  const finish = {};
  for (const r of list) for (const x of r.raw ?? []) finish[x.finish ?? "?"] = (finish[x.finish ?? "?"] ?? 0) + 1;
  return {
    n: list.length,
    ok: ok.length,
    empty: list.filter((r) => !r.error && !r.ok).length,
    errored: list.filter((r) => r.error).length,
    contextOverflow: list.filter((r) => /exceeds the available context|exceed_context_size/i.test(r.error ?? "")).length,
    requestCount: requests,
    requestsPerPhoto: list.length ? +(requests / list.length).toFixed(2) : 0,
    finishReasons: finish,
    emptyContentReplies: list.reduce((n, r) => n + (r.raw ?? []).filter((x) => x.contentLen === 0).length, 0),
    medianMs: ms.length ? ms[Math.floor(ms.length / 2)] : null,
    p90Ms: ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.9))] : null,
  };
}

const metrics = {
  generatedAt: new Date().toISOString(),
  provider: providerName,
  baseUrl,
  model,
  seed,
  pools: { naming: namingPool.length, doc: docPool.length, random: randomPool.length },
  caption: {},
  naming: null,
  doc: null,
  determinism: null,
  batch: results.batch,
  days: null,
};
for (const set of ["naming", "doc", "random"]) {
  if (results[set].length) metrics.caption[set] = stats(results[set]);
}

if (results.naming.length) {
  const cloudHits = results.naming.filter((r) => r.cloudHit).length;
  const localHits = results.naming.filter((r) => r.localHit).length;
  const hard = results.naming.filter((r) => !r.cloudHit);
  const hardLocal = hard.filter((r) => r.localHit).length;
  const localAny = results.naming.filter((r) => r.localAny).length;
  const cloudAny = results.naming.filter((r) => r.cloudAny).length;
  metrics.naming = {
    n: results.naming.length,
    cloudHit: cloudHits,
    localHit: localHits,
    cloudHitPct: +((cloudHits / results.naming.length) * 100).toFixed(0),
    localHitPct: +((localHits / results.naming.length) * 100).toFixed(0),
    cloudAnyWord: cloudAny,
    localAnyWord: localAny,
    hardSubsetN: hard.length,
    hardSubsetLocalHit: hardLocal,
  };
  log(`\nnaming (key word): local ${localHits}/${results.naming.length} vs cloud ${cloudHits}/${results.naming.length}`);
  log(`naming (any title word): local ${localAny}/${results.naming.length} vs cloud ${cloudAny}/${results.naming.length}`);
  log(`  hard subset (cloud missed the key): local ${hardLocal}/${hard.length}`);
}

if (results.doc.length) {
  const both = results.doc.filter((r) => r.cloudLen > 0);
  const j = both.map((r) => r.tokenJaccard).sort((a, b) => a - b);
  metrics.doc = {
    n: results.doc.length,
    cloudHadText: both.length,
    localNull: results.doc.filter((r) => !r.local?.extractedText).length,
    medianJaccard: j.length ? +j[Math.floor(j.length / 2)].toFixed(2) : null,
    meanLengthRatio:
      both.length > 0
        ? +(both.reduce((n, r) => n + r.localLen / Math.max(1, r.cloudLen), 0) / both.length).toFixed(2)
        : null,
  };
  log(`\ndoc: median word-set Jaccard vs cloud = ${metrics.doc.medianJaccard}, local produced no text on ${metrics.doc.localNull}/${results.doc.length}`);
}

if (results.random.length) {
  const stopwords = new Set(
    "the and for with from this that are was were not you your photo picture image view showing showing near outside inside front behind over under into onto against their there these those some more than about after before its his her she they them then when what where which while during".split(/\s+/),
  );
  const candidates = [];
  for (const r of results.random) {
    const cap = r.local?.caption ?? "";
    if (!cap) continue;
    const hay = [r.cloud.caption, r.cloud.extractedText, r.context?.place, r.context?.trip, r.stop].filter(Boolean).join(" ").toLowerCase();
    const known = new Set([...tokens(hay)]);
    for (const m of cap.matchAll(/\b([A-Z][A-Za-z'’-]{3,})\b/g)) {
      const w = m[1];
      const lc = w.toLowerCase();
      if (stopwords.has(lc) || known.has(lc)) continue;
      // Sentence-initial words are usually just the start of the sentence.
      if (m.index === 0 || /[.!?]\s+$/.test(cap.slice(0, m.index))) continue;
      candidates.push({ id: r.id, fileName: r.fileName, word: w, caption: cap, cloudCaption: r.cloud.caption });
    }
  }
  metrics.hallucinationCandidates = candidates.length;
  results.hallucinationCandidates = candidates;
  log(`\nrandom: ${candidates.length} hallucination candidate proper noun(s) for human review (see raw-caption.json)`);
}

if (results.determinism.length) {
  metrics.determinism = {
    n: results.determinism.length,
    captionSame: results.determinism.filter((r) => r.captionSame).length,
    contentTypeSame: results.determinism.filter((r) => r.contentTypeSame).length,
    extractedSame: results.determinism.filter((r) => r.extractedSame).length,
    meanTagsJaccard: +(results.determinism.reduce((n, r) => n + r.tagsJaccard, 0) / results.determinism.length).toFixed(2),
  };
  log(`\ndeterminism: caption identical ${metrics.determinism.captionSame}/${results.determinism.length}, type ${metrics.determinism.contentTypeSame}, tags Jaccard ${metrics.determinism.meanTagsJaccard}`);
}

if (results.days.length) {
  const withViolation = results.days.filter((d) => d.registerViolations.length);
  metrics.days = {
    n: results.days.length,
    errored: results.days.filter((d) => d.error).length,
    contextOverflow: results.days.filter((d) => /exceeds the available context|exceed_context_size/i.test(d.error ?? "")).length,
    registerViolations: withViolation.length,
    violations: withViolation.map((d) => ({ date: d.date, rules: d.registerViolations })),
    dayFit: results.dayFit ?? null,
    medianMs: (() => {
      const a = results.days.map((d) => d.ms).sort((x, y) => x - y);
      return a[Math.floor(a.length / 2)] ?? null;
    })(),
  };
  log(`\nday summaries: ${results.days.length}, errored ${metrics.days.errored}, register violations ${withViolation.length}`);
  if (results.dayFit) log(`  eligible ${results.dayFit.eligible}: ${results.dayFit.fits} fit the ${maxContext}-token context, ${results.dayFit.tooBig} too big (smallest skipped ~${results.dayFit.smallestSkippedTokens} tokens)`);
}

/* ---------- write -------------------------------------------------------- */

mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, "sample.json"), JSON.stringify({
  seed,
  naming: namingPick.map(({ p, stop, key }) => ({ id: p.id, fileName: p.fileName, stop: stop.title, key })),
  doc: docPick.map((p) => ({ id: p.id, fileName: p.fileName })),
  random: randomPick.map((p) => ({ id: p.id, fileName: p.fileName })),
}, null, 2));
writeFileSync(path.join(OUT, "raw-caption.json"), JSON.stringify(results, null, 2));
writeFileSync(path.join(OUT, "raw-day.json"), JSON.stringify(results.days, null, 2));
writeFileSync(path.join(OUT, "metrics.json"), JSON.stringify(metrics, null, 2));
writeFileSync(path.join(OUT, "report.txt"), report.join("\n"));

console.log(`\nwrote ${OUT}\\{sample,raw-caption,raw-day,metrics}.json + report.txt`);
console.log(JSON.stringify({ caption: metrics.caption, naming: metrics.naming, doc: metrics.doc, determinism: metrics.determinism, batch: metrics.batch, days: metrics.days }, null, 2));
