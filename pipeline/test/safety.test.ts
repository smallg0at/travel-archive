import { describe, expect, it } from "vitest";
import { applyEdits, textKey, type DaySegment } from "@travel-archive/shared";

const seg = (over: Partial<DaySegment> = {}): DaySegment =>
  ({
    id: "seg-1",
    title: "Morning",
    summary: "coffee",
    photoIds: ["p1", "p2"],
    ...over,
  }) as DaySegment;

describe("textKey", () => {
  it("is stable and discriminating", () => {
    expect(textKey("hello")).toBe(textKey("hello"));
    expect(textKey("hello")).not.toBe(textKey("world"));
    expect(textKey("")).not.toBe(textKey("hello"));
  });
});

describe("applyEdits", () => {
  it("passes through without edits", () => {
    const segments = [seg()];
    const out = applyEdits("s", segments, null);
    expect(out.summary).toBe("s");
    expect(out.segments).toEqual(segments);
    expect(out.orphaned).toBe(0);
  });

  it("applies a stop edit by anchor photo", () => {
    const out = applyEdits("s", [seg()], {
      stops: [{ anchorPhotoId: "p2", title: "Museum" }],
    });
    expect(out.segments[0].title).toBe("Museum");
    expect(out.orphaned).toBe(0);
  });

  it("counts edits whose anchor photo is gone as orphaned", () => {
    const out = applyEdits("s", [seg()], {
      stops: [{ anchorPhotoId: "gone", title: "Wrong place" }],
    });
    expect(out.orphaned).toBe(1);
    expect(out.segments[0].title).toBe("Morning");
  });
});

describe("live-data guard", () => {
  // 20s, not the 5s default: what this costs is importing graph.ts, which pulls
  // in MSAL's client and token cache, and on a busy machine that alone has
  // taken over five seconds — failing a test whose subject is the guard, not
  // the import's speed. It has timed out locally while a build ran; it has
  // never been wrong.
  it(
    "refuses Graph calls in CI without explicit opt-in",
    async () => {
      const { downloadMetadataJson } = await import("../src/graph.js");
      await expect(downloadMetadataJson("tok", "CI-FAKE-FOLDER-NEVER-USE", "index.json")).rejects.toThrow(
        /Refusing live Graph call/,
      );
    },
    20_000,
  );

  it("uses an isolated ARCHIVE_HOME, not the real checkout", async () => {
    const { archiveHome } = await import("../src/paths.js");
    expect(archiveHome()).not.toMatch(/pipeline$/);
  });
});
