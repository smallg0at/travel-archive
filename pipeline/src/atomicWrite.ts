import { mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Replace a file in one step.
 *
 * `writeFile` truncates the target first, so a crash, a full disk or a killed
 * process leaves a half-written JSON file — and the archive's local files are
 * the copy the server reads on the next start. Writing beside the target and
 * renaming over it means a reader sees either the old file or the new one,
 * never a prefix of the new one. The rename is atomic on the same volume, which
 * is why the temporary lives in the same directory.
 *
 * `sync` before the rename is deliberate: without it the renamed file can
 * point at blocks that were never flushed, so a power cut at the wrong moment
 * still produces an empty file. These are month-sized JSON files, not a hot
 * log, so the cost is paid once per job step rather than per request.
 */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const handle = await open(temp, "w");
    try {
      await handle.writeFile(data, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}
