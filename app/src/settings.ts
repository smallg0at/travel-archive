import type {
  ArchiveStatus,
  AutostartStatus,
  ConfigStatus,
  JobRecord,
  ProviderOption,
  RemoteAccessStatus,
  SyncState,
  SyncStatus,
} from "@travel-archive/shared";
import {
  archiveStatus,
  autostartStatus,
  canWrite,
  checkHealth,
  getConfig,
  clearCache,
  remoteAccessStatus,
  restartServer,
  saveSyncSettings,
  setAutostart,
  setRemoteAccess,
  setPin,
  saveConfig,
  startSync,
  startScan,
  syncStatus,
  validateGeneration,
  watchJob,
  type ConflictChoice,
  type ScanMode,
} from "./backend";
import { el } from "./photoUi";
import { createFolderPanel } from "./photoFolder";
import { renderDensityControl, getCachedIndex, formatMonthLabel } from "./album";
import { resetSidebarWidth } from "./chrome";
import { renderThemeControl } from "./theme";
import { renderContentLanguageControl } from "./contentLang";
import { fmtDate, jobPhase, num, ui } from "./i18n";

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

/** Read at use rather than captured here: the language can still be applied in place while the app starts. */
const stateLabel = (state: SyncState): string => ui.settings.syncState[state];

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

/**
 * A row whose value is a file path. Machine text, so it wears `.is-path`
 * instead of the row's headline style: mono, muted, capped and ellipsised at
 * the tail — the head is the part that differs between archive homes, so it
 * is what survives truncation — with the whole line on hover for copying.
 */
function setPathValue(node: HTMLElement, value: string): void {
  setRowValue(node, value);
  node.classList.add("is-path");
  node.querySelector("b")!.title = value;
}

function button(label: string, onClick: () => void, kind = ""): HTMLButtonElement {
  const b = el<HTMLButtonElement>(`<button type="button" class="set-btn ${kind}"></button>`);
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

/** A labelled input, for the provider rows. */
function labelledInput(label: string, control: string): HTMLLabelElement {
  const node = el<HTMLLabelElement>(`<label class="set-scan-field"><span></span></label>`);
  node.querySelector("span")!.textContent = label;
  node.insertAdjacentHTML("beforeend", control);
  return node;
}

/**
 * A provider's name in the reader's language.
 *
 * The server sends a `label` with every option and it is the fallback, so a
 * backend added to `PRESETS` before its name is translated still renders. The
 * map is keyed by the preset `id`, which is stable, not by the label, which is
 * prose that may change.
 */
function providerName(option: ProviderOption): string {
  return (ui.settings.providers as Record<string, string>)[option.id] ?? option.label;
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
        ? `${jobPhase(p.phase)}${p.total ? ui.settings.ofTotal(p.done, p.total) : ""}`
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

  const writable = canWrite();
  frag.appendChild(librarySection(archive));
  // The rest is this machine's: scanning and syncing the archive, running
  // jobs, the proxy and storage behind them. A remote reader is shown only the
  // archive it is reading and how this window looks — the server would refuse
  // every control in these sections anyway.
  if (writable) {
    frag.appendChild(photosFolderSection());
    frag.appendChild(scanSection(sync));
    frag.appendChild(backgroundSection());
    frag.appendChild(remoteSection());
    frag.appendChild(generationSection());
    frag.appendChild(proxySection());
    frag.appendChild(syncSection(sync));
    frag.appendChild(offlineSection(sync));
    frag.appendChild(storageSection(sync));
  }
  frag.appendChild(appearanceSection(writable));
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
  node.textContent = stateLabel(status.state);
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
 * Which photos folder this archive reads.
 *
 * The wizard asked once, then the field vanished: after setup there was no
 * way to point the archive at a different folder at all (the write was
 * whitelisted, the picker existed — Settings simply never mounted either).
 * This is the same panel the wizard used, so probe-before-write and the
 * path-keyed status cannot fork between the two surfaces.
 */
function photosFolderSection(): HTMLElement {
  const s = section(ui.setup.folderTitle);
  const body = s.querySelector(".set-body")!;
  body.appendChild(createFolderPanel("").root);
  body.appendChild(el<HTMLParagraphElement>(`<p class="set-note">${ui.settings.photosFolderNote}</p>`));
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
/** A titled container the provider rows are grouped into (by `scope`). */
function providerGroup(title: string): HTMLDivElement {
  const root = el<HTMLDivElement>(`<div class="set-provider-group"></div>`);
  const heading = el<HTMLHeadingElement>(`<h3 class="set-provider-group-title"></h3>`);
  heading.textContent = title;
  root.append(heading);
  return root;
}

function generationSection(): HTMLElement {
  const s = section(ui.settings.generation);
  const body = s.querySelector(".set-body")!;

  const state = el<HTMLElement>(`<div class="set-sync-state"></div>`);
  body.appendChild(state);

  const intro = el<HTMLParagraphElement>(`<p class="set-note"></p>`);
  intro.textContent = ui.settings.providerTableNote;
  body.appendChild(intro);

  /**
   * One collapsible row per backend, grouped by where it runs and built once,
   * then updated in place.
   *
   * This used to be every backend's full form, always open — nine blocks of
   * endpoint, model and key, which buried the choice it was asking for and left
   * a local service, which needs no key and never leaves the machine,
   * indistinguishable from the ones that call out. A row is now a header (name,
   * whether it is in force, whether it has a key) that opens in place to its
   * fields; only one is open at a time. The group is the `scope` the server
   * reports, not a guess from the id. Keeping the inputs mounted means one save
   * can repaint the others without the reader losing half-typed text.
   */
  interface Row {
    id: string;
    scope: "local" | "cloud";
    root: HTMLDivElement;
    head: HTMLButtonElement;
    panel: HTMLDivElement;
    keyInput: HTMLInputElement;
    note: HTMLElement;
    summary: HTMLElement;
    badge: HTMLElement;
    button: HTMLButtonElement;
    expanded: boolean;
    paint: (option: ProviderOption, active: boolean) => void;
  }
  const rows: Row[] = [];

  const groups = {
    local: providerGroup(ui.settings.providersLocal),
    cloud: providerGroup(ui.settings.providersCloud),
  };
  body.append(groups.local, groups.cloud);

  let openRow: Row | null = null;
  const setExpanded = (row: Row, expand: boolean) => {
    row.expanded = expand;
    row.panel.hidden = !expand;
    row.head.setAttribute("aria-expanded", String(expand));
    row.root.classList.toggle("is-open", expand);
    if (expand) openRow = row;
    else if (openRow === row) openRow = null;
  };

  const makeRow = (scope: "local" | "cloud"): Row => {
    const root = el<HTMLDivElement>(`<div class="set-provider"></div>`);
    const head = el<HTMLButtonElement>(
      `<button type="button" class="set-provider-head" aria-expanded="false"></button>`,
    );
    const name = el<HTMLSpanElement>(`<span class="set-provider-name"></span>`);
    const badge = el<HTMLSpanElement>(`<span class="set-provider-badge"></span>`);
    const summary = el<HTMLSpanElement>(`<span class="set-provider-summary"></span>`);
    const chevron = el<HTMLSpanElement>(`<span class="set-provider-chevron" aria-hidden="true">›</span>`);
    head.append(name, badge, summary, chevron);

    const panel = el<HTMLDivElement>(`<div class="set-provider-panel" hidden></div>`);
    const fields = el<HTMLDivElement>(`<div class="set-provider-fields"></div>`);
    const urlField = labelledInput(ui.settings.providerBaseUrl, `<input type="text" name="baseUrl" spellcheck="false" />`);
    const modelField = labelledInput(ui.settings.providerModel, `<input type="text" name="model" spellcheck="false" />`);
    const keyField = labelledInput(
      ui.settings.apiKey,
      `<input type="password" name="key" autocomplete="off" spellcheck="false" />`,
    );
    fields.append(urlField, modelField, keyField);

    const note = el<HTMLElement>(`<p class="set-note"></p>`);
    // Where the key comes from, the same link the wizard offers: a provider
    // row asking for a key without saying where to get one is half a row.
    const getKey = el<HTMLAnchorElement>(`<a class="setup-link" target="_blank" rel="noreferrer" hidden></a>`);
    getKey.textContent = ui.setup.platformLink;
    const status = el<HTMLDivElement>(`<div class="set-progress" hidden></div>`);
    const actions = el<HTMLDivElement>(`<div class="set-provider-actions"></div>`);
    const checkButton = button(ui.settings.providerCheck, () => void check());
    const useButton = button(ui.settings.providerSaveUse, () => {}, "primary");
    actions.append(checkButton, useButton);
    panel.append(fields, note, getKey, status, actions);
    root.append(head, panel);
    groups[scope].appendChild(root);

    const urlInput = urlField.querySelector("input") as HTMLInputElement;
    const modelInput = modelField.querySelector("input") as HTMLInputElement;
    const keyInput = keyField.querySelector("input") as HTMLInputElement;

    const row: Row = {
      id: "",
      scope,
      root,
      head,
      panel,
      keyInput,
      note,
      summary,
      badge,
      button: useButton,
      expanded: false,
      paint(option, active) {
        row.id = option.id;
        name.textContent = providerName(option);
        badge.textContent = active ? ui.settings.providerActive : "";
        badge.hidden = !active;
        badge.classList.toggle("tone-ok", active);
        root.classList.toggle("is-active", active);
        // The collapsed header carries the one thing worth seeing without
        // opening it: whether this backend can be used as it stands. A local
        // service can, key or no key — a missing key is only a problem for the
        // ones that call out.
        const keyState = option.hasKey
          ? ui.settings.providerKeySet
          : option.scope === "local"
            ? ui.settings.providerLocalNoKey
            : ui.settings.providerKeyMissing;
        const keyWarn = !option.hasKey && option.scope !== "local";
        summary.textContent = keyState;
        summary.classList.toggle("tone-warn", keyWarn);
        // The endpoint only means something for an OpenAI-compatible service —
        // Gemini's own client has it baked in.
        urlField.hidden = !option.editable.baseUrl;
        urlInput.value = option.baseUrl ?? "";
        modelInput.value = option.model;
        urlInput.placeholder = option.baseUrl ?? "";
        keyInput.placeholder = option.hasKey ? ui.settings.keySaved : ui.settings.keyPaste;
        const batch = option.supportsBatch ? ui.settings.providerBatchOk : ui.settings.providerNoBatch;
        note.textContent = `${keyState} · ${batch}`;
        note.classList.toggle("tone-warn", keyWarn);
        getKey.hidden = !option.platformUrl;
        if (option.platformUrl) getKey.href = option.platformUrl;
        // Never disabled, not even for the backend already in use: its key or
        // model is exactly what one comes here to fix, and a disabled button
        // with no reason reads as a broken page.
      },
    };

    /**
     * A check the reader asks for, not a gate: it reports what the provider
     * answered and never blocks saving — a wrong key is the reader's to fix,
     * and a service that happens to be down should not stop them either.
     */
    const check = async () => {
      const typed = keyInput.value.trim();
      status.hidden = false;
      status.classList.remove("tone-warn");
      status.textContent = ui.settings.providerCheckBusy;
      const result = await validateGeneration(row.id, typed || undefined);
      if (result.ok) {
        status.textContent = ui.settings.providerCheckOk;
      } else if (result.kind === "auth") {
        status.textContent = ui.setup.keyRejected(result.detail);
        status.classList.add("tone-warn");
      } else {
        status.textContent = ui.settings.providerCheckUnreachable(result.detail);
        status.classList.add("tone-warn");
      }
    };

    head.addEventListener("click", () => {
      const expand = !row.expanded;
      if (expand && openRow && openRow !== row) setExpanded(openRow, false);
      setExpanded(row, expand);
    });
    keyInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") useButton.click();
    });
    return row;
  };

  let latest: ConfigStatus | null = null;

  const render = () => {
    if (!latest) {
      state.textContent = ui.settings.unavailable;
      state.className = "set-sync-state tone-muted";
      return;
    }
    const active = latest.providers.find((p) => p.id === latest!.provider);
    // A local service is ready without a key: saying "no key" of LM Studio is
    // the same lie as asking it for one.
    const usable = !!active && (active.hasKey || active.scope === "local");
    state.textContent = usable
      ? `${active ? providerName(active) : ""} · ${ui.settings.ready}`
      : ui.settings.noKey;
    state.className = `set-sync-state tone-${usable ? "ok" : "warn"}`;

    // Rows exist for every provider the server knows, created on first sight
    // into the group its scope names, so the order within a group is the
    // server's.
    for (const option of latest.providers) {
      let row = rows.find((r) => r.id === option.id);
      if (!row) {
        row = makeRow(option.scope ?? "cloud");
        rows.push(row);
        row.button.addEventListener("click", () => void save(row!));
      }
      row.paint(option, option.id === latest.provider);
    }
    groups.local.hidden = !latest.providers.some((p) => p.scope === "local");
    groups.cloud.hidden = !latest.providers.some((p) => p.scope === "cloud");
  };

  /**
   * Writes one row. Only the fields that row uses, so saving DeepSeek cannot
   * blank Gemini's model, and vice versa.
   */
  const save = async (row: Row) => {
    if (!latest) return;
    const option = latest.providers.find((p) => p.id === row.id);
    if (!option) return;
    const root = row.root;
    const key = row.keyInput;
    const url = root.querySelector<HTMLInputElement>('input[name="baseUrl"]')!;
    const model = root.querySelector<HTMLInputElement>('input[name="model"]')!;
    const status = root.querySelector<HTMLElement>(".set-progress")!;

    const patch: Record<string, string> = { AI_PROVIDER: option.id };
    const prefix = option.id.toUpperCase();
    if (option.editable.baseUrl && url.value.trim()) patch[`${prefix}_BASE_URL`] = url.value.trim();
    if (option.editable.model && model.value.trim()) patch[`${prefix}_MODEL`] = model.value.trim();
    // Write a model for Gemini too, under the name its own code reads.
    if (option.id === "gemini" && model.value.trim()) patch.GEMINI_MODEL = model.value.trim();
    const typed = key.value.trim();
    if (typed) patch[option.apiKeyEnv] = typed;

    status.hidden = false;
    status.textContent = ui.common.saving;
    row.button.disabled = true;
    try {
      const next = await saveConfig(patch);
      key.value = "";
      status.textContent = next.ready ? ui.settings.savedReady : ui.settings.saved;
      apply(next);
      setExpanded(row, false);
    } catch (err) {
      status.textContent = (err as Error).message;
      row.button.disabled = false;
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

function appearanceSection(writable = true): HTMLElement {
  const s = section(ui.settings.appearance);
  const body = s.querySelector(".set-body")!;

  const theme = el<HTMLDivElement>(`<div class="set-row"><span>${ui.theme.label}</span></div>`);
  theme.appendChild(renderThemeControl());
  body.appendChild(theme);

  const density = el<HTMLDivElement>(`<div class="set-row"><span>${ui.album.gridDensity}</span></div>`);
  density.appendChild(renderDensityControl());
  body.appendChild(density);

  // One setting for the interface and the archive's own text — captions, day
  // pages, trips. That text needs translating from Generate first; anything
  // without a translation shows as written.
  // TODO: choose it from the browser's language on first launch instead, which
  // would make this row — and the question of whose language it is — go away
  // for every reader rather than being withheld from remote ones.
  if (writable) {
    const language = el<HTMLDivElement>(`<div class="set-row"><span>${ui.language.label}</span></div>`);
    language.appendChild(renderContentLanguageControl(ui.language.label));
    body.appendChild(language);
  }

  const sidebar = el<HTMLDivElement>(`<div class="set-row"><span>${ui.settings.sidebarWidth}</span></div>`);
  sidebar.appendChild(button(ui.common.reset, resetSidebarWidth));
  body.appendChild(sidebar);
  return s;
}

/**
 * Starting the job server at sign-in.
 *
 * The whole reason this switch exists is one machine: the server every reader
 * depends on currently exists only while the desktop window does, so closing
 * the window takes the archive away from the phone and from everyone on the
 * home network, with nothing on screen to say why. Registered at sign-in, the
 * server outlives the window — and the window becomes just another client of
 * it, because `startPipelineServer` adopts a healthy server rather than
 * starting a second copy.
 *
 * In the writable block for the same reason as every other switch here: it
 * writes a Run key and two files under the archive home, and the server
 * refuses that from anything but this machine regardless.
 *
 * Fetched rather than known, because the answer is a fact about the server's
 * machine — and unknown until it says. Until then the row stays hidden, so a
 * control that cannot work is never drawn (the same rule as `canWrite`).
 */
/**
 * Who may reach the job server — and the button that restarts it.
 *
 * Two values are shown at once, deliberately: what the server is doing *now*
 * (makeAccess and server.listen took their answers from `.env` at startup) and
 * what is saved for next time, with `restartNeeded` between them. Showing only
 * the saved value would claim a change that has not happened; showing only the
 * running one would make a successful save look like a refusal.
 *
 * Restart belongs here rather than behind a second "apply" button: this is the
 * section whose changes need it, and a server that simply wants restarting is
 * the same button.
 */
function remoteSection(): HTMLElement {
  const s = section(ui.settings.remote);
  const body = s.querySelector(".set-body")!;
  body.appendChild(el<HTMLParagraphElement>(`<p class="set-note">${ui.settings.remoteNote}</p>`));

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const hostRow = row(ui.settings.remoteHost, "—");
  const passRow = row(ui.settings.remotePassword, "—");
  // The file, not its contents: a failed restart says "look in data\serve.log"
  // and this is the path worth copying. Hidden until the server sends one —
  // it sends null to anyone but the machine running it.
  const logRow = row(ui.settings.remoteLogFile, "");
  logRow.hidden = true;
  const openWarn = el<HTMLParagraphElement>(`<p class="set-note tone-warn" hidden>${ui.settings.remoteOpen}</p>`);
  const savedWarn = el<HTMLParagraphElement>(`<p class="set-note tone-warn" hidden>${ui.settings.remoteSaved}</p>`);
  body.append(hostRow, passRow, logRow, openWarn, savedWarn);

  const exposedLabel = el<HTMLLabelElement>(
    `<label class="set-check" hidden><input type="checkbox"><span>${ui.settings.remoteExpose}</span></label>`,
  );
  const exposed = exposedLabel.querySelector("input") as HTMLInputElement;

  const keyField = labelledInput(
    ui.settings.remoteNewPassword,
    `<input type="password" name="remote-password" autocomplete="new-password" spellcheck="false" />`,
  );
  const keyInput = keyField.querySelector("input") as HTMLInputElement;

  const keyActions = el<HTMLDivElement>(`<div class="set-actions"></div>`);
  const saveKey = button(ui.settings.remoteSetPassword, () => void save({ password: keyInput.value }));
  const clearKey = button(ui.settings.remoteClearPassword, () => void save({ password: null }));
  keyActions.append(saveKey, clearKey);

  const restartActions = el<HTMLDivElement>(`<div class="set-actions"></div>`);
  const restart = button(ui.settings.restart, () => void restartNow(), "primary");
  restartActions.appendChild(restart);

  const progress = el<HTMLParagraphElement>(`<p class="set-note" hidden></p>`);
  const problem = el<HTMLParagraphElement>(`<p class="set-note tone-warn" hidden></p>`);
  body.append(exposedLabel, keyField, keyActions, restartActions, progress, problem);

  const apply = (status: RemoteAccessStatus | null) => {
    if (!status) return;
    setRowValue(hostRow, status.host);
    setRowValue(passRow, status.hasPassword ? ui.settings.remotePasswordSet : ui.settings.remotePasswordUnset);
    logRow.hidden = !status.logFile;
    if (status.logFile) setPathValue(logRow, status.logFile);
    // The checkbox shows what is *saved*, because that is what ticking it
    // changes; the running answer is the row above, and `restartNeeded` is the
    // line between them.
    exposedLabel.hidden = false;
    exposed.checked = status.savedExposed;
    openWarn.hidden = !(
      (status.exposed && !status.hasPassword) ||
      (status.savedExposed && !status.savedHasPassword)
    );
    savedWarn.hidden = !status.restartNeeded;
    if (status.restartNeeded) {
      // Name what differs instead of "saved": a divergence can be inherited
      // from an earlier session (or the harness pinning the environment), and
      // "Saved" reads like something the reader just did.
      const changes: string[] = [];
      if (status.savedExposed !== status.exposed) {
        changes.push(`${status.host} → ${status.savedExposed ? "0.0.0.0" : "127.0.0.1"}`);
      }
      if (status.savedHasPassword !== status.hasPassword) {
        changes.push(
          `${ui.settings.remotePassword} → ${status.savedHasPassword ? ui.settings.remotePasswordSet : ui.settings.remotePasswordUnset}`,
        );
      }
      savedWarn.textContent = ui.settings.remoteSaved(changes.join("；"));
    }
    clearKey.hidden = !(status.hasPassword || status.savedHasPassword);
  };

  const save = async (patch: { exposed?: boolean; password?: string | null }) => {
    problem.hidden = true;
    try {
      apply(await setRemoteAccess(patch));
      keyInput.value = "";
    } catch (err) {
      // The server's own wording: "not a host this server can bind" is the
      // useful half of an invalid answer, and it is not this side's to improve.
      problem.textContent = (err as Error).message;
      problem.hidden = false;
      void remoteAccessStatus().then(apply);
    }
  };

  exposed.addEventListener("change", () => void save({ exposed: exposed.checked }));

  /** Waits for a server that has been asked to replace itself. */
  const waitForServer = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await checkHealth()) return true;
      await sleep(500);
    }
    return false;
  };

  const restartNow = async () => {
    problem.hidden = true;
    restart.disabled = true;
    progress.textContent = ui.settings.restarting;
    progress.hidden = false;
    try {
      await restartServer();
      // The handover starts ~300ms after this answer and closes the listener;
      // asking sooner would reach the server that is on its way out and reload
      // straight into the gap it leaves.
      await sleep(1500);
      if (await waitForServer()) {
        location.reload();
        return;
      }
      progress.textContent = ui.settings.restartFailed;
    } catch (err) {
      // Most likely a running job, which the server refuses on purpose.
      progress.hidden = true;
      problem.textContent = (err as Error).message;
      problem.hidden = false;
    } finally {
      restart.disabled = false;
    }
  };

  void remoteAccessStatus().then(apply);
  return s;
}

function backgroundSection(): HTMLElement {
  const s = section(ui.settings.background);
  const body = s.querySelector(".set-body")!;

  const note = el<HTMLParagraphElement>(`<p class="set-note">${ui.settings.backgroundNote}</p>`);
  const control = el<HTMLLabelElement>(
    `<label class="set-check" hidden><input type="checkbox"><span>${ui.settings.backgroundOn}</span></label>`,
  );
  const box = control.querySelector("input") as HTMLInputElement;
  // What the Run key holds, carried by the checkbox's own hint rather than a
  // row of its own: a registered command is a fact about the switch, not a
  // setting — and with the box off, that line is the reason why.
  const where = el<HTMLParagraphElement>(`<p class="set-note" hidden></p>`);
  const problem = el<HTMLParagraphElement>(`<p class="set-note tone-warn" hidden></p>`);
  // The one control that must exist when the server cannot answer: every row
  // beside it asks the server something, and this one is for when there is
  // nobody to ask. Shell-only (IPC), so it exists exactly where a window does.
  const startBtn = el<HTMLButtonElement>(`<button type="button" class="set-btn" hidden>${ui.settings.startServer}</button>`);
  body.append(note, control, where, problem, startBtn);

  startBtn.addEventListener("click", () => {
    const api = window.electronAPI;
    if (!api?.startPipeline) return;
    problem.hidden = true;
    startBtn.disabled = true;
    startBtn.textContent = ui.settings.startServerBusy;
    void api
      .startPipeline()
      .then((r) => {
        if (r.ok) {
          // Settings draws from the server; reload so every row fills in from
          // the one that just came up.
          location.reload();
          return;
        }
        problem.textContent = r.error || ui.settings.startServerFailed;
        problem.hidden = false;
      })
      .catch(() => {
        problem.textContent = ui.settings.startServerFailed;
        problem.hidden = false;
      })
      .finally(() => {
        startBtn.disabled = false;
        startBtn.textContent = ui.settings.startServer;
      });
  });

  const apply = (status: AutostartStatus | null) => {
    // No answer at all: keep the explanation, and offer the way out — the
    // start button — instead of drawing a checkbox that would fail on click.
    if (!status) {
      note.textContent = ui.settings.backgroundNote;
      control.hidden = true;
      where.hidden = true;
      startBtn.hidden = false;
      return;
    }
    if (!status.supported) {
      note.textContent = ui.settings.backgroundUnsupported;
      control.hidden = true;
      where.hidden = true;
      return;
    }
    note.textContent = ui.settings.backgroundNote;
    control.hidden = false;
    box.checked = status.enabled;
    // The registered command is the switch's own footnote: what it will start
    // when ticked, or — with the box off — whose archive that Run key belongs
    // to, which is the whole reason a checked box can mean someone else's home.
    where.hidden = !status.command;
    if (status.command) {
      where.textContent = status.enabled
        ? ui.settings.backgroundWhere(status.command)
        : ui.settings.backgroundForeign(status.command);
      where.classList.toggle("tone-warn", !status.enabled);
    }
  };

  box.addEventListener("change", () => {
    const want = box.checked;
    problem.hidden = true;
    box.disabled = true;
    void setAutostart(want)
      .then(apply)
      .catch((err: Error) => {
        // Back to what the server says it is, not what the click hoped for.
        box.checked = !want;
        problem.textContent = err.message;
        problem.hidden = false;
      })
      .finally(() => {
        box.disabled = false;
      });
  });

  void autostartStatus().then(apply);
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
