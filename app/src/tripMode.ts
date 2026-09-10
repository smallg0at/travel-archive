import type { JobRecord } from "@travel-archive/shared";
import { el } from "./photoUi";
import { localServerSource, setThumbnailSource } from "./photoSource";
import {
  cancelJob,
  checkHealth,
  forgetJob,
  getJob,
  archiveStatus,
  planAnalyze,
  planOrganize,
  rememberJob,
  rememberedJob,
  startAnalyze,
  startOrganize,
  startTrip,
  watchJob,
} from "./backend";

/**
 * The generation panel: pick a date range, name it or let the model name it,
 * attach context, and watch the job run.
 *
 * Only rendered when `pipeline serve` answers. Without it the app is a reader —
 * which is exactly the phone's experience, since the server binds to loopback
 * and holds OneDrive credentials. There is no mobile-specific code here; the
 * absent backend *is* the mobile path.
 *
 * The range is always chosen by hand. Inferring trips from GPS was tried and
 * dropped: it needs a fixed home to measure from and home moves, and no
 * distance threshold separates a trip from a day out — on this archive the real
 * trip's first day sat 105km from home and an ordinary local day sat at 87km.
 */

type Refresh = () => void;

let onFinished: Refresh = () => {};
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

  box.querySelector(".job-phase")!.textContent =
    `${job.kind} · ${job.status}${job.progress.total > 0 ? ` · ${job.progress.done}/${job.progress.total}` : ""}`;

  // Model output and file names end up in here, so it is set as text.
  box.querySelector(".job-log")!.textContent = job.log.slice(-6).join("\n");

  const cancel = box.querySelector(".job-cancel") as HTMLButtonElement;
  const finished = job.status !== "running" && job.status !== "queued";
  cancel.hidden = finished;

  if (finished) {
    forgetJob();
    const result = job.error
      ? `failed: ${job.error}`
      : Object.entries(job.result ?? {})
          .map(([k, v]) => `${k} ${v}`)
          .join(", ");
    box.querySelector(".job-phase")!.textContent = `${job.kind} · ${job.status}${result ? ` · ${result}` : ""}`;
    // A finished job has almost always changed index.json, so the caller
    // reloads rather than leaving a stale nav on screen.
    if (job.status === "done") onFinished();
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
  box.querySelector(".job-phase")!.textContent = "failed";
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
        <button type="button" data-mode="trip" class="active">Trip</button>
        <button type="button" data-mode="analyze">Analyze</button>
        <button type="button" data-mode="organize">Day summaries</button>
      </div>

      <form class="job-form" data-mode="trip">
        <p class="job-note">
          Writes the story of a trip from its <em>day summaries</em> — so run Analyze and Day summaries
          for the range first, or it will have nothing to work from.
        </p>
        <div class="job-row"></div>
        <label class="job-field"><span>Notes (optional)</span><textarea rows="3" name="notes" placeholder="Anything worth knowing — plans, who you were with, what the trip was for."></textarea></label>
        <label class="job-field"><span>Context documents (.txt, .md)</span><input type="file" name="documents" multiple accept=".txt,.md,.markdown" /></label>
        <button type="submit">Write the narrative</button>
      </form>

      <form class="job-form" data-mode="analyze" hidden>
        <div class="job-row"></div>
        <p class="job-note">
          Captions every photo in the range that has never been looked at, one model call each.
          <strong>This is the step that costs money</strong> — check the estimate first. Re-running is safe:
          photos that already have a caption are skipped.
        </p>
        <div class="job-buttons">
          <button type="button" class="job-estimate">Estimate cost</button>
          <button type="submit">Analyze</button>
        </div>
      </form>

      <form class="job-form" data-mode="organize" hidden>
        <p class="job-note">
          Turns the captions from Analyze into day pages: groups each day into the places you stopped,
          names them, and picks what to show. One text-only model call per day — no images, so it is cheap.
          <strong>Run this after Analyze and before Trip.</strong>
        </p>
        <div class="job-row job-scope">
          <label class="job-field">
            <span>Months</span>
            <select name="scope" class="job-select"><option value="">Everything</option></select>
          </label>
          <label class="job-check">
            <input type="checkbox" name="force" />
            <span>Include days that have not changed</span>
          </label>
        </div>
        <div class="job-buttons">
          <button type="button" class="job-preview">Find days to summarise</button>
        </div>
        <div class="job-plan" hidden></div>
      </form>

      <div class="job-progress" hidden>
        <div class="job-phase"></div>
        <div class="job-bar"><div class="job-bar-fill"></div></div>
        <pre class="job-log"></pre>
        <button type="button" class="job-cancel">Cancel</button>
      </div>
    </section>
  `);

  for (const form of panel.querySelectorAll<HTMLFormElement>(".job-form")) {
    // Day summaries picks a month from a list, not a date range, so it has no
    // date row to fill — and its scope row is not one.
    const row = form.querySelector(".job-row:not(.job-scope)");
    if (!row) continue;
    row.appendChild(field("From", `<input type="date" name="from" required />`));
    row.appendChild(field("To", `<input type="date" name="to" required />`));
    if (form.dataset.mode === "trip") {
      row.appendChild(field("Name (blank = let the model propose one)", `<input type="text" name="name" />`));
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
      }),
    );
  });

  const analyzeForm = panel.querySelector<HTMLFormElement>('.job-form[data-mode="analyze"]')!;
  analyzeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(analyzeForm);
    void start(() => startAnalyze({ from: String(data.get("from")), to: String(data.get("to")) }));
  });

  analyzeForm.querySelector<HTMLButtonElement>(".job-estimate")!.addEventListener("click", async () => {
    const data = new FormData(analyzeForm);
    const note = analyzeForm.querySelector(".job-note")!;
    try {
      const plan = await planAnalyze({ from: String(data.get("from")), to: String(data.get("to")) });
      note.textContent =
        plan.total === 0
          ? "Nothing to analyze in that range — already done, or filtered out as duplicates and withheld screenshots."
          : `${plan.total} photo(s) across ${plan.months.length} month(s) — about ${(plan.estimatedInputTokens / 1e6).toFixed(2)}M input and ${(plan.estimatedOutputTokens / 1e6).toFixed(2)}M output tokens.`;
    } catch (err) {
      note.textContent = `Could not estimate: ${(err as Error).message}`;
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
      option.textContent = `${m.month} · ${m.photoCount.toLocaleString()} photos`;
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
    planBox.textContent = "Checking…";
    try {
      const plan = await planOrganize({ ...(scope.value ? { only: scope.value } : {}), force });
      planBox.replaceChildren();

      const lead = el<HTMLParagraphElement>(`<p class="job-plan-lead"></p>`);
      lead.textContent =
        plan.rewrite === 0
          ? "No days need summarising here."
          : `${plan.rewrite} day${plan.rewrite === 1 ? "" : "s"} can be summarised.`;
      planBox.appendChild(lead);

      // Every day accounted for, each reason named. "No analyzed photos" is the
      // one worth spelling out: Analyze has to run first, and nothing said so.
      for (const [n, label] of [
        [plan.reuse, "already up to date, or outside this scope"],
        [plan.skippedNoAnalyzed, "have no analyzed photos yet — run Analyze on them first"],
        [plan.skippedOutOfScope, "outside this scope"],
        [plan.skippedUndated, "have no usable date"],
      ] as [number, string][]) {
        if (n === 0) continue;
        const row = el<HTMLParagraphElement>(`<p class="job-plan-row"></p>`);
        row.textContent = `${n.toLocaleString()} ${label}`;
        planBox.appendChild(row);
      }

      if (plan.rewrite === 0) return;

      const list = el<HTMLDivElement>(`<div class="job-plan-days"></div>`);
      for (const day of plan.days) {
        const row = el<HTMLLabelElement>(`<label class="job-day"><input type="checkbox" checked><span></span></label>`);
        row.querySelector("input")!.value = day.date;
        row.querySelector("span")!.textContent = `${day.date} · ${day.analyzed} photo${day.analyzed === 1 ? "" : "s"}`;
        list.appendChild(row);
      }
      planBox.appendChild(list);

      if (plan.truncated) {
        const more = el<HTMLParagraphElement>(`<p class="job-plan-row"></p>`);
        more.textContent = "Only the first 300 are listed — narrow it by month to see the rest.";
        planBox.appendChild(more);
      }

      const ticked = () => [...list.querySelectorAll<HTMLInputElement>("input:checked")].map((i) => i.value);
      const actions = el<HTMLDivElement>(`<div class="job-buttons"></div>`);
      const none = el<HTMLButtonElement>(`<button type="button">Select none</button>`);
      const go = el<HTMLButtonElement>(`<button type="button" class="job-go"></button>`);
      const label = () => {
        const n = ticked().length;
        go.textContent = n === 0 ? "Nothing selected" : `Summarise ${n} day${n === 1 ? "" : "s"}`;
        go.disabled = n === 0;
      };
      none.addEventListener("click", () => {
        const on = ticked().length > 0;
        list.querySelectorAll<HTMLInputElement>("input").forEach((i) => (i.checked = !on));
        none.textContent = on ? "Select all" : "Select none";
        label();
      });
      list.addEventListener("change", label);
      go.addEventListener("click", () => runSelected(ticked()));
      actions.append(none, go);
      planBox.appendChild(actions);
      label();
    } catch (err) {
      planBox.textContent = `Could not check: ${(err as Error).message}`;
    }
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

    panel = renderJobPanel(refresh);

    const running = health.running ?? (await (async () => {
      const id = rememberedJob();
      return id ? await getJob(id) : null;
    })());
    if (running) attach(panel, running);
  } finally {
    markReady(panel !== null);
  }
}
