import type { PhotoRecord } from "@travel-archive/shared";
import { setPhotosTakenAt } from "./backend";
import { forgetMonths } from "./archiveData";
import { fillHours, isRetimable } from "./dayEdit";
import { el } from "./photoUi";

/**
 * Picking several photos in a grid and giving them one hour.
 *
 * The backlog this is for is 118 WhatsApp saves, and a day's worth of them
 * usually belongs to one part of the day. Retimed one at a time each photo was
 * a round trip to the server that re-read the same 3.4MB index; selected
 * together they are one request (see `setPhotosTakenAt` on the server).
 *
 * Additive to the grid rather than a new gallery: a click that would open the
 * viewer toggles selection instead when a modifier is held, or once anything is
 * selected — the usual photo-library convention. Shift extends a run within the
 * grid. Escape clears.
 *
 * "One hour" means the chosen hour for all of them, a minute apart in the order
 * they sit on the page. The same minute for all would tie their order to
 * whatever breaks a tie; a minute apart keeps the sequence they were saved in
 * and still puts every one of them in the hour that was picked.
 */

interface Entry {
  photo: PhotoRecord;
  img: HTMLImageElement;
}

const selected = new Map<string, Entry>();
/** The last photo clicked, so a shift-click knows where a run starts. */
let anchor: { photos: PhotoRecord[]; index: number } | null = null;
/** The last batch's outcome, kept on the bar until the next change. */
let lastStatus = "";

let bar: HTMLElement | null = null;
let count: HTMLElement;
let dateInput: HTMLInputElement;
let hourSelect: HTMLSelectElement;
let saveBtn: HTMLButtonElement;
let status: HTMLElement;

const pad = (n: number) => String(n).padStart(2, "0");

function localDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function ensureBar(): HTMLElement {
  if (bar) return bar;
  bar = el<HTMLElement>(`
    <div class="retime-bar" role="toolbar" aria-label="Set the time of the selected photos" hidden>
      <span class="retime-count"></span>
      <label><span>Date</span><input type="date" class="retime-date" /></label>
      <label><span>Hour</span><select class="retime-hour"></select></label>
      <button type="button" class="retime-save">Set time</button>
      <button type="button" class="retime-clear">Clear</button>
      <p class="retime-status"></p>
    </div>
  `);
  count = bar.querySelector(".retime-count")!;
  dateInput = bar.querySelector(".retime-date")!;
  hourSelect = bar.querySelector(".retime-hour")!;
  saveBtn = bar.querySelector(".retime-save")!;
  status = bar.querySelector(".retime-status")!;
  fillHours(hourSelect);
  hourSelect.addEventListener("change", update);
  bar.querySelector(".retime-clear")!.addEventListener("click", clear);
  saveBtn.addEventListener("click", () => void apply());
  document.body.appendChild(bar);
  return bar;
}

/** Selected photos in page order, dropping any whose grid has since been redrawn away. */
function ordered(): Entry[] {
  for (const [id, entry] of selected) {
    if (!entry.img.isConnected) selected.delete(id);
  }
  return [...selected.values()].sort((a, b) =>
    a.img.compareDocumentPosition(b.img) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );
}

function update(): void {
  const entries = ordered();
  const b = ensureBar();
  document.body.classList.toggle("retime-selecting", entries.length > 0);
  b.hidden = entries.length === 0 && !lastStatus;
  count.textContent = entries.length ? `${entries.length} selected` : "";
  for (const el of b.querySelectorAll<HTMLElement>("label, .retime-save, .retime-clear")) {
    el.hidden = entries.length === 0;
  }

  // Sixty minutes in an hour, so sixty is as many as fit a minute apart.
  const tooMany = hourSelect.value !== "" && entries.length > 60;
  saveBtn.disabled = entries.length === 0 || tooMany;
  status.textContent = tooMany
    ? "At most 60 photos fit in one hour a minute apart — select fewer, or choose “Not known”."
    : lastStatus;
}

function clear(): void {
  for (const { img } of selected.values()) img.classList.remove("is-selected");
  selected.clear();
  anchor = null;
  lastStatus = "";
  update();
}

function setSelected(photo: PhotoRecord, img: HTMLImageElement, on: boolean): void {
  if (on) selected.set(photo.id, { photo, img });
  else selected.delete(photo.id);
  img.classList.toggle("is-selected", on);
}

/**
 * Handles a grid click if it is a selection gesture. Returns false when the
 * click should open the viewer as usual.
 *
 * `imgs` is the grid's own images, index-aligned with `photos`, so a shift-run
 * can mark the thumbnails it covers.
 */
export function selectionClick(
  event: MouseEvent,
  photos: PhotoRecord[],
  imgs: HTMLImageElement[],
  index: number,
): boolean {
  const photo = photos[index];
  const modifier = event.ctrlKey || event.metaKey || event.shiftKey;
  const selecting = ordered().length > 0;
  if (!modifier && !selecting) return false;
  // A photo dated from EXIF cannot be moved by a rename, so it is not
  // selectable — and while a selection is being built, clicking one does
  // nothing rather than yanking the viewer open over it.
  if (!isRetimable(photo)) return selecting || modifier;
  event.preventDefault();
  lastStatus = "";

  if (!dateInput?.value || !selecting) {
    ensureBar();
    dateInput.value = localDate(photo.takenAt!);
  }

  if (event.shiftKey && anchor && anchor.photos === photos) {
    const [from, to] = anchor.index < index ? [anchor.index, index] : [index, anchor.index];
    for (let i = from; i <= to; i++) {
      if (isRetimable(photos[i])) setSelected(photos[i], imgs[i], true);
    }
  } else {
    setSelected(photo, imgs[index], !selected.has(photo.id));
  }
  anchor = { photos, index };
  update();
  return true;
}

async function apply(): Promise<void> {
  const entries = ordered();
  if (entries.length === 0) return;
  if (!dateInput.value) {
    lastStatus = "Pick a date first.";
    update();
    return;
  }

  // Local wall clock to the UTC instant the archive stores, per photo — the
  // same conversion the single-photo control makes, so both agree with the
  // caption the viewer shows. No hour means a bare date, which has no zone.
  const items = entries.map(({ photo }, i) => {
    const month = photo.takenAt!.slice(0, 7);
    if (!hourSelect.value) return { id: photo.id, month, date: dateInput.value, time: null };
    const instant = new Date(`${dateInput.value}T${hourSelect.value.slice(0, 2)}:${pad(i)}`);
    const iso = instant.toISOString();
    return { id: photo.id, month, date: iso.slice(0, 10), time: iso.slice(11, 16) };
  });

  saveBtn.disabled = true;
  saveBtn.textContent = `Saving ${items.length}…`;
  try {
    const result = await setPhotosTakenAt(items);
    // In place, as the single-photo control does: the record is the object
    // the cached shard holds, and a reload would lose the place in the day.
    for (const r of result.results) {
      const entry = selected.get(r.id);
      if (!entry) continue;
      Object.assign(entry.photo, {
        fileName: r.fileName,
        takenAt: r.takenAt,
        dateSource: r.dateSource,
        timeSuspect: r.timeSuspect,
      });
      setSelected(entry.photo, entry.img, false);
      entry.img.classList.add("is-retimed");
    }
    forgetMonths(result.months);

    // Refusals stay selected, so they can be looked at or tried again.
    const done = `Set ${result.results.length} photo${result.results.length === 1 ? "" : "s"}.`;
    lastStatus = result.errors.length
      ? `${done} ${result.errors.length} refused: ${result.errors[0].error}`
      : `${done} The day regroups on the next reload.`;
  } catch (err) {
    lastStatus = (err as Error).message.slice(0, 160);
  } finally {
    saveBtn.textContent = "Set time";
    update();
  }
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || selected.size === 0) return;
  // The viewer owns Escape while it is open.
  if (document.getElementById("lightbox")?.hidden === false) return;
  clear();
});
