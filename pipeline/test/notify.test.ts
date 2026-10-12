import { describe, expect, it } from "vitest";
import type { JobKind, JobRecord } from "@travel-archive/shared";
import { escapeXml, notifyJobFinished, shouldNotify, toastBody, toastScript, toastTitle } from "../src/notify.js";

const both = { success: true, failures: true };

function record(kind: JobKind, status: JobRecord["status"], extra: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "test",
    kind,
    status,
    startedAt: "2026-10-13T00:00:00.000Z",
    finishedAt: "2026-10-13T00:01:00.000Z",
    progress: { phase: "saving", done: 1, total: 1, message: null },
    log: [],
    error: null,
    result: null,
    ...extra,
  };
}

describe("shouldNotify", () => {
  it("announces the work someone started, and only that work", () => {
    for (const kind of ["analyze", "organize", "trip", "translate"] as JobKind[]) {
      expect(shouldNotify(record(kind, "done"), both), kind).toBe(true);
    }
  });

  it("leaves the jobs that run on their own alone when they succeed", () => {
    for (const kind of ["scan", "sync", "collect", "locate"] as JobKind[]) {
      expect(shouldNotify(record(kind, "done"), both), kind).toBe(false);
    }
  });

  it("announces a failure whatever started it", () => {
    expect(shouldNotify(record("scan", "failed"), both)).toBe(true);
    expect(shouldNotify(record("sync", "failed"), both)).toBe(true);
    expect(shouldNotify(record("collect", "failed"), both)).toBe(true);
  });

  it("honours the two switches independently", () => {
    expect(shouldNotify(record("analyze", "done"), { success: false, failures: true })).toBe(false);
    expect(shouldNotify(record("analyze", "failed"), { success: true, failures: false })).toBe(false);
    expect(shouldNotify(record("analyze", "failed"), { success: false, failures: true })).toBe(true);
    expect(shouldNotify(record("analyze", "done"), { success: true, failures: false })).toBe(true);
  });

  it("stays quiet when someone is already watching the job", () => {
    expect(shouldNotify(record("analyze", "done"), both, true)).toBe(false);
    expect(shouldNotify(record("analyze", "failed"), both, true)).toBe(false);
  });

  it("treats a cancel as not an outcome", () => {
    expect(shouldNotify(record("analyze", "cancelled"), both)).toBe(false);
    expect(shouldNotify(record("scan", "cancelled"), both)).toBe(false);
  });

  it("says nothing about a job that is still running", () => {
    expect(shouldNotify(record("analyze", "running"), both)).toBe(false);
    expect(shouldNotify(record("analyze", "queued"), both)).toBe(false);
  });
});

describe("toastBody", () => {
  it("carries the job's own last word, without the log's timestamp", () => {
    const r = record("analyze", "done", { log: ["11:30:01  Writing 1 shard(s)...", "11:30:10  Scanned 48 photo(s)."] });
    expect(toastBody(r)).toBe("Scanned 48 photo(s).");
  });

  it("carries the failure's reason rather than the last log line", () => {
    const r = record("scan", "failed", {
      error: "Graph API 401 Unauthorized — the token was rejected",
      log: ["12:00:00  error: Graph API 401 Unauthorized — the token was rejected"],
    });
    expect(toastBody(r)).toBe("Graph API 401 Unauthorized — the token was rejected");
  });
});

describe("toastScript", () => {
  it("escapes what a log line can contain", () => {
    const script = toastScript({
      title: "Photo Archive · Analyze",
      body: 'Analyzed 2 "photo(s)" <3 & 4 > 1 — it\'s fine',
      aumid: "com.travelarchive.photoarchive",
      suppress: false,
    });
    expect(script).toContain("&quot;photo(s)&quot;");
    expect(script).toContain("&lt;3 &amp; 4 &gt; 1");
    expect(script).toContain("&apos;s fine");
    // The raw text must not survive into the markup.
    expect(script).not.toContain('Analyzed 2 "photo');
  });

  it("can post silently", () => {
    const silent = toastScript({ title: "t", body: "b", aumid: "x", suppress: true });
    const loud = toastScript({ title: "t", body: "b", aumid: "x", suppress: false });
    expect(silent).toContain("$toast.SuppressPopup = $true");
    expect(loud).toContain("$toast.SuppressPopup = $false");
  });

  it("names the identity the notification is filed under", () => {
    expect(toastScript({ title: "t", body: "b", aumid: "PhotoArchive.Server", suppress: false })).toContain(
      "CreateToastNotifier('PhotoArchive.Server')",
    );
  });
});

describe("escapeXml", () => {
  it("covers the five characters that break the markup", () => {
    expect(escapeXml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &apos;");
  });
});

describe("notifyJobFinished", () => {
  it("does nothing — and never throws — for a job nobody wants to hear about", () => {
    // Not posting is the contract here; the spawn path is covered by
    // `sendTestNotification` on a real machine, because a unit test must not
    // ring the developer's bell.
    expect(notifyJobFinished(record("scan", "done"))).toBe(false);
    expect(notifyJobFinished(record("analyze", "cancelled"))).toBe(false);
    expect(notifyJobFinished(record("analyze", "done"), { watched: true })).toBe(false);
  });

  it("reports whether it would post, for the policy to be read in tests", () => {
    // NOTIFY_SUCCESS=0 is the switch a Settings save would write; the shell is
    // pointed at nothing so the assertion cannot ring a real bell on the
    // machine running the suite.
    const previousEnv = {
      success: process.env.NOTIFY_SUCCESS,
      shell: process.env.POWERSHELL_EXE,
    };
    process.env.NOTIFY_SUCCESS = "0";
    process.env.POWERSHELL_EXE = "no-such-shell-for-tests.exe";
    try {
      expect(notifyJobFinished(record("analyze", "done"))).toBe(false);
      expect(notifyJobFinished(record("analyze", "failed"))).toBe(true);
    } finally {
      if (previousEnv.success === undefined) delete process.env.NOTIFY_SUCCESS;
      else process.env.NOTIFY_SUCCESS = previousEnv.success;
      if (previousEnv.shell === undefined) delete process.env.POWERSHELL_EXE;
      else process.env.POWERSHELL_EXE = previousEnv.shell;
    }
  });
});
