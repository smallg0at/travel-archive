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

**A write path may read the mirror too, when it can prove it is safe.** The rule
above is about a *stale* mirror, not about writing. `loadShardForWriting` reads
locally unless the remote's `lastModifiedDateTime` is newer than the mirror
file's own mtime — one metadata request instead of a full download, and a
genuine external write still falls back to Graph. On a whole-library pass this
is the difference between 80 downloads and 80 metadata reads. `translate`,
`renameTrip`, `deleteTrip` and `editTrip` read the index the same way
(`loadIndexForReading`). The archive lock (`lock.ts`) is what makes the
single-writer assumption hold; a second machine that only *translates* moves no
eTag and is not detectable by `checkSync`.

**Read the index back after a job that wrote it.** `runTrip` summarises missing
days through `runOrganize`, which saves the index itself; carrying on with the
copy read beforehand silently overwrote what had just been paid for — "1 day
summarized" and the day still empty. Whenever a nested job writes, re-`loadIndex`
and rebuild anything derived from it.

**A `display` on an id beats `[hidden]`.** `#print-progress`, `.signin-banner`
and `.lightbox` have each shipped a control that could not be dismissed because
an unconditional `display: flex` outranks the browser's `[hidden] { display:
none }`. Express it as `:not([hidden]) { display: flex }`, or the flag the code
sets does nothing visible.

**Paths split two ways** (`pipeline/src/paths.ts`). Writable per-user state
resolves from `ARCHIVE_HOME`; read-only config that ships with the build
resolves from the module. Get this wrong and an installed app writes into a
read-only directory, or reads a config file that is not there.

**Reading over the home network is gated; writing is local-only.** Set
`ARCHIVE_HOST=0.0.0.0` and `ARCHIVE_PASSWORD` to expose the archive to the
family (`pipeline/src/access.ts`). Read is the whole product and is gated by a
signed cookie; **write is a rule about kind, not about accounts** — anything
that is not a GET is refused to everyone but loopback, because there are no
users, roles or session store and a photo archive does not need them. Video is
deliberately **404 to remote readers**: `/video/:id` is the one route that hands
out a pre-authenticated OneDrive URL, and the family does not need it. The cookie
secret is regenerated at every start, so a restart signs everyone out; that is
the honest behaviour for a token nobody can revoke.

**A loopback request is not a test of anything.** This is the single most
expensive lesson in the file — **five** separate failures shipped that only
appeared on a second device, and every one of them was invisible from the owner's
own machine, because loopback short-circuits authentication, CORS and CSP alike.
Found in one session, all self-inflicted:

- **The shell did not read `.env`.** `ARCHIVE_HOST` reached the job server but
  not the static server, so the page was served on loopback while the server
  listened on `0.0.0.0`. Fix: `main.ts` parses `.env` once
  (`f82e80e`).
- **MSAL was constructed at module scope.** `new PublicClientApplication(...)`
  needs `window.crypto.subtle`, which only exists in a secure context — https,
  localhost, `127.0.0.1`. A LAN address is none of those, so the constructor
  threw `crypto_nonexistent` **while the bundle was still evaluating**, killing
  every module imported after it. The symptom was a rendered shell and nothing
  else, which reads as an empty app rather than an auth problem. Fix: construct
  on first use (`msal()`), never on import (`0e17ac4`). A remote reader imports
  `msAuth` freely and never calls into it.
- **The CSP used a wildcard, which a source cannot contain.**
  `http://192.168.*:*` is not a valid host-source — the browser **discards it
  silently** and the policy kept only its loopback origins, so every request from
  the family's laptop was refused with no error on screen. There is no CIDR
  syntax either. Fix: read the machine's own private IPv4 addresses from
  `os.networkInterfaces()` **at listen time** and emit literal hosts
  (`d007dc1`). Enumerated, not patterned; current, not remembered across a DHCP
  lease.
- **Cross-origin images sent no cookie.** The page is on one port and the job
  server on another, so they are different origins, and a cross-origin `<img>`
  sends no credentials by default. The grid set `crossOrigin="anonymous"` —
  which asks for none *explicitly* — while the lightbox set nothing at all, so
  **one failed and the other looked fine on any given machine**. Fix:
  `use-credentials` on every image the job server serves, which both sends the
  cookie and keeps the response CORS-clean for the print export's canvas
  (`c969262`).

**The remote smoke test, to run before believing a guest-access change works.**
Open the archive on a **non-loopback origin** — `http://<lan-ip>:17923`, never
`localhost` — and check all five, because each fails independently and each is
invisible locally:

1. The page shows content, not just its shell → the index loaded (MSAL, CSP).
2. The **grid** shows images → static assets, CORS, cookie.
3. The **lightbox** shows images → the same, plus `full`.
4. **Video is absent** → the gate rule still holds.
5. `GET /access` returns `{"gated":true,"exposed":true,"signedIn":true}`.

`Invoke-WebRequest` cannot reproduce 2 or 3 faithfully: it does not enforce CORS
or CSP, so it will report 200 for a request a browser refuses. Verify the
credentialed request directly instead — an `Origin` header matching the page
**plus** the `archive_access` cookie, and check that `Access-Control-Allow-Origin`
**echoes that origin** (never `*`, which `use-credentials` rejects) alongside
`Access-Control-Allow-Credentials: true`.

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
`http://127.0.0.1:18419` is mixed content.

**A "which files exist" list must be read back from the files.** `parts` in a
`TranslationFile` names the months that have a caption file, and the app fetches
a month's captions only when `parts` names it. It was an accumulated array that a
translate run loaded and only ever appended to, so a run starting from an index
without it wrote a *shorter* one — and one had: `parts` named 5 months while 123
caption files with ~29,500 entries existed, so 118 months read in English on the
phone and in the desktop window, and sync, which reads the same list, skipped
them too. `translationParts()` (`archiveStore.ts`) derives it now from a Graph
folder listing unioned with the mirror, and the index is rewritten whenever the
list differs. The files are the source of truth; a summary of them can only lose
entries.

**A photo shown from the phone must be the file the archive describes.** The
installed app serves photographs from the phone's own storage where it has them
(README, "Photographs from the phone's own storage") — 76% of this library.
The match is file name **plus exact byte size**, and both halves are load
bearing: ~1,900 names in this library have an archived copy that is a different
encoding of the same picture, ~235KB against ~2.6MB. Match on the name alone and
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

**And `app/dist` itself is built, not served from source.** Editing `app/src`
changes nothing the running app can see — the shell serves the built bundle, so
Ctrl+R re-fetches the same old code. Both of these have now cost a debugging
session: `pipeline/dist` must be rebuilt (and the shell restarted) after a
pipeline change, `app/dist` must be rebuilt after an app change, and "it is in
the source but not on screen" is the symptom of forgetting either. Check the
timestamp on `dist/assets/*.js` before believing the fix is broken.

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

**Two provider shapes, one table.** `pipeline/src/providers/index.ts`'s `PRESETS`
lists every backend Settings can switch to. Two kinds exist and the difference is
real: **gemini** (its own SDK, `responseSchema` enforced by the API, and the only
one with a Batch API) and **openai** — anything speaking Chat Completions, which
is DeepSeek, SiliconFlow, DashScope, Zhipu, Moonshot, OpenRouter and a local
Ollama, all served by `openaiCompatible.ts`. A new service is an entry there, not
a module. The two switches that genuinely vary between vendors are on the entry
(`tokenParam`, `jsonMode`).

**The provider is chosen for the job, not once for the app.** Gemini's
`responseSchema` is a hard constraint the prompt-only path cannot match, which is
why day and trip pages come out more reliably on it; DeepSeek is roughly 3-6x
cheaper and has no project spend cap, which is what makes bulk captioning
affordable. `AI_PROVIDER=deepseek` with DeepSeek cost **¥1.32** to caption 791
photos (~¥1.98/M tokens) — the same work wanted ~$1.30 on Gemini and hit the
project's monthly cap.

**`max_tokens` is a cap, not a budget.** Nothing is charged for unused headroom,
and on DeepSeek's JSON mode the cap is a **hard truncation** — a low one does not
save money, it cuts the reply mid-object and loses the whole call. Sizes live in
`MAX_OUTPUT` in `openaiCompatible.ts`; the day summary (33 cards per stop) is the
longest reply these prompts ask for. A reply that still will not parse is
repaired (`closeTruncated`) or retried without cards, never dropped whole.

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

### Street level and POI names: investigated, decided against (2026-10-04)

`photo.near` (`{venue, street}`) has had **no writer since `2ffeefe`**, the
Nominatim → GeoNames move, so both fields are always null and the two places
that would use them — `captionContext.ts:23-24` and `analyze.ts:288-289` — are
dead code. The fields and the prompt lines are kept rather than deleted:
reviving the feature costs one writer plus a backfill, and the read end is
already built.

Four ways to fill it were examined. The evidence says none of them pays:

| Evidence | Figure |
|---|---|
| street names in captions | **0.1%** |
| street/venue words reaching a day summary | **2.00%** (41/2,048) |
| a neighbouring hint naming the subject | **0 of 20** (the railway museum, `types.ts:17-22`) |
| venue-hint A/B run in `scripts/bench-providers.mjs` | 0/6 and 1/6 — six photos at two places, half the calls never reaching the model |

- **GeoNames, extended to class S (spot) and R (road)** — the cheapest: CC BY
  4.0 stays and only `build-geo.mjs` changes. Not the same files, though —
  `cities500.txt` is class P only, so it needs the per-country `XX.zip`
  downloads. Density in China is unmeasured.
- **OSM extraction** — data-side fine, download-side awkward. The footprint is
  nine countries in disconnected clusters (see the 足迹 map), and Geofabrik
  slices by administration: China 1.5GB whole, 25–163MB a province, Europe
  32.5GB — gigabytes bought for a few hundred square kilometres of interest.
  ODbL is workable (build `poi.tsv` locally, never commit it, credit line in
  Settings); the public Overpass instance has the same fair-use problem that
  killed Nominatim, so an OSM route means a file download, not an API.
- **Photon, self-hosted** — ruled out on size rather than licence: the planet
  database dump is **62.8GB** (JSON dump 26.9GB) and wants Java 21, OpenSearch
  and — per its own README — 64GB of RAM. Against a "tens of MB, loaded once
  at startup" target that is three orders of magnitude away. Photon's
  *regional JSON dumps* remain a reasonable way to obtain OSM data without
  running Photon.
- **Text extraction from the archive's own OCR** — zero new data and zero
  licence, and rejected on precision: what OCR reads is a departure board, a
  ticket, a menu or a map, and those name the destination rather than the
  place. A name being *in* the image is not the image being *of* it, and that
  failure mode would be quiet.

Standing gap, unrelated to POIs: **9,817 of 32,700 photos have no place at
all** — a settlement lookup miss, not a venue miss.

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

**2026-09-24 — a day of "it was already broken by the fix."** Worth reading as a
class, because three of the four were self-inflicted within the same session:

- **Save-as-PDF had not disappeared; its button was never created.**
  `addExportButton` ran `if (!canPrint()) return` while the header was still
  being built, before any photograph existed in the DOM. The count was always
  zero, so the button never appeared on any page. The check is deferred now.
  (A second, real defect in the same area: `exportableImages` and `slotPxFor`
  knew only the card layout, so a grid export would have embedded full-size
  images.)
- **The print toast could not be cancelled and would not go away.** Two separate
  causes: nothing checked for an interruption during the encode loop (fixed with
  an `AbortSignal` and a Cancel button), and then `#print-progress` grew an
  unconditional `display: flex` — my own addition of that button — which
  outranked `[hidden]` and left it on screen forever.
- **A nested job's work was overwritten by the caller's stale copy.** `runTrip`
  summarises missing days via `runOrganize`, which saves the index; `runTrip`
  then re-bucketed days from the copy it had read *before* that, writing the
  empty days back. Symptom: "1 day summarized", and the day still had no summary.
- **The `_alt` second-language fields were never requested.** The instruction
  said "every text field has a twin ending in `_alt`", but on the OpenAI-compatible
  path the only place those fields exist is the JSON shape in the prompt, and it
  listed none of them. Gemini got them from `withAltFields` in its schema, so
  only Gemini wrote them.

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

## The shell has no node, and that is not a broken install

**Every command an agent runs goes through `pwsh -NoLogo -NoProfile
-NonInteractive -Command …`.** `-NoProfile` means the PowerShell profile is never
read, and the profile is where `fnm env` puts node and npm on `PATH`. So inside
this harness `npm` is not a command, and it looks exactly like a machine where
node was never installed — it was, and versions are installed, and `fnm` itself
*is* on `PATH`.

Check `fnm list` before concluding anything. Either prefix a command with the
selected version's directory (what the earlier sessions did, and it silently
breaks when the version changes), or set it up per command the way the profile
does:

```powershell
fnm env --shell powershell | Out-String | Invoke-Expression; npm run --workspace app build
```

**In a terminal a person opened, none of this applies** — the profile runs and
`npm` works. The asymmetry is the confusing part: "it works for me" and "npm is
not recognised" are both true of the same machine.

The profile (`~/OneDrive/Documents/PowerShell/profile.ps1`) has the `fnm env`
block as of 2026-09-25; before that it had only conda, so nobody's shell had
node either. If a future machine reports `npm` missing with no `-NoProfile`
involved, that block is what to check.

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
under £8 for 4,181 photos on Gemini; on DeepSeek the same work is single-digit
yuan. Show an estimate before spending, and never re-run over the library
casually.

**The writing has a register, and it was chosen on purpose.** A trip narrative is
**a plain written account with the life left in it** — concrete, in order, in the
traveller's own voice. Warm is allowed; literary is not. Named and forbidden in
`tripPrompt`: interpretation ("what it meant"), closing flourishes and aphorisms
("it turned out to be enough"), metaphors, telling the reader how to feel, photo
counts and distances, and **naming the trip inside its own narrative**. Each of
those was a real output that had to be argued out of it.

**Rolling the dice does not change a voice.** Three runs on one input produced
the same travel-essay mode every time, so the register is the model's reading of
"write a diary", not sampling noise — a `prompt` change is the only lever. When a
generated text reads wrong, regenerate *after* fixing the prompt, not instead of.

**The second language is written, not translated.** `altInstructions` asks for the
twin `_alt` fields to be composed **directly** in that language; asking for "the
same content written in X" produced translationese in both providers — Gemini's
stored narratives read "低地国家以其充满活力的建筑奇观……迎接了我". And on the
OpenAI-compatible path the `_alt` fields must be listed in the JSON shape, or the
model is told about fields it cannot see (see the regressions above).

---

## The one piece of work with real value left

**Caption what is left** — the 2,574 uncaptioned photos are mostly **deliberate**:
2,395 are withheld screenshots. The genuinely capturable remainder was **52**
(31 photos + 21 videos) on 2026-09-24, of which 41 have no Graph thumbnail at all
— older videos, HEIC and DNG, which the thumbnail pipeline does not decode. There
is no model work left in the archive; what remains is a **local decode** for those
41 if they are wanted.

### How captioning works, for when it is needed again

- **Context.** The prompt carries the camera's clock in words, the trip, the
  town, and the owner's note for the day. The town is looked up *before*
  captioning from the local gazetteer (`geocodeBeforeCaptioning` — no network,
  and no `data/geocode-cache.json`: that file was Nominatim's). `venue` and
  `street` are still declared on `CaptionContext` but always null, because
  nothing writes `photo.near` — see "Street level and POI names: investigated,
  decided against". Measured: a real place name added to 6 of 24
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

---

## Local models, measured (2026-10-07)

Can an LM Studio model stand in for the cloud model on the two things the AI
layer does — caption a photo and summarise a day? Asked because Ollama is
retired and a local call costs nothing. Measured on `google/gemma-4-e4b` at
`127.0.0.1:1234/v1` against the **stored Gemini captions and day summaries
already in the archive**, so the comparison spent nothing — no Gemini call was
made. Harness: `pipeline/scripts/bench-local.mjs`, read-only, seed 20261007;
raw JSON under `data/bakeoff/local-2026-10-07{,-ctx12k}/` (gitignored).

**Two defects surfaced before any quality number did.**

1. LM Studio answers **400** to OpenAI's
   `response_format:{"type":"json_object"}` (it accepts only `json_schema` or
   `text`), and the `ollama` preset's unset `jsonMode` sends exactly that — so
   the very first caption call failed. LM Studio is a different service from
   Ollama (port, and this), so it now has its own preset (`lmstudio`,
   `jsonMode: "prompt"`); the prompts already ask for one JSON object and
   `looseJson` unwraps a fence, so nothing else changed. The running app was
   switched to it through the Settings save path and reported `ready`.
2. LM Studio JIT-loads the model at **8,192** tokens although its ceiling is
   131,072. A day summary needs ~13,160, so it is refused with
   `exceed_context_size_error`. A 12,288 load worked and rescued days that
   failed at 8,192; **16,384 would not load at all** on this 8 GiB card
   (`llama-server` died at 38% — measured 7,156 MiB at 12,288 and
   7,349–7,461 MiB at 8,192). 93 of 357 written days (26%; median day 3,371
   tokens, p90 15,056) do not fit 8,192. Buying context with CPU offload does
   not work either: 32,768 loads only at `--gpu 0.5`, where generation fell to
   ~7 t/s (17 W on a 115 W card — CPU-bound) and the largest day (345 photos)
   died with `fetch failed` after **25.7 minutes**. The route that does work is
   the smaller model: `gemma4-e2b` at 65,536 in full offload (6,225 MiB)
   summarised that same day in **45.6 s**, register-clean though less specific
   than the cloud. On this card, longer context means a smaller model.

Optional knobs written to `.env` for the run and their final value:
`AI_PROVIDER` (set to `lmstudio`, **restored to `deepseek`**), and
`LMSTUDIO_BASE_URL` / `LMSTUDIO_MODEL` / `LMSTUDIO_API_KEY` (left in place,
matching the preset). `PROXY_AI_MODE` was left at `system`: `proxy.ts` never
proxies `localhost`/`127.0.0.1`, so the local endpoint was never at risk of the
proxy and Gemini stayed reachable for nothing (no Gemini call was made).

### What it produced

| | n | local | cloud (same sample) | cloud (whole pool) |
|---|---|---|---|---|
| caption schema OK | 123 model calls | **123 (100%)** | — | — |
| `finish_reason` stop (no truncation) | 123 | 123 | — | — |
| naming: the stop title's key word named | 12 | **5 (42%)** | 8 (67%) | 304/448 (68%) |
| naming: any title word named | 12 | **8 (67%)** | 11 (92%) | 392/448 (88%) |
| document transcript, word-set Jaccard | 12 | **median 0.79** (length 0.78×) | — | — |
| invented place names, hand-checked | 30 | **0** | — | — |
| day register violations | 3 produced | **0** | — | — |

The naming denominators are the whole pool — every camera photo whose own OCR
carries a word of its day's stop title (448), not the 144 the cloud missed. On
the sample the cloud named 67% of the key words and the local model 42%: **25
points lower, past the 10-point bar**, and of the four the cloud missed the
local named **none**. (The key word alone is a weak name sometimes — "Making"
from "Museum of Making" — so the any-word row is reported beside it; the gap
holds at 67% vs 92%.)

Caption latency: median 20–25 s a photo, p90 ~26–29 s. A six-image
`captionPhotos` batch returned all six in order in 57 s (9.5 s an image, ~2×
throughput) with no truncation, so the batch path itself is sound. Determinism
is weak: the same thumbnail twice gave an identical caption **1 of 8 times**
(content_type same 6/8, tag-set Jaccard 0.74) at temperature 0 — harmless when a
photo is captioned once, fatal to a naive A/B.

Day summaries: **3 of 5 attempts produced text** — one lost to the
`parseDaySummary` crash now in TODO, one to a 195-second run that returned
"empty message" after five tries. Every one that produced text had clean
register (no photo counts, distances, trip name or flourish; read, not only
grepped).

### Verdict

**Caption: no-go as a stand-in for Gemini.** The schema path is solid (100%, no
truncation, batch works), but naming is 25 points down and the document tail is
bad: a four-language museum label came back as `Generationen` four times, and
"Cradle to Grave" was replaced by an invented essay about the human body. It is
a plausible *supplement* — local, free, fine for unremarkable snapshots — not a
replacement.

**Day summary: no-go at the default load — and not the easier task.** The prose
and register are good, which is what the pure-text intuition expects; what fails
is everything around it — 26% of days do not fit the loaded context, the parse
crashes on a reply that omits a field, and a large day can come back empty.
Harden the parser (TODO) and budget the day input to the context and it is worth
a second look; as shipped it cannot replace `organize`.

**Worst samples.**
- `IMG_20260917_105733 1.jpg` — a German/French/Italian/English museum label;
  local `extracted_text` was `"Generationen\nGenerationen\nGenerationen\nGenerationen"`.
- `IMG_20230812_144804.jpg` — the "Cradle to Grave" placard; local invented
  "God's Gift to Humanity… the human body is a marvel of engineering"
  (word-set Jaccard 0.08).
- `IMG_20230809_121619.jpg` — captioned "museum label" one run and "museum
  plaque" the next, with an identical image; 7 of 8 pairs moved like that.

