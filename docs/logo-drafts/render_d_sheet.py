#!/usr/bin/env python3
"""Contact sheet for the Concept D master: the sizes it ships at, on both surfaces."""

import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SIZES = [256, 128, 64, 48, 32]


def load(size):
    return Image.open(os.path.join(HERE, f"logo-d-nordkette-{size}.png")).convert("RGBA")


def label(text, colour=(150, 150, 158)):
    font = ImageFont.load_default()
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    left, top, right, bottom = probe.textbbox((0, 0), text, font=font)
    im = Image.new("RGBA", (right - left + 10, 18), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((5 - left, 3), text, font=font, fill=colour + (255,))
    return im


def sheet():
    margin, gap, row_h = 28, 30, 220
    width = 940
    height = 76 + row_h * 2 + 24
    canvas = Image.new("RGBA", (width, height), (26, 26, 28, 255))
    draw = ImageDraw.Draw(canvas)
    draw.text((margin, 16), "Concept D - landscape redrawn from the Nordkette frame", fill=(255, 255, 255))
    canvas.alpha_composite(
        label("256 master, then 128 / 64 / 48 / 32 as they ship; the same mark on a light title bar and a dark taskbar"),
        (margin, 40),
    )

    for row, surface in enumerate(((243, 244, 247, 255), (32, 32, 32, 255))):
        top = 76 + row * row_h
        draw.rounded_rectangle((margin - 10, top - 8, width - margin + 10, top + 196), radius=12, fill=surface)
        hero = load(256).resize((168, 168), Image.LANCZOS)
        canvas.alpha_composite(hero, (margin + 12, top + 10))
        x = margin + 300
        for size in SIZES[1:]:
            icon = load(size)
            canvas.alpha_composite(icon, (x, top + 96 - size // 2))
            canvas.alpha_composite(label(f"{size}px", (120, 120, 128)), (x, top + 176))
            x += max(size, 48) + gap + 30
    return canvas.convert("RGB")


if __name__ == "__main__":
    out = os.path.join(HERE, "logo-d-nordkette-sheet.png")
    sheet().save(out)
    print("generated", out)
