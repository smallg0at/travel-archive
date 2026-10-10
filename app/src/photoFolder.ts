import { el } from "./photoUi";
import { ui } from "./i18n";
import { oobeFolder, oobeFolders, saveConfig, type FolderProbe } from "./backend";

/**
 * The photos-folder editor — one implementation behind two homes.
 *
 * The wizard's page 2 grew every honest behaviour this archive needs on a
 * folder: answers are drawn under the path they measured (a ✓ for a
 * sub-folder outliving a change back to the root was a real bug), a
 * candidate is probed *before* `POST /config` ever hears about it (a typo
 * used to land in `.env` on one click), typing retires a stale answer in
 * place so the caret survives, and the picker walks real OneDrive folders.
 * Settings then asked for the same field after the wizard closed — rather
 * than fork all of that, it lives here and both surfaces mount `root`.
 *
 * The panel owns its state and paints itself; the host observes `onChange`
 * for any gate it draws around it (the wizard's Continue is one).
 */
interface Picking {
  path: string;
  folders: string[];
  loading: boolean;
  notFound: boolean;
}

interface PanelState {
  /** What the server has configured — the path every answer must match. */
  path: string;
  editing: boolean;
  text: string;
  probe: FolderProbe | null;
  probing: boolean;
  pick: Picking | null;
  error: string | null;
}

export interface FolderPanel {
  /** Mount this; moving it keeps its DOM (and focus) intact. */
  readonly root: HTMLElement;
  /** The configured path as last known. */
  path(): string;
  /** Measured, measuring this path, not mid-edit — a Continue gate. */
  ok(): boolean;
  /** Ask the server about the configured path (first arrival does this). */
  probe(): Promise<void>;
  /** Re-probe with `confirm` — the stamp that records a human agreed. */
  stamp(): Promise<boolean>;
  /** The path changed elsewhere (an `/oobe` poll); retires other answers. */
  setServerPath(path: string): void;
  /** Fires whenever `ok()` may have changed. */
  onChange(cb: () => void): void;
}

export function createFolderPanel(initialPath: string): FolderPanel {
  const state: PanelState = {
    path: initialPath,
    editing: false,
    text: initialPath,
    probe: null,
    probing: true, // until the first answer: "confirming", never a silent gap
    pick: null,
    error: null,
  };
  const root = el(`<div class="photo-folder"></div>`);
  const listeners: (() => void)[] = [];
  const emit = (): void => listeners.forEach((fn) => fn());
  const ok = (): boolean =>
    state.probe?.state === "ok" && state.probe.path === state.path && !state.probing && !state.editing;

  // The status line always names the path it measured: `FolderProbe.path`
  // must match what is on screen, or the line reads "not confirmed yet" —
  // never another folder's answer.
  const statusNode = (): HTMLElement => {
    if (state.probing) return el(`<p class="set-note">${ui.setup.checking}</p>`);
    const active = state.editing ? state.text.trim() : state.path;
    const p = state.probe;
    if (!p || p.path !== active) return el(`<p class="set-note">${ui.setup.unchecked}</p>`);
    if (p.state === "ok") return el(`<p class="setup-ok">✓ ${ui.setup.folderExists(p.count ?? 0, p.months ?? 0)}</p>`);
    if (p.state === "not-found") return el(`<p class="set-note tone-warn">${ui.setup.notFound}</p>`);
    return el(`<p class="set-note tone-warn">${ui.setup.noToken}</p>`);
  };

  const paint = (): void => {
    root.replaceChildren();
    if (state.editing) {
      const field = el(`<div class="setup-field"></div>`);
      const input = el<HTMLInputElement>(`<input type="text" class="setup-input"></input>`);
      input.value = state.text;
      input.addEventListener("input", () => {
        state.text = input.value;
        // Typing retires an answer that no longer describes the text — in
        // place, because a full re-render here would eat the caret.
        if (state.probe && state.probe.path !== input.value.trim()) {
          state.probe = null;
          document.getElementById("photo-folder-status")?.replaceChildren(statusNode());
          emit(); // a gate around the panel (Continue) keys off ok()
        }
      });
      field.appendChild(input);
      const save = el<HTMLButtonElement>(`<button type="button" class="set-btn"></button>`);
      save.textContent = ui.setup.check;
      save.addEventListener("click", () => void confirm(input.value.trim()));
      field.appendChild(save);
      const browse = el<HTMLButtonElement>(`<button type="button" class="set-btn"></button>`);
      browse.textContent = ui.setup.browse;
      browse.addEventListener("click", () => void openPicker(input.value.trim() || ""));
      field.appendChild(browse);
      root.appendChild(field);
      root.appendChild(el(`<p class="set-note">${ui.setup.monthHint}</p>`));
    } else {
      root.appendChild(el(`<p class="setup-path">${state.path}</p>`));
      const change = el<HTMLButtonElement>(`<button type="button" class="set-btn"></button>`);
      change.textContent = ui.setup.change;
      change.addEventListener("click", () => {
        state.editing = true;
        state.text = state.path;
        paint();
      });
      root.appendChild(change);
    }
    const statusHost = el(`<div id="photo-folder-status"></div>`);
    statusHost.appendChild(statusNode());
    root.appendChild(statusHost);
    // An unmeasured folder offers the confirm action where the status sits.
    if (!state.editing && !state.probing && !ok()) {
      const confirmBtn = el<HTMLButtonElement>(`<button type="button" class="set-btn"></button>`);
      confirmBtn.textContent = ui.setup.check;
      confirmBtn.addEventListener("click", () => void confirm(state.path));
      root.appendChild(confirmBtn);
    }
    if (state.error) root.appendChild(el(`<p class="set-note tone-warn">${state.error}</p>`));
    if (state.pick) root.appendChild(pickerNode());
  };

  const pickerNode = (): HTMLElement => {
    const pick = state.pick!;
    const panel = el(`<div class="setup-picker"></div>`);
    panel.appendChild(el(`<p class="setup-path">${pick.path || "/"}</p>`));
    const up = el<HTMLButtonElement>(`<button type="button" class="set-btn"></button>`);
    up.textContent = ui.setup.pickUp;
    up.disabled = !pick.path;
    up.addEventListener("click", () => {
      const path = pick.path.split("/").slice(0, -1).join("/");
      void openPicker(path);
    });
    panel.appendChild(up);
    const list = el(`<div class="setup-pick-list"></div>`);
    if (pick.loading) list.appendChild(el(`<p class="set-note">${ui.setup.checking}</p>`));
    else if (pick.notFound) list.appendChild(el(`<p class="set-note tone-warn">${ui.setup.notFound}</p>`));
    else if (!pick.folders.length) list.appendChild(el(`<p class="set-note">${ui.setup.pickEmpty}</p>`));
    for (const name of pick.folders) {
      const row = el(`<div class="setup-pick-row"></div>`);
      const down = el<HTMLButtonElement>(`<button type="button" class="linkish"></button>`);
      down.textContent = name;
      down.addEventListener("click", () => void openPicker(pick.path ? `${pick.path}/${name}` : name));
      row.appendChild(down);
      const choose = el<HTMLButtonElement>(`<button type="button" class="set-btn"></button>`);
      choose.textContent = ui.setup.pickChoose;
      choose.addEventListener("click", () => {
        const path = pick.path ? `${pick.path}/${name}` : name;
        state.pick = null;
        void confirm(path);
      });
      row.appendChild(choose);
      list.appendChild(row);
    }
    panel.appendChild(list);
    const close = el<HTMLButtonElement>(`<button type="button" class="set-btn"></button>`);
    close.textContent = ui.setup.pickClose;
    close.addEventListener("click", () => {
      state.pick = null;
      paint();
    });
    panel.appendChild(close);
    return panel;
  };

  const openPicker = async (start: string): Promise<void> => {
    state.pick = { path: start, folders: [], loading: true, notFound: false };
    paint();
    const listed = await oobeFolders(start);
    if (!state.pick) return;
    state.pick.folders = listed?.folders ?? [];
    state.pick.notFound = listed?.state === "not-found";
    state.pick.loading = false;
    paint();
  };

  const probe = async (): Promise<void> => {
    state.probing = true;
    state.error = null;
    paint();
    const result = await oobeFolder(false);
    state.probing = false;
    state.probe = result;
    if (result?.path) state.path = result.path;
    paint();
    emit();
  };

  /**
   * Validates a candidate and only then writes it: the probe is a read-only
   * question, `POST /config` stays the one way a setting changes, and a
   * folder that 404s never reaches the config file.
   */
  const confirm = async (candidate: string): Promise<void> => {
    if (!candidate) return;
    state.probing = true;
    state.error = null;
    paint();
    const result = await oobeFolder(false, candidate);
    state.probing = false;
    state.probe = result;
    if (result?.state === "ok" && result.path === candidate) {
      try {
        await saveConfig({ ONEDRIVE_PHOTOS_FOLDER: candidate });
        state.path = candidate;
        state.text = candidate;
        state.editing = false;
      } catch (err) {
        state.error = (err as Error).message;
      }
    }
    paint();
    emit();
  };

  const stamp = async (): Promise<boolean> => {
    state.probing = true;
    state.error = null;
    paint();
    const result = await oobeFolder(true);
    state.probing = false;
    state.probe = result;
    if (result?.path) state.path = result.path;
    paint();
    emit();
    return ok();
  };

  paint();
  void probe();

  return {
    root,
    path: () => state.path,
    ok,
    probe,
    stamp,
    setServerPath: (path: string) => {
      if (path === state.path) return;
      state.path = path;
      state.probe = null;
      paint();
      emit();
    },
    onChange: (cb) => listeners.push(cb),
  };
}
