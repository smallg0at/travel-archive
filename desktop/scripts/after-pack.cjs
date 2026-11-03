/**
 * Puts the native packages into the packaged app.
 *
 * `extraResources` copies `staging/pipeline` — but electron-builder drops any
 * `node_modules` directory inside an extraResources source, silently, even
 * though that is exactly where Node looks for the native half of `sharp`
 * (measured 2026-11-04: `resources/pipeline/node_modules` was absent from
 * `win-unpacked` while the same tree in `staging/` had it). A hook is the point
 * in the build where the copy is not subject to that filter.
 *
 * The failing alternative is a packaged server that answers `/health` with
 * `render: {images: false}` and quietly falls back to OneDrive thumbnails for
 * everything — see `docs/packaging.md`.
 */
const { cpSync, existsSync } = require("node:fs");
const { join, resolve } = require("node:path");

exports.default = async function afterPack(context) {
  const from = resolve(context.packager.projectDir, "staging/pipeline/node_modules");
  const to = join(context.appOutDir, "resources/pipeline/node_modules");

  if (!existsSync(from)) {
    throw new Error(`missing ${from} — run "npm run bundle" before packaging`);
  }
  cpSync(from, to, { recursive: true });
  console.log(`  • copied native packages  from=${from} to=${to}`);
};
