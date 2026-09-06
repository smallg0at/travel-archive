/**
 * Provider bake-off — the evidence for choosing a model, before the AI layer
 * is built on top of one.
 *
 * Runs a stratified sample of the REAL archive through every provider that has
 * credentials, and reports what actually matters: OCR fidelity on museum
 * placards, caption quality, determinism, blur judgment, latency and cost.
 *
 * CAMERA PHOTOS ONLY. Screenshots are deliberately excluded and must stay
 * excluded: they hold private messages, mail, tickets and banking, and an
 * earlier version of this script sampled them blind and sent two WeChat
 * conversations and a rail ticket to a cloud model. Screenshots are handled
 * by the local allowlist in pipeline/src/screenshots.ts and never leave the
 * machine.
 *
 * It also answers a question worth as much as the provider choice: does the
 * model need the full original, or is Graph's 800px `large` thumbnail enough?
 * `analyze` currently sends full originals — 4096x3072 JPEGs, several MB each.
 * If 800px reads placards just as well, production gets an order-of-magnitude
 * cheaper for free. The placard stratum is run at both resolutions to find out.
 *
 *   node scripts/bakeoff.mjs
 *   node scripts/bakeoff.mjs --per-stratum 8 --providers gemini-3.8-flash
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { getAccessToken } from "../dist/auth.js";
import { downloadPhotoBuffer } from "../dist/graph.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const OUT_DIR = "data/bakeoff";

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PER_STRATUM = Number(arg("--per-stratum", "8"));
const PLACARD_DAY = arg("--placard-day", "2026-09-01");

function loadAllPhotos() {
  const dir = "data/photos";
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => Object.values(JSON.parse(readFileSync(`${dir}/${f}`, "utf-8")).photos));
}

/** Deterministic pick so re-runs compare like with like. */
function take(list, n) {
  return list.slice(0, n);
}

function buildStrata(allPhotos) {
  // Enforced here rather than trusted to each stratum's own filter.
  const photos = allPhotos.filter((p) => p.screenshot === null);
  const dated = photos.filter((p) => p.takenAt);
  const byGroup = new Map();
  for (const p of photos) {
    if (!p.duplicateGroupId) continue;
    byGroup.set(p.duplicateGroupId, [...(byGroup.get(p.duplicateGroupId) ?? []), p]);
  }
  const groups = [...byGroup.values()].sort((a, b) => b.length - a.length);

  // Camera photos only, smallest first — the most likely blurry or dark ones.
  const cameraPhotos = photos.filter((p) => /^(IMG_|MVIMG_|PXL_|DSC)/i.test(p.fileName) && p.bytes > 0);

  return {
    // Text-heavy: the whole extractedText feature rests on these.
    placards: take(
      dated.filter((p) => p.takenAt.startsWith(PLACARD_DAY)).sort((a, b) => b.bytes - a.bytes),
      PER_STRATUM,
    ),
    landscapes: take(
      photos.filter((p) => p.gps && p.width > p.height && !p.duplicateGroupId),
      PER_STRATUM,
    ),
    // Both copies of a byte-identical duplicate. Same pixels in, so the model
    // should say the same thing twice — a direct read on how deterministic its
    // captions are, which matters when captions feed day summaries.
    identicalPairs: take(
      groups.filter((g) => g.length >= 2 && g[0].duplicateKind === "exact").flatMap((g) => g.slice(0, 2)),
      PER_STRATUM,
    ),
    // Smallest camera files: the throwaways, to see if `quality` can spot them.
    likelyPoor: take([...cameraPhotos].sort((a, b) => a.bytes - b.bytes), PER_STRATUM),
  };
}

async function thumbnailBuffer(token, id) {
  const meta = await fetch(`${GRAPH}/me/drive/items/${id}/thumbnails/0/large`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!meta.ok) return null;
  const { url } = await meta.json();
  if (!url) return null;
  return Buffer.from(await (await fetch(url)).arrayBuffer());
}

/**
 * Which models to compare. Defaults to Gemini's newest Flash against Pro:
 * Flash is what a 14,500-photo bulk pass would realistically use, and Pro is
 * the question — does it read museum placards materially better, and is that
 * worth reserving it for the text-heavy days? Anthropic is included only if a
 * key happens to be set.
 */
const DEFAULT_MODELS = "gemini-3.8-flash,gemini-3.1-pro-preview";

async function loadProviders(requested) {
  const available = [];
  const { createGeminiProvider } = await import("../dist/providers/gemini.js");

  for (const model of (requested ?? DEFAULT_MODELS).split(",").map((s) => s.trim())) {
    if (model === "anthropic") {
      if (!process.env.ANTHROPIC_API_KEY) continue;
      const { anthropicProvider } = await import("../dist/providers/anthropic.js");
      available.push({ name: `anthropic/${process.env.ANTHROPIC_MODEL ?? "default"}`, provider: anthropicProvider });
      continue;
    }
    if (!process.env.GEMINI_API_KEY) continue;
    available.push({ name: model, provider: createGeminiProvider(model) });
  }
  return available;
}

function mediaTypeFor(name) {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  return { ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" }[ext] ?? "image/jpeg";
}

async function main() {
  const providers = await loadProviders(arg("--providers"));
  if (providers.length === 0) {
    console.error("No providers have credentials. Set GEMINI_API_KEY and/or ANTHROPIC_API_KEY.");
    process.exit(1);
  }
  console.log(`Providers: ${providers.map((p) => p.name).join(", ")}`);

  const photos = loadAllPhotos();
  console.log(`Loaded ${photos.length} photos from local shards.`);
  const strata = buildStrata(photos);
  for (const [name, list] of Object.entries(strata)) console.log(`  ${name}: ${list.length}`);

  const token = await getAccessToken();
  const results = [];

  for (const [stratum, list] of Object.entries(strata)) {
    for (const [i, photo] of list.entries()) {
      console.log(`[${stratum} ${i + 1}/${list.length}] ${photo.fileName}`);

      const thumb = await thumbnailBuffer(token, photo.id);
      if (!thumb) {
        console.log("   no thumbnail, skipping");
        continue;
      }

      // Placards get both resolutions so the "is 800px enough?" question gets
      // a real answer; everything else runs at thumbnail size only.
      const inputs = [{ label: "thumb800", buffer: thumb }];
      if (stratum === "placards") {
        inputs.push({ label: "original", buffer: await downloadPhotoBuffer(token, photo.id) });
      }

      const runs = [];
      for (const { name, provider } of providers) {
        for (const input of inputs) {
          const started = Date.now();
          try {
            const out = await provider.captionPhoto({
              imageBase64: input.buffer.toString("base64"),
              mediaType: mediaTypeFor(photo.fileName),
            });
            runs.push({ provider: name, input: input.label, ms: Date.now() - started, ok: true, ...out });
          } catch (err) {
            runs.push({ provider: name, input: input.label, ms: Date.now() - started, ok: false, error: String(err).slice(0, 300) });
          }
        }
      }

      results.push({
        stratum,
        id: photo.id,
        fileName: photo.fileName,
        takenAt: photo.takenAt,
        bytes: photo.bytes,
        dims: photo.width && photo.height ? `${photo.width}x${photo.height}` : null,
        duplicateGroupId: photo.duplicateGroupId,
        duplicateKind: photo.duplicateKind,
        thumbDataUri: `data:image/jpeg;base64,${thumb.toString("base64")}`,
        runs,
      });
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    `${OUT_DIR}/results.json`,
    JSON.stringify(results.map(({ thumbDataUri, ...r }) => r), null, 2),
  );
  writeFileSync(`${OUT_DIR}/report.html`, renderReport(results, providers.map((p) => p.name)));

  // Latency summary, printed so the terminal alone answers "is it fast?".
  console.log("\n--- latency (ms, median) ---");
  for (const { name } of providers) {
    const times = results.flatMap((r) => r.runs.filter((x) => x.provider === name && x.ok).map((x) => x.ms)).sort((a, b) => a - b);
    if (times.length) console.log(`  ${name}: ${times[Math.floor(times.length / 2)]}ms over ${times.length} calls`);
  }
  console.log(`\nReport: ${OUT_DIR}/report.html`);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

function renderRun(run) {
  if (!run.ok) return `<div class="run bad"><b>${esc(run.provider)}/${esc(run.input)}</b><div>${esc(run.error)}</div></div>`;
  return `<div class="run">
    <div class="rhead"><b>${esc(run.provider)}</b> · ${esc(run.input)} · ${run.ms}ms${run.usage ? ` · ${run.usage.promptTokens}in / ${run.usage.thoughtsTokens}think / ${run.usage.outputTokens}out` : ""}</div>
    <div class="meta">${esc(run.contentType)}${run.notable ? " · notable" : ""}</div>
    <div class="cap">${esc(run.caption)}</div>
    <div class="tags">${(run.tags ?? []).map((t) => `<span>${esc(t)}</span>`).join("")}</div>
    ${run.extractedText ? `<pre class="ocr">${esc(run.extractedText)}</pre>` : `<div class="noocr">no extracted text</div>`}
  </div>`;
}

function renderReport(results, providerNames) {
  const byStratum = {};
  for (const r of results) (byStratum[r.stratum] ??= []).push(r);

  const sections = Object.entries(byStratum)
    .map(
      ([stratum, items]) => `<h2>${esc(stratum)} <span class="count">${items.length}</span></h2>
      ${items
        .map(
          (item) => `<div class="card">
            <div class="left">
              <img src="${item.thumbDataUri}" alt="">
              <div class="fn">${esc(item.fileName)}</div>
              <div class="fmeta">${esc(item.dims ?? "")} · ${(item.bytes / 1024).toFixed(0)}KB${item.duplicateGroupId ? " · " + item.duplicateKind + " dup" : ""}</div>
            </div>
            <div class="right">${item.runs.map(renderRun).join("")}</div>
          </div>`,
        )
        .join("")}`,
    )
    .join("");

  return `<!doctype html><meta charset="utf-8"><title>Provider bake-off</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a18;--mut:#5f5e5a;--line:#e2e0d8;--panel:#f7f6f2}
@media(prefers-color-scheme:dark){:root{--bg:#161614;--fg:#f1efe8;--mut:#b4b2a9;--line:#333330;--panel:#1e1c1a}}
body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:1400px}
h1{font-size:22px} h2{font-size:15px;margin:32px 0 10px;text-transform:capitalize}
.count{color:var(--mut);font-weight:400;font-size:12px}
.card{display:flex;gap:16px;padding:14px 0;border-top:1px solid var(--line)}
.left{width:230px;flex-shrink:0}
.left img{width:100%;border-radius:6px;display:block;background:var(--panel)}
.fn{font-size:11px;color:var(--mut);margin-top:6px;word-break:break-all}
.fmeta{font-size:11px;color:var(--mut)}
.right{flex:1;display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.run{background:var(--panel);border-radius:8px;padding:10px 12px;font-size:13px}
.run.bad{outline:1px solid #c0392b}
.rhead{font-size:11px;color:var(--mut);margin-bottom:4px}
.meta{font-size:11px;color:var(--mut)}
.cap{margin:4px 0}
.tags span{display:inline-block;font-size:11px;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:1px 7px;margin:2px 3px 0 0}
.ocr{white-space:pre-wrap;font-size:11px;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:6px 8px;margin-top:6px;max-height:260px;overflow:auto}
.noocr{font-size:11px;color:var(--mut);margin-top:6px;font-style:italic}
</style>
<h1>Provider bake-off</h1>
<p style="color:var(--mut)">Providers: ${esc(providerNames.join(", "))} · ${results.length} photos · placards run at both 800px and full resolution to test whether the original is needed.</p>
${sections}`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
