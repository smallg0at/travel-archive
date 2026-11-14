#!/usr/bin/env python3
"""
Concept D, taken to the two places the showcase never tested:

  1. real small sizes (32/24/16), where the layered Polaroid collapses into mush;
  2. a mobile tile that keeps the depth of the Windows version instead of
     flattening the Polaroid into the whole squircle.

Output: logo-d-small-sizes.png — both variants, on a light title bar (#F3F4F7)
and a dark taskbar (#202020), plus 4x nearest-neighbour enlargements of the
small ones so the pixel damage is visible rather than guessed at.

Run:  python docs/logo-drafts/render_logo_d_refined.py
"""

import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render_logos_v2 as base  # noqa: E402

OUT = os.path.dirname(os.path.abspath(__file__))

BLUE_TOP = "#3AA0F0"
BLUE_BOTTOM = "#0B5FC0"
CORAL_TOP = "#FF6E38"
CORAL_BOTTOM = "#C82800"
SKY_TOP = "#6FD3FF"
SKY_BOTTOM = "#0E8CE0"
SUN = "#FFC24D"


# --------------------------------------------------------------------------
# Windows / Fluent variant
# --------------------------------------------------------------------------
def d_windows(size, detail=None):
    """detail: 'full' | 'medium' | 'small'. Small drops what cannot survive."""
    if detail is None:
        detail = "full" if size >= 48 else ("medium" if size >= 28 else "small")
    x, y, aa = base.make_grid(size)
    rgb = np.zeros((size, size, 3), dtype=np.float32)
    a = np.zeros((size, size), dtype=np.float32)

    # Back card: only worth drawing while its tilt can be read.
    if detail != "small":
        m_back = base.aa_mask(base.sd_rot_round_rect(x, y, 42.0, 46.0, 29.0, 34.0, 7.0, -8.5), aa)
        rgb, a = base.add_drop_shadow(rgb, a, m_back, size, 0.0, 2.2, 3.2, 0.24)
        back = base.linear_grad(x, y, 12, 12, 70, 80, "#E4EAF0", "#C5D0DC")
        rgb, a = base.blend_layer(rgb, a, back, m_back)
        m_bi = base.aa_mask(base.sd_rot_round_rect(x, y, 41.2, 41.5, 23.5, 23.0, 4.5, -8.5), aa) * m_back
        rgb, a = base.blend_layer(rgb, a, base.linear_grad(x, y, 16, 16, 65, 65, "#FFB900", "#E05319"), m_bi)

    # Front Polaroid. In the small variant it keeps a hairline edge so the white
    # card does not vanish on a light title bar — the flaw visible at 16px in the
    # first showcase.
    if detail == "small":
        # No white card at all: draw the photograph itself, edge to edge.
        front = base.aa_mask(base.sd_round_rect(x, y, 50.0, 50.0, 34.0, 38.0, 8.0), aa)
        photo = base.linear_grad(x, y, 20, 16, 80, 84, SKY_TOP, SKY_BOTTOM)
        photo = np.where((y > 56.0 + (x - 50.0) * 0.10)[..., None], base.hex_rgb("#1C6FB8"), photo)
        photo = np.where((y > 66.0 - (x - 50.0) * 0.16)[..., None], base.hex_rgb("#12589B"), photo)
        photo = np.where(base.sd_circle(x, y, 38.0, 34.0, 6.5)[..., None] < 0, base.hex_rgb(SUN), photo)
        rgb, a = base.blend_layer(rgb, a, photo, front)
        pin = base.aa_mask(base.sd_map_pin(x, y, cx=72.0, cy=27.0, head_r=16.0, tip_y=27.0 + 16.0 * 1.75, deg=12.0), aa)
        rgb, a = base.blend_layer(
            rgb, a, base.linear_grad(x, y, 58, 12, 88, 52, CORAL_TOP, CORAL_BOTTOM, "#E8430A", 0.52), pin
        )
        dot = base.aa_mask(base.sd_circle(x, y, 72.0, 27.0, 6.4), aa) * pin
        rgb, a = base.blend_layer(rgb, a, base.hex_rgb("#FFFFFF"), dot)
        return base.to_pil(rgb, a)
    else:
        front = base.aa_mask(base.sd_round_rect(x, y, 50.0, 53.0, 32.0, 38.0, 8.0), aa)
        rgb, a = base.add_drop_shadow(rgb, a, front, size, -1.5, 2.5, 4.0, 0.35, (6, 20, 38))

    card = base.linear_grad(x, y, 18, 15, 82, 91, "#FFFFFF", "#E7EDF3")
    if detail == "small":
        edge = base.aa_mask(base.sd_round_rect(x, y, 50.0, 50.0, 33.0, 37.0, 6.0), aa)
        hair = np.clip(edge - base.aa_mask(base.sd_round_rect(x, y, 50.0, 50.0, 31.4, 35.4, 5.2), aa), 0, 1)
        card = card * (1.0 - hair[..., None] * 0.55) + base.hex_rgb("#A8B7C6") * (hair[..., None] * 0.55)
    if detail == "full":
        strip = base.aa_mask(88.0 - y, aa)
        edge_rgb = base.linear_grad(x, y, 18, 88, 82, 91, "#C4CED9", "#9FB0C2")
        card = card * (1.0 - strip[..., None]) + edge_rgb * strip[..., None]
    rgb, a = base.blend_layer(rgb, a, card, front)

    # Photo window.
    if detail == "small":
        view = base.aa_mask(base.sd_round_rect(x, y, 50.0, 43.0, 27.0, 21.0, 4.0), aa)
        photo = base.linear_grad(x, y, 23, 22, 77, 64, SKY_TOP, SKY_BOTTOM)
        # Two ridges and a sun, drawn as flat shapes: at 16px a gradient
        # landscape is one grey smear.
        photo = np.where(
            (y > 52.0 + (x - 50.0) * 0.10)[..., None], base.hex_rgb("#1C6FB8"), photo
        )
        photo = np.where(
            (y > 58.0 - (x - 50.0) * 0.16)[..., None], base.hex_rgb("#12589B"), photo
        )
        photo = np.where(base.sd_circle(x, y, 64.0, 34.0, 5.0)[..., None] < 0, base.hex_rgb(SUN), photo)
    else:
        view = base.aa_mask(base.sd_round_rect(x, y, 50.0, 45.0, 26.0, 24.0, 5.0), aa)
        photo = base.paint_scenic_landscape(x, y, aa, 24.0, 21.0, 76.0, 69.0, (36.0, 33.0), 6.2)
    rgb, a = base.blend_layer(rgb, a, photo, view * front)

    # Caption lines and the amber tag: gone below 28px, one line at 32.
    if detail == "full":
        lines = np.minimum(
            base.sd_round_rect(x, y, 42.0, 75.8, 16.5, 2.0, 2.0),
            base.sd_round_rect(x, y, 36.5, 81.8, 11.0, 2.0, 2.0),
        )
        rgb, a = base.blend_layer(rgb, a, base.linear_grad(x, y, 24, 74, 60, 84, "#6C8094", "#506478"), base.aa_mask(lines, aa) * front)
        m_tag = base.aa_mask(base.sd_round_rect(x, y, 70.0, 78.5, 5.2, 3.0, 2.5), aa) * front
        rgb, a = base.blend_layer(rgb, a, base.linear_grad(x, y, 65, 75, 75, 82, "#FFAA00", "#E06A00"), m_tag)
    elif detail == "medium":
        m1 = base.aa_mask(base.sd_round_rect(x, y, 40.0, 76.5, 16.0, 2.2, 2.2), aa) * front
        rgb, a = base.blend_layer(rgb, a, base.hex_rgb("#6C8094"), m1)

    # Pin. Enlarged in the small variant so it survives as a coral dot.
    if detail == "small":
        head, tip_y, hx = 15.5, 47.0, 73.0
    else:
        head, tip_y, hx = 12.5, 45.0, 76.5
    pin = base.aa_mask(base.sd_map_pin(x, y, cx=hx, cy=22.5, head_r=head, tip_y=tip_y, deg=12.0), aa)
    if detail != "small":
        rgb, a = base.add_drop_shadow(rgb, a, pin, size, -1.8, 2.4, 3.5, 0.38, (15, 20, 30))
    rgb, a = base.blend_layer(
        rgb, a, base.linear_grad(x, y, 64, 10, 89, 45, CORAL_TOP, CORAL_BOTTOM, "#E8430A", 0.52), pin
    )
    dot = base.aa_mask(base.sd_circle(x, y, hx, 22.5, head * 0.40), aa) * pin
    rgb, a = base.blend_layer(rgb, a, base.hex_rgb("#FFFFFF"), dot)
    return base.to_pil(rgb, a)


# --------------------------------------------------------------------------
# Mobile variant, rebuilt: the depth of the Windows mark inside a squircle
# --------------------------------------------------------------------------
def d_mobile(size, detail=None):
    if detail is None:
        detail = "full" if size >= 48 else "small"
    x, y, aa = base.make_grid(size)
    rgb = np.zeros((size, size, 3), dtype=np.float32)
    a = np.zeros((size, size), dtype=np.float32)

    # Blue squircle: the tile itself is the brand colour, so the white card has
    # contrast on a light home screen and on a dark one. (The first mobile
    # version made the whole tile white, which is why it read as a cheaper
    # icon than the Windows version.)
    tile = base.aa_mask(base.sd_round_rect(x, y, 50.0, 50.0, 46.0, 46.0, 21.0), aa)
    rgb, a = base.blend_layer(rgb, a, base.linear_grad(x, y, 4, 4, 96, 96, BLUE_TOP, BLUE_BOTTOM), tile)

    if detail == "small":
        photo = base.linear_grad(x, y, 22, 18, 78, 82, SKY_TOP, SKY_BOTTOM)
        photo = np.where((y > 58.0 + (x - 50.0) * 0.08)[..., None], base.hex_rgb("#1C6FB8"), photo)
        photo = np.where(base.sd_circle(x, y, 38.0, 34.0, 6.0)[..., None] < 0, base.hex_rgb(SUN), photo)
        rgb, a = base.blend_layer(rgb, a, photo, tile)
        pin = base.aa_mask(base.sd_map_pin(x, y, cx=72.0, cy=27.0, head_r=16.5, tip_y=27.0 + 16.5 * 1.75, deg=8.0), aa) * tile
        rgb, a = base.blend_layer(
            rgb, a, base.linear_grad(x, y, 57, 12, 88, 52, CORAL_TOP, CORAL_BOTTOM, "#E8430A", 0.52), pin
        )
        dot = base.aa_mask(base.sd_circle(x, y, 72.0, 27.0, 6.6), aa) * pin
        rgb, a = base.blend_layer(rgb, a, base.hex_rgb("#FFFFFF"), dot)
        return base.to_pil(rgb, a)
    else:
        card = base.aa_mask(base.sd_round_rect(x, y, 50.0, 51.0, 25.0, 29.0, 6.0), aa) * tile
        rgb, a = base.add_drop_shadow(rgb, a, card, size, 0.0, 2.0, 3.0, 0.40, (4, 18, 40))
    rgb, a = base.blend_layer(rgb, a, base.linear_grad(x, y, 25, 22, 75, 80, "#FFFFFF", "#E9EFF5"), card)

    if detail == "small":
        view = base.aa_mask(base.sd_round_rect(x, y, 50.0, 46.0, 20.0, 17.0, 3.0), aa) * card
        photo = base.linear_grad(x, y, 30, 29, 70, 63, SKY_TOP, SKY_BOTTOM)
        photo = np.where((y > 55.0 + (x - 50.0) * 0.08)[..., None], base.hex_rgb("#1C6FB8"), photo)
        photo = np.where(base.sd_circle(x, y, 60.0, 38.0, 4.0)[..., None] < 0, base.hex_rgb(SUN), photo)
    else:
        view = base.aa_mask(base.sd_round_rect(x, y, 50.0, 44.0, 20.0, 17.5, 4.0), aa) * card
        photo = base.paint_scenic_landscape(x, y, aa, 30.0, 26.5, 70.0, 61.5, (41.0, 38.0), 5.0)
    rgb, a = base.blend_layer(rgb, a, photo, view)

    if detail != "small":
        m1 = base.aa_mask(base.sd_round_rect(x, y, 41.0, 69.5, 12.0, 1.9, 1.9), aa) * card
        rgb, a = base.blend_layer(rgb, a, base.hex_rgb("#70859A"), m1)

    head, hx = (13.5, 68.0) if detail != "small" else (15.0, 66.0)
    pin = base.aa_mask(base.sd_map_pin(x, y, cx=hx, cy=30.0, head_r=head, tip_y=30.0 + head * 1.75, deg=8.0), aa) * tile
    if detail != "small":
        rgb, a = base.add_drop_shadow(rgb, a, pin, size, -1.2, 1.8, 2.6, 0.38, (4, 18, 40))
    rgb, a = base.blend_layer(
        rgb, a, base.linear_grad(x, y, 54, 16, 82, 56, CORAL_TOP, CORAL_BOTTOM, "#E8430A", 0.52), pin
    )
    dot = base.aa_mask(base.sd_circle(x, y, hx, 30.0, head * 0.40), aa) * pin
    rgb, a = base.blend_layer(rgb, a, base.hex_rgb("#FFFFFF"), dot)
    return base.to_pil(rgb, a)


# --------------------------------------------------------------------------
# Contact sheet
# --------------------------------------------------------------------------
def fit(img, box):
    w, h = img.size
    k = min(box / w, box / h)
    return img.resize((max(1, int(w * k)), max(1, int(h * k))), Image.LANCZOS)


def text_img(text, size=15, bold=False, colour=(240, 240, 240)):
    font = ImageFont.load_default()
    pad = 4
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    left, top, right, bottom = probe.textbbox((0, 0), text, font=font)
    w = right - left + pad * 2
    im = Image.new("RGBA", (max(1, w), size + pad), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((pad - left, 2), text, font=font, fill=colour + (255,))
    return im


def sheet():
    """Hero at 256, then the sizes that actually ship: 64/48/32/24/16."""
    grid = [64, 48, 32, 24, 16]
    hero = 150
    cell = 92
    gap = 22
    margin = 28
    head = 74
    row_h = cell + 40
    width = max(
        margin * 2 + hero + gap + len(grid) * (cell + gap) - gap,
        margin * 2 + 6 * (128 + 16),
    )
    rows = 4
    zoom_h = 150
    height = head + rows * row_h + 18 + zoom_h + 34
    canvas = Image.new("RGBA", (width, height), (26, 26, 28, 255))
    draw = ImageDraw.Draw(canvas)

    def label(x, y, text, colour=(206, 206, 212)):
        canvas.alpha_composite(text_img(text, colour=colour), (x, y))

    draw.text((margin, 16), "Concept D - small sizes and a rebuilt mobile tile", fill=(255, 255, 255))
    label(
        margin,
        40,
        "rows: FDS / mobile, on a light surface then a dark one; the first column is the 256px master",
        (150, 150, 158),
    )

    def paint_row(top, maker, surface):
        draw.rounded_rectangle(
            [margin - 8, top - 8, width - margin + 8, top + cell + 8], radius=12, fill=surface
        )
        master = fit(maker(256), hero)
        canvas.alpha_composite(master, (margin, top + (cell - master.height) // 2))
        for i, s in enumerate(grid):
            icon = maker(s)
            x = margin + hero + gap + i * (cell + gap) + (cell - s) // 2
            canvas.alpha_composite(icon, (x, top + (cell - s) // 2))

    light = (243, 244, 247, 255)
    dark = (32, 32, 32, 255)

    for i, (maker, surface) in enumerate(
        [(d_windows, light), (d_mobile, light), (d_windows, dark), (d_mobile, dark)]
    ):
        paint_row(head + i * row_h, maker, surface)

    # Enlargements: what 32/24/16 really look like, nearest neighbour so the
    # pixels are evidence rather than an impression.
    zoom_top = head + rows * row_h + 12
    label(margin, zoom_top - 20, "4x nearest neighbour - 32 / 24 / 16, FDS then mobile", (150, 150, 158))
    x = margin
    for maker in (d_windows, d_mobile):
        for s in (32, 24, 16):
            big = maker(s).resize((s * 4, s * 4), Image.NEAREST)
            canvas.alpha_composite(big, (x, zoom_top + (128 - big.height) // 2))
            x += 128 + 16
    return canvas.convert("RGB")


if __name__ == "__main__":
    out = os.path.join(OUT, "logo-d-small-sizes.png")
    sheet().save(out)
    for s in (256, 64, 48, 32, 24, 16):
        d_windows(s).save(os.path.join(OUT, f"logo-d-windows-{s}.png"))
        d_mobile(s).save(os.path.join(OUT, f"logo-d-mobile-{s}.png"))
    print("generated", out)
