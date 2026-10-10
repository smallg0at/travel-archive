import { describe, expect, it } from "vitest";
import { monthUnder } from "../src/graph.js";

/**
 * The rule the scan and the folder probe must share. When they disagreed, the
 * wizard's page 2 showed a green "0 period folders" and page 4 then scanned
 * nothing (2026-10-10: the photos folder was a year, its children bare
 * `01`..`12`, and nobody recognised them).
 */
describe("monthUnder", () => {
  it("reads a flat yyyy-mm under any root", () => {
    expect(monthUnder("图片/本机照片", "2025-03")).toEqual({ month: "2025-03", year: "2025" });
  });

  it("reads a bare month when its parent is a year — the parent being the root too", () => {
    expect(monthUnder("图片/本机照片/2025", "03")).toEqual({ month: "2025-03", year: "2025" });
    // single digit, padded the way shard names are
    expect(monthUnder("Apps/Shot/2016", "9")).toEqual({ month: "2016-09", year: "2016" });
  });

  it("claims nothing where there is no year above it", () => {
    // a bare "03" under a normal root is just a folder named 03
    expect(monthUnder("图片/本机照片", "03")).toBeNull();
    // a year child is a period, not a month
    expect(monthUnder("图片/本机照片", "2025")).toBeNull();
    // files and nonsense
    expect(monthUnder("图片/本机照片", "IMG_1234.jpg")).toBeNull();
    expect(monthUnder("图片/本机照片/2025", "2026")).toBeNull();
  });
});
