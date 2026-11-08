import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFresh } from "../src/server/mirror.js";

/**
 * A month shard is fetched on demand and never replaced once it is on disk, so
 * a re-derivation that rewrote shards on the writing machine left an installed
 * app serving the old copies while reporting "in-sync". These pin the rule that
 * a shard older than `index.json` is re-fetched.
 */

let home: string;
const before = process.env.ARCHIVE_HOME;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mirror-"));
  process.env.ARCHIVE_HOME = home;
});

afterEach(async () => {
  if (before === undefined) delete process.env.ARCHIVE_HOME;
  else process.env.ARCHIVE_HOME = before;
  await rm(home, { recursive: true, force: true });
});

async function place(relative: string, secondsAgo: number): Promise<void> {
  // Everything the mirror serves lives under `data/`; `isFresh` is given the
  // path as the routes write it ("photos/2026-10.json").
  const file = join(home, "data", relative);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, "{}", "utf-8");
  const when = new Date(Date.now() - secondsAgo * 1000);
  await utimes(file, when, when);
}

describe("isFresh", () => {
  it("trusts a shard written after the index", async () => {
    await place("index.json", 60);
    await place("photos/2026-10.json", 10);
    expect(await isFresh("photos/2026-10.json")).toBe(true);
  });

  it("distrusts a shard older than the index", async () => {
    await place("index.json", 10);
    await place("photos/2026-10.json", 600);
    expect(await isFresh("photos/2026-10.json")).toBe(false);
  });

  it("always trusts the index itself", async () => {
    await place("index.json", 600);
    expect(await isFresh("index.json")).toBe(true);
  });

  it("trusts the only copy when there is no index to compare against", async () => {
    await place("photos/2026-10.json", 600);
    expect(await isFresh("photos/2026-10.json")).toBe(true);
  });
});
