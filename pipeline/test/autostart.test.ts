import { describe, expect, it } from "vitest";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { launcherSource, registeredValue, runtimePath, wrapperSource } from "../src/autostart.js";

/**
 * The sign-in launcher, line by line.
 *
 * Nothing here runs: `launcherSource` and `wrapperSource` build text, and the
 * only thing that ever executes them is Windows at the next sign-in. That is
 * why they are worth a test — a quote wrong in a PowerShell single-quoted
 * string, a window style that hides nothing, or a path pinned to a directory
 * fnm will clean up all fail silently, days later, with nobody watching.
 */
const ENTRY = "C:\\Code\\proj\\pipeline\\dist\\serve.js";

/** What `autostart.ts` does to a value for PowerShell's single-quoted strings. */
const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

describe("registered value", () => {
  it("runs the wrapper through wscript, quoted", () => {
    expect(registeredValue()).toMatch(/^wscript\.exe ".*serve-at-login\.vbs"$/);
  });
});

describe("wrapper", () => {
  const src = wrapperSource();

  it("starts PowerShell hidden and without waiting", () => {
    expect(src).toContain("powershell.exe");
    expect(src).toContain("-ExecutionPolicy Bypass");
    // Style 0 is "hidden from the start" — `-WindowStyle Hidden` on the command
    // line is a console that appears and is then dismissed, which is the one
    // thing this mechanism exists not to do.
    expect(src).toMatch(/, 0, False\r?\n/);
    expect(src).toContain("serve-at-login.ps1");
  });

  it("derives the launcher's path instead of writing it, and stays ASCII", () => {
    // VBScript reads a script as ANSI, with no byte-order mark to ask for
    // better: any path written in here would decode wrong for a user whose
    // name is not ASCII. Deriving from this file's own name keeps it pure
    // ASCII, which is asserted rather than assumed.
    expect(src).toContain("WScript.ScriptFullName");
    expect(src).toMatch(/^[\x20-\x7E\r\n]+$/);
    expect(src).not.toContain("\\Code\\proj");
  });

  it("records that it ran, before anything that can fail", () => {
    // The chain has no other witness: the server writes nothing until it is
    // up, and the window is hidden. A run that died at the probe, or never
    // started, would otherwise look identical - which is exactly what the
    // first sign-in after a reboot looked like.
    expect(src).toContain("serve-at-login.trace");
    expect(src).toContain("vbs started");
  });
});

describe("launcher", () => {
  const src = launcherSource(ENTRY, 18419);

  it("carries a byte-order mark for PowerShell 5.1 to read it as UTF-8", () => {
    // The mark is added where the file is written rather than here; assert the
    // body is what that write prepends to, and that nothing outside ASCII was
    // left in it — mojibake in a comment is harmless, mojibake in a path is not.
    expect(src.startsWith("# Written by")).toBe(true);
    expect(src).toMatch(/^[\x09\x0A\x0D\x20-\x7E]+$/);
  });

  it("probes for a server before starting one", () => {
    const probe = src.indexOf("Invoke-WebRequest");
    const start = src.indexOf("Start-Process");
    expect(probe).toBeGreaterThan(0);
    expect(start).toBeGreaterThan(probe);
    expect(src).toContain("http://127.0.0.1:18419/health");
    expect(src).toContain("if ($health.StatusCode -eq 200)");
    expect(src).toContain("exit 0");
  });

  it("records that it ran before it probes", () => {
    // Written first, so the trace answers "did the chain start at all" even
    // when the probe below is what went wrong - or when nothing after this
    // line ever ran.
    const trace = src.indexOf("Add-Content");
    expect(trace).toBeGreaterThan(0);
    expect(trace).toBeLessThan(src.indexOf("Invoke-WebRequest"));
    expect(src).toContain("serve-at-login.trace");
  });

  it("runs the entry with the real runtime, detached and unredirected", () => {
    // Detached: the script used to block on `& node`, and the wrapper stayed
    // alive (51MB) for as long as the server did - two seconds of CPU a day
    // paid for by a permanent process.
    expect(src).toContain(
      `Start-Process -WindowStyle Hidden -FilePath '${runtimePath()}' -ArgumentList '"${ENTRY}"' -WorkingDirectory`,
    );
    expect(src).not.toMatch(/^& /m);
    // No redirect: the server mirrors both streams itself (logFile.ts), and a
    // second path into the same file would double every line. Worse, the
    // launcher's own `$ErrorActionPreference = 'SilentlyContinue'` discards
    // native stderr under redirection - measured - which is how the reason a
    // restart failed went missing.
    expect(src).not.toContain(">>");
    expect(src).toContain("ELECTRON_RUN_AS_NODE = '1'");
    expect(src).toContain("data\\serve.log");
  });

  it("says whether the detached copy came up", () => {
    // The last thing this script can know, and the only thing that tells a
    // sign-in which failed from one that never ran.
    expect(src).toContain("server answering");
    expect(src).toContain("no answer within 30s");
    // ...bounded, so the wrapper never lingers: 30s at sign-in, not forever.
    expect(src).toContain("AddSeconds(30)");
  });

  it("pins the real runtime, not the per-shell shim it was started through", () => {
    // fnm's multishell directory is created for one shell and pruned later; a
    // launcher pointing there works today and silently stops at the next
    // sign-in after fnm tidies up. Resolving must be idempotent — a second
    // realpath changing the answer would mean the first one still sat in a
    // shim directory.
    expect(realpathSync(runtimePath())).toBe(runtimePath());
    expect(runtimePath()).not.toContain("fnm_multishells");
    expect(src).not.toContain("fnm_multishells");
  });

  it("doubles a single quote rather than ending the string", () => {
    const awkward = launcherSource("C:\\it's\\serve.js", 18419);
    // The entry now sits inside ArgumentList's own quotes; what matters is that
    // the apostrophe doubled instead of closing the string.
    expect(awkward).toContain("C:\\it''s\\serve.js");
  });

  it("carries ARCHIVE_HOME through when the shell set one", () => {
    const previous = process.env.ARCHIVE_HOME;
    // Two different values go in: the variable is used verbatim for
    // `$env:ARCHIVE_HOME`, and `archiveHome()` *resolves* it for the child's
    // working directory. Those are the same string on Windows, where this
    // feature exists, and not the same on POSIX, where `C:\...` is a relative
    // path - which is what CI caught: a Windows-shaped literal asserted against
    // a resolved one passes on the developer's machine and nowhere else.
    const win = process.platform === "win32";
    const home = win ? "C:\\Users\\O'Brien\\Photo Archive" : "/home/O'Brien/Photo Archive";
    const located = resolve(home);
    process.env.ARCHIVE_HOME = home;
    try {
      const packaged = launcherSource(ENTRY, 18419);
      expect(packaged).toContain(`$env:ARCHIVE_HOME = ${psQuote(home)}`);
      expect(packaged).toContain(`-WorkingDirectory ${psQuote(located)}`);
    } finally {
      if (previous === undefined) delete process.env.ARCHIVE_HOME;
      else process.env.ARCHIVE_HOME = previous;
    }
  });

  it("says plainly which directory it is in when there is no archive home", () => {
    const previous = process.env.ARCHIVE_HOME;
    delete process.env.ARCHIVE_HOME;
    try {
      expect(launcherSource(ENTRY, 18419)).not.toContain("$env:ARCHIVE_HOME");
    } finally {
      if (previous !== undefined) process.env.ARCHIVE_HOME = previous;
    }
  });
});
