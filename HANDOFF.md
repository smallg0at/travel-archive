# Handoff

For whoever picks this up next.

- **`README.md`** — what this is, quick start, one-time setup, licence.
- **`docs/design-brief.md`** — what the product is.
- **`TODO.md`** — a pointer to where the open items live (a private GitHub
  Project, so the entries' measurements stay out of a public repo).
- **`AGENTS.md`** — how to work in this repo (run to completion, report progress, measure before asserting).

This file is the front door. The depth lives in `docs/`:

| file | what |
|---|---|
| [`docs/pipeline.md`](docs/pipeline.md) | The storage layout, the three passes, providers, trips. |
| [`docs/clients.md`](docs/clients.md) | The web app, the phone app, the desktop shell, authentication. |
| [`docs/invariants.md`](docs/invariants.md) | The things that bite — every rule this codebase punishes you for forgetting. |
| [`docs/working-style.md`](docs/working-style.md) | How to work on this: measurement discipline, multi-session hygiene, the writing's register. |
| [`docs/architecture.md`](docs/architecture.md) | Subsystem notes: the phone's offline archive, the offline gazetteer, captioning. |
| [`docs/environment.md`](docs/environment.md) | This machine: `npm`/`fnm`, the job server at logon, the network. |
| [`docs/history.md`](docs/history.md) | Records, not rules: past regressions and the local-model measurements. |
| `private/TODO-history.md` | Frozen archive of the old TODO as of 2026-09-22. Kept on disk, not committed. |

---

## Running it

```
npm install
npm run --workspace pipeline build
npm run --workspace app build
npm run desktop          # Electron shell: serves the app, starts the job server
```

Or, without the shell: `npm run preview --workspace app -- --port 4173` and
`node pipeline/dist/serve.js` from `pipeline/`.

Node is installed via **fnm**, so every shell needs
`fnm env --use-on-cd | Out-String | Invoke-Expression` before `node` or `npm`
resolve. This is why the desktop shell spawns the job server through Electron's
own Node rather than `node` — a GUI-launched app has run no shell profile.

`npm run package` builds the installer (~90MB) into `desktop/release/`.

---

## Shape

Three workspaces plus a shell:

- **`shared/`** — the schema. `SCHEMA_VERSION` is **14**; `loadIndex` refuses a
  newer one rather than half-reading it. Runtime code lives in `types.ts` itself
  (`textKey`, `applyEdits`): the pipeline loads that file through Node's type
  stripping, where a relative import between `.ts` files would not resolve.
- **`pipeline/`** — `scan` (free, Graph listing only) → `analyze` (costs money,
  captions photos) → `organize` (day and place summaries) → `trip` (narrative).
  Plus `serve.ts`, the local job server on **127.0.0.1:18419**.
- **`app/`** — a reader. It never writes the archive; it asks the server to.
- **`desktop/`** — Electron. Serves `app/dist` on **17923** and spawns the job
  server.
- **`app/src/mobile/`** + **`app/android/`** — the phone app: its own page and
  layout over the same data layer, packaged with Capacitor. README "The phone
  app". Work on it at `http://localhost:17923/mobile/` with a phone viewport.

The archive itself lives in OneDrive as `index.json` plus `photos/<yyyy-mm>.json`
shards, mirrored locally under `pipeline/data/`.

A second language sits **beside** it, never inside it: `i18n/<lang>/index.json`
(day, stop, card and trip text, plus that language's hand edits under `owner`)
and `i18n/<lang>/photos/<yyyy-mm>.json` (captions), keyed by `textKey()` of the
original text — see `TranslationFile` in `shared/src/types.ts`. The index file's
`parts` lists which month files exist; sync and the app read it instead of
probing every month. Written by `jobs/translate.ts` (machine translation), by
organize and trip (`via: "native"`, the summarizers writing Chinese in the same
call), and by `jobs/dayEdit.ts` when an edit carries a `lang`. None of them
touches `index.json` or a shard.

**One language setting drives both** — that content and the interface around
it. The interface's words are `app/src/i18n/`: `en.ts` is the source and
`Messages` is its type, so `zh-Hans.ts` missing a key fails `tsc`. Anything with
a number is a function (that is where plurals live), and dates and numbers go
through `fmtDate`/`num` there, never a bare `toLocale*()`. Keys ending `Html`
are the only ones that may carry markup. `contentLang.ts` holds the setting and
must not import `i18n/` — `i18n/` reads the setting while it loads, and the
cycle would hit it uninitialised. Server and job log text stays English.

---

## Where things are

| | |
|---|---|
| day → place → cards layout | `app/src/render.ts` |
| photo viewer (card-scoped, zoom) | `app/src/viewer.ts` |
| sidebar, pins, look-ahead | `app/src/album.ts` |
| Settings page | `app/src/settings.ts` |
| generation config (`.env` at runtime) | `pipeline/src/configStore.ts` |
| Generate page | `app/src/tripMode.ts` |
| PDF export rules | `app/src/print.ts` + the `@media print` block |
| trip map | `app/src/tripMap.ts` |
| home map (whole-world, clustered) | `app/src/homeMap.ts` |
| trip + day-out detection | `pipeline/src/jobs/tripSuggest.ts` |
| trip suggestion UI | `app/src/tripSuggestions.ts` |
| day-out heading, Trip/Gallery switch | `app/src/album.ts` (`excursionPlace`, `modeToggle`) |
| map index + days out (`home.json`) | `pipeline/src/jobs/homeIndex.ts` |
| phone app: screens, stack, viewer | `app/src/mobile/` (`main.ts` routes, `router.ts`, `day.ts`) |
| phone app: native shell | `app/capacitor.config.ts`, `app/vite.mobile.config.ts`, `app/android/` |
| phone app: photos from the device | `app/src/mobile/devicePhotos.ts`, `android/…/LocalPhotosPlugin.java` |
| phone app: offline months, shard cache, incremental pull | `app/src/mobile/offline.ts`, `mobile/cache.ts` |
| phone app: MSAL bridge page | `app/auth.html` + `app/auth/main.ts` |
| thumbnails / disk cache | `pipeline/src/thumbStore.ts`, `serve.ts` |
| sync | `pipeline/src/jobs/sync.ts`, `syncStore.ts` |
| place names (offline) | `pipeline/src/geocodeOffline.ts` + `scripts/build-geo.mjs` |

Subsystem explanations — the phone's offline archive, the offline gazetteer, street level — are in [`docs/architecture.md`](docs/architecture.md).

---

## The one piece of work with real value left

**Caption what is left** — the 2,574 uncaptioned photos are mostly **deliberate**:
2,395 are withheld screenshots. The genuinely capturable remainder was **52**
(31 photos + 21 videos) on 2026-09-24, of which 41 have no Graph thumbnail at all
— older videos, HEIC and DNG, which the thumbnail pipeline does not decode. There
is no model work left in the archive; what remains is a **local decode** for those
41 if they are wanted.

How captioning works, for when it is needed again: [`docs/architecture.md`](docs/architecture.md#how-captioning-works-for-when-it-is-needed-again).
