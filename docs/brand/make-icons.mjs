#!/usr/bin/env node
/**
 * The app's icon assets, all from one master.
 *
 * Source of truth: docs/brand/app-icon.svg (Concept D: a Polaroid card carrying
 * the Naze Tower, with a coral pin breaking out of its top-right corner).
 *
 * Writes:
 *   desktop/build/icon.png   512x512, what BrowserWindow uses and what
 *                            electron-builder converts to the installer's icon
 *   desktop/build/icon.ico   16/24/32/48/64/128/256, PNG-compressed ICO
 *   app/public/brand/        copies of both masters, so the app can serve them
 *                            from its own origin (favicon, About pane)
 *
 *   node docs/brand/make-icons.mjs
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const APP_ICON = join(HERE, "app-icon.svg");
const ABOUT_ICON = join(HERE, "about-icon.svg");
const DESKTOP_BUILD = join(ROOT, "desktop", "build");
const APP_BRAND = join(ROOT, "app", "public", "brand");

/** ICO container with PNG payloads: Windows Vista and later read these. */
function ico(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + count * 16;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

const source = readFileSync(APP_ICON);
const base = await sharp(source, { density: 288 }).png().toBuffer();
const meta = await sharp(base).metadata();
const square = Math.min(meta.width, meta.height);
const master = await sharp(base)
  .extract({ left: 0, top: 0, width: square, height: square })
  .png()
  .toBuffer();

mkdirSync(DESKTOP_BUILD, { recursive: true });
mkdirSync(APP_BRAND, { recursive: true });

await sharp(master).resize(512, 512, { kernel: "lanczos3" }).toFile(join(DESKTOP_BUILD, "icon.png"));

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = [];
for (const size of sizes) {
  pngs.push({ size, data: await sharp(master).resize(size, size, { kernel: "lanczos3" }).png().toBuffer() });
}
writeFileSync(join(DESKTOP_BUILD, "icon.ico"), ico(pngs));

copyFileSync(APP_ICON, join(APP_BRAND, "app-icon.svg"));
copyFileSync(ABOUT_ICON, join(APP_BRAND, "about-icon.svg"));

console.log("icons:", sizes.join("/"), "-> desktop/build, app/public/brand");
