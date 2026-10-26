# Verifying a packaged build

A checkout and an install are different products. The checkout has
`pipeline/data/`, a full `node_modules`, and `app/dist` beside the code; the
install has only what `electron-builder` copied into `resources/`. Every
packaging bug found so far came from that difference:

| Missing from the payload | What a user saw |
|---|---|
| `sharp`'s native libraries | local rendering silently off; a permanent warning line |
| `data/geo/*` | captioning died on its first photo, after the paid run started (1.0.2) |
| `app-dist` | the API answered and there was no page to type |

Reading the source cannot catch any of them. Starting the artifact and asking
it a question can.

## Build, then check

```
npm run package          # app build → pipeline build → electron-builder
npm run smoke:package    # starts desktop/release/win-unpacked and asserts things
```

`desktop/release/win-unpacked/` is the same tree the installer copies, so
testing it is testing the install without installing.

The check, in order:

1. **Payload files exist and are non-empty** — `server.mjs`, the three
   gazetteer files, `screenshot-apps.json`, `app-dist/index.html`. Each is named
   individually so a failure says which file, not "something went wrong".
2. **The artifact says what it is.** `resources/pipeline/build-info.json` carries
   version, commit and whether the tree was dirty when it was built. The check
   compares the version with `desktop/package.json`, the commit with the
   checkout, and — in CI — the version with the tag that was asked for, so a tag
   cannot quietly build different code.
3. **The gazetteer resolves from beside the code.** A probe is bundled into
   `resources/pipeline/dist/`, which makes `paths.ts` compute its module root as
   `resources/pipeline` — the root the real server sees — and it resolves one
   coordinate. This is the check that 1.0.2 would have failed.
4. **The server starts** from `resources/` against a throwaway home, with the
   app's own runtime (`ELECTRON_RUN_AS_NODE`), and `/health`, `/`, `/mobile/`
   and `/oobe` answer.

Options: `--staging` tests `desktop/staging` with the local node instead of the
packed exe; `--self-check` copies the payload, deletes the gazetteer and proves
the check rejects it (a test that cannot fail is decoration); `--require-clean`
fails when the payload was built from a dirty tree; `--expect-version v1.0.3`
pins the version CI was asked to build; `--require-render` turns the `sharp`
warning into a failure, for when the native libraries are bundled.

CI runs `node scripts/smoke-package.mjs --self-check` after `npm run package`
and before attaching the installer, so a payload-less build cannot reach a
release.

## What it still cannot see

- OneDrive, tokens and AI providers: CI has no credentials and must not need
  any. The archive paths are covered by unit tests, not here.
- The UI itself: the page must answer, not look right.
- The NSIS script: it copies the same `win-unpacked` tree, but the installer's
  own steps (shortcuts, uninstall entries) are only exercised by installing on a
  real machine.
- `sharp`: reported as a warning until its native libraries ship (see the
  desktop item for bundling `@img/sharp-win32-x64`).

When a packaging failure is fixed, add the check here first. The test exists
because "works on my machine" was true three times while the install was broken.
