import type { ArchiveIndexFile, DayEdits, DayRecord, StopEdit } from "@travel-archive/shared";
import { loadIndex, saveIndex } from "../archiveStore.js";
import { getAccessToken } from "../auth.js";
import { withArchiveLock } from "../lock.js";

/**
 * The owner's own words: a note for the summarizer, and corrections to what it
 * wrote.
 *
 * Kept apart from `organize` deliberately. `organize` spends money and rewrites
 * whole days; this spends nothing and touches one field, and the two must not
 * share a path — the reason to correct a title by hand is usually that you do
 * *not* want to pay to have the day written again.
 *
 * Writes go through the server because the server is the only writer (see
 * HANDOFF.md): the app is a reader, and a second writer clobbering a shard has
 * actually happened here.
 */

/**
 * One change. `undefined` means "leave this alone"; an explicit `null` clears.
 *
 * The distinction is the whole interface: a form that always sends every field
 * cannot express "I did not touch the note", and would erase one every time the
 * title was corrected.
 */
export interface DayPatch {
  /** Text for the summarizer. `null` or blank removes it. */
  note?: string | null;
  /** Freeze the day's summary at this text. `null` hands it back to the model. */
  summary?: string | null;
  /** Per-stop corrections, each anchored to a photo — see `StopEdit`. */
  stops?: { anchorPhotoId: string; title?: string | null; summary?: string | null }[];
}

export interface DayEditResult {
  date: string;
  note: string | null;
  edits: DayEdits | null;
  /** True when the change means the next `organize` run will rewrite this day. */
  stale: boolean;
}

function findDay(index: ArchiveIndexFile, date: string): DayRecord | null {
  for (const section of index.sections) {
    const day = section.days.find((d) => d.date === date);
    if (day) return day;
  }
  return null;
}

/** Drops a stop edit that no longer says anything, so cleared fields do not accumulate. */
function prune(edits: DayEdits): DayEdits | null {
  const stops = (edits.stops ?? []).filter((s) => s.title !== undefined || s.summary !== undefined);
  const next: DayEdits = {};
  if (edits.summary !== undefined) next.summary = edits.summary;
  if (stops.length) next.stops = stops;
  return next.summary === undefined && !next.stops ? null : next;
}

function applyStopPatch(edits: DayEdits, patch: NonNullable<DayPatch["stops"]>[number]): void {
  const stops = (edits.stops ??= []);
  let entry = stops.find((s) => s.anchorPhotoId === patch.anchorPhotoId);
  if (!entry) {
    entry = { anchorPhotoId: patch.anchorPhotoId } satisfies StopEdit;
    stops.push(entry);
  }
  // `null` clears the freeze rather than freezing the empty string, so the
  // field goes back to being the model's to write.
  if (patch.title !== undefined) {
    if (patch.title === null) delete entry.title;
    else entry.title = patch.title;
  }
  if (patch.summary !== undefined) {
    if (patch.summary === null) delete entry.summary;
    else entry.summary = patch.summary;
  }
}

/**
 * Applies a patch to one day and writes the index.
 *
 * The visible text is updated in place as well as frozen, so a correction shows
 * immediately instead of waiting for a run that costs money. Clearing a freeze
 * is the one asymmetric case: the model's original text was never stored, so
 * the words stay on screen until the day is next summarized — the day is
 * reported `stale` so the caller can offer that.
 */
export async function editDay(date: string, patch: DayPatch): Promise<DayEditResult> {
  return withArchiveLock("edit day", async () => {
    // The Graph copy, not the mirror: this is a write path, and a mirror gone
    // stale on another machine would be merged onto and uploaded over the
    // newer index (HANDOFF.md, "A read-only path must read the mirror").
    const token = await getAccessToken();
    const index = await loadIndex(token);
    const day = findDay(index, date);
    if (!day) throw new Error(`No day ${date} in the archive. Run organize for it first.`);

    if (patch.note !== undefined) {
      const note = patch.note?.trim();
      day.note = note ? note : null;
    }

    const edits: DayEdits = { ...(day.edits ?? {}) };
    if (edits.stops) edits.stops = edits.stops.map((s) => ({ ...s }));

    if (patch.summary !== undefined) {
      if (patch.summary === null) delete edits.summary;
      else {
        edits.summary = patch.summary;
        day.summary = patch.summary;
      }
    }

    for (const stopPatch of patch.stops ?? []) {
      applyStopPatch(edits, stopPatch);
      const segment = day.segments.find((seg) => seg.photoIds.includes(stopPatch.anchorPhotoId));
      if (!segment) {
        throw new Error(`No stop in ${date} contains photo ${stopPatch.anchorPhotoId}.`);
      }
      if (typeof stopPatch.title === "string") segment.title = stopPatch.title;
      if (stopPatch.summary !== undefined && stopPatch.summary !== null) segment.summary = stopPatch.summary;
    }

    day.edits = prune(edits);
    await saveIndex(token, index);

    return {
      date,
      note: day.note ?? null,
      edits: day.edits,
      stale: (day.summarizedNote ?? null) !== (day.note ?? null),
    };
  });
}
