"""
High-precision SDF / Supersampled Vector Renderer for Photo Archive Logo Concepts.
Generates:
1. Individual 512x512 transparent PNGs and lossless SVGs for both:
   - Mobile Rounded-Rectangle Edition (移动端圆角矩形版)
   - Windows 11 Fluent Design Edition (Windows Fluent Design 版)
   across 3 design concepts:
   - Concept A (Flagship): Archive Page & Route Tile (书页与路线叠卡)
   - Concept B: Route Chronicle Album (旅途纪事装订册)
   - Concept C: Horizon Photo Frame & Route (层叠山海相框与路线)
2. A seamless Windows 11 Reference Lineup comparison alongside Paint, Calculator, Clock, Notepad, Snipping Tool on #212D31.
3. A comprehensive Design Showcase Sheet showing all 3 pairs, dark/light surfaces, and multi-size downscaling (64px, 32px, 24px, 16px).
"""

import os
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
REF_IMG_PATH = r"C:\Users\small\.dsh\attachments\v1\objects\e8\e88c014687e17bfedbd62cf26992b51cc3ad8ac5105db8a8db6484cd2f84cd21"


def hex_rgb(h):
    h = h.lstrip("#")
    return np.array([int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)], dtype=np.float32)


def sd_round_rect(x, y, cx, cy, hw, hh, r):
    dx = np.abs(x - cx) - (hw - r)
    dy = np.abs(y - cy) - (hh - r)
    outside = np.hypot(np.maximum(dx, 0.0), np.maximum(dy, 0.0))
    inside = np.minimum(np.maximum(dx, dy), 0.0)
    return outside + inside - r


def sd_circle(x, y, cx, cy, r):
    return np.hypot(x - cx, y - cy) - r


def sd_ring(x, y, cx, cy, r, stroke):
    return np.abs(np.hypot(x - cx, y - cy) - r) - stroke * 0.5


def sd_segment(x, y, ax, ay, bx, by, r):
    pax, pay = x - ax, y - ay
    bax, bay = bx - ax, by - ay
    h = np.clip((pax * bax + pay * bay) / (bax * bax + bay * bay + 1e-9), 0.0, 1.0)
    return np.hypot(pax - bax * h, pay - bay * h) - r


def aa_mask(sd, aa_width=1.0):
    return np.clip(0.5 - sd / aa_width, 0.0, 1.0)


def blend_layer(canvas_rgb, canvas_a, layer_rgb, layer_a):
    out_a = layer_a + canvas_a * (1.0 - layer_a)
    safe_a = np.where(out_a > 1e-6, out_a, 1.0)
    out_rgb = (layer_rgb * layer_a[..., None] + canvas_rgb * (canvas_a * (1.0 - layer_a))[..., None]) / safe_a[..., None]
    out_rgb = np.where(out_a[..., None] > 1e-6, out_rgb, 0.0)
    return out_rgb, out_a


def add_drop_shadow(canvas_rgb, canvas_a, mask, px_size, offset_x=0.0, offset_y=2.0, blur_radius=3.5, opacity=0.28, color=(8, 20, 38)):
    alpha_img = Image.fromarray(np.uint8(np.clip(mask * 255.0, 0, 255)), mode="L")
    scale = px_size / 100.0
    blur_px = max(0.5, blur_radius * scale)
    ox_px = int(round(offset_x * scale))
    oy_px = int(round(offset_y * scale))
    shifted = Image.new("L", (px_size, px_size), 0)
    shifted.paste(alpha_img, (ox_px, oy_px))
    blurred = shifted.filter(ImageFilter.GaussianBlur(radius=blur_px))
    sh_a = (np.array(blurred, dtype=np.float32) / 255.0) * opacity
    sh_rgb = np.zeros((px_size, px_size, 3), dtype=np.float32)
    sh_rgb[..., 0] = color[0]
    sh_rgb[..., 1] = color[1]
    sh_rgb[..., 2] = color[2]
    return blend_layer(canvas_rgb, canvas_a, sh_rgb, sh_a)


def linear_grad(x, y, x0, y0, x1, y1, c0, c1, c_mid=None, mid_pos=0.5):
    dx, dy = x1 - x0, y1 - y0
    t = np.clip(((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy + 1e-9), 0.0, 1.0)
    c0 = hex_rgb(c0)
    c1 = hex_rgb(c1)
    if c_mid is None:
        return c0[None, None, :] * (1.0 - t[..., None]) + c1[None, None, :] * t[..., None]
    cm = hex_rgb(c_mid)
    t1 = np.clip(t / mid_pos, 0.0, 1.0)
    t2 = np.clip((t - mid_pos) / (1.0 - mid_pos), 0.0, 1.0)
    part1 = c0[None, None, :] * (1.0 - t1[..., None]) + cm[None, None, :] * t1[..., None]
    part2 = cm[None, None, :] * (1.0 - t2[..., None]) + c1[None, None, :] * t2[..., None]
    return np.where((t < mid_pos)[..., None], part1, part2)


def make_grid(px_size):
    coords = (np.arange(px_size, dtype=np.float32) + 0.5) / px_size * 100.0
    y, x = np.meshgrid(coords, coords, indexing="ij")
    aa = 100.0 / px_size
    return x, y, aa


def to_pil(rgb, a):
    rgba = np.zeros((rgb.shape[0], rgb.shape[1], 4), dtype=np.uint8)
    rgba[..., :3] = np.clip(np.round(rgb), 0, 255).astype(np.uint8)
    rgba[..., 3] = np.clip(np.round(a * 255.0), 0, 255).astype(np.uint8)
    return Image.fromarray(rgba, mode="RGBA")


def draw_route_mark(x, y, aa, ring_xy, end_xy, ring_r, ring_stroke, end_r, dot_r, num_dots=4):
    rx, ry = ring_xy
    ex, ey = end_xy
    sd_r = sd_ring(x, y, rx, ry, ring_r, ring_stroke)
    sd_e = sd_circle(x, y, ex, ey, end_r)

    ux, uy = ex - rx, ey - ry
    dist = math.hypot(ux, uy)
    ux, uy = ux / dist, uy / dist
    start_d = ring_r + ring_stroke * 0.5
    end_d = dist - end_r
    span = end_d - start_d
    sd_dots = np.full_like(x, 1e6)
    for k in range(1, num_dots + 1):
        d = start_d + span * (k / (num_dots + 1))
        dx_k = rx + ux * d
        dy_k = ry + uy * d
        sd_dots = np.minimum(sd_dots, sd_circle(x, y, dx_k, dy_k, dot_r))

    sd_all = np.minimum(sd_r, np.minimum(sd_e, sd_dots))
    return aa_mask(sd_all, aa), aa_mask(sd_r, aa), aa_mask(sd_dots, aa), aa_mask(sd_e, aa)


# ==============================================================================
# CONCEPT A (FLAGSHIP): "Archive Page & Route Tile" (书页与路线叠卡)
# ==============================================================================

def render_concept_a_windows(px_size=512):
    x, y, aa = make_grid(px_size)
    rgb = np.zeros((px_size, px_size, 3), dtype=np.float32)
    a = np.zeros((px_size, px_size), dtype=np.float32)

    # 1. Back Layer: Warm Archive Page (x=9..67, y=6..78)
    sd_page = sd_round_rect(x, y, 38.0, 42.0, 29.0, 36.0, 8.5)
    mask_page = aa_mask(sd_page, aa)

    rgb, a = add_drop_shadow(rgb, a, mask_page, px_size, offset_x=0.0, offset_y=2.2, blur_radius=3.2, opacity=0.24)

    # Page base fill: warm tactile off-white (#F8FAFC -> #DCE3EC)
    page_rgb = linear_grad(x, y, 9, 6, 67, 78, "#F8FAFC", "#DCE3EC")

    # Warm amber/brown archive bottom binding strip (y=72..78) & crisp white paper edge (y=68.5..72)
    amber_rgb = linear_grad(x, y, 9, 72, 67, 78, "#C86416", "#964A0A")
    edge_rgb = hex_rgb("#CFD6DF")[None, None, :]
    m_amber = aa_mask(72.0 - y, aa)
    m_edge = aa_mask(68.5 - y, aa) * (1.0 - m_amber)
    page_rgb = page_rgb * (1.0 - m_edge[..., None]) + edge_rgb * m_edge[..., None]
    page_rgb = page_rgb * (1.0 - m_amber[..., None]) + amber_rgb * m_amber[..., None]

    # Top-left Coral-Orange archive stamp / photo header badge (#F25C22 -> #D83B01)
    sd_badge = sd_round_rect(x, y, 24.5, 20.5, 7.5, 5.2, 2.6)
    m_badge = aa_mask(sd_badge, aa) * mask_page
    badge_rgb = linear_grad(x, y, 17, 15, 32, 26, "#F45E24", "#D83B01")

    # Bold, clean narrative ruled lines ("A trip becomes a document; a day is a page")
    sd_line1 = sd_round_rect(x, y, 46.0, 18.0, 10.5, 2.1, 2.1)
    sd_line2 = sd_round_rect(x, y, 43.5, 23.5, 8.0, 2.1, 2.1)
    sd_line3 = sd_round_rect(x, y, 35.5, 34.0, 18.5, 2.2, 2.2)
    sd_line4 = sd_round_rect(x, y, 30.5, 43.0, 13.5, 2.2, 2.2)
    sd_line5 = sd_round_rect(x, y, 27.5, 52.0, 10.5, 2.2, 2.2)
    m_lines = aa_mask(np.minimum(sd_line1, np.minimum(sd_line2, np.minimum(sd_line3, np.minimum(sd_line4, sd_line5)))), aa) * mask_page
    line_rgb = linear_grad(x, y, 17, 17, 56, 55, "#748A9E", "#566C80")

    rgb, a = blend_layer(rgb, a, page_rgb, mask_page)
    rgb, a = blend_layer(rgb, a, badge_rgb, m_badge)
    rgb, a = blend_layer(rgb, a, line_rgb, m_lines)

    # 2. Front Layer: Overlapping Fluent Route Tile (x=30..92, y=31..93)
    sd_tile = sd_round_rect(x, y, 61.0, 62.0, 31.0, 31.0, 11.5)
    mask_tile = aa_mask(sd_tile, aa)

    # Rich Fluent contact shadow cast onto the paper page behind it
    rgb, a = add_drop_shadow(rgb, a, mask_tile, px_size, offset_x=-2.0, offset_y=2.2, blur_radius=4.2, opacity=0.38, color=(6, 22, 45))

    # Fluent Cyan-to-Communication-Blue gradient
    tile_rgb = linear_grad(x, y, 30, 31, 92, 93, "#48D0FA", "#005299", c_mid="#0A84DC", mid_pos=0.52)

    # Specular inner top edge highlight
    sd_inner_border = np.abs(sd_tile + 0.6) - 0.6
    m_highlight = aa_mask(sd_inner_border, aa) * mask_tile * np.clip((55.0 - y) / 24.0, 0.0, 1.0) * 0.35
    tile_rgb = tile_rgb * (1.0 - m_highlight[..., None]) + 255.0 * m_highlight[..., None]

    rgb, a = blend_layer(rgb, a, tile_rgb, mask_tile)

    # 3. Signature Route Mark inside the Blue Tile
    m_route, _, _, _ = draw_route_mark(
        x, y, aa,
        ring_xy=(46.8, 76.2),
        end_xy=(75.2, 47.8),
        ring_r=6.3,
        ring_stroke=3.5,
        end_r=7.8,
        dot_r=2.2,
        num_dots=3,
    )
    m_route = m_route * mask_tile
    rgb, a = add_drop_shadow(rgb, a, m_route, px_size, offset_x=0.0, offset_y=1.4, blur_radius=2.0, opacity=0.26, color=(0, 32, 72))
    route_rgb = linear_grad(x, y, 40, 40, 80, 80, "#FFFFFF", "#EEF6FC")
    rgb, a = blend_layer(rgb, a, route_rgb, m_route)

    return to_pil(rgb, a)


def render_concept_a_mobile(px_size=512, shape="square"):
    """
    Mobile Rounded-Rectangle Edition for Concept A:
    Inside the Fluent Blue squircle container, a crisp layered white/paper Archive Corner Sheet
    peeks from the top-left with a warm Coral-Orange bookmark accent, while the bold White Route Mark
    commands the main diagonal. Clean, bold, and unmistakable from 192px down to 16px!
    """
    x, y, aa = make_grid(px_size)
    rgb = np.zeros((px_size, px_size, 3), dtype=np.float32)
    a = np.zeros((px_size, px_size), dtype=np.float32)

    if shape == "round":
        sd_bg = sd_circle(x, y, 50.0, 50.0, 46.0)
    else:
        sd_bg = sd_round_rect(x, y, 50.0, 50.0, 46.0, 46.0, 18.5)
    mask_bg = aa_mask(sd_bg, aa)

    # Deep outer squircle backdrop (#005BA4 -> #00396B) on top-left, overlapped by the main Fluent Blue Route Tile!
    # Wait: let's see how cool this is:
    # Inside the rounded-rect icon, the top-left shows the crisp warm-white Archive Page card (#F6F8FB)
    # with the Coral-Orange badge & ruled line, and the main Fluent Blue card (#3CC8F6 -> #0078D4 -> #005299)
    # overlaps from bottom-right filling the main canvas with the Route Mark!
    base_rgb = linear_grad(x, y, 4, 4, 96, 96, "#0A64AD", "#003B6E")
    rgb, a = blend_layer(rgb, a, base_rgb, mask_bg)

    # Top-left Archive Page tucked inside the squircle (x=15..64, y=15..66)
    sd_page = sd_round_rect(x, y, 39.5, 40.5, 24.0, 25.0, 8.0)
    m_page = aa_mask(sd_page, aa) * mask_bg
    page_rgb = linear_grad(x, y, 15, 15, 64, 65, "#F9FAFC", "#DCE4EE")
    rgb, a = add_drop_shadow(rgb, a, m_page, px_size, offset_x=0.0, offset_y=1.5, blur_radius=2.5, opacity=0.25)
    rgb, a = blend_layer(rgb, a, page_rgb, m_page)

    # Coral-orange header pill + 2 bold slate lines on that top-left page
    sd_badge = sd_round_rect(x, y, 27.5, 25.5, 6.2, 4.0, 2.2)
    m_badge = aa_mask(sd_badge, aa) * m_page
    rgb, a = blend_layer(rgb, a, linear_grad(x, y, 21, 21, 34, 30, "#F45E24", "#D83B01"), m_badge)

    sd_l1 = sd_round_rect(x, y, 44.5, 25.5, 7.0, 1.9, 1.9)
    sd_l2 = sd_round_rect(x, y, 34.0, 35.0, 12.5, 2.0, 2.0)
    sd_l3 = sd_round_rect(x, y, 29.0, 42.5, 7.5, 2.0, 2.0)
    m_lines = aa_mask(np.minimum(sd_l1, np.minimum(sd_l2, sd_l3)), aa) * m_page
    rgb, a = blend_layer(rgb, a, hex_rgb("#687F94")[None, None, :], m_lines)

    # Main Front Fluent Blue Route Card overlapping lower-right and clipped cleanly to the squircle
    sd_front = sd_round_rect(x, y, 59.0, 59.0, 37.0, 37.0, 14.0)
    m_front = aa_mask(sd_front, aa) * mask_bg
    rgb, a = add_drop_shadow(rgb, a, m_front, px_size, offset_x=-2.0, offset_y=1.5, blur_radius=3.8, opacity=0.38, color=(4, 18, 40))

    front_rgb = linear_grad(x, y, 22, 22, 94, 94, "#42CCF8", "#005096", c_mid="#0078D4", mid_pos=0.5)
    rgb, a = blend_layer(rgb, a, front_rgb, m_front)

    # Signature Route Mark centered inside the front blue zone
    m_route, _, _, _ = draw_route_mark(
        x, y, aa,
        ring_xy=(41.5, 72.5),
        end_xy=(72.5, 41.5),
        ring_r=7.2,
        ring_stroke=3.9,
        end_r=8.8,
        dot_r=2.45,
        num_dots=3,
    )
    m_route = m_route * m_front
    rgb, a = add_drop_shadow(rgb, a, m_route, px_size, offset_x=0.0, offset_y=1.5, blur_radius=2.0, opacity=0.26, color=(0, 28, 64))
    rgb, a = blend_layer(rgb, a, hex_rgb("#FFFFFF")[None, None, :], m_route)

    return to_pil(rgb, a)


# ==============================================================================
# CONCEPT B: "Route Chronicle Album" (旅途纪事册 · 装订相册版)
# ==============================================================================

def render_concept_b_windows(px_size=512):
    x, y, aa = make_grid(px_size)
    rgb = np.zeros((px_size, px_size, 3), dtype=np.float32)
    a = np.zeros((px_size, px_size), dtype=np.float32)

    # Main vertical album body: x=17..83 (w=66), y=10..91 (h=81), rx=8.5
    sd_body = sd_round_rect(x, y, 50.0, 50.5, 33.0, 40.5, 8.5)
    mask_body = aa_mask(sd_body, aa)

    rgb, a = add_drop_shadow(rgb, a, mask_body, px_size, offset_x=0.0, offset_y=2.4, blur_radius=3.5, opacity=0.28)

    # Album body gradient: Windows 11 Cyan-Blue (#62D5F7 -> #0E86DC -> #005AA3)
    body_rgb = linear_grad(x, y, 20, 10, 80, 82, "#62D5F7", "#005AA3", c_mid="#0E86DC", mid_pos=0.52)

    # Left book-spine accent band (x=17..26.5)
    m_spine = aa_mask(x - 26.5, aa) * mask_body
    spine_rgb = linear_grad(x, y, 17, 10, 26, 82, "#0B5FA3", "#003B6E")
    body_rgb = body_rgb * (1.0 - m_spine[..., None]) + spine_rgb * m_spine[..., None]

    # Bottom stacked white paper edge (y=81..85.5) + warm amber-brown album backing (y=85.5..91)
    amber_rgb = linear_grad(x, y, 17, 85, 83, 91, "#C86416", "#964A0A")
    paper_rgb = linear_grad(x, y, 17, 81, 83, 85, "#F2F5F8", "#D0D8E2")
    m_amber = aa_mask(85.5 - y, aa)
    m_paper = aa_mask(80.8 - y, aa) * (1.0 - m_amber)
    body_rgb = body_rgb * (1.0 - m_paper[..., None]) + paper_rgb * m_paper[..., None]
    body_rgb = body_rgb * (1.0 - m_amber[..., None]) + amber_rgb * m_amber[..., None]

    rgb, a = blend_layer(rgb, a, body_rgb, mask_body)

    # Top 4 sculpted archive binding rings (exact Notepad geometry: dark teal vertical capsules sitting on top edge)
    ring_xs = [33.0, 45.5, 58.0, 70.5]
    sd_rings = np.full_like(x, 1e6)
    sd_ring_tips = np.full_like(x, 1e6)
    for rx_pos in ring_xs:
        sd_rings = np.minimum(sd_rings, sd_round_rect(x, y, rx_pos, 10.5, 2.7, 4.5, 2.4))
        sd_ring_tips = np.minimum(sd_ring_tips, sd_circle(x, y, rx_pos, 13.8, 2.9))

    m_tips = aa_mask(sd_ring_tips, aa) * mask_body
    rgb, a = blend_layer(rgb, a, hex_rgb("#044C6E")[None, None, :], m_tips * 0.65)

    m_rings = aa_mask(sd_rings, aa)
    rings_rgb = linear_grad(x, y, 30, 6, 70, 15, "#0B7AA8", "#055A80")
    rgb, a = blend_layer(rgb, a, rings_rgb, m_rings)

    # Coral-Orange index tab protruding on the right edge (y=24..35)
    sd_tab = sd_round_rect(x, y, 82.8, 29.5, 4.5, 5.8, 2.4)
    m_tab = aa_mask(sd_tab, aa) * (1.0 - mask_body)
    tab_rgb = linear_grad(x, y, 78, 24, 87, 35, "#F55E28", "#D83B01")
    rgb, a = blend_layer(rgb, a, tab_rgb, m_tab)

    # Signature Route Mark embossed on the album cover
    m_route, _, _, _ = draw_route_mark(
        x, y, aa,
        ring_xy=(40.5, 62.5),
        end_xy=(68.5, 34.5),
        ring_r=6.4,
        ring_stroke=3.5,
        end_r=7.8,
        dot_r=2.15,
        num_dots=3,
    )
    m_route = m_route * mask_body
    rgb, a = add_drop_shadow(rgb, a, m_route, px_size, offset_x=0.0, offset_y=1.5, blur_radius=2.2, opacity=0.25, color=(0, 28, 64))
    rgb, a = blend_layer(rgb, a, hex_rgb("#FFFFFF")[None, None, :], m_route)

    return to_pil(rgb, a)


def render_concept_b_mobile(px_size=512, shape="square"):
    """Mobile Rounded-Rect version of Concept B (Book spine + Coral-Orange bookmark + Route)."""
    x, y, aa = make_grid(px_size)
    rgb = np.zeros((px_size, px_size, 3), dtype=np.float32)
    a = np.zeros((px_size, px_size), dtype=np.float32)

    if shape == "round":
        sd_bg = sd_circle(x, y, 50.0, 50.0, 46.0)
    else:
        sd_bg = sd_round_rect(x, y, 50.0, 50.0, 46.0, 46.0, 18.5)
    mask_bg = aa_mask(sd_bg, aa)

    bg_rgb = linear_grad(x, y, 10, 6, 90, 94, "#42CAF7", "#005299", c_mid="#0078D4", mid_pos=0.52)

    # Left spine band (x < 21.5)
    m_spine = aa_mask(x - 21.5, aa) * mask_bg
    spine_rgb = linear_grad(x, y, 4, 4, 22, 96, "#005096", "#003363")
    bg_rgb = bg_rgb * (1.0 - m_spine[..., None]) + spine_rgb * m_spine[..., None]

    # Subtle spine groove highlight at x=21.5
    m_groove = aa_mask(np.abs(x - 22.0) - 0.5, aa) * mask_bg
    bg_rgb = bg_rgb * (1.0 - m_groove[..., None] * 0.28) + 255.0 * (m_groove[..., None] * 0.28)

    rgb, a = blend_layer(rgb, a, bg_rgb, mask_bg)

    # Top Coral-Orange bookmark ribbon dropping down from top-left (x=31..40, y=4..25)
    sd_rib = sd_round_rect(x, y, 35.5, 13.5, 4.5, 11.0, 2.2)
    m_rib = aa_mask(sd_rib, aa) * mask_bg
    rib_rgb = linear_grad(x, y, 31, 4, 40, 25, "#F6622A", "#D83B01")
    rgb, a = add_drop_shadow(rgb, a, m_rib, px_size, offset_x=0.0, offset_y=1.2, blur_radius=1.8, opacity=0.25)
    rgb, a = blend_layer(rgb, a, rib_rgb, m_rib)

    # Route Mark shifted right of spine
    m_route, _, _, _ = draw_route_mark(
        x, y, aa,
        ring_xy=(38.5, 66.5),
        end_xy=(70.5, 34.5),
        ring_r=8.2,
        ring_stroke=4.4,
        end_r=10.0,
        dot_r=2.6,
        num_dots=3,
    )
    m_route = m_route * mask_bg
    rgb, a = add_drop_shadow(rgb, a, m_route, px_size, offset_x=0.0, offset_y=1.5, blur_radius=2.2, opacity=0.25, color=(0, 28, 64))
    rgb, a = blend_layer(rgb, a, hex_rgb("#FFFFFF")[None, None, :], m_route)

    return to_pil(rgb, a)


# ==============================================================================
# CONCEPT C: "Horizon Photo Frame & Route Badge" (层叠山海相框与路线徽章)
# ==============================================================================

def render_concept_c_windows(px_size=512):
    x, y, aa = make_grid(px_size)
    rgb = np.zeros((px_size, px_size, 3), dtype=np.float32)
    a = np.zeros((px_size, px_size), dtype=np.float32)

    # 1. Back Stacked Card (offset top-left: x=9..75, y=9..75)
    sd_back = sd_round_rect(x, y, 42.0, 42.0, 32.0, 32.0, 9.5)
    m_back = aa_mask(sd_back, aa)
    rgb, a = add_drop_shadow(rgb, a, m_back, px_size, offset_x=0.0, offset_y=2.0, blur_radius=3.0, opacity=0.22)
    back_rgb = linear_grad(x, y, 10, 10, 74, 74, "#DCE3EC", "#B4C0D0")
    rgb, a = blend_layer(rgb, a, back_rgb, m_back)

    # 2. Main Photo Card (x=18..88, y=18..88) with crisp white polaroid/photo border
    sd_card = sd_round_rect(x, y, 53.0, 53.0, 35.0, 35.0, 10.5)
    m_card = aa_mask(sd_card, aa)
    rgb, a = add_drop_shadow(rgb, a, m_card, px_size, offset_x=-1.5, offset_y=2.2, blur_radius=3.8, opacity=0.32)
    card_border_rgb = linear_grad(x, y, 18, 18, 88, 88, "#FAFBFC", "#DFE5EC")
    rgb, a = blend_layer(rgb, a, card_border_rgb, m_card)

    # Inner photo viewport
    sd_inner = sd_round_rect(x, y, 53.0, 53.0, 29.5, 29.5, 7.5)
    m_inner = aa_mask(sd_inner, aa)

    sky_rgb = linear_grad(x, y, 23, 23, 83, 76, "#52D6FA", "#087CD6")

    hill1_y = 64.0 - 9.0 * np.sin((x - 19.0) / 68.0 * math.pi)
    m_hill1 = aa_mask(hill1_y - y, aa)
    hill1_rgb = linear_grad(x, y, 23, 53, 83, 83, "#0063B1", "#004785")
    sky_rgb = sky_rgb * (1.0 - m_hill1[..., None]) + hill1_rgb * m_hill1[..., None]

    hill2_y = 71.0 - 8.0 * np.cos((x - 63.0) / 52.0 * math.pi * 0.85)
    m_hill2 = aa_mask(hill2_y - y, aa)
    hill2_rgb = linear_grad(x, y, 23, 61, 83, 83, "#004B8D", "#003160")
    sky_rgb = sky_rgb * (1.0 - m_hill2[..., None]) + hill2_rgb * m_hill2[..., None]

    rgb, a = blend_layer(rgb, a, sky_rgb, m_inner)

    # 3. Signature Route Mark crossing the photo viewport
    m_route, m_ring, m_dots, _ = draw_route_mark(
        x, y, aa,
        ring_xy=(36.5, 69.5),
        end_xy=(70.5, 35.5),
        ring_r=6.5,
        ring_stroke=3.5,
        end_r=8.8,
        dot_r=2.2,
        num_dots=3,
    )
    rgb, a = add_drop_shadow(rgb, a, m_route, px_size, offset_x=0.0, offset_y=1.6, blur_radius=2.4, opacity=0.32, color=(0, 24, 56))

    m_white_parts = np.maximum(m_ring, m_dots)
    rgb, a = blend_layer(rgb, a, hex_rgb("#FFFFFF")[None, None, :], m_white_parts)

    m_end_outer = aa_mask(sd_circle(x, y, 70.5, 35.5, 9.2), aa)
    m_end_inner = aa_mask(sd_circle(x, y, 70.5, 35.5, 6.2), aa)
    rgb, a = blend_layer(rgb, a, hex_rgb("#FFFFFF")[None, None, :], m_end_outer)
    sun_rgb = linear_grad(x, y, 63, 28, 78, 43, "#FF6E38", "#D83B01")
    rgb, a = blend_layer(rgb, a, sun_rgb, m_end_inner)

    return to_pil(rgb, a)


def render_concept_c_mobile(px_size=512, shape="square"):
    """Mobile Rounded-Rect version of Concept C (Horizon waves + 3 well-spaced dots + Coral-Orange sun/destination)."""
    x, y, aa = make_grid(px_size)
    rgb = np.zeros((px_size, px_size, 3), dtype=np.float32)
    a = np.zeros((px_size, px_size), dtype=np.float32)

    if shape == "round":
        sd_bg = sd_circle(x, y, 50.0, 50.0, 46.0)
    else:
        sd_bg = sd_round_rect(x, y, 50.0, 50.0, 46.0, 46.0, 18.5)
    mask_bg = aa_mask(sd_bg, aa)

    sky_rgb = linear_grad(x, y, 10, 6, 90, 80, "#46CEF8", "#0078D4")
    hill1_y = 66.0 - 11.0 * np.sin((x - 8.0) / 88.0 * math.pi)
    m_hill1 = aa_mask(hill1_y - y, aa)
    hill1_rgb = linear_grad(x, y, 10, 54, 90, 96, "#005BA4", "#00427A")
    sky_rgb = sky_rgb * (1.0 - m_hill1[..., None]) + hill1_rgb * m_hill1[..., None]

    hill2_y = 75.0 - 10.0 * np.cos((x - 68.0) / 65.0 * math.pi * 0.85)
    m_hill2 = aa_mask(hill2_y - y, aa)
    hill2_rgb = linear_grad(x, y, 10, 64, 90, 96, "#004580", "#002B54")
    sky_rgb = sky_rgb * (1.0 - m_hill2[..., None]) + hill2_rgb * m_hill2[..., None]

    rgb, a = blend_layer(rgb, a, sky_rgb, mask_bg)

    m_route, m_ring, m_dots, _ = draw_route_mark(
        x, y, aa,
        ring_xy=(33.0, 67.0),
        end_xy=(67.0, 33.0),
        ring_r=8.2,
        ring_stroke=4.4,
        end_r=10.4,
        dot_r=2.55,
        num_dots=3,
    )
    m_route = m_route * mask_bg
    rgb, a = add_drop_shadow(rgb, a, m_route, px_size, offset_x=0.0, offset_y=1.6, blur_radius=2.4, opacity=0.28, color=(0, 22, 52))

    m_white_parts = np.maximum(m_ring, m_dots) * mask_bg
    rgb, a = blend_layer(rgb, a, hex_rgb("#FFFFFF")[None, None, :], m_white_parts)

    m_end_outer = aa_mask(sd_circle(x, y, 67.0, 33.0, 10.4), aa) * mask_bg
    m_end_inner = aa_mask(sd_circle(x, y, 67.0, 33.0, 6.8), aa) * mask_bg
    rgb, a = blend_layer(rgb, a, hex_rgb("#FFFFFF")[None, None, :], m_end_outer)
    sun_rgb = linear_grad(x, y, 58, 25, 75, 42, "#FF6E38", "#D83B01")
    rgb, a = blend_layer(rgb, a, sun_rgb, m_end_inner)

    return to_pil(rgb, a)


def write_svg_assets():
    """Writes standalone lossless SVG files for both the Windows Fluent Design version and Mobile Rounded-Rect version."""
    svg_win_a = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="512" height="512">
  <defs>
    <linearGradient id="pageGrad" x1="9" y1="6" x2="67" y2="78" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#F8FAFC"/>
      <stop offset="100%" stop-color="#DCE3EC"/>
    </linearGradient>
    <linearGradient id="amberGrad" x1="9" y1="72" x2="67" y2="78" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#C86416"/>
      <stop offset="100%" stop-color="#964A0A"/>
    </linearGradient>
    <linearGradient id="badgeGrad" x1="17" y1="15" x2="32" y2="26" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#F45E24"/>
      <stop offset="100%" stop-color="#D83B01"/>
    </linearGradient>
    <linearGradient id="tileGrad" x1="30" y1="31" x2="92" y2="93" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#48D0FA"/>
      <stop offset="52%" stop-color="#0A84DC"/>
      <stop offset="100%" stop-color="#005299"/>
    </linearGradient>
    <filter id="tileShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="-2.0" dy="2.2" stdDeviation="3.2" flood-color="#06162D" flood-opacity="0.36"/>
    </filter>
    <filter id="pageShadow" x="-15%" y="-15%" width="130%" height="130%">
      <feDropShadow dx="0" dy="2.0" stdDeviation="2.5" flood-color="#081426" flood-opacity="0.22"/>
    </filter>
    <clipPath id="pageClip">
      <rect x="9" y="6" width="58" height="72" rx="8.5"/>
    </clipPath>
  </defs>
  <!-- Back Layer: Archive Page ("A trip becomes a document; a day is a page") -->
  <g filter="url(#pageShadow)">
    <g clip-path="url(#pageClip)">
      <rect x="9" y="6" width="58" height="72" fill="url(#pageGrad)"/>
      <rect x="9" y="68.5" width="58" height="3.5" fill="#CFD6DF"/>
      <rect x="9" y="72" width="58" height="6" fill="url(#amberGrad)"/>
      <rect x="17" y="15.3" width="15" height="10.4" rx="2.6" fill="url(#badgeGrad)"/>
      <rect x="35.5" y="15.9" width="21" height="4.2" rx="2.1" fill="#687E92"/>
      <rect x="35.5" y="21.4" width="16" height="4.2" rx="2.1" fill="#687E92"/>
      <rect x="17" y="31.8" width="37" height="4.4" rx="2.2" fill="#62788C"/>
      <rect x="17" y="40.8" width="27" height="4.4" rx="2.2" fill="#62788C"/>
      <rect x="17" y="49.8" width="21" height="4.4" rx="2.2" fill="#62788C"/>
    </g>
  </g>
  <!-- Front Layer: Overlapping Fluent Blue Route Tile -->
  <g filter="url(#tileShadow)">
    <rect x="30" y="31" width="62" height="62" rx="11.5" fill="url(#tileGrad)"/>
    <!-- Signature Route Mark: Origin Ring -> 3 Stepping Dots -> Destination Disc -->
    <circle cx="46.8" cy="76.2" r="6.3" fill="none" stroke="#FFFFFF" stroke-width="3.5"/>
    <circle cx="55.3" cy="67.7" r="2.2" fill="#FFFFFF"/>
    <circle cx="60.6" cy="62.4" r="2.2" fill="#FFFFFF"/>
    <circle cx="65.9" cy="57.1" r="2.2" fill="#FFFFFF"/>
    <circle cx="75.2" cy="47.8" r="7.8" fill="#FFFFFF"/>
  </g>
</svg>
"""
    svg_mob_a = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="512" height="512">
  <defs>
    <linearGradient id="baseGrad" x1="4" y1="4" x2="96" y2="96" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#0A64AD"/>
      <stop offset="100%" stop-color="#003B6E"/>
    </linearGradient>
    <linearGradient id="pageGradM" x1="15" y1="15" x2="64" y2="65" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#F9FAFC"/>
      <stop offset="100%" stop-color="#DCE4EE"/>
    </linearGradient>
    <linearGradient id="badgeGradM" x1="21" y1="21" x2="34" y2="30" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#F45E24"/>
      <stop offset="100%" stop-color="#D83B01"/>
    </linearGradient>
    <linearGradient id="frontGradM" x1="22" y1="22" x2="94" y2="94" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#42CCF8"/>
      <stop offset="50%" stop-color="#0078D4"/>
      <stop offset="100%" stop-color="#005096"/>
    </linearGradient>
    <filter id="frontShadowM" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="-2.0" dy="1.5" stdDeviation="3.0" flood-color="#041228" flood-opacity="0.38"/>
    </filter>
    <clipPath id="squircleClip">
      <rect x="4" y="4" width="92" height="92" rx="18.5"/>
    </clipPath>
  </defs>
  <g clip-path="url(#squircleClip)">
    <rect x="4" y="4" width="92" height="92" fill="url(#baseGrad)"/>
    <!-- Top-Left Archive Page Card -->
    <rect x="15.5" y="15.5" width="48" height="50" rx="8.0" fill="url(#pageGradM)"/>
    <rect x="21.3" y="21.5" width="12.4" height="8.0" rx="2.2" fill="url(#badgeGradM)"/>
    <rect x="37.5" y="23.6" width="14" height="3.8" rx="1.9" fill="#687F94"/>
    <rect x="21.5" y="33.0" width="25" height="4.0" rx="2.0" fill="#687F94"/>
    <rect x="21.5" y="40.5" width="15" height="4.0" rx="2.0" fill="#687F94"/>
    <!-- Main Fluent Blue Route Layer -->
    <g filter="url(#frontShadowM)">
      <rect x="22" y="22" width="74" height="74" rx="14.0" fill="url(#frontGradM)"/>
      <circle cx="41.5" cy="72.5" r="7.2" fill="none" stroke="#FFFFFF" stroke-width="3.9"/>
      <circle cx="51.1" cy="62.9" r="2.45" fill="#FFFFFF"/>
      <circle cx="56.7" cy="57.3" r="2.45" fill="#FFFFFF"/>
      <circle cx="62.3" cy="51.7" r="2.45" fill="#FFFFFF"/>
      <circle cx="72.5" cy="41.5" r="8.8" fill="#FFFFFF"/>
    </g>
  </g>
</svg>
"""
    with open(os.path.join(OUT_DIR, "logo-fluent-windows-A.svg"), "w", encoding="utf-8") as f:
        f.write(svg_win_a)
    with open(os.path.join(OUT_DIR, "logo-mobile-rounded-A.svg"), "w", encoding="utf-8") as f:
        f.write(svg_mob_a)


def load_cjk_font(size, bold=False):
    candidates = [
        r"C:\Windows\Fonts\msyhbd.ttc" if bold else r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\simhei.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def load_segoe_font(size, bold=False):
    candidates = [
        r"C:\Windows\Fonts\seguisb.ttf" if bold else r"C:\Windows\Fonts\segoeui.ttf",
        r"C:\Windows\Fonts\msyh.ttc",
    ]
    for path in candidates:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def build_win11_lineup_comparison(concepts_win):
    ref = Image.open(REF_IMG_PATH).convert("RGBA")
    rw, rh = ref.size  # 969 x 205

    col_w = 194
    total_w = rw + col_w
    total_h = rh * 2 + 28
    board = Image.new("RGBA", (total_w, total_h), (33, 45, 49, 255))
    draw = ImageDraw.Draw(board)

    # Match exact vertical gradient of reference image on Row 1 right extension
    for y_row in range(rh):
        t = y_row / max(1, rh - 1)
        r_c = int(round(33 * (1 - t) + 32 * t))
        g_c = int(round(45 * (1 - t) + 44 * t))
        b_c = int(round(49 * (1 - t) + 48 * t))
        draw.line([(rw, y_row), (total_w, y_row)], fill=(r_c, g_c, b_c, 255))

    board.paste(ref, (0, 0))

    font_segoe_label = load_segoe_font(20, bold=False)
    font_cjk_title = load_cjk_font(15, bold=True)
    font_cjk_sub = load_cjk_font(13, bold=False)
    font_cjk_badge = load_cjk_font(12, bold=True)

    # Slot 6 on Row 1: Concept A (Flagship Windows Fluent Design) seamlessly extending the Windows 11 lineup
    slot6_cx = rw + col_w // 2 - 12
    icon_a_64 = concepts_win["A"].resize((68, 68), Image.Resampling.LANCZOS)
    board.alpha_composite(icon_a_64, (slot6_cx - 34, 53))

    draw.rounded_rectangle([slot6_cx - 80, 18, slot6_cx + 80, 184], radius=12, outline=(64, 166, 245, 130), width=1)
    draw.text((slot6_cx, 146), "Photo Archive", fill=(242, 245, 247, 255), font=font_segoe_label, anchor="mm")
    draw.text((slot6_cx, 33), "NEW · 方案 A (主推)", fill=(95, 205, 255, 255), font=font_cjk_badge, anchor="mm")

    # Divider line between Row 1 and Row 2
    draw.line([(36, rh + 8), (total_w - 36, rh + 8)], fill=(54, 70, 76, 255), width=1)

    # Row 2: 5 slots comparing Current vs 3 Fluent Concepts + Mobile Squircle
    cur_icon = Image.open(os.path.join(OUT_DIR, "..", "..", "desktop", "build", "icon.png")).convert("RGBA")
    row2_items = [
        ("Current (当前图标)", "移动端方块直接套用", cur_icon.resize((64, 64), Image.Resampling.LANCZOS), (150, 165, 172, 255)),
        ("方案 A · 书页与路线叠卡", "Windows Fluent 版 (主推)", concepts_win["A"].resize((68, 68), Image.Resampling.LANCZOS), (90, 205, 255, 255)),
        ("方案 B · 旅途纪事装订册", "Windows Fluent 版 (Notepad风)", concepts_win["B"].resize((68, 68), Image.Resampling.LANCZOS), (180, 220, 240, 255)),
        ("方案 C · 山海相框与路线", "Windows Fluent 版 (相片风)", concepts_win["C"].resize((68, 68), Image.Resampling.LANCZOS), (180, 220, 240, 255)),
        ("方案 A · 移动端圆角矩形版", "Android / iOS 标准圆角矩形", concepts_win["A_mobile"].resize((64, 64), Image.Resampling.LANCZOS), (130, 230, 175, 255)),
    ]

    slot_span = total_w // len(row2_items)
    y_base = rh + 20
    for idx, (title, subtitle, ic, badge_col) in enumerate(row2_items):
        cx = slot_span * idx + slot_span // 2
        iw, ih = ic.size
        board.alpha_composite(ic, (cx - iw // 2, y_base + 50 - (ih - 64) // 2))
        draw.text((cx, y_base + 138), title, fill=(240, 244, 246, 255), font=font_cjk_title, anchor="mm")
        draw.text((cx, y_base + 164), subtitle, fill=badge_col, font=font_cjk_sub, anchor="mm")

    out_path = os.path.join(OUT_DIR, "win11-lineup-comparison.png")
    board.convert("RGB").save(out_path, quality=95)
    return out_path


def build_full_design_sheet(win_icons, mob_icons):
    W, H = 1680, 1140
    sheet = Image.new("RGBA", (W, H), (22, 29, 33, 255))
    draw = ImageDraw.Draw(sheet)

    f_h1 = load_cjk_font(25, bold=True)
    f_h2 = load_cjk_font(18, bold=True)
    f_body = load_cjk_font(13, bold=False)
    f_small = load_cjk_font(12, bold=True)
    f_segoe_tb = load_segoe_font(13, bold=True)

    draw.text((48, 34), "Photo Archive (travel-archive) — 新 Logo 设计方案全览（Windows Fluent 版 + 移动端圆角矩形版）", fill=(245, 248, 250, 255), font=f_h1)
    draw.text(
        (48, 70),
        "核心设计语言：\"A trip becomes a document, not a folder. A day is a page, not a grid.\" — 延续左下→右上【旅途路线】基因，融合【可读档案书页】与 Win11 Fluent 多层材质光影",
        fill=(160, 178, 190, 255),
        font=f_body,
    )

    cards = [
        (
            "A",
            "方案 A（主推）：「书页与路线叠卡」",
            "左上暖白手记书页（橙红印记 + 叙事文本行 + 琥珀书脊底边）",
            "右下破界叠合 Fluent 品牌蓝路线卡，兼顾书页隐喻与极佳小尺寸辨识度",
            (56, 168, 245, 255),
        ),
        (
            "B",
            "方案 B：「旅途纪事装订册」",
            "致敬 Win11 Notepad 48×64 立式装订册剪影与底部琥珀封底",
            "顶部 4 枚装订环 + 左侧深蓝书脊 + 右侧橙红索引贴 + 封面路线",
            (85, 115, 135, 255),
        ),
        (
            "C",
            "方案 C：「层叠山海相框与路线」",
            "前后错位叠放拍立得相片卡 + 天青渐变与双层远山折面",
            "左下起点圆环跨越山海直达右上暖橙落日终点，画面感更强",
            (85, 115, 135, 255),
        ),
    ]

    card_w = 512
    card_h = 684
    gap = 24
    start_x = 48
    top_y = 110

    for idx, (key, title, desc1, desc2, border_col) in enumerate(cards):
        x0 = start_x + idx * (card_w + gap)
        y0 = top_y
        draw.rounded_rectangle([x0, y0, x0 + card_w, y0 + card_h], radius=16, fill=(31, 42, 48, 255), outline=border_col, width=2 if key == "A" else 1)

        draw.text((x0 + 24, y0 + 20), title, fill=(245, 248, 250, 255), font=f_h2)
        draw.text((x0 + 24, y0 + 50), desc1, fill=(162, 178, 188, 255), font=f_body)
        draw.text((x0 + 24, y0 + 70), desc2, fill=(162, 178, 188, 255), font=f_body)

        well_y = y0 + 104
        well_w = 220
        well_h = 242

        # Left well: Windows Fluent Design
        wx0 = x0 + 24
        draw.rounded_rectangle([wx0, well_y, wx0 + well_w, well_y + well_h], radius=12, fill=(24, 33, 38, 255), outline=(48, 62, 70, 255))
        ic_win = win_icons[key].resize((176, 176), Image.Resampling.LANCZOS)
        sheet.alpha_composite(ic_win, (wx0 + (well_w - 176) // 2, well_y + 12))
        draw.text((wx0 + well_w // 2, well_y + 204), "Windows Fluent Design 版", fill=(100, 205, 255, 255), font=f_small, anchor="mm")
        draw.text((wx0 + well_w // 2, well_y + 224), "独立多层实物剪影 · 桌面/开始菜单", fill=(140, 158, 168, 255), font=f_small, anchor="mm")

        # Right well: Mobile Rounded-Rectangle
        mx0 = x0 + 24 + well_w + 24
        draw.rounded_rectangle([mx0, well_y, mx0 + well_w, well_y + well_h], radius=12, fill=(24, 33, 38, 255), outline=(48, 62, 70, 255))
        ic_mob = mob_icons[key].resize((168, 168), Image.Resampling.LANCZOS)
        sheet.alpha_composite(ic_mob, (mx0 + (well_w - 168) // 2, well_y + 16))
        draw.text((mx0 + well_w // 2, well_y + 204), "移动端圆角矩形版 (Squircle)", fill=(130, 230, 175, 255), font=f_small, anchor="mm")
        draw.text((mx0 + well_w // 2, well_y + 224), "Android / iOS 标准圆角矩形容器", fill=(140, 158, 168, 255), font=f_small, anchor="mm")

        # Dark surface multi-size preview strip
        strip_dark_y = well_y + well_h + 16
        draw.rounded_rectangle([x0 + 24, strip_dark_y, x0 + card_w - 24, strip_dark_y + 132], radius=10, fill=(25, 34, 39, 255), outline=(45, 58, 65, 255))
        draw.text((x0 + 38, strip_dark_y + 14), "深色桌面 / 任务栏实寸 (64 / 32 / 24 / 16 px)   |   移动端 (64方 / 48方 / 48圆)", fill=(165, 180, 190, 255), font=f_small)

        px_x = x0 + 42
        for sz in [64, 32, 24, 16]:
            im_s = win_icons[key].resize((sz, sz), Image.Resampling.LANCZOS)
            sheet.alpha_composite(im_s, (px_x, strip_dark_y + 36 + (64 - sz) // 2))
            draw.text((px_x + sz // 2, strip_dark_y + 114), f"{sz}", fill=(130, 145, 155, 255), font=f_small, anchor="mm")
            px_x += sz + 22

        draw.line([(px_x - 6, strip_dark_y + 36), (px_x - 6, strip_dark_y + 118)], fill=(52, 66, 74, 255), width=1)
        px_x += 12
        for sz, src_im, lbl in [(64, mob_icons[key], "64方"), (48, mob_icons[key], "48方"), (48, mob_icons[key + "_round"], "48圆")]:
            im_s = src_im.resize((sz, sz), Image.Resampling.LANCZOS)
            sheet.alpha_composite(im_s, (px_x, strip_dark_y + 36 + (64 - sz) // 2))
            draw.text((px_x + sz // 2, strip_dark_y + 114), lbl, fill=(130, 145, 155, 255), font=f_small, anchor="mm")
            px_x += sz + 18

        # Light surface multi-size preview strip
        strip_light_y = strip_dark_y + 146
        draw.rounded_rectangle([x0 + 24, strip_light_y, x0 + card_w - 24, strip_light_y + 142], radius=10, fill=(242, 244, 247, 255), outline=(210, 216, 224, 255))
        draw.text((x0 + 38, strip_light_y + 14), "浅色模式 (Light #F3F4F7) · 桌面图标与窗口左上角 16px 标题栏效果", fill=(70, 82, 94, 255), font=f_small)

        px_x = x0 + 42
        for sz in [64, 32, 24, 16]:
            im_s = win_icons[key].resize((sz, sz), Image.Resampling.LANCZOS)
            sheet.alpha_composite(im_s, (px_x, strip_light_y + 40 + (64 - sz) // 2))
            draw.text((px_x + sz // 2, strip_light_y + 122), f"{sz}", fill=(90, 102, 114, 255), font=f_small, anchor="mm")
            px_x += sz + 22

        tb_x = px_x + 8
        tb_y = strip_light_y + 52
        draw.rounded_rectangle([tb_x, tb_y, x0 + card_w - 38, tb_y + 40], radius=6, fill=(255, 255, 255, 255), outline=(209, 209, 209, 255))
        im_16 = mob_icons[key].resize((18, 18), Image.Resampling.LANCZOS)
        sheet.alpha_composite(im_16, (tb_x + 12, tb_y + 11))
        draw.text((tb_x + 38, tb_y + 20), "Photo Archive", fill=(70, 74, 80, 255), font=f_segoe_tb, anchor="lm")

    # Bottom section: Embedded Windows 11 Native Lineup Strip
    lineup_im = Image.open(os.path.join(OUT_DIR, "win11-lineup-comparison.png")).convert("RGBA")
    lw, lh = lineup_im.size
    target_w = W - 96
    row1_crop = lineup_im.crop((0, 0, lw, 205))
    r1_h = int(round(205 * (target_w / lw)))
    row1_scaled = row1_crop.resize((target_w, r1_h), Image.Resampling.LANCZOS)
    sheet.alpha_composite(row1_scaled, (48, 816))

    out_path = os.path.join(OUT_DIR, "logo-design-showcase.png")
    sheet.convert("RGB").save(out_path, quality=95)
    return out_path


def build_flagship_pair_hero(win_a, mob_a):
    """Builds a clean side-by-side hero card of the Flagship Pair (Windows Fluent Design + Mobile Squircle)."""
    W, H = 1200, 560
    card = Image.new("RGBA", (W, H), (24, 33, 38, 255))
    draw = ImageDraw.Draw(card)

    f_title = load_cjk_font(24, bold=True)
    f_sub = load_cjk_font(15, bold=False)
    f_lbl = load_cjk_font(18, bold=True)
    f_desc = load_cjk_font(13, bold=False)

    draw.text((60, 36), "Photo Archive — 主推新 Logo 套组（方案 A：书页与路线叠卡）", fill=(245, 248, 250, 255), font=f_title)
    draw.text((60, 72), "同一套品牌视觉基因（「可读的书页 Archive Page」+「旅途路线 Route」），针对桌面端与移动端各自原生形态定制", fill=(160, 178, 190, 255), font=f_sub)

    # Left panel: Windows Fluent Design Edition
    draw.rounded_rectangle([60, 112, 576, 516], radius=16, fill=(32, 44, 49, 255), outline=(64, 166, 245, 180), width=2)
    ic_w = win_a.resize((260, 260), Image.Resampling.LANCZOS)
    card.alpha_composite(ic_w, (60 + (516 - 260) // 2, 132))
    draw.text((318, 424), "Windows Fluent Design 版（桌面端）", fill=(100, 208, 255, 255), font=f_lbl, anchor="mm")
    draw.text((318, 456), "非对称双卡破界剪影 · 暖白手记书页 + 琥珀书脊底边 + 橙红印记", fill=(180, 195, 205, 255), font=f_desc, anchor="mm")
    draw.text((318, 480), "前景叠合 Fluent 渐变蓝路线卡（带柔和接触阴影与顶部高光）", fill=(150, 168, 178, 255), font=f_desc, anchor="mm")

    # Right panel: Mobile Rounded-Rectangle Edition
    draw.rounded_rectangle([624, 112, 1140, 516], radius=16, fill=(32, 44, 49, 255), outline=(85, 195, 145, 180), width=2)
    ic_m = mob_a.resize((248, 248), Image.Resampling.LANCZOS)
    card.alpha_composite(ic_m, (624 + (516 - 248) // 2, 138))
    draw.text((882, 424), "圆角矩形版（移动端 / 标题栏角标）", fill=(130, 232, 178, 255), font=f_lbl, anchor="mm")
    draw.text((882, 456), "标准圆角矩形容器 (Squircle) · 深海蓝衬底内嵌左上微缩书页角", fill=(180, 195, 205, 255), font=f_desc, anchor="mm")
    draw.text((882, 480), "右下主体 Fluent 蓝卡承载标志性对角路线，完美适配 Adaptive 遮罩", fill=(150, 168, 178, 255), font=f_desc, anchor="mm")

    out_path = os.path.join(OUT_DIR, "logo-flagship-pair-A.png")
    card.convert("RGB").save(out_path, quality=95)
    return out_path


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    win_icons = {
        "A": render_concept_a_windows(512),
        "B": render_concept_b_windows(512),
        "C": render_concept_c_windows(512),
    }
    mob_icons = {
        "A": render_concept_a_mobile(512, "square"),
        "A_round": render_concept_a_mobile(512, "round"),
        "B": render_concept_b_mobile(512, "square"),
        "B_round": render_concept_b_mobile(512, "round"),
        "C": render_concept_c_mobile(512, "square"),
        "C_round": render_concept_c_mobile(512, "round"),
    }

    win_icons["A"].save(os.path.join(OUT_DIR, "logo-fluent-windows-A.png"))
    mob_icons["A"].save(os.path.join(OUT_DIR, "logo-mobile-rounded-A.png"))
    win_icons["B"].save(os.path.join(OUT_DIR, "logo-fluent-windows-B.png"))
    mob_icons["B"].save(os.path.join(OUT_DIR, "logo-mobile-rounded-B.png"))
    win_icons["C"].save(os.path.join(OUT_DIR, "logo-fluent-windows-C.png"))
    mob_icons["C"].save(os.path.join(OUT_DIR, "logo-mobile-rounded-C.png"))

    write_svg_assets()

    win_with_mob = dict(win_icons)
    win_with_mob["A_mobile"] = mob_icons["A"]
    p1 = build_win11_lineup_comparison(win_with_mob)
    p2 = build_full_design_sheet(win_icons, mob_icons)
    p3 = build_flagship_pair_hero(win_icons["A"], mob_icons["A"])
    print("Generated:", p1)
    print("Generated:", p2)
    print("Generated:", p3)


if __name__ == "__main__":
    main()
