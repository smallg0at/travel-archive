/**
 * Writes desktop/build/icon.png — a 512x512 app icon, drawn in pure Node.
 *
 * No image dependency: a PNG is a signature plus a few chunks, and the pixel
 * data is just zlib-compressed scanlines each prefixed with a filter byte.
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

// Background tile.
roundRect(0, 0, SIZE, SIZE, 108, INK);

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
}

// Two overlapping hills, the nearer one in the accent.
const hill = (cx, peak, halfWidth, colour) => {
  for (let x = inX0; x < inX1; x++) {
    const t = (x - cx) / halfWidth;
    const top = peak + (1 - Math.exp(-t * t * 2.2)) * (inY1 - peak);
    for (let y = Math.max(inY0, Math.round(top)); y < inY1; y++) set(x, y, colour);
  }
};
hill(inX0 + 120, inY0 + 150, 190, [42, 78, 112]);
hill(inX1 - 110, inY0 + 205, 170, ACCENT);

// --- PNG encoding --------------------------------------------------------
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

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
