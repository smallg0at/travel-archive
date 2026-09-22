# Photo archive

Indexes a OneDrive photo library into a month-by-month album, then — separately,
and only when you ask — has an AI provider describe photos and write day
summaries on top of it. No server: the pipeline talks to OneDrive and the AI
provider directly, and the app authenticates to Graph itself to read both
metadata and photo bytes client-side.

## Structure

- `shared/` — TypeScript types shared between the pipeline and the app (`ArchiveIndexFile`, `PhotoShard`, `PhotoRecord`, `DayRecord`, `TripRecord`).
- `pipeline/` — three commands, in increasing order of cost (see below):
  - `scan.ts` — indexes OneDrive into per-month shards. Graph listing calls only.
  - `analyze.ts` — the AI pass: captions/tags/OCR for photos scan indexed but never looked at.
  - `organize.ts` — groups analyzed photos into day pages with summaries and layouts.
- `app/` — the web app. Reads `index.json` and month shards from OneDrive at runtime and renders the album. `app/src/mobile/` is the phone app built from the same data layer, packaged for Android with Capacitor (`app/android/`) — see "The phone app".

## Storage layout — sharded, not one big file

Everything lives under `ONEDRIVE_METADATA_FOLDER`:

```
index.json              nav + day structure, no PhotoRecords (~6MB minified)
photos/2025-04.json     every PhotoRecord for that month (~200-400KB each)
photos/2025-05.json
```

This replaced a single `archive.json`, which doesn't survive contact with a
10k-photo library: it runs ~7MB minified, every run that added a handful of
photos re-uploaded all of it, and the app had to pull the whole thing before
painting anything. Sharding by month means `scan` writes only the months it
actually saw, and the app fetches one shard when you open a tab.

A record's shard is its **capture month**, not the folder it was filed under.
Those normally agree, but when they don't, the capture date is what the day
grouping and album headings go by, so the shard has to follow it. The folder is
the fallback for photos with no recoverable date at all.

One consequence worth knowing: with the nested `yyyy/mm` layout the month
folders are named bare `01`..`12`, so anything comparing folders must compare
**full paths** — `2025/01` and `2026/01` are otherwise indistinguishable. That's
what `wasCovered()` in `scan.ts` does when deciding whether a missing record
means "deleted from OneDrive" or "outside this run's range".

`pipeline/data/` mirrors the same tree locally, pretty-printed, for inspection.
The uploaded copies are minified — pretty-printing inflated them ~40% for no
benefit on a file that's re-uploaded whole.

## The three passes

```
npm run --workspace pipeline build

npm run --workspace pipeline scan                              # free, whole library
npm run --workspace pipeline scan -- --from 2025-01 --to 2026-12
npm run --workspace pipeline analyze -- --month 2025-04        # spends tokens
npm run --workspace pipeline organize                          # spends tokens
```

**`scan` costs nothing and needs no AI.** The photo library is filed by date,
and Graph returns `photo.takenDateTime`, `location` and `image` facets on the
*listing* response — so indexing a 10k-photo library downloads zero photo bytes
and makes zero model calls. This is what makes the album usable over the whole
library immediately. Bound it to a date range with `--from`/`--to` (or
`SCAN_MONTH_FROM`/`SCAN_MONTH_TO` in `.env`) to index a slice first.

Two folder layouts are recognized, since either is a reasonable way to file a
library — flat `yyyy-mm/` directly under the root, and nested `yyyy/mm/` with
bare month names (`01`..`12`), which is what this library actually uses.
Knowing each folder's month up front is what keeps a bounded scan cheap: only
folders in range get listed at all.

Photos also sit loose in some year folders and in the library root. Those are
scanned non-recursively as month-less folders, and each photo's shard comes
from its own capture date; a loose photo with no recoverable date has nowhere
to be filed and is skipped (the run reports how many). A bounded run filters
loose year folders on their year and skips the root entirely — otherwise
"2025 only" would drag in every stray file at the top level.

Capture time is resolved best-effort, in descending order of trustworthiness:
`photo.takenDateTime` (real EXIF) → the filename (`Screenshot_20250412_143022.png`
— screenshots usually have no EXIF at all but do encode the date, and for a
library that's a big mix of screenshots and everyday photos that covers a large
slice of it) → `fileSystemInfo.createdDateTime`, which degrades to the upload
time for anything copied in and so is a last resort rather than a peer.

**`analyze` is the only pass that spends tokens.** It downloads bytes and
describes photos where `analyzedAt === null`, so re-running is cheap and safe —
already-analyzed photos are skipped, and the shard is written after every month
so an interrupted run keeps its work. Scope it with `--month`, `--from`/`--to`,
and `--limit`. Since it has the bytes anyway, it backfills GPS and capture date
from real EXIF wherever Graph's facets came up empty, then reverse-geocodes.

**`organize` writes the day pages.** Only days with at least one analyzed photo
get summarized — there's nothing for the model to work from otherwise — and only
days whose photo set actually changed get a fresh call. Output goes into
`index.json`'s `sections`; the shards aren't touched.

`organize` survives a model outage rather than losing the run. A day the model
will not write keeps whatever text it had and stays stale, three failures in a
row stop the run, and the index is checkpointed every five written days —
before that, one 503 on the ninth day of a run discarded eight summaries that
had already been paid for.

Rescanning never discards AI work: `scan` merges, carrying forward captions,
tags, OCR text and geocoded places for photos it has seen before.

Two maintenance passes exist for the case where something the summary does
*not* depend on has changed underneath it, so that a paid re-run isn't needed
to clear the staleness:

```
npm run --workspace pipeline dayplaces    # copy each day's dominant place onto the day record
npm run --workspace pipeline accept-days  # accept the current photo set for already-written days
```

Neither calls a model. `dayplaces` exists because `npm run places` rewrites the
shards while `DayRecord.place` is written by organize, so re-placing a library
left 939 days both displaying the old name and marked stale. `accept-days`
covers days whose summary was written before a late caption arrived. A day
whose *prose* names the old place still names it — that half is a rewrite, at
the owner's choosing.

## Provider abstraction

`analyze.ts` and `organize.ts` never call Claude or Gemini directly — they call
`getProvider()` from `pipeline/src/providers/index.ts`, which returns whichever
implementation of the `AiProvider` interface (`pipeline/src/providers/types.ts`)
matches `AI_PROVIDER` in `.env`.

- `providers/anthropic.ts` — Claude, structured JSON output.
- `providers/gemini.ts` — same contract, via `@google/genai`. **Verified working** against the real API (`pipeline/scripts/smoke-gemini.mjs` — run it any time after changing this file to sanity-check without needing OneDrive access). Default model is `gemini-3.6-flash`; `gemini-2.5-flash` was retired and returns a 404 pointing at the replacement, which is how the current default was picked.

To add another provider (a local model, a different vendor): implement
`captionPhoto` and `summarizeDay` per the `AiProvider` interface in a new
`providers/<name>.ts`, and add a case to the switch in `providers/index.ts`.

## Trips vs. everyday

Photo libraries that mix travel photos with daily snapshots and screenshots
have no reliable signal in *distance* to detect trips from — no clean day-gaps,
no clean geo-cluster. An early attempt was dropped because nothing separated a
trip's first day (105km from home) from an ordinary day out (87km).

So a trip is still an explicit record in `pipeline/data/trips.json`, but it no
longer has to be typed by hand — see **Trips propose themselves** below:

```json
[
  { "id": "trip-japan-korea-2024-04", "name": "a city, Japan & Korea", "startDate": "2024-04-12", "endDate": "2024-04-16" }
]
```

`organize.ts` (`tripDefs.ts`) slots any day whose date falls in
`[startDate, endDate]` into that trip. Any day not covered falls into a month
bucket instead. First matching range wins if ranges overlap, so keep them
non-overlapping — `POST /trips/define` refuses an overlap for that reason.

You can still write one by hand, or tell an agent *"look at the photos from
March 1–15 and call that the Japan trip"*. Mostly you accept a suggestion.

### Trips propose themselves

`pipeline/src/jobs/tripSuggest.ts` proposes ranges, and Generate's Trip tab
lists them with an editable name and three answers: **Create** (a trip with no
story — free, instant), **Write its story** (fills the generation form), and
**Not a trip** (remembered in `data/trip-suggestions-dismissed.json`).

The measure is **nights, not distances**. A day out ends at home however far it
went; a trip does not. So a night counts as away when the evening is more than
`AWAY_KM` (40km) from home *and* the next morning is not at home either — an
evening 200km out says where the camera was at six, not where its owner slept.
A run ends at the first morning spent at home, which stops a trip bridging a
photo-less day into the next one.

Home is not configured. It is the 0.2° grid cell holding nights in the most
distinct weeks within ±120 days of the day being judged, so it follows a move
between cities on its own — this library's does, from Beijing to the capital.

It reproduced both hand-made trips exactly, and 15 trips are now defined.

### Days out

The same pass (`findExcursions`) picks up the other half: a day that went
somewhere and came home the same night — home both sides, at least
`MIN_AWAY_PHOTOS` (10) photos away, and not already inside a defined trip.
There are 17 here, York at 366km down to a town at 41km.

They need no trip page and get none. They ride in `home.json` as `excursions`
(`DayExcursion` in `shared/src/types.ts`), because they come from the same pass
over the same shards and every reader that fetches one fetches the other — so
the phone gets them for free.

## The app

Month tabs down the side (a horizontal strip under 700px), photos grouped by the
day they were taken. Thumbnails load only as they scroll into view — a busy month
holds several hundred photos and every thumbnail is its own authenticated Graph
call, so firing them all on render would stall the tab.

Days that `organize` has summarized render with their AI-chosen layout
(`render.ts`: hero / document_focus / gallery / standard) instead of the plain
grid. Everything else is the plain grid. The AI layer is purely additive — the
album works fully without it.

Two things a month marks, because thirty days in two thousand have a summary
and nothing used to say which:

- A **summarized day** carries an accent dot on its date and a rule down the
  text, in the page and in the contents bar.
- A **day out** is headed like a small trip rather than carded: a "Day out"
  kicker, the place in trip-page type, then date · distance · photos. If it has
  a summary it also carries a **Trip / Gallery** switch — the written page with
  its stops, or the plain grid. The choice is stored under
  `localStorage["day-out-mode"]` and is deliberately global rather than
  per-day, since it is a reading habit; the phone uses the same key so the two
  shells agree.

```
npm run --workspace app dev        # local dev server
npm run --workspace app build      # production build -> app/dist
npm run --workspace app typecheck
```

There is no data-sync step. The app reads `index.json` and month shards from
OneDrive at runtime using the token it already holds for photo bytes, so a
pipeline run shows up immediately with no rebuild and no `cap sync`, and the
bundle stays flat no matter how large the library gets.

## The phone app

A separate page from the desktop's — `app/mobile/index.html` and
`app/src/mobile/` — sharing the data layer (`archiveData`, `graphPhoto`,
`msAuth`, i18n) and none of the layout. The desktop is a sidebar and one long
document; the phone is four tabs (Home, Trips, Library, Search) and a stack of
pages, with a trip as an overview and **each day its own page**, because a
whole trip on one page is 4,000-odd photos of DOM. View-only by design: it
reads OneDrive and generates nothing.

```
npm run --workspace app build          # also builds the phone page at /mobile/
npm run --workspace app build:mobile   # the phone page alone, at the root -> app/dist-mobile
npm run --workspace app cap:sync       # build:mobile, then copy into android/
npm run --workspace app android:apk    # ...then a debug APK -> app/android/app/build/outputs/apk/debug/
```

**The APK is built from `dist-mobile`, and only `build:mobile` fills it.**
`npm run --workspace app build` also builds a phone page — at `/mobile/` inside
`dist`, which is what the desktop shell serves and what the browser preview
shows — but the Android project's `webDir` is `dist-mobile`
(`app/capacitor.config.ts`). Build the wrong one and `cap copy` cheerfully
copies the last `dist-mobile` there was: the APK installs, runs, and shows the
old app, with no error anywhere. It cost an afternoon here — a CSS fix that
"did not work" and a sign-in fix that was never in the build being tested. The
way to catch it is to compare the hashed file names, which are visible from
both ends:

```
ls app/dist-mobile/assets | grep mobile-                  # what was just built
ls app/android/app/src/main/assets/public/assets | grep mobile-   # what the APK will carry
```

They must match, and must match the `<link>` the running app reports. Using
`cap:sync` or `android:apk` avoids the trap entirely, since both start with
`build:mobile`.

The quickest way to work on it is the desktop build at
`http://localhost:17923/mobile/` with the browser's phone viewport: the local
server is used when it answers, so it loads in milliseconds. The APK needs
`ANDROID_HOME` pointing at the SDK Android Studio installed
(`%LOCALAPPDATA%\Android\Sdk`) and a JDK in `JAVA_HOME`; install it with
`adb install -r app/android/app/build/outputs/apk/debug/app-debug.apk`.

What it does differently from the desktop, and why:

- **It opens on the index it kept last time** (IndexedDB, `mobile/cache.ts`),
  then asks OneDrive for just that file's eTag and fetches the index
  (~6MB minified) only when it changed — offering a refresh rather than
  rebuilding the page under the reader. Nothing else on the Graph path
  persisted between launches before the phone's own cache, below.
- **It keeps the whole library on the phone.** A background pass caches every
  month's photo records (a quiet toast reports it; Settings › Offline shows the
  count and controls it), so the library opens without the network and days
  already read work offline. A launch asks OneDrive for one listing of the
  `photos` folder and pulls only the shards whose eTag moved; the index
  translations are read from their kept copy before first paint. See "The
  phone's offline archive" in `HANDOFF.md`.
- **Sign-in is a full-page redirect inside the app's WebView**, never a popup,
  and Microsoft's login hosts are in Capacitor's `allowNavigation`. The system
  browser cannot be used: a sign-in finished there lands on
  `https://localhost/auth.html` in the browser, not in the app, and the SPA
  platform in Azure accepts no custom-scheme redirect to return by. See
  `capacitor.config.ts` for the trade-off.
- **Android's back button** closes the viewer or a sheet, then pops a page,
  then goes to Home, then leaves — not WebView history, which after a
  redirect sign-in holds Microsoft's login pages.
- **Photographs come from the phone itself where it has them**, which is most
  of them: measured on the owner's phone, ~24,000 of ~31,700 photos and ~80GB of
  ~100GB, over 90% for every year since 2021. This is the third source
  `photoSource.ts` was written for, and it is off until allowed in Settings —
  it needs `READ_MEDIA_IMAGES`, and Android's own dialog says nothing about
  why an archive reader wants the camera folder.
- **The sign-in survives a restart** because the key that unlocks MSAL's kept
  tokens is rewritten as a persistent cookie. See "The phone keeps its own
  sign-in" in `HANDOFF.md` — without it the app signed out every time Android
  ended its process.

**Before sign-in can work on a device**, add `https://localhost/auth.html` as a
redirect URI under the *Single-page application* platform of the Azure app
registration (iOS, once added, will need `capacitor://localhost/auth.html`).

### Photographs from the phone's own storage

`android/…/LocalPhotosPlugin.java` lists the phone's photo library — name, size
and MediaStore id, nothing else — and `src/mobile/devicePhotos.ts` matches the
archive against it. The bytes are served by MainActivity's `WebViewClient` from
`https://localhost/_device/…`, so an `<img>` gets an ordinary same-origin URL
and nothing leaves the phone. Photos are only read.

**Matched on file name *and* exact byte size, never one alone.** This library
holds ~1,900 names whose archived copy is a different encoding of the same
picture — ~235KB against ~2.6MB — and showing one for the other would show a
different picture from the one the archive describes. A miss falls back to
OneDrive, which is also what happens for the quarter of the archive that was
never on this phone, so the feature cannot introduce a new failure.

Three things the next person would otherwise rediscover:

- **A `WebResourceResponse` with no `Content-Length` makes a page `fetch()` of
  it hang forever.** An `<img>` does not care, so this hides until something
  measures a photo rather than displaying it.
- **MediaStore's thumbnail cache is an upscale above ~512px.** Asked for 1280
  it returned 320x240. Up to 512 it is the fast path (26ms, no decode of a 5MB
  original); larger sizes are sampled from the original with `ImageDecoder`
  (1280 in 106ms).
- **HEIC has to be decoded natively** — the WebView cannot display it, and
  7,159 of this phone's photos are HEIC.

The size the archive recorded rides on every URL as `?b=`, and the plugin
re-reads the file's size before serving it, so a photo edited in place after
the library was listed is refused rather than shown in place of what the
archive describes. The refusal is not a broken square: `devicePhotos.ts`
drops the match and re-requests from OneDrive. The list is rebuilt whenever
the app is resumed, so photos taken or deleted meanwhile are picked up.

## The desktop shell

One window, and the only way to use the parts that need a local machine —
generation, sync, pinning photos to disk. From a checkout:

```
npm run --workspace pipeline build # the shell runs pipeline/dist/serve.js as built
npm run --workspace app build      # the shell serves app/dist; build it first
npm run desktop                    # build the shell and open the window
npm run package                    # installer -> desktop/release
```

`npm run desktop` builds only the shell. The job server and the app are run
from their last build, so after pulling or editing either one, rebuild it
first — a stale `pipeline/dist` runs yesterday's server with no warning.

**Don't also start the job server by hand** (`npm run --workspace pipeline
serve`). If anything already holds 18419 the shell's own child fails to bind,
and `/health` answers from the other one — possibly older code, and not
stopped when the window closes. Stop it first; the shell starts and stops its
own.

`npm run desktop` builds `desktop/` and starts Electron. The shell then serves
the built app on **17923** and starts the pipeline's job server as a child
process on **18419**, waiting for it to answer `/health` before relying on it. If
the job server cannot start, the window still opens and the archive still reads
from OneDrive — only generation is unavailable, which is the same read-only path
the phone takes.

Two things that follow from it being a child process:

- **Only one instance may run.** A second would fight over both ports and, worse,
  run a second job server writing the same archive. The shell enforces this, and
  quitting stops the child — a job server left holding port 18419 and the archive
  lock is a failure with nothing on screen to explain it.
- **The window serves a build, not a dev server.** After
  `npm run --workspace app build`, press **Ctrl+R** in the window to pick the new
  bundle up. For UI work `npm run --workspace app dev` is the faster loop; the
  shell is for testing what it actually ships.

A busy port is normal in development, so the shell adopts what is already
there — but only after asking the port for the page and recognising this app in
the answer. Anything else raises a dialog naming what it found and the shell
stops, because showing the owner a stranger's page as their archive is worse
than not starting.

The static server sends a **Content-Security-Policy** with every response
(`desktop/src/static.ts`). Inline script is allowed, since both pages bootstrap
the theme from an inline block before the stylesheets paint; `unsafe-eval` is
not, which is the part Electron actually warns about. `img-src` allows `https:`
for whichever OneDrive CDN host Graph hands out that hour, `connect-src` is
Graph, the sign-in host and loopback, and `frame-src` is the sign-in host alone
so MSAL can still renew tokens in its hidden iframe.

`DESKTOP_PORT` and `SERVE_PORT` override the two ports.

## Authentication

Two different flows against **one** Azure app registration, because the pipeline
and the app run in different places:

| | pipeline (Node) | app (browser/webview) |
|---|---|---|
| Flow | device code, `@azure/msal-node` | Authorization Code + PKCE, `@azure/msal-browser` |
| Azure platform needed | **Mobile and desktop applications** + "Allow public client flows" = Yes | **Single-page application** |
| Scopes | `Files.ReadWrite offline_access` | `Files.Read` |

**Both platform entries are required, and they are not interchangeable.**
Registering only the SPA platform makes the app work and the pipeline fail with
`AADSTS70002: The provided client is not supported for this feature. The client
application must be marked as 'mobile.'` — confirmed live against the raw
`/devicecode` endpoint. Registering only the native platform does the reverse:
the SPA entry is what makes Microsoft's token endpoint answer the browser's CORS
preflight for PKCE at all.

### Why the app can't just use the pipeline's flow

Device-code **doesn't work from a browser** — confirmed live: `Access to fetch at
'.../devicecode' ... blocked by CORS policy`. Microsoft's device-code endpoints
aren't CORS-enabled for `fetch()` from a page origin, regardless of how the Azure
app is configured.

- `app/src/msAuth.ts` — `loginPopup()` **requires a genuine user click**; popups opened from anywhere else (e.g. from an IntersectionObserver callback during lazy-loading) get silently blocked, confirmed live as `BrowserAuthError: popup_window_error`. That's *why* sign-in is a visible banner button rather than something that fires on its own. It also auto-clears MSAL's stale `interaction_in_progress` lock, which otherwise sticks on forever after an abandoned popup and blocks every future attempt.
- `app/auth.html` (+ `app/auth/main.ts`) — a **dedicated redirect bridge page**, separate from the main app. `loginPopup()`'s popup has to land on a page that hands the response back to the opener via `BroadcastChannel` and closes itself; pointing `redirectUri` at the main app means the popup loads the whole UI and nothing does the handoff. It also answers msal-browser 5's **silent renewal**: that runs in a hidden iframe which lands on the same page and waits for the same broadcast (`waitForBridgeResponse`), so a silent frame is treated like a popup. `auth/main.ts` doesn't even construct a `PublicClientApplication` for the bridge handoff — an earlier fix attempt did, and still didn't work (popup landed on the right URL with a valid code and just sat there). Reading the installed package source (`node_modules/@azure/msal-browser/dist/redirect_bridge/index.mjs`) turned up the actual answer: `broadcastResponseToMainFrame` from the `@azure/msal-browser/redirect-bridge` subpath, which is the entire job of that page. `vite.config.ts` builds it as a second Rollup entry.
- Redirect URIs are `…/auth.html` — **a real file, and the `.html` is load-bearing**. Every server here (Vite dev/preview, `desktop/src/static.ts`, Capacitor) serves a real path as itself, so there is no trailing-slash or directory-index rule to get right. The old `/auth/` was not: Capacitor's local server runs in html5mode and serves *any* extensionless path as `index.html`, so `/auth/` booted the whole app inside msal-browser's hidden renewal iframe instead of the bridge, and silent renewal timed out once the SPA refresh token's 24 hours lapsed. Registered: `https://localhost/auth.html`, `http://localhost:17923/auth.html`, `http://localhost:5173/auth.html`, `http://localhost:4173/auth.html`; iOS, once added, `capacitor://localhost/auth.html`.

The browser half is verified end-to-end, including a completed real sign-in:
tokens land in `localStorage`, the banner disappears, and the app renders signed
in.

### CSS gotcha, if you add another `hidden`-toggled element

**`display: flex` (or any explicit `display`) set unconditionally on a class
beats the browser's own `[hidden] { display: none }`** — that's a non-`!important`
UA-stylesheet rule, so any author rule of equal specificity overrides it,
regardless of what the `hidden` attribute says. This bit both `.lightbox` and
`.signin-banner`; each looked "stuck open" (and `.lightbox` silently ate every
click on the page beneath it) while `hidden` was correctly `true` in JS the whole
time. Pattern to follow: default the class to `display: none`, then add
`.your-class:not([hidden]) { display: flex; }`, as both existing ones do.

## One-time setup

1. **Azure app registration**: portal.azure.com → App registrations → New registration, "Personal Microsoft accounts only". Under Authentication add **both** platforms from the table above, set "Allow public client flows" to **Yes** under Advanced settings, and copy the Application (client) ID.
2. `cp pipeline/.env.example pipeline/.env` — fill in `AZURE_CLIENT_ID`, `ONEDRIVE_PHOTOS_FOLDER` (the folder holding the date subfolders, `yyyy-mm/` or `yyyy/mm/`), `ONEDRIVE_METADATA_FOLDER`, `GEOCODE_CONTACT_EMAIL`, and the Anthropic or Gemini section.
3. `cp app/.env.example app/.env` — same client ID as `VITE_AZURE_CLIENT_ID`, and `VITE_ONEDRIVE_METADATA_FOLDER` matching `ONEDRIVE_METADATA_FOLDER`.
4. `npm install` at the repo root (installs all three workspaces).

**On a packaged install there is no step 2.** The installer bakes every
non-secret setting (see the allowlist in `desktop/scripts/bundle-pipeline.mjs`),
so the only thing missing is the AI provider's API key — set it under
**Settings > Generation**, which writes `.env` beside the archive and applies it
to the running server without a restart. Keys are write-only across that
boundary: the server reports whether one is set and never returns it.

One caveat worth knowing, because it is silent: `process.env` beats `.env`, so
if the key is also set as a **system environment variable**, a key saved in the
form works until the next restart and then loses to the machine's setting.
Settings says so when it detects one.

## Known simplifications

- **The desktop holds shards in memory for the session, not persisted client-side.** Flipping between month tabs is instant after first load, but a reload re-fetches. The phone does persist them (README, "The phone app"); on the desktop the job server's mirror is a ~34ms read, so there is less to gain.
- **No cross-archive search.** Finding "everything tagged `temple` in 2023" means loading every shard. The fix when it's wanted is a third artifact — a compact `search.json` of `{id, tags, place, truncated text}`, ~1.5MB at 10k photos — not turning the store into a database.
- **Model is configurable via `ANTHROPIC_MODEL`/`GEMINI_MODEL`** (defaults `claude-opus-5` / `gemini-3.6-flash`). For bulk tagging at this volume a cheaper tier (`claude-haiku-4-5`, `gemini-3.6-flash-lite`) is worth considering.
- **Trip ranges are edited by hand** (`pipeline/trips.json`); re-run `organize` after adding one.
