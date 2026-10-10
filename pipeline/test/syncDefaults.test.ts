import { describe, expect, it } from "vitest";
import { readSync } from "../src/syncStore.js";

/**
 * A default nobody has to go and set. Sync used to default to "on launch
 * only" (`intervalMinutes: 0`), which meant a machine that stayed open — the
 * normal case — never checked again unless someone found the dropdown in
 * Settings ("don't expect the reader to actually look", 2026-10-10).
 */
describe("a fresh home's sync defaults", () => {
  it("checks hourly, and on launch, without being asked", async () => {
    const sync = await readSync();
    expect(sync.intervalMinutes).toBe(60);
    expect(sync.autoSyncOnLaunch).toBe(true);
  });
});
