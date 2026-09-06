import type { DayRecord, TripRecord } from "@travel-archive/shared";
import type { TripDefinition } from "../tripDefs.js";
import { findTripFor } from "../tripDefs.js";
import { formatMonthLabel } from "../util.js";

/**
 * Sorts days into trip sections and month buckets.
 *
 * Shared by `organize` (which rebuilds every section after summarizing days)
 * and the trip-narrative job (which re-sorts after a trip's date range is added
 * or moved). Having one copy matters because the two must agree on which
 * section a day belongs to — a day counted into a trip by one and into its
 * month by the other would appear twice in the app's nav.
 */
export function bucketDays(
  days: DayRecord[],
  defs: TripDefinition[],
  existing: TripRecord[] = [],
): TripRecord[] {
  const dated = days.filter((d) => d.date !== "unknown-date").sort((a, b) => a.date.localeCompare(b.date));

  const tripBuckets = new Map<string, DayRecord[]>();
  const otherDays: DayRecord[] = [];

  for (const day of dated) {
    const match = findTripFor(day.date, defs);
    if (match) {
      const list = tripBuckets.get(match.id) ?? [];
      list.push(day);
      tripBuckets.set(match.id, list);
    } else {
      otherDays.push(day);
    }
  }

  // A narrative costs a model call, so re-bucketing must carry it forward
  // rather than blanking it. The trip job decides when it is stale.
  const priorById = new Map(existing.map((s) => [s.id, s] as const));

  const trips: TripRecord[] = defs
    .filter((def) => tripBuckets.has(def.id))
    .map((def) => {
      const tripDays = tripBuckets.get(def.id)!;
      const prior = priorById.get(def.id);
      return {
        id: def.id,
        kind: "trip" as const,
        name: def.name,
        startDate: tripDays[0].date,
        endDate: tripDays[tripDays.length - 1].date,
        days: tripDays,
        narrative: prior?.narrative ?? null,
        places: prior?.places ?? [],
        narrativeGeneratedAt: prior?.narrativeGeneratedAt ?? null,
      };
    });

  const monthMap = new Map<string, DayRecord[]>();
  for (const day of otherDays) {
    const key = day.date.slice(0, 7);
    const list = monthMap.get(key) ?? [];
    list.push(day);
    monthMap.set(key, list);
  }

  const monthSections: TripRecord[] = [...monthMap.entries()].sort().map(([key, monthDays]) => ({
    id: `month-${key}`,
    kind: "month" as const,
    name: formatMonthLabel(key),
    startDate: monthDays[0].date,
    endDate: monthDays[monthDays.length - 1].date,
    days: monthDays,
    narrative: null,
    places: [],
    narrativeGeneratedAt: null,
  }));

  return [...trips, ...monthSections].sort((a, b) => a.startDate.localeCompare(b.startDate));
}
