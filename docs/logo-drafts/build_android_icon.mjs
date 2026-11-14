#!/usr/bin/env node
/**
 * Android launcher icon from the Concept D master.
 *
 * Adaptive icons are a 108dp canvas whose visible area is roughly a 72dp circle,
 * with everything inside 66dp safe: so the mark is rendered at 62% of the canvas
 * and centred. Legacy icons (pre-Android 8) get the mark on the app's light
 * surface colour, and the round variant is the same inside a circle.
 *
 *   node docs/logo-drafts/build_android_icon.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const RES = join(HERE, "..", "..", "app", "android", "app", "src", "main", "res");
const MASTER = join(HERE, "argon-frame-light.svg");

const SURFACE = { r: 227, g: 234, b: 242, alpha: 1 }; // ic_launcher_background, one step deeper than the card

const base = await sharp(readFileSync(MASTER), { density: 288 }).png().toBuffer();
const meta = await sharp(base).metadata();
const square = Math.min(meta.width, meta.height);

/** The mark alone, transparent, `content` px wide inside a `canvas` px square. */
async function centred(canvas, content) {
  const mark = await sharp(base)
    .extract({ left: 0, top: 0, width: square, height: square })
    .resize(Math.round(content), Math.round(content), { kernel: "lanczos3" })
    .png()
    .toBuffer();
  const offset = Math.round((canvas - content) / 2);
  return sharp({ create: { width: canvas, height: canvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: mark, left: offset, top: offset }])
    .png()
    .toBuffer();
}

async function onSurface(canvas, content, circular) {
  const mark = await centred(canvas, content);
  let bg = sharp({ create: { width: canvas, height: canvas, channels: 4, background: SURFACE } }).png();
  if (circular) {
    const mask = Buffer.from(
      `<svg width="${canvas}" height="${canvas}"><circle cx="${canvas / 2}" cy="${canvas / 2}" r="${canvas / 2}"/></svg>`,
    );
    bg = sharp(await bg.toBuffer()).composite([{ input: mask, blend: "dest-in" }]).png();
  } else {
    // Android's own squircle-ish corner: 22% radius, as in the legacy template.
    const r = Math.round(canvas * 0.22);
    const mask = Buffer.from(
      `<svg width="${canvas}" height="${canvas}"><rect width="${canvas}" height="${canvas}" rx="${r}" ry="${r}"/></svg>`,
    );
    bg = sharp(await bg.toBuffer()).composite([{ input: mask, blend: "dest-in" }]).png();
  }
  const surface = await bg.toBuffer();
  return sharp(surface).composite([{ input: mark, left: 0, top: 0 }]).png().toBuffer();
}

const DENSITIES = [
  ["mdpi", 1],
  ["hdpi", 1.5],
  ["xhdpi", 2],
  ["xxhdpi", 3],
  ["xxxhdpi", 4],
];

for (const [bucket, scale] of DENSITIES) {
  const dir = join(RES, `mipmap-${bucket}`);
  mkdirSync(dir, { recursive: true });

  // Adaptive foreground: 108dp canvas, mark at 60% (inside the 66dp safe zone).
  const fgCanvas = Math.round(108 * scale);
  writeFileSync(join(dir, "ic_launcher_foreground.png"), await centred(fgCanvas, fgCanvas * 0.60));

  // Legacy square + round: 48dp, mark at 78%.
  const legacy = Math.round(48 * scale);
  writeFileSync(join(dir, "ic_launcher.png"), await onSurface(legacy, legacy * 0.78, false));
  writeFileSync(join(dir, "ic_launcher_round.png"), await onSurface(legacy, legacy * 0.78, true));
  console.log(bucket, "foreground", fgCanvas, "legacy", legacy);
}

// A preview of what the launcher will show, at 3x density.
const preview = 324;
const fg = await sharp(join(RES, "mipmap-xxhdpi", "ic_launcher_foreground.png")).png().toBuffer();
const fgMeta = await sharp(fg).metadata();
const bgLayer = await sharp({ create: { width: preview, height: preview, channels: 4, background: SURFACE } }).png().toBuffer();
const maskSvg = `<svg width="${preview}" height="${preview}"><circle cx="${preview / 2}" cy="${preview / 2}" r="${preview * 0.47}"/></svg>`;
const composited = await sharp(bgLayer)
  .composite([{ input: Buffer.from(maskSvg), blend: "dest-in" }])
  .composite([{ input: fg, left: Math.round((preview - fgMeta.width) / 2), top: Math.round((preview - fgMeta.height) / 2) }])
  .png()
  .toBuffer();
await sharp(composited).resize(256, 256).toFile(join(HERE, "android-adaptive-preview.png"));

console.log("done");
