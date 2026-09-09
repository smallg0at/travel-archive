import type { DayRecord, DaySegment } from "@travel-archive/shared";
import { editDay, getJob, startOrganize, type DayPatch } from "./backend";
import { el } from "./photoUi";

/**
 * Correcting what the summarizer wrote, from the page it wrote it on.
 *
 * Two surfaces, deliberately not one. A **note** is something you tell the
 * model before it writes — "this is the the railway museum" — and it belongs with
 * the day as a whole. An **edit** is you overruling it afterwards, and it
 * belongs on the thing that is wrong: the stop whose title is not its name.
 *
 * Every field here is text a model produced about the owner's own life, so the
 * bar for the interaction is low friction and no surprises: nothing saves
 * without a press, cancelling restores what was there, and a failed write says
 * so on the spot rather than silently reverting.
 *
 * The whole module is inert without the local server — the phone reads the
 * archive from OneDrive and has nothing to write to. That is the same
 * "no backend is a supported state" rule the Generate page follows.
 */

let available = false;
let refresh: (() => void) | null = null;

/** Called once, after the health check that reveals the other server-only tools. */
export function setDayEditingAvailable(value: boolean): void {
  available = value;
}

/** How to redraw the archive after a regenerate. Set by main.ts. */
export function setArchiveRefresh(fn: () => void): void {
  refresh = fn;
}

function button(label: string, className: string): HTMLButtonElement {
  const b = el<HTMLButtonElement>(`<button type="button" class="${className}"></button>`);
  b.textContent = label;
  return b;
}

/**
 * Runs a save, keeping the button honest about what is happening.
 *
 * A write that fails must not leave the page showing the new text: the whole
 * point of the feature is that what you see is what is stored.
 */
async function save(action: HTMLButtonElement, patch: () => Promise<void>): Promise<boolean> {
  const label = action.textContent;
  action.disabled = true;
  action.textContent = "Saving…";
  try {
    await patch();
    return true;
  } catch (err) {
    action.textContent = (err as Error).message.slice(0, 80);
    action.disabled = false;
    return false;
  } finally {
    if (action.textContent === "Saving…") action.textContent = label;
  }
}

/**
 * The day's note and its summary, behind one Edit button in the day header.
 *
 * The note is the reason this panel is not just an editable summary: it is the
 * only channel for what no photograph carries, and it survives every future
 * run, so it earns a permanent place rather than a per-run text box.
 */
export function addDayControls(header: HTMLElement, day: DayRecord): void {
  if (!available) return;

  const bar = el<HTMLDivElement>(`<div class="day-tools"></div>`);
  const edit = button("Edit", "day-edit-open");
  bar.appendChild(edit);
  header.appendChild(bar);

  const panel = el<HTMLDivElement>(`
    <div class="day-editor" hidden>
      <label class="day-field">
        <span>Note for the summarizer — kept, and used every time this day is rewritten</span>
        <textarea rows="2" class="day-note" placeholder="e.g. the 11:00 stop is the the railway museum; the morning was a write-off."></textarea>
      </label>
      <label class="day-field">
        <span>Day summary</span>
        <textarea rows="4" class="day-summary-edit"></textarea>
      </label>
      <div class="day-editor-actions"></div>
      <p class="day-editor-note" hidden></p>
    </div>
  `);
  const note = panel.querySelector<HTMLTextAreaElement>(".day-note")!;
  const summary = panel.querySelector<HTMLTextAreaElement>(".day-summary-edit")!;
  const status = panel.querySelector<HTMLParagraphElement>(".day-editor-note")!;
  const actions = panel.querySelector<HTMLDivElement>(".day-editor-actions")!;

  const reset = () => {
    note.value = day.note ?? "";
    summary.value = day.summary ?? "";
  };
  reset();

  const saveBtn = button("Save", "day-save");
  const cancel = button("Cancel", "day-cancel");
  const regen = button("Rewrite this day", "day-regen");
  actions.append(saveBtn, cancel, regen);

  edit.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    edit.textContent = panel.hidden ? "Edit" : "Close";
    if (!panel.hidden) note.focus();
  });

  cancel.addEventListener("click", () => {
    reset();
    panel.hidden = true;
    edit.textContent = "Edit";
  });

  saveBtn.addEventListener("click", async () => {
    // Only what changed. Sending every field would clear the note each time a
    // summary was corrected, which is exactly the bug the patch shape exists
    // to prevent.
    const patch: DayPatch = {};
    if ((note.value.trim() || null) !== (day.note ?? null)) patch.note = note.value;
    if (summary.value !== (day.summary ?? "")) patch.summary = summary.value;
    if (Object.keys(patch).length === 0) {
      status.hidden = false;
      status.textContent = "Nothing changed.";
      return;
    }

    const ok = await save(saveBtn, async () => {
      const result = await editDay(day.date, patch);
      day.note = result.note;
      if (patch.summary !== undefined) {
        day.summary = summary.value;
        const shown = header.querySelector(".day-summary");
        if (shown) shown.textContent = summary.value;
      }
      status.hidden = false;
      status.textContent = result.stale
        ? "Saved. The note has changed, so the next day-summaries run will rewrite this day — or press Rewrite this day."
        : "Saved.";
    });
    if (ok) saveBtn.textContent = "Save";
  });

  regen.addEventListener("click", async () => {
    status.hidden = false;
    status.textContent = "Rewriting…";
    regen.disabled = true;
    try {
      // Forced: pressing this button *is* the intent to pay for a rewrite, and
      // without it a day whose note has not changed would be judged unchanged
      // and silently do nothing — the "0 day(s) summarized" trap again.
      let job = await startOrganize({ days: [day.date], force: true });
      while (job.status === "running" || job.status === "queued") {
        await new Promise((r) => setTimeout(r, 1500));
        job = (await getJob(job.id)) ?? job;
      }
      if (job.status !== "done") {
        status.textContent =
          job.status === "cancelled" ? "Rewrite cancelled." : `Rewrite failed: ${job.error ?? "unknown error"}`;
        return;
      }
      status.textContent = "Rewritten.";
      refresh?.();
    } catch (err) {
      status.textContent = `Rewrite failed: ${(err as Error).message}`;
    } finally {
      regen.disabled = false;
    }
  });

  header.appendChild(panel);
}

/**
 * A stop's title and summary, editable in place.
 *
 * Anchored to the stop's first photo rather than its id, because that is what
 * the stored edit is anchored to — see `StopEdit`. A stop with no photos cannot
 * be corrected, and there is nothing sensible to anchor to, so it is skipped.
 */
export function addStopControls(head: HTMLElement, section: HTMLElement, date: string, segment: DaySegment): void {
  if (!available) return;
  const anchorPhotoId = segment.photoIds[0];
  if (!anchorPhotoId) return;

  const open = button("Rename", "stop-edit-open");
  head.appendChild(open);

  const editor = el<HTMLDivElement>(`
    <div class="stop-editor" hidden>
      <input type="text" class="stop-title-edit" />
      <textarea rows="2" class="stop-summary-edit" placeholder="What happened here (optional)"></textarea>
      <div class="stop-editor-actions"></div>
      <p class="stop-editor-note" hidden></p>
    </div>
  `);
  const title = editor.querySelector<HTMLInputElement>(".stop-title-edit")!;
  const summary = editor.querySelector<HTMLTextAreaElement>(".stop-summary-edit")!;
  const status = editor.querySelector<HTMLParagraphElement>(".stop-editor-note")!;
  const actions = editor.querySelector<HTMLDivElement>(".stop-editor-actions")!;

  const reset = () => {
    title.value = segment.title;
    summary.value = segment.summary ?? "";
  };
  reset();

  const saveBtn = button("Save", "stop-save");
  const cancel = button("Cancel", "stop-cancel");
  actions.append(saveBtn, cancel);

  const close = () => {
    editor.hidden = true;
    open.textContent = "Rename";
  };

  open.addEventListener("click", () => {
    editor.hidden = !editor.hidden;
    open.textContent = editor.hidden ? "Rename" : "Close";
    if (!editor.hidden) title.focus();
  });
  cancel.addEventListener("click", () => {
    reset();
    close();
  });

  saveBtn.addEventListener("click", async () => {
    const stop: NonNullable<DayPatch["stops"]>[number] = { anchorPhotoId };
    if (title.value !== segment.title) stop.title = title.value;
    if (summary.value !== (segment.summary ?? "")) stop.summary = summary.value;
    if (stop.title === undefined && stop.summary === undefined) {
      status.hidden = false;
      status.textContent = "Nothing changed.";
      return;
    }

    const ok = await save(saveBtn, async () => {
      await editDay(date, { stops: [stop] });
      if (stop.title !== undefined) {
        segment.title = title.value;
        section.querySelector(".stop-title")!.textContent = title.value;
      }
      if (stop.summary !== undefined) {
        segment.summary = summary.value;
        const shown = section.querySelector(".stop-summary");
        if (shown) shown.textContent = summary.value;
        else if (summary.value) {
          const added = el<HTMLParagraphElement>(`<p class="stop-summary"></p>`);
          added.textContent = summary.value;
          editor.after(added);
        }
      }
    });
    if (ok) close();
  });

  section.appendChild(editor);
}
