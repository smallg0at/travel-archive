import type { ArchiveStatus, ConfigStatus, JobRecord, SyncState, SyncStatus } from "@travel-archive/shared";
import {
  archiveStatus,
  checkHealth,
  getConfig,
  clearCache,
  saveSyncSettings,
  setPin,
  saveConfig,
  startSync,
  startScan,
  syncStatus,
  watchJob,
  type ConflictChoice,
  type ScanMode,
} from "./backend";
import { el } from "./photoUi";
import { renderDensityControl, getCachedIndex, formatMonthLabel } from "./album";
import { resetSidebarWidth } from "./chrome";
import { renderThemeControl } from "./theme";
import { renderContentLanguageControl } from "./contentLang";
import { fmtDate, num, ui } from "./i18n";

/**
 * Settings, as a page rather than a popup.
 *
 * It used to be a 230px floating panel holding two controls, which is no longer
 * anywhere near enough: sync needs a status, a resolver and progress, and
 * "what is kept on this device" needs a list. It renders into `#content` like a
 * trip or a month and is reached from the sidebar, which is also what the
 * burger menu was asked to become.
 *
 * Everything here is read from the server. With no server — the phone — the
 * page says so rather than showing dead controls, since the archive is still
 * perfectly readable without one.
 */

const STATE_LABEL: Record<SyncState, string> = ui.settings.syncState;

/** Green for settled, amber for "something to do", red only for a real decision. */
const STATE_TONE: Record<SyncState, string> = {
  "in-sync": "ok",
  behind: "warn",
  ahead: "warn",
  conflict: "bad",
  "never-synced": "warn",
  offline: "muted",
};

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function relative(iso: string | null): string {
  if (!iso) return ui.settings.never;
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return ui.settings.justNow;
  if (seconds < 3600) return ui.settings.minutesAgo(Math.round(seconds / 60));
  if (seconds < 86400) return ui.settings.hoursAgo(Math.round(seconds / 3600));
  return fmtDate(new Date(iso), {});
}

function section(title: string): HTMLElement {
  const node = el<HTMLElement>(`<section class="set-section"><h3></h3><div class="set-body"></div></section>`);
  node.querySelector("h3")!.textContent = title;
  return node;
}

function row(label: string, value: string): HTMLElement {
  const node = el<HTMLDivElement>(`<div class="set-row"><span></span><b></b></div>`);
  node.querySelector("span")!.textContent = label;
  node.querySelector("b")!.textContent = value;
  return node;
}

/** Rewrites a row built by `row()`, so a refresh does not rebuild the section. */
function setRowValue(node: HTMLElement, value: string): void {
  node.querySelector("b")!.textContent = value;
}

function button(label: string, onClick: () => void, kind = ""): HTMLButtonElement {
  const b = el<HTMLButtonElement>(`<button type="button" class="set-btn ${kind}"></button>`);
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

/**
 * The conflict resolver.
 *
 * Two choices, each named for what it does to the data rather than which side
 * it prefers — "keep local" never says whether the other copy survives, and
 * both of these destroy one copy. Shown with both timestamps so the choice is
 * informed rather than a coin toss.
 */
function conflictBlock(status: SyncStatus, rerun: (r: ConflictChoice) => void): HTMLElement {
  const box = el<HTMLElement>(`
    <div class="set-conflict">
      <p class="set-conflict-lead"></p>
      <div class="set-conflict-sides"></div>
      <div class="set-conflict-actions"></div>
    </div>
  `);
  box.querySelector(".set-conflict-lead")!.textContent = ui.settings.conflictLead;

  const sides = box.querySelector(".set-conflict-sides")!;
  sides.appendChild(row(ui.settings.thisDevice, relative(status.localGeneratedAt)));
  sides.appendChild(row(ui.settings.oneDrive, relative(status.remoteLastModified)));

  const actions = box.querySelector(".set-conflict-actions")!;
  actions.appendChild(button(ui.settings.uploadMine, () => rerun("upload-mine"), "danger"));
  actions.appendChild(button(ui.settings.replaceMine, () => rerun("replace-mine"), "danger"));
  return box;
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Where the page keeps its live state.
 *
 * Settings used to rebuild itself by calling `showSettings()` again after every
 * button press, which meant a full teardown plus both status round trips — the
 * reason a sync button felt like a page load. Sections now register an updater
 * and the page mutates in place; nothing below re-renders `#content`.
 */
const updaters: ((status: SyncStatus) => void)[] = [];
/**
 * Live job subscriptions, dropped when the page is left.
 *
 * Settings is rebuilt on every open — unlike the Generate panel, which is
 * constructed once and moved into the page precisely so a running job survives
 * being navigated away from. Without these the streams would pile up one per
 * visit; without the reattach in `followRunningJob` the progress would vanish
 * the moment you closed Settings during a scan, which is what happened.
 */
const watchers: (() => void)[] = [];

/**
 * Shows a job's progress in `line`, and re-enables `busy` when it ends.
 *
 * Used both for a job this page just started and for one found already running,
 * so a reattached scan looks exactly like one you watched from the beginning.
 */
function followJob(job: JobRecord, line: HTMLElement, busy: HTMLButtonElement | null, onDone: () => void): void {
  line.hidden = false;
  if (busy) busy.disabled = true;
  const stop = watchJob(job.id, (j) => {
    const p = j.progress;
    line.textContent =
      j.status === "running" || j.status === "queued"
        ? `${p.message ?? p.phase}${p.total ? ui.settings.ofTotal(p.done, p.total) : ""}`
        : j.status === "failed"
          ? ui.settings.failed(j.error ?? ui.edit.unknownError)
          : (p.message ?? ui.settings.finished);
    if (j.status !== "running" && j.status !== "queued") {
      stop();
      if (busy) busy.disabled = false;
      onDone();
    }
  });
  watchers.push(stop);
}

/**
 * Reattaches to a job of this kind that is already running.
 *
 * Asked of `/health` rather than remembered locally, so it also finds a job
 * started from the CLI, from another tab, or from an earlier visit to this
 * page — the case that made closing Settings mid-scan lose the progress.
 */
function followRunningJob(kind: JobRecord["kind"], line: HTMLElement, busy: HTMLButtonElement | null, onDone: () => void): void {
  void checkHealth().then((health) => {
    const running = health?.running;
    if (running && running.kind === kind && document.querySelector(".set-section")) {
      followJob(running, line, busy, onDone);
    }
  });
}

/** Separate from the sync updaters: these are fed by `archiveStatus`, not `syncStatus`. */
const archiveUpdaters: ((archive: ArchiveStatus | null) => void)[] = [];
let inFlight = false;

/** Re-reads the library totals. Cheap now that they come from the local mirror. */
async function refreshArchive(): Promise<void> {
  const next = await archiveStatus();
  if (document.querySelector(".set-section")) for (const update of archiveUpdaters) update(next);
}

function applyStatus(status: SyncStatus): void {
  for (const update of updaters) update(status);
}

/**
 * Asks for a checked status and applies it.
 *
 * Guarded against overlap because this is called from the poll, from every
 * button, and once on open: two eTag comparisons in flight would race to write
 * the same labels, and the loser could be the older answer.
 */
async function refreshStatus(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const next = await syncStatus();
    if (next && document.querySelector(".set-section")) applyStatus(next);
  } finally {
    inFlight = false;
  }
}

/** Stops the panel's polling. Called when the view changes. */
export function releaseSettings(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  updaters.length = 0;
  archiveUpdaters.length = 0;
  for (const stop of watchers.splice(0)) stop();
}

export async function showSettings(): Promise<void> {
  const content = document.getElementById("content")!;
  releaseSettings();
  content.replaceChildren(el(`<div class="loading">${ui.settings.loading}</div>`));

  // The cached status costs no Graph call, so the page paints from disk. The
  // checked one is fetched below and swapped in when it lands.
  const [sync, archive] = await Promise.all([syncStatus({ cached: true }), archiveStatus()]);
  const frag = document.createDocumentFragment();
  frag.appendChild(el(`<div class="month-heading"><h1>${ui.nav.settings}</h1><span></span></div>`));

  if (!sync) {
    // No backend. Not an error state: the archive reads from OneDrive and the
    // phone lives here permanently.
    const none = section(ui.settings.localServer);
    none.querySelector(".set-body")!.append(el(`<p class="set-note">${ui.settings.noServer}</p>`));
    frag.appendChild(none);
    content.replaceChildren(frag);
    return;
  }

  frag.appendChild(librarySection(archive));
  frag.appendChild(scanSection(sync));
  frag.appendChild(generationSection());
  frag.appendChild(proxySection());
  frag.appendChild(syncSection(sync));
  frag.appendChild(offlineSection(sync));
  frag.appendChild(storageSection(sync));
  frag.appendChild(appearanceSection());
  // GeoNames is CC BY 4.0, which asks for credit "as suitable for your medium".
  // Natural Earth is public domain and needs none, but naming it costs a line.
  frag.appendChild(el(`<p class="set-credits"></p>`)).textContent = ui.settings.dataCredits;

  content.replaceChildren(frag);

  void refreshStatus();

  // The status changes underneath while a sync runs; a page showing "Behind"
  // after it finished would be worse than no page.
  refreshTimer = setInterval(() => {
    if (!document.querySelector(".set-section")) return releaseSettings();
    void refreshStatus();
  }, 5000);
}

function applyState(node: HTMLElement, status: SyncStatus): void {
  node.textContent = STATE_LABEL[status.state];
  node.className = `set-sync-state tone-${STATE_TONE[status.state]}`;
}

function librarySection(archive: ArchiveStatus | null): HTMLElement {
  const s = section(ui.settings.library);
  const body = s.querySelector(".set-body")!;
  const note = el<HTMLParagraphElement>(`<p class="set-note">${ui.settings.notSignedIn}</p>`);
  const rows = {
    photos: row(ui.settings.photos, ""),
    analyzed: row(ui.settings.analyzed, ""),
    days: row(ui.settings.days, ""),
    sections: row(ui.settings.sections, ""),
    schema: row(ui.settings.schema, ""),
  };
  body.append(note, ...Object.values(rows));

  const update = (next: ArchiveStatus | null) => {
    const signedIn = Boolean(next?.signedIn);
    note.hidden = signedIn;
    for (const r of Object.values(rows)) r.hidden = !signedIn;
    if (!next?.signedIn) return;
    setRowValue(rows.photos, num(next.totals.photos));
    setRowValue(rows.analyzed, num(next.totals.analyzed));
    setRowValue(rows.days, num(next.totals.days));
    setRowValue(rows.sections, num(next.totals.sections));
    setRowValue(rows.schema, `v${next.schemaVersion}`);
  };
  update(archive);
  archiveUpdaters.push(update);
  return s;
}

/**
 * Re-indexing the library.
 *
 * Lives here rather than on Generate because it is maintenance, not
 * generation: it costs nothing, spends no tokens, and is the thing you run
 * routinely. Generate is for the passes that cost money.
 */
function scanSection(status: SyncStatus): HTMLElement {
  const s = section(ui.settings.scan);
  const body = s.querySelector(".set-body")!;

  const lastScan = row(ui.settings.lastScanned, relative(status.lastScanAt));
  body.appendChild(lastScan);

  const modeRow = el<HTMLDivElement>(`<div class="set-row"><span>${ui.settings.whatToScan}</span></div>`);
  const mode = el<HTMLSelectElement>(`
    <select class="set-select">
      <option value="incremental">${ui.settings.scanModes.incremental}</option>
      <option value="full">${ui.settings.scanModes.full}</option>
      <option value="range">${ui.settings.scanModes.range}</option>
    </select>
  `);
  modeRow.appendChild(mode);
  body.appendChild(modeRow);

  const range = el<HTMLDivElement>(`
    <div class="set-scan-range" hidden>
      <label class="set-scan-field"><span>${ui.common.from}</span><input type="month" name="from" /></label>
      <label class="set-scan-field"><span>${ui.common.to}</span><input type="month" name="to" /></label>
    </div>
  `);
  body.appendChild(range);

  const note = el<HTMLParagraphElement>(`<p class="set-note"></p>`);
  body.appendChild(note);

  // Said plainly because it is the one surprise in how scanning works: a run
  // only reaps photos deleted from OneDrive inside the folders it listed, so
  // an incremental run leaves deletions in older months in place.
  const NOTES: Record<string, string> = ui.settings.scanNotes;
  const applyMode = () => {
    range.hidden = mode.value !== "range";
    note.textContent = NOTES[mode.value] ?? "";
  };
  mode.addEventListener("change", applyMode);
  applyMode();

  const progress = el<HTMLDivElement>(`<div class="set-progress" hidden></div>`);

  // Both change when a scan ends: the totals come from the index it rewrote,
  // and `lastScanAt` is what the next incremental run starts from.
  const afterScan = () => {
    void refreshArchive();
    void refreshStatus();
  };

  const run = button(
    ui.settings.scanNow,
    () => {
      const from = range.querySelector<HTMLInputElement>('input[name="from"]')!.value.trim();
      const to = range.querySelector<HTMLInputElement>('input[name="to"]')!.value.trim();
      progress.hidden = false;
      progress.textContent = ui.common.starting;
      run.disabled = true;
      void startScan({
        mode: mode.value as ScanMode,
        ...(mode.value === "range" && from ? { from } : {}),
        ...(mode.value === "range" && to ? { to } : {}),
      })
        .then((job) => followJob(job, progress, run, afterScan))
        .catch((err: Error) => {
          progress.textContent = err.message;
          run.disabled = false;
        });
    },
    "primary",
  );

  // A scan takes minutes over a whole library, so it long outlives a visit to
  // this page. Closing Settings and reopening it used to show an idle button
  // with the scan still running underneath.
  followRunningJob("scan", progress, run, afterScan);

  const actions = el<HTMLDivElement>(`<div class="set-actions"></div>`);
  actions.appendChild(run);
  body.appendChild(actions);
  body.appendChild(progress);

  updaters.push((next) => setRowValue(lastScan, relative(next.lastScanAt)));
  return s;
}

/**
 * Configuring generation, which used to mean being told to write a `.env` by
 * hand.
 *
 * The old missing-config dialog could not say what was already correct, and
 * pointed at a file in a directory most people would never otherwise open. It
 * only ever appeared on a packaged install, and a packaged install carries
 * every non-secret setting baked in — so the one thing genuinely missing there
 * is the AI provider's key, which is what this asks for.
 *
 * **The key is write-only.** The server reports whether one is set and never
 * returns it, so this shows "saved" rather than a value.
 */
function generationSection(): HTMLElement {
  const s = section(ui.settings.generation);
  const body = s.querySelector(".set-body")!;

  const state = el<HTMLElement>(`<div class="set-sync-state"></div>`);
  body.appendChild(state);

  const keyField = el<HTMLLabelElement>(`
    <label class="set-scan-field set-key-field">
      <span>${ui.settings.apiKey}</span>
      <input type="password" name="key" autocomplete="off" spellcheck="false" />
    </label>
  `);
  const key = keyField.querySelector("input") as HTMLInputElement;
  body.appendChild(keyField);

  const note = el<HTMLParagraphElement>(`<p class="set-note"></p>`);
  const warning = el<HTMLParagraphElement>(`<p class="set-note tone-warn" hidden></p>`);
  body.append(note, warning);

  const status = el<HTMLDivElement>(`<div class="set-progress" hidden></div>`);
  const save = button(
    ui.common.save,
    () => {
      const value = key.value.trim();
      const patch: Record<string, string> = { AI_PROVIDER: "gemini" };
      if (value) patch.GEMINI_API_KEY = value;
      status.hidden = false;
      status.textContent = ui.common.saving;
      save.disabled = true;
      void saveConfig(patch)
        .then((next) => {
          // Cleared on success so a key is never left sitting in the DOM.
          key.value = "";
          status.textContent = next.ready ? ui.settings.savedReady : ui.settings.saved;
          apply(next);
        })
        .catch((err: Error) => (status.textContent = err.message))
        .finally(() => (save.disabled = false));
    },
    "primary",
  );

  const actions = el<HTMLDivElement>(`<div class="set-actions"></div>`);
  actions.appendChild(save);
  body.append(actions, status);

  /**
   * The last status from the server. Kept so the display can be recomputed
   * when the *selection* changes without asking again.
   */
  let latest: ConfigStatus | null = null;

  /**
   * Gemini is the only provider, so this reports the *configured* one rather
   * than a selection. It used to key on a provider dropdown, which was wrong
   * in a way that lied: a provider with no key still read "Ready" because the
   * configured one had one.
   */
  const render = () => {
    if (!latest) {
      state.textContent = ui.settings.unavailable;
      state.className = "set-sync-state tone-muted";
      return;
    }
    const hasKey = latest.keys.gemini;
    const ready = hasKey && latest.provider === "gemini";

    state.textContent = hasKey
      ? latest.provider === "gemini"
        ? ui.settings.ready
        : ui.settings.readyOnceSaved
      : ui.settings.noKey;
    state.className = `set-sync-state tone-${ready ? "ok" : "warn"}`;

    key.placeholder = hasKey ? ui.settings.keySaved : ui.settings.keyPaste;
    note.textContent = ui.settings.keyNote(latest.path);

    // dotenv never overrides a real environment variable, so a key saved here
    // would work until the next restart and then quietly lose to the machine's
    // own setting. Better said than discovered.
    const shadowed = latest.shadowed.includes("GEMINI_API_KEY");
    warning.hidden = !shadowed;
    if (shadowed) {
      warning.textContent = ui.settings.shadowed("GEMINI_API_KEY");
    }
  };

  const apply = (config: ConfigStatus | null) => {
    latest = config;
    render();
  };

  apply(null);
  void getConfig().then(apply);
  return s;
}

function proxySection(): HTMLElement {
  const s = section(ui.settings.proxy);
  const body = s.querySelector(".set-body")!;

  const state = el<HTMLElement>(`<div class="set-sync-state"></div>`);
  body.appendChild(state);

  const sysRow = el<HTMLDivElement>(`
    <div class="set-row">
      <label class="set-check">
        <input type="checkbox" name="proxy-system" />
        <span>${ui.settings.proxySystem}</span>
      </label>
      <span class="set-proxy-detected"></span>
    </div>
  `);
  const sysCheck = sysRow.querySelector<HTMLInputElement>('input[name="proxy-system"]')!;
  const detectedLabel = sysRow.querySelector<HTMLSpanElement>(".set-proxy-detected")!;
  body.appendChild(sysRow);

  const aiRow = el<HTMLDivElement>(`<div class="set-row"><span>${ui.settings.proxyAi}</span></div>`);
  const aiMode = el<HTMLSelectElement>(`
    <select class="set-select">
      <option value="system">${ui.settings.proxyModes.system}</option>
      <option value="direct">${ui.settings.proxyModes.direct}</option>
      <option value="custom">${ui.settings.proxyModes.custom}</option>
    </select>
  `);
  aiRow.appendChild(aiMode);
  body.appendChild(aiRow);

  const aiUrlField = el<HTMLLabelElement>(`
    <label class="set-scan-field set-key-field" hidden>
      <span>URL</span>
      <input type="text" name="ai-url" placeholder="${ui.settings.proxyCustomPlaceholder}" spellcheck="false" autocomplete="off" />
    </label>
  `);
  const aiUrlInput = aiUrlField.querySelector<HTMLInputElement>('input[name="ai-url"]')!;
  body.appendChild(aiUrlField);

  const graphRow = el<HTMLDivElement>(`<div class="set-row"><span>${ui.settings.proxyGraph}</span></div>`);
  const graphMode = el<HTMLSelectElement>(`
    <select class="set-select">
      <option value="direct">${ui.settings.proxyModes.direct}</option>
      <option value="system">${ui.settings.proxyModes.system}</option>
      <option value="custom">${ui.settings.proxyModes.custom}</option>
    </select>
  `);
  graphRow.appendChild(graphMode);
  body.appendChild(graphRow);

  const graphUrlField = el<HTMLLabelElement>(`
    <label class="set-scan-field set-key-field" hidden>
      <span>URL</span>
      <input type="text" name="graph-url" placeholder="${ui.settings.proxyCustomPlaceholder}" spellcheck="false" autocomplete="off" />
    </label>
  `);
  const graphUrlInput = graphUrlField.querySelector<HTMLInputElement>('input[name="graph-url"]')!;
  body.appendChild(graphUrlField);

  const note = el<HTMLParagraphElement>(`<p class="set-note">${ui.settings.proxyNote}</p>`);
  body.appendChild(note);

  const status = el<HTMLDivElement>(`<div class="set-progress" hidden></div>`);

  const save = button(
    ui.common.save,
    () => {
      status.hidden = false;
      status.textContent = ui.common.saving;
      save.disabled = true;

      const patch: Record<string, string> = {
        PROXY_SYSTEM_ENABLED: sysCheck.checked ? "true" : "false",
        PROXY_AI_MODE: aiMode.value,
        PROXY_AI_URL: aiUrlInput.value.trim(),
        PROXY_GRAPH_MODE: graphMode.value,
        PROXY_GRAPH_URL: graphUrlInput.value.trim(),
      };

      void saveConfig(patch)
        .then((next) => {
          status.textContent = ui.settings.proxySaved;
          apply(next);
        })
        .catch((err: Error) => (status.textContent = err.message))
        .finally(() => (save.disabled = false));
    },
    "primary",
  );

  const actions = el<HTMLDivElement>(`<div class="set-actions"></div>`);
  actions.appendChild(save);
  body.append(actions, status);

  const apply = (config: ConfigStatus | null) => {
    if (!config?.proxy) {
      state.textContent = ui.settings.unavailable;
      state.className = "set-sync-state tone-muted";
      return;
    }
    const p = config.proxy;
    sysCheck.checked = p.systemEnabled;
    detectedLabel.textContent = p.systemDetected
      ? ui.settings.proxySystemDetected(p.systemDetected)
      : ui.settings.proxySystemNone;

    aiMode.value = p.aiMode;
    aiUrlInput.value = p.aiUrl ?? "";
    aiUrlField.hidden = p.aiMode !== "custom";

    graphMode.value = p.graphMode;
    graphUrlInput.value = p.graphUrl ?? "";
    graphUrlField.hidden = p.graphMode !== "custom";

    if ((p.systemEnabled && p.systemDetected) || p.aiMode === "custom" || p.graphMode === "custom") {
      state.textContent = ui.settings.ready;
      state.className = "set-sync-state tone-ok";
    } else {
      state.textContent = ui.settings.proxyModes.direct;
      state.className = "set-sync-state tone-muted";
    }
  };

  aiMode.addEventListener("change", () => {
    aiUrlField.hidden = aiMode.value !== "custom";
  });
  graphMode.addEventListener("change", () => {
    graphUrlField.hidden = graphMode.value !== "custom";
  });

  apply(null);
  void getConfig().then(apply);
  return s;
}

function syncSection(status: SyncStatus): HTMLElement {
  const s = section(ui.settings.sync);
  const body = s.querySelector(".set-body")!;

  const state = el<HTMLElement>(`<div class="set-sync-state"></div>`);
  applyState(state, status);
  body.appendChild(state);

  // A stale answer is labelled rather than silently presented as current: it is
  // the last state measured, not one just confirmed against OneDrive.
  const checking = el<HTMLParagraphElement>(`<p class="set-note">${ui.settings.checkingOneDrive}</p>`);
  checking.hidden = !status.stale;
  body.appendChild(checking);

  const checked = row(ui.settings.lastChecked, relative(status.checkedAt));
  const synced = row(ui.settings.lastSynced, relative(status.syncedAt));
  body.appendChild(checked);
  body.appendChild(synced);

  const progress = el<HTMLDivElement>(`<div class="set-progress" hidden></div>`);

  const actions = el<HTMLDivElement>(`<div class="set-actions"></div>`);
  const conflictHost = el<HTMLDivElement>(`<div class="set-conflict-host"></div>`);

  // Update in place. This used to call `showSettings()`, which tore the page
  // down and paid for both status round trips again.
  const afterSync = () => void refreshStatus();

  const run = (resolve?: ConflictChoice) => {
    progress.hidden = false;
    progress.textContent = ui.common.starting;
    void startSync(resolve ? { resolve } : {})
      .then((job) => followJob(job, progress, null, afterSync))
      .catch((err: Error) => (progress.textContent = err.message));
  };

  // Same reattach as the scan section: a sync outlives a visit to this page.
  followRunningJob("sync", progress, null, afterSync);

  actions.appendChild(button(ui.settings.checkNow, () => void refreshStatus(), ""));
  const syncNow = button(ui.settings.syncNow, () => run(), "primary");
  body.appendChild(actions);
  body.appendChild(conflictHost);
  body.appendChild(progress);

  /** Everything on this section that a fresh status can change. */
  const update = (next: SyncStatus) => {
    applyState(state, next);
    checking.hidden = !next.stale;
    setRowValue(checked, relative(next.checkedAt));
    setRowValue(synced, relative(next.syncedAt));

    // "Sync now" is meaningless in a conflict — the user has to choose a side
    // first — so the resolver replaces it rather than sitting beside it.
    const conflict = next.state === "conflict";
    if (conflict && !conflictHost.firstChild) conflictHost.appendChild(conflictBlock(next, run));
    if (!conflict) conflictHost.replaceChildren();
    if (conflict) syncNow.remove();
    else if (!syncNow.isConnected) actions.appendChild(syncNow);
  };
  updaters.push(update);

  update(status);
  return s;
}

function offlineSection(status: SyncStatus): HTMLElement {
  const s = section(ui.settings.kept);
  const body = s.querySelector(".set-body")!;
  const list = el<HTMLDivElement>(`<div class="set-pins"></div>`);
  body.appendChild(list);

  const renderPins = (pins: SyncStatus["pins"]) => {
    if (pins.length === 0) {
      list.replaceChildren(el(`<p class="set-note">${ui.settings.nothingPinned}</p>`));
      return;
    }
    const rows = pins.map((pin) => {
      const r = el<HTMLDivElement>(`<div class="set-row set-pin"><span></span></div>`);
      // A pin's own record only carries the id it was made against — a trip
      // slug or a yyyy-mm month — because that is all a pin needs to function.
      // The reader never asked to see that slug, though; it's an internal
      // identifier; this resolves it back to what they actually recognize.
      const label =
        pin.kind === "trip"
          ? (getCachedIndex()?.sections.find((s) => s.id === pin.id)?.name ?? pin.id)
          : formatMonthLabel(pin.id);
      r.querySelector("span")!.textContent =
        `${pin.kind === "trip" ? ui.settings.pinTrip : ui.settings.pinMonth} · ${label}${pin.originals ? ` · ${ui.settings.withOriginals}` : ""}`;
      // The server always took `originals`; nothing in the app could set it.
      // This records the choice — the next sync fetches or drops the files.
      r.appendChild(
        button(pin.originals ? ui.settings.thumbnailsOnly : ui.settings.includeOriginals, () => {
          void setPin({ ...pin, originals: !pin.originals, pinned: true }).then((res) => renderPins(res.pins));
        }),
      );
      r.appendChild(
        button(ui.settings.unpin, () => {
          // The server answers with the new pin list, so the section can be
          // rebuilt from that alone rather than reloading the whole page.
          void setPin({ ...pin, pinned: false }).then((res) => renderPins(res.pins));
        }),
      );
      return r;
    });
    list.replaceChildren(...rows);
  };

  renderPins(status.pins);
  updaters.push((next) => renderPins(next.pins));

  const auto = el<HTMLLabelElement>(
    `<label class="set-check"><input type="checkbox"><span>${ui.settings.autoCheck}</span></label>`,
  );
  const box = auto.querySelector("input") as HTMLInputElement;
  // The stored value. It was hard-coded to checked, so unticking it looked
  // undone on the next visit; `settings` is absent from an older server.
  box.checked = status.settings?.autoSyncOnLaunch ?? true;
  box.addEventListener("change", () => void saveSyncSettings({ autoSyncOnLaunch: box.checked }));
  body.appendChild(auto);

  const every = el<HTMLDivElement>(`<div class="set-row"><span>${ui.settings.checkEvery}</span></div>`);
  const pick = document.createElement("select");
  pick.className = "set-select";
  for (const minutes of [0, 15, 60, 360]) {
    const option = document.createElement("option");
    option.value = String(minutes);
    option.textContent = ui.settings.interval(minutes);
    pick.appendChild(option);
  }
  pick.value = String(status.settings?.intervalMinutes ?? 0);
  pick.addEventListener("change", () => void saveSyncSettings({ intervalMinutes: Number(pick.value) }));
  every.appendChild(pick);
  body.appendChild(every);
  return s;
}

function appearanceSection(): HTMLElement {
  const s = section(ui.settings.appearance);
  const body = s.querySelector(".set-body")!;

  const theme = el<HTMLDivElement>(`<div class="set-row"><span>${ui.theme.label}</span></div>`);
  theme.appendChild(renderThemeControl());
  body.appendChild(theme);

  const density = el<HTMLDivElement>(`<div class="set-row"><span>${ui.album.thumbnailSize}</span></div>`);
  density.appendChild(renderDensityControl());
  body.appendChild(density);

  // One setting for the interface and the archive's own text — captions, day
  // pages, trips. That text needs translating from Generate first; anything
  // without a translation shows as written.
  const language = el<HTMLDivElement>(`<div class="set-row"><span>${ui.language.label}</span></div>`);
  language.appendChild(renderContentLanguageControl(ui.language.label));
  body.appendChild(language);

  const sidebar = el<HTMLDivElement>(`<div class="set-row"><span>${ui.settings.sidebarWidth}</span></div>`);
  sidebar.appendChild(button(ui.common.reset, resetSidebarWidth));
  body.appendChild(sidebar);
  return s;
}

function storageSection(status: SyncStatus): HTMLElement {
  const s = section(ui.settings.storage);
  const body = s.querySelector(".set-body")!;

  const files = ui.settings.files;
  const metadata = row(ui.settings.metadata, "");
  const thumbs = row(ui.settings.thumbnails, "");
  const originals = row(ui.settings.originals, "");
  const total = row(ui.settings.total, "");
  body.append(metadata, thumbs, originals, total);

  const update = (next: SyncStatus) => {
    const st = next.storage;
    setRowValue(metadata, mb(st.metadataBytes));
    setRowValue(thumbs, `${files(st.thumbnails.count)} · ${mb(st.thumbnails.bytes)}`);
    setRowValue(originals, `${files(st.originals.count)} · ${mb(st.originals.bytes)}`);
    setRowValue(total, mb(st.metadataBytes + st.thumbnails.bytes + st.originals.bytes));
  };
  update(status);
  updaters.push(update);

  const actions = el<HTMLDivElement>(`<div class="set-actions"></div>`);
  // Pinned files survive: clearing a cache must not silently undo "keep this".
  for (const [label, category] of [
    [ui.settings.clearThumbnails, "thumbnails"],
    [ui.settings.clearOriginals, "originals"],
  ] as const) {
    actions.appendChild(
      button(label, () => {
        void clearCache(category).then(() => refreshStatus());
      }),
    );
  }
  body.appendChild(actions);
  body.appendChild(
    el(`<p class="set-note">${ui.settings.storageNote}</p>`),
  );
  return s;
}
