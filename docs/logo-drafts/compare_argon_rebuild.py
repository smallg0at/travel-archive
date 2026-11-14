#!/usr/bin/env python3
"""Argon's PNG against the SVG rebuild of it, same sizes."""

import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))


def label(text, colour=(60, 60, 66)):
    font = ImageFont.load_default()
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    left, top, right, bottom = probe.textbbox((0, 0), text, font=font)
    im = Image.new("RGBA", (right - left + 10, 18), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((5 - left, 3), text, font=font, fill=colour + (255,))
    return im


his = Image.open(os.path.join(HERE, "logo-fluent-windows-D.png")).convert("RGBA")

canvas = Image.new("RGBA", (760, 400), (243, 244, 247, 255))
d = ImageDraw.Draw(canvas)
d.text((24, 14), "Argon's PNG (above) and the SVG rebuild (below)", fill=(40, 40, 44))

for row, source in enumerate(("his", "svg")):
    top = 56 + row * 170
    canvas.alpha_composite(label("PNG 512" if source == "his" else "SVG"), (24, top - 20))
    x = 100
    for size in (256, 128, 64, 32):
        if source == "his":
            im = his.resize((size, size), Image.LANCZOS)
        else:
            im = Image.open(os.path.join(HERE, f"argon-frame-{size}.png")).convert("RGBA")
        canvas.alpha_composite(im, (x, top + 130 - size // 2))
        canvas.alpha_composite(label(str(size), (130, 130, 138)), (x, top + 145))
        x += max(size, 44) + 24

canvas.convert("RGB").save(os.path.join(HERE, "compare-argon-rebuild.png"))
print("generated compare-argon-rebuild.png")
