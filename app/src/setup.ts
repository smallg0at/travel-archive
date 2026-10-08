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
    saveError: null,
    scan: null,
  };
}

/**
 * Whether this machine is looking at a fresh archive.
 *
 * Server-computed (`neverScanned`), gated on write capability — a remote
 * reader has no route to any of this — and absent-on-error: a reader that
 * cannot ask should get the app it already knows, not a wizard nobody can
 * complete.
 */
export async function setupNeeded(): Promise<boolean> {
  try {
    if (!canWrite()) return false;
    const s = await oobeState();
    return !!s && s.neverScanned && !s.photosFolderValidatedAt;
  } catch {
    return false;
  }
}

/** Runs the wizard. `onDone`/`onSkip` both land back in the normal app. */
export function showSetup(opts: { onDone: () => void; onSkip: () => void }): void {
  if (active) return;
  active = true;
  state = fresh();
  document.body.classList.add("setup-active");

  const content = document.getElementById("content")!;
  content.replaceChildren(el(`<div class="loading">${ui.setup.loading}</div>`));

  const exit = (next: () => void) => {
    stopPoll();
    state.scan?.stop?.();
    active = false;
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
    state.photosFolder = s.photosFolder;
    const after = `${state.signedIn}${state.deviceCode?.code ?? ""}`;
    if (before !== after) render();
    if (s.signedIn) stopPoll();
  };
  const startPoll = (): void => {
    if (poll !== null) return;
    poll = window.setInterval(() => void refreshOobe(), 2000);
  };

  // --- page 2 -------------------------------------------------------------
  const probeFolder = async (confirm: boolean): Promise<void> => {
    state.probing = true;
    state.saveError = null;
    render();
    state.probe = await oobeFolder(confirm);
    state.probing = false;
    if (state.probe?.state === "ok") state.editing = false;
    render();
  };

  const saveFolderPath = async (path: string): Promise<void> => {
    state.saveError = null;
    try {
      await saveConfig({ ONEDRIVE_PHOTOS_FOLDER: path });
      state.folderText = path;
      await probeFolder(false);
    } catch (err) {
      state.saveError = (err as Error).message;
      render();
    }
  };

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
    if (path) await saveFolderPath(path);
    else render();
  };

  // --- page 3 -------------------------------------------------------------
  const loadConfig = async (): Promise<void> => {
    if (state.config) return;
    state.config = await getConfig();
    render();
  };

  const saveGeneration = async (): Promise<void> => {
    state.saveError = null;
    try {
      const cfg = state.config;
      const select = document.getElementById("setup-provider") as HTMLSelectElement | null;
      const provider = select?.value || cfg?.provider;
      const patch: Record<string, string> = {};
      if (provider) patch.AI_PROVIDER = provider;
      const key = state.keyDraft.trim();
      if (key && provider) patch[`${provider.toUpperCase()}_API_KEY`] = key;
      if (Object.keys(patch).length) await saveConfig(patch);
      state.keyDraft = "";
      state.step = 4;
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

    const primary = (label: string, onClick: () => void, disabled = false): void => {
      const b = el<HTMLButtonElement>(`<button type="button" class="set-btn setup-primary"></button>`);
      b.textContent = label;
      b.disabled = disabled;
      b.addEventListener("click", onClick);
      foot.appendChild(b);
    };
    const secondary = (label: string, onClick: () => void): void => {
      const b = el<HTMLButtonElement>(`<button type="button" class="set-btn setup-secondary"></button>`);
      b.textContent = label;
      b.addEventListener("click", onClick);
      foot.appendChild(b);
    };
    const later = (): void => {
      const a = el<HTMLAnchorElement>(`<a href="#" class="setup-later"></a>`);
      a.textContent = ui.setup.later;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        exit(opts.onSkip);
      });
      foot.appendChild(a);
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
      primary(ui.setup.continue, () => {
        state.step = 2;
        stopPoll();
        render();
        void probeFolder(false);
      }, !state.signedIn);
      foot.appendChild(el(`<span class="setup-blocked">${state.signedIn ? "" : ui.setup.needSignIn}</span>`));
      later();
    } else if (state.step === 2) {
      card.appendChild(el(`<h2>${ui.setup.folderTitle}</h2>`));
      if (state.editing) {
        const field = el(`<div class="setup-field"></div>`);
        const input = el<HTMLInputElement>(`<input type="text" class="setup-input"></input>`);
        input.value = state.folderText;
        input.addEventListener("input", () => (state.folderText = input.value));
        field.appendChild(input);
        const save = el<HTMLButtonElement>(`<button type="button" class="set-btn"></button>`);
        save.textContent = ui.setup.check;
        save.addEventListener("click", () => void saveFolderPath(state.folderText.trim()));
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
        if (state.probing) card.appendChild(el(`<p class="set-note">${ui.setup.checking}</p>`));
        else if (state.probe?.state === "ok")
          card.appendChild(el(`<p class="setup-ok">✓ ${ui.setup.folderExists(state.probe.count ?? 0, state.probe.months ?? 0)}</p>`));
        else if (state.probe?.state === "not-found")
          card.appendChild(el(`<p class="set-note tone-warn">${ui.setup.notFound}</p>`));
        else if (state.probe?.state === "no-token")
          card.appendChild(el(`<p class="set-note tone-warn">${ui.setup.noToken}</p>`));
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
            void saveFolderPath(path);
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
      primary(
        ui.setup.continue,
        () => {
          state.step = 3;
          render();
          void loadConfig();
        },
        state.probe?.state !== "ok" || state.probing,
      );
      foot.appendChild(
        el(`<span class="setup-blocked">${state.probe?.state === "ok" ? "" : ui.setup.needFolder}</span>`),
      );
      secondary(ui.setup.back, () => {
        state.step = 1;
        render();
      });
      later();
    } else if (state.step === 3) {
      card.appendChild(el(`<h2>${ui.setup.aiTitle}</h2>`));
      card.appendChild(el(`<p class="set-note">${ui.setup.aiNote}</p>`));
      const row = el(`<div class="setup-ai"></div>`);
      const select = el<HTMLSelectElement>(`<select id="setup-provider" class="setup-input"></select>`);
      for (const p of state.config?.providers ?? []) {
        const opt = el<HTMLOptionElement>(`<option value="${p.id}"></option>`);
        opt.textContent = p.label;
        if (p.id === state.config?.provider) opt.selected = true;
        select.appendChild(opt);
      }
      select.addEventListener("change", () => {
        state.keyDraft = "";
        render();
      });
      row.appendChild(select);
      const cloud = (state.config?.providers ?? []).find((p) => p.id === select.value)?.scope !== "local";
      if (cloud) {
        const key = el<HTMLInputElement>(`<input type="password" class="setup-input" autocomplete="off"></input>`);
        key.placeholder = ui.setup.aiKeyHint;
        key.value = state.keyDraft;
        key.addEventListener("input", () => (state.keyDraft = key.value));
        row.appendChild(key);
      }
      card.appendChild(row);
      if (state.saveError) card.appendChild(el(`<p class="set-note tone-warn">${state.saveError}</p>`));
      secondary(ui.setup.skip, () => {
        state.step = 4;
        render();
      });
      primary(ui.setup.continue, () => void saveGeneration(), !state.config);
      later();
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
        state.step = 3;
        render();
      });
      later();
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
