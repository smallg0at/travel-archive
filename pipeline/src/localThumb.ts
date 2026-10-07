import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

/**
 * Thumbnails rendered **here**, for the items OneDrive refuses to render.
 *
 * Graph's `/thumbnails/0/{size}` does not fail the way the code once assumed.
 * For these items it answers 200 with a transform URL, and the transform CDN
 * then answers **406** carrying a *cached* failure:
 *
 *     Substitution Stream for ImageProcessingFailure found in slot
 *     (Original Time: 2026-09-11 15:59:00Z. Original error code: -2146233088)
 *
 * videos say `VideoThumbnailProcessingFailure` instead. So OneDrive processed
 * the file once, failed, stored the failure in the slot, and has served that
 * same failure to every request since — which is why a retry "gets the same
 * answer" and why the format is a red herring: real HEIF, JPEG bytes wearing a
 * `.HEIC` name, DNG and MP4 all fail alike (measured, 2026-10-07).
 *
 * The fix is local: download the original and render it here.
 *
 * **Nothing in this module may assume the machine can do any of it.** Two of
 * the three decoders are npm packages the pipeline installs itself; `ffmpeg` is
 * a program that may simply not exist on a user's computer, and its absence
 * must cost video posters and DNG, not the server. Everything degrades to
 * `null`, which is the shape every caller already handles.
 */

/** Pixel sizes, matching what Graph's own `medium`/`large` return. */
export const BOX: Record<"medium" | "large", number> = { medium: 176, large: 800 };

export interface RenderCapability {
  /** sharp installed and loadable: JPEG, PNG, WebP, GIF, AVIF, TIFF. */
  images: boolean;
  /** `heic-decode` *and* sharp: HEIC/HEIF — the format this library has 7,249 of. */
  heif: boolean;
  /** Absolute path to a working ffmpeg, or null when there is none. */
  ffmpeg: string | null;
}

/**
 * Re-probed after this long, so a `FFMPEG_PATH` saved in Settings reaches the
 * running server without waiting for a restart.
 */
const CAPABILITY_TTL_MS = 60_000;

let capabilityAt = 0;
let capability: RenderCapability = { images: false, heif: false, ffmpeg: null };

/** Whether an `ffmpeg` binary answers `-version`; memoised per path. */
const ffmpegCache = new Map<string, Promise<string | null>>();

function findFfmpeg(): Promise<string | null> {
  const configured = process.env.FFMPEG_PATH?.trim();
  const candidates = configured ? [configured] : ["ffmpeg"];
  const cached = ffmpegCache.get(candidates[0]);
  if (cached) return cached;

  const attempt = (async (): Promise<string | null> => {
    for (const bin of candidates) {
      const found = await new Promise<string | null>((resolve) => {
        execFile(bin, ["-version"], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
          if (err) return;
          const line = stdout.split(/\r?\n/)[0] ?? "";
          resolve(line.startsWith("ffmpeg version") ? bin : null);
        });
      });
      if (found) return found;
    }
    return null;
  })();

  ffmpegCache.set(candidates[0], attempt);
  return attempt;
}

/**
 * What this machine can render, refreshed at most once a minute.
 *
 * sharp and `heic-decode` are imported here rather than at module scope on
 * purpose: a native module that fails to load (wrong Node ABI, a broken
 * install, an offline `npm install`) must degrade this feature, not take the
 * job server down with it — the server does far more than thumbnails.
 */
export async function renderCapability(): Promise<RenderCapability> {
  if (Date.now() - capabilityAt < CAPABILITY_TTL_MS) return capability;

  let images = false;
  let heif = false;
  try {
    await import("sharp");
    images = true;
  } catch {
    images = false;
  }
  // HEIC is decoded to raw pixels and then resized *by sharp* (heicWorker.ts),
  // so it needs both packages, and a missing sharp costs it too.
  if (images) {
    try {
      await import("heic-decode");
      heif = true;
    } catch {
      heif = false;
    }
  }

  capability = { images, heif, ffmpeg: await findFfmpeg() };
  capabilityAt = Date.now();
  return capability;
}

/** Drops the memoised answer — for a Settings save that changed `FFMPEG_PATH`. */
export function resetRenderCapability(): void {
  capabilityAt = 0;
  ffmpegCache.clear();
}

/** What kind of decoder these bytes want, from their magic number alone. */
export type ImageKind = "sharp" | "heif" | "unknown";

function ascii(bytes: Buffer, start: number, end: number): string {
  return bytes.subarray(start, end).toString("latin1");
}

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1", "heif"]);

/**
 * Sniffs the container, never the file name.
 *
 * The extension is demonstrably unreliable in this library — several `.HEIC`
 * files hold JPEG bytes — and OneDrive's own media processor appears to have
 * been confused by exactly that. The bytes are the only honest evidence.
 */
export function sniffImageKind(bytes: Buffer): ImageKind {
  if (bytes.length < 16) return "unknown";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "sharp"; // JPEG
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "sharp"; // PNG
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "sharp";
  if (ascii(bytes, 0, 4) === "GIF8") return "sharp";
  // TIFF (and therefore DNG): "II*\0" little-endian or "MM\0*" big-endian.
  const tiff =
    (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a);
  if (tiff) return "sharp";
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (HEIF_BRANDS.has(brand)) return "heif";
    // AVIF is a HEIF family member but sharp reads it directly, and
    // libheif-js's WASM build does not always ship the AV1 decoder.
    if (brand === "avif" || brand === "avis") return "sharp";
    return "unknown";
  }
  return "unknown";
}

/** Loads sharp lazily; null when the native module is not usable here. */
async function loadSharp(): Promise<typeof import("sharp").default | null> {
  try {
    const mod = await import("sharp");
    return mod.default;
  } catch {
    return null;
  }
}

async function sharpJpeg(bytes: Buffer, box: number): Promise<Buffer> {
  const sharp = await loadSharp();
  if (!sharp) throw new Error("sharp unavailable");
  return sharp(bytes, { failOn: "none", animated: false })
    .rotate() // EXIF orientation: a portrait shot must not reach the model sideways
    .resize({ width: box, height: box, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
}

/**
 * Runs ffmpeg over a file we already have on disk.
 *
 * DNG is the reason this exists: libvips refuses it outright
 * (`tiff2vips: tile size out of range`), and the JPEG preview embedded in a
 * phone DNG is 16-bit at 203x306, which libvips refuses too. ffmpeg demosaics
 * it: measured 5.4MB DNG -> 3248x2448 JPEG.
 */
async function ffmpegBufferJpeg(bin: string, bytes: Buffer, box: number): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), "thumb-"));
  try {
    const input = join(dir, "input.bin");
    const output = join(dir, "out.jpg");
    await writeFile(input, bytes);
    await ffmpegJpeg(bin, ["-i", input], output, box);
    return await readFile(output);
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** `-ss` before `-i` seeks with Range requests instead of reading the file. */
function ffmpegJpeg(bin: string, inputArgs: string[], output: string, box: number): Promise<void> {
  const scale = `scale=w=${box}:h=${box}:force_original_aspect_ratio=decrease`;
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ["-hide_banner", "-loglevel", "error", ...inputArgs, "-frames:v", "1", "-vf", scale, "-q:v", "3", "-y", output],
      { timeout: 90_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

/**
 * Decodes HEIC off the main thread.
 *
 * libheif's WASM decoder is synchronous, and a 4080x3060 photo blocks for
 * ~1.5s — measured. In a job server that also streams progress over SSE and
 * serves the album grid, that reads as a hung page, and the server already
 * warns about half-second lag. So the decode happens in a worker: the host
 * only ever waits.
 *
 * Falls back to decoding in-process when the worker cannot start at all
 * (running the TypeScript sources under vitest, where `heicWorker.js` does not
 * exist yet) — a slow answer beats no answer, and it keeps this path testable.
 */
function heicViaWorker(bytes: Buffer, box: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: Buffer | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let worker: Worker;
    try {
      worker = new Worker(new URL("./heicWorker.js", import.meta.url), { workerData: { bytes, box } });
    } catch {
      void heicInProcess(bytes, box).then(done);
      return;
    }

    const timer = setTimeout(() => {
      void worker.terminate();
      done(null);
    }, 60_000);

    worker.once("message", (msg: { ok: boolean; jpeg?: Uint8Array }) => {
      clearTimeout(timer);
      void worker.terminate();
      done(msg.ok && msg.jpeg ? Buffer.from(msg.jpeg) : null);
    });
    worker.once("error", () => {
      clearTimeout(timer);
      void heicInProcess(bytes, box).then(done);
    });
    worker.once("exit", () => {
      clearTimeout(timer);
      done(null);
    });
  });
}

/** The same decode as the worker, for when there is no worker to run. */
async function heicInProcess(bytes: Buffer, box: number): Promise<Buffer | null> {
  try {
    const decode = (await import("heic-decode")).default;
    const { width, height, data } = await decode({ buffer: bytes });
    const sharp = await loadSharp();
    if (!sharp) return null;
    const raw = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return await sharp(raw, { raw: { width, height, channels: 4 } })
      .resize({ width: box, height: box, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
  } catch {
    return null;
  }
}

/**
 * A JPEG at most `box` on a side, from photo bytes we already hold.
 *
 * Returns null — never throws — for anything this machine cannot decode, which
 * is the answer callers already give for "OneDrive has no thumbnail".
 */
export async function renderImageThumbnail(bytes: Buffer, box: number): Promise<Buffer | null> {
  const kind = sniffImageKind(bytes);
  try {
    if (kind === "heif") {
      const cap = await renderCapability();
      if (!cap.heif) return null;
      return await heicViaWorker(bytes, box);
    }
    if (kind === "sharp") {
      try {
        return await sharpJpeg(bytes, box);
      } catch {
        // sharp reads TIFF but not DNG's tiled CFA data, so this catch is
        // where a raw file lands; ffmpeg is the only thing that has decoded one.
        const cap = await renderCapability();
        if (!cap.ffmpeg) return null;
        return await ffmpegBufferJpeg(cap.ffmpeg, bytes, box);
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * A poster frame for a video, read from its **pre-authenticated URL** rather
 * than from bytes in memory: ffmpeg seeks with Range requests, so a 382MB
 * original costs one keyframe, and no bearer token ever travels to a CDN host.
 *
 * `-ss 0.1` rather than `-ss 1`: Graph's `video.duration` for a 2016 clip read
 * 537, and seeking past the end produced an empty file with exit code 0. A
 * clip shorter than that falls back to decoding from the start.
 */
export async function renderVideoPoster(url: string, box: number): Promise<Buffer | null> {
  const cap = await renderCapability();
  if (!cap.ffmpeg) return null;

  const dir = await mkdtemp(join(tmpdir(), "poster-"));
  try {
    const output = join(dir, "poster.jpg");
    try {
      await ffmpegJpeg(cap.ffmpeg, ["-ss", "0.1", "-i", url], output, box);
    } catch {
      await ffmpegJpeg(cap.ffmpeg, ["-i", url], output, box);
    }
    return await readFile(output);
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
