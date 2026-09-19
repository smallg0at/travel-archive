// Draws the phone app's legacy launcher icons: the PNGs Android 6-7.1 use,
// which predate adaptive icons. Android 8 and later draw the vector
// (android/app/src/main/res/drawable/ic_launcher_mark.xml) and never read these.
//
//   node app/scripts/build-icons.mjs
//
// Rasterised here rather than exported from an editor so the PNGs cannot drift
// from the vector: the geometry below is the vector's, in the same 108-unit
// adaptive-icon space, and a change to one should be made to both. No image
// library — the shapes are a rounded square or a disc, a ring and five discs,
// and Node's zlib is all a PNG needs.

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RES = join(dirname(fileURLToPath(import.meta.url)), "../android/app/src/main/res");

/** The app's accent — --accent in style.css, ic_launcher_background.xml. */
const BLUE = [0x00, 0x78, 0xd4];

// Mirrors ic_launcher_mark.xml.
const RING = { x: 38, y: 70, r: 6.5, stroke: 3.6 };
const DOTS = [[47.07,60.93], [51.76,56.24], [56.45,51.55], [61.14,46.86]].map(([x, y]) => ({ x, y, r: 2.1 }));
const END = { x: 70, y: 38, r: 8 };

// A legacy icon has no launcher mask, so it shows the 72 units an adaptive
// icon shows (18..90) and draws its own outline.
const VIEW = { from: 18, size: 72 };

const inside = {
  square: (x, y) => {
    const r = 13;
    const cx = Math.min(Math.max(x, 18 + r), 90 - r);
    const cy = Math.min(Math.max(y, 18 + r), 90 - r);
    return Math.hypot(x - cx, y - cy) <= r;
  },
  round: (x, y) => Math.hypot(x - 54, y - 54) <= 36,
};

function isMark(x, y) {
  const ring = Math.abs(Math.hypot(x - RING.x, y - RING.y) - RING.r) <= RING.stroke / 2;
  return ring || Math.hypot(x - END.x, y - END.y) <= END.r || DOTS.some((d) => Math.hypot(x - d.x, y - d.y) <= d.r);
}

/** RGBA pixels, each averaged from 4x4 samples so the edges are smooth. */
function draw(px, shape) {
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
          if (!inside[shape](x, y)) continue;
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

const SIZES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [density, px] of Object.entries(SIZES)) {
  for (const [name, shape] of [["ic_launcher", "square"], ["ic_launcher_round", "round"]]) {
    const file = join(RES, `mipmap-${density}`, `${name}.png`);
    writeFileSync(file, png(px, draw(px, shape)));
    console.log(`${density.padEnd(8)} ${px}px  ${name}.png`);
  }
}
