import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { dataFile } from "../src/paths.js";
import { readOobe } from "../src/oobeStore.js";

/**
 * oobe.json exists to say one thing: a human confirmed the photo folder, and
 * the first scan may start. Its read path has to be as forgiving as
 * syncStore's, because the file simply does not exist until the setup wizard
 * writes it — "nothing confirmed yet" is the normal state of a fresh install,
 * not an error.
 */
describe("oobe store", () => {
  it("reads as empty when the file has never been written", async () => {
    // The vitest setup points ARCHIVE_HOME at a fresh temp dir per run.
    await expect(readOobe()).resolves.toEqual({});
  });

  it("treats a corrupt file the same as an absent one", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const path = dataFile("oobe.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{ not json", "utf-8");

    // A fresh module cache, so the previous assertion's read is not reused:
    // the file was written after `readOobe` may already have memoised.
    const { vi } = await import("vitest");
    vi.resetModules();
    const fresh = await import("../src/oobeStore.js");
    await expect(fresh.readOobe()).resolves.toEqual({});

    // And the file is left exactly as found — reading never repairs or
    // overwrites state it does not own.
    await expect(readFile(path, "utf-8")).resolves.toBe("{ not json");
  });
});
