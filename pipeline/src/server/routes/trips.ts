/**
 * Trip definitions: the named date ranges the archive is organised by.
 */

import { defineTrip, deleteTrip, editTrip, renameTrip } from "../../jobs/trip.js";
import { dismissTripSuggestion, listTripSuggestions } from "../../jobs/tripSuggest.js";
import { json, readJsonBody, refuseIfBusy, type Route } from "../http.js";
import * as jobs from "../jobs.js";
import type { RouteContext } from "./context.js";

/** The routes, in the order they were written; the dispatcher keeps looking after a method mismatch. */
export const tripRoutes = (_ctx: RouteContext): Route[] => [
  /**
   * A trip renamed or deleted from its page. Synchronous like the day editor:
   * one write, nothing spent. Delete keeps every day and photo — see deleteTrip.
   */
  [
    /^\/trips\/([^/]+)\/rename$/,
    "POST",
    async (req, res, [id]) => {
      if (refuseIfBusy(res)) return;
      const body = await readJsonBody<{ name?: string }>(req);
      try {
        await renameTrip(decodeURIComponent(id), body.name ?? "");
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    },
  ],
  /**
   * Trips proposed from where the nights were spent (jobs/tripSuggest.ts).
   * Read-only; accepting one defines it without a narrative, which costs
   * nothing either.
   */
  [
    /^\/trips\/suggestions$/,
    "GET",
    async (_req, res) => {
      try {
        json(res, 200, await listTripSuggestions());
      } catch (err) {
        json(res, 500, { error: (err as Error).message });
      }
    },
  ],

  [
    /^\/trips\/suggestions\/dismiss$/,
    "POST",
    async (req, res) => {
      const body = await readJsonBody<{ startDate?: string; endDate?: string }>(req);
      if (!body.startDate || !body.endDate) return json(res, 400, { error: "startDate and endDate are required" });
      await dismissTripSuggestion(body.startDate, body.endDate);
      json(res, 200, { ok: true });
    },
  ],

  [
    /^\/trips\/define$/,
    "POST",
    async (req, res) => {
      if (refuseIfBusy(res)) return;
      const body = await readJsonBody<{ startDate?: string; endDate?: string; name?: string }>(req);
      try {
        json(res, 200, await defineTrip(body.startDate ?? "", body.endDate ?? "", body.name ?? ""));
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    },
  ],

  [
    /^\/trips\/([^/]+)\/delete$/,
    "POST",
    async (_req, res, [id]) => {
      if (refuseIfBusy(res)) return;
      try {
        await deleteTrip(decodeURIComponent(id));
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    },
  ],
  /**
   * The owner's own corrections to a trip's narrative or name, in whichever
   * language they are reading. Synchronous, one write, nothing spent — see
   * editTrip. `lang` picks the sidecar the text belongs to.
   */
  [
    /^\/trips\/([^/]+)\/edit$/,
    "POST",
    async (req, res, [id]) => {
      if (refuseIfBusy(res)) return;
      const body = await readJsonBody<{ narrative?: string | null; name?: string | null; lang?: string | null }>(req);
      try {
        const edits = await editTrip(decodeURIComponent(id), body);
        json(res, 200, { ok: true, edits });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    },
  ],
];
