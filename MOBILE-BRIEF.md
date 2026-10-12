# Brief: make the photo archive usable on a phone

> **Historical, written 2026-09-18.** The phone app this brief asked for exists:
> `app/mobile/` + `app/android/`, and it caches the whole library offline now.
> Read `README.md` and `docs/clients.md` ("The phone app"), and `docs/architecture.md` ("The phone's
> offline archive") for the current state; this file is kept for the reasoning
> that got
> it there, and some of its "what is already true" is no longer true — notably
> the cold-start and persistence notes below.

You are picking up one strand of an ongoing personal photo-archive project, in
this checkout. Another session may be working in the same repo on unrelated
features. **Do not commit files you did not change, and do not restart or kill
the job server or the Electron shell without asking the owner first** — long jobs
run inside them.

## The repo in one paragraph

Four npm workspaces: `pipeline/` (Node; scans OneDrive, captions photos with
Gemini, writes metadata), `app/` (Vite + TypeScript web app, no framework),
`desktop/` (Electron shell), `shared/` (types). The app reads `index.json` and
per-month photo shards **from OneDrive at runtime** via Microsoft Graph, so a
pipeline run shows up with no rebuild. When a local job server is running on
`127.0.0.1:18419` the app prefers its byte-identical mirror; when there is none
it goes straight to Graph. That second path is the phone's path and it already
works — see `app/src/archiveData.ts`.

Build and check with `npx tsc --noEmit -p app` and
`npm run build --workspace app`. PATH needs the newest
`%APPDATA%\fnm\node-versions\<version>\installation`.

## What is already true (verified 2026-09-18, don't re-derive)

- **The no-server path is deliberate and complete.** `archiveData.ts` tries the
  local mirror, falls back to Graph, and handles 429/503 with backoff, because
  Graph throttles this app during normal browsing.
- **The layout is responsive** — breakpoints at 1100 / 900 / 700 / 620px in
  `app/src/style.css`, and the sidebar nav becomes a horizontal strip on narrow
  screens. It was tested on a real phone on 2026-09-06; a portrait-scroll bug
  was found and fixed then.
- **Preferences degrade correctly with no server.** `app/src/prefs.ts` mirrors
  settings to the job server but `localStorage` stays authoritative for reads,
  precisely so a phone with no server still works.
- **Capacitor is scaffolded but nothing was built.** `app/capacitor.config.ts`
  exists, `@capacitor/core` and `cli` are installed, and `cap:add:android` /
  `cap:add:ios` scripts exist — but there is no `android/` or `ios/` directory
  and `appId` is still the placeholder `com.example.travelarchive`.

## The actual blockers

1. **A phone cannot reach the app.** There is no hosting config anywhere (no
   Vercel/Netlify/Pages/workflow), and the job server binds `127.0.0.1` on
   purpose — it holds OneDrive credentials, so exposing it on the LAN is a
   security decision, not a flag change. Read the comment at
   `pipeline/src/serve.ts:48` before proposing anything here.
2. **Auth follows the origin.** `app/src/msalConfig.ts` sets
   `redirectUri: ${window.location.origin}/auth.html`, so any new origin must be
   registered as a redirect URI in the Azure app registration — an action only
   the owner can take. Currently registered: `http://localhost:17923/auth.html`
   and the Vite dev/preview ports. Inside Capacitor the origin becomes
   `https://localhost` (Android) or `capacitor://localhost` (iOS), which MSAL
   in a WebView handles badly; a system-browser flow is usually required.
3. **Cold start is heavy on mobile data.** `index.json` is 3.7MB and blocks
   first render; the Chinese index adds 300KB; a month shard follows; and the
   search feature pulls `search.json` at 6.5MB. Nothing persists between
   sessions on the Graph path — an IndexedDB cache existed once and was
   removed (see `TODO.md` around line 1084 for why).
4. **The design question is open.** `TODO.md:922` — "Mobile view: design needs
   rethinking; a Figma would help." Features added since the phone test —
   search, activity, the trip map, the day editor, and a home page landing now
   — have never been looked at on a small screen.

## What to do

Start by **measuring, not building**. This project's own hard-won lesson is
that estimates here have been repeatedly wrong and that hand-checked samples
beat reasoning — so open the app at a phone viewport, exercise every view, and
report what is actually broken before proposing an architecture.

Then bring the owner a recommendation on the one real fork:

- **Hosted web app / PWA** — solves reach and auth with one origin, allows a
  service worker to fix the cold-start cost, needs a host and one Azure
  redirect URI. But the archive is private, so think carefully about what is
  being served where; the photos themselves stay in OneDrive behind the user's
  own token, and nothing about that should change.
- **Capacitor native app** — no hosting, but needs Android Studio/Xcode, a real
  `appId`, icons, and a solution to MSAL-in-a-WebView.

Give the owner the trade-off and a cost in hours, and let them choose. Do not
start `cap add android` or sign up for a host on your own initiative.

## House rules

- Measure before claiming. Quote real numbers and say how you got them.
- Comments explain *why*, with the measurement that motivated the code. Read a
  few files first — the existing style is unusually thorough and should be
  matched, not reduced to what-comments.
- Never type passwords or credentials, and never put API keys or tokens in any
  file you write.
- Commit messages: a plain-English sentence of intent, no "feat:" prefixes.
- The owner reads every diff. Small, explained changes beat sweeping ones.
