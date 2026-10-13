// What would a local model make of the screenshots the allowlist keeps off the
// wire? Read-only against the archive: it downloads thumbnails the way `analyze`
// does, calls the provider, and writes nothing back — no shard, no index.
//
//   node scripts/bench-screenshots.mjs --per-app 3                 # both groups
//   node scripts/bench-screenshots.mjs --group blocked --per-app 2
//   node scripts/bench-screenshots.mjs --dry-run                   # selection only
//
// Two questions per screenshot, and they are different questions:
//
//  1. **Description** — the production call, unchanged (`captionPhoto` with the
//     same context `analyze` builds). This is exactly what the pipeline would
//     store, so "is it usable" can be judged on the real thing.
//  2. **Sensitivity** — a separate raw call asking the model to say whether the
//     screen holds anything private, with its reason. Nothing in the pipeline
//     asks this today; the allowlist decides instead. If the split ever becomes
//     "描述给云、详细内容留本机", this is the number that decides whether a model
//     verdict can be trusted to make that call — see the note in the project
//     notes: the claim that judgement is the local model's weakest skill is an
//     inference from the retired judge experiment, not a measurement.
//
// Both answers land in `data/bakeoff/<out>/report.md` (gitignored) with blank
// score columns, because only the owner can say whether a description leaked
// something or whether a verdict was wrong.
//
// `--concurrency` is capped at 8 rather than at the measured-safe 2 (see
// docs/history.md, 2026-10-07: e2b crashed the engine at 4 streams, losing
// 104/359 calls with 6.3 of 8.0 GB used and the GPU at 68 C — the multimodal
// parallel path, not memory). That was one configuration, so the cap is only a
// guard against a typo; anything above 2 is an experiment, and the sweep that
// decides it belongs in its own run with the error count watched.
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const perApp = Number(arg("per-app", "3"));
const maxApps = Number(arg("max-apps", "12"));
const captionsOnly = flag("captions-only");
const group = arg("group", "both"); // travel | blocked | both
const dryRun = flag("dry-run");
const outName = arg("out", `screenshots-${new Date().toISOString().slice(0, 10)}`);
const concurrency = Math.max(1, Math.min(8, Number(arg("concurrency", "1"))));

// Before anything that reads env: env.ts resolves AI_PROVIDER at import.
process.env.AI_PROVIDER = arg("provider", process.env.AI_PROVIDER ?? "lmstudio");
const { initProxyDispatcher } = await import("../dist/proxy.js");
const { getProvider } = await import("../dist/providers/index.js");
const { captionContextFor, contextSources } = await import("../dist/jobs/analyze.js");
const { getAccessToken } = await import("../dist/auth.js");
const { downloadThumbnailBuffer } = await import("../dist/graph.js");
initProxyDispatcher();

const provider = getProvider();
const localBase = (process.env.LMSTUDIO_BASE_URL || "http://127.0.0.1:1234/v1").replace(/\/$/, "");
const localModel = process.env.LMSTUDIO_MODEL || "google/gemma-4-e4b";
console.log(`provider: ${process.env.AI_PROVIDER}   verdict calls: ${localBase} (${localModel})`);
console.log(`per-app ${perApp}   max-apps ${maxApps}   group ${group}   files ${existsSync(path.join(ROOT, "..", "data", "index.json")) ? "ok" : "MISSING"}\n`);

/* ---------- the local archive (read-only) -------------------------------- */

const dataDir = path.join(ROOT, "..", "data");
const index = JSON.parse(readFileSync(path.join(dataDir, "index.json"), "utf8"));
const sources = contextSources(index);

const photos = new Map();
for (const f of readdirSync(path.join(dataDir, "photos")).filter((f) => f.endsWith(".json"))) {
  const shard = JSON.parse(readFileSync(path.join(dataDir, "photos", f), "utf8"));
  for (const [id, p] of Object.entries(shard.photos ?? {})) photos.set(id, p);
}

function mediaTypeOf(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf.length >= 6 && buf.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  if (buf.length >= 12 && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "image/jpeg";
}

/* ---------- selection ---------------------------------------------------- */

const all = [...photos.values()].filter((p) => p.screenshot || /^screenshot/i.test(p.fileName ?? ""));
const travel = all
  .filter((p) => p.screenshot?.analyzable)
  .sort((a, b) => (a.takenAt ?? "").localeCompare(b.takenAt ?? "") || a.id.localeCompare(b.id));
const blocked = all.filter((p) => !p.screenshot?.analyzable);

/** Up to `k` from each of the `maxApps` biggest source apps. */
function spread(items, k, maxApps) {
  const by = new Map();
  for (const p of items) {
    const key = p.screenshot?.sourceApp ?? "(none in filename)";
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(p);
  }
  return [...by.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, maxApps)
    .flatMap(([, list]) => list.slice(0, k));
}

const chosen = [
  ...(group !== "blocked" ? spread(travel, perApp, maxApps) : []),
  ...(group !== "travel" ? spread(blocked, perApp, maxApps) : []),
];

console.log(`screenshots ${all.length}   allowlisted ${travel.length}   withheld ${blocked.length}`);
const apps = new Map();
for (const p of chosen) {
  const k = p.screenshot?.sourceApp ?? "(none in filename)";
  apps.set(k, (apps.get(k) ?? 0) + 1);
}
console.log(`selected ${chosen.length}:`);
for (const [app, n] of apps) console.log(`   ${String(n).padStart(3)}  ${app}`);
if (dryRun) process.exit(0);

/* ---------- the sensitivity question (nothing in the pipeline asks it) --- */

const VERDICT_PROMPT = [
  "This is a phone screenshot. Do not transcribe any private content from it.",
  'Answer with one JSON object and nothing else: {"what":"<what this screen is, max 8 words>","sensitive":true|false,"why":"<max 12 words>"}',
  "",
  'sensitive=true if the screen holds any of: a person\'s name, a chat or mail body,',
  "a payment or bank detail, a booking or ID number together with a name, a phone",
  "number or address, health information, or anything else you would not show a stranger.",
  'sensitive=false if it is a map, a timetable, weather, a ticket with no name on it,',
  "a settings screen, a game UI, or a photo of the screen with nothing personal in it.",
].join("\n");

function looseJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function verdictFor(b64, mediaType) {
  const started = Date.now();
  const res = await fetch(`${localBase}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: localModel,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: VERDICT_PROMPT },
            { type: "image_url", image_url: { url: `data:${mediaType};base64,${b64}` } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) return { error: `HTTP ${res.status}`, ms: Date.now() - started };
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content ?? "";
  return { text: text.trim(), parsed: looseJson(text), ms: Date.now() - started };
}

/* ---------- run ---------------------------------------------------------- */

const tokenPromise = (() => {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("no cached pipeline token — run the pipeline once to sign in")), 45_000).unref(),
  );
  return Promise.race([getAccessToken(), timeout]);
})();

const outDir = path.join(dataDir, "bakeoff", outName);
const results = [];

async function one(photo, position) {
  const label = `${position}/${chosen.length}  ${photo.screenshot?.sourceApp ?? "(no app)"}  ${photo.fileName}`;
  const row = {
    id: photo.id,
    fileName: photo.fileName,
    app: photo.screenshot?.sourceApp ?? null,
    allowlisted: Boolean(photo.screenshot?.analyzable),
    takenAt: photo.takenAt,
    bytes: photo.bytes,
    existingCaption: photo.caption ?? null,
    existingAnalyzedAt: photo.analyzedAt ?? null,
  };
  try {
    const token = await tokenPromise;
    const bytes = await downloadThumbnailBuffer(token, photo.id);
    const b64 = bytes.toString("base64");
    const mediaType = mediaTypeOf(bytes);
    row.thumbBytes = bytes.length;

    const t0 = Date.now();
    const caption = await provider.captionPhoto({
      imageBase64: b64,
      mediaType,
      context: captionContextFor(photo, sources),
    });
    row.captionMs = Date.now() - t0;
    row.caption = caption?.caption ?? null;
    row.tags = caption?.tags ?? [];
    row.extractedText = caption?.extractedText ?? null;
    row.usage = caption?.usage ?? null;

    const verdict = captionsOnly ? { ms: 0 } : await verdictFor(b64, mediaType);
    row.verdictMs = verdict.ms;
    row.verdictText = verdict.text ?? null;
    row.verdict = verdict.parsed ?? null;
    row.verdictError = verdict.error ?? null;

    console.log(`${label}`);
    console.log(`   caption(${(row.captionMs / 1000).toFixed(1)}s): ${row.caption}`);
    console.log(`   verdict(${(row.verdictMs / 1000).toFixed(1)}s): sensitive=${row.verdict?.sensitive}  what=${row.verdict?.what}  why=${row.verdict?.why}`);
  } catch (err) {
    row.error = err.message;
    console.log(`${label}\n   FAILED: ${err.message}`);
  }
  results.push(row);
}

const t0 = Date.now();
let cursor = 0;
const workers = Array.from({ length: concurrency }, async () => {
  while (cursor < chosen.length) {
    const i = cursor++;
    await one(chosen[i], i + 1);
  }
});
await Promise.all(workers);

/* ---------- the report a human has to read ------------------------------- */

mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ when: new Date().toISOString(), group, perApp, localModel, provider: process.env.AI_PROVIDER, results }, null, 2));

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const lines = [];
lines.push(`# Screenshots through a local model — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`);
lines.push("");
lines.push(`Model \`${localModel}\` (local, ${localModel === "gemma4-e2b" ? "4.6B" : "7.5B"}), context 8192, parallel 2.`);
lines.push(`${chosen.length} screenshots: ${group === "both" ? "allowlisted + withheld" : group}, up to ${perApp} per source app, ${((Date.now() - t0) / 60000).toFixed(1)} min total.`);
lines.push("");
lines.push("**Two hand-filled columns are the point of this file.** 描述: would you accept this caption in the archive? 判断: was the sensitive/not verdict right?");
lines.push("");
lines.push(`| # | app | allowlisted | 描述 | 判断 | what the model called it |`);
lines.push(`|---|---|---|---|---|---|`);
results.forEach((r, i) => {
  lines.push(
    `| ${i + 1} | ${esc(r.app ?? "(no app)")} | ${r.allowlisted ? "yes" : "**no**"} | ☐ | ${r.verdict ? (r.verdict.sensitive ? "says **private**" : "says public") : "—"} | ${esc(r.verdict?.what ?? r.error ?? "")} |`,
  );
});
lines.push("");
lines.push("---");
results.forEach((r, i) => {
  lines.push("");
  lines.push(`### ${i + 1}. ${esc(r.app ?? "(no app in filename)")} — \`${esc(r.fileName)}\``);
  lines.push("");
  lines.push(`- ${r.allowlisted ? "白名单内（会送去模型）" : "**白名单外（今天永不描述）**"} · ${esc(r.takenAt?.slice(0, 10) ?? "")} · 缩略图 ${(((r.thumbBytes ?? 0) / 1024) | 0)} KB`);
  if (r.error) {
    lines.push(`- **FAILED**: ${esc(r.error)}`);
    return;
  }
  lines.push(`- **本地模型判断**: \`sensitive=${r.verdict?.sensitive}\` — “${esc(r.verdict?.why)}”; 它认为这是 “${esc(r.verdict?.what)}”`);
  lines.push(`- **本地图注（生产过程原样）**: ${esc(r.caption)}`);
  lines.push(`- 标签: ${esc((r.tags ?? []).join(", ")) || "—"}`);
  if (r.extractedText) lines.push(`- 抽取文本 ${r.extractedText.length} 字${r.extractedText.length > 400 ? "（截断）" : ""}: \`${esc(r.extractedText.slice(0, 400))}\``);
  if (r.existingCaption) lines.push(`- 现有图注（此前分析过）: ${esc(r.existingCaption)}`);
  lines.push(`- 用时 caption ${((r.captionMs ?? 0) / 1000).toFixed(1)}s / verdict ${((r.verdictMs ?? 0) / 1000).toFixed(1)}s${r.usage ? ` · in=${r.usage.promptTokens} out=${r.usage.outputTokens} think=${r.usage.thoughtsTokens ?? 0}` : ""}`);
});
fsWrite(path.join(outDir, "report.md"), lines.join("\n") + "\n");

function fsWrite(file, text) {
  writeFileSync(file, text);
}
console.log(`\nreport: ${path.relative(process.cwd(), path.join(outDir, "report.md"))}`);
console.log(`raw:    ${path.relative(process.cwd(), path.join(outDir, "results.json"))}`);
if (!captionsOnly) {
  const priv = results.filter((r) => r.verdict?.sensitive).length;
  console.log(`model called ${priv}/${results.filter((r) => r.verdict).length} screens sensitive`);
}
// One line the concurrency sweep can grep: wall time, calls, failures, and the
// per-call latency spread. Model time is the sum, wall time is what it cost.
const done = results.filter((r) => r.captionMs);
const ms = done.map((r) => r.captionMs).sort((a, b) => a - b);
const wall = (Date.now() - t0) / 1000;
console.log(
  `TIMING wall=${wall.toFixed(1)}s calls=${done.length} failed=${results.length - done.length} ` +
    `model=${(ms.reduce((a, b) => a + b, 0) / 1000).toFixed(1)}s ` +
    `min=${((ms[0] ?? 0) / 1000).toFixed(1)}s median=${((ms[Math.floor(ms.length / 2)] ?? 0) / 1000).toFixed(1)}s max=${((ms[ms.length - 1] ?? 0) / 1000).toFixed(1)}s ` +
    `concurrency=${concurrency} captionsOnly=${captionsOnly}`,
);
