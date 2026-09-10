import type { DayRecord, DaySegment, PhotoRecord } from "@travel-archive/shared";
import { editDay, getJob, setPhotoTakenAt, startOrganize, type DayPatch } from "./backend";
import { el } from "./photoUi";
import { forgetMonths } from "./archiveData";

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

/**
 * When this photo was taken, corrected by hand.
 *
 * Offered on any photo the archive dates from its filename — the 125 WhatsApp
 * saves here, which land at a fabricated midnight that `stops.ts` refuses to
 * place, so they are appended to the end of the day rather than sitting in it.
 * A photo dated from EXIF is left alone: the server would refuse it, because
 * EXIF outranks the name and a rename would move nothing.
 *
 * The control writes the timestamp into the *filename*, which is why it is a
 * correction rather than an annotation — a rescan reads it straight back.
 */
/**
 * Whether the time editor is open, remembered across photos.
 *
 * Retiming is a *batch*: 123 WhatsApp saves, each wanting one hour picked. If
 * the editor closed itself every time the panel redrew — after a save, and
 * again on every arrow key to the next photo — the job would be three clicks
 * per photo instead of one. Opened once, it stays open until it is closed.
 */
let timeEditorOpen = false;
/** The last save, so the confirmation survives the redraw that follows it. */
let lastTimeSave: { id: string; fileName: string } | null = null;

export function addPhotoTimeControl(host: HTMLElement, photo: PhotoRecord, onSaved: () => void): void {
  if (!available) return;
  if (photo.dateSource !== "filename" && photo.dateSource !== "filename-date") return;
  if (!photo.takenAt) return;

  const month = photo.takenAt.slice(0, 7);
  const wrap = el<HTMLDivElement>(`
    <div class="photo-time">
      <button type="button" class="photo-time-open"></button>
      <div class="photo-time-editor" hidden>
        <label><span>Date</span><input type="date" class="photo-time-date" /></label>
        <label><span>Time (hour)</span><select class="photo-time-clock"></select></label>
        <div class="photo-time-actions"></div>
        <p class="photo-time-note"></p>
      </div>
    </div>
  `);
  const open = wrap.querySelector<HTMLButtonElement>(".photo-time-open")!;
  const editor = wrap.querySelector<HTMLDivElement>(".photo-time-editor")!;
  const date = wrap.querySelector<HTMLInputElement>(".photo-time-date")!;
  const clock = wrap.querySelector<HTMLSelectElement>(".photo-time-clock")!;
  const status = wrap.querySelector<HTMLParagraphElement>(".photo-time-note")!;
  const actions = wrap.querySelector<HTMLDivElement>(".photo-time-actions")!;

  open.textContent = photo.timeSuspect ? "Set the time" : "Change the time";

  // Local, because the line right above this control is local — `takenAt` is a
  // UTC instant and the viewer formats it for the reader. Prefilling from the
  // raw UTC slice showed 15:30 under a caption that said 16:30, so typing what
  // you saw moved the photo an hour.
  const local = new Date(photo.takenAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  date.value = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`;
  // A suspect clock is a fabricated midnight, so offering it as the starting
  // value would invite confirming a number nothing measured.
  // A list of hours, not a time field. `<input type="time">` yields an empty
  // string until *both* halves are filled, and `step="3600"` only governs the
  // stepper — so picking an hour and leaving the minutes alone read as "no time
  // given" and silently saved the date by itself. A select cannot be half
  // answered.
  //
  // Hours because nobody remembers whether the museum was 14:10 or 14:25, and a
  // minute field invites a precision the memory does not have; an hour already
  // puts the photo in the right part of the day.
  //
  // Not `el()` for the options: an <option> parsed inside a <div> is dropped on
  // the floor, which is how the Generate month list once came up empty.
  const unknown = document.createElement("option");
  unknown.value = "";
  unknown.textContent = "Not known";
  clock.appendChild(unknown);
  for (let hour = 0; hour < 24; hour++) {
    const option = document.createElement("option");
    option.value = `${pad(hour)}:00`;
    option.textContent = `${pad(hour)}:00`;
    clock.appendChild(option);
  }
  clock.value = photo.timeSuspect ? "" : `${pad(local.getHours())}:00`;
  status.textContent = "Renames the file in OneDrive, so it survives a rescan.";

  const saveBtn = button("Save", "photo-time-save");
  actions.appendChild(saveBtn);

  editor.hidden = !timeEditorOpen;
  if (lastTimeSave?.id === photo.id) status.textContent = `Saved as ${lastTimeSave.fileName}.`;

  open.addEventListener("click", () => {
    timeEditorOpen = editor.hidden;
    editor.hidden = !timeEditorOpen;
    if (timeEditorOpen) clock.focus();
  });

  saveBtn.addEventListener("click", async () => {
    if (!date.value) {
      status.textContent = "Pick a date first.";
      return;
    }
    // Back to the instant the archive stores. With no time there is nothing to
    // convert — a bare date is a bare date in any zone, and the record keeps
    // the midnight that marks it untimed.
    let sendDate = date.value;
    let sendTime: string | null = null;
    if (clock.value) {
      const instant = new Date(`${date.value}T${clock.value}`);
      sendDate = instant.toISOString().slice(0, 10);
      sendTime = instant.toISOString().slice(11, 16);
    }

    const ok = await save(saveBtn, async () => {
      const result = await setPhotoTakenAt(photo.id, { month, date: sendDate, time: sendTime });

      // Updated in place, not reloaded. There are 123 of these to get through,
      // and a full reload after each one closes the viewer and throws away the
      // place in the day — which makes the job impractical rather than merely
      // slow. The record here is the same object the cached shard holds, so
      // mutating it is what every other view will read.
      photo.fileName = result.fileName;
      photo.takenAt = result.takenAt;
      photo.dateSource = result.dateSource;
      photo.timeSuspect = result.timeSuspect;

      // The shard on disk has moved on too; dropping it means a later read
      // fetches the server's copy rather than trusting this mutation forever.
      forgetMonths(result.months);
      lastTimeSave = { id: photo.id, fileName: result.fileName };
    });

    // Redraw just this panel, so the caption line and the control agree with
    // what was saved. The day around it is not regrouped — that needs the
    // reload the user can do when the batch is finished.
    if (ok) onSaved();
  });

  host.appendChild(wrap);
}
