#!/usr/bin/env python3
"""Small marks: drawn on the grid vs the master scaled down."""

import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))


def label(text, colour=(90, 90, 96)):
    font = ImageFont.load_default()
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    left, top, right, bottom = probe.textbbox((0, 0), text, font=font)
    im = Image.new("RGBA", (right - left + 8, 16), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((4 - left, 2), text, font=font, fill=colour + (255,))
    return im


rows = [(48, None), (32, "small-32.png"), (24, "small-24.png"), (16, "small-16.png")]
row_h = 180
canvas = Image.new("RGBA", (700, 50 + row_h * len(rows)), (243, 244, 247, 255))
d = ImageDraw.Draw(canvas)
d.text((20, 10), "master scaled (left)   vs   mark drawn on the grid (right)", fill=(30, 30, 34))

y = 40
for size, drawn_name in rows:
    scaled = Image.open(os.path.join(HERE, f"argon-frame-light-{size}.png")).convert("RGBA")
    canvas.alpha_composite(scaled.resize((size * 4, size * 4), Image.NEAREST), (24, y))
    canvas.alpha_composite(scaled, (24 + size * 4 + 14, y + size * 2 - size // 2))
    canvas.alpha_composite(label(f"{size}", (110, 110, 118)), (24 + size * 4 + 14, y + size * 2 + 12))

    if drawn_name:
        drawn = Image.open(os.path.join(HERE, drawn_name)).convert("RGBA")
        canvas.alpha_composite(drawn.resize((size * 4, size * 4), Image.NEAREST), (300, y))
        canvas.alpha_composite(drawn, (300 + size * 4 + 14, y + size * 2 - size // 2))
        canvas.alpha_composite(label(f"{size}", (110, 110, 118)), (300 + size * 4 + 14, y + size * 2 + 12))
    else:
        canvas.alpha_composite(label("master is used at this size", (150, 150, 158)), (300, y + size * 2))

    y += row_h

canvas.convert("RGB").save(os.path.join(HERE, "small-marks.png"))
print("generated small-marks.png")
