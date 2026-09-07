# Handoff

For whoever picks this up next. Read `README.md` for how the pipeline works and
`docs/design-brief.md` for what the product is; this file is the things you
would otherwise have to learn by breaking them.

`TODO.md` is the live checklist and the only place that should be trusted for
what is outstanding. Four items at the very top were written by the owner and
have not been triaged yet — two of them are regressions, described below.

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

- **`shared/`** — the schema. `SCHEMA_VERSION` is **13**; `loadIndex` refuses a
  newer one rather than half-reading it.
- **`pipeline/`** — `scan` (free, Graph listing only) → `analyze` (costs money,
  captions photos) → `organize` (day and place summaries) → `trip` (narrative).
  Plus `serve.ts`, the local job server on **127.0.0.1:4319**.
- **`app/`** — a reader. It never writes the archive; it asks the server to.
- **`desktop/`** — Electron. Serves `app/dist` on **17923** and spawns the job
  server.

The archive itself lives in OneDrive as `index.json` plus `photos/<yyyy-mm>.json`
shards, mirrored locally under `pipeline/data/`.

---

## Invariants — the things that bite

**The server is the only writer.** Every mutation goes through
`pipeline/src/serve.ts`, which holds the archive lock (`pipeline/src/lock.ts`) for
the duration of a write. Two writers clobbering the same shard has actually
happened. If you add a way for the app to change the archive, route it through
the server or you break sync's dirty flag.

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
| Generate page | `app/src/tripMode.ts` |
| PDF export rules | `app/src/print.ts` + the `@media print` block |
| trip map | `app/src/tripMap.ts` |
| thumbnails / disk cache | `pipeline/src/thumbStore.ts`, `serve.ts` |
| sync | `pipeline/src/jobs/sync.ts`, `syncStore.ts` |

---

## Open regressions the owner has flagged

Two of the four items at the top of `TODO.md` were caused by one bad edit of
mine: I replaced a slice of `app/src/style.css` between two text markers and it
silently took everything in between.

- **Map styling** — recovered from `c65bc5b` and verified (380px canvas, sea
  colour, 23 city markers). Believed fixed; worth a look.
- **Settings performance** — takes ~half a second and rebuilds completely on
  every sync button press. `showSettings()` re-renders the whole page and
  re-runs `syncStatus()` + `archiveStatus()`; the sync status check costs a
  Graph round trip (~880ms) because it asks OneDrive for an eTag. It should
  render from cached state and update in place.

The other two are genuine gaps: there is no way to trigger a `scan` from the app
(Generate offers Trip / Analyze / Day summaries only), and the missing-`.env`
dialog still tells you to create a file by hand when it should be a Settings
form.

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
deleted unrelated blocks. Use anchored replacements of exact text and verify the
selector count afterwards.

**Watch for `display: …` beating `[hidden]`.** An author-origin `display` rule
overrides the UA's `[hidden] { display: none }`. This has bitten three times —
`.lightbox`, `.signin-banner`, `.job-form`. The remedy in the stylesheet is to
qualify the rule (`.job-progress:not([hidden]) { display: flex }`).

**Verify in the browser, not in the diff.** Chrome is driven through the
`claude-in-chrome` tools; the desktop shell can be inspected with
`--remote-debugging-port=9222` and a ~40-line CDP client, since it is not Chrome
and the extension cannot attach.

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
