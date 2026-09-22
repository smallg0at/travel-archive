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

**The MSAL bridge is `/auth.html`, a real file — keep it that way.** msal-browser
5 renews silently in a hidden iframe that lands on the redirect URI and waits for
the bridge's `BroadcastChannel` message (`waitForBridgeResponse`). Give it an
extensionless path and Capacitor's local server, in html5mode, serves
`index.html` there instead: the whole app boots inside the hidden frame, never
broadcasts, and every renewal past the SPA refresh token's 24 hours times out.
The desktop's static server (`desktop/src/static.ts`) needs no special rule for a
real file; it had one for the old `/auth/`. A trail of this — `auth/index.html`
under a trailing-slash `/auth/`, and a `shouldInterceptRequest` shim to rescue it
— was replaced by the plain `/auth.html`.

**No backend is a supported state, not a failure.** It is the phone. A failed
health check means: no Generate page, no pins, thumbnails via Graph + IndexedDB.

**A running server silently strips fields it does not know about.** Derived
files are rewritten wholesale from the writing server's own type, so a server
built before a field existed drops it on its next write, with nothing on screen
to explain it. This happened to `home.json`'s `excursions` — the days out
vanished from the album because the shell was still running the previous
`pipeline/dist`. `HomeIndexFile` carries `schemaVersion` for exactly this
reason. **After changing a derived file's shape, rebuild `pipeline/dist` and
restart the shell before believing anything the app shows you.**
Every feature needs that path to degrade rather than error. The installed phone
app does not even ask: its WebView is `https://localhost`, and a request to
`http://127.0.0.1:4319` is mixed content.

**A photo shown from the phone must be the file the archive describes.** The
installed app serves photographs from the phone's own storage where it has them
(README, "Photographs from the phone's own storage") — 76% of this library.
The match is file name **plus exact byte size**, and both halves are load
bearing: 1,898 names in this library have an archived copy that is a different
encoding of the same picture, 235KB against 2.6MB. Match on the name alone and
the reader is shown a different photograph from the one the caption, the day
and the place were written about, which is the one failure this feature could
introduce and the reason it cannot. Every URL carries the expected size and the
plugin re-checks it before serving, so an edit made after the library was
listed is refused; a refusal falls back to OneDrive rather than showing a gap.

**Building the phone app: `dist`, then `dist-mobile`, are two different
builds.** The Android `webDir` is `dist-mobile`, filled only by
`build:mobile`. `npm run --workspace app build` fills `dist`, including a phone
page at `/mobile/` — that one is what the desktop shell serves and what a
browser preview shows, and it never reaches the APK. Build `dist`, run `cap
copy`, and the APK silently ships whatever `dist-mobile` held last: it
installs, launches and looks fine while running old code. Verified against
this on 2026-09-20 by comparing `mobile-*.css` between `app/dist-mobile/assets`
and `app/android/app/src/main/assets/public/assets`, and against the
stylesheet the running app reports. Prefer `npm run --workspace app
android:apk`, which starts from `build:mobile`.

**The phone keeps its own sign-in.** msal-browser encrypts the tokens it keeps
in `localStorage` with a key held in a *session* cookie, and an Android WebView
ends that session whenever the process dies — an update, a swipe away, Android
reclaiming memory. The app therefore rewrites `msal.cache.encryption` with a
year's expiry (`keepSignInAcrossLaunches`, `mobile/native.ts`) and flushes it
to disk immediately (`CookiesPlugin`), as well as in `onPause`. Without it the
app opened on its kept index, signed out, every time.

The expiry alone was not enough, and the flush is not belt-and-braces: a cookie
written from the page lives in memory until the WebView gets round to writing
it, so a process that ends without pausing — a crash, a "force stop", an
install over the top — takes the key with it. Measured on the emulator: a probe
cookie written exactly the way the key is written was gone after `am
force-stop`, and the app came back with the key regenerated and `localStorage`
down to `msal.version`, showing "Your Microsoft session has expired".

**The flush itself is not yet verified on a device.** The emulator run that
appeared to confirm it was worthless: the APK under test carried a stale web
bundle (see "Building the phone app" below), so the flush code was not in it,
and the key most likely survived that kill because the WebView's own timer had
already written it during the seconds the app sat idle. The test that would
settle it is a cookie written and flushed through the plugin and then a kill
within a second or so, which is shorter than any timer. Until someone runs it,
treat the fix as reasoned and shipped, not as measured. Third-party cookies are enabled in `MainActivity` for the same
reason: MSAL renews silently through a hidden Microsoft iframe once the SPA
refresh token's 24 hours are up.

**The MSAL bridge is `/auth.html`, and the extension is load-bearing.** The
hidden renewal frame lands on the redirect URI and waits for the bridge's
`BroadcastChannel` message (msal-browser 5's `waitForBridgeResponse`). Capacitor's
local server runs in html5mode and serves *any* extensionless path as
`index.html`, so the trailing-slash `/auth/` the app first used booted the whole
app inside that frame: it never broadcast, every renewal past the refresh token's
24 hours timed out, and the app asked to be signed in again — a real, reported
failure that looked like an MSAL problem. A real file is served as itself by
Capacitor, Vite and `desktop/src/static.ts` alike, so there is no per-platform
routing to get wrong. `auth/main.ts` answers the popup, the full-page redirect and
the silent frame with one rule (a silent frame is treated like a popup); a
`shouldInterceptRequest` shim that briefly rescued the old path, and Capacitor's
`RouteProcessor` (which is never asked about an extensionless path), were both
tried and dropped.

**Clearing cookies/session resets the interface, but not the offline archive.**
Measured 2026-09-22 by clearing the WebView's cookies, `localStorage` and
`sessionStorage`: the MSAL keys go 7 → 0 and the app asks for a sign-in again,
which is correct — there is nothing left to renew. The IndexedDB store is
untouched, so the phone's kept months survive, and a fresh sign-in immediately
rewrites `msal.cache.encryption`. What does *not* survive is the interface
preferences: the installed app has no job server, so `localStorage` is their only
store and they fall back to defaults (English, system theme).

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

### The phone's offline archive

The phone keeps every month's `PhotoRecords` in IndexedDB and opens from them
rather than the network. `offline.ts` runs one background pass over the whole
library (a quiet toast reports it; Settings › Offline shows the count, the bytes
and an off switch), and a launch asks OneDrive for a single listing of the
`photos` folder to diff each month's eTag and pull only the shards that moved —
so a month already kept is never re-downloaded. `loadMonthKept` is local-first,
and the index translations are read from their kept copy before first paint, so a
slow link costs freshness, never the first screen; coming back to the foreground
resumes a pass a backgrounded WebView stalled. The month caption files are kept
too, so an offline month reads in the reader's language. Measured on this
library: 122 of 123 months, the last being a shard the index lists but OneDrive
does not hold (the ghost-month issue in TODO, seen as a Graph 404 for
`2016-01.json`).

### Place names come from a local gazetteer, not a service

Reverse geocoding used to call Nominatim once a second per photo. Their usage
policy allows **4 requests a minute** for anything scheduled or running longer
than a day, which a library-wide captioning pass is, so it moved offline.

`pipeline/data/geo/` holds `places.tsv` (235,822 settlements — position,
population, and the name in its own language, English and Simplified Chinese)
and `countries.tsv`. Both are built from the GeoNames dumps by:

```
npm run geo:build --workspace pipeline
```

which needs `cities500.txt`, `alternateNamesV2.txt` and `countryInfo.txt`
downloaded into that folder first (see the script's header). The data folder is
gitignored, so a fresh clone must run this before analyzing anything; without
it, geocoding throws on the missing file. GeoNames is CC BY 4.0 — the credit
line in Settings (`settings.dataCredits`) is the attribution, and it must stay.

Lookups are ~57µs, so locating a 4,000-photo round is about a second where
Nominatim took 40 minutes. Street-level detail ("The Quay, a coastal suburb")
was dropped with the move: measured on this archive it reached 9% of captions,
and street names 0.1%, for a second request per photo.

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

**Before deleting a CSS rule, find out who builds that class.** A month-heading
redesign (`a1af269`) took the `.density-control` rules with it, because the
heading no longer used them — but `album.ts:120` and `theme.ts:108` still build
that class, so all three Settings controls (theme, thumbnail size, language)
lost their frame on the desktop *and* on the phone, where `mobile.css` only
layers flex and min-height on top of those base rules. The owner spotted it;
restored in `64e6473`. `grep` for the class name across `app/src` before
removing its rules, and remember that the phone may be styling on top of them.

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

**When a file is the thing in question, read that file.** "Days out are missing
on the phone" produced three confident diagnoses across two sessions — a stale
server stripping the field, then the local mirror being ahead of the upload —
and all of them were inferred from downstream behaviour. One direct read of
`home.json` from OneDrive (via the pipeline's own auth) disproved both in a
minute: `schemaVersion: 2`, 17 excursions, `builtAt` byte-identical to the
mirror's. The real cause was that the device was signed out, so the file was
never requested at all. A signed-out app is worth recognising by that shape —
`getAccessToken()` throws, no metadata is fetched, and every feature reading it
looks *empty* rather than broken.

**Several sessions work in this tree at once.** Four, recently: this one, the
phone app, the basemap's China worldview, and an editor agent on the desktop
shell. Consequences that have actually bitten:

- **Check `git status` before assuming a broken file is yours.** A stale patch
  applied over a committed redesign left `album.ts`, `dayEdit.ts` and
  `style.css` with every rewritten line duplicated — the old copy first, never
  closed. CSS nesting made the stylesheet *parse*, silently nesting the rest of
  the file inside one selector. `git show HEAD:<file>` proved the committed
  state clean, which is what identified it as another session's in-flight work.
- **Ask before editing a shared renderer** (`tripMap.ts`, `search.ts`,
  `home.ts`, `archiveData.ts`) — the phone reuses them, and a peer may have
  uncommitted work in the same file.

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

**Caption the rest of the library** — **2,413 of 31,742 photos** were still
uncaptioned on 2026-09-20, down from 23,425 on 2026-09-11 as the self-submitting
batch run works through them. Everything it needs is built:

- **Context.** The prompt carries the camera's clock in words, the trip, the
  town, a street-level venue and street (Nominatim `zoom=18`, looked up
  *before* captioning and cached on disk in `data/geocode-cache.json`) and the
  owner's note for the day. Measured: a real place name added to 6 of 24
  captions, nothing invented (TODO.md, "Photo captions are written with no
  context"). The name of a museum still first appears in the stop title.
- **Low image resolution** (`CAPTION_RESOLUTION`, `gemini.ts`) — ~600 input
  tokens a photo instead of 1,429, same naming, same transcriptions.
- **Batch** — Generate → Analyze → "As a batch": half price, results within a
  day (the test took 4 minutes), in files of 4,000 requests
  (`jobs/analyzeBatch.ts`). The server collects finished batches itself every
  ten minutes. `data/batches/analyze.json` records what was submitted and is
  the only way back to a batch being paid for — never delete it while one is
  open.
- **Activity** (sidebar, `app/src/activity.ts`) shows all of it: the running
  job live, thumbnail warming, every batch with its tokens and cost, and job
  history read from `data/jobs/` (so it survives restarts). When a job the page
  did not start ends — the server's own collect — it reloads the album once
  (`claimRefresh`, and `lastFinished` on `/health`, since a 15 s poll misses a
  collect that takes 0.3 s).

**The first whole-library submit (2026-09-11) was cut short.** One batch of
4,000 went in (`batches/2az4hfxa9xo75f0ycfrmysehp2oo2o7skql7`); the second was
refused with HTTP 429 "You exceeded your current quota", and the job ended
there. The file had uploaded; `batches.create` was what refused. Tier 1 allows
**3M tokens queued across all open batches** for Gemini 3.7 Flash (Google's
rate-limits page; Tier 2 allows 400M), and one 4,000-photo file is ~2.6M — so
at Tier 1 only one batch can be open at a time. Submitting again is safe:
photos already in an open batch are skipped. **Since then the server submits
the rest by itself**, one batch after each collect (`autoSubmit` in
`analyzeBatch.ts`; stop it from Activity). Photos that come back without a
caption are left out of later batches — run one interactive Analyze at the end.
While a batch is out the server also looks up places for the next one (a
`locate` job), so a round is Google's wait rather than an hour of Nominatim
followed by it.

At batch prices on gemini-3.7-flash (they double on 2027-01-01) the whole run
is about **$20**, measured on the first full batch: 4,000 photos for $3.40 —
578 input and 337 output tokens a photo (output, including thinking, above
the 250 estimated, and 62% of the cost). A photo that
comes back empty (RECITATION) stays uncaptioned — one interactive Analyze
afterwards picks those up with its fallback.

The i18n decision no longer blocks this: captions stay English and are
translated beside the archive.

**Day summaries are no longer the gap they were.** Measured 2026-09-20 from
`index.json`: **340 days are written** (245 in months, 95 in trips), against 30
earlier that week. Six eligible days remain unwritten, all inside trips, and 19
written days are stale — their captioned set has moved on since the prose was
written. What is left of this is a rewrite at the owner's choosing, not a body
of work.

Still open and cheaper: day summaries are written in isolation, and the owner's
notes reach only the trip narrator.
