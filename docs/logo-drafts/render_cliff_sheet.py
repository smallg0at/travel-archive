#!/usr/bin/env python3
"""The cliff reference beside the icon it produced."""

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


ref = Image.open(os.path.join(HERE, r"C:/Users/small/Downloads/11-14-26-202019.png")).convert("RGBA")
ref.thumbnail((180, 180), Image.LANCZOS)
big = Image.open(os.path.join(HERE, "logo-d-cliff-256.png")).convert("RGBA")
small = [Image.open(os.path.join(HERE, f"logo-d-cliff-{s}.png")).convert("RGBA") for s in (128, 64, 48, 32, 16)]

canvas = Image.new("RGBA", (720, 250), (243, 244, 247, 255))
canvas.alpha_composite(label("the frame", (90, 90, 96)), (26, 12))
canvas.alpha_composite(ref, (26, 34))
x = 230
canvas.alpha_composite(big, (x, 20))
canvas.alpha_composite(label("256", (120, 120, 128)), (x + 108, 276 - 30))
x += 256 + 22
for im in small:
    canvas.alpha_composite(im, (x, 130 - im.height // 2))
    x += max(im.width, 40) + 12

canvas.convert("RGB").save(os.path.join(HERE, "logo-d-cliff-sheet.png"))
print("generated logo-d-cliff-sheet.png")
