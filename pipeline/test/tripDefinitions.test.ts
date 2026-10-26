import { beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { dataFile } from "../src/paths.js";
import { definitionsFromIndex, loadTripDefinitions } from "../src/tripDefs.js";

/**
 * The trip list is local (`data/trips.json`) while the index is shared, so an
 * absent or empty local list used to rebuild every section without trips and
 * upload that — the 2026-10-27 wipe. These tests pin the two rules that make
 * that impossible: a broken file is an error, and a missing/empty one is
 * recovered from the index's own trip sections.
 */
const TRIPS = dataFile("trips.json");
const INDEX = dataFile("index.json");

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value), "utf-8");
}

const indexWith = (...sections: unknown[]) => ({ schemaVersion: 14, generatedAt: "2026-10-27T00:00:00Z", months: [], sections });

const trip = (id: string, name: string, startDate: string, endDate: string) => ({
  id,
  kind: "trip",
  name,
  startDate,
  endDate,
  days: [],
});

beforeEach(async () => {
  await rm(TRIPS, { force: true });
  await rm(INDEX, { force: true });
});

describe("definitionsFromIndex", () => {
  it("keeps trip sections and ignores months", () => {
    const defs = definitionsFromIndex(
      indexWith({ id: "2026-09", kind: "month", name: "September 2026", days: [] }, trip("t1", "A trip", "2026-09-01", "2026-09-05")) as never,
    );
    expect(defs).toEqual([{ id: "t1", name: "A trip", startDate: "2026-09-01", endDate: "2026-09-05" }]);
  });
});

describe("loadTripDefinitions", () => {
  it("recovers a missing file from the index, and writes it back", async () => {
    await writeJson(INDEX, indexWith(trip("t1", "A trip", "2026-09-01", "2026-09-05")));
    const defs = await loadTripDefinitions();
    expect(defs.map((d) => d.id)).toEqual(["t1"]);
    expect(JSON.parse(await readFile(TRIPS, "utf-8"))).toEqual(defs);
  });

  it("recovers an empty file from the index", async () => {
    await writeJson(TRIPS, []);
    await writeJson(INDEX, indexWith(trip("t1", "A trip", "2026-09-01", "2026-09-05"), trip("t2", "Another", "2026-10-01", "2026-10-02")));
    const defs = await loadTripDefinitions();
    expect(defs.map((d) => d.id)).toEqual(["t1", "t2"]);
  });

  it("returns an empty list only when neither file has trips", async () => {
    expect(await loadTripDefinitions()).toEqual([]);
    await writeJson(INDEX, indexWith({ id: "2026-09", kind: "month", name: "September", days: [] }));
    expect(await loadTripDefinitions()).toEqual([]);
  });

  it("refuses to read a corrupt file as 'no trips'", async () => {
    await writeJson(INDEX, indexWith(trip("t1", "A trip", "2026-09-01", "2026-09-05")));
    await writeFile(TRIPS, '[{"id": "t1", "name": "truncat', "utf-8");
    await expect(loadTripDefinitions()).rejects.toThrow(/Refusing to treat a broken trip list/);
  });
});
