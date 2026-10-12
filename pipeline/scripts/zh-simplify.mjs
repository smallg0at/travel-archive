/**
 * Traditional Chinese place names, in Simplified.
 *
 * GeoNames tags most Chinese names `zh-Hans` or `zh-CN`, but some places carry
 * only a generic `zh` entry, and a fair number of those are Traditional: the
 * trim came out with traditional forms (維, 紐) beside simplified ones (纽, 龙). The archive reads
 * 简体中文, so they are converted once here rather than left mixed.
 *
 * OpenCC's table is build-time only — nothing at runtime depends on it, and
 * places.tsv ships already converted.
 *
 * Run `node scripts/zh-simplify.mjs --fix` to convert the built files in place;
 * build-geo.mjs applies the same function when it writes them.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as OpenCC from "opencc-js";

/** Hong Kong/Taiwan forms to mainland Simplified, characters and common phrases. */
const convert = OpenCC.Converter({ from: "hk", to: "cn" });

export function toSimplified(text) {
  if (!text) return text;
  return convert(text);
}

function fixFile(path, column) {
  const lines = readFileSync(path, "utf8").split("\n");
  let changed = 0;
  const samples = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = lines[i].split("\t");
    const was = f[column];
    if (!was) continue;
    const now = toSimplified(was);
    if (now === was) continue;
    if (samples.length < 8) samples.push(`${was} -> ${now}`);
    f[column] = now;
    lines[i] = f.join("\t");
    changed++;
  }
  writeFileSync(path, lines.join("\n"), "utf8");
  console.log(`${path}: ${changed} name(s) converted`);
  for (const s of samples) console.log(`  ${s}`);
}

if (process.argv.includes("--fix")) {
  const geo = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "geo");
  fixFile(join(geo, "places.tsv"), 6);
  fixFile(join(geo, "countries.tsv"), 3);
}
