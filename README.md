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
index.json              nav + day structure only, no PhotoRecords (~200-400KB)
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

Rescanning never discards AI work: `scan` merges, carrying forward captions,
tags, OCR text and geocoded places for photos it has seen before.

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
have no reliable *automatic* signal to detect trips from — no clean day-gaps,
no clean geo-cluster. So trips are **defined manually**, in `pipeline/trips.json`:

```json
[
  { "id": "trip-japan-korea-2024-04", "name": "a city, Japan & Korea", "startDate": "2024-04-12", "endDate": "2024-04-16" }
]
```

The intended workflow: tell an agent (a Claude Code session — this one included)
something like *"look at the photos from March 1–15 and call that the Japan
trip"*. It inspects `pipeline/data/photos/*.json` for that date range and adds
an entry here; `organize.ts` (`tripDefs.ts`) then slots any day whose date falls
in `[startDate, endDate]` into that trip. Any day not covered falls into a month
bucket instead. First matching range wins if ranges overlap, so keep them
non-overlapping.

## The app

Month tabs down the side (a horizontal strip under 700px), photos grouped by the
day they were taken. Thumbnails load only as they scroll into view — a busy month
holds several hundred photos and every thumbnail is its own authenticated Graph
call, so firing them all on render would stall the tab.

Days that `organize` has summarized render with their AI-chosen layout
(`render.ts`: hero / document_focus / gallery / standard) instead of the plain
grid. Everything else is the plain grid. The AI layer is purely additive — the
album works fully without it.

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

The quickest way to work on it is the desktop build at
`http://localhost:17923/mobile/` with the browser's phone viewport: the local
server is used when it answers, so it loads in milliseconds. The APK needs
`ANDROID_HOME` pointing at the SDK Android Studio installed
(`%LOCALAPPDATA%\Android\Sdk`) and a JDK in `JAVA_HOME`; install it with
`adb install -r app/android/app/build/outputs/apk/debug/app-debug.apk`.

What it does differently from the desktop, and why:

- **It opens on the index it kept last time** (IndexedDB, `mobile/cache.ts`),
  then asks OneDrive for just that file's eTag and fetches the 3.7MB index
  only when it changed — offering a refresh rather than rebuilding the page
  under the reader. Nothing else on the Graph path persisted between launches.
- **Sign-in is a full-page redirect inside the app's WebView**, never a popup,
  and Microsoft's login hosts are in Capacitor's `allowNavigation`. The system
  browser cannot be used: a sign-in finished there lands on
  `https://localhost/auth/` in the browser, not in the app, and the SPA
  platform in Azure accepts no custom-scheme redirect to return by. See
  `capacitor.config.ts` for the trade-off.
- **Android's back button** closes the viewer or a sheet, then pops a page,
  then goes to Home, then leaves — not WebView history, which after a
  redirect sign-in holds Microsoft's login pages.

**Before sign-in can work on a device**, add `https://localhost/auth/` as a
redirect URI under the *Single-page application* platform of the Azure app
registration (iOS, once added, will need `capacitor://localhost/auth/`).

## The desktop shell

One window, and the only way to use the parts that need a local machine —
generation, sync, pinning photos to disk. From a checkout:

```
npm run --workspace app build      # the shell serves app/dist; build it first
npm run desktop                    # build the shell and open the window
npm run package                    # installer -> desktop/release
```

`npm run desktop` builds `desktop/` and starts Electron. The shell then serves
the built app on **17923** and starts the pipeline's job server as a child
process on **4319**, waiting for it to answer `/health` before relying on it. If
the job server cannot start, the window still opens and the archive still reads
from OneDrive — only generation is unavailable, which is the same read-only path
the phone takes.

Two things that follow from it being a child process:

- **Only one instance may run.** A second would fight over both ports and, worse,
  run a second job server writing the same archive. The shell enforces this, and
  quitting stops the child — a job server left holding port 4319 and the archive
  lock is a failure with nothing on screen to explain it.
- **The window serves a build, not a dev server.** After
  `npm run --workspace app build`, press **Ctrl+R** in the window to pick the new
  bundle up. For UI work `npm run --workspace app dev` is the faster loop; the
  shell is for testing what it actually ships.

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
- `app/auth/` — a **dedicated redirect bridge page**, separate from the main app. `loginPopup()`'s popup has to land on a page that hands the response back to the opener via `BroadcastChannel` and closes itself; pointing `redirectUri` at the main app means the popup loads the whole UI and nothing does the handoff. `auth/main.ts` doesn't even construct a `PublicClientApplication` — an earlier fix attempt did, and still didn't work (popup landed on the right URL with a valid code and just sat there). Reading the installed package source (`node_modules/@azure/msal-browser/dist/redirect_bridge/index.mjs`) turned up the actual answer: `broadcastResponseToMainFrame` from the `@azure/msal-browser/redirect-bridge` subpath, which is the entire job of that page. `vite.config.ts` builds it as a second Rollup entry.
- Redirect URIs are `http://localhost:5173/auth/` and `http://localhost:4173/auth/` — **the trailing slash matters**, confirmed live: Vite only resolves `auth/index.html` for the exact path `/auth/`; `/auth` falls through to the SPA fallback and serves the main app. The Android app needs `https://localhost/auth/` (see "The phone app"); iOS, once added, `capacitor://localhost/auth/`. The desktop shell needs `http://localhost:17923/auth/` registered too — it serves the same built app on its own port, so without that entry the window opens and sign-in fails there alone.

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

- **Shards are held in memory for the session, not persisted client-side.** Flipping between month tabs is instant after first load, but a reload re-fetches. An IndexedDB cache keyed on `generatedAt` would fix that; not worth it until the app is actually on a phone.
- **No cross-archive search.** Finding "everything tagged `temple` in 2023" means loading every shard. The fix when it's wanted is a third artifact — a compact `search.json` of `{id, tags, place, truncated text}`, ~1.5MB at 10k photos — not turning the store into a database.
- **Model is configurable via `ANTHROPIC_MODEL`/`GEMINI_MODEL`** (defaults `claude-opus-5` / `gemini-3.6-flash`). For bulk tagging at this volume a cheaper tier (`claude-haiku-4-5`, `gemini-3.6-flash-lite`) is worth considering.
- **Trip ranges are edited by hand** (`pipeline/trips.json`); re-run `organize` after adding one.
