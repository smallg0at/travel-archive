import { mkdir, writeFile } from "node:fs/promises";
import type { PhotoRecord } from "@travel-archive/shared";
import { getAccessToken } from "./auth.js";
import { loadIndex, loadShard } from "./archiveStore.js";
import { fetchItemHashes, type ItemHashes } from "./graph.js";
import { dataFile } from "./paths.js";
import { pooled } from "./jobs/analyze.js";
import { stripCopySuffix } from "./duplicates.js";

/**
 * Which duplicate files could be deleted from OneDrive — a dry run. It
 * deletes nothing, and has no way to.
 *
 *   npm run --workspace pipeline dedupe
 *
 * Takes the archive's "exact" duplicate groups (same name less a copy suffix,
 * or same capture instant, pixels and size — duplicates.ts) and checks each
 * copy against the photo the group keeps by the files' own content hashes,
 * because those rules are inference and a deletion must not be. A copy counts
 * as safe to delete only when the strongest hash both files carry matches:
 * SHA-256, else SHA-1, else QuickXor. Bursts are never listed — they are
 * different frames.
 *
 * Writes `data/dedupe/dry-run-<time>.json` and `.csv` for the owner to read.
 * Actual deletion is a separate step, to be built after that list has been
 * reviewed, and would move files to the OneDrive recycle bin.
 */

const AT_ONCE = 6;

type Verdict = "same-bytes" | "different" | "unverifiable" | "gone";

interface Row {
  month: string;
  keepPath: string;
  copyPath: string;
  copyId: string;
  bytes: number;
  hash: "sha256" | "sha1" | "quickXor" | null;
  verdict: Verdict;
}

function compare(keep: ItemHashes, copy: ItemHashes): { hash: Row["hash"]; same: boolean | null } {
  for (const kind of ["sha256", "sha1", "quickXor"] as const) {
    if (keep[kind] && copy[kind]) return { hash: kind, same: keep[kind] === copy[kind] };
  }
  return { hash: null, same: null };
}

const csvField = (v: string | number | null) => `"${String(v ?? "").replace(/"/g, '""')}"`;

async function main(): Promise<void> {
  const token = await getAccessToken();
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
  // Keep the file with the original name. The archive's representative is the
  // largest file, and identical copies tie, so it was as often "IMG_1 1.jpg"
  // as "IMG_1.jpg" — the first dry run would have deleted the original name in
  // most groups (1,116 of 1,377) and kept the " 1" copy. Captions are not a
  // reason to prefer the representative: they are inherited by every member.
  const clean = (p: PhotoRecord) => stripCopySuffix(p.fileName) === p.fileName;
  const pairs = [...groups.values()].flatMap(({ month, photos }) => {
    const keep =
      photos.find((p) => p.isDuplicateRepresentative && clean(p)) ??
      photos.find(clean) ??
      photos.find((p) => p.isDuplicateRepresentative);
    return keep ? photos.filter((p) => p !== keep).map((copy) => ({ month, keep, copy })) : [];
  });
  console.log(`${groups.size} exact group(s), ${pairs.length} copy(ies) to check against the photo each group keeps.`);

  const hashes = new Map<string, ItemHashes | null>();
  const ids = [...new Set(pairs.flatMap(({ keep, copy }) => [keep.id, copy.id]))];
  let fetched = 0;
  await pooled(ids, AT_ONCE, async (id) => {
    hashes.set(id, await fetchItemHashes(token, id));
    if (++fetched % 200 === 0) console.log(`  hashes ${fetched}/${ids.length}`);
  });

  const rows: Row[] = pairs.map(({ month, keep, copy }) => {
    const k = hashes.get(keep.id);
    const c = hashes.get(copy.id);
    const base = { month, keepPath: keep.oneDrivePath, copyPath: copy.oneDrivePath, copyId: copy.id, bytes: copy.bytes };
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
