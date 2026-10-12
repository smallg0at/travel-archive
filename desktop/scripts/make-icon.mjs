/**
 * Writes desktop/build/icon.png — a 512x512 app icon, drawn in pure Node.
 *
 * Mirrors the mobile launcher mark (ic_launcher_mark.xml / build-icons.mjs):
 * the accent background squircle with the route mark (origin ring, 4-dot route,
 * destination disc). No image dependency: a PNG is a signature plus a few
 * chunks, and the pixel data is zlib-compressed scanlines with 4x4 supersampling.
 * electron-builder converts this to the .ico Windows needs.
 *
 *   node desktop/scripts/make-icon.mjs
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 512;
const OUT = resolve(fileURLToPath(new URL("../build/icon.png", import.meta.url)));

/** The app's accent — #0078d4 / --accent in style.css / ic_launcher_background.xml. */
const BLUE = [0x00, 0x78, 0xd4];

// Mirrors ic_launcher_mark.xml and app/scripts/build-icons.mjs.
const RING = { x: 38, y: 70, r: 6.5, stroke: 3.6 };
const DOTS = [[47.07, 60.93], [51.76, 56.24], [56.45, 51.55], [61.14, 46.86]].map(([x, y]) => ({ x, y, r: 2.1 }));
const END = { x: 70, y: 38, r: 8 };

// A legacy / standalone icon shows the 72 units an adaptive icon shows (18..90).
const VIEW = { from: 18, size: 72 };

const insideSquare = (x, y) => {
  const r = 13;
  const cx = Math.min(Math.max(x, 18 + r), 90 - r);
  const cy = Math.min(Math.max(y, 18 + r), 90 - r);
  return Math.hypot(x - cx, y - cy) <= r;
};

function isMark(x, y) {
  const ring = Math.abs(Math.hypot(x - RING.x, y - RING.y) - RING.r) <= RING.stroke / 2;
  return ring || Math.hypot(x - END.x, y - END.y) <= END.r || DOTS.some((d) => Math.hypot(x - d.x, y - d.y) <= d.r);
}

/** RGBA pixels, each averaged from 4x4 samples for smooth anti-aliased edges. */
function draw(px) {
  const S = 4;
  const out = Buffer.alloc(px * px * 4);
  for (let j = 0; j < px; j++) {
    for (let i = 0; i < px; i++) {
      let bg = 0;
      let white = 0;
      for (let sj = 0; sj < S; sj++) {
        for (let si = 0; si < S; si++) {
          const x = VIEW.from + ((i + (si + 0.5) / S) / px) * VIEW.size;
          const y = VIEW.from + ((j + (sj + 0.5) / S) / px) * VIEW.size;
          if (!insideSquare(x, y)) continue;
          bg++;
          if (isMark(x, y)) white++;
        }
      }
      const n = S * S;
      const o = (j * px + i) * 4;
      // Colour from the blue/white mix within the shape; alpha from its cover.
      const w = bg ? white / bg : 0;
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(BLUE[c] * (1 - w) + 255 * w);
      out[o + 3] = Math.round((bg / n) * 255);
    }
  }
  return out;
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(px, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(px, 0);
  header.writeUInt32BE(px, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  // One filter byte (0, none) before each row.
  const raw = Buffer.alloc(px * (px * 4 + 1));
  for (let j = 0; j < px; j++) rgba.copy(raw, j * (px * 4 + 1) + 1, j * px * 4, (j + 1) * px * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(dirname(OUT), { recursive: true });
const iconBuffer = png(SIZE, draw(SIZE));
writeFileSync(OUT, iconBuffer);
console.log(`wrote ${OUT} (${SIZE}x${SIZE}, ${(iconBuffer.length / 1024).toFixed(0)} KB)`);

/**
 * And the .ico, written here rather than converted by electron-builder.
 *
 * Its converter is a WASM blob, and on this machine it dies every time with
 * `WebAssembly.Memory(): could not allocate memory` — an odd thing to depend
 * on for a file this script can write outright. An ICO is a directory of
 * images, and for 32-bit entries Windows takes a PNG or a raw DIB equally, so
 * the small sizes go out as DIBs (the shape that file explorers still sample
 * best at 16px) and the large ones as the PNG already being drawn.
 *
 * With `win.icon` pointing at the .ico, the conversion step never runs.
 */
const ICO_OUT = resolve(fileURLToPath(new URL("../build/icon.ico", import.meta.url)));
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** A 32-bit DIB: BITMAPINFOHEADER, bottom-up BGRA, then an (empty) 1bpp AND mask. */
function dib(px, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(px, 4);
  header.writeInt32LE(px * 2, 8); // height doubled: the AND mask follows the XOR bitmap
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(px * px * 4, 20);
  const xor = Buffer.alloc(px * px * 4);
  for (let j = 0; j < px; j++) {
    for (let i = 0; i < px; i++) {
      const src = ((px - 1 - j) * px + i) * 4; // DIB rows are bottom-up
      const dst = (j * px + i) * 4;
      xor[dst] = rgba[src + 2];
      xor[dst + 1] = rgba[src + 1];
      xor[dst + 2] = rgba[src];
      xor[dst + 3] = rgba[src + 3];
    }
  }
  const maskRow = Math.ceil(px / 32) * 4;
  const mask = Buffer.alloc(maskRow * px); // all zero: the alpha channel carries the shape
  return Buffer.concat([header, xor, mask]);
}

function ico() {
  const images = ICO_SIZES.map((px) => {
    const rgba = draw(px);
    return px >= 128 ? png(px, rgba) : dib(px, rgba);
  });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  images.forEach((image, i) => {
    const px = ICO_SIZES[i];
    const entry = Buffer.alloc(16);
    entry[0] = px >= 256 ? 0 : px; // 0 means 256
    entry[1] = px >= 256 ? 0 : px;
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(image.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += image.length;
    entries.push(entry);
  });
  return Buffer.concat([header, ...entries, ...images]);
}

const icoBuffer = ico();
writeFileSync(ICO_OUT, icoBuffer);
console.log(`wrote ${ICO_OUT} (${ICO_SIZES.join("/")} px, ${(icoBuffer.length / 1024).toFixed(0)} KB)`);
