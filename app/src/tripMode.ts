import type { JobRecord } from "@travel-archive/shared";
import { el } from "./photoUi";
import { localServerSource, setThumbnailSource } from "./photoSource";
import {
  canWrite,
  cancelJob,
  checkHealth,
  forgetJob,
  getJob,
  archiveStatus,
  getConfig,
  listBatches,
  planAnalyze,
  planOrganize,
  planTranslate,
  rememberJob,
  rememberedJob,
  saveConfig,
  screensStatus,
  startAnalyze,
  startCollect,
  startOrganize,
  startScreens,
  startTranslate,
  startTrip,
  watchJob,
} from "./backend";
import { SUMMARY_MIN_PHOTOS } from "@travel-archive/shared";
import { fmtDateTime, num, ui } from "./i18n";
import { claimRefresh, jobLabel } from "./activity";
import { mountTripSuggestions } from "./tripSuggestions";
import { checkProvider, localOptions, providerName } from "./providerChoice";

/**
 * The generation panel: pick a date range, name it or let the model name it,
 * attach context, and watch the job run.
 *
 * Only rendered when `pipeline serve` answers. Without it the app is a reader —
 * which is exactly the phone's experience, since the server binds to loopback
 * and holds OneDrive credentials. There is no mobile-specific code here; the
 * absent backend *is* the mobile path.
 *
 * The range is always the owner's to confirm. Inferring trips from each day's
 * distance from home was tried and dropped — no threshold separated a trip's
 * first day (105km) from an ordinary day out (87km). The suggestions above
 * the form measure nights away instead (tripSuggestions.ts), and still only
 * propose.
 */

type Refresh = () => void;

let onFinished: Refresh = () => {};
/** Redraws the batch list; any job may have submitted or collected one. */
let onJobSettled: () => void = () => {};
let stopWatching: (() => void) | null = null;

function field(label: string, control: string): HTMLElement {
  const wrap = el<HTMLLabelElement>(`<label class="job-field"><span></span>${control}</label>`);
  wrap.querySelector("span")!.textContent = label;
  return wrap;
}

function renderProgress(panel: HTMLElement, job: JobRecord): void {
  const box = panel.querySelector(".job-progress") as HTMLElement;
  box.hidden = false;

  const pct = job.progress.total > 0 ? Math.round((job.progress.done / job.progress.total) * 100) : 0;
  (box.querySelector(".job-bar-fill") as HTMLElement).style.width = `${pct}%`;

  const phase = jobLabel(job.kind, job.status);
  box.querySelector(".job-phase")!.textContent =
    `${phase}${job.progress.total > 0 ? ` · ${num(job.progress.done)}/${num(job.progress.total)}` : ""}`;

  // Model output and file names end up in here, so it is set as text.
  box.querySelector(".job-log")!.textContent = job.log.slice(-6).join("\n");

  const cancel = box.querySelector(".job-cancel") as HTMLButtonElement;
  const finished = job.status !== "running" && job.status !== "queued";
  cancel.hidden = finished;

  if (finished) {
    forgetJob();
    // The result's keys are the server's own names ("summarized 3") and stay
    // as it wrote them, like the log above.
    const result = job.error
      ? ui.generate.jobFailed(job.error)
      : Object.entries(job.result ?? {})
          .map(([k, v]) => `${k} ${v}`)
          .join(", ");
    box.querySelector(".job-phase")!.textContent = `${phase}${result ? ` · ${result}` : ""}`;
    onJobSettled();
    // A finished job has almost always changed index.json, so the caller
    // reloads rather than leaving a stale nav on screen.
    if (job.status === "done" && claimRefresh(job.id)) onFinished();
  }
}

function attach(panel: HTMLElement, job: JobRecord): void {
  rememberJob(job.id);
  renderProgress(panel, job);
  stopWatching?.();
  stopWatching = watchJob(job.id, (update) => renderProgress(panel, update));

  const cancel = panel.querySelector(".job-cancel") as HTMLButtonElement;
  cancel.onclick = () => {
    cancel.disabled = true;
    void cancelJob(job.id).finally(() => (cancel.disabled = false));
  };
}

function fail(panel: HTMLElement, message: string): void {
  const box = panel.querySelector(".job-progress") as HTMLElement;
  box.hidden = false;
  box.querySelector(".job-phase")!.textContent = ui.generate.jobStatus.failed;
  box.querySelector(".job-log")!.textContent = message;
  (box.querySelector(".job-cancel") as HTMLElement).hidden = true;
}

/** Reads dropped/selected .txt/.md files into the request body. */
async function readDocuments(files: FileList | null): Promise<{ name: string; text: string }[]> {
  if (!files) return [];
  return Promise.all(
    [...files]
      .filter((f) => /\.(txt|md|markdown)$/i.test(f.name))
      .map(async (f) => ({ name: f.name, text: await f.text() })),
  );
}

export function renderJobPanel(refresh: Refresh): HTMLElement {
  onFinished = refresh;

  const panel = el<HTMLElement>(`
    <section class="job-panel">
      <div class="job-tabs">
        <button type="button" data-mode="trip" class="active">${ui.generate.tabs.trip}</button>
        <button type="button" data-mode="analyze">${ui.generate.tabs.analyze}</button>
        <button type="button" data-mode="organize">${ui.generate.tabs.organize}</button>
        <button type="button" data-mode="translate">${ui.generate.tabs.translate}</button>
        <button type="button" data-mode="screens">${ui.generate.tabs.screens}</button>
      </div>

      <form class="job-form" data-mode="trip">
        <p class="job-note">${ui.generate.tripNoteHtml}</p>
        <div class="job-row"></div>
        <label class="job-field"><span>${ui.generate.notes}</span><textarea rows="3" name="notes" placeholder="${ui.generate.notesPlaceholder}"></textarea></label>
        <label class="job-field"><span>${ui.generate.documents}</span><input type="file" name="documents" multiple accept=".txt,.md,.markdown" /></label>
        <label class="job-check">
          <input type="checkbox" name="allowMissing" />
          <span>${ui.generate.tripAllowMissing}</span>
        </label>
        <button type="submit">${ui.generate.writeNarrative}</button>
        <!-- Below the controls, at the owner's request: the form is the tool,
             the suggestions a list to work through under it. -->
        <div class="trip-suggestions" hidden></div>
      </form>

      <form class="job-form" data-mode="analyze" hidden>
        <div class="job-row"></div>
        <p class="job-note">${ui.generate.analyzeNoteHtml}</p>
        <label class="job-check">
          <input type="checkbox" name="batch" />
          <span>${ui.generate.batchLabel}</span>
        </label>
        <div class="job-buttons">
          <button type="button" class="job-estimate">${ui.generate.estimateCost}</button>
          <button type="submit">${ui.generate.analyze}</button>
        </div>
        <div class="job-plan job-batches" hidden></div>
      </form>

      <form class="job-form" data-mode="organize" hidden>
        <p class="job-note">${ui.generate.organizeNoteHtml}</p>
        <div class="job-row job-scope">
          <label class="job-field">
            <span>${ui.generate.months}</span>
            <select name="scope" class="job-select"><option value="">${ui.common.everything}</option></select>
          </label>
          <label class="job-check">
            <input type="checkbox" name="force" />
            <span>${ui.generate.includeUnchanged}</span>
          </label>
        </div>
        <div class="job-buttons">
          <button type="button" class="job-preview">${ui.generate.findDays}</button>
        </div>
        <div class="job-plan" hidden></div>
      </form>

      <form class="job-form" data-mode="translate" hidden>
        <p class="job-note">${ui.generate.translateNote}</p>
        <div class="job-row job-scope">
          <label class="job-field">
            <span>${ui.generate.whatToTranslate}</span>
            <select name="translate-scope" class="job-select"></select>
          </label>
        </div>
        <div class="job-buttons">
          <button type="button" class="job-estimate">${ui.generate.estimate}</button>
          <button type="submit">${ui.generate.translate}</button>
        </div>
        <p class="job-note job-translate-plan" hidden></p>
      </form>

      <!-- Describing the screenshots nobody has vouched for. A tab here rather
           than a row in Settings because it is one of the things Generate does:
           run a pass over the archive, watch it, cancel it. -->
      <form class="job-form" data-mode="screens" hidden>
        <p class="job-note">${ui.generate.screensNote}</p>
        <div class="job-row job-scope">
          <label class="job-field">
            <span>${ui.generate.screensService}</span>
            <select name="provider" class="job-select"></select>
          </label>
          <label class="job-field">
            <span>${ui.generate.screensPassphrase}</span>
            <input type="password" name="passphrase" autocomplete="new-password" spellcheck="false" />
          </label>
        </div>
        <p class="job-note job-screens-state"></p>
        <div class="job-buttons">
          <button type="button" class="job-screens-check">${ui.generate.screensCheck}</button>
          <button type="submit">${ui.generate.screensStart}</button>
        </div>
      </form>

      <div class="job-progress" hidden>
        <div class="job-phase"></div>
        <div class="job-bar"><div class="job-bar-fill"></div></div>
        <pre class="job-log"></pre>
        <button type="button" class="job-cancel">${ui.common.cancel}</button>
      </div>
    </section>
  `);

  for (const form of panel.querySelectorAll<HTMLFormElement>(".job-form")) {
    // Day summaries picks a month from a list, not a date range, so it has no
    // date row to fill — and its scope row is not one.
    const row = form.querySelector(".job-row:not(.job-scope)");
    if (!row) continue;
    // A trip needs both ends. Analyze does not: leaving one blank means "open
    // that end", so an empty field is a real answer and `required` was forcing
    // a fake one — a typed-out 0001-01-01 just to satisfy the browser.
    const rangeRequired = form.dataset.mode === "trip" ? " required" : "";
    row.appendChild(field(ui.common.from, `<input type="date" name="from"${rangeRequired} />`));
    row.appendChild(field(ui.common.to, `<input type="date" name="to"${rangeRequired} />`));
    if (form.dataset.mode === "trip") {
      row.appendChild(field(ui.generate.name, `<input type="text" name="name" />`));
    }
  }

  panel.querySelectorAll<HTMLButtonElement>(".job-tabs button").forEach((tab) => {
    tab.addEventListener("click", () => {
      panel.querySelectorAll(".job-tabs button").forEach((b) => b.classList.remove("active"));
      tab.classList.add("active");
      panel.querySelectorAll<HTMLFormElement>(".job-form").forEach((f) => {
        f.hidden = f.dataset.mode !== tab.dataset.mode;
      });
    });
  });

  const start = async (run: () => Promise<JobRecord>) => {
    try {
      attach(panel, await run());
    } catch (err) {
      fail(panel, (err as Error).message);
    }
  };

  const tripForm = panel.querySelector<HTMLFormElement>('.job-form[data-mode="trip"]')!;
  mountTripSuggestions(tripForm.querySelector<HTMLElement>(".trip-suggestions")!, {
    fill: (from, to, name) => {
      tripForm.querySelector<HTMLInputElement>('input[name="from"]')!.value = from;
      tripForm.querySelector<HTMLInputElement>('input[name="to"]')!.value = to;
      tripForm.querySelector<HTMLInputElement>('input[name="name"]')!.value = name;
      tripForm.querySelector(".job-note")!.scrollIntoView({ block: "start" });
    },
    refresh: () => onFinished(),
  });
  tripForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(tripForm);
    const files = tripForm.querySelector<HTMLInputElement>('input[name="documents"]')!.files;
    void start(async () =>
      startTrip({
        startDate: String(data.get("from")),
        endDate: String(data.get("to")),
        name: String(data.get("name") ?? "").trim() || undefined,
        notes: String(data.get("notes") ?? "").trim() || undefined,
        documents: await readDocuments(files),
        allowMissingSummaries: data.get("allowMissing") === "on",
      }),
    );
  });

  const analyzeForm = panel.querySelector<HTMLFormElement>('.job-form[data-mode="analyze"]')!;

  /**
   * A date field's value, or undefined for "no bound on that end".
   *
   * An empty `<input type="date">` reads as "" through FormData and would only
   * be "null" if the field were missing entirely — the string that used to be
   * sent, and read server-side as a month named "null". Empty is a real answer
   * here: analyze without a lower bound means the whole archive. `undefined`
   * so the key is dropped from the request body, which the server already reads
   * as no bound.
   */
  const bound = (value: FormDataEntryValue | null): string | undefined => {
    const text = String(value ?? "").trim();
    return text === "" ? undefined : text;
  };

  analyzeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(analyzeForm);
    void start(() =>
      startAnalyze({ from: bound(data.get("from")), to: bound(data.get("to")), batch: data.get("batch") === "on" }),
    );
  });

  // Batches outlive the page and the job that submitted them, so what they
  // are doing is asked of the server, not remembered here.
  const batchBox = analyzeForm.querySelector<HTMLDivElement>(".job-batches")!;
  const renderBatches = async () => {
    const batches = await listBatches();
    if (!batches || batches.length === 0) {
      batchBox.hidden = true;
      return;
    }
    batchBox.hidden = false;
    const lead = el<HTMLParagraphElement>(`<p class="job-plan-lead"></p>`);
    lead.textContent = ui.generate.batchesTitle;
    const rows = [...batches]
      .reverse()
      .slice(0, 8)
      .map((b) => {
        const row = el<HTMLParagraphElement>(`<p class="job-plan-row"></p>`);
        const when = fmtDateTime(new Date(b.createdAt), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
        row.textContent = ui.generate.batchRow(when, b.photos, ui.generate.batchState[b.collectedAt ? "collected" : b.state], b.applied);
        return row;
      });
    batchBox.replaceChildren(lead, ...rows);
    if (batches.some((b) => !b.collectedAt && b.state === "succeeded")) {
      const collect = el<HTMLButtonElement>(`<button type="button">${ui.generate.collectNow}</button>`);
      collect.addEventListener("click", () => void start(() => startCollect()));
      batchBox.appendChild(collect);
    }
  };
  onJobSettled = () => void renderBatches();
  panel.querySelector<HTMLButtonElement>('.job-tabs button[data-mode="analyze"]')!.addEventListener("click", () => void renderBatches());
  void renderBatches();

  analyzeForm.querySelector<HTMLButtonElement>(".job-estimate")!.addEventListener("click", async () => {
    const data = new FormData(analyzeForm);
    const note = analyzeForm.querySelector(".job-note")!;
    try {
      const plan = await planAnalyze({ from: bound(data.get("from")), to: bound(data.get("to")) });
      const batch = data.get("batch") === "on";
      note.textContent =
        plan.total === 0
          ? ui.generate.nothingToAnalyze
          : ui.generate.analyzePlan(plan.total, plan.months.length, plan.estimatedInputTokens, plan.estimatedOutputTokens) +
            (batch ? ` ${ui.generate.batchEstimate}` : "");
    } catch (err) {
      note.textContent = ui.generate.couldNotEstimate((err as Error).message);
    }
  });

  const organizeForm = panel.querySelector<HTMLFormElement>('.job-form[data-mode="organize"]')!;
  const planBox = organizeForm.querySelector<HTMLDivElement>(".job-plan")!;
  const scope = organizeForm.querySelector<HTMLSelectElement>('select[name="scope"]')!;

  // The month list comes from the archive rather than being typed. The old
  // field was free text where "2026-09" and "2026-09-01" meant different things
  // and only the prose below it said so.
  void archiveStatus().then((archive) => {
    for (const m of [...(archive?.months ?? [])].reverse()) {
      // Not el(): an <option> parsed inside a <div> is dropped on the floor.
      const option = document.createElement("option");
      option.value = m.month;
      option.textContent = ui.generate.monthOption(m.month, m.photoCount);
      scope.appendChild(option);
    }
  });

  /**
   * Finds the days a run would touch and offers them for selection.
   *
   * The preview *is* the input. Naming particular days used to mean typing one
   * date, running, and repeating — nine times, for nine days — with no way to
   * tell a day that was skipped from one that did not exist. Here every
   * candidate is listed with how many analyzed photos it has, ticked by
   * default, and the run takes exactly what is ticked.
   */
  const runSelected = (dates: string[]) => {
    void start(() => startOrganize({ days: dates, force: true }));
  };

  organizeForm.querySelector<HTMLButtonElement>(".job-preview")!.addEventListener("click", async () => {
    const force = organizeForm.querySelector<HTMLInputElement>('input[name="force"]')!.checked;
    planBox.hidden = false;
    planBox.textContent = ui.common.checking;
    try {
      const plan = await planOrganize({ ...(scope.value ? { only: scope.value } : {}), force });
      planBox.replaceChildren();

      const lead = el<HTMLParagraphElement>(`<p class="job-plan-lead"></p>`);
      lead.textContent = plan.rewrite === 0 ? ui.generate.noDays : ui.generate.canSummarise(plan.rewrite);
      planBox.appendChild(lead);

      // Every day accounted for, each reason named. "No analyzed photos" is the
      // one worth spelling out: Analyze has to run first, and nothing said so.
      for (const [n, line] of [
        [plan.reuse, ui.generate.reuse],
        [plan.skippedNoAnalyzed, ui.generate.noAnalyzed],
        [plan.skippedOutOfScope, ui.generate.outOfScope],
        [plan.skippedUndated, ui.generate.undated],
        [plan.skippedSmall ?? 0, (n: number) => ui.generate.small(n, SUMMARY_MIN_PHOTOS)],
      ] as [number, (n: number) => string][]) {
        if (n === 0) continue;
        const row = el<HTMLParagraphElement>(`<p class="job-plan-row"></p>`);
        row.textContent = line(n);
        planBox.appendChild(row);
      }

      if (plan.rewrite === 0) return;

      const list = el<HTMLDivElement>(`<div class="job-plan-days"></div>`);
      for (const day of plan.days) {
        const row = el<HTMLLabelElement>(`<label class="job-day"><input type="checkbox" checked><span></span></label>`);
        row.querySelector("input")!.value = day.date;
        row.querySelector("span")!.textContent = ui.generate.planDay(day.date, day.analyzed);
        list.appendChild(row);
      }
      planBox.appendChild(list);

      if (plan.truncated) {
        const more = el<HTMLParagraphElement>(`<p class="job-plan-row"></p>`);
        more.textContent = ui.generate.truncated;
        planBox.appendChild(more);
      }

      const ticked = () => [...list.querySelectorAll<HTMLInputElement>("input:checked")].map((i) => i.value);
      const actions = el<HTMLDivElement>(`<div class="job-buttons"></div>`);
      const none = el<HTMLButtonElement>(`<button type="button">${ui.generate.selectNone}</button>`);
      const go = el<HTMLButtonElement>(`<button type="button" class="job-go"></button>`);
      const label = () => {
        const n = ticked().length;
        go.textContent = n === 0 ? ui.generate.nothingSelected : ui.generate.summarise(n);
        go.disabled = n === 0;
      };
      none.addEventListener("click", () => {
        const on = ticked().length > 0;
        list.querySelectorAll<HTMLInputElement>("input").forEach((i) => (i.checked = !on));
        none.textContent = on ? ui.generate.selectAll : ui.generate.selectNone;
        label();
      });
      list.addEventListener("change", label);
      go.addEventListener("click", () => runSelected(ticked()));
      actions.append(none, go);
      planBox.appendChild(actions);
      label();
    } catch (err) {
      planBox.textContent = ui.generate.couldNotCheck((err as Error).message);
    }
  });

  const translateForm = panel.querySelector<HTMLFormElement>('.job-form[data-mode="translate"]')!;
  const translateScope = translateForm.querySelector<HTMLSelectElement>('select[name="translate-scope"]')!;
  const translatePlanBox = translateForm.querySelector<HTMLParagraphElement>(".job-translate-plan")!;
  // Not el(): an <option> parsed inside a <div> is dropped on the floor.
  for (const [value, label] of [
    ["all", ui.generate.translateScopes.all],
    ["day", ui.generate.translateScopes.day],
    ["captions", ui.generate.translateScopes.captions],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    translateScope.appendChild(option);
  }
  const translateBody = () => ({ lang: "zh-Hans", scope: translateScope.value as "all" | "day" | "captions" });

  translateForm.querySelector<HTMLButtonElement>(".job-estimate")!.addEventListener("click", async () => {
    translatePlanBox.hidden = false;
    translatePlanBox.textContent = ui.common.checking;
    try {
      const plan = await planTranslate(translateBody());
      translatePlanBox.textContent =
        plan.missing === 0
          ? ui.generate.nothingToTranslate(plan.strings)
          : ui.generate.translatePlan(
              plan.missing,
              plan.strings,
              plan.missingChars,
              plan.estimatedInputTokens,
              plan.estimatedOutputTokens,
            );
    } catch (err) {
      translatePlanBox.textContent = ui.generate.couldNotEstimate((err as Error).message);
    }
  });

  translateForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void start(() => startTranslate(translateBody()));
  });

  /**
   * The screenshots tab. Two things come from the server and both have to be
   * current when the tab is opened, not when the page was: which services on
   * this machine exist (the same list Settings shows, filtered by scope) and how
   * much is already described. A stale count here would read as "it did
   * nothing".
   */
  const screensForm = panel.querySelector<HTMLFormElement>('.job-form[data-mode="screens"]')!;
  const screensProvider = screensForm.querySelector<HTMLSelectElement>('select[name="provider"]')!;
  const screensPass = screensForm.querySelector<HTMLInputElement>('input[name="passphrase"]')!;
  const screensState = screensForm.querySelector<HTMLElement>(".job-screens-state")!;
  const screensSubmit = screensForm.querySelector<HTMLButtonElement>('button[type="submit"]')!;

  const paintScreens = async () => {
    const [config, status] = await Promise.all([getConfig(), screensStatus()]);
    const local = localOptions(config?.providers ?? []);
    const chosen = status?.provider ?? local[0]?.id ?? "";
    screensProvider.replaceChildren(
      ...local.map((option) => {
        const item = el<HTMLOptionElement>(`<option></option>`);
        item.value = option.id;
        item.textContent = providerName(option);
        item.selected = option.id === chosen;
        return item;
      }),
    );
    screensPass.placeholder = status?.hasPassphrase ? ui.generate.screensPassSaved : ui.generate.screensPassNew;
    // A run in flight, an unreadable file (a changed passphrase), a missing
    // passphrase, no local service — each is a different sentence, and only the
    // last two stop the button.
    screensState.textContent = status?.error
      ? status.error
      : status?.running
        ? ui.generate.screensRunning
        : local.length === 0
          ? ui.generate.screensNoLocal
          : status?.hasPassphrase
            ? ui.generate.screensDescribed(status.described)
            : ui.generate.screensNoPassphrase;
    const blocked = local.length === 0 || !!status?.error;
    screensState.classList.toggle("tone-warn", blocked || !status?.hasPassphrase);
    screensSubmit.disabled = blocked;
  };

  panel.querySelector<HTMLButtonElement>('.job-tabs button[data-mode="screens"]')!.addEventListener("click", () => void paintScreens());
  void paintScreens();

  screensForm.querySelector<HTMLButtonElement>(".job-screens-check")!.addEventListener("click", async () => {
    screensState.classList.remove("tone-warn");
    screensState.textContent = ui.settings.providerCheckBusy;
    const result = await checkProvider(screensProvider.value);
    screensState.textContent = result.text;
    screensState.classList.toggle("tone-warn", result.warn);
  });

  screensForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const passphrase = screensPass.value.trim();
    void start(async () => {
      // Saved first and deliberately: the pass reads these values when it starts
      // (settingNow), so this is what makes the choice the run's, and what keeps
      // it after a restart. A blank passphrase means "keep the saved one".
      await saveConfig(
        passphrase
          ? { SCREENSHOT_PROVIDER: screensProvider.value, SCREENSHOT_PASSPHRASE: passphrase }
          : { SCREENSHOT_PROVIDER: screensProvider.value },
      );
      screensPass.value = "";
      return startScreens();
    });
  });

  return panel;
}

/**
 * Adds the panel only if a backend answers, and reattaches to whatever was
 * running — either a job this tab started before a reload, or one started
 * elsewhere (the CLI, another tab), which the health check reports.
 */
/**
 * The panel, built once and kept.
 *
 * Generate is a page now rather than a drawer, and a page is re-rendered every
 * time it is opened — but this panel holds a form someone may have half filled
 * in and the live progress of a running job. Both would be thrown away by a
 * rebuild, so the element is created once and moved into the page instead.
 */
let panel: HTMLElement | null = null;
let refreshFn: Refresh = () => {};

let markReady: (ok: boolean) => void = () => {};
const ready = new Promise<boolean>((resolve) => {
  markReady = resolve;
});

/**
 * Settles once `initGeneration` has decided: true when the panel exists. A
 * refresh on `#generate` renders the album before the panel is built, and has
 * to wait for this rather than find nothing to show.
 */
export function whenGenerationReady(): Promise<boolean> {
  return ready;
}

/** Shows Generate as a page, like Settings. False when there is no backend. */
export function showGenerate(): boolean {
  if (!panel) return false;
  document.getElementById("content")!.replaceChildren(panel);
  return true;
}

/**
 * Decides where thumbnails come from, and builds the Generate panel if a
 * backend answers. Called once at startup; the panel itself is shown by
 * `showGenerate`.
 */
export async function initGeneration(refresh: Refresh): Promise<void> {
  refreshFn = refresh;
  // Settled on every exit, including a failed health check or a throw, so a
  // page waiting on `whenGenerationReady` is never left on "Loading archive…".
  try {
    const health = await checkHealth();
    if (!health?.ok) return;

    // The same check that reveals the generation controls also decides where
    // thumbnails come from: a server that can run jobs can serve images from
    // its own disk cache, which is shared between browsers and survives one
    // clearing its site data. Without a backend the built-in Graph path stays
    // in use.
    setThumbnailSource(localServerSource);

    // Build the panel only where this client may write. A remote reader is
    // served by the same server, so `health.ok` is true for them too — and
    // every control in this panel would answer 403. `showGenerate` treats a
    // missing panel as "no Generate page", which is the truth for them. The
    // image source above is set regardless: reading *is* served by that
    // server, that is the whole of remote reading.
    panel = canWrite() ? renderJobPanel(refresh) : null;

    const running = health.running ?? (await (async () => {
      const id = rememberedJob();
      return id ? await getJob(id) : null;
    })());
    if (running && panel) attach(panel, running);
  } finally {
    markReady(panel !== null);
  }
}
