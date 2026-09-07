import type { JobRecord } from "@travel-archive/shared";
import { el } from "./photoUi";
import { localServerSource, setThumbnailSource } from "./photoSource";
import {
  cancelJob,
  checkHealth,
  forgetJob,
  getJob,
  planAnalyze,
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
        <label class="job-field">
          <span>Limit to a date (optional)</span>
          <input type="text" name="only" placeholder="Leave empty — all days" />
        </label>
        <p class="job-note job-hint">
          Empty means every day is <em>considered</em>, not rewritten: only days whose photos changed cost
          anything, and days with nothing analyzed are skipped. Narrow it with <code>2026-08</code> for a
          month or <code>2026-08-30</code> for one day.
        </p>
        <label class="job-check">
          <input type="checkbox" name="force" />
          <span>Rewrite days that have not changed</span>
        </label>
        <button type="submit">Write day summaries</button>
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
    const row = form.querySelector(".job-row");
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
  organizeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(organizeForm);
    const only = String(data.get("only") ?? "").trim();
    void start(() => startOrganize({ ...(only ? { only } : {}), force: data.get("force") === "on" }));
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
  const health = await checkHealth();
  if (!health?.ok) return;

  // The same check that reveals the generation controls also decides where
  // thumbnails come from: a server that can run jobs can serve images from its
  // own disk cache, which is shared between browsers and survives one clearing
  // its site data. Without a backend the built-in Graph path stays in use.
  setThumbnailSource(localServerSource);

  panel = renderJobPanel(refresh);

  const running = health.running ?? (await (async () => {
    const id = rememberedJob();
    return id ? await getJob(id) : null;
  })());
  if (running) attach(panel, running);
}
