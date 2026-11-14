#!/usr/bin/env node
/**
 * Rasterise the Concept D master and put it next to the sizes it has to survive.
 *
 * sharp is already a pipeline dependency (it renders HEIC/JPEG for the archive),
 * so it rasterises this SVG without another image tool on the machine — there is
 * no Inkscape, resvg or ImageMagick here.
 *
 *   node docs/logo-drafts/render_svg_d.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const SVG = join(HERE, "logo-d-nordkette.svg");
const source = readFileSync(SVG);

/** One 1024px render, then Lanczos to each size: sharp's SVG density on a
 *  512-unit document explodes past its pixel limit if driven per size. */
const base = await sharp(source, { density: 144 }).png().toBuffer();

export async function render(size) {
  return sharp(base)
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: "lanczos3" })
    .png()
    .toBuffer();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const size of [512, 256, 128, 64, 48, 32]) {
    writeFileSync(join(HERE, `logo-d-nordkette-${size}.png`), await render(size));
  }
  console.log("rendered 512/256/128/64/48/32");
}
