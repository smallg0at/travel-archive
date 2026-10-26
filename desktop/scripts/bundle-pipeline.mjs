/**
 * Bundles the pipeline job server into one file for packaging.
 *
 * npm workspaces hoist dependencies to the root `node_modules`, so there is no
 * `pipeline/node_modules` tree to ship — and copying the root one would drag in
 * Electron, Vite and the whole toolchain. Bundling produces a single ~3MB file
 * with the six runtime dependencies inlined instead.
 *
 * **ESM, not CJS.** `pipeline/src/paths.ts` locates the files that ship beside
 * the code with `import.meta.url`, which esbuild leaves empty under CJS — the
 * screenshot allowlist would then be looked for in the wrong directory.
 *
 * **The output path is load-bearing** for the same reason: `paths.ts` resolves
 * config as `../<name>` from its own module, so the bundle has to sit one level
 * below the directory holding `screenshot-apps.json`, exactly as `dist/` does
 * in a checkout.
 */
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
// staging/, not build/ — electron-builder treats build/ as its own resources
// directory (that is where the icon lives) and excludes it from the app.
const STAGE = resolve(ROOT, "desktop/staging/pipeline");
const OUT = resolve(STAGE, "dist/server.mjs");

/**
 * Configuration compiled into the bundle as a fallback for `process.env`.
 *
 * An installed app has no checkout, and `AZURE_CLIENT_ID` is *required* — so
 * without this a fresh machine got a job server that refused to start, and
 * generation did not fail visibly, it simply was not there. Baking the
 * non-secret settings lets the server come up and report something specific.
 *
 * **Allowlist, not a blocklist.** Only these names are ever baked; an API key
 * added to `.env` later cannot be swept in by accident. The values come from
 * the building machine's own `.env`, so nothing personal enters the repository
 * — but the installer does carry them, which makes the .exe personal.
 */
// ONEDRIVE_PHOTOS_FOLDER is deliberately NOT baked: this machine's path is
// not anybody else's and the shipped default matches neither this account nor
// OneDrive's photo-sync layout — the setup wizard asks instead (docs/oobe.md,
// ruled 2026-10-08). The metadata folder stays, with a literal fallback
// below: it names where the archive *lives*, a wrong value strands a first
// run in an empty namespace, and the ruling was that a default must already
// be present rather than left to the user.
const BAKE = [
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "ONEDRIVE_METADATA_FOLDER",
  "GEOCODE_CONTACT_EMAIL",
  "AI_PROVIDER",
  "GEMINI_MODEL",
  "GEMINI_THINKING_BUDGET",
  "ANALYZE_CONCURRENCY",
];

/** Belt and braces: refuse to bake anything that looks like a credential. */
const SECRET = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i;

function bakedConfig() {
  const envPath = resolve(ROOT, "pipeline/.env");
  const fromFile = {};
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, key, rawValue] = m;
      if (!BAKE.includes(key) || SECRET.test(key)) continue;
      const value = rawValue.trim().replace(/^['"]|['"]$/g, "");
      if (value) fromFile[key] = value;
    }
    console.log(`read ${Object.keys(fromFile).length} setting(s) from pipeline/.env`);
  } else {
    console.warn("no pipeline/.env — falling back to the environment");
  }

  // CI has no .env: it passes these from repository variables. Without this a
  // release build baked nothing, and `env.ts` then refused to start at all —
  // an installer that could never sign in, which no earlier step noticed.
  const out = { ...fromFile };
  for (const key of BAKE) {
    if (out[key] || SECRET.test(key)) continue;
    const value = process.env[key]?.trim();
    if (value) out[key] = value;
  }
  console.log(`baking ${Object.keys(out).length} setting(s): ${Object.keys(out).join(", ")}`);

  if (!out.AZURE_CLIENT_ID) {
    throw new Error(
      "AZURE_CLIENT_ID is missing: an install built without it cannot sign in. " +
        "Put it in pipeline/.env (see .env.example) or set it in the environment.",
    );
  }
  // Guarantee, not hope: every build carries a metadata folder. The builder's
  // value when there is one; the documented default otherwise — never nothing.
  if (!out.ONEDRIVE_METADATA_FOLDER) out.ONEDRIVE_METADATA_FOLDER = "Apps/TravelArchive";
  return out;
}

await build({
  entryPoints: [resolve(ROOT, "pipeline/dist/serve.js")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: OUT,
  logLevel: "warning",
  // Electron supplies these; bundling them would be wrong even if it worked.
  external: ["electron"],
  define: { __BAKED_CONFIG__: JSON.stringify(bakedConfig()) },
  banner: {
    // Some bundled dependencies are CommonJS and expect `require` to exist.
    // Under ESM it does not, so it is recreated from the module's own URL.
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
});

// The allowlist ships beside the code, one level above dist/ — see paths.ts.
mkdirSync(STAGE, { recursive: true });
copyFileSync(resolve(ROOT, "pipeline/screenshot-apps.json"), resolve(STAGE, "screenshot-apps.json"));

/**
 * The offline gazetteer ships too, and unlike the allowlist it cannot be
 * regenerated on the user's machine: it is built from GeoNames downloads.
 *
 * Leaving it out packaged an app whose captioning died on its first photo
 * with `ENOENT … data\geo\countries.tsv`, after the user had paid for the
 * run. Failing the build here is the whole point — a package without it is
 * broken, not smaller.
 */
const GEO = ["places.tsv", "countries.tsv", "countries.geo.json"];
for (const name of GEO) {
  const from = resolve(ROOT, "pipeline/data/geo", name);
  if (!existsSync(from)) {
    throw new Error(`missing pipeline/data/geo/${name} — run "npm run --workspace pipeline geo:build" before packaging`);
  }
  const to = resolve(STAGE, "data/geo", name);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

console.log(`bundled ${(statSync(OUT).size / 1024 / 1024).toFixed(1)} MB -> ${OUT}`);
console.log(`copied screenshot-apps.json and ${GEO.length} gazetteer files alongside it`);

/**
 * What this payload was built from, written beside it.
 *
 * A tag, a checkout and an installer were three claims with nothing tying them
 * together: the 1.0.2 installer gave no way to ask "which commit are you?".
 * `scripts/smoke-package.mjs` compares this file against the checkout and, in
 * CI, against the tag it was asked to build, so the chain is verifiable from
 * the artifact rather than from the release log.
 */
const { execFileSync } = await import("node:child_process");
const git = (args) => {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
};
const version = JSON.parse(readFileSync(resolve(ROOT, "desktop/package.json"), "utf-8")).version;
const buildInfo = {
  version,
  commit: git(["rev-parse", "HEAD"]),
  dirty: Boolean(git(["status", "--porcelain"])),
  builtAt: new Date().toISOString(),
};
writeFileSync(resolve(STAGE, "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`, "utf-8");
console.log(`build-info: ${version} ${buildInfo.commit?.slice(0, 7) ?? "(no git)"}${buildInfo.dirty ? " + uncommitted changes" : ""}`);
