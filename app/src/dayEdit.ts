import type { DayRecord, DaySegment, PhotoRecord, TripRecord } from "@travel-archive/shared";
import { deleteTrip, editDay, getJob, renameTrip, setPhotoTakenAt, startOrganize, type DayPatch } from "./backend";
import { el } from "./photoUi";
import { forgetMonths } from "./archiveData";
import { contentLanguage } from "./contentLang";
import { ui } from "./i18n";

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

/**
 * Edits made while reading a translation are that language's edits: they are
 * saved beside it and shown over it, and the original is left alone.
 */
function inReadersLanguage(patch: DayPatch): DayPatch {
  const lang = contentLanguage();
  return lang === "en" ? patch : { ...patch, lang };
}

/**
 * The text to send for a field. In a translation, emptying a field hands it
 * back to the translation (`null`) rather than freezing it blank — there is
 * always a translation to fall back to, where the original has only the model.
 */
function fieldPatch(value: string): string | null {
  return contentLanguage() !== "en" && !value.trim() ? null : value;
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
  action.textContent = ui.common.saving;
  try {
    await patch();
    return true;
  } catch (err) {
    action.textContent = (err as Error).message.slice(0, 80);
    action.disabled = false;
    return false;
  } finally {
    if (action.textContent === ui.common.saving) action.textContent = label;
  }
}

/**
 * Renaming or deleting a trip, from its own page.
 *
 * Delete asks for a second press within five seconds rather than a dialog —
 * it discards a paid-for narrative, and the desktop shell's window is not
 * somewhere to rely on `confirm()`. Either way no photo and no day summary is
 * touched: the days go back to their months (deleteTrip on the server).
 *
 * `name` is the trip's own name, not the translation on screen, since that is
 * what gets renamed.
 */
export function addTripControls(header: HTMLElement, actions: HTMLElement, trip: TripRecord, name: string): void {
  if (!available) return;

  const rename = el<HTMLButtonElement>(`
    <button class="btn-action trip-rename-btn" type="button" title="${ui.edit.renameTrip}">
      <svg viewBox="0 0 20 20" width="13" height="13" aria-hidden="true">
        <path fill="currentColor" d="M13.586 3.586a2 2 0 1 1 2.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793 3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/>
      </svg>
      <span>${ui.edit.rename}</span>
    </button>
  `);

  const remove = el<HTMLButtonElement>(`
    <button class="btn-action btn-danger trip-delete-btn" type="button" title="${ui.edit.deleteTrip}">
      <svg viewBox="0 0 20 20" width="13" height="13" aria-hidden="true">
        <path fill="currentColor" fill-rule="evenodd" d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193V3.75A2.75 2.75 0 0 0 11.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 0 0-1.5.12l.5 7.5a.75.75 0 0 0 1.5-.12l-.5-7.5zm4.34.12a.75.75 0 1 0-1.5-.12l-.5 7.5a.75.75 0 0 0 1.5-.12l.5-7.5z" clip-rule="evenodd"/>
      </svg>
      <span>${ui.edit.deleteTrip ?? "删除"}</span>
    </button>
  `);

  actions.appendChild(rename);
  actions.appendChild(remove);

  const panel = el<HTMLDivElement>(`
    <div class="day-editor trip-editor" hidden>
      <label class="day-field">
        <span>${ui.edit.tripNameLabel}</span>
        <input type="text" class="trip-name-edit" />
      </label>
      <div class="day-editor-actions"></div>
    </div>
  `);
  const input = panel.querySelector<HTMLInputElement>(".trip-name-edit")!;
  input.value = name;
  const saveBtn = button(ui.common.save, "day-save");
  const cancel = button(ui.common.cancel, "day-cancel");
  panel.querySelector(".day-editor-actions")!.append(saveBtn, cancel);
  header.after(panel);

  rename.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) input.focus();
  });
  cancel.addEventListener("click", () => {
    input.value = name;
    panel.hidden = true;
  });
  saveBtn.addEventListener("click", async () => {
    if (await save(saveBtn, async () => void (await renameTrip(trip.id, input.value)))) refresh?.();
  });

  let armed: ReturnType<typeof setTimeout> | null = null;
  remove.addEventListener("click", async () => {
    if (!armed) {
      remove.classList.add("armed");
      remove.querySelector("span")!.textContent = ui.edit.confirmDeleteTrip;
      armed = setTimeout(() => {
        armed = null;
        remove.classList.remove("armed");
        remove.querySelector("span")!.textContent = ui.edit.deleteTrip ?? "删除";
      }, 5000);
      return;
    }
    clearTimeout(armed);
    armed = null;
    if (await save(remove, async () => void (await deleteTrip(trip.id)))) refresh?.();
  });
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
  const edit = button(ui.common.edit, "day-edit-open");
  bar.appendChild(edit);
  header.appendChild(bar);

  const panel = el<HTMLDivElement>(`
    <div class="day-editor" hidden>
      <label class="day-field">
        <span>${ui.edit.noteLabel}</span>
        <textarea rows="2" class="day-note" placeholder="${ui.edit.notePlaceholder}"></textarea>
      </label>
      <label class="day-field">
        <span>${ui.edit.summaryLabel}</span>
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

  const saveBtn = button(ui.common.save, "day-save");
  const cancel = button(ui.common.cancel, "day-cancel");
  const regen = button(ui.edit.rewrite, "day-regen");
  actions.append(saveBtn, cancel, regen);

  edit.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    edit.textContent = panel.hidden ? ui.common.edit : ui.common.close;
    if (!panel.hidden) note.focus();
  });

  cancel.addEventListener("click", () => {
    reset();
    panel.hidden = true;
    edit.textContent = ui.common.edit;
  });

  saveBtn.addEventListener("click", async () => {
    // Only what changed. Sending every field would clear the note each time a
    // summary was corrected, which is exactly the bug the patch shape exists
    // to prevent.
    const patch: DayPatch = {};
    if ((note.value.trim() || null) !== (day.note ?? null)) patch.note = note.value;
    if (summary.value !== (day.summary ?? "")) patch.summary = fieldPatch(summary.value);
    if (Object.keys(patch).length === 0) {
      status.hidden = false;
      status.textContent = ui.edit.nothingChanged;
      return;
    }

    const ok = await save(saveBtn, async () => {
      const result = await editDay(day.date, inReadersLanguage(patch));
      day.note = result.note;
      // A `null` handed the text back to the translation, which only a reload
      // redraws — so the page keeps what it shows rather than blanking it.
      if (patch.summary !== undefined && patch.summary !== null) {
        day.summary = summary.value;
        const shown = header.querySelector(".day-summary");
        if (shown) shown.textContent = summary.value;
      }
      status.hidden = false;
      status.textContent = result.stale ? ui.edit.savedStale : ui.edit.saved;
    });
    if (ok) saveBtn.textContent = ui.common.save;
  });

  regen.addEventListener("click", async () => {
    status.hidden = false;
    status.textContent = ui.edit.rewriting;
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
          job.status === "cancelled"
            ? ui.edit.rewriteCancelled
            : ui.edit.rewriteFailed(job.error ?? ui.edit.unknownError);
        return;
      }
      status.textContent = ui.edit.rewritten;
      refresh?.();
    } catch (err) {
      status.textContent = ui.edit.rewriteFailed((err as Error).message);
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

  const open = button(ui.edit.rename, "stop-edit-open");
  head.appendChild(open);

  const editor = el<HTMLDivElement>(`
    <div class="stop-editor" hidden>
      <input type="text" class="stop-title-edit" />
      <textarea rows="2" class="stop-summary-edit" placeholder="${ui.edit.stopSummaryPlaceholder}"></textarea>
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

  const saveBtn = button(ui.common.save, "stop-save");
  const cancel = button(ui.common.cancel, "stop-cancel");
  actions.append(saveBtn, cancel);

  const close = () => {
    editor.hidden = true;
    open.textContent = ui.edit.rename;
  };

  open.addEventListener("click", () => {
    editor.hidden = !editor.hidden;
    open.textContent = editor.hidden ? ui.edit.rename : ui.common.close;
    if (!editor.hidden) title.focus();
  });
  cancel.addEventListener("click", () => {
    reset();
    close();
  });

  saveBtn.addEventListener("click", async () => {
    const stop: NonNullable<DayPatch["stops"]>[number] = { anchorPhotoId };
    if (title.value !== segment.title) stop.title = fieldPatch(title.value);
    if (summary.value !== (segment.summary ?? "")) stop.summary = fieldPatch(summary.value);
    if (stop.title === undefined && stop.summary === undefined) {
      status.hidden = false;
      status.textContent = ui.edit.nothingChanged;
      return;
    }

    const ok = await save(saveBtn, async () => {
      await editDay(date, inReadersLanguage({ stops: [stop] }));
      if (stop.title !== undefined && stop.title !== null) {
        segment.title = title.value;
        section.querySelector(".stop-title")!.textContent = title.value;
      }
      if (stop.summary !== undefined && stop.summary !== null) {
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

/**
 * Whether a photo's time can be corrected from here: the server is present,
 * and the photo is dated from its filename, which a rename can change. EXIF
 * outranks the name, so renaming such a photo would move nothing.
 */
export function isRetimable(photo: PhotoRecord): boolean {
  return (
    available &&
    !!photo.takenAt &&
    (photo.dateSource === "filename" || photo.dateSource === "filename-date")
  );
}

/**
 * "Not known" and the 24 hours.
 *
 * A list of hours, not a time field. `<input type="time">` yields an empty
 * string until *both* halves are filled, and `step="3600"` only governs the
 * stepper — so picking an hour and leaving the minutes alone read as "no time
 * given" and silently saved the date by itself. A select cannot be half
 * answered.
 *
 * Hours because nobody remembers whether the museum was 14:10 or 14:25, and a
 * minute field invites a precision the memory does not have; an hour already
 * puts the photo in the right part of the day.
 *
 * Not `el()` for the options: an <option> parsed inside a <div> is dropped on
 * the floor, which is how the Generate month list once came up empty.
 */
export function fillHours(select: HTMLSelectElement): void {
  const unknown = document.createElement("option");
  unknown.value = "";
  unknown.textContent = ui.time.notKnown;
  select.appendChild(unknown);
  for (let hour = 0; hour < 24; hour++) {
    const option = document.createElement("option");
    option.value = `${String(hour).padStart(2, "0")}:00`;
    option.textContent = option.value;
    select.appendChild(option);
  }
}

export function addPhotoTimeControl(host: HTMLElement, photo: PhotoRecord, onSaved: () => void): void {
  if (!isRetimable(photo) || !photo.takenAt) return;

  const month = photo.takenAt.slice(0, 7);
  const wrap = el<HTMLDivElement>(`
    <div class="photo-time">
      <button type="button" class="photo-time-open"></button>
      <div class="photo-time-editor" hidden>
        <label><span>${ui.common.date}</span><input type="date" class="photo-time-date" /></label>
        <label><span>${ui.time.hourLabel}</span><select class="photo-time-clock"></select></label>
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

  open.textContent = photo.timeSuspect ? ui.time.set : ui.time.change;

  // The camera's clock, as stored and as the line above now shows it:
  // `takenAt` is wall-clock time with UTC digits. This used to convert to the
  // reader's zone to match a caption that did the same; both now read the
  // stored clock, so what you see is what you type is what is saved.
  const taken = new Date(photo.takenAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  date.value = `${taken.getUTCFullYear()}-${pad(taken.getUTCMonth() + 1)}-${pad(taken.getUTCDate())}`;
  fillHours(clock);
  // A suspect clock is a fabricated midnight, so offering it as the starting
  // value would invite confirming a number nothing measured.
  clock.value = photo.timeSuspect ? "" : `${pad(taken.getUTCHours())}:00`;
  status.textContent = ui.time.note;

  const saveBtn = button(ui.common.save, "photo-time-save");
  actions.appendChild(saveBtn);

  editor.hidden = !timeEditorOpen;
  if (lastTimeSave?.id === photo.id) status.textContent = ui.time.savedAs(lastTimeSave.fileName);

  open.addEventListener("click", () => {
    timeEditorOpen = editor.hidden;
    editor.hidden = !timeEditorOpen;
    if (timeEditorOpen) clock.focus();
  });

  saveBtn.addEventListener("click", async () => {
    if (!date.value) {
      status.textContent = ui.time.pickDate;
      return;
    }
    // Sent as typed: the archive stores the camera's clock, so there is no
    // zone to convert between. No time keeps the untimed midnight.
    const sendDate = date.value;
    const sendTime: string | null = clock.value || null;

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
