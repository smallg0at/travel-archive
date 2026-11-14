#!/usr/bin/env python3
"""The traced frame, and Gemini's icon built from it."""

import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
DL = r"C:/Users/small/Downloads"


def label(text, colour=(120, 120, 128)):
    font = ImageFont.load_default()
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    left, top, right, bottom = probe.textbbox((0, 0), text, font=font)
    im = Image.new("RGBA", (right - left + 10, 18), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((5 - left, 3), text, font=font, fill=colour + (255,))
    return im


canvas = Image.new("RGBA", (900, 330), (243, 244, 247, 255))

for i, name in enumerate(("11-14-26-203322.png", "11-14-26-203322_edge.png")):
    im = Image.open(os.path.join(DL, name)).convert("RGBA")
    im.thumbnail((150, 150), Image.LANCZOS)
    canvas.alpha_composite(im, (24, 40 + i * 160))
    canvas.alpha_composite(label("frame" if i == 0 else "frame, with the line that matters"), (24, 24 + i * 160))

big = Image.open(os.path.join(HERE, "gemini-cliff-256.png")).convert("RGBA")
canvas.alpha_composite(big, (200, 30))

x = 480
for size in (128, 64, 48, 32, 16):
    path = os.path.join(HERE, f"gemini-cliff-{size}.png")
    if not os.path.exists(path):
        continue
    im = Image.open(path).convert("RGBA")
    canvas.alpha_composite(im, (x, 160 - im.height // 2))
    canvas.alpha_composite(label(f"{size}"), (x, 250))
    x += max(im.width, 40) + 16

canvas.convert("RGB").save(os.path.join(HERE, "logo-d-gemini-sheet.png"))
print("generated logo-d-gemini-sheet.png")
