#!/usr/bin/env python3
"""Argon's original D, downscaled the way the app would use it, next to ours."""

import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ARGON = os.path.join(HERE, "logo-fluent-windows-D.png")
OURS = os.path.join(HERE, "gemini-cliff")


def label(text, colour=(120, 120, 128)):
    font = ImageFont.load_default()
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    left, top, right, bottom = probe.textbbox((0, 0), text, font=font)
    im = Image.new("RGBA", (right - left + 10, 18), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((5 - left, 3), text, font=font, fill=colour + (255,))
    return im


canvas = Image.new("RGBA", (760, 420), (243, 244, 247, 255))
d = ImageDraw.Draw(canvas)
d.text((24, 14), "Argon's D (512 PNG) vs the current vector master, at the sizes that ship", fill=(40, 40, 44))

argon = Image.open(ARGON).convert("RGBA")

rows = [("Argon, downscaled", argon), ("vector master", None)]
for row, (title, base) in enumerate(rows):
    top = 60 + row * 180
    canvas.alpha_composite(label(title, (70, 70, 76)), (24, top - 22))
    x = 24
    for size in (256, 128, 64, 32, 16):
        if base is not None:
            im = base.resize((size, size), Image.LANCZOS)
        else:
            im = Image.open(f"{OURS}-{size}.png").convert("RGBA") if os.path.exists(f"{OURS}-{size}.png") else None
            if im is None:
                continue
        canvas.alpha_composite(im, (x, top + 120 - size // 2))
        canvas.alpha_composite(label(str(size), (140, 140, 148)), (x, top + 150))
        x += max(size, 44) + 26

canvas.convert("RGB").save(os.path.join(HERE, "compare-argon-vs-vector.png"))
print("generated compare-argon-vs-vector.png")
