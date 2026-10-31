/**
 * Small edits to what the archive already holds: a day's notes, a photograph's
 * capture time.
 */

import { editDay, type DayPatch } from "../../jobs/dayEdit.js";
import { setPhotoTakenAt, setPhotosTakenAt } from "../../jobs/photoTime.js";
import { json, readJsonBody, refuseIfBusy, type Route } from "../http.js";
import type { RouteContext } from "./context.js";

/** The routes, in the order they were written; the dispatcher keeps looking after a method mismatch. */
export const contentRoutes = (_ctx: RouteContext): Route[] => [
  /**
   * The owner's note for a day, and their corrections to what the model wrote.
   *
   * Not a job: it spends nothing and finishes in one write, so it answers
   * synchronously rather than handing back a job to poll. It still takes the
   * archive lock — the app is a reader and the server is the only writer.
   */
  [
    /^\/days\/(\d{4}-\d{2}-\d{2})$/,
    "POST",
    async (req, res, [date]) => {
      if (refuseIfBusy(res)) return;
      const body = await readJsonBody<DayPatch>(req);
      try {
        json(res, 200, await editDay(date, body));
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    },
  ],
  /**
   * The day and time a photo was taken, corrected by hand.
   *
   * A rename in OneDrive, not a stored override — see `renameForTakenAt`. Like
   * the day editor it answers synchronously and takes the archive lock; unlike
   * it, it writes to the photo library itself, so it refuses rather than
   * guesses whenever the filename is not the photo's real source of truth.
   */
  [
    /^\/photos\/([^/]+)\/taken$/,
    "POST",
    async (req, res, [id]) => {
      if (refuseIfBusy(res)) return;
      const body = await readJsonBody<{ month?: string; date?: string; time?: string | null }>(req);
      if (!body.month || !body.date) {
        return json(res, 400, { error: "month and date are required" });
      }
      try {
        json(res, 200, await setPhotoTakenAt(decodeURIComponent(id), {
          month: body.month,
          date: body.date,
          time: body.time?.trim() ? body.time.trim() : null,
        }));
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    },
  ],
  /**
   * Many photos at once — see `setPhotosTakenAt` for why this is the fast path
   * and not merely the convenient one. Partial success comes back as 200 with
   * the refusals listed, because the renames that went through are real.
   */
  [
    /^\/photos\/taken$/,
    "POST",
    async (req, res) => {
      if (refuseIfBusy(res)) return;
      const body = await readJsonBody<{
        items?: { id?: string; month?: string; date?: string; time?: string | null }[];
      }>(req);
      if (!Array.isArray(body.items) || body.items.some((i) => !i.id || !i.month || !i.date)) {
        return json(res, 400, { error: "items, each with id, month and date, are required" });
      }
      try {
        json(res, 200, await setPhotosTakenAt(body.items.map((i) => ({
          id: i.id!,
          month: i.month!,
          date: i.date!,
          time: i.time?.trim() ? i.time.trim() : null,
        }))));
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    },
  ],
];
