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
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
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
const BAKE = [
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "ONEDRIVE_PHOTOS_FOLDER",
  "ONEDRIVE_METADATA_FOLDER",
  "GEOCODE_CONTACT_EMAIL",
  "AI_PROVIDER",
  "ANTHROPIC_MODEL",
  "GEMINI_MODEL",
  "GEMINI_THINKING_BUDGET",
  "ANALYZE_CONCURRENCY",
];

/** Belt and braces: refuse to bake anything that looks like a credential. */
const SECRET = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i;

function bakedConfig() {
  const envPath = resolve(ROOT, "pipeline/.env");
  if (!existsSync(envPath)) {
    console.warn("no pipeline/.env — building with no baked configuration");
    return {};
  }
  const out = {};
  for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (!BAKE.includes(key) || SECRET.test(key)) continue;
    const value = rawValue.trim().replace(/^['"]|['"]$/g, "");
    if (value) out[key] = value;
  }
  console.log(`baking ${Object.keys(out).length} setting(s): ${Object.keys(out).join(", ")}`);
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

console.log(`bundled ${(statSync(OUT).size / 1024 / 1024).toFixed(1)} MB -> ${OUT}`);
console.log("copied screenshot-apps.json alongside it");
