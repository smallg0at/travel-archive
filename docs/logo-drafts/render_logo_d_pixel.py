#!/usr/bin/env python3
"""
Concept D at 16 and 24 pixels, drawn on the pixel grid instead of downsampled.

The vector version loses everything that identifies it at these sizes: the
Polaroid edge is a hairline, the caption line is noise, the pin hole vanishes.
Fluent's own small icons are not scaled-down 256px art — they are drawn again
with fewer, fatter shapes. This does that: a white frame 2px thick, one blue
photograph, one coral dot, nothing else.

Output: logo-d-16px-pixel.png — smooth vs pixel at 16 and 24, actual size and 8x,
on a light title bar and a dark taskbar.
"""

import os
import sys

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render_logo_d_refined as smooth  # noqa: E402

OUT = os.path.dirname(os.path.abspath(__file__))
WHITE = (255, 255, 255, 255)
FRAME_EDGE = (176, 190, 204, 255)
SKY = (74, 166, 232, 255)
SKY_DARK = (24, 94, 168, 255)
CORAL = (232, 67, 10, 255)
HOLE = (255, 255, 255, 255)


def d_pixel(size):
    """Hand-placed pixels. Everything is snapped to the grid on purpose."""
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if size <= 16:
        # 16: 1px gutter, 2px white frame, 1px photo inset, 3px dot.
        card = (1, 1, size - 1, size - 1)
        d.rounded_rectangle(card, radius=2, fill=WHITE)
        d.rounded_rectangle((2, 2, size - 2, size - 2), radius=1, outline=FRAME_EDGE)
        d.rectangle((3, 3, size - 4, size - 7), fill=SKY)
        d.rectangle((3, size - 9, size - 4, size - 7), fill=SKY_DARK)
        d.ellipse((size - 6, 1, size - 1, 6), fill=CORAL)
        d.point((size - 4, 3), fill=HOLE)
    elif size <= 24:
        card = (1, 1, size - 1, size - 1)
        d.rounded_rectangle(card, radius=3, fill=WHITE)
        d.rounded_rectangle((2, 2, size - 2, size - 2), radius=2, outline=FRAME_EDGE)
        d.rectangle((4, 4, size - 5, size - 9), fill=SKY)
        d.rectangle((4, size - 12, size - 5, size - 9), fill=SKY_DARK)
        d.ellipse((size - 8, 1, size - 1, 8), fill=CORAL)
        d.ellipse((size - 6, 3, size - 3, 6), fill=HOLE)
    else:
        raise ValueError("this is the small-size pass; use the vector one above 24")
    return im


def text_img(text, colour=(210, 210, 214)):
    font = ImageFont.load_default()
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    left, top, right, bottom = probe.textbbox((0, 0), text, font=font)
    im = Image.new("RGBA", (right - left + 10, 18), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((5 - left, 3), text, font=font, fill=colour + (255,))
    return im


def sheet():
    """One row per surface: 16 smooth, 16 pixel, 24 smooth, 24 pixel."""
    items = [(16, "vector"), (16, "pixel"), (24, "vector"), (24, "pixel")]
    margin = 26
    gap = 28
    big_w = sum(size * 8 + gap for size, _ in items) - gap
    w = margin * 2 + 150 + big_w
    h = 150 + 150 + 190
    canvas = Image.new("RGBA", (w, h), (26, 26, 28, 255))
    d = ImageDraw.Draw(canvas)
    d.text((margin, 14), "Concept D at 16 and 24px - vector downscale vs drawn on the grid", fill=(255, 255, 255))
    canvas.alpha_composite(
        text_img("each pair: the vector mark scaled down, then the pixel pass (actual size, then 8x)", (150, 150, 158)),
        (margin, 36),
    )

    top = 74
    for surface, label in (( (243, 244, 247, 255), "light #F3F4F7"), ((32, 32, 32, 255), "dark #202020")):
        d.rounded_rectangle((margin - 10, top - 10, w - margin + 10, top + 132), radius=10, fill=surface)
        canvas.alpha_composite(text_img(label, (110, 110, 118)), (margin, top - 6))
        x = margin + 150
        for size, kind in items:
            icon = smooth.d_windows(size) if kind == "vector" else d_pixel(size)
            big = icon.resize((size * 8, size * 8), Image.NEAREST)
            canvas.alpha_composite(big, (x, top + 18))
            canvas.alpha_composite(icon, (x + (big.width - size) // 2, top + 18 + big.height + 10))
            canvas.alpha_composite(text_img(f"{size} {kind}", (120, 120, 128)), (x, top + 18 + big.height + 30))
            x += big.width + gap
        top += 160
    return canvas.convert("RGB")


if __name__ == "__main__":
    out = os.path.join(OUT, "logo-d-16px-pixel.png")
    sheet().save(out)
    for s in (16, 24):
        d_pixel(s).save(os.path.join(OUT, f"logo-d-pixel-{s}.png"))
    print("generated", out)
