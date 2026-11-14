#!/usr/bin/env python3
"""Reference crop beside the icon it produced: 256, 64, 32, on both surfaces."""

import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))


def label(text, colour=(150, 150, 158)):
    font = ImageFont.load_default()
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    left, top, right, bottom = probe.textbbox((0, 0), text, font=font)
    im = Image.new("RGBA", (right - left + 10, 18), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((5 - left, 3), text, font=font, fill=colour + (255,))
    return im


def sheet():
    ref = Image.open(os.path.join(HERE, "reference-crop.png")).convert("RGBA")
    ref = ref.resize((int(ref.width * 168 / ref.height), 168), Image.LANCZOS)
    icon = Image.open(os.path.join(HERE, "logo-d-nordkette-256.png")).convert("RGBA").resize((168, 168), Image.LANCZOS)
    small = [Image.open(os.path.join(HERE, f"logo-d-nordkette-{s}.png")).convert("RGBA") for s in (64, 48, 32)]

    margin, gap = 28, 34
    width = 760
    height = 76 + 220 * 2
    canvas = Image.new("RGBA", (width, height), (26, 26, 28, 255))
    draw = ImageDraw.Draw(canvas)
    draw.text((margin, 16), "Concept D - the frame, and the icon built from it", fill=(255, 255, 255))
    canvas.alpha_composite(label("left: the crop that goes in the window   then the icon at 256, 64, 48, 32"), (margin, 40))

    for row, surface in enumerate(((243, 244, 247, 255), (32, 32, 32, 255))):
        top = 76 + row * 220
        draw.rounded_rectangle((margin - 10, top - 8, width - margin + 10, top + 196), radius=12, fill=surface)
        if row == 0:
            canvas.alpha_composite(ref, (margin + 4, top + 16))
            canvas.alpha_composite(label("reference"), (margin + 4, top + 190))
        x = margin + 210
        canvas.alpha_composite(icon, (x, top + 16))
        x += 168 + gap
        for im in small:
            canvas.alpha_composite(im, (x, top + 100 - im.height // 2))
            canvas.alpha_composite(label(f"{im.width}px", (120, 120, 128)), (x, top + 176))
            x += max(im.width, 48) + gap
    return canvas.convert("RGB")


if __name__ == "__main__":
    out = os.path.join(HERE, "logo-d-compare.png")
    sheet().save(out)
    print("generated", out)
