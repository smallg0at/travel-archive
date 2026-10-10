import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { AutostartStatus } from "@travel-archive/shared";
import { env } from "./env.js";
import { archiveHome, dataDir, homeFile } from "./paths.js";

const exec = promisify(execFile);

/**
 * Starting the job server at sign-in, with no window and no shell.
 *
 * Everything a remote reader needs from this archive is served by one Node
 * process, and today that process only exists while the desktop window is
 * open: closing the window runs `before-quit`, which stops it — a reader on
 * the phone then finds the archive gone and cannot know why. So the server is
 * registered to start itself at sign-in instead, and the window becomes one
 * more client of it: `startPipelineServer` already adopts a healthy server
 * rather than starting a second one, which is the whole of the coupling
 * between the two.
 *
 * **Not a Windows service.** A service runs in session 0 with no user profile,
 * which is where this server's own requirements do not fit: the device-code
 * sign-in, the dialogs the shell shows for it, `ARCHIVE_HOME` under AppData,
 * and OneDrive's own sync. Sign-in *at logon* is the right moment — the user
 * is there once a day if the token ever needs them, and the rest of the time
 * silent renewal does the work.
 *
 * **Two files, both under home, both plain text.** The Run key starts a
 * console program in a visible console, and a console cannot be hidden from
 * its own command line — so the registered line is a four-line VBScript that
 * launches PowerShell with window style 0 (hidden *from the start*, rather
 * than hidden a moment later), and PowerShell runs the launcher proper. Both
 * are written here, both are meant to be readable: when Node moves or is
 * upgraded, the path pinned into the launcher is the thing to edit, and there
 * is nothing else in the mechanism to understand.
 */

/** The Run key's value name. Namespaced to this app, not to the machine's. */
const VALUE = "PhotoArchiveServer";
const RUN_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`;

/** Both files live beside `.env`, so they are where the settings already are. */
const LAUNCHER = "serve-at-login.ps1";
const WRAPPER = "serve-at-login.vbs";

const supported = process.platform === "win32";

/** Quotes a value for PowerShell's single-quoted strings, where `'` doubles. */
const ps = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * The file to launch, resolved to where it actually lives.
 *
 * `process.execPath` reports the path the process was *started through*, and on
 * this machine that is fnm's per-shell shim —
 * `%LOCALAPPDATA%\fnm_multishells\<pid>_<epoch>\node.exe`, a directory created
 * for one shell and cleaned up later. A launcher pinning it would stop working
 * the next time fnm prunes, discovered at the next sign-in by nothing
 * starting. Following the link costs one syscall and pins the install that
 * survives.
 *
 * Electron's own binary is not a link, so this is the identity there — and the
 * shell's `process.execPath` is exactly the path we want in that case too.
 */
export function runtimePath(): string {
  try {
    return realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

/** The line registered under the Run key: hidden wrapper, then the launcher. */
export function registeredValue(): string {
  return `wscript.exe ${quoteForCmd(homeFile(WRAPPER))}`;
}

/** Command-line quoting for a single argument (MSVCRT rules, which `reg.exe` reads). */
function quoteForCmd(arg: string): string {
  return `"${arg.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1")}"`;
}

/**
 * The launcher: probe, then start, appending to one log file.
 *
 * The probe first, for the same reason `startPipelineServer` adopts: if the
 * desktop shell got there first (it starts before or alongside this), a second
 * copy would only fail to bind and write a stack trace into the log on every
 * login. `/health` is reachable without a session because the gate exempts
 * loopback — see `access.ts`.
 *
 * `argv[1]` is the file this server was started from — `dist/serve.js` from a
 * checkout, the bundled `server.mjs` when installed — and `process.execPath` is
 * whatever is running it: `node.exe`, or Electron's own binary when the shell
 * spawned this. `ELECTRON_RUN_AS_NODE` is what makes the second case work, and
 * is inert for the first.
 *
 * Exported for the tests: a quote wrong in here fails only at the next sign-in,
 * on a machine nobody is watching, which is exactly what a test is for.
 */
export function launcherSource(entry: string, port: number): string {
  const home = archiveHome();
  const archiveHomeVar = process.env.ARCHIVE_HOME?.trim();
  return `# Written by Photo Archive when "start at sign-in" was turned on.
# Everything that runs at sign-in is this file. The path to the runtime is
# pinned as it was at that moment: if Node moves or is upgraded, point line 1
# at the new one.
#
# Output is deliberately NOT redirected here: the server mirrors both of its
# streams into data\\serve.log itself (logFile.ts). Redirecting as well would
# put every line in twice - and PowerShell's $ErrorActionPreference, set below
# to keep a hidden window quiet, discards a native command's stderr under
# redirection, which is how the reason a restart failed went missing.
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

# The first line of evidence, written before anything that can fail: whether
# this ran, and when. The server writes nothing until it is running, so a
# chain that dies here would otherwise leave the same silence as a chain that
# never started - which is what a sign-in that produced no log looked like.
# Beside this file, one line per run, so it answers the question at the next
# sign-in rather than the one after.
try {
  "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ps1 started (pid $PID)" |
    Add-Content -LiteralPath (Join-Path $PSScriptRoot 'serve-at-login.trace')
} catch {}

# Already serving - the desktop shell started it, or an earlier login's copy is
# still up. A second one could only lose the bind and log a stack trace.
try {
  $health = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 ${ps(`http://127.0.0.1:${port}/health`)}
  if ($health.StatusCode -eq 200) {
    try { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ps1 exited: already serving" | Add-Content -LiteralPath (Join-Path $PSScriptRoot 'serve-at-login.trace') } catch {}
    exit 0
  }
} catch {}

$env:ELECTRON_RUN_AS_NODE = '1'
${archiveHomeVar ? `$env:ARCHIVE_HOME = ${ps(archiveHomeVar)}` : "# No ARCHIVE_HOME: running from a checkout, where paths.ts falls back on the code's own directory."}
# Detached, and this script must not wait on it. It used to block here, so the
# wrapper stayed alive - 51MB - for as long as the server ran, for two seconds
# of CPU a day. Nothing is lost by not holding its output: the server writes
# data\\serve.log itself.
Start-Process -WindowStyle Hidden -FilePath ${ps(runtimePath())} -ArgumentList ${ps('"' + entry + '"')} -WorkingDirectory ${ps(home)}

# Say whether it answered. The probe above could not - it ran *before* this
# line - and a sign-in that produced no server is otherwise indistinguishable
# from a sign-in that never ran. Bounded at 30s, past the 11s cold start this
# server has measured.
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while ([DateTime]::UtcNow -lt $deadline) {
  Start-Sleep -Milliseconds 500
  try {
    if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 ${ps(`http://127.0.0.1:${port}/health`)}).StatusCode -eq 200) {
      try { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ps1 exited: server answering" | Add-Content -LiteralPath (Join-Path $PSScriptRoot 'serve-at-login.trace') } catch {}
      exit 0
    }
  } catch {}
}
try { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ps1 exited: no answer within 30s" | Add-Content -LiteralPath (Join-Path $PSScriptRoot 'serve-at-login.trace') } catch {}
`;
}

/**
 * The wrapper: start the launcher with no window at all.
 *
 * Window style 0 is applied by `WScript.Shell.Run` before the process exists,
 * which is the difference between "never visible" and "visible for a few
 * hundred milliseconds", and the Run key has no flag of its own for that.
 *
 * The launcher's path is **derived from this file's own location** rather than
 * written in, and that is deliberate: VBScript reads a script as ANSI with no
 * byte-order mark to ask for better, so a path with a non-ASCII character in it
 * would be decoded wrong at exactly the wrong moment. Deriving it keeps this
 * file ASCII whatever the user's name is.
 */
export function wrapperSource(): string {
  return `' Written by Photo Archive when "start at sign-in" was turned on.
' Starts serve-at-login.ps1 with no window; the Run key alone would show a console.
Option Explicit
Dim shell, folder, launcher, fso, traceFile
On Error Resume Next
Set shell = CreateObject("WScript.Shell")
folder = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
launcher = folder & "\\${LAUNCHER}"
Set fso = CreateObject("Scripting.FileSystemObject")
Set traceFile = fso.OpenTextFile(folder & "\\serve-at-login.trace", 8, True)
traceFile.WriteLine Now & " vbs started"
traceFile.Close
On Error GoTo 0
shell.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & launcher & """", 0, False
`;
}

/** `reg.exe`, hidden. */
const reg = (args: string[]) => exec("reg", args, { windowsHide: true });

/**
 * What the Run key **actually stores**, as this process last knew it.
 *
 * **Read once, then maintained here** — and that difference is between two
 * kinds of caller, which is why it is worth the state. Populating the control
 * is a *read*: a query on every Settings page, one `reg.exe` per open, for a
 * value the server itself wrote. Applying a change is a *write*, which needs
 * the process anyway.
 *
 * The read is also the one that opened a terminal: after a restart the server
 * runs with `stdio: 'ignore'` and so has no console of its own, and a console
 * child of a console-less parent gets a fresh, *visible* window — `windowsHide`
 * on the spawn covers that, and caching means it happens at most once, at
 * start-up (`warmAutostartCache`), where nothing is looking.
 *
 * Trusting the cache is deliberate: this is the server's own record, corrected
 * by the next save if someone edits the key by hand outside it.
 */
let registration: string | null = null;

/**
 * The stored data — "" when the value is absent or unreadable.
 *
 * The value *name* existing was never the point: there is one name per
 * machine, and a second archive home's line under it made that home's
 * switch read as "on" while the machine would start someone else's archive
 * at login. Holding the string instead of a boolean is what lets
 * `autostartStatus` report what is registered rather than what this home
 * would register — the desync the settings page was reported for.
 */
async function registeredLine(): Promise<string> {
  if (!supported) return "";
  if (registration !== null) return registration;
  try {
    const { stdout } = await reg(["query", RUN_KEY, "/v", VALUE]);
    const line = stdout.split(/\r?\n/).find((l) => l.includes("REG_SZ"));
    // `reg query` prints `name REG_SZ data`; everything after the type is the
    // value, and the data is whatever wrote it last — this home, another one,
    // or a hand edit.
    registration = line ? line.slice(line.indexOf("REG_SZ") + "REG_SZ".length).trim() : "";
  } catch {
    // No value of that name (reg exits non-zero) or the read failed: either
    // way nothing starts at sign-in, as far as this process can tell.
    registration = "";
  }
  return registration;
}

/** Asks once, at start-up, so the first Settings page does not have to. */
export function warmAutostartCache(): void {
  void registeredLine();
}

export async function autostartStatus(): Promise<AutostartStatus> {
  const command = await registeredLine();
  // One name per machine; "enabled" means the stored line points at *this*
  // home's wrapper. Another home's line reads as off here, with its line in
  // `command` so the page shows what the machine actually starts at login
  // instead of a checked box that would start someone else's archive.
  const mine = command !== "" && command.includes(homeFile(WRAPPER));
  return {
    supported,
    enabled: mine,
    script: homeFile(LAUNCHER),
    command,
  };
}

/**
 * Turns sign-in start-up on or off.
 *
 * Enabling refuses rather than registers something that cannot work: the
 * launcher is a path and an argument, so if this process was not started from
 * a file on disk (a REPL, a test runner) there is nothing to point at.
 *
 * Disabling removes the value *and* the two files — leaving a launcher behind
 * is how a machine ends up starting something nobody remembers writing.
 */
export async function setAutostart(enabled: boolean): Promise<AutostartStatus> {
  if (!supported) throw new Error("Sign-in start-up is only supported on Windows.");

  if (enabled) {
    const entry = process.argv[1];
    if (!entry || !isAbsolute(entry) || !existsSync(entry)) {
      throw new Error(
        `This server was not started from a file on disk (${entry ?? "no entry point"}), ` +
          `so there is nothing to register. Start it normally and turn this on again.`,
      );
    }
    await mkdir(dirname(homeFile(LAUNCHER)), { recursive: true });
    // The byte-order mark is load-bearing: the interpreter is Windows
    // PowerShell 5.1, which reads a script file as ANSI unless a mark says
    // otherwise. Without it every non-ASCII character in here - and any path
    // with one - decodes as mojibake at the moment of starting. The wrapper
    // goes the other way, because VBScript treats a mark as a syntax error:
    // it is written plain and built to stay ASCII.
    await writeFile(homeFile(LAUNCHER), `\uFEFF${launcherSource(entry, env.servePort)}`, "utf-8");
    await writeFile(homeFile(WRAPPER), wrapperSource(), "ascii");
    await reg(["add", RUN_KEY, "/v", VALUE, "/t", "REG_SZ", "/d", registeredValue(), "/f"]);
    registration = registeredValue();
    return autostartStatus();
  }

  if ((await registeredLine()) !== "") {
    await reg(["delete", RUN_KEY, "/v", VALUE, "/f"]);
  }
  registration = "";
  await Promise.all([rm(homeFile(LAUNCHER), { force: true }), rm(homeFile(WRAPPER), { force: true })]);
  return autostartStatus();
}
