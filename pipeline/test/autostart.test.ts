import { describe, expect, it } from "vitest";
import { realpathSync } from "node:fs";
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
    const start = src.indexOf("& '");
    expect(probe).toBeGreaterThan(0);
    expect(start).toBeGreaterThan(probe);
    expect(src).toContain("http://127.0.0.1:18419/health");
    expect(src).toContain("if ($health.StatusCode -eq 200) { exit 0 }");
  });

  it("runs the entry with the runtime that started it, redirected to a log", () => {
    expect(src).toContain(`& '${runtimePath()}' '${ENTRY}' *>> $log`);
    expect(src).toContain("ELECTRON_RUN_AS_NODE = '1'");
    expect(src).toContain("serve.log");
    expect(src).toContain("New-Item -ItemType Directory -Force");
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
    expect(awkward).toContain("'C:\\it''s\\serve.js'");
  });

  it("carries ARCHIVE_HOME through when the shell set one", () => {
    const previous = process.env.ARCHIVE_HOME;
    process.env.ARCHIVE_HOME = "C:\\Users\\O'Brien\\Photo Archive";
    try {
      const packaged = launcherSource(ENTRY, 18419);
      expect(packaged).toContain("$env:ARCHIVE_HOME = 'C:\\Users\\O''Brien\\Photo Archive'");
      expect(packaged).toContain("Set-Location 'C:\\Users\\O''Brien\\Photo Archive'");
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
