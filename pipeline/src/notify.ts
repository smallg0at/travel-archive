import { spawn } from "node:child_process";
import type { JobKind, JobRecord } from "@travel-archive/shared";

/**
 * Telling the owner a job ended, without a client open.
 *
 * The job server already runs in the signed-in session (it starts at sign-in
 * via the Run key), so it can post a Windows toast itself: no desktop window,
 * no phone, no third-party service, nothing leaves the machine. Every other
 * channel considered — Electron's Notification, ntfy, Telegram, e-mail — needs
 * either a client process alive or an account, and this archive is one person's
 * travel photographs.
 *
 * The rules that keep it from becoming a nuisance, all enforced here rather
 * than remembered at the call site:
 *
 *   - **Success only for work someone started.** `analyze`, `organize`, `trip`
 *     and `translate` cost money and take minutes, so their ending is news.
 *     `scan`, `sync`, `collect` and `locate` run on their own or on a phone and
 *     their success is not news — while their *failure* still is.
 *   - **A watched job is already on screen.** If something is subscribed to
 *     this job (the Activity page is open on it), a toast repeats what the
 *     reader can see.
 *   - **A cancel is not an outcome.** The person who pressed it knows.
 *   - **This never fails loudly.** A toast is the softest thing the server
 *     does; a missing notification, a broken PowerShell, a machine with
 *     notifications switched off — none of it may touch the job that just
 *     finished. Errors are logged at most once per ten minutes.
 *
 * Delivery has two shapes, measured on this machine on 2026-10-13:
 * a normal toast shows a banner and lands in the Action Center, and
 * `SuppressPopup = $true` shows **no banner and still lands there** — which is
 * what `NOTIFY_BANNER=0` selects. The banner switch is config-only for now; it
 * has not earned a row in Settings until someone has lived with both.
 */

/** Jobs whose success is worth interrupting for. */
const WORTH_A_TOAST: ReadonlySet<JobKind> = new Set(["analyze", "organize", "trip", "translate"]);

/**
 * The identity the toast is filed under.
 *
 * Windows names and icons a notification from the Start Menu shortcut that
 * carries this AppUserModelID, so a machine without that shortcut still gets
 * the toast but under whatever name Windows has for the raw id. The desktop
 * app's own id (from `desktop/package.json`) — reusing it keeps one icon and
 * one name for the whole archive instead of a second identity to keep in step.
 */
const DEFAULT_AUMID = "com.travelarchive.photoarchive";

export interface NotifyModes {
  success: boolean;
  failures: boolean;
}

/**
 * The switches, read live.
 *
 * Read from `process.env` on purpose: `saveConfig` writes it and reloads, so a
 * change saved in Settings applies to the *next* job with no restart, and a
 * server that had to be restarted for a notification switch would be a worse
 * deal than the switch.
 */
export function notifyModes(): NotifyModes {
  return {
    success: process.env.NOTIFY_SUCCESS !== "0",
    failures: process.env.NOTIFY_FAILURES !== "0",
  };
}

/**
 * Whether this ending is news. Pure, so the whole policy is one table of
 * tests: the kinds, the two switches, the cancel, the watched job.
 */
export function shouldNotify(
  record: Pick<JobRecord, "kind" | "status">,
  modes: NotifyModes,
  watched = false,
): boolean {
  if (watched) return false;
  if (record.status === "cancelled") return false;
  if (record.status === "failed") return modes.failures;
  if (record.status !== "done") return false;
  return modes.success && WORTH_A_TOAST.has(record.kind);
}

/** `11:30:00  Scanned 48 photo(s)` → `Scanned 48 photo(s)`. */
function logMessage(line: string): string {
  return line.replace(/^\d{2}:\d{2}:\d{2}\s+/, "");
}

/** The sentence a toast carries: the job's own last word, never a paraphrase. */
export function toastBody(record: JobRecord): string {
  if (record.status === "failed") {
    return record.error || (record.log.at(-1) ? logMessage(record.log.at(-1)!) : "Failed.");
  }
  const line = [...record.log].reverse().find((l) => !l.startsWith("error:"));
  return (line ? logMessage(line) : record.progress.message || "Finished.").slice(0, 240);
}

export function toastTitle(record: Pick<JobRecord, "kind">): string {
  const kind = record.kind;
  return `Photo Archive · ${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
}

/** XML-escapes text destined for the toast's markup. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * The PowerShell that posts one toast, as a string.
 *
 * Returned rather than run so the escaping can be tested without posting a
 * notification at every test run. `-EncodedCommand` (base64 of UTF-16LE) is how
 * it is finally passed: a log line full of quotes, parentheses and Chinese
 * meets no shell, no argument quoting and no temp file.
 */
export function toastScript(opts: {
  title: string;
  body: string;
  aumid: string;
  suppress: boolean;
}): string {
  return [
    "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
    "[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]",
    `$xml = New-Object Windows.Data.Xml.Dom.XmlDocument`,
    `$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>${escapeXml(opts.title)}</text><text>${escapeXml(opts.body)}</text></binding></visual></toast>')`,
    `$toast = New-Object Windows.UI.Notifications.ToastNotification($xml)`,
    `$toast.SuppressPopup = $${opts.suppress ? "true" : "false"}`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${escapeXml(opts.aumid)}').Show($toast)`,
  ].join("\n");
}

function encodedCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** Fire-and-forget: the caller must never await this on a job's critical path. */
function post(script: string, onFail?: (err: Error) => void): void {
  if (process.platform !== "win32") return;
  try {
    const child = spawn(
      process.env.POWERSHELL_EXE || "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand(script)],
      { windowsHide: true, stdio: "ignore" },
    );
    child.on("error", (err) => onFail?.(err));
    // The toast is shown by the time the process exits; a non-zero exit means
    // the notifier failed, which is worth one log line and nothing more.
    child.on("exit", (code) => {
      if (code) onFail?.(new Error(`powershell exited ${code}`));
    });
  } catch (err) {
    onFail?.(err as Error);
  }
}

const LOGGED_AT = new Map<string, number>();
const LOG_EVERY_MS = 10 * 60 * 1000;

/** One line, at most one per ten minutes per reason — not a log flood. */
function noteFailure(reason: string, err: Error): void {
  const last = LOGGED_AT.get(reason) ?? 0;
  if (Date.now() - last < LOG_EVERY_MS) return;
  LOGGED_AT.set(reason, Date.now());
  console.log(`notification not sent (${reason}): ${err.message}`);
}

/**
 * Announces a finished job. Returns whether a toast was actually posted, which
 * the tests read; the caller in `jobs.ts` ignores it on purpose.
 */
export function notifyJobFinished(
  record: Pick<JobRecord, "kind" | "status" | "log" | "error" | "progress">,
  opts: { watched?: boolean } = {},
): boolean {
  try {
    if (!shouldNotify(record as JobRecord, notifyModes(), opts.watched)) return false;
    const suppress = process.env.NOTIFY_BANNER === "0";
    post(
      toastScript({
        title: toastTitle(record as Pick<JobRecord, "kind">),
        body: toastBody(record as JobRecord),
        aumid: process.env.NOTIFY_AUMID?.trim() || DEFAULT_AUMID,
        suppress,
      }),
      (err) => noteFailure(record.kind, err),
    );
    return true;
  } catch (err) {
    noteFailure("unexpected", err as Error);
    return false;
  }
}

/**
 * One toast on demand — the Settings "send a test" button.
 *
 * It rejects with the reason rather than reporting success, because the point
 * of the button is to find out whether this machine will show one at all: a
 * server that answers `ok` while Windows has notifications switched off would
 * be the one lie the button exists to prevent.
 */
export function sendTestNotification(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.platform !== "win32") {
      reject(new Error("Desktop notifications are only available on Windows."));
      return;
    }
    const script = toastScript({
      title: "Photo Archive",
      body: `Test notification — sent at ${new Date().toLocaleTimeString()}.`,
      aumid: process.env.NOTIFY_AUMID?.trim() || DEFAULT_AUMID,
      suppress: process.env.NOTIFY_BANNER === "0",
    });
    let settled = false;
    const child = spawn(
      process.env.POWERSHELL_EXE || "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand(script)],
      { windowsHide: true, stdio: "ignore" },
    );
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve();
    };
    child.on("error", (err) => done(err));
    child.on("exit", (code) => (code ? done(new Error(`powershell exited ${code}`)) : done()));
  });
}
