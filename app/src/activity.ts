import type { AnalyzeBatchStatus, AutoSubmitStatus, JobKind, JobRecord } from "@travel-archive/shared";
import {
  autoSubmitStatus,
  stopAutoSubmit,
  cancelJob,
  canWrite,
  checkHealth,
  jobHistory,
  listBatches,
  startCollect,
  watchJob,
  type Health,
  type RenderCapability,
  type ThumbWarming,
} from "./backend";
import { el } from "./photoUi";
import { fmtDateTime, num, ui } from "./i18n";

/**
 * Activity: what the local server is doing, and has done, in one place.
 *
 * Until the batch captioner every job ran in the foreground, on the page that
 * started it, and that page's progress line was enough. Now there is work
 * nobody watches — a whole-library submit that runs for hours, batches that
 * sit at Google for up to a day, collects the server starts by itself every
 * ten minutes, thumbnails cached in the background — and none of it showed
 * anywhere unless Generate happened to be open. Generate and Settings keep
 * their own progress lines, which belong to the form just pressed; this is the
 * overview.
 *
 * Like Settings it is read from the server and rebuilt on every visit. With no
 * server — the phone — there is nothing to show, and it says so.
 */

/** How often the sidebar entry asks what is running. /health is milliseconds on loopback. */
const INDICATOR_EVERY_MS = 15_000;
/**
 * Pounds per US dollar, for the "≈£" beside batch costs — Google bills in
 * dollars and the spend cap is set in pounds. Fixed on 2026-09-11, so
 * approximate by design; the dollar figure is the exact one.
 */
const GBP_PER_USD = 0.79;
/**
 * Job kinds whose end means the album's data changed and nobody on this page
 * asked for it. Scan and sync are left out: Settings starts them and reloads
 * after them itself, and the app's own check-only sync at launch would
 * otherwise reload the album every time it opened.
 */
const REFRESH_AFTER = new Set<JobKind>(["analyze", "collect", "organize", "trip", "translate"]);
const WHEN: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
const GIVEN_UP = new Set(["failed", "cancelled", "expired"]);

let stopLive: (() => void) | null = null;
/** The job the "Now" section is following, if any. */
let liveJobId: string | null = null;
/** Set while the page is open, so the indicator can hand it a job that started elsewhere. */
let nowHost: HTMLElement | null = null;
let warmHost: HTMLElement | null = null;
let refreshLists: (() => void) | null = null;
/** The last batch list read, so an idle "Now" can say what is still out at Google. */
let lastBatches: AnalyzeBatchStatus[] = [];
let indicatorTimer: ReturnType<typeof setInterval> | null = null;

let refreshAlbum: () => void = () => {};
/** Jobs the album has already been reloaded for — by Generate's own watcher or by the indicator. */
const refreshed = new Set<string>();
/** The last `lastFinished` id the indicator saw; undefined until its first poll. */
let seenFinished: string | null | undefined;

/** The album's reload, handed over once at startup like `setArchiveRefresh`. */
export function setActivityRefresh(refresh: () => void): void {
  refreshAlbum = refresh;
}

/**
 * True the first time it is asked about a job, false after. Generate reloads
 * the album when a job it watched ends, and the indicator reloads it when any
 * job ends; whichever notices first does it, and the other finds it done.
 */
export function claimRefresh(jobId: string): boolean {
  if (refreshed.has(jobId)) return false;
  refreshed.add(jobId);
  return true;
}

/** Drops the live subscription. Called whenever the view changes. */
export function releaseActivity(): void {
  stopLive?.();
  stopLive = null;
  liveJobId = null;
  nowHost = null;
  warmHost = null;
  refreshLists = null;
}

const finished = (job: JobRecord) => job.status !== "running" && job.status !== "queued";

function money(usd: number): string {
  // A three-photo test batch costs a fifth of a cent; two decimals would say $0.00.
  const digits = usd < 0.1 ? 4 : 2;
  return ui.activity.money(`$${usd.toFixed(digits)}`, `£${(usd * GBP_PER_USD).toFixed(digits)}`);
}

function section(title: string): { node: HTMLElement; body: HTMLElement } {
  const node = el<HTMLElement>(`<section class="set-section"><h3></h3><div class="set-body"></div></section>`);
  node.querySelector("h3")!.textContent = title;
  return { node, body: node.querySelector<HTMLElement>(".set-body")! };
}

function note(text: string): HTMLElement {
  const p = el<HTMLParagraphElement>(`<p class="set-note"></p>`);
  p.textContent = text;
  return p;
}

function row(label: string, value: string): HTMLElement {
  const node = el<HTMLDivElement>(`<div class="set-row"><span></span><b></b></div>`);
  node.querySelector("span")!.textContent = label;
  node.querySelector("b")!.textContent = value;
  return node;
}

/**
 * A job kind or status in the reader's language, or the server's own word
 * when this build has no label for it. A window left open across a server
 * upgrade runs the old catalogue against new kinds — the first `locate` job
 * showed as "undefined · running".
 */
export function jobLabel(kind: JobKind, status?: JobRecord["status"]): string {
  const k = (ui.generate.jobKind as Partial<Record<string, string>>)[kind] ?? kind;
  if (!status) return k;
  return `${k} · ${(ui.generate.jobStatus as Partial<Record<string, string>>)[status] ?? status}`;
}

function jobTitle(job: Pick<JobRecord, "kind" | "status">): string {
  return jobLabel(job.kind, job.status);
}

/** The server's own result keys ("summarized 3"), as it wrote them — like the job log. */
function resultText(job: JobRecord): string {
  if (job.error) return ui.generate.jobFailed(job.error);
  return Object.entries(job.result ?? {})
    .filter(([, value]) => value)
    .map(([key, value]) => `${key} ${num(value)}`)
    .join(", ");
}

/**
 * What "Now" says with no job running here. A batch at Google is work in
 * progress all the same — for hours — and "Nothing is running" above it read
 * as if the run had stalled.
 */
function idleNote(): HTMLElement {
  const uncollected = lastBatches.filter((b) => !b.collectedAt);
  const waiting = uncollected.filter((b) => b.state === "pending" || b.state === "running");
  const done = uncollected.filter((b) => b.state === "succeeded");
  const lines: string[] = [];
  if (waiting.length) {
    const photos = waiting.reduce((n, b) => n + b.photos, 0);
    const oldest = Math.min(...waiting.map((b) => Date.parse(b.createdAt)));
    lines.push(ui.activity.waitingForGoogle(photos, ui.activity.duration(Date.now() - oldest)));
  }
  if (done.length) lines.push(ui.activity.readyToCollect(done.reduce((n, b) => n + b.photos, 0)));
  return note(lines.length ? lines.join(" ") : ui.activity.idle);
}

/** The running job, followed live, with its cancel button; or what is idle and what is still out. */
function renderNow(host: HTMLElement, job: JobRecord | null): void {
  stopLive?.();
  stopLive = null;
  liveJobId = null;
  host.replaceChildren();
  if (!job || finished(job)) {
    host.appendChild(idleNote());
    return;
  }
  liveJobId = job.id;

  const box = el<HTMLDivElement>(`
    <div class="job-progress">
      <div class="job-phase"></div>
      <div class="job-bar"><div class="job-bar-fill"></div></div>
      <pre class="job-log"></pre>
      <button type="button" class="job-cancel"></button>
    </div>
  `);
  const cancel = box.querySelector<HTMLButtonElement>(".job-cancel")!;
  if (canWrite()) {
    cancel.textContent = ui.common.cancel;
    cancel.addEventListener("click", () => {
      cancel.disabled = true;
      void cancelJob(job.id).finally(() => (cancel.disabled = false));
    });
  } else {
    // Watching is a read; stopping is not. Removed rather than hidden so no
    // reader is offered a control that would answer 403.
    cancel.remove();
  }

  const paint = (j: JobRecord) => {
    const { phase, done, total } = j.progress;
    box.querySelector(".job-phase")!.textContent = `${jobTitle(j)} · ${phase}${total > 0 ? ` · ${num(done)}/${num(total)}` : ""}`;
    box.querySelector<HTMLElement>(".job-bar-fill")!.style.width = `${total > 0 ? Math.round((done / total) * 100) : 0}%`;
    // Model output and file names end up in here, so it is set as text.
    // A whole tail, not the last few lines: a scan writes one line per folder,
    // so eight showed barely the current one. The box scrolls (see `.job-log`)
    // and is pinned to the newest line so a growing log stays readable.
    const log = box.querySelector<HTMLPreElement>(".job-log")!;
    log.textContent = j.log.slice(-40).join("\n");
    log.scrollTop = log.scrollHeight;
  };
  paint(job);
  host.appendChild(box);

  stopLive = watchJob(job.id, (update) => {
    paint(update);
    if (!finished(update)) return;
    stopLive?.();
    stopLive = null;
    liveJobId = null;
    // It moves to the top of the history, which is refreshed to show it.
    host.replaceChildren(idleNote());
    refreshLists?.();
  });
}

/**
 * What this machine cannot render, when that is something.
 *
 * Only ever shown while degraded: a line that reads "all good" on every visit
 * is a line nobody reads, and the gaps are rare enough to be worth the
 * silence. It names the fix because this note is where a missing ffmpeg is
 * visible from at all — the job log says it too, but only after an analyze
 * run has already been started.
 */
function capabilityNote(render: RenderCapability | undefined): HTMLElement | null {
  if (!render) return null;
  const gaps: string[] = [];
  if (!render.images) gaps.push(ui.activity.noSharp);
  else if (!render.heif) gaps.push(ui.activity.noHeic);
  if (!render.ffmpeg) gaps.push(ui.activity.noFfmpeg);
  return gaps.length ? note(gaps.join(" · ")) : null;
}

/** Background thumbnail caching — not a job, so it has no stream; the indicator's poll repaints it. */
function renderWarming(host: HTMLElement, warm: ThumbWarming | null | undefined): void {
  host.replaceChildren();
  if (!warm) return;
  const box = el<HTMLDivElement>(`
    <div class="job-progress">
      <div class="job-phase"></div>
      <div class="job-bar"><div class="job-bar-fill"></div></div>
    </div>
  `);
  const settled = warm.done + warm.failed;
  box.querySelector(".job-phase")!.textContent =
    `${ui.activity.thumbnails} · ${ui.activity.warming(warm.done, warm.total, warm.failed, warm.finishedAt !== null)}`;
  box.querySelector<HTMLElement>(".job-bar-fill")!.style.width = `${warm.total ? Math.round((settled / warm.total) * 100) : 0}%`;
  host.appendChild(box);
}

/** The server submitting the rest one batch at a time, and the switch to stop it. */
function autoSubmitBlock(auto: AutoSubmitStatus): HTMLElement {
  const box = el<HTMLDivElement>(`<div></div>`);
  box.appendChild(note(ui.activity.autoSubmit(auto.waitingForBatch, fmtDateTime(new Date(auto.since), WHEN))));
  const actions = el<HTMLDivElement>(`<div class="set-actions"></div>`);
  const stop = el<HTMLButtonElement>(`<button type="button" class="set-btn"></button>`);
  stop.textContent = ui.activity.stopAutoSubmit;
  stop.addEventListener("click", () => {
    stop.disabled = true;
    void stopAutoSubmit()
      .then(() => box.replaceChildren(note(ui.activity.autoSubmitStopped)))
      .catch((err: Error) => {
        stop.disabled = false;
        stop.textContent = err.message.slice(0, 80);
      });
  });
  actions.appendChild(stop);
  box.appendChild(actions);
  return box;
}

function renderBatches(host: HTMLElement, batches: AnalyzeBatchStatus[] | null, auto: AutoSubmitStatus | null): void {
  host.replaceChildren();
  if (auto) host.appendChild(autoSubmitBlock(auto));
  if (!batches || batches.length === 0) {
    host.appendChild(note(ui.activity.noBatches));
    return;
  }
  for (const b of [...batches].reverse()) {
    const state = ui.generate.batchState[b.collectedAt ? "collected" : b.state];
    // One block per batch, its figures under its own heading. As loose rows
    // the line below a batch read as the heading of the next one.
    const item = el<HTMLDivElement>(`<div class="act-batch"></div>`);
    item.appendChild(row(`${fmtDateTime(new Date(b.createdAt), WHEN)} · ${ui.common.photos(b.photos)}`, state));
    host.appendChild(item);
    // `usage` and `costUsd` are absent from a server built before this page.
    const usage = b.usage ?? null;
    const detail = ui.activity.batchDetail(
      b.applied,
      b.failed,
      usage ? usage.promptTokens : null,
      usage ? usage.outputTokens + usage.thoughtsTokens : null,
      b.costUsd != null ? money(b.costUsd) : null,
    );
    if (detail) item.appendChild(note(detail));
  }

  const spent = batches.reduce((sum, b) => sum + (b.costUsd ?? 0), 0);
  const waiting = batches
    .filter((b) => !b.collectedAt && !GIVEN_UP.has(b.state))
    .reduce((n, b) => n + b.photos, 0);
  const total = note(ui.activity.batchTotal(money(spent), waiting));
  total.classList.add("act-total");
  host.appendChild(total);

  if (batches.some((b) => !b.collectedAt && b.state === "succeeded")) {
    const actions = el<HTMLDivElement>(`<div class="set-actions"></div>`);
    const collect = el<HTMLButtonElement>(`<button type="button" class="set-btn primary"></button>`);
    collect.textContent = ui.generate.collectNow;
    collect.addEventListener("click", () => {
      collect.disabled = true;
      void startCollect()
        .then((job) => {
          if (nowHost?.isConnected) renderNow(nowHost, job);
        })
        .catch((err: Error) => {
          collect.disabled = false;
          collect.textContent = err.message.slice(0, 80);
        });
    });
    actions.appendChild(collect);
    host.appendChild(actions);
  }
}

function renderHistory(host: HTMLElement, history: JobRecord[] | null): void {
  host.replaceChildren();
  const past = (history ?? []).filter(finished);
  if (past.length === 0) {
    host.appendChild(note(ui.activity.noHistory));
    return;
  }
  for (const job of past) {
    const item = el<HTMLDetailsElement>(`<details class="act-job"><summary><span></span><span></span></summary></details>`);
    const [what, when] = item.querySelectorAll<HTMLSpanElement>("summary span");
    what.textContent = jobTitle(job);
    what.classList.toggle("tone-bad", job.status === "failed");
    const took = job.finishedAt ? Date.parse(job.finishedAt) - Date.parse(job.startedAt) : null;
    when.textContent = `${fmtDateTime(new Date(job.startedAt), WHEN)}${took !== null ? ` · ${ui.activity.duration(took)}` : ""}`;
    const result = resultText(job);
    if (result) item.appendChild(note(result));
    if (job.log.length) {
      const log = el<HTMLPreElement>(`<pre class="job-log"></pre>`);
      log.textContent = job.log.join("\n");
      item.appendChild(log);
    }
    host.appendChild(item);
  }
}

export async function showActivity(): Promise<void> {
  const content = document.getElementById("content")!;
  releaseActivity();
  content.replaceChildren(el(`<div class="loading">${ui.activity.loading}</div>`));

  const writable = canWrite();
  const [health, batches, history, auto] = await Promise.all([
    checkHealth(),
    // Nothing to draw for a reader, so nothing to ask for either.
    writable ? listBatches() : null,
    writable ? jobHistory() : null,
    writable ? autoSubmitStatus() : null,
  ]);
  // The reader may have gone elsewhere while those were in flight.
  if (location.hash !== "#activity") return;

  const frag = document.createDocumentFragment();
  frag.appendChild(el(`<div class="month-heading"><h1>${ui.nav.activity}</h1><span></span></div>`));
  if (!health) {
    frag.appendChild(note(ui.activity.noServer));
    content.replaceChildren(frag);
    return;
  }

  const now = section(ui.activity.now);
  const warm = el<HTMLDivElement>(`<div></div>`);
  now.node.appendChild(warm);
  const batchSection = section(ui.activity.batches);
  const past = section(ui.activity.history);
  // The running job is attached for **every** reader — watching is a read —
  // and it goes first, above the batches and the history, because it is the
  // only thing on this page that is happening now.
  //
  // It was dropped from here when the writable sections were made
  // conditional, and the loss was quiet: `nowHost` still pointed at a body
  // that existed but was never in the document, so `renderNow` painted into
  // it, the indicator's `nowHost?.isConnected` guard never fired, and the page
  // showed batches while a job ran.
  frag.appendChild(now.node);
  // A reader may watch what is running — that is the point of this page for
  // them — while the queue and the history are the owner's, and so is the
  // cancel button (a cancel from here would be refused server-side anyway).
  if (writable) frag.append(batchSection.node, past.node);
  content.replaceChildren(frag);

  nowHost = now.body;
  warmHost = warm;
  lastBatches = batches ?? [];
  renderNow(now.body, health.running ?? null);
  renderWarming(warm, health.warming);
  // What this machine cannot render — the reason a video has no tile.
  const gap = capabilityNote(health.render);
  if (gap) now.node.appendChild(gap);
  if (writable) {
    renderBatches(batchSection.body, batches, auto);
    renderHistory(past.body, history);
  }
  refreshLists = () => {
    if (!writable) return;
    void Promise.all([listBatches(), jobHistory(), autoSubmitStatus()]).then(([b, h, a]) => {
      if (!batchSection.node.isConnected) return;
      lastBatches = b ?? [];
      if (liveJobId === null && nowHost) nowHost.replaceChildren(idleNote());
      renderBatches(batchSection.body, b, a);
      renderHistory(past.body, h);
    });
  };
}

/** A job ended since the last poll: reload the album if nobody else has, and redraw the lists. */
function noticeFinished(health: Health): void {
  const last = health.lastFinished ?? null;
  const id = last?.id ?? null;
  const firstPoll = seenFinished === undefined;
  if (id === seenFinished) return;
  seenFinished = id;
  // What had already ended when the page loaded is in the data it loaded.
  if (firstPoll || !last) return;
  if (last.status === "done" && REFRESH_AFTER.has(last.kind) && claimRefresh(last.id)) refreshAlbum();
  // The album reload re-renders this page if it is open; otherwise just its lists.
  else refreshLists?.();
}

/**
 * The sidebar entry's live status — what is running, in a word — so it can be
 * seen from any page. Restarted whenever the nav is rebuilt, which replaces
 * the button; a timer whose button has gone stops itself.
 */
export function startActivityIndicator(button: HTMLElement): void {
  if (indicatorTimer) clearInterval(indicatorTimer);
  const tick = async () => {
    if (!button.isConnected) {
      if (indicatorTimer) clearInterval(indicatorTimer);
      indicatorTimer = null;
      return;
    }
    const health = await checkHealth();
    if (!health) return;
    const job = health.running ?? null;
    const warm = health.warming && !health.warming.finishedAt ? health.warming : null;
    const status = button.querySelector<HTMLElement>(".nav-activity-status");
    if (status) {
      status.textContent = job ? `${jobLabel(job.kind)}…` : warm ? `${ui.activity.thumbnails}…` : "";
    }
    button.title = job ? jobTitle(job) : warm ? ui.activity.warming(warm.done, warm.total, warm.failed, false) : "";

    // A job started elsewhere — the server's own collect, the CLI — while
    // this page sits open showing nothing running.
    if (job && nowHost?.isConnected && liveJobId === null) renderNow(nowHost, job);
    if (warmHost?.isConnected) renderWarming(warmHost, health.warming);
    noticeFinished(health);
  };
  void tick();
  indicatorTimer = setInterval(() => void tick(), INDICATOR_EVERY_MS);
}
