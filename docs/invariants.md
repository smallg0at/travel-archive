# Invariants — the things that bite

Every rule here was learned by breaking it. Read it before changing the pipeline.

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

