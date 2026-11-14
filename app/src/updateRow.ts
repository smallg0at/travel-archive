import { el } from "./photoUi";
import { ui } from "./i18n";

/** The shape desktop/src/updates.ts sends over IPC. */
type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none"; checkedAt: number }
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string }
  | { kind: "unavailable"; reason: "dev" | "dirty" };

interface UpdatesApi {
  state(): Promise<unknown>;
  check(): Promise<unknown>;
  install(): Promise<{ ok: boolean; error?: string }>;
  onState(fn: (state: unknown) => void): () => void;
}

/**
 * One row in Settings → App. No modal, no badge on the icon: an update is
 * something to notice when the settings page is open, not an interruption.
 *
 * The button does both jobs — check, then install once something has been
 * downloaded — because a second control that only appears in one state is a
 * control nobody finds.
 */
export function updateRow(api: UpdatesApi): HTMLElement {
  const row = el<HTMLDivElement>(`<div class="set-row is-update"><span>${ui.settings.updates}</span></div>`);
  const control = el<HTMLDivElement>(`<div class="set-about-update"></div>`);
  const note = el<HTMLSpanElement>(`<span class="set-note"></span>`);
  const button = el<HTMLButtonElement>(`<button type="button" class="set-link-chip"></button>`);
  control.append(note, button);
  row.appendChild(control);

  let state: UpdateState = { kind: "idle" };
  let busy = false;

  const apply = (raw: unknown): void => {
    const next = raw as UpdateState;
    state = next;
    busy = next.kind === "checking" || next.kind === "downloading";
    switch (next.kind) {
      case "idle":
        note.textContent = "";
        button.textContent = ui.settings.updateCheck;
        break;
      case "checking":
        note.textContent = ui.settings.updateChecking;
        button.textContent = ui.settings.updateCheck;
        break;
      case "none":
        note.textContent = ui.settings.updateNone;
        button.textContent = ui.settings.updateCheck;
        break;
      case "available":
        note.textContent = ui.settings.updateAvailable(next.version);
        button.textContent = ui.settings.updateCheck;
        break;
      case "downloading":
        note.textContent = ui.settings.updateDownloading(next.percent);
        button.textContent = ui.settings.updateCheck;
        break;
      case "ready":
        note.textContent = ui.settings.updateReady(next.version);
        button.textContent = ui.settings.updateInstall;
        break;
      case "error":
        // "Cannot find latest.yml ... 404" is not a failure the reader can act
        // on; it means this release simply has no update metadata yet.
        note.textContent = /latest\.yml/i.test(next.message)
          ? ui.settings.updateNoRelease
          : ui.settings.updateFailed(next.message);
        button.textContent = ui.settings.updateCheck;
        break;
      case "unavailable":
        note.textContent =
          next.reason === "dirty" ? ui.settings.updateDirtyBuild : ui.settings.updateDevBuild;
        button.textContent = ui.settings.updateCheck;
        break;
    }
    button.disabled = busy || next.kind === "unavailable";
  };

  button.addEventListener("click", () => {
    if (state.kind === "ready") {
      void api.install().then((result) => {
        if (!result.ok && result.error) apply({ kind: "error", message: result.error });
      });
      return;
    }
    apply({ kind: "checking" });
    void api.check().then(apply);
  });

  api.onState(apply);
  void api.state().then(apply);
  return row;
}
