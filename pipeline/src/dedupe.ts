import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { PhotoRecord } from "@travel-archive/shared";
import { getAccessToken } from "./auth.js";
import { loadIndex, loadShard } from "./archiveStore.js";
import { fetchItemHashes, recycleItem, type ItemHashes } from "./graph.js";
import { dataFile } from "./paths.js";
import { pooled } from "./jobs/analyze.js";
import { stripCopySuffix } from "./duplicates.js";

/**
 * Duplicate files in OneDrive: which could go, and — once that list has been
 * seen — sending them to the recycle bin.
 *
 *   npm run --workspace pipeline dedupe                          dry run, deletes nothing
 *   npm run --workspace pipeline dedupe -- --apply <dry-run.json>
 *
 * The dry run takes the archive's "exact" duplicate groups (same name less a
 * copy suffix, or same capture instant, pixels and size — duplicates.ts) and
 * checks each copy against the file the group keeps by the files' own content
 * hashes, because those rules are inference and a deletion must not be. A
 * copy counts only when the strongest hash both files carry matches: SHA-256,
 * else SHA-1, else QuickXor. Bursts are never listed — they are different
 * frames. It writes `data/dedupe/dry-run-<time>.json` and `.csv`.
 *
 * `--apply` acts on one reviewed dry run and nothing else: only its
 * "same-bytes" rows, and each only after both files' hashes are read again
 * and still match, with the kept file still there. Deleted means OneDrive's
 * recycle bin, restorable for about 30 days. A scan afterwards drops the
 * records. Owner's go-ahead 2026-09-11: "same hash images are obviously safe".
 */

const AT_ONCE = 6;
const DELETE_AT_ONCE = 4;

type Verdict = "same-bytes" | "different" | "unverifiable" | "gone";

interface Row {
  month: string;
  keepPath: string;
  keepId: string;
  copyPath: string;
  copyId: string;
  bytes: number;
  hash: "sha256" | "sha1" | "quickXor" | null;
  verdict: Verdict;
}

interface Pair {
  month: string;
  keep: PhotoRecord;
  copy: PhotoRecord;
}

function compare(keep: ItemHashes, copy: ItemHashes): { hash: Row["hash"]; same: boolean | null } {
  for (const kind of ["sha256", "sha1", "quickXor"] as const) {
    if (keep[kind] && copy[kind]) return { hash: kind, same: keep[kind] === copy[kind] };
  }
  return { hash: null, same: null };
}

const csvField = (v: string | number | null) => `"${String(v ?? "").replace(/"/g, '""')}"`;

/**
 * Every copy in an exact group, paired with the file its group keeps.
 *
 * Keep the file with the original name. The archive's representative is the
 * largest file, and identical copies tie, so it was as often "IMG_1 1.jpg" as
 * "IMG_1.jpg" — the first dry run would have deleted the original name in
 * most groups (1,116 of 1,377) and kept the " 1" copy. Captions are not a
 * reason to prefer the representative: they are inherited by every member.
 */
async function pairsOf(token: string): Promise<{ groups: number; pairs: Pair[] }> {
  const index = await loadIndex(token);
  const groups = new Map<string, { month: string; photos: PhotoRecord[] }>();
  for (const summary of index.months) {
    const shard = await loadShard(token, summary.month);
    for (const photo of Object.values(shard.photos)) {
      if (photo.duplicateKind !== "exact" || !photo.duplicateGroupId) continue;
      const key = `${summary.month}/${photo.duplicateGroupId}`;
      const group = groups.get(key) ?? { month: summary.month, photos: [] };
      group.photos.push(photo);
      groups.set(key, group);
    }
  }
  const clean = (p: PhotoRecord) => stripCopySuffix(p.fileName) === p.fileName;
  const pairs = [...groups.values()].flatMap(({ month, photos }) => {
    const keep =
      photos.find((p) => p.isDuplicateRepresentative && clean(p)) ??
      photos.find(clean) ??
      photos.find((p) => p.isDuplicateRepresentative);
    return keep ? photos.filter((p) => p !== keep).map((copy) => ({ month, keep, copy })) : [];
  });
  return { groups: groups.size, pairs };
}

async function hashesFor(token: string, ids: string[]): Promise<Map<string, ItemHashes | null>> {
  const hashes = new Map<string, ItemHashes | null>();
  let fetched = 0;
  await pooled(ids, AT_ONCE, async (id) => {
    hashes.set(id, await fetchItemHashes(token, id));
    if (++fetched % 200 === 0) console.log(`  hashes ${fetched}/${ids.length}`);
  });
  return hashes;
}

async function dryRun(): Promise<void> {
  const token = await getAccessToken();
  const { groups, pairs } = await pairsOf(token);
  console.log(`${groups} exact group(s), ${pairs.length} copy(ies) to check against the file each group keeps.`);
  const hashes = await hashesFor(token, [...new Set(pairs.flatMap(({ keep, copy }) => [keep.id, copy.id]))]);

  const rows: Row[] = pairs.map(({ month, keep, copy }) => {
    const k = hashes.get(keep.id);
    const c = hashes.get(copy.id);
    const base = {
      month,
      keepPath: keep.oneDrivePath,
      keepId: keep.id,
      copyPath: copy.oneDrivePath,
      copyId: copy.id,
      bytes: copy.bytes,
    };
    if (!k || !c) return { ...base, hash: null, verdict: "gone" };
    const { hash, same } = compare(k, c);
    return { ...base, hash, verdict: same === null ? "unverifiable" : same ? "same-bytes" : "different" };
  });

  const count = (v: Verdict) => rows.filter((r) => r.verdict === v).length;
  const reclaim = rows.filter((r) => r.verdict === "same-bytes").reduce((n, r) => n + r.bytes, 0);
  const byHash = rows.reduce<Record<string, number>>((acc, r) => ((acc[r.hash ?? "none"] = (acc[r.hash ?? "none"] ?? 0) + 1), acc), {});

  const dir = dataFile("dedupe");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const json = `${dir}/dry-run-${stamp}.json`;
  const csv = `${dir}/dry-run-${stamp}.csv`;
  await writeFile(json, JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 1), "utf-8");
  await writeFile(
    csv,
    ["verdict,hash,bytes,month,copy (would be deleted),keep,copy id"]
      .concat(rows.map((r) => [r.verdict, r.hash, r.bytes, r.month, r.copyPath, r.keepPath, r.copyId].map(csvField).join(",")))
      .join("\n"),
    "utf-8",
  );

  console.log(`
Dry run — nothing was deleted.
  same bytes:    ${count("same-bytes")} (${(reclaim / 1e9).toFixed(2)} GB)
  different:     ${count("different")}  (the archive's rule matched, the bytes do not — kept)
  unverifiable:  ${count("unverifiable")}  (no hash both files carry — kept)
  gone:          ${count("gone")}  (a file no longer in OneDrive — nothing to do)
  compared by:   ${JSON.stringify(byHash)}
Report: ${csv}`);
}

type Outcome = "recycled" | "skipped-changed" | "skipped-gone" | "failed";

async function apply(reportPath: string): Promise<void> {
  const report = JSON.parse(await readFile(reportPath, "utf-8")) as { rows: Row[] };
  const approved = new Set(report.rows.filter((r) => r.verdict === "same-bytes").map((r) => r.copyId));
  if (approved.size === 0) throw new Error(`${reportPath} lists nothing byte-identical to delete.`);

  const token = await getAccessToken();
  // Re-derived from the archive rather than trusted from the file, so a copy
  // is deleted only if it is still a copy of the file kept beside it now.
  const { pairs } = await pairsOf(token);
  const todo = pairs.filter((p) => approved.has(p.copy.id) && p.copy.id !== p.keep.id);
  console.log(`${approved.size} approved in ${reportPath}; ${todo.length} still paired with the file they duplicate.`);

  const hashes = await hashesFor(token, [...new Set(todo.flatMap(({ keep, copy }) => [keep.id, copy.id]))]);
  const results: { copyPath: string; keepPath: string; copyId: string; bytes: number; outcome: Outcome; error?: string }[] = [];
  let done = 0;
  await pooled(todo, DELETE_AT_ONCE, async ({ keep, copy }) => {
    const k = hashes.get(keep.id);
    const c = hashes.get(copy.id);
    const base = { copyPath: copy.oneDrivePath, keepPath: keep.oneDrivePath, copyId: copy.id, bytes: copy.bytes };
    if (!k || !c) {
      results.push({ ...base, outcome: "skipped-gone" });
      return;
    }
    if (compare(k, c).same !== true) {
      results.push({ ...base, outcome: "skipped-changed" });
      return;
    }
    try {
      await recycleItem(token, copy.id);
      results.push({ ...base, outcome: "recycled" });
    } catch (err) {
      results.push({ ...base, outcome: "failed", error: (err as Error).message });
    }
    if (++done % 100 === 0) console.log(`  recycled ${done}/${todo.length}`);
  });

  const count = (o: Outcome) => results.filter((r) => r.outcome === o).length;
  const freed = results.filter((r) => r.outcome === "recycled").reduce((n, r) => n + r.bytes, 0);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = dataFile("dedupe", `applied-${stamp}.json`);
  await writeFile(out, JSON.stringify({ report: reportPath, appliedAt: new Date().toISOString(), results }, null, 1), "utf-8");
  console.log(`
Recycled:          ${count("recycled")} (${(freed / 1e9).toFixed(2)} GB) — in OneDrive's recycle bin for about 30 days
Skipped, changed:  ${count("skipped-changed")}
Skipped, gone:     ${count("skipped-gone")}
Failed:            ${count("failed")}
Record: ${out}
Run a scan so the archive drops the deleted copies.`);
}

async function main(): Promise<void> {
  const i = process.argv.indexOf("--apply");
  if (i < 0) return dryRun();
  const report = process.argv[i + 1];
  if (!report) throw new Error("--apply needs the dry-run .json it acts on.");
  return apply(report);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
