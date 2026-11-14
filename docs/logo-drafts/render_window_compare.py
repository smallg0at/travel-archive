#!/usr/bin/env python3
"""Two answers to the same brief: posterised raster window vs Gemini's vector window."""

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


rows = [
    ("raster window (posterised frame)", "logo-d-nordkette"),
    ("vector window (gemini-4-hydrogen)", "gemini-icon"),
]

canvas = Image.new("RGBA", (620, 420), (26, 26, 28, 255))
d = ImageDraw.Draw(canvas)
d.text((24, 14), "Concept D - same card, two ways of drawing the window", fill=(255, 255, 255))

for row, (title, stem) in enumerate(rows):
    top = 46 + row * 186
    d.rounded_rectangle((16, top - 8, 604, top + 168), radius=10, fill=(243, 244, 247, 255))
    canvas.alpha_composite(label(title, (90, 90, 96)), (26, top))
    x = 40
    for size in (256, 128, 64, 32):
        im = Image.open(os.path.join(HERE, f"{stem}-{size}.png")).convert("RGBA")
        canvas.alpha_composite(im, (x, top + 60 - size // 2))
        x += max(size, 40) + 24

canvas.convert("RGB").save(os.path.join(HERE, "logo-d-window-compare.png"))
print("generated logo-d-window-compare.png")
