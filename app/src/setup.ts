/**
 * First-run setup — the four-page wizard from docs/oobe.md.
 *
 * The server decides whether this appears (`setupNeeded`), and it only ever
 * does on this machine, before the archive has been scanned: at that point
 * there is nothing to show — no index exists until the wizard's last page
 * runs the first scan — so the wizard *is* the first screen rather than a
 * dialog over an empty one.
 *
 * Deliberately not a View kind: it is not reachable from the nav, adds no
 * history entry, and hides the sidebar and search while it is up (there is
 * nothing in them yet). It hands control back through the callbacks it was
 * given, and leaves no state behind when it is dismissed — the design's
 * "skipping records nothing" — so a reload re-enters it.
 */
import { el } from "./photoUi";
import type { ConfigStatus, JobRecord } from "@travel-archive/shared";
import { contentLanguage, setContentLanguage } from "./contentLang";
import { ui } from "./i18n";
import {
  archiveStatus,
  canWrite,
  checkHealth,
  getConfig,
  oobeFolder,
  oobeFolders,
  oobeSignIn,
  oobeState,
  saveConfig,
  startScan,
  validateGeneration,
  watchJob,
  type FolderProbe,
  type OobeState,
} from "./backend";

interface Picking {
  path: string;
  folders: string[];
  loading: boolean;
  notFound: boolean;
}

interface ScanState {
  job: JobRecord | null;
  stop: (() => void) | null;
  error: string | null;
  photos: number | null;
  months: number | null;
}

interface State {
  step: 1 | 2 | 3 | 4;
  signedIn: boolean;
  deviceCode: OobeState["deviceCode"];
  signingIn: boolean;
  photosFolder: string;
  editing: boolean;
  folderText: string;
  probe: FolderProbe | null;
  probing: boolean;
  pick: Picking | null;
  config: ConfigStatus | null;
  keyDraft: string;
  /** The provider picked in the wizard, held across re-renders until saved. */
  providerDraft: string;
  /** The last validation of that pick: a failed one blocks Continue. */
  validateFailed: boolean;
  saveError: string | null;
  scan: ScanState | null;
}

let state: State = fresh();
let poll: number | null = null;
let active = false;

function fresh(): State {
  return {
    step: 1,
    signedIn: false,
    deviceCode: null,
    signingIn: false,
    photosFolder: "",
    editing: false,
    folderText: "",
    probe: null,
    probing: false,
    pick: null,
    config: null,
    keyDraft: "",
    providerDraft: "",
    validateFailed: false,
    saveError: null,
    scan: null,
  };
}

/**
 * Where the wizard was **in this tab**.
 *
 * `neverScanned` alone is not enough: the folder stamp (what releases the
 * first scan) used to gate this function too, so pressing Continue on page 2
 * and reloading dropped the reader into the app with no way back — and the
 * auto scan would quietly finish the wizard behind them. A step this tab
 * recorded means "still in progress" and keeps the wizard alive across a
 * refresh, even if the background scan completed while it was open; the
 * key dies with the tab, so a fresh visit later sees the normal app.
 */
const STEP_KEY = "setup.step";
const resumedStep = (): 1 | 2 | 3 | 4 | null => {
  const n = Number(sessionStorage.getItem(STEP_KEY));
  return n >= 1 && n <= 4 ? (n as 1 | 2 | 3 | 4) : null;
};

/** Move pages, leaving a trail this tab's refresh can follow. */
const goto = (step: 1 | 2 | 3 | 4): void => {
  state.step = step;
  sessionStorage.setItem(STEP_KEY, String(step));
};

/**
 * Whether this machine is still owed the wizard.
 *
 * A fresh archive (server-computed `neverScanned`) **or** an unfinished step
 * in this tab (see `resumedStep`). Gated on write capability — a remote
 * reader has no route to any of this — and absent-on-error: a reader that
 * cannot ask should get the app it already knows, not a wizard nobody can
 * complete.
 */
export async function setupNeeded(): Promise<boolean> {
  try {
    if (!canWrite()) return false;
    const s = await oobeState();
    return !!s && (s.neverScanned || resumedStep() !== null);
  } catch {
    return false;
  }
}

/**
 * Runs the wizard. `onDone` lands back in the normal app; there is no
 * skip-back-door — with nothing built yet there is nothing to peek at, and
 * the state it would skip past (agreed folder) is exactly what has to happen.
 */
export function showSetup(opts: { onDone: () => void }): void {
  if (active) return;
  active = true;
  state = fresh();
  state.step = resumedStep() ?? 1;
  document.body.classList.add("setup-active");

  const content = document.getElementById("content")!;
  content.replaceChildren(el(`<div class="loading">${ui.setup.loading}</div>`));

  const exit = (next: () => void) => {
    stopPoll();
    state.scan?.stop?.();
    active = false;
    sessionStorage.removeItem(STEP_KEY);
    document.body.classList.remove("setup-active");
    next();
  };

  const render = (): void => {
    content.replaceChildren(renderPage());
    wirePage();
  };

  // --- polling: page 1 watches the server's own sign-in state -------------
  const stopPoll = (): void => {
    if (poll !== null) {
      window.clearInterval(poll);
      poll = null;
    }
  };
  const refreshOobe = async (): Promise<void> => {
    const s = await oobeState();
    if (!s || !active) return;
    const before = `${state.signedIn}${state.deviceCode?.code ?? ""}`;
    state.signedIn = s.signedIn;
    state.deviceCode = s.deviceCode;
    if (s.photosFolder !== state.photosFolder) {
      state.photosFolder = s.photosFolder;
      state.probe = null; // a folder set elsewhere has not been measured here
    }
    const after = `${state.signedIn}${state.deviceCode?.code ?? ""}`;
    if (before !== after) render();
    if (s.signedIn) stopPoll();
  };
  const startPoll = (): void => {
    if (poll !== null) return;
    poll = window.setInterval(() => void refreshOobe(), 2000);
  };

  // --- page 2 -------------------------------------------------------------
  /**
   * Probes a folder. The answer carries the path it measured
   * (`FolderProbe.path`), and the page draws it under that path only — the
   * old state updated `photosFolder` and `probe` along different routes, so
   * a ✓ for a sub-folder could outlive a change back to the root and only a
   * refresh straightened it out.
   */
  const probeFolder = async (confirm: boolean, path?: string): Promise<void> => {
    state.probing = true;
    state.saveError = null;
    render();
    state.probe = await oobeFolder(confirm, path);
    state.probing = false;
    render();
  };

  /**
   * Validates a candidate path and only then writes it: the probe is a
   * read-only question, `POST /config` stays the one way a setting changes,
   * and a folder that 404s never reaches the config file (the old flow saved
   * first — one click on a typo wrote it into `.env`).
   */
  const confirmFolder = async (candidate: string): Promise<void> => {
    if (!candidate) return;
    await probeFolder(false, candidate);
    if (state.probe?.state !== "ok" || state.probe.path !== candidate) return;
    try {
      await saveConfig({ ONEDRIVE_PHOTOS_FOLDER: candidate });
      state.photosFolder = candidate;
      state.folderText = candidate;
      state.editing = false;
      render();
    } catch (err) {
      state.saveError = (err as Error).message;
      render();
    }
  };

  /** What Continue waits on: measured, measuring the configured path, not mid-edit. */
  const folderOk = (): boolean =>
    state.probe?.state === "ok" && state.probe.path === state.photosFolder && !state.editing && !state.probing;

  const openPicker = async (start: string): Promise<void> => {
    state.pick = { path: start, folders: [], loading: true, notFound: false };
    render();
    const listed = await oobeFolders(start);
    if (!state.pick) return;
    state.pick.folders = listed?.folders ?? [];
    state.pick.notFound = listed?.state === "not-found";
    state.pick.loading = false;
    render();
  };

  const descend = async (name: string): Promise<void> => {
    if (!state.pick) return;
    const path = state.pick.path ? `${state.pick.path}/${name}` : name;
    await openPicker(path);
  };

  const upOne = async (): Promise<void> => {
    if (!state.pick) return;
    const path = state.pick.path.split("/").slice(0, -1).join("/");
    await openPicker(path);
  };

  const choose = async (): Promise<void> => {
    const path = state.pick?.path ?? "";
    state.pick = null;
    if (path) await confirmFolder(path);
    else render();
  };

  // --- page 3 -------------------------------------------------------------
  const loadConfig = async (): Promise<void> => {
    if (state.config) return;
    state.config = await getConfig();
    if (!state.providerDraft) state.providerDraft = state.config?.provider ?? "";
    render();
  };

  const saveGeneration = async (): Promise<void> => {
    state.saveError = null;
    state.validateFailed = false;
    try {
      const cfg = state.config;
      const select = document.getElementById("setup-provider") as HTMLSelectElement | null;
      const provider = select?.value || state.providerDraft || cfg?.provider;
      // A key is believed only after the provider believes it: this form used
      // to write any text into `.env` and continue, with the typo surfacing
      // minutes later as a failed job. Local services are checked too — an
      // LM Studio that is not running says so here instead of at scan time.
      if (provider) {
        const verdict = await validateGeneration(provider, state.keyDraft);
        if (!verdict.ok) {
          state.validateFailed = true;
          state.saveError = verdict.detail;
          render();
          return;
        }
      }
      const patch: Record<string, string> = {};
      if (provider) patch.AI_PROVIDER = provider;
      const key = state.keyDraft.trim();
      if (key && provider) patch[`${provider.toUpperCase()}_API_KEY`] = key;
      if (Object.keys(patch).length) await saveConfig(patch);
      state.keyDraft = "";
      goto(4);
      render();
    } catch (err) {
      state.saveError = (err as Error).message;
      render();
    }
  };

  // --- page 4 -------------------------------------------------------------
  const startFirstScan = async (): Promise<void> => {
    state.saveError = null;
    state.scan = { job: null, stop: null, error: null, photos: null, months: null };
    render();

    // Both this button and the 60-second scan timer can want the first scan;
    // one job runs and the other gets "already running" (noted in
    // docs/oobe.md). Attaching to the job that won is the honest recovery:
    // the reader is watching the same scan either way.
    const follow = (job: JobRecord): void => {
      state.scan!.job = job;
      render();
      state.scan!.stop = watchJob(job.id, (update) => {
        if (!state.scan) return;
        state.scan.job = update;
        if (update.status === "done" || update.status === "failed") {
          state.scan.stop?.();
          state.scan.stop = null;
          if (update.status === "failed") state.scan.error = update.error ?? ui.setup.scanFailed;
          else
            void archiveStatus().then((s) => {
              if (!state.scan) return;
              state.scan.photos = s?.totals.photos ?? null;
              state.scan.months = s?.months.length ?? null;
              render();
            });
        }
        render();
      });
    };

    try {
      follow(await startScan({ mode: "incremental" }));
    } catch (err) {
      const health = await checkHealth().catch(() => null);
      if (health?.running) {
        follow(health.running);
        return;
      }
      state.scan.error = (err as Error).message;
      render();
    }
  };

  // --- rendering ----------------------------------------------------------
  const renderPage = (): HTMLElement => {
    const page = el<HTMLDivElement>(`<div class="setup-page"></div>`);
    page.append(
      el(`<div class="setup-head"><h1>${ui.setup.title}</h1><span class="setup-count">${state.step} / 4</span></div>`),
    );
    const card = el(`<div class="setup-card"></div>`);
    page.appendChild(card);
    const foot = el(`<div class="setup-foot"></div>`);
    page.appendChild(foot);

    // The way forward appears only when its condition holds: a greyed button
    // with fine print read as "press me and something will explain", which
    // is what it was. The hint span takes its place until then (laid out
    // left, the button right), and when it does show it is the one
    // highlighted control here — `.set-btn.primary`, the settings page's own
    // accent button.
    const primary = (label: string, onClick: () => void, blocked = false): void => {
      if (blocked) return;
      const b = el<HTMLButtonElement>(`<button type="button" class="set-btn primary setup-primary"></button>`);
      b.textContent = label;
      b.addEventListener("click", onClick);
      foot.appendChild(b);
    };
    const secondary = (label: string, onClick: () => void): void => {
      const b = el<HTMLButtonElement>(`<button type="button" class="set-btn setup-secondary"></button>`);
      b.textContent = label;
      b.addEventListener("click", onClick);
      foot.appendChild(b);
    };

    if (state.step === 1) {
      card.appendChild(el(`<h2>${ui.setup.langTitle}</h2>`));
      const lang = el(`<div class="setup-lang"></div>`);
      for (const [value, label] of [
        ["zh-Hans", "中文"],
        ["en", "English"],
      ] as const) {
        const b = el<HTMLButtonElement>(`<button type="button" class="set-btn"></button>`);
        b.textContent = label;
        if (contentLanguage() === value) b.classList.add("on");
        b.addEventListener("click", () => {
          setContentLanguage(value);
          render();
        });
        lang.appendChild(b);
      }
      card.appendChild(lang);

      card.appendChild(el(`<h2>${ui.setup.signTitle}</h2>`));
      card.appendChild(el(`<p class="set-note">${ui.setup.signNote}</p>`));
      if (state.signedIn) {
        card.appendChild(el(`<p class="setup-ok">✓ ${ui.setup.signedIn}</p>`));
      } else {
        const b = el<HTMLButtonElement>(`<button type="button" class="set-btn"></button>`);
        b.textContent = state.signingIn ? ui.setup.signingIn : ui.setup.signInBtn;
        b.addEventListener("click", () => {
          state.signingIn = true;
          state.saveError = null;
          render();
          void oobeSignIn()
            .then(() => startPoll())
            .catch((err: Error) => {
              // Never a bare swallow: a sign-in that cannot even be requested
              // is the one failure with no other surface (the code only ever
              // appears if the request went through).
              console.error("[setup] sign-in request failed:", err);
              state.signingIn = false;
              state.saveError = err.message;
              render();
            })
            .then(() => refreshOobe());
        });
        card.appendChild(b);
        if (state.saveError) card.appendChild(el(`<p class="set-note tone-warn">${state.saveError}</p>`));
        if (state.deviceCode) {
          const code = el(`<div class="setup-code"></div>`);
          code.appendChild(el(`<p>${ui.setup.codeHint}</p>`));
          const link = el<HTMLAnchorElement>(`<a href="${state.deviceCode.url}" target="_blank" rel="noreferrer"></a>`);
          link.textContent = state.deviceCode.url;
          code.appendChild(link);
          code.appendChild(el(`<code>${state.deviceCode.code}</code>`));
          card.appendChild(code);
        }
      }
      if (!state.signedIn) foot.appendChild(el(`<span class="setup-blocked">${ui.setup.needSignIn}</span>`));
      primary(
        ui.setup.continue,
        () => {
          goto(2);
          stopPoll();
          render();
          void probeFolder(false);
        },
        !state.signedIn,
      );
    } else if (state.step === 2) {
      card.appendChild(el(`<h2>${ui.setup.folderTitle}</h2>`));
      // The status line serves both modes and always names the path it
      // measured: `FolderProbe.path` must match what is on screen, or the
      // line reads "not confirmed yet" — never another folder's answer.
      const statusNode = (): HTMLElement => {
        if (state.probing) return el(`<p class="set-note">${ui.setup.checking}</p>`);
        const active = state.editing ? state.folderText.trim() : state.photosFolder;
        const p = state.probe;
        if (!p || p.path !== active) return el(`<p class="set-note">${ui.setup.unchecked}</p>`);
        if (p.state === "ok") return el(`<p class="setup-ok">✓ ${ui.setup.folderExists(p.count ?? 0, p.months ?? 0)}</p>`);
        if (p.state === "not-found") return el(`<p class="set-note tone-warn">${ui.setup.notFound}</p>`);
        return el(`<p class="set-note tone-warn">${ui.setup.noToken}</p>`);
      };
      if (state.editing) {
        const field = el(`<div class="setup-field"></div>`);
        const input = el<HTMLInputElement>(`<input type="text" class="setup-input"></input>`);
        input.value = state.folderText;
        input.addEventListener("input", () => {
          state.folderText = input.value;
          // Typing retires an answer that no longer describes the text — in
          // place, because a full re-render here would eat the caret.
          if (state.probe && state.probe.path !== input.value.trim()) {
            state.probe = null;
            document.getElementById("setup-status")?.replaceChildren(statusNode());
          }
        });
        field.appendChild(input);
        const save = el<HTMLButtonElement>(`<button type="button" class="set-btn"></button>`);
        save.textContent = ui.setup.check;
        save.addEventListener("click", () => void confirmFolder(state.folderText.trim()));
        field.appendChild(save);
        const browse = el<HTMLButtonElement>(`<button type="button" class="set-btn"></button>`);
        browse.textContent = ui.setup.browse;
        browse.addEventListener("click", () => void openPicker(state.folderText.trim() || ""));
        field.appendChild(browse);
        card.appendChild(field);
        card.appendChild(el(`<p class="set-note">${ui.setup.monthHint}</p>`));
      } else {
        card.appendChild(el(`<p class="setup-path">${state.photosFolder}</p>`));
        const change = el<HTMLButtonElement>(`<button type="button" class="set-btn"></button>`);
        change.textContent = ui.setup.change;
        change.addEventListener("click", () => {
          state.editing = true;
          state.folderText = state.photosFolder;
          render();
        });
        card.appendChild(change);
      }
      const statusHost = el(`<div id="setup-status"></div>`);
      statusHost.appendChild(statusNode());
      card.appendChild(statusHost);
      // An unmeasured folder offers the confirm action where the status
      // sits — checking used to be a mystery keystroke with no visible
      // result in edit mode (and no result at all for a miss).
      if (!state.editing && !state.probing && !folderOk()) {
        const confirm = el<HTMLButtonElement>(`<button type="button" class="set-btn"></button>`);
        confirm.textContent = ui.setup.check;
        confirm.addEventListener("click", () => void confirmFolder(state.photosFolder));
        card.appendChild(confirm);
      }
      if (state.saveError) card.appendChild(el(`<p class="set-note tone-warn">${state.saveError}</p>`));
      if (state.pick) {
        const panel = el(`<div class="setup-picker"></div>`);
        panel.appendChild(el(`<p class="setup-path">${state.pick.path || "/"}</p>`));
        const up = el<HTMLButtonElement>(`<button type="button" class="set-btn"></button>`);
        up.textContent = ui.setup.pickUp;
        up.disabled = !state.pick.path;
        up.addEventListener("click", () => void upOne());
        panel.appendChild(up);
        const list = el(`<div class="setup-pick-list"></div>`);
        if (state.pick.loading) list.appendChild(el(`<p class="set-note">${ui.setup.checking}</p>`));
        else if (state.pick.notFound) list.appendChild(el(`<p class="set-note tone-warn">${ui.setup.notFound}</p>`));
        else if (!state.pick.folders.length) list.appendChild(el(`<p class="set-note">${ui.setup.pickEmpty}</p>`));
        for (const name of state.pick.folders) {
          const row = el(`<div class="setup-pick-row"></div>`);
          const down = el<HTMLButtonElement>(`<button type="button" class="linkish"></button>`);
          down.textContent = name;
          down.addEventListener("click", () => void descend(name));
          row.appendChild(down);
          const pick = el<HTMLButtonElement>(`<button type="button" class="set-btn"></button>`);
          pick.textContent = ui.setup.pickChoose;
          pick.addEventListener("click", () => {
            const path = state.pick?.path ? `${state.pick.path}/${name}` : name;
            state.pick = null;
            void confirmFolder(path);
          });
          row.appendChild(pick);
          list.appendChild(row);
        }
        panel.appendChild(list);
        const close = el<HTMLButtonElement>(`<button type="button" class="set-btn"></button>`);
        close.textContent = ui.setup.pickClose;
        close.addEventListener("click", () => {
          state.pick = null;
          render();
        });
        panel.appendChild(close);
        card.appendChild(panel);
      }
      secondary(ui.setup.back, () => {
        goto(1);
        render();
      });
      if (!folderOk()) foot.appendChild(el(`<span class="setup-blocked">${ui.setup.needFolder}</span>`));
      primary(
        ui.setup.continue,
        () => {
          void (async () => {
            // Green on screen is not agreement: the server re-probes and
            // stamps here, and that stamp is what releases the first scan —
            // until now nothing ever sent `confirm: true`, so the folder was
            // never recorded and the wizard came back on every launch.
            await probeFolder(true);
            if (state.probe?.state === "ok" && state.probe.path === state.photosFolder) {
              goto(3);
              render();
              void loadConfig();
            } else render();
          })();
        },
        !folderOk(),
      );
    } else if (state.step === 3) {
      card.appendChild(el(`<h2>${ui.setup.aiTitle}</h2>`));
      // Why this page exists, before any control: what setting a provider
      // buys (search, the timeline's prose and the album text all read the
      // generated captions and summaries) and what keeps working without it.
      card.appendChild(el(`<p class="set-note">${ui.setup.aiNote}</p>`));
      card.appendChild(el(`<p class="set-note">${ui.setup.aiSend}</p>`));
      const row = el(`<div class="setup-ai"></div>`);
      const select = el<HTMLSelectElement>(`<select id="setup-provider" class="setup-input"></select>`);
      const selected = (): string => state.providerDraft || state.config?.provider || "";
      for (const p of state.config?.providers ?? []) {
        const opt = el<HTMLOptionElement>(`<option value="${p.id}"></option>`);
        opt.textContent = p.label;
        if (p.id === selected()) opt.selected = true;
        select.appendChild(opt);
      }
      select.addEventListener("change", () => {
        // Hold the pick across the re-render the key row needs: the option
        // mark used to point only at the saved provider, so the select
        // snapped back the moment you chose another one.
        state.providerDraft = select.value;
        state.keyDraft = "";
        state.validateFailed = false;
        render();
      });
      row.appendChild(select);
      const picked = (state.config?.providers ?? []).find((p) => p.id === select.value);
      const cloud = picked?.scope !== "local";
      // "Missing" counts a typed key too. The saved-only reading is what the
      // first test ran into: fill a key into a service that has none and
      // Continue never appeared — no way to attempt, let alone fail, a wrong
      // key. Typed or saved lets Continue show; the server then decides
      // whether it is any good, which is the actual validation.
      const keyAvailable = Boolean(picked?.hasKey) || state.keyDraft.trim() !== "";
      const keyMissing = !!state.config && cloud && picked?.editable.apiKey !== false && !keyAvailable;
      const keyStateNode = (): HTMLElement => {
        if (picked?.hasKey) return el(`<p class="set-note">${ui.setup.keySet}</p>`);
        if (state.keyDraft.trim()) return el(`<p class="set-note">${ui.setup.keyTyped}</p>`);
        return el(`<p class="set-note tone-warn">${ui.setup.keyMissing}</p>`);
      };
      if (cloud) {
        const key = el<HTMLInputElement>(`<input type="password" class="setup-input" autocomplete="off"></input>`);
        key.placeholder = ui.setup.aiKeyHint;
        key.value = state.keyDraft;
        key.addEventListener("input", () => {
          state.keyDraft = key.value;
          // The state line follows the box as it fills — in place, so the
          // caret survives (the folder field works the same way).
          document.getElementById("setup-keystate")?.replaceChildren(keyStateNode());
        });
        row.appendChild(key);
      }
      card.appendChild(row);
      // Whether the choice already works — the one thing an empty box cannot
      // tell you (the saved key lives in .env and is never shown).
      if (cloud && state.config) {
        const keyState = el(`<div id="setup-keystate"></div>`);
        keyState.appendChild(keyStateNode());
        card.appendChild(keyState);
        if (picked?.platformUrl) {
          const link = el<HTMLAnchorElement>(`<a class="setup-link" target="_blank" rel="noreferrer"></a>`);
          link.href = picked.platformUrl;
          link.textContent = ui.setup.platformLink;
          card.appendChild(link);
        }
      }
      card.appendChild(el(`<p class="set-note">${ui.setup.aiSkipNote}</p>`));
      if (state.saveError) card.appendChild(el(`<p class="set-note tone-warn">${state.saveError}</p>`));
      secondary(ui.setup.back, () => {
        goto(2);
        render();
      });
      // Skip appears when Continue cannot succeed as-is: nothing has been
      // supplied (its hint says so) or the last attempt was rejected (the
      // red line says why). It is the way out of either — and only then.
      if (keyMissing || state.validateFailed) {
        secondary(ui.setup.skip, () => {
          state.keyDraft = "";
          state.providerDraft = state.config?.provider ?? "";
          state.validateFailed = false;
          goto(4);
          render();
        });
      }
      if (state.config && keyMissing) foot.appendChild(el(`<span class="setup-blocked">${ui.setup.needKey}</span>`));
      primary(
        ui.setup.continue,
        () => void saveGeneration(),
        !state.config || keyMissing,
      );
    } else {
      // Page 4 — the scan owns the screen, per the design.
      card.appendChild(el(`<h2>${ui.setup.scanTitle}</h2>`));
      const scan = state.scan;
      if (!scan) {
        card.appendChild(el(`<p class="set-note">${ui.setup.scanNote}</p>`));
        primary(ui.setup.startScan, () => void startFirstScan());
      } else if (scan.error) {
        card.appendChild(el(`<p class="set-note tone-warn">${scan.error}</p>`));
        primary(ui.setup.retry, () => void startFirstScan());
      } else if (scan.photos !== null) {
        card.appendChild(el(`<p class="setup-done">${ui.setup.scanDone(scan.photos, scan.months ?? 0)}</p>`));
        primary(ui.setup.openArchive, () => exit(opts.onDone));
      } else {
        const job = scan.job;
        const big = el(`<div class="setup-scan"></div>`);
        const phase = job?.progress.phase ?? ui.setup.starting;
        const { done, total } = job?.progress ?? { done: 0, total: 0 };
        big.appendChild(el(`<div class="setup-scan-phase"></div>`)).textContent = `${phase}`;
        const bar = el(`<div class="job-bar"><div class="job-bar-fill"></div></div>`);
        bar.querySelector<HTMLElement>(".job-bar-fill")!.style.width =
          total > 0 ? `${Math.round((done / total) * 100)}%` : "0%";
        big.appendChild(bar);
        big.appendChild(el(`<div class="setup-scan-count"></div>`)).textContent =
          total > 0 ? `${done} / ${total}` : "";
        const tail = (job?.log ?? []).slice(-3).join("\n");
        if (tail) big.appendChild(el(`<pre class="setup-log"></pre>`)).textContent = tail;
        card.appendChild(big);
      }
      secondary(ui.setup.back, () => {
        goto(3);
        render();
      });
    }
    return page;
  };

  const wirePage = (): void => {
    if (state.step === 3 && !state.config) void loadConfig();
  };

  // Boot: one state read paints pages 1–2 correctly (folder value included).
  void refreshOobe().then(() => {
    if (active) render();
  });
}
