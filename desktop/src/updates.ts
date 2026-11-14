import { app } from "electron";
import { autoUpdater, type UpdateInfo } from "electron-updater";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * In-app updates, from the GitHub release the installer came from.
 *
 * Two states are deliberately not updateable:
 *
 *   - the unpackaged dev shell: `electron-updater` would look for an
 *     `app-update.yml` that only exists inside a build;
 *   - a build made from a dirty tree. `build-info.json` records `dirty`, and a
 *     "1.1.0" that secretly contains half a commit is exactly the payload that
 *     makes an update look like a regression. Those installs keep working; they
 *     just do not update themselves.
 *
 * Signing is not in place yet, so the publisher check is off. It is not a
 * formality: with a certificate, `verifyUpdateCodeSignature` stays on and this
 * block goes away. Until then the only integrity check is the download itself,
 * which is why updates come from this repository's own releases.
 */
export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none"; checkedAt: number }
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string }
  | { kind: "unavailable"; reason: "dev" | "dirty" };

const ROOT = app.isPackaged ? process.resourcesPath : join(__dirname, "..", "..");
const INFO = join(ROOT, "pipeline", "build-info.json");

function buildInfo(): { version?: string; commit?: string; dirty?: boolean } {
  if (!existsSync(INFO)) return {};
  try {
    return JSON.parse(readFileSync(INFO, "utf8")) as { version?: string; commit?: string; dirty?: boolean };
  } catch {
    return {};
  }
}

let state: UpdateState = { kind: "idle" };
let listeners: Array<(s: UpdateState) => void> = [];
let wired = false;

export function currentUpdateState(): UpdateState {
  return state;
}

export function onUpdateState(fn: (s: UpdateState) => void): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

function set(next: UpdateState): void {
  state = next;
  for (const fn of listeners) fn(next);
}

/** Why this install cannot update itself, or null when it can. */
export function updateBlocker(): "dev" | "dirty" | null {
  if (!app.isPackaged) return "dev";
  if (buildInfo().dirty === true) return "dirty";
  return null;
}

function wire(): void {
  if (wired) return;
  wired = true;

  // Unsigned builds: see the file comment. The property lives on the NSIS
  // updater at runtime but not on AppUpdater's type, hence the cast.
  (autoUpdater as unknown as { verifyUpdateCodeSignature: boolean }).verifyUpdateCodeSignature = false;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;

  autoUpdater.on("checking-for-update", () => set({ kind: "checking" }));
  autoUpdater.on("update-not-available", (_info: UpdateInfo) => set({ kind: "none", checkedAt: Date.now() }));
  autoUpdater.on("update-available", (info: UpdateInfo) => set({ kind: "available", version: info.version }));
  autoUpdater.on("download-progress", (p) =>
    set({ kind: "downloading", version: state.kind === "downloading" ? state.version : "", percent: Math.round(p.percent) }),
  );
  autoUpdater.on("update-downloaded", (info: UpdateInfo) => set({ kind: "ready", version: info.version }));
  autoUpdater.on("error", (err: Error) => set({ kind: "error", message: err.message.slice(0, 300) }));
}

export async function checkForUpdates(): Promise<UpdateState> {
  const blocker = updateBlocker();
  if (blocker) {
    set({ kind: "unavailable", reason: blocker });
    return state;
  }
  wire();
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    set({ kind: "error", message: (err as Error).message.slice(0, 300) });
  }
  return state;
}

/**
 * Install what has been downloaded. `before-quit` stops the pipeline child, so
 * the installer replaces `resources/pipeline` without fighting a running
 * server for the files.
 */
export function installUpdate(): { ok: boolean; error?: string } {
  if (state.kind !== "ready") return { ok: false, error: "Nothing has been downloaded yet." };
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { ok: true };
}
