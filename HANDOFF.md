# Handoff

For whoever picks this up next. Read `README.md` for how the pipeline works and
`docs/design-brief.md` for what the product is; this file is the things you
would otherwise have to learn by breaking them.

`TODO.md` is the live checklist and the only place that should be trusted for
what is outstanding — open items are listed first in each section, with fixes
kept below under "Resolved" for the measurement detail they record.

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
  Plus `serve.ts`, the local job server on **127.0.0.1:4319**.
- **`app/`** — a reader. It never writes the archive; it asks the server to.
- **`desktop/`** — Electron. Serves `app/dist` on **17923** and spawns the job
  server.

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

## Invariants — the things that bite

**The server is the only writer.** Every mutation goes through
`pipeline/src/serve.ts`, which holds the archive lock (`pipeline/src/lock.ts`) for
the duration of a write. Two writers clobbering the same shard has actually
happened. If you add a way for the app to change the archive, route it through
the server or you break sync's dirty flag.

**A read-only path must read the mirror, not OneDrive.** `saveIndex` and
`saveShard` write local first and upload second, so `pipeline/data/` holds
identical bytes. Use `loadIndexForReading` / `loadShardForReading` for anything
that only reads; `loadIndex` / `loadShard` stay on Graph for write paths, where
a mirror gone stale on another machine would be merged onto and uploaded over
the newer copy. This has now been found in three separate places
(`/archive/status`, `planAnalyze`, `loadAllShards`), each time as a
multi-second wait with an instant answer sitting on disk.

**Paths split two ways** (`pipeline/src/paths.ts`). Writable per-user state
resolves from `ARCHIVE_HOME`; read-only config that ships with the build
resolves from the module. Get this wrong and an installed app writes into a
read-only directory, or reads a config file that is not there.

**The app must load over `http://localhost` on a registered port.** MSAL derives
its redirect URI from `window.location.origin`, and it has to match a URI
registered under Azure's *Single-page application* platform. `file://` has a
null origin. Changing the desktop port means registering the URI **and** adding
the origin to `ALLOWED_ORIGINS` in `serve.ts` — miss the second and the archive
renders but every job request fails CORS silently.

**`/auth/` with the trailing slash serves a bridge page**, not the app. The
static server in `desktop/src/static.ts` reproduces that deliberately. Serve the
app there instead and sign-in breaks in a way that looks like an MSAL problem.

**No backend is a supported state, not a failure.** It is the phone. A failed
health check means: no Generate page, no pins, thumbnails via Graph + IndexedDB.
Every feature needs that path to degrade rather than error.

**`Vary: Origin` must be sent whether or not the request had an Origin.**
Thumbnails are cached `immutable` for a year. Send it only when an `Origin` is
present and a no-CORS fetch caches a copy with no record that CORS mattered —
the browser then hands that copy to a later CORS request, which fails because it
carries no `Access-Control-Allow-Origin`. It presents as "some images load and
some do not", it fails in ~4ms so it does not look like a network problem, and
it survives clearing the server's cache because the bad copy is in the browser's.
A fix here cannot repair entries already cached, so `THUMB_CACHE_VERSION` in
`app/src/backend.ts` exists to retire them: bump it and every thumbnail URL
changes, which abandons the poisoned entries without asking anyone to clear a
browser cache — and clearing one *before* the server fix just re-poisons on the
next load.

**Images must be CORS-clean or the PDF export dies.** The export draws every
card image onto a canvas and calls `toDataURL`; a cross-origin image loaded
without `crossOrigin` taints it and that throws. Thumbnails come from the local
server's own origin now, so `ThumbnailSource.crossOrigin` opts in — **per
source, never blanket**: setting it on a host that does not send
`Access-Control-Allow-Origin` makes the image fail to load outright, which is
why the Graph CDN path leaves it unset.

**Config can be written at runtime, so nothing may capture it at import.**
`POST /config` writes `.env` and calls `reloadEnv()`, which updates the `env`
object in place. That reaches every `env.x` read at call time — but a
module-level `const KEY = env.key` would hold the old value for the life of the
process, which is why both providers build their clients lazily. `/config`
writes only an **allowlist** of names: it turns a request into environment
variables the process reads on next start, so an unrestricted version would let
`NODE_OPTIONS` run arbitrary code.

**`process.env` beats `.env`, silently.** dotenv never overrides a real
environment variable, so a key saved in Settings works until the next restart
and then loses to the machine's own setting. This machine has `GEMINI_API_KEY`
set system-wide, which is exactly the case; `configStatus.shadowed` reports it
and the form warns.

**Nothing personal is committed.** `.env`, `token-cache.json`,
`redaction-terms.json` and all of `data/` are ignored. Check with
`git check-ignore`, not by reading `.gitignore`. The repo is private because
`TODO.md` is a travel history in prose.

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
| thumbnails / disk cache | `pipeline/src/thumbStore.ts`, `serve.ts` |
| sync | `pipeline/src/jobs/sync.ts`, `syncStore.ts` |

---

## Past regressions, now fixed

Two things reported by the owner turned out to trace back to one bad edit of
mine: I replaced a slice of `app/src/style.css` between two text markers and it
silently took everything in between.

- **Map styling** — recovered from `c65bc5b` and verified (380px canvas, sea
  colour, 23 city markers).
- **Settings performance** — fixed 2026-09-08. See `TODO.md`'s Resolved list
  for the two separate causes and the numbers.

The other two gaps were closed the same day: `scan` can now be triggered from
the app (`POST /jobs/scan`, three modes in Settings), and the missing-`.env`
dialog is now a **Settings > Generation** form that writes the key and applies
it without a restart. Both are in `TODO.md`'s Resolved list.

---

## How to work on this

This has been earned the hard way over the sessions, and is the most useful
thing in this file.

**Measure before asserting.** Nearly every confident diagnosis on this project
that was not backed by a measurement turned out to be wrong. Recent examples:
`will-change: transform` was added to fix compositing seams and guaranteed the
layer causing them; a transcript sizing bug was blamed on `<details>` when a
stale `max-height: 22vh` rule was capping it; the thumbnail bottleneck was
blamed on the server when the server did 13.6 requests/sec and the browser's
six-connection limit was the wall.

**A number your own code produced is not a measurement** until an independent
signal agrees. A cache-stats call memoised for 30s reported "0 files evicted"
when 1,082 had gone.

**Check the metric measures what you think.** "Only 5 of 24 images loaded" was
counting images inside collapsed `<details>` that are never meant to load.
"0 of 3,659 loaded" was a test jumping `scrollTop` before layout settled.

**Never edit CSS by slicing between markers.** Twice now that has silently
deleted unrelated blocks — and the second one was not fully found for weeks.
The whole `@media print` block went at `268d217` and the export ran without a
print stylesheet until 2026-09-08. **After any CSS edit, count `@media` blocks
and braces**, not just the selectors you meant to touch. Use anchored replacements of exact text and verify the
selector count afterwards.

**Watch for `display: …` beating `[hidden]`.** An author-origin `display` rule
overrides the UA's `[hidden] { display: none }`. This has bitten three times —
`.lightbox`, `.signin-banner`, `.job-form`. The remedy in the stylesheet is to
qualify the rule (`.job-progress:not([hidden]) { display: flex }`).

**A browser you are driving is not a browser someone is looking at.** A
backgrounded tab stops rendering, so `IntersectionObserver` never fires and lazy
images never load — which reads exactly like a regression. Twice now a "fix"
has been reported on the strength of such a reading. If a measurement says
nothing loaded, check that a *fresh* observer fires on an element you can see
before believing it.

**Verify in the browser, not in the diff.** Chrome is driven through the
`claude-in-chrome` tools; the desktop shell can be inspected with
`--remote-debugging-port=9222` and a ~40-line CDP client, since it is not Chrome
and the extension cannot attach.

**Precise measurement answers the wrong question when the question is "does
this look right."** The Fluent 2 sidebar refresh (`TODO.md`, 2026-09-09) spent
several rounds proving a chevron centered to 0.5px and a marker column's math
correct against the TreeView spec, while the actual defect was one level up —
TreeView was the wrong component archetype for what the design wanted
(Fluent's flatter NavDrawer). `getBoundingClientRect` verifies a claim once you
know what to check; it does not tell you whether you are checking the right
thing. Look at the screen first, especially when a critique is about how
something reads rather than whether it matches a spec.

**Cost is real.** `analyze` spends money per photo. The whole 18-day trip cost
under £8 for 4,181 photos. Show an estimate before spending, and never re-run
over the library casually.

---

## The one piece of work with real value left

Captions are written with **no context at all** — `CaptionPhotoInput` is
`{ imageBase64, mediaType }`, so the model cannot know a blue carriage is in the
the railway museum. Day summaries are written in isolation, and the owner's own
notes reach only the trip narrator. Fixing those needs a re-analysis of the
library, which costs money — and the i18n decision (the owner wants Chinese)
changes the storage shape, so **settle i18n first or the library gets paid for
twice**. This has been deferred three times and is the item most worth doing.
