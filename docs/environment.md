# Environment and the machine

## The shell has no node, and that is not a broken install

**Every command an agent runs goes through `pwsh -NoLogo -NoProfile
-NonInteractive -Command …`.** `-NoProfile` means the PowerShell profile is never
read, and the profile is where `fnm env` puts node and npm on `PATH`. So inside
this harness `npm` is not a command, and it looks exactly like a machine where
node was never installed — it was, and versions are installed, and `fnm` itself
*is* on `PATH`.

Check `fnm list` before concluding anything. Three ways, best first:

1. **Call node by absolute path.** No `fnm`, no `Invoke-Expression`, nothing for
   Defender to match — this is the route for anything multi-step. The path is
   in "Windows Defender flags long commands that start that way", below.
2. **One short command**, initialised the way the profile does. Legitimate, but
   it must stay short — see the same note:

   ```powershell
   fnm env --shell powershell | Out-String | Invoke-Expression; npm run --workspace app build
   ```

3. Prefix a command with the selected version's directory — what the earlier
   sessions did, and it silently breaks when the version changes.

**Never put the `fnm env … | Invoke-Expression` prefix at the head of a long
inline command.** That is the exact shape Defender kills, and it takes the whole
command with it.

**In a terminal a person opened, none of this applies** — the profile runs and
`npm` works. The asymmetry is the confusing part: "it works for me" and "npm is
not recognised" are both true of the same machine.

The user's PowerShell profile has the `fnm env` block as of 2026-09-25; before
that it had only conda, so nobody's shell had node either. If a machine reports
`npm` missing with no `-NoProfile` involved, that block is what to check.

### Windows Defender flags long commands that start that way

**`Trojan:Win32/ClickFix.DHT!MTB` (severity Severe) matches a long inline
`pwsh -Command` whose body opens with `fnm env … | Out-String |
Invoke-Expression`.** Two detections on 2026-10-08 — 01:37 (remediated
"Removed") and 11:38 — each killed the command mid-run: the tool call comes
back as `aborted` with no output, which reads like a hang. OpenCode's
"move to background" does **not** release such a command; it has to be
terminated manually. Short commands with the same prefix were never flagged —
it is the length and the shape (a copy-paste chain with `Start-Process`,
redirections and nested quoting) that trips it. Re-read the evidence any time
with `Get-MpThreatDetection`, which keeps both cmdlines.

The rule that follows: **keep shell commands to a line or two, and put anything
multi-step in a script file.** Orchestration belongs in Node (`.mjs`) rather
than PowerShell — start a child server, poll, collect evidence, stop it — and
node's absolute path is what makes that possible without `fnm env` at all:

```
%APPDATA%\fnm\node-versions\<version>\installation\node.exe
```

Take the newest directory under `node-versions`: the version is machine state,
and writing one down goes stale on the next upgrade.

**Roaming, not `Local`**, and the same path is what the login launcher pins.
`fnm` itself lives under WinGet
(`…\WinGet\Packages\Schniz.fnm_…\fnm.exe`); `fnm list` still answers when the
version directory needs finding after an upgrade.

---

## Operations on this machine (2026-10-07)

**The job server starts itself at sign-in.** `HKCU\...\Run\PhotoArchiveServer`
→ `wscript serve-at-login.vbs` → hidden `serve-at-login.ps1` → `Start-Process
-WindowStyle Hidden` on `node dist/serve.js`. Enabled from Settings; the two
generated scripts and `serve-at-login.trace` sit in `pipeline/` and are
gitignored — machine state, like `.env`.

Verified on a real boot (2026-10-05): the trace reads `vbs started → ps1 started
→ server answering` four seconds after logon, and the PowerShell **exits** —
before this it blocked on `& node`, holding 51MB resident for two seconds of CPU
a day. The server itself is ~90MB working set and about a minute of CPU a day.

**If a sign-in ever leaves no server, read `pipeline/serve-at-login.trace`
first**: it records whether the chain ran, when, and whether the replacement
answered — the question that had no answer before (the first real boot produced
no server and no trace of why). An empty trace means the Run key did not fire; a
trigger that provably works here is a logon scheduled task.

**Restarting without a window**: Settings > Remote access > restart the archive
server. It closes the listener *before* spawning — on Windows a replacement
binding while the old one holds the port is EADDRINUSE, which is what the first
attempt did for twenty seconds — then waits for `/health` and leaves only once
the replacement answers. It refuses while a job runs: a process killed mid-write
leaves the archive lock held by something that never releases it.

**The server writes its own log** — `pipeline/data/serve.log`, both streams, one
5MB generation rotated to `.1`. The launcher deliberately does not redirect:
PowerShell's `$ErrorActionPreference = 'SilentlyContinue'` discards a native
command's stderr under redirection (measured), which is how the reason a restart
failed once vanished without a trace. The same file carries the device-code
prompt when interactive sign-in is needed; `token-cache.json`'s mtime says
whether it was completed.

**Reading the loop-lag line.** `monitorEventLoopDelay` measures wall clock, so a
system sleep is reported as a stall: `event loop lagged 24481314ms — no job
running` (6.8 hours) was a suspend, not a blocked event loop. Real stalls here
are sub-second (560-754ms during scans) — treat a reading in the hours as the
machine having slept.

**The network here.** An HTTP proxy runs on loopback. **Direct connections to
`dl.google.com` and `generativelanguage.googleapis.com` time out**, so AI traffic
goes through the proxy (`PROXY_AI_MODE=system`), and Android builds need
`~/.gradle/gradle.properties` with `systemProp.https.proxy*` — a machine-local
file, deliberately not in the repo, because Gradle's daemon ignores `-D` flags
and a TUN interface does not capture it.

**git carries the same proxy in its global config** (`http.proxy` /
`https.proxy` = `http://localhost:10808`), so after a reboot — before the proxy
app is up — `git push` fails with `Failed to connect … via localhost` while
GitHub still answers directly (200 without the proxy). Push through with a
one-shot override rather than editing their config:

```powershell
git -c http.proxy= -c https.proxy= push origin main
```

**Building the phone app.** `npm run cap:sync --workspace @travel-archive/app`,
then `app\android\gradlew.bat assembleDebug`; APK lands in
`app\android\app\build\outputs\apk\debug\` and installs with `adb install -r`
(package `com.travelarchive.photos`). If a successful build does not move the APK's
timestamp, delete the APK and rebuild: gradle's up-to-date state can survive a
stopped build.

**Driving the phone over adb.** The search field is a WebView `<input>`, which
`input text` does not reach — use `input keyevent`, then `KEYCODE_ENTER`, or the
IME absorbs the keys as composing text. And `screencap` returns a white frame
while the display dozes: `input keyevent KEYCODE_WAKEUP` + `wm dismiss-keyguard`
first.

**Mobile verification state (build installed 2026-10-06).** Home, map clusters,
translated captions and the local search index all verified on device (a
place-name search returned 4,312 photos across 276 days in 34ms). The Microsoft
session had expired, so thumbnails needed an owner-only re-login, and the
`.is-the-day` transit rendering is the one change still to be eyeballed.

**Google's generation-parameter deprecation (2026-10) is handled.** No
`temperature`, `top_p`, `top_k` or `thinking_budget` leaves this codebase:
`providers/geminiConfig.ts` builds that config alone, and
`test/geminiConfig.test.ts` scans gemini.ts for the retired keys — they only
fail when someone runs generation, which is the worst time to find out. The knob
is `GEMINI_THINKING_LEVEL`; a legacy `GEMINI_THINKING_BUDGET` is read and mapped,
never sent. The Interactions API the same notice recommends is parked on purpose:
`generateContent` stays supported.

**Origin policy** (`pipeline/src/originCheck.ts`) answers pages reached by
loopback (any port), by this machine's name, and by private addresses on the
app's ports — and refuses public names, including rebinding tricks such as
`127.0.0.1.nip.io`. A name this install is reached by that fits none of those
goes into `ARCHIVE_EXTRA_HOSTS` in `.env`: hand-edited, read per request, no
restart. Unknown names are configured rather than guessed, because an arbitrary
legitimate name and an arbitrary hostile one are indistinguishable.

**A push that fails while everything else works (2026-10-07).** Pushing the
default branch gave `unpack ok.` and then `ng refs/heads/main Internal Server
Error`, four times in four minutes, while `git ls-remote` and `gh api` both
answered and githubstatus.com still said all systems operational. One command
isolated it: the same commits pushed one at a time to a throwaway ref
(`git push origin <sha>:refs/heads/tmp-probe`) all succeeded, which clears the
objects, the account and the credentials and leaves only the default branch's
ref update. Retrying that later worked on its own. Note there is **no SSH
fallback here** — the local `~/.ssh/id_ed25519` is not registered with the
GitHub account (`Permission denied (publickey)`), so HTTPS is the only path until
the key is added; and note that status page is not a substitute for probing,
since it stayed green throughout.

## Operations on this machine (2026-10-08)

**Port tables are not evidence here.** `netstat -ano` returned no LISTENING
row for a port its own ESTABLISHED rows were talking to, and a PID parsed from
it was `0` (System Idle) more than once; `Get-NetTCPConnection` has been
declining silently since at least 2026-10-07. What does work: a real TCP
connect probe for "is it answering", and `Get-CimInstance Win32_Process`
filtered on the command line (`dist[\\/]serve\.js`) sorted by `CreationDate`
when the task is "kill the test server and definitely not the real one" —
the newest instance is the throwaway, and a guard of "only if two or more
exist" makes the real 18419 unkillable by accident.

**Driving the app in a browser, end to end.** Build with
`VITE_PIPELINE_URL=http://127.0.0.1:<throwaway port>` and serve the result
with `npm run --workspace app preview -- --port 4173` (4173 is in the origin
allow-list, so CORS answers). The throwaway is a fresh `ARCHIVE_HOME` plus
`SERVE_PORT`, metadata pointed at `Apps/TravelArchiveTest`, and `.env` copied
in for `AZURE_CLIENT_ID` — never the real metadata folder, because the auto
scan starts on its own. **Rebuild `app/dist` without the variable when done**
(verified by grepping the assets for the test port): a stale pointer ships
into the desktop shell and nothing works until it is noticed. A fresh browser
origin has no reader session, so this reaches everything that renders before
the archive loads — the setup wizard, offline and error states — and none of
what sits behind the sign-in wall.

## Operations on this machine (2026-10-10)

**Backgrounded shells are ephemeral, and the ledger lies.** OpenCode's
move-to-background shells are reaped after a few idle hours: the process is
killed, the `.out` file is deleted, and **no completion notification arrives**
— the shell stays listed as running. Observed twice on 2026-10-10 (the OOBE
test environment: a vite preview and a throwaway job server, both reaped
within hours; ports dead, output files gone, harness silent). The rules that
follow:

- A backgrounded long-running process is **dead until a probe says otherwise**.
  A TCP connect probe is the only honest answer; the shell's own record is not.
- Anything that must outlive the harness is **detached**: `Start-Process`
  (what the login launcher does) — the OS adopts the process and harness
  sweeps cannot touch it. The throwaway test server runs this way now.

**The browser-test recipe is one process, not two — but the build needs the
pointer.** The job server serves the static app page itself (`serveApp` on
`DESKTOP_PORT`), so a test setup needs only the throwaway server: build with
`VITE_PIPELINE_URL=http://127.0.0.1:<SERVE_PORT>`, start the throwaway with
its own `ARCHIVE_HOME`, `SERVE_PORT`, `DESKTOP_PORT`, and a test metadata
folder, and open `http://localhost:<DESKTOP_PORT>` — the page on the static
port, the API on the throwaway (the origin allow-list covers it).

The pointer is not optional: **the app's default API base is
`${location.hostname}:18419`** (`backend.ts`) — production's port. A plain
build opened from any loopback origin silently renders the *production*
archive, because CORS allows every loopback origin and production is happy to
answer (verified the hard way on 2026-10-10: the "test" settings page showed
the real library's 32,805 photos while the throwaway's `/config` said
otherwise). Rebuild `app/dist` plainly when done — a stale test pointer ships
into the desktop shell and nothing works until it is noticed. This supersedes
the `preview --port 4173` recipe above, which is kept as history.

**Reproducing a reader that is not this machine, without putting anything on the
network.** `access.ts` calls a peer remote unless its socket address is `::1`,
`127.0.0.1` or `::ffff:127.0.0.1`, and that one test decides both the read gate
and `canWrite`. Connecting to `127.0.0.2` does **not** fool it: Windows normalises
the source address of a loopback connection to `127.0.0.1` (measured 2026-10-10 —
the connection was made to `127.0.0.2` and arrived as `127.0.0.1`). What does work
is a local forwarding proxy that dials upstream with
`net.connect({ host: "127.0.0.1", port, localAddress: "127.0.0.2" })`: the server
then sees `127.0.0.2` while both ends stay inside `127/8`, so nothing is exposed
and no LAN address is involved. Point the browser at the proxy and serve the page
from somewhere else — the two being different origins is usually part of the thing
under test.

Two conditions come with it. The throwaway must set `ARCHIVE_HOST=0.0.0.0`,
because `access.ts` only gates reads (and so only wants `ARCHIVE_PASSWORD`) when
the server is *exposed*; bound to loopback, `canRead` is unconditionally true and
there is nothing to reproduce. And an empty `ARCHIVE_HOME` is enough: a job still
starts (it fails for want of a token), which is all a progress-stream test needs.

That is how the remote-reader progress bug was found on 2026-10-10. Every read
went through `apiFetch`'s `credentials: "include"`, but the progress stream opened
a bare `new EventSource` — and a cross-origin EventSource sends no cookies unless
told to, so `serve.ts`'s gate answered 401 while the rest of the page worked, and
the Activity panel painted one frame and froze. A minimal page asking the same URL
both ways, with nothing else differing, gave `error` against `open`. `watchJob`
now passes `{ withCredentials: true }`. The harness is
`scripts/remote-reader-probe.mjs`; `--keep` leaves the facade up so the real app
can be hand-driven through it.

## Operations on this machine (2026-10-13)

**Two copies of a model on an 8 GiB card look exactly like an engine that got
2–4× slower.** `lms unload` takes **no `-y`** — it answers
`error: unknown option '-y'` and unloads *nothing*, so the next `lms load`
quietly creates a **second instance** (`google/gemma-4-e4b` and
`google/gemma-4-e4b:2`) instead of replacing the first. Each copy is ~4.3 GB of
Q4_K_M weights plus its own BF16 vision tower, so two overflow the card, spill to
shared memory, and generation falls to 9–11 t/s against 34–36 for one copy. Half
a day went into blaming the runtime version and the GPU before the LM Studio
window itself showed both models listed.

The commands: `lms unload <identifier>` (or `lms unload --all`), then **verify
before trusting any timing** — `lms ps` must show exactly one row, and nvidia-smi
about 4,354 MiB used with one copy loaded (209 MiB with none). A sweep or bench
that reloads models must assert that count; a load that silently adds a copy
invalidates every number after it. Note also that `lms unload --all -y` can hang
on an interactive prompt rather than erroring out, which is how one sweep sat
idle for eleven minutes with the GPU at 1.5 W.

**Where the engine's own timings are.** `%USERPROFILE%\.lmstudio\server-logs\<YYYY-MM>\*.log`
holds a `slot print_timing` block per request:

```
prompt eval time =  1309.78 ms / 517 tokens ( 394.72 t/s)   ← prefill: fast, and often
        eval time = 89455.19 ms / 831 tokens (   9.28 t/s)   ← decode: the slow half
```

Prefill commonly reports only 5 tokens because the prefix cache hit. And the wall
time is dominated by **how much the model writes**, including its reasoning:
`raw-caption.json` in the bakeoff output carries `reasoningLen`, and caption calls
routinely spend 550–650 tokens thinking before one sentence — which is both the
explanation for a 25-second caption and the reason the caption prompt forbids
transcribing or summarising personal screens (the model's thinking quotes the
screen's text verbatim when nothing stops it).

**LM Studio auto-updates its llama.cpp runtime at start-up and keeps the old
builds.** `~/.lmstudio/extensions/backends/` held 2.51.0, 2.53.0 (installed
2026-10-07), 2.55.0 and 2.56.0 (installed 2026-10-13 16:06, the minute the app
started); the selection lives in `~/.lmstudio/.internal/backend-preferences-v1.json`
and can be changed with `lms runtime ls` / `lms runtime select <alias>` (no
download). Useful when a throughput change coincides with an app start — but
check the copy count first: selecting the older 2.53.0 here measured *worse*
(89,784 ms against 36,319 ms), which turned out to be the double-copy bug, not
the runtime.
