/**
 * Video probe — the evidence for whether a video pass is worth building.
 *
 * Read-only. Walks the same month folders `scan` does, but keeps only
 * `video/*` items, and answers the four numbers that decide everything:
 *
 *   1. how many videos there are and their total duration,
 *   2. their size distribution (how many are small enough to download),
 *   3. how often Graph has a **poster thumbnail**, and how big it is,
 *   4. the codec/fourCC mix.
 *
 * It downloads **no original video bytes**. The only bytes it pulls are a
 * sample of poster thumbnails, to measure what S1 would actually transfer.
 *
 *   node scripts/video-probe.mjs
 *   node scripts/video-probe.mjs --from 2026-01 --to 2026-12
 *   node scripts/video-probe.mjs --thumb-sample 60 --bytes-sample 20
 */
import { getAccessToken } from "../dist/auth.js";
import { listPhotoFolders } from "../dist/graph.js";
import { env } from "../dist/env.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const SELECT = "id,name,size,file,folder,video,image,photo,location,fileSystemInfo";

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const FROM = arg("--from", null);
const TO = arg("--to", null);
const THUMB_SAMPLE = Number(arg("--thumb-sample", "80"));
const BYTES_SAMPLE = Number(arg("--bytes-sample", "20"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET with backoff. Graph returns 504 on big folders and 429 under load. */
async function graphGet(token, url, tries = 6) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      if (attempt >= tries) throw err;
      await sleep(1000 * attempt);
      continue;
    }
    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && attempt < tries) {
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      await sleep(retryAfter ? retryAfter * 1000 : 1000 * attempt);
      continue;
    }
    throw new Error(`GET ${url}: ${res.status} ${await res.text()}`);
  }
}

async function listFolder(token, folderPath, recursive) {
  const files = [];
  const subfolders = [];
  let url = `${GRAPH}/me/drive/root:/${encodeURI(folderPath)}:/children?$top=200&$select=${SELECT}`;
  while (url) {
    const res = await graphGet(token, url);
    const body = await res.json();
    for (const item of body.value) {
      if (item.folder) {
        if (recursive) subfolders.push(`${folderPath}/${item.name}`);
      } else {
        files.push(item);
      }
    }
    url = body["@odata.nextLink"];
  }
  for (const sub of subfolders) files.push(...(await listFolder(token, sub, true)));
  return files;
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function percentile(nums, p) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
}

const MB = 1024 * 1024;

async function main() {
  const token = await getAccessToken();
  const folders = (await listPhotoFolders(token, env.photosFolder)).filter((f) => {
    if (f.month) {
      if (FROM && f.month < FROM) return false;
      if (TO && f.month > TO) return false;
      return true;
    }
    if (f.year) {
      if (FROM && f.year < FROM.slice(0, 4)) return false;
      if (TO && f.year > TO.slice(0, 4)) return false;
    }
    return true;
  });

  console.log(`Library: ${env.photosFolder} — ${folders.length} folder(s) in scope`);

  const byId = new Map();
  const byMonth = new Map();
  for (const f of folders) {
    const files = await listFolder(token, f.path, f.recursive);
    const videos = files.filter((it) => it.file?.mimeType?.startsWith("video/"));
    for (const v of videos) {
      if (byId.has(v.id)) continue;
      const rec = {
        id: v.id,
        name: v.name,
        size: v.size ?? 0,
        month: f.month,
        duration: v.video?.duration ?? null,
        width: v.video?.width ?? v.image?.width ?? null,
        height: v.video?.height ?? v.image?.height ?? null,
        fourCC: v.video?.fourCC ?? null,
        bitrate: v.video?.bitrate ?? null,
      };
      byId.set(v.id, rec);
      const key = f.month ?? "(loose)";
      byMonth.set(key, (byMonth.get(key) ?? 0) + 1);
    }
    process.stdout.write(`\r  scanned ${f.path} — ${byId.size} videos so far`.padEnd(90));
  }
  console.log("\n");

  const videos = [...byId.values()];
  if (!videos.length) {
    console.log("No videos in scope. (S1 is moot; nothing to download or caption.)");
    return;
  }

  const durations = videos.map((v) => v.duration).filter((d) => typeof d === "number");
  const sizes = videos.map((v) => v.size);
  const totalMs = durations.reduce((a, b) => a + b, 0);
  const totalBytes = sizes.reduce((a, b) => a + b, 0);
  const buckets = { "<10MB": 0, "10-25": 0, "25-50": 0, "50-100": 0, "100+": 0 };
  for (const s of sizes) {
    if (s < 10 * MB) buckets["<10MB"]++;
    else if (s < 25 * MB) buckets["10-25"]++;
    else if (s < 50 * MB) buckets["25-50"]++;
    else if (s < 100 * MB) buckets["50-100"]++;
    else buckets["100+"]++;
  }

  console.log(`== videos ==`);
  console.log(`count            ${videos.length}`);
  console.log(`total duration   ${(totalMs / 3600000).toFixed(2)} h  (avg ${(totalMs / durations.length / 1000).toFixed(1)}s, median ${(median(durations) / 1000).toFixed(1)}s)`);
  console.log(`total size       ${(totalBytes / 1024 ** 3).toFixed(2)} GB  (median ${(median(sizes) / MB).toFixed(1)}MB, p90 ${(percentile(sizes, 0.9) / MB).toFixed(1)}MB, max ${(Math.max(...sizes) / MB).toFixed(1)}MB)`);
  console.log(`size buckets     ${Object.entries(buckets).map(([k, v]) => `${k}: ${v}`).join("  ")}`);
  const codecs = {};
  for (const v of videos) codecs[v.fourCC ?? "?"] = (codecs[v.fourCC ?? "?"] ?? 0) + 1;
  console.log(`codecs           ${Object.entries(codecs).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join("  ")}`);
  console.log(`\nby month`);
  for (const [m, n] of [...byMonth.entries()].sort()) console.log(`  ${m.padEnd(10)} ${n}`);

  // ---- poster availability, on a bounded sample ----
  const step = Math.max(1, Math.floor(videos.length / THUMB_SAMPLE));
  const sample = videos.filter((_, i) => i % step === 0).slice(0, THUMB_SAMPLE);
  let hit = 0;
  const dims = {};
  const posterUrls = [];
  for (const v of sample) {
    try {
      const res = await graphGet(token, `${GRAPH}/me/drive/items/${v.id}/thumbnails?$select=large`, 3);
      if (res.ok) {
        const body = await res.json();
        const t = body.value?.[0]?.large;
        if (t?.url) {
          hit++;
          const key = `${t.width}x${t.height}`;
          dims[key] = (dims[key] ?? 0) + 1;
          posterUrls.push(t.url);
        }
      }
    } catch {
      /* treat as no poster */
    }
    process.stdout.write(`\r  poster probe ${hit}/${sample.length}`.padEnd(90));
  }
  console.log(`\n\n== poster (thumbnail) ==`);
  console.log(`hit rate         ${hit}/${sample.length} (${((hit / sample.length) * 100).toFixed(0)}%)`);
  console.log(`sizes seen       ${Object.entries(dims).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}×${v}`).join("  ")}`);

  const byteSample = posterUrls.slice(0, BYTES_SAMPLE);
  const posterBytes = [];
  for (const url of byteSample) {
    try {
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      posterBytes.push(buf.length);
    } catch {
      /* skip */
    }
  }
  if (posterBytes.length) {
    console.log(
      `poster bytes     median ${(median(posterBytes) / 1024).toFixed(0)}KB, p90 ${(
        percentile(posterBytes, 0.9) / 1024
      ).toFixed(0)}KB, max ${(Math.max(...posterBytes) / 1024).toFixed(0)}KB  (n=${posterBytes.length})`,
    );
    const projectedGB = (median(posterBytes) * hit * (videos.length / sample.length)) / 1024 ** 3;
    console.log(`S1 transfer est. ~${projectedGB.toFixed(2)} GB of posters (median × expected hits)`);
  }
  console.log(`\n(No original video bytes were downloaded. Nothing was written.)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
