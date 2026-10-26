import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../src/atomicWrite.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atomic-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("writeFileAtomic", () => {
  it("writes a new file and leaves no temporary behind", async () => {
    const dir = await tempDir();
    const file = join(dir, "index.json");
    await writeFileAtomic(file, '{"a":1}');
    expect(await readFile(file, "utf-8")).toBe('{"a":1}');
    expect(await readdir(dir)).toEqual(["index.json"]);
  });

  it("replaces an existing file in one step", async () => {
    const dir = await tempDir();
    const file = join(dir, "index.json");
    await writeFile(file, '{"old":true}');
    await writeFileAtomic(file, '{"new":true}');
    expect(await readFile(file, "utf-8")).toBe('{"new":true}');
    expect((await readdir(dir)).sort()).toEqual(["index.json"]);
  });

  it("keeps the old file when the replacement cannot land", async () => {
    const dir = await tempDir();
    // A directory in the target's place: the rename fails, and the previous
    // content must still be there rather than half-written.
    await mkdir(join(dir, "photos.json"));
    await expect(writeFileAtomic(join(dir, "photos.json"), "{}")).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["photos.json"]);
  });
});
