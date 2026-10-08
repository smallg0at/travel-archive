# First-run setup (OOBE)

**Status: proposed design, 2026-10-08.** Tracked as a draft in the project
(`GUI OOBE: first-run sign-in and setup`). Nothing here is implemented yet;
the measurements below are, and they are what the design answers.

## Why this exists — five measured facts

All five come from the first deliberate from-scratch run of this archive
(2026-10-08: throwaway `ARCHIVE_HOME`, packaged build, fresh profiles):

1. **A source checkout with no `.env` dies at import.** `env.ts`'s
   `required("AZURE_CLIENT_ID")` throws while the module loads, so the job
   server exits before it creates anything; the only trace is a stack trace in
   a console nobody reads, and the reader's toast then says "please start it
   with npm run desktop" — advice the user has already followed. The packaged
   build is fine (the setting is baked at package time, and
   `warnIfUnconfigured` does open a dialog — both measured), so the gap is
   specifically the from-source machine.

2. **The shipped folder defaults do not exist.** Direct Graph probes:
   `Pictures` 404, `Pictures/Travel` 404 (the `ONEDRIVE_PHOTOS_FOLDER`
   default), `Apps` 200, `Apps/TravelArchive` 404 (the metadata default) —
   while this account really stores photos under a Chinese-named folder and
   metadata under `Apps/DayArchive`. The first scan with defaults then fails
   as `Graph API 404 … itemNotFound … graph: 404 https://…` in a job log that
   names neither the setting nor the fix.

3. **Scanning starts itself, and starts too early.** `scanIfDue` runs 60s
   after the server boots and then every 5 minutes; on a fresh archive
   `lastScanAt` is null, so it is always due. Before the user has said where
   the photos are, that is either the 404 loop above or — if the folder exists
   and is empty — a confident archive of nothing.

4. **The server's device-code prompt reaches no UI.** `auth.ts` renders it
   with `console.log(response.message)` and nothing else; no app code consumes
   it. On a real first run the auto-scan therefore reaches `signing-in`, blocks
   on a code sitting in `serve.log`, and the job page shows "Signing in…"
   forever. (This was invisible in testing only because the test copied a
   `token-cache.json`.)

5. **There are two sign-ins.** The reader uses MSAL browser (PKCE) and keeps
   its own session; the job server uses msal-node with its own
   `token-cache.json` and falls back to device code. They are the same human
   account in two caches, and only the server's gates jobs, thumbnails from the
   mirror, and everything Graph that the server does.

## Goals

- From zero to a working archive without opening a log file.
- Never start a scan before the photo folder has been confirmed.
- As few sign-ins as the caches actually allow, with the one that matters
  (the server's) made visible.
- Resumable and skippable: a user who is not ready must be able to leave and
  come back, and an already-configured archive must never be interrupted.
- Remote readers never see any of this (the write-capability invariant: the
  server does not advertise write, so nothing that configures is drawn).

## Non-goals for v1

- The phone. It reads through a server someone else configured, and it has no
  configuration authority.
- Moving or importing an existing archive's configuration.
- Changing how sign-in works underneath: both existing flows stay as they are.
- Packaging: the baked settings stay exactly as they are — OOBE *validates*
  them rather than trusting them, because an installer built on this machine
  bakes this machine's personal paths.

## The flow

The server decides; the app draws. `GET /oobe` returns a computed state, so
the same conditions can also drive a banner or a job-server message later:

```jsonc
{
  "needed": true,
  "reasons": ["server-not-signed-in", "photos-folder-unverified", "never-scanned"],
  "optional": ["ai-key"],              // never blocks reading
  "photosFolder": "图片/本机照片",       // current value, whatever its source
  "folderState": "unknown",            // unknown | ok | not-found | no-months
  "signedIn": false,
  "language": "zh-Hans",
  "skippedAt": null
}
```

**When it appears.** Automatic only when the archive has never been scanned
and the reader can write (loopback). If something is already readable, the
same reasons produce a dismissible card instead of a takeover — a configured
archive whose folder later went missing must not lose the page it is showing.

**The steps, in dependency order** (this order is the answer to "不能太快"):

0. **Gate.** Shell only; `canWrite` must be true; remote readers get nothing.

1. **Sign in the archive server.** The device code has to appear in the page:
   while `acquireTokenByDeviceCode` is pending, `GET /oobe` (or a dedicated
   `/auth/device`) carries `{ url, code, expiresAt }`, and `signedIn` flips
   when it completes. The console line stays — it is still the right place for
   a CLI run. The reader's own PKCE sign-in is *not* collected here (see
   decision 1).

2. **The photo folder.** Show the value (default, baked, or user-supplied) and
   **probe it**: does the path resolve, and does it contain `yyyy-mm` or
   `yyyy/mm` children? On `not-found`, a text field — writing goes through the
   existing `POST /config`, because `ONEDRIVE_PHOTOS_FOLDER` is already in the
   writable whitelist and the server already validates and applies it. Success
   here is what stamps `photosFolderValidatedAt`, which is also what releases
   the scan gate.

3. **Language.** The detected value (`contentLang` already detects from the
   browser on first use) with a two-state control. Cosmetic: it can be changed
   any time afterwards in Settings.

4. **AI key — optional, and last.** Deep-links to the Settings form that
   already exists, with its set-or-not semantics. Skipping leaves the archive
   fully readable; generation is the only thing that waits.

5. **First scan, explicitly.** A button, not a timer (decision 2). Once it has
   run, ownership returns to `scanIfDue` as it is today.

## Server pieces

- `data/oobe.json` — machine-level state beside `sync.json` and `prefs.json`:
  `{ version, photosFolderValidatedAt, skippedAt }`. Single writer, lives in
  `ARCHIVE_HOME`, invisible to remote readers.
- `GET /oobe` (read, loopback) — computes the state above; the folder probe is
  one Graph request, cached until the folder changes.
- `POST /oobe/skip`, `POST /oobe/complete` — writes the timestamps.
- Folder writes stay on `POST /config`; no second path to the same value.
- **Scan gate** (`scanIfDue`): skip silently when the folder is unverified or
  404, log one line, start nothing. This is item "Do not auto-scan a fresh
  archive before the photo folder is configured" and it holds whether or not
  the rest of OOBE has shipped.
- **Device-code slot**: `deviceCodeCallback` additionally records the pending
  response (one slot, replaced by any newer attempt) so `/oobe` can serve it,
  and clears it on completion or failure.

## Client pieces

- `#setup` route: a full-screen page for the first run, drawn by the existing
  app (i18n both languages, existing controls, no new styling system).
- A compact card for the non-first-run case, living in the `#toasts` stack
  that already holds the sign-in prompt and the server toast.
- Everything else is reuse: `msAuth.signIn()` stays where it is, Settings
  keeps owning keys and remote access, `contentLang` keeps detecting, and
  `canWrite()` keeps the whole thing off remote readers.

## Decisions needed before implementation

1. **One sign-in or two?**
   - **A (recommended): OOBE collects only the server's device code.** Jobs,
     the mirror and thumbnails all work; the reader's PKCE session remains the
     fallback it already is for degraded mode and the phone. One sign-in on
     screen, no new token plumbing.
   - B: collect both — correct but reads as "sign in to Microsoft twice".
   - C: bridge the reader's refresh token into msal-node's cache — best UX,
     new plumbing, and cache surgery is exactly where this project has been
     burned before.

2. **First scan: button or automatic once the folder is confirmed?**
   **Recommended: button.** The user's framing was "不然扫个寂寞" — the one
   scan that matters most should be the one the user started; `scanIfDue`
   keeps its 6-hour life afterwards.

3. **Folder creation in v1?** Recommended no: path entry only. (Graph creates
   parent folders for a PUT by path — measured — so creating a folder is
   small, but it is scope on top of the flow that fixes the actual failure.)

4. **Skip semantics.** Recommended: `skippedAt` suppresses the automatic
   appearance until a reason changes (a new failure re-raises it) or Settings
   offers "run setup again". No timer, so nothing pops up weeks later.

5. **Where it draws.** Recommended: in-app page, not native dialogs —
   bilingual, matches the product, and testable the way everything else here
   is.

## Test plan

The throwaway-home harness from the first from-scratch run is the base
(`ARCHIVE_HOME` in `%TEMP%`, port 18519, metadata folder
`Apps/TravelArchiveTest` so no run can reach production):

- checkout with no `.env` → still the P0 companion fix (surface the child's
  failure), because OOBE cannot run without a server;
- packaged first run → OOBE appears *before* the 60s scan check; no scan until
  the folder step completes; device code visible in the page;
- wrong folder → one log line, no job, no 404 loop;
- configured archive → `/oobe` says nothing to do, `scanIfDue` unchanged;
- remote reader (`canWrite` false) → no route, no card, no endpoint writes.

## Phasing

- **P0 — a fresh install stops failing silently** (each item stands alone):
  surface the device code; the scan gate; surface a job server that exited
  (pairs with the manual-start item for the desktop).
- **P1 — the flow**: `/oobe`, `#setup`, folder and language steps, first-scan
  button.
- **P2 — polish**: create-folder helper, "run setup again" in Settings, phone
  parity if it ever needs any.
