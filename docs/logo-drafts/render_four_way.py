#!/usr/bin/env python3
"""Four answers side by side, so the choice is visual rather than argued."""

import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
COLUMNS = [
    ("reference", "reference-crop.png"),
    ("raster window", "logo-d-nordkette-256.png"),
    ("vector window (mine)", "logo-d-vector-256.png"),
    ("vector window (gemini)", "gemini-icon-256.png"),
]


def label(text, colour=(150, 150, 158)):
    font = ImageFont.load_default()
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    left, top, right, bottom = probe.textbbox((0, 0), text, font=font)
    im = Image.new("RGBA", (right - left + 10, 18), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((5 - left, 3), text, font=font, fill=colour + (255,))
    return im


def fit(im, box):
    im = im.copy()
    im.thumbnail((box, box), Image.LANCZOS)
    return im


canvas = Image.new("RGBA", (4 * 210 + 40, 300), (243, 244, 247, 255))
d = ImageDraw.Draw(canvas)
for i, (title, name) in enumerate(COLUMNS):
    x = 20 + i * 210
    im = fit(Image.open(os.path.join(HERE, name)).convert("RGBA"), 190)
    canvas.alpha_composite(im, (x + (190 - im.width) // 2, 30 + (190 - im.height) // 2))
    canvas.alpha_composite(label(title, (60, 60, 66)), (x, 236))

small = Image.open(os.path.join(HERE, "logo-d-nordkette-64.png")).convert("RGBA")
small2 = Image.open(os.path.join(HERE, "logo-d-vector-64.png")).convert("RGBA")
small3 = Image.open(os.path.join(HERE, "gemini-icon-64.png")).convert("RGBA")
for i, im in enumerate((small, small2, small3)):
    canvas.alpha_composite(im, (20 + (i + 1) * 210 + 63, 240))

canvas.convert("RGB").save(os.path.join(HERE, "logo-d-four-way.png"))
print("generated logo-d-four-way.png")
