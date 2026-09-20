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
