import { describe, expect, it } from "vitest";
import { parseDaySummary, parseTripSummary } from "../src/providers/summarise.js";
import type { SummarizeDayInput, SummarizeTripInput } from "../src/providers/types.js";

/**
 * A reply the model got slightly wrong used to die as
 * "Cannot read properties of undefined (reading 'trim')" — true, but it names
 * neither the field nor the day, and reads like a bug in this code rather than
 * a malformed reply. The day is isolated and retried either way
 * (jobs/organize.ts keeps its old text and leaves it stale), so these tests are
 * about the message being worth reading, and about a blank never becoming
 * content: an empty title written into the archive reads as a real stop with
 * nothing to say.
 */

const day = (): SummarizeDayInput => ({
  date: "2025-04-01",
  place: "Somewhere",
  stops: [
    {
      id: "stop-1",
      kind: "place",
      startTime: "09:00",
      endTime: "11:00",
      photos: [{ id: "p1", caption: "a caption", tags: [], contentType: "photo" }],
    },
  ],
  timeUncertain: false,
  placeFromMetadataOnly: false,
  note: null,
});

const trip = (): SummarizeTripInput => ({
  name: null,
  startDate: "2025-04-01",
  endDate: "2025-04-03",
  days: [],
  notes: null,
  documents: [],
});

const goodSegment = { id: "stop-1", title: "The museum", summary: null, highlights: [] };

describe("parseDaySummary", () => {
  it("names the missing field rather than dying on .trim()", () => {
    const withoutSummary = { segments: [goodSegment] };
    expect(() => parseDaySummary(day(), withoutSummary)).toThrow(/day summary/);
    expect(() => parseDaySummary(day(), withoutSummary)).not.toThrow(/reading 'trim'/);
  });

  it("names the stop whose segment came back without a title", () => {
    const bad = { summary: "A day.", segments: [{ id: "stop-1", summary: null, highlights: [] }] };
    expect(() => parseDaySummary(day(), bad)).toThrow(/title for stop stop-1/);
  });

  it("names the stop when a highlight has no title either", () => {
    const bad = {
      summary: "A day.",
      segments: [
        { ...goodSegment, highlights: [{ size: "full", description: null, photo_ids: ["p1"], document_photo_ids: [], document_translation: null }] },
      ],
    };
    expect(() => parseDaySummary(day(), bad)).toThrow(/title for a highlight at stop stop-1/);
  });

  it("treats a blank title as missing, so no empty one reaches the archive", () => {
    const blank = { summary: "A day.", segments: [{ ...goodSegment, title: "   " }] };
    expect(() => parseDaySummary(day(), blank)).toThrow(/title for stop stop-1/);
  });

  it("keeps a good reply, and drops a segment this day has no stop for", () => {
    const good = {
      summary: "A day.",
      segments: [
        { ...goodSegment, summary: "  Inside.  " },
        { id: "not-this-day", title: "Elsewhere", summary: null, highlights: [] },
      ],
    };
    const parsed = parseDaySummary(day(), good);
    expect(parsed.summary).toBe("A day.");
    expect(parsed.segments.map((s) => s.id)).toEqual(["stop-1"]);
    expect(parsed.segments[0]!.summary).toBe("Inside.");
  });
});

describe("parseTripSummary", () => {
  it("names a missing trip name, and a missing narrative", () => {
    expect(() => parseTripSummary(trip(), { narrative: "Once.", places: [] })).toThrow(/trip name/);
    expect(() => parseTripSummary(trip(), { name: "A trip", places: [] })).toThrow(/trip narrative/);
  });

  it("prefers the name the caller gave over the one the model echoed back", () => {
    const parsed = parseTripSummary({ ...trip(), name: "Given" }, { name: "Echoed", narrative: "Once.", places: [] });
    expect(parsed.name).toBe("Given");
  });
});
