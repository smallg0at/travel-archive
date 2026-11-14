#!/usr/bin/env python3
"""The small-size mark as it was designed: drawn on the pixel grid, not scaled.

Currently unused — 48px still reads from the master and 32 is the smallest place
any launcher or title bar uses. Kept because the drawing is real work: at 16px
the card's margin and the tower both collapse, and what survives is three shapes.

  16  card 14x14 r2, one sky band, one land band, 4px dot
  24  card 22x22 r3, sky, land, dot with a 1px hole
  32  card 30x30 r4, sky, land with one shoulder, 1px caption, 2px tag
"""

import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))

WHITE = (255, 255, 255, 255)
EDGE = (188, 202, 214, 255)
SKY = (92, 200, 240, 255)
SKY_LOW = (44, 172, 226, 255)
LAND = (18, 156, 155, 255)
LAND_HI = (30, 178, 170, 255)
LAND_LOW = (5, 82, 88, 255)
CORAL = (232, 67, 10, 255)
CAPTION = (118, 138, 158, 255)
AMBER = (240, 161, 30, 255)


def mark(size):
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)

    if size <= 16:
        d.rounded_rectangle((1, 1, size - 2, size - 2), radius=2, fill=WHITE, outline=EDGE, width=1)
        d.rectangle((3, 3, size - 4, 7), fill=SKY)
        d.rectangle((3, 8, size - 4, 11), fill=LAND)
        d.rectangle((3, 11, size - 4, 12), fill=LAND_LOW)
        d.ellipse((size - 6, 0, size - 2, 4), fill=CORAL)
        return im

    if size <= 24:
        d.rounded_rectangle((1, 1, size - 2, size - 2), radius=3, fill=WHITE, outline=EDGE, width=1)
        d.rectangle((4, 4, size - 5, 10), fill=SKY)
        d.rectangle((4, 11, size - 5, 11), fill=SKY_LOW)
        d.rectangle((4, 12, size - 5, 16), fill=LAND)
        d.rectangle((4, 17, size - 5, 18), fill=LAND_LOW)
        d.rectangle((5, 19, size - 8, 19), fill=CAPTION)
        px, py, pr = size - 5, 4, 3
        d.ellipse((px - pr, py - pr, px + pr, py + pr), fill=CORAL)
        d.ellipse((px - 1, py - 1, px + 1, py + 1), fill=WHITE)
        return im

    d.rounded_rectangle((1, 1, size - 2, size - 2), radius=4, fill=WHITE, outline=EDGE, width=1)
    d.rectangle((4, 4, size - 5, 12), fill=SKY)
    d.rectangle((4, 13, size - 5, 14), fill=SKY_LOW)
    d.rectangle((4, 15, size - 5, 20), fill=LAND)
    d.rectangle((11, 13, size - 5, 15), fill=LAND)
    d.rectangle((4, 14, 12, 15), fill=LAND_HI)
    d.rectangle((4, 21, size - 5, 22), fill=LAND_LOW)
    d.rectangle((5, 24, size - 12, 25), fill=CAPTION)
    d.rectangle((size - 11, 23, size - 7, 25), fill=AMBER)
    px, py, pr = size - 6, 5, 4
    d.ellipse((px - pr, py - pr, px + pr, py + pr), fill=CORAL)
    d.ellipse((px - 1, py - 1, px + 1, py + 1), fill=WHITE)
    return im


if __name__ == "__main__":
    for s in (32, 24, 16):
        mark(s).save(os.path.join(HERE, f"check-small-{s}.png"))
    print("written check-small-32/24/16.png")
