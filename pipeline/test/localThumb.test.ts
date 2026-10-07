import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { renderCapability, renderImageThumbnail, resetRenderCapability, sniffImageKind, BOX } from "../src/localThumb.js";

/**
 * What can be tested without OneDrive: the sniffer, the sharp path, and the
 * degradations. The HEIC path is exercised by hand instead — see the note on
 * `heicWorker.ts` — because a real HEIC is somebody's photograph and this
 * repository commits no personal media (`Nothing personal is committed`).
 * Measured on 2026-10-07 against live items: 4080x3060 HEIC -> 90,173-byte
 * JPEG, correct orientation, in 9.9s including the original download.
 */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);

describe("sniffImageKind", () => {
  it("reads the magic number, not the name", () => {
    expect(sniffImageKind(Buffer.from("ffd8ffe10000ff00ff00ff00ff00ff00", "hex"))).toBe("sharp");
    expect(sniffImageKind(PNG)).toBe("sharp");
    expect(sniffImageKind(Buffer.from("GIF89a............", "latin1"))).toBe("sharp");
    expect(sniffImageKind(Buffer.from("II*\u0000............", "latin1"))).toBe("sharp"); // TIFF / DNG
    expect(sniffImageKind(Buffer.from("MM\u0000*............", "latin1"))).toBe("sharp"); // big-endian
  });

  it("recognises HEIF by its ftyp brand", () => {
    // The shape every .HEIC in this library starts with: size, "ftyp", "heic".
    expect(sniffImageKind(Buffer.from("00000018667479706865696300000000", "hex"))).toBe("heif");
    expect(sniffImageKind(Buffer.from("00000018667479706d69663100000000", "hex"))).toBe("heif");
    // AVIF is a cousin, but sharp decodes it and libheif-js may lack AV1.
    expect(sniffImageKind(Buffer.from("00000020667479706176696600000000", "hex"))).toBe("sharp");
  });

  it("does not guess at containers it cannot render", () => {
    expect(sniffImageKind(Buffer.from("00000018667479706d70343200000000", "hex"))).toBe("unknown"); // mp4
    expect(sniffImageKind(Buffer.from("not an image at all"))).toBe("unknown");
    expect(sniffImageKind(Buffer.alloc(4))).toBe("unknown");
  });
});

describe("renderImageThumbnail", () => {
  it("resizes to fit the box without enlarging, and returns a JPEG", async () => {
    const source = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: { r: 40, g: 90, b: 150 } },
    })
      .jpeg()
      .toBuffer();

    const out = await renderImageThumbnail(source, BOX.large);
    expect(out).not.toBeNull();
    const meta = await sharp(out!).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(BOX.large);
    expect(meta.height).toBe(Math.round((BOX.large * 800) / 1200));
  });

  it("honours the medium box", async () => {
    const source = await sharp({
      create: { width: 640, height: 640, channels: 3, background: { r: 10, g: 10, b: 10 } },
    })
      .jpeg()
      .toBuffer();
    const meta = await sharp((await renderImageThumbnail(source, BOX.medium))!).metadata();
    expect(meta.width).toBe(BOX.medium);
  });

  it("returns null rather than throwing for bytes nothing can decode", async () => {
    await expect(renderImageThumbnail(Buffer.from("II*\u0000 this is not a tiff", "latin1"), BOX.large)).resolves.toBeNull();
    await expect(renderImageThumbnail(Buffer.alloc(0), BOX.large)).resolves.toBeNull();
    // An mp4 handed to the image path by mistake: a video's bytes are never
    // meant to arrive here — they are streamed to ffmpeg instead — but if they
    // do, the answer is still null rather than a stack trace.
    await expect(
      renderImageThumbnail(Buffer.from("00000018667479706d70343200000000", "hex"), BOX.large),
    ).resolves.toBeNull();
  });
});

describe("renderCapability", () => {
  it("reports what this machine can do, and always in the same shape", async () => {
    const cap = await renderCapability();
    expect(typeof cap.images).toBe("boolean");
    expect(typeof cap.heif).toBe("boolean");
    expect(cap.ffmpeg === null || typeof cap.ffmpeg === "string").toBe(true);
    // sharp is a dependency of this workspace and is what every JPEG path
    // needs; if it is missing, that is an install failure worth failing on.
    expect(cap.images).toBe(true);
    // HEIC needs both packages: decoded to raw pixels, then resized by sharp.
    expect(cap.heif).toBe(cap.images);
  });

  it("answers when ffmpeg is absent, instead of waiting for it", async () => {
    // The probe's error branch used to `return` without resolving, so on any
    // machine where ffmpeg is missing — which is what a CI runner is — this
    // call waited for ever, and `/health`, which calls it, waited with it.
    // Point it at a name that cannot exist anywhere and require an answer.
    process.env.FFMPEG_PATH = "definitely-not-ffmpeg";
    resetRenderCapability();
    try {
      const cap = await renderCapability();
      expect(cap.ffmpeg).toBeNull();
      // The decoders are a separate question: sharp's answer must not change
      // because a program on PATH was not found.
      expect(cap.images).toBe(true);
    } finally {
      delete process.env.FFMPEG_PATH;
      resetRenderCapability();
    }
  });
});
