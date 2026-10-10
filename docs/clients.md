# The clients

The web app, the phone app and the desktop shell, and how they authenticate.

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
  phone's offline archive" in `docs/architecture.md`.
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
  of them: measured on the owner's phone, the large majority of both the photos
  and the gigabytes, and over 90% for every recent year. This is the third source
  `photoSource.ts` was written for, and it is off until allowed in Settings —
  it needs `READ_MEDIA_IMAGES`, and Android's own dialog says nothing about
  why an archive reader wants the camera folder.
- **The sign-in survives a restart** because the key that unlocks MSAL's kept
  tokens is rewritten as a persistent cookie. See "The phone keeps its own
  sign-in" in `docs/invariants.md` — without it the app signed out every time Android
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
holds about two thousand names whose archived copy is a different encoding of
the same picture — a few hundred KB against a few MB — and showing one for the
other would show a different picture from the one the archive describes. A miss
falls back to OneDrive, which is also what happens for the part of the archive
that was never on this phone, so the feature cannot introduce a new failure.

Three things the next person would otherwise rediscover:

- **A `WebResourceResponse` with no `Content-Length` makes a page `fetch()` of
  it hang forever.** An `<img>` does not care, so this hides until something
  measures a photo rather than displaying it.
- **MediaStore's thumbnail cache is an upscale above ~512px.** Asked for 1280
  it returned 320x240. Up to 512 it is the fast path (26ms, no decode of a 5MB
  original); larger sizes are sampled from the original with `ImageDecoder`
  (1280 in 106ms).
- **HEIC has to be decoded natively** — the WebView cannot display it, and
  thousands of this phone's photos are HEIC.

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
the built app on **17923** — or, since 2026-10-10, *reuses* it: the job server
serves the same page itself (`pipeline/src/staticApp.ts`), so the login chain
that starts the job server brings up **both** the API and a page a browser can
open, with no window involved. Nothing ever required the pairing — the static
server is pure `node:http` — but before it, a reboot left `/health` answering
while 17923 was dead until someone launched the app, and a remote reader could
reach the API and nothing else. Whichever of the two binds 17923 first serves
it; the loser asks the port whether the answer is this app and adopts it (see
below). The shell also starts the pipeline's job server as a child process on
**18419**, waiting for it to answer `/health` before relying on it. If
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
than not starting. The job server's own copy answers the same two outcomes
without a window to raise anything in: `app page: … already serving this app —
adopted`, or `… is held by something else (…) — not serving`, and either way
the API keeps running.

The static server sends a **Content-Security-Policy** with every response
(`desktop/src/static.ts`, and its twin `pipeline/src/staticApp.ts` — the
policies must stay byte-identical, which is not a hope but a test:
`pipeline/test/staticApp.test.ts` fails if they ever differ, so edit one file
and not the other and the suite turns red instead of a renderer refusing a
request six months later). Inline script is allowed, since both pages bootstrap
the theme from an inline block before the stylesheets paint; `unsafe-eval` is
not, which is the part Electron actually warns about. `img-src` and `media-src`
allow `https:` for whichever OneDrive CDN host Graph hands out that hour, and
`connect-src` allows the same, because `graph.microsoft.com/.../content`
answers with a 302 to that host and a redirect target is checked like any other
request — without it the archive cannot load at all once the job server is away,
which is the one time the renderer fetches its files from Graph directly.
`connect-src` also names Graph, the sign-in host and loopback, and `frame-src`
is the sign-in host alone so MSAL can still renew tokens in its hidden iframe.

`DESKTOP_PORT` (read by **both** servers — one number on both sides, because
adoption is a single door) and `SERVE_PORT` override the two ports.

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
- Redirect URIs are `…/auth.html` — **a real file, and the `.html` is load-bearing**. Every server here (Vite dev/preview, `desktop/src/static.ts`, `pipeline/src/staticApp.ts`, Capacitor) serves a real path as itself, so there is no trailing-slash or directory-index rule to get right. The old `/auth/` was not: Capacitor's local server runs in html5mode and serves *any* extensionless path as `index.html`, so `/auth/` booted the whole app inside msal-browser's hidden renewal iframe instead of the bridge, and silent renewal timed out once the SPA refresh token's 24 hours lapsed. Registered: `https://localhost/auth.html`, `http://localhost:17923/auth.html`, `http://localhost:5173/auth.html`, `http://localhost:4173/auth.html`; iOS, once added, `capacitor://localhost/auth.html`.

The browser half is verified end-to-end, including a completed real sign-in:
tokens land in `localStorage`, the banner disappears, and the app renders signed
in.

### CSS gotcha, if you add another `hidden`-toggled element

It is the trap described in `docs/working-style.md` → "Watch for `display: …`
beating `[hidden]`": qualify the rule
(`.your-class:not([hidden]) { display: flex; }`) rather than setting `display`
unconditionally, or the element stays on screen while `hidden` is correctly
`true`.
