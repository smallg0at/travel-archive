/**
 * Writes desktop/build/icon.png — a 512x512 app icon, drawn in pure Node.
 *
 * No image dependency: a PNG is a signature plus a few chunks, and the pixel
 * data is just zlib-compressed scanlines each prefixed with a filter byte.
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

// The app's accent, and the paper it prints on.
const INK = [20, 20, 15];
const ACCENT = [55, 138, 222];
const PAPER = [246, 245, 240];
const SKY = [122, 170, 214];
/** The app's accent — #0078d4 / --accent in style.css / ic_launcher_background.xml. */
const BLUE = [0x00, 0x78, 0xd4];

const px = Buffer.alloc(SIZE * SIZE * 4);
const set = (x, y, [r, g, b], a = 255) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  // Source-over, so later shapes blend onto earlier ones.
  const sa = a / 255;
  px[i] = px[i] * (1 - sa) + r * sa;
  px[i + 1] = px[i + 1] * (1 - sa) + g * sa;
  px[i + 2] = px[i + 2] * (1 - sa) + b * sa;
  px[i + 3] = Math.max(px[i + 3], a);
};
// Mirrors ic_launcher_mark.xml and app/scripts/build-icons.mjs.
const RING = { x: 38, y: 70, r: 6.5, stroke: 3.6 };
const DOTS = [[47.07, 60.93], [51.76, 56.24], [56.45, 51.55], [61.14, 46.86]].map(([x, y]) => ({ x, y, r: 2.1 }));
const END = { x: 70, y: 38, r: 8 };

/** Rounded rectangle with a soft edge, so it does not look aliased. */
function roundRect(x0, y0, x1, y1, r, colour) {
  for (let y = Math.floor(y0); y < y1; y++) {
    for (let x = Math.floor(x0); x < x1; x++) {
      const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
      const dy = Math.max(y0 + r - y, 0, y - (y1 - r));
      const d = Math.hypot(dx, dy);
      const a = d <= r - 1 ? 255 : d >= r + 1 ? 0 : Math.round(255 * (r + 1 - d) / 2);
      if (a > 0) set(x, y, colour, a);
    }
  }
}
// A legacy / standalone icon shows the 72 units an adaptive icon shows (18..90).
const VIEW = { from: 18, size: 72 };

// Background tile.
roundRect(0, 0, SIZE, SIZE, 108, INK);
const insideSquare = (x, y) => {
  const r = 13;
  const cx = Math.min(Math.max(x, 18 + r), 90 - r);
  const cy = Math.min(Math.max(y, 18 + r), 90 - r);
  return Math.hypot(x - cx, y - cy) <= r;
};

// A photograph sitting on it: paper, a sky, a horizon, hills, a sun.
const M = 96;
const PW = SIZE - M * 2;
roundRect(M, M + 24, M + PW, M + 24 + PW - 48, 26, PAPER);

const inX0 = M + 22, inX1 = M + PW - 22, inY0 = M + 46, inY1 = M + PW - 46;
for (let y = inY0; y < inY1; y++) for (let x = inX0; x < inX1; x++) set(x, y, SKY);

// Sun.
const sx = inX1 - 78, sy = inY0 + 74, sr = 34;
for (let y = sy - sr - 1; y <= sy + sr + 1; y++) {
  for (let x = sx - sr - 1; x <= sx + sr + 1; x++) {
    const d = Math.hypot(x - sx, y - sy);
    if (d <= sr + 1) set(x, y, PAPER, d <= sr - 1 ? 255 : Math.round(255 * (sr + 1 - d) / 2));
  }
function isMark(x, y) {
  const ring = Math.abs(Math.hypot(x - RING.x, y - RING.y) - RING.r) <= RING.stroke / 2;
  return ring || Math.hypot(x - END.x, y - END.y) <= END.r || DOTS.some((d) => Math.hypot(x - d.x, y - d.y) <= d.r);
}

// Two overlapping hills, the nearer one in the accent.
const hill = (cx, peak, halfWidth, colour) => {
  for (let x = inX0; x < inX1; x++) {
    const t = (x - cx) / halfWidth;
    const top = peak + (1 - Math.exp(-t * t * 2.2)) * (inY1 - peak);
    for (let y = Math.max(inY0, Math.round(top)); y < inY1; y++) set(x, y, colour);
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
};
hill(inX0 + 120, inY0 + 150, 190, [42, 78, 112]);
hill(inX1 - 110, inY0 + 205, 170, ACCENT);

// --- PNG encoding --------------------------------------------------------
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  return out;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
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

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`wrote ${OUT} (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(0)} KB)`);
const iconBuffer = png(SIZE, draw(SIZE));
writeFileSync(OUT, iconBuffer);
console.log(`wrote ${OUT} (${SIZE}x${SIZE}, ${(iconBuffer.length / 1024).toFixed(0)} KB)`);
