#!/usr/bin/env node
/**
 * Generate `THIRD-PARTY-NOTICES.md` from the installed tree.
 *
 * A distributed build owes the licence text of everything it bundles, so this is
 * a build artefact rather than a hand-kept list — a hand-kept list falls behind
 * the dependency set silently, and the one time it matters is the one time
 * nobody checked.
 *
 * It walks `package-lock.json`, takes each **production** package's declared
 * licence, and copies the full text of every distinct licence from one installed
 * package that carries it. Dev-only packages are excluded: they are not bundled.
 *
 * Usage:  node scripts/third-party-notices.mjs
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(REPO, "THIRD-PARTY-NOTICES.md");
const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENSE-MIT", "COPYING"];

const lock = JSON.parse(readFileSync(join(REPO, "package-lock.json"), "utf8"));

function licenceText(dir) {
  for (const name of LICENSE_FILES) {
    const path = join(REPO, dir, name);
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf8").trim();
      if (text.length > 40) return text;
    } catch {}
  }
  return null;
}

const packages = [];
for (const [path, meta] of Object.entries(lock.packages ?? {})) {
  if (!path || meta.dev || meta.link) continue;
  // Workspace roots (`app`, `pipeline`, ...) and the links to them are this
  // repository, not third parties — they have no licence field and should not
  // appear as "no licence declared".
  if (!path.includes("node_modules/") || path.startsWith("node_modules/@travel-archive/")) continue;
  const name = path.replace(/^.*node_modules\//, "");
  let license = meta.license ?? null;
  const pkgJson = join(REPO, path, "package.json");
  if (existsSync(pkgJson)) {
    try {
      license = JSON.parse(readFileSync(pkgJson, "utf8")).license ?? license;
    } catch {}
  }
  packages.push({ name, version: meta.version, license, dir: path, text: licenceText(path) });
}

/** `A AND B` / `(MIT OR CC0-1.0)` -> the individual identifiers. */
const identifiers = (license) =>
  license
    ? license
        .replace(/[()]/g, "")
        .split(/\s+(?:AND|OR)\s+/i)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

const tally = new Map();
for (const p of packages) {
  const key = p.license ?? "no licence declared";
  tally.set(key, (tally.get(key) ?? 0) + 1);
}

/** One full text per identifier, taken from whichever installed package has one. */
const texts = new Map();
for (const p of packages) {
  for (const id of identifiers(p.license)) {
    if (texts.has(id) || !p.text) continue;
    texts.set(id, { from: `${p.name}@${p.version}`, text: p.text });
  }
}

const lines = [
  "# Third-party notices",
  "",
  "This project is licensed **AGPL-3.0-or-later** (see [`LICENSE`](LICENSE)). It",
  "depends on the work of others, whose licences are reproduced here.",
  "",
  "**Generated** by `scripts/third-party-notices.mjs` from `package-lock.json` and",
  "the installed packages — do not edit by hand; run the script instead. Only",
  "production dependencies are listed, because only they are bundled in a build.",
  "",
  "## Licence inventory",
  "",
  "| Licence | Packages |",
  "| --- | --- |",
];
for (const [license, count] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
  lines.push(`| \`${license}\` | ${count} |`);
}

lines.push("", "## Packages", "");
for (const p of packages.slice().sort((a, b) => a.name.localeCompare(b.name))) {
  lines.push(`- \`${p.name}@${p.version}\` — ${p.license ?? "no licence declared"}`);
}

lines.push("", "## Licence texts", "");
for (const [id, entry] of [...texts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  lines.push(`### ${id}`, "", `Taken from \`${entry.from}\`.`, "", "```", entry.text, "```", "");
}
const missing = [...new Set(packages.flatMap((p) => identifiers(p.license)))].filter((id) => !texts.has(id));
if (missing.length) {
  lines.push("## Licences with no text found in the tree", "", ...missing.map((id) => `- \`${id}\``), "");
}

writeFileSync(OUT, lines.join("\n"));
console.log(`wrote ${OUT}`);
console.log(`  packages: ${packages.length}`);
console.log(`  licence texts: ${texts.size}${missing.length ? `  (${missing.length} not found: ${missing.join(", ")})` : ""}`);
