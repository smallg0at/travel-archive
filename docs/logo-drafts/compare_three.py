#!/usr/bin/env python3
"""Three way: Argon's original, his frame restored with his landscape, and his
frame with the cliff landscape."""

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


cols = [
    ("Argon's original (PNG)", lambda s: Image.open(os.path.join(HERE, "logo-fluent-windows-D.png")).convert("RGBA").resize((s, s), Image.LANCZOS)),
    ("his frame, rebuilt", lambda s: Image.open(os.path.join(HERE, f"argon-frame-{s}.png")).convert("RGBA")),
    ("his frame + cliff", lambda s: Image.open(os.path.join(HERE, f"argon-frame-cliff-{s}.png")).convert("RGBA")),
]

canvas = Image.new("RGBA", (3 * 240 + 60, 340), (243, 244, 247, 255))
for i, (title, make) in enumerate(cols):
    x = 24 + i * 240
    canvas.alpha_composite(label(title, (50, 50, 56)), (x, 14))
    y = 40
    for size in (256, 64, 32):
        im = make(size)
        canvas.alpha_composite(im, (x, y))
        y += max(size, 40) + 10

canvas.convert("RGB").save(os.path.join(HERE, "compare-three.png"))
print("generated compare-three.png")
