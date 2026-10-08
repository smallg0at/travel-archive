# Environment and the machine

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
redirections and nested quoting) that trips it.

The rule that follows: **keep shell commands to a line or two, and put anything
multi-step in a script file.** Orchestration belongs in Node (`.mjs`) rather
than PowerShell — start a child server, poll, collect evidence, stop it — and
node's absolute path is what makes that possible without `fnm env` at all:

```
%APPDATA%\fnm\node-versions\<version>\installation\node.exe
```

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
