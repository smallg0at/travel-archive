import { parentPort, workerData } from "node:worker_threads";
import decode from "heic-decode";
import sharp from "sharp";

/**
 * HEIC -> JPEG, in a thread of its own.
 *
 * libheif's WASM decoder runs synchronously and a 4080x3060 photo measured
 * 1.5s of blocked event loop; doing that on the job server would stall every
 * request it was serving, including its own progress stream. The host process
 * (`localThumb.ts`) starts this worker, waits for one message and terminates
 * it — no pool, because the items that need it number in the tens.
 *
 * Resize and encode happen here as well, so what crosses the thread boundary
 * is the ~90KB JPEG rather than the 50MB of RGBA pixels.
 */
interface Job {
  bytes: Buffer;
  box: number;
}

const { bytes, box } = workerData as Job;

(async () => {
  try {
    const { width, height, data } = await decode({ buffer: bytes });
    // A Uint8ClampedArray over its own ArrayBuffer, which sharp accepts as
    // `raw` input with the alpha channel it was decoded with.
    const raw = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const jpeg = await sharp(raw, { raw: { width, height, channels: 4 } })
      .resize({ width: box, height: box, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    parentPort?.postMessage({ ok: true, jpeg });
  } catch (err) {
    parentPort?.postMessage({ ok: false, error: (err as Error).message });
  }
})();
