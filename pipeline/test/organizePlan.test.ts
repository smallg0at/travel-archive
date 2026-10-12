import { describe, expect, it } from "vitest";
import { decideDay, type DayOutcome } from "../src/jobs/organize.js";
import type { DayRecord, DaySegment } from "@travel-archive/shared";

/**
 * Which days a summarize run pays for.
 *
 * These came out of a plan the owner read: it offered days labelled "4 photos",
 * "5 photos", "17 photos" beside a line saying days of 15 photos or fewer are
 * skipped. The rule counted every photo in the day's folder (31, 20, 17) while
 * the label counted the ones a summary could be written from, so a thin day
 * slipped through and two numbers in the same dialog disagreed. The rule now
 * measures what the summarizer can use. The cases below pin that down, plus the
 * ones that must not change: a trip day is always worth a summary, and a day
 * with nothing analyzed is reported as needing Analyze rather than as small.
 */

/** A segment in the shape this build writes, so a stored day reads as current. */
const currentSegment = (): DaySegment =>
  ({
    id: "stop-1",
    kind: "place",
    title: "A stop",
    summary: null,
    startTime: "09:00",
    endTime: "10:00",
    photoIds: ["a"],
    highlights: [
      { size: "full", title: "The thing", description: null, photoIds: ["a"], documentPhotoIds: [], documentTranslation: null },
    ],
  }) as DaySegment;

const decide = (args: {
  date?: string;
  prior?: DayRecord | undefined;
  analyzedCount: number;
  inTrip?: boolean;
  only?: string | null;
  days?: string[] | null;
  note?: string | null;
}): DayOutcome =>
  decideDay({
    date: args.date ?? "2026-10-08",
    prior: args.prior,
    analyzedCount: args.analyzedCount,
    inTrip: args.inTrip ?? false,
    place: "Home",
    note: args.note ?? null,
    summarizedIds: ["a", "b"].slice(0, Math.max(1, args.analyzedCount)),
    opts: { only: args.only ?? null, days: args.days ?? null, force: false },
  });

/** A stored day, current in every other respect, with the notes as given. */
const storedDay = (notes: { note?: string | null; summarizedNote?: string | null } = {}): DayRecord =>
  ({
    date: "2026-10-08",
    place: "Home",
    note: notes.note ?? null,
    summarizedNote: notes.summarizedNote ?? null,
    summary: "A day.",
    segments: [currentSegment()],
    summarizedPhotoIds: ["a", "b"],
  }) as unknown as DayRecord;

describe("decideDay", () => {
  it("skips a day outside a trip whose usable photos are too few", () => {
    // 31 photos in the folder, 4 the summarizer could use — the case reported.
    expect(decide({ analyzedCount: 4 })).toBe("skip-small");
    expect(decide({ analyzedCount: 15 })).toBe("skip-small");
  });

  it("summarizes one with more usable photos than the floor", () => {
    expect(decide({ analyzedCount: 16 })).toBe("rewrite");
  });

  it("summarizes a small day that sits inside a trip", () => {
    // A trip day is worth the call whatever its size; the rule is about the
    // days between trips.
    expect(decide({ analyzedCount: 2, inTrip: true })).toBe("rewrite");
  });

  it("reports a day with nothing analyzed as needing Analyze, not as too small", () => {
    // The reason it stays blank is the one worth telling the reader: analysis
    // has not run, and running it would change this answer.
    expect(decide({ analyzedCount: 0 })).toBe("skip-no-analyzed");
  });

  it("leaves an unchanged day alone", () => {
    expect(decide({ prior: storedDay(), analyzedCount: 2 })).toBe("reuse");
  });

  it("keeps an explicit day list from bypassing the rules", () => {
    // Ticking a day in the plan sends it as `days`; the size rule still applies,
    // since the plan only offers days that passed it.
    expect(decide({ analyzedCount: 4, days: ["2026-10-08"] })).toBe("skip-small");
  });

  it("leaves a day alone when the note only lost whitespace", () => {
    // 2026-08-28, verbatim: one blank line deleted out of a 1,228-character
    // note put a 241-photo day on the plan.
    const prior = storedDay({ summarizedNote: "Day one.\n\nMuseum, then home." });
    expect(decide({ prior, analyzedCount: 2, note: "Day one.\nMuseum, then home." })).toBe("reuse");
  });

  it("re-summarizes when the note itself changed", () => {
    const prior = storedDay({ summarizedNote: "Day one. Museum." });
    expect(decide({ prior, analyzedCount: 20, note: "Day one. Museum, again." })).toBe("rewrite");
    expect(decide({ prior, analyzedCount: 20, note: "Day one. The museum." })).toBe("rewrite");
  });

  it("re-summarizes when a note appears where there was none", () => {
    const prior = storedDay({ summarizedNote: null });
    expect(decide({ prior, analyzedCount: 20, note: "Went to the museum." })).toBe("rewrite");
  });

  it("leaves out-of-scope days to their own run", () => {
    expect(decide({ analyzedCount: 40, only: "2026-09" })).toBe("skip-out-of-scope");
  });
});
