# First-run setup (OOBE)

**Status: proposed design, 2026-10-08 (v2 — reviewed the same day).** Tracked
as a draft in the project (`GUI OOBE: first-run sign-in and setup`). v2 is a
four-step wizard — language + sign-in, folder, AI, then a full-screen first
scan — replacing the single panel of v1, on the ruling that sign-in cannot be
a co-equal row: without Microsoft there is no data to show. Nothing here is
implemented yet; the measurements below are, and they are what the design
answers.

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
- Resumable: closing the window and coming back continues where it stopped,
  and an already-configured archive is never interrupted. There is no "later"
  inside the wizard — with no sign-in there is no archive to look at, so an
  escape hatch would only lead to an empty room.
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

## The flow — four steps, and their order is the argument

**Ruling (2026-10-08 review): a wizard, not a panel; sign-in is not
skippable.** Without Microsoft there is no data to show — a "稍后再说" that
lands in an empty app is an escape hatch out of a room that has no furniture —
so the first page earns its blocking state, and the scan comes last because it
is the *result* of the three answers, not a step among them.

0. **Gate.** Shell only; `canWrite` must be true; remote readers get no route.

1. **Language and sign-in — one page.** Language first because it costs
   nothing and decides the words of every following screen (the browser's
   detection is already made; this page only confirms it). Sign-in sits on the
   same page as the blocking action: the page reads as "tell the archive who
   you are and which tongue", and it is the only step with a hard dependency —
   the folder probe, the scan, thumbnails and every job hang off this token.
   The device code renders here (P0, because today it only reaches
   `serve.log`).

2. **Photos folder.** Displayed and *probed* — does the path resolve, does it
   hold `yyyy-mm` children — edited only when the probe fails (see the open
   question on baking below). Success stamps `photosFolderValidatedAt`, which
   is what releases the scan gate.

3. **AI provider and key.** The provider list and key field the Settings form
   already has, with its set-or-not semantics. Skippable *as a step* (a
   secondary action, not an exit from the wizard): scanning costs nothing, and
   generation can arrive later from Settings.

4. **First scan — its own full-screen state.** Not a footer this time: the
   wizard's chrome goes away and the scan owns the page, because this is the
   one moment the user is waiting on the machine. On completion it shows the
   two numbers every fresh archive wants — photos and months — and one action
   that opens the archive, at which point `never-scanned` is false and the
   wizard is over for good.

**Resuming** is client-side only: each step's completion is derivable from
the server (`signedIn`, the folder probe, key set, `never-scanned`), so the
server keeps no wizard cursor and reopening restarts at page 1 — which is
cheap now, because page 1 is language + a sign-in that remembers itself.

## Server pieces

- `data/oobe.json` — the one piece of state the server keeps for this:
  `{ version, photosFolderValidatedAt }`, beside `sync.json` and `prefs.json`.
  Single writer, lives in `ARCHIVE_HOME`, invisible to remote readers.
  Everything else the wizard needs is derived: `signedIn` (`/health`), key set
  (`/config` status), `never-scanned` (`sync.json`), folder state (probe).
  There is deliberately **no wizard cursor** on the server — see resuming above.
- `GET /oobe` (read, loopback) — the computed state:

  ```jsonc
  {
    "needed": true,                    // never-scanned && canWrite
    "reasons": ["server-not-signed-in", "photos-folder-unverified", "never-scanned"],
    "optional": ["ai-key"],            // blocks nothing that reads
    "photosFolder": "图片/本机照片",     // current value, whatever its source
    "folderState": "unknown",          // unknown | ok | not-found | no-months
    "signedIn": false,
    "language": "zh-Hans",
    "deviceCode": null                 // { url, code, expiresAt } while pending
  }
  ```

- Folder writes stay on `POST /config`; no second path to the same value.
  Folder **reads** need one new endpoint (a bounded listing for the picker —
  see the open question below), guarded like every other non-GET.
- **Scan gate** (`scanIfDue`): skip silently when the folder is unverified or
  404, log one line, start nothing. This is item "Do not auto-scan a fresh
  archive before the photo folder is configured" and it holds whether or not
  the rest of OOBE has shipped.
- **Device-code slot**: `deviceCodeCallback` additionally records the pending
  response (one slot, replaced by any newer attempt) so `/oobe` can serve it,
  and clears it on completion or failure. The console line stays — it is
  still the right place for a CLI run.

## Client pieces

- One route, four pages: `#setup` runs the wizard (page 1 language + sign-in,
  page 2 folder, page 3 AI, page 4 full-screen scan), drawn by the existing
  app — i18n in both languages, existing controls, no new styling system.
  Progress is held by the route (which page am I on), nothing else.
- A compact card for the non-first-run case, living in the `#toasts` stack
  that already holds the sign-in prompt and the server toast.
- Everything else is reuse: `msAuth.signIn()` stays where it is, Settings
  keeps owning keys and remote access, `contentLang` keeps detecting, and
  `canWrite()` keeps the whole thing off remote readers.

## Decisions

**Ruled on, 2026-10-08 (the review that produced v2):**

1. **A wizard, not a single panel**, and **sign-in is not skippable** —
   without Microsoft there is no data to show, so there is nowhere to "come
   back later" to.
2. **Language and sign-in share page 1**; the folder is page 2; AI provider
   and key are page 3; the first scan is page 4 and **full-screen**.
3. The scan stays an explicit action (never a timer the user waits on) —
   the original "不然扫个寂寞" requirement, now expressed as a page rather
   than a button.

**Still open — recommendations below, need a yes:**

4. **The folder: baked and hidden, or a real step?** The installer already
   bakes `ONEDRIVE_PHOTOS_FOLDER` (this machine's personal paths — the bundle
   script's own comment calls the `.exe` personal as a result), and `env.ts`
   has a default for a checkout. **Recommendation: bake *and* validate, and
   only surface the input when the probe fails.** A green probe shows a
   read-only line ("图片/本机照片 · 144 个按月文件夹") and page 2 becomes a
   confirmation; a red probe turns the same page into the editor. This keeps
   the folder out of the way when it is right — which is the question being
   asked — without ever stranding a machine where the baked path is someone
   else's. Hiding it *unconditionally* would trade one silent failure (today's
   404 loop) for another.

5. **Interactive picker, yes — minimal.** The paths here are Chinese; typing
   `图片/本机照片` by hand is the failure mode, not the concept. A
   breadcrumb + children list (one bounded listing endpoint, list-and-descend,
   no drag, no create in v1) with the text field as the fallback for a path
   that is not yet reachable. Roughly one endpoint and one dialog — small
   next to what page 4 has to do.

6. **The AI step skips within the wizard** (secondary action, keeps the user
   in the flow): scanning costs nothing, and an API key is not something a
   photo archive should demand before it will look at its own photos.

## Privacy

Asked on 2026-10-08 with a dog attached, and the answer is boring on purpose:
no telemetry, no analytics, no third party beyond the two the archive is made
of — OneDrive (Microsoft) for storage, and whichever AI provider is configured.
That second one is the only place **image bytes leave this machine**, and it
leaves because captioning is precisely that; keys live in `.env` on disk and
are reported set-or-not over the wire. A personal, sideloaded tool needs no
privacy policy. If this were ever distributed, the honest artifact is a short
"what leaves this machine" paragraph — and Settings already carries the
`dataCredits` row it would hang on.

## Test plan

The throwaway-home harness from the first from-scratch run is the base
(`ARCHIVE_HOME` in `%TEMP%`, port 18519, metadata folder
`Apps/TravelArchiveTest` so no run can reach production):

- checkout with no `.env` → still the P0 companion fix (surface the child's
  failure), because OOBE cannot run without a server;
- packaged first run → the wizard appears *before* the 60s scan check; page 1
  shows the device code; nothing scans until page 2's probe passes **and**
  page 4 is started;
- close the wizard at page 2 and reopen → back at page 1 with sign-in already
  held (no server cursor, by design);
- wrong folder → one log line, no job, no 404 loop; picking the right path
  stamps `photosFolderValidatedAt` and page 4 unblocks;
- AI step skipped → the scan still runs; Settings shows the key as unset;
- configured archive → `/oobe` says nothing to do, `scanIfDue` unchanged;
- remote reader (`canWrite` false) → no route, no card, no endpoint writes.

## Phasing

- **P0 — a fresh install stops failing silently** (each item stands alone):
  surface the device code; the scan gate; surface a job server that exited
  (pairs with the manual-start item for the desktop).
- **P1 — the wizard**: `/oobe`, `#setup`'s four pages, the folder step
  (probe, and the picker if it is ruled in), the AI step, and the full-screen
  first scan.
- **P2 — polish**: create-folder helper, "run setup again" in Settings, phone
  parity if it ever needs any.

---

## The experience (UX)

The system design above says *when*; this says what the four pages look like.
Ruled a wizard on 2026-10-08: the order is the argument, so each page states
what it is waiting for. Desktop first, per the design brief; the phone is not
in scope.

### Principles, taken from the product as it already is

- **No ceremony.** Plain sectioned rows, short declarative copy, consequence
  before action — the register of "登录后即可加载照片。" No illustrations, no
  cartoon progress dots, no feature tour. The step indicator is a quiet list
  of four words, because the real progress bar is "am I blocked or not".
- **Show the state, not the promise.** Folder counts come from the probe,
  sign-in state from `/health`, scan numbers from the job. The failure this
  design fixes was an unverified assumption; the pages must not make new ones.
- **Every blocking page says what unblocks it** — under the disabled
  button, naming one thing, not a bare grey.
- **The scan owns the screen.** Page 4 is full-bleed because it is the only
  step where the user is waiting on the machine.

### Page 1 — 语言与登录

```
┌────────────────────────────────────────────────────────┐
│  设置照片档案                                    1 / 4 │
│                                                        │
│  语言                                                  │
│  中文（简体）· 检测自浏览器                [English]   │  ← applies in place, no reload
│                                                        │
│  登录                                                  │
│  作业、缩略图与扫描都经由档案服务器，它需要你的        │
│  Microsoft 账户授权一次。                              │
│                                                        │
│  ┌ 打开 microsoft.com/devicelink 并输入 ────────────┐  │
│  │  A B 1 C D 2 E F        9 分钟后过期   [复制]    │  │  ← P0: today this code only
│  └──────────────────────────────────────────────────┘  │     reaches serve.log
│                                                        │
│  ✓ 已登录                          （先看看界面 →）    │
│                                    [ 继续 → ]          │  ← enabled only by signedIn
└────────────────────────────────────────────────────────┘
```

Language is here because it decides the words of every page after it and
costs nothing; sign-in is the *reason* this page blocks — everything downstream
(folder probe, scan, thumbnails, jobs) hangs off that token. The reader's own
PKCE session is not collected (one sign-in on screen; the browser-side
fallback stays exactly as it is for degraded mode and the phone).

**Offline trapdoor:** 先看看界面 is a deliberately quiet text link. It does
not record a skip — the wizard reopens on next launch — it exists so a machine
with no network is not stuck in a page it cannot complete. If the review wants
it gone, the cost is: offline users cannot leave page 1.

### Page 2 — 照片目录

The ruling is *bake and validate; surface only what fails* (Decisions 4–5), so
this page has two faces:

```
  照片目录                                            2 / 4
  图片/本机照片 · 随安装包提供
  ✓ 存在 · 144 个按月文件夹                 [更改]      ← green: confirmation only

  — or, when the probe fails —
  照片目录
  ✗ 找不到 图片/本机照片
  [ 图片/本机照片            ]  [浏览…]  [检查]          ← red: the page becomes the editor
  必须是 OneDrive 里的文件夹，且以 yyyy-mm 分月。         (field + picker + re-probe)
```

**The picker** (recommended: yes, minimal): a list of the current path's
children — breadcrumb, click to descend, "选择这个文件夹" to accept — because
these paths are Chinese and hand-typing `图片/本机照片` is the failure mode.
No create, no rename, no drag; the text field stays for anything the listing
cannot reach. One bounded listing endpoint, guarded like every other non-GET.

Probes that find a folder with no month subfolders get their own state
(存在，但没有 yyyy-mm 子文件夹，扫描会找不到照片) rather than being dressed
up as success — `scan.ts` already words this correctly.

### Page 3 — AI 生成（可跳过一步）

Provider list (the presets Settings already renders, cloud and local alike),
key field with set-or-not semantics, model left at its default unless touched.

```
  生成                                                3 / 4
  选择服务 · DeepSeek                                   ← or Gemini / LM Studio / …
  API 密钥  [••••••••••••]                    已保存 ✓
  摘要与图片说明会发送照片给所选服务；密钥只存在本机。

  [ 跳过，稍后在设置里配置 ]              [ 继续 → ]
```

Skipping is a secondary action **inside** the wizard, not an exit: scanning
costs nothing, and an API key is not something a photo archive should demand
before it will look at its own photos. Copy says where the photos go — the one
sentence a privacy-minded reader deserves (see **Privacy** below).

### Page 4 — 首次扫描（全屏）

The chrome disappears; the scan is the whole page.

```
  正在扫描照片目录
              18,402                                  ← live count from the job
  117 / 144 个文件夹 · 当前 2024-09 — 38 张
  ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░                        ← proportion of folders, honest
```

- Progress lines are the job's own (SSE); no invented estimates, no ETA.
- Closing the window does **not** stop it — the server keeps scanning, and the
  next launch lands here rather than at page 1 (`never-scanned` still true,
  `signedIn` held).
- Completion states the result in the archive's own terms:
  **32,750 张照片 · 124 个月** → `[ 打开档案 ]`, after which `never-scanned`
  is false and the wizard never returns.
- Failure keeps the page with the job's short error and `[ 重试 ]`; the full
  log stays where job logs live.

### Entry, exit, and the card variant

Automatic entry is unchanged: never scanned **and** can write. There is no
"稍后再说" as a destination — with no sign-in there is no archive to go back
to — only the quiet trapdoor above for offline machines, and closing the
window (which resumes).

Everything that is *not* a first run keeps the v1 answer: one card in the
`#toasts` stack, never a takeover — a working archive whose folder later went
missing must not lose the page it is showing:

- 照片目录 *图片/本机照片* 找不到——新照片不会被扫描。 [打开设置向导]
- 档案服务器未登录——扫描与生成不可用。 [登录]
- 档案还没扫描过。 [开始设置]

### Interaction details

- The step list is informational; pages advance only through their own
  继续, so a green row on page 3 never skips page 2's validation.
- Focus lands on the blocking action; **Enter** submits the folder field;
  Esc leaves the picker, nothing else.
- Motion matches the existing toasts (0.18s, off under
  `prefers-reduced-motion`); language switches in place.
- Both languages ship together — the i18n cross-check keeps them honest, and
  page 1 is the first thing either of them has to say.
- Failure never leaves the app: no step requires reading a file outside the
  wizard. That is the whole point of it.

### Deliberately not done

No wizard dots, no illustrations, no welcome copy, no feature tour, no phone
screens, no native dialogs, no second question about a folder that probes
green, and no privacy policy (see below) — the archive itself is the reward
screen, and the setup's job is to be finished and forgotten.
