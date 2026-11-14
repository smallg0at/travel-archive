"""
High-precision SDF / Supersampled Vector Renderer for Photo Archive Logo Concepts — Batch 2 (D, E, F).
Freed from the original blue-squircle + dotted-route motif, exploring three rich, multi-color,
object-centric metaphors tailored for Windows 11 Fluent Design & Mobile Squircle:

- Concept D ("拍立得相片叠与旅行图钉 · Polaroid Prints & Map Pin"):
  Stacked tactile photo prints with a vibrant cyan/emerald mountain-bay landscape & golden sun,
  written caption lines on the wide white Polaroid bottom margin, and a 3D Coral-Red Map Pin
  overlapping the top-right corner.

- Concept E ("时光档案盒与月份索引卡 · Chronicle Archive Box & Month Tabs"):
  A sculpted slate-metal desktop archive box (matching Calculator/Clock's slate body) holding
  stepped multi-color month index cards (Amber Gold, Coral Red, and a front Sky-Blue landscape
  photo card), embodying "tens of thousands of photos across a decade, filed by month".

- Concept F ("游记手账本与光学镜头徽章 · Traveler's Journal & Sapphire Lens"):
  A warm terracotta/amber leather hardcover travel journal with an open ivory page (mini landscape
  header + narrative prose lines + crimson bookmark ribbon), overlapped at bottom-right by a
  metallic-rimmed Sapphire Camera Lens / Compass badge.
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


def sd_rot_round_rect(x, y, cx, cy, hw, hh, r, deg):
    rad = math.radians(deg)
    ca, sa = math.cos(rad), math.sin(rad)
    dx, dy = x - cx, y - cy
    rx = dx * ca + dy * sa
    ry = -dx * sa + dy * ca
    qx = np.abs(rx) - (hw - r)
    qy = np.abs(ry) - (hh - r)
    outside = np.hypot(np.maximum(qx, 0.0), np.maximum(qy, 0.0))
    inside = np.minimum(np.maximum(qx, qy), 0.0)
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


def sd_map_pin(x, y, cx, cy, head_r, tip_y, deg=0.0):
    """
    Smooth teardrop / map location pin with head centered at (cx, cy) of radius head_r
    and bottom point at (cx, tip_y), optionally rotated by `deg` around (cx, cy).
    """
    if abs(deg) > 1e-4:
        rad = math.radians(deg)
        ca, sa = math.cos(rad), math.sin(rad)
        dx, dy = x - cx, y - cy
        rx = cx + dx * ca + dy * sa
        ry = cy - dx * sa + dy * ca
    else:
        rx, ry = x, y

    # Combine circle at (cx, cy) with a tapered capsule down to (cx, tip_y - tip_r)
    tip_r = head_r * 0.16
    ay = cy
    by = tip_y - tip_r
    t = np.clip((ry - ay) / max(1e-5, by - ay), 0.0, 1.0)
    r_at_t = head_r * (1.0 - t) + tip_r * t
    sd_cone = np.hypot(rx - cx, ry - (ay + t * (by - ay))) - r_at_t
    return sd_cone


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


def paint_scenic_landscape(x, y, aa, vx0, vy0, vx1, vy1, sun_xy, sun_r=6.5):
    """
    Renders a lush Windows 11 Fluent landscape inside a viewport [vx0..vx1, vy0..vy1]:
    - Cyan-to-azure sky (#4CE0FF -> #0E8CE0)
    - Warm golden sun (#FFE066 -> #FF9E00)
    - Back emerald-teal mountain ridge (#1ED4A4 -> #0E8F76)
    - Front deep teal-azure coastal ridge (#0A789E -> #044B6E)
    """
    vw = vx1 - vx0
    vh = vy1 - vy0
    sky = linear_grad(x, y, vx0, vy0, vx0, vy1, "#5CE4FF", "#108EE2", c_mid="#28B8F7", mid_pos=0.55)

    # Golden sun
    sx, sy = sun_xy
    m_sun = aa_mask(sd_circle(x, y, sx, sy, sun_r), aa)
    sun_rgb = linear_grad(x, y, sx - sun_r, sy - sun_r, sx + sun_r, sy + sun_r, "#FFE46B", "#FF9900")
    sky = sky * (1.0 - m_sun[..., None]) + sun_rgb * m_sun[..., None]

    # Back emerald mountain (peaks on the left/center)
    nx = (x - vx0) / max(1e-5, vw)
    hill1_y = vy0 + vh * 0.64 - vh * 0.24 * np.exp(-((nx - 0.34) / 0.36) ** 2)
    m_hill1 = aa_mask(hill1_y - y, aa)
    hill1_rgb = linear_grad(x, y, vx0, vy0 + vh * 0.4, vx1, vy1, "#2AD6A8", "#0B806C")
    sky = sky * (1.0 - m_hill1[..., None]) + hill1_rgb * m_hill1[..., None]

    # Front teal-cobalt ridge (peaks on the right)
    hill2_y = vy0 + vh * 0.77 - vh * 0.22 * np.exp(-((nx - 0.74) / 0.38) ** 2)
    m_hill2 = aa_mask(hill2_y - y, aa)
    hill2_rgb = linear_grad(x, y, vx0, vy0 + vh * 0.55, vx1, vy1, "#0E8AB8", "#05476E")
    sky = sky * (1.0 - m_hill2[..., None]) + hill2_rgb * m_hill2[..., None]

    return sky


# ==============================================================================
# CONCEPT D: "拍立得相片叠与旅行图钉 · Polaroid Prints & Map Pin"
# ==============================================================================

def render_concept_d_windows(px_size=512):
    x, y, aa = make_grid(px_size)
    rgb = np.zeros((px_size, px_size, 3), dtype=np.float32)
    a = np.zeros((px_size, px_size), dtype=np.float32)

    # 1. Back tilted Polaroid card (-8 deg, shifted top-left) with warm amber sunset photo inside
    sd_back = sd_rot_round_rect(x, y, 42.0, 46.0, 29.0, 34.0, 7.0, -8.5)
    m_back = aa_mask(sd_back, aa)
    rgb, a = add_drop_shadow(rgb, a, m_back, px_size, offset_x=0.0, offset_y=2.2, blur_radius=3.2, opacity=0.24)
    back_card_rgb = linear_grad(x, y, 12, 12, 70, 80, "#E4EAF0", "#C5D0DC")
    rgb, a = blend_layer(rgb, a, back_card_rgb, m_back)

    # Warm sunset orange/gold inner photo on the back card
    sd_back_inner = sd_rot_round_rect(x, y, 41.2, 41.5, 23.5, 23.0, 4.5, -8.5)
    m_back_inner = aa_mask(sd_back_inner, aa) * m_back
    back_photo_rgb = linear_grad(x, y, 16, 16, 65, 65, "#FFB900", "#E05319")
    rgb, a = blend_layer(rgb, a, back_photo_rgb, m_back_inner)

    # 2. Main Front Polaroid Card (upright, x=18..82, y=15..91, rx=8.0)
    sd_front = sd_round_rect(x, y, 50.0, 53.0, 32.0, 38.0, 8.0)
    m_front = aa_mask(sd_front, aa)
    rgb, a = add_drop_shadow(rgb, a, m_front, px_size, offset_x=-1.5, offset_y=2.5, blur_radius=4.0, opacity=0.35, color=(6, 20, 38))

    front_card_rgb = linear_grad(x, y, 18, 15, 82, 91, "#FFFFFF", "#E3E9F0")
    # Subtle warm paper bottom thickness strip (y=88..91)
    m_bottom_edge = aa_mask(88.0 - y, aa)
    edge_rgb = linear_grad(x, y, 18, 88, 82, 91, "#C4CED9", "#9FB0C2")
    front_card_rgb = front_card_rgb * (1.0 - m_bottom_edge[..., None]) + edge_rgb * m_bottom_edge[..., None]
    rgb, a = blend_layer(rgb, a, front_card_rgb, m_front)

    # Inner scenic photo viewport (x=24..76, y=21..69, rx=5.0)
    sd_view = sd_round_rect(x, y, 50.0, 45.0, 26.0, 24.0, 5.0)
    m_view = aa_mask(sd_view, aa) * m_front
    scenic_rgb = paint_scenic_landscape(x, y, aa, 24.0, 21.0, 76.0, 69.0, sun_xy=(36.0, 33.0), sun_r=6.2)
    rgb, a = blend_layer(rgb, a, scenic_rgb, m_view)

    # Written caption lines on the wide white Polaroid bottom margin (y=74..83)
    sd_l1 = sd_round_rect(x, y, 42.0, 75.8, 16.5, 2.0, 2.0)
    sd_l2 = sd_round_rect(x, y, 36.5, 81.8, 11.0, 2.0, 2.0)
    m_lines = aa_mask(np.minimum(sd_l1, sd_l2), aa) * m_front
    rgb, a = blend_layer(rgb, a, linear_grad(x, y, 24, 74, 60, 84, "#6C8094", "#506478"), m_lines)

    # Small warm amber tag pill on bottom-right of Polaroid margin (x=65..75, y=75..81)
    sd_tag = sd_round_rect(x, y, 70.0, 78.5, 5.2, 3.0, 2.5)
    m_tag = aa_mask(sd_tag, aa) * m_front
    rgb, a = blend_layer(rgb, a, linear_grad(x, y, 65, 75, 75, 82, "#FFAA00", "#E06A00"), m_tag)

    # 3. Foreground Overlapping 3D Coral-Red Map Pin at top-right (breaking out of the Polaroid silhouette!)
    sd_pin = sd_map_pin(x, y, cx=76.5, cy=22.5, head_r=12.5, tip_y=45.0, deg=12.0)
    m_pin = aa_mask(sd_pin, aa)
    rgb, a = add_drop_shadow(rgb, a, m_pin, px_size, offset_x=-1.8, offset_y=2.4, blur_radius=3.5, opacity=0.38, color=(15, 20, 30))

    pin_rgb = linear_grad(x, y, 64, 10, 89, 45, "#FF6E38", "#C82800", c_mid="#E8430A", mid_pos=0.52)
    rgb, a = blend_layer(rgb, a, pin_rgb, m_pin)

    # Crisp white inner hole of the Map Pin
    m_pin_dot = aa_mask(sd_circle(x, y, 76.5, 22.5, 5.0), aa) * m_pin
    rgb, a = blend_layer(rgb, a, hex_rgb("#FFFFFF")[None, None, :], m_pin_dot)

    return to_pil(rgb, a)


def render_concept_d_mobile(px_size=512, shape="square"):
    """Mobile Rounded-Rectangle Edition of Concept D (Polaroid frame + scenic mountain/sun + Coral Map Pin)."""
    x, y, aa = make_grid(px_size)
    rgb = np.zeros((px_size, px_size, 3), dtype=np.float32)
    a = np.zeros((px_size, px_size), dtype=np.float32)

    if shape == "round":
        sd_bg = sd_circle(x, y, 50.0, 50.0, 46.0)
    else:
        sd_bg = sd_round_rect(x, y, 50.0, 50.0, 46.0, 46.0, 18.5)
    mask_bg = aa_mask(sd_bg, aa)

    # Warm white Polaroid card container (#FFFFFF -> #E2E8F0)
    card_rgb = linear_grad(x, y, 4, 4, 96, 96, "#FFFFFF", "#DCE3EC")
    rgb, a = blend_layer(rgb, a, card_rgb, mask_bg)

    # Inner scenic photo canvas (x=13..87, y=13..73, rx=11.5)
    sd_view = sd_round_rect(x, y, 50.0, 43.0, 37.0, 30.0, 11.5)
    m_view = aa_mask(sd_view, aa) * mask_bg
    scenic_rgb = paint_scenic_landscape(x, y, aa, 13.0, 13.0, 87.0, 73.0, sun_xy=(32.0, 30.0), sun_r=8.2)
    rgb, a = blend_layer(rgb, a, scenic_rgb, m_view)

    # Bottom Polaroid margin caption lines (y=80..87)
    sd_l1 = sd_round_rect(x, y, 38.0, 81.5, 19.0, 2.3, 2.3)
    sd_l2 = sd_round_rect(x, y, 31.0, 87.8, 12.0, 2.2, 2.2)
    m_lines = aa_mask(np.minimum(sd_l1, sd_l2), aa) * mask_bg
    rgb, a = blend_layer(rgb, a, hex_rgb("#647A8F")[None, None, :], m_lines)

    # Bold Coral-Red Map Pin overlapping top-right of the photo viewport (cx=70, cy=29)
    sd_pin = sd_map_pin(x, y, cx=69.5, cy=28.5, head_r=13.5, tip_y=53.5, deg=8.0)
    m_pin = aa_mask(sd_pin, aa) * mask_bg
    rgb, a = add_drop_shadow(rgb, a, m_pin, px_size, offset_x=-1.5, offset_y=2.2, blur_radius=3.2, opacity=0.35, color=(8, 22, 42))
    pin_rgb = linear_grad(x, y, 56, 15, 83, 53, "#FF6E38", "#C82800", c_mid="#E8430A", mid_pos=0.52)
    rgb, a = blend_layer(rgb, a, pin_rgb, m_pin)

    m_pin_dot = aa_mask(sd_circle(x, y, 69.5, 28.5, 5.4), aa) * m_pin
    rgb, a = blend_layer(rgb, a, hex_rgb("#FFFFFF")[None, None, :], m_pin_dot)

    return to_pil(rgb, a)


# ==============================================================================
# CONCEPT E: "时光档案盒与月份索引卡 · Chronicle Archive Box & Month Tabs"
# ==============================================================================

def render_concept_e_windows(px_size=512):
    x, y, aa = make_grid(px_size)
    rgb = np.zeros((px_size, px_size, 3), dtype=np.float32)
    a = np.zeros((px_size, px_size), dtype=np.float32)

    # 1. Back Index Card 1 (Left-tabbed Warm Amber-Gold Archive Divider, y=10..62, x=15..85)
    sd_card1 = np.minimum(
        sd_round_rect(x, y, 50.0, 36.0, 34.0, 20.0, 6.0),
        sd_round_rect(x, y, 29.0, 16.0, 13.0, 7.5, 4.5),  # Left month tab ear
    )
    m_card1 = aa_mask(sd_card1, aa)
    rgb, a = add_drop_shadow(rgb, a, m_card1, px_size, offset_x=0.0, offset_y=2.0, blur_radius=2.8, opacity=0.22)
    card1_rgb = linear_grad(x, y, 16, 9, 84, 50, "#FFD042", "#D97706", c_mid="#F59E0B", mid_pos=0.5)
    rgb, a = blend_layer(rgb, a, card1_rgb, m_card1)

    # 2. Middle Index Card 2 (Right-tabbed Coral-Red Narrative Card, y=16..68, x=14..86)
    sd_card2 = np.minimum(
        sd_round_rect(x, y, 50.0, 43.0, 35.5, 20.0, 6.5),
        sd_round_rect(x, y, 69.5, 22.0, 14.0, 7.5, 4.5),  # Right month tab ear
    )
    m_card2 = aa_mask(sd_card2, aa)
    rgb, a = add_drop_shadow(rgb, a, m_card2, px_size, offset_x=0.0, offset_y=1.8, blur_radius=2.8, opacity=0.28)
    card2_rgb = linear_grad(x, y, 14, 15, 86, 56, "#FF6E38", "#C82D00", c_mid="#E84610", mid_pos=0.5)
    rgb, a = blend_layer(rgb, a, card2_rgb, m_card2)

    # 3. Front Pull-out Scenic Photo Card (Centered, rising above the archive box: x=20..80, y=24..74)
    sd_photo_card = sd_round_rect(x, y, 50.0, 49.0, 30.0, 24.0, 7.0)
    m_photo_card = aa_mask(sd_photo_card, aa)
    rgb, a = add_drop_shadow(rgb, a, m_photo_card, px_size, offset_x=0.0, offset_y=2.0, blur_radius=3.2, opacity=0.32)
    frame_rgb = linear_grad(x, y, 20, 25, 80, 73, "#FFFFFF", "#DFE6EE")
    rgb, a = blend_layer(rgb, a, frame_rgb, m_photo_card)

    # Inner scenic landscape on the front photo card (x=25..75, y=29..64)
    sd_photo_inner = sd_round_rect(x, y, 50.0, 46.5, 25.0, 17.5, 4.5)
    m_photo_inner = aa_mask(sd_photo_inner, aa) * m_photo_card
    scenic_rgb = paint_scenic_landscape(x, y, aa, 25.0, 29.0, 75.0, 64.0, sun_xy=(62.0, 38.0), sun_r=5.2)
    rgb, a = blend_layer(rgb, a, scenic_rgb, m_photo_inner)

    # 4. Foreground Archive Box Tray (x=10..90, y=54..92, with a central scooped thumb notch at top!)
    sd_tray_raw = sd_round_rect(x, y, 50.0, 73.0, 40.0, 19.0, 9.5)
    # Subtract a smooth rounded scoop at top-center (cx=50, cy=52, hw=13, hh=6.5, r=5)
    sd_scoop = sd_round_rect(x, y, 50.0, 51.5, 13.5, 6.8, 5.5)
    sd_tray = np.maximum(sd_tray_raw, -sd_scoop)
    m_tray = aa_mask(sd_tray, aa)

    rgb, a = add_drop_shadow(rgb, a, m_tray, px_size, offset_x=0.0, offset_y=2.4, blur_radius=3.6, opacity=0.35, color=(8, 16, 24))

    # Fluent Slate-Metal body (matching Calculator & Clock in reference image: #828B94 -> #586068)
    tray_rgb = linear_grad(x, y, 10, 54, 90, 92, "#87919B", "#525A62", c_mid="#6C757E", mid_pos=0.55)
    # Darker base lip at bottom (y=86..92)
    m_lip = aa_mask(86.5 - y, aa)
    lip_rgb = linear_grad(x, y, 10, 86, 90, 92, "#454C54", "#343A40")
    tray_rgb = tray_rgb * (1.0 - m_lip[..., None]) + lip_rgb * m_lip[..., None]

    # Top edge highlight on the slate tray
    sd_tray_top = np.abs(sd_tray + 0.6) - 0.6
    m_tray_hi = aa_mask(sd_tray_top, aa) * m_tray * np.clip((63.0 - y) / 8.0, 0.0, 1.0) * 0.4
    tray_rgb = tray_rgb * (1.0 - m_tray_hi[..., None]) + 255.0 * m_tray_hi[..., None]

    rgb, a = blend_layer(rgb, a, tray_rgb, m_tray)

    # Crisp metallic Archive Label Plate on the front of the box (cx=50, cy=73.5, hw=15, hh=5.5, r=3.2)
    sd_plate = sd_round_rect(x, y, 50.0, 73.5, 15.5, 5.5, 3.2)
    m_plate = aa_mask(sd_plate, aa) * m_tray
    plate_rgb = linear_grad(x, y, 35, 68, 65, 79, "#EEF2F6", "#C8D1DC")
    rgb, a = blend_layer(rgb, a, plate_rgb, m_plate)

    # Inner dark slot line on the label plate
    sd_slot = sd_round_rect(x, y, 50.0, 73.5, 9.5, 1.8, 1.8)
    m_slot = aa_mask(sd_slot, aa) * m_plate
    rgb, a = blend_layer(rgb, a, hex_rgb("#49525B")[None, None, :], m_slot)

    return to_pil(rgb, a)


def render_concept_e_mobile(px_size=512, shape="square"):
    """Mobile Rounded-Rectangle Edition of Concept E (Archive Box + Multi-color Month Tabs + Scenic Photo)."""
    x, y, aa = make_grid(px_size)
    rgb = np.zeros((px_size, px_size, 3), dtype=np.float32)
    a = np.zeros((px_size, px_size), dtype=np.float32)

    if shape == "round":
        sd_bg = sd_circle(x, y, 50.0, 50.0, 46.0)
    else:
        sd_bg = sd_round_rect(x, y, 50.0, 50.0, 46.0, 46.0, 18.5)
    mask_bg = aa_mask(sd_bg, aa)

    # Deep slate-navy interior backdrop (#2D3742 -> #1C242C)
    bg_rgb = linear_grad(x, y, 4, 4, 96, 60, "#38434F", "#1E262E")
    rgb, a = blend_layer(rgb, a, bg_rgb, mask_bg)

    # Back Index Tab 1 (Left Amber-Gold Tab)
    sd_c1 = np.minimum(
        sd_round_rect(x, y, 50.0, 36.0, 36.0, 18.0, 6.0),
        sd_round_rect(x, y, 28.0, 18.0, 13.0, 7.0, 4.0),
    )
    m_c1 = aa_mask(sd_c1, aa) * mask_bg
    rgb, a = blend_layer(rgb, a, linear_grad(x, y, 14, 11, 86, 48, "#FFD042", "#D97706"), m_c1)

    # Middle Index Tab 2 (Right Coral-Red Tab)
    sd_c2 = np.minimum(
        sd_round_rect(x, y, 50.0, 42.0, 37.0, 18.0, 6.0),
        sd_round_rect(x, y, 71.0, 23.0, 13.0, 7.0, 4.0),
    )
    m_c2 = aa_mask(sd_c2, aa) * mask_bg
    rgb, a = blend_layer(rgb, a, linear_grad(x, y, 13, 16, 87, 52, "#FF6E38", "#C82D00"), m_c2)

    # Front Scenic Photo Card (x=17..83, y=26..72)
    sd_pc = sd_round_rect(x, y, 50.0, 49.0, 32.5, 22.5, 7.0)
    m_pc = aa_mask(sd_pc, aa) * mask_bg
    rgb, a = add_drop_shadow(rgb, a, m_pc, px_size, offset_x=0.0, offset_y=2.0, blur_radius=3.0, opacity=0.30)
    rgb, a = blend_layer(rgb, a, linear_grad(x, y, 17, 26, 83, 72, "#FFFFFF", "#DFE6EE"), m_pc)

    sd_pi = sd_round_rect(x, y, 50.0, 47.0, 27.5, 17.0, 4.5)
    m_pi = aa_mask(sd_pi, aa) * m_pc
    scenic_rgb = paint_scenic_landscape(x, y, aa, 22.5, 30.0, 77.5, 64.0, sun_xy=(64.0, 39.0), sun_r=5.2)
    rgb, a = blend_layer(rgb, a, scenic_rgb, m_pi)

    # Front Slate-Metal Archive Tray filling the bottom half of the squircle (y=58..96) with central scoop
    sd_tray_raw = sd_round_rect(x, y, 50.0, 78.0, 48.0, 20.0, 4.0)
    sd_scoop = sd_round_rect(x, y, 50.0, 56.5, 14.5, 6.8, 5.5)
    sd_tray = np.maximum(sd_tray_raw, -sd_scoop)
    m_tray = aa_mask(sd_tray, aa) * mask_bg
    rgb, a = add_drop_shadow(rgb, a, m_tray, px_size, offset_x=0.0, offset_y=-1.5, blur_radius=3.0, opacity=0.30)

    tray_rgb = linear_grad(x, y, 4, 58, 96, 96, "#87919B", "#525A62", c_mid="#6C757E", mid_pos=0.55)
    rgb, a = blend_layer(rgb, a, tray_rgb, m_tray)

    # Metallic Label Plate on the tray
    sd_plate = sd_round_rect(x, y, 50.0, 77.5, 16.5, 5.8, 3.4)
    m_plate = aa_mask(sd_plate, aa) * m_tray
    rgb, a = blend_layer(rgb, a, linear_grad(x, y, 33, 72, 67, 83, "#EEF2F6", "#C8D1DC"), m_plate)
    sd_slot = sd_round_rect(x, y, 50.0, 77.5, 10.0, 1.9, 1.9)
    m_slot = aa_mask(sd_slot, aa) * m_plate
    rgb, a = blend_layer(rgb, a, hex_rgb("#49525B")[None, None, :], m_slot)

    return to_pil(rgb, a)


# ==============================================================================
# CONCEPT F: "游记手账本与光学镜头徽章 · Traveler's Journal & Sapphire Lens"
# ==============================================================================

def render_concept_f_windows(px_size=512):
    x, y, aa = make_grid(px_size)
    rgb = np.zeros((px_size, px_size, 3), dtype=np.float32)
    a = np.zeros((px_size, px_size), dtype=np.float32)

    # 1. Warm Terracotta / Amber Leather Hardcover Journal Base (x=12..78, y=8..88, rx=9.0)
    sd_cover = sd_round_rect(x, y, 45.0, 48.0, 33.0, 40.0, 9.0)
    m_cover = aa_mask(sd_cover, aa)
    rgb, a = add_drop_shadow(rgb, a, m_cover, px_size, offset_x=0.0, offset_y=2.4, blur_radius=3.5, opacity=0.28)

    cover_rgb = linear_grad(x, y, 12, 8, 78, 88, "#E87A24", "#9E4208", c_mid="#C65911", mid_pos=0.55)
    # Left dark leather spine (x=12..22.5)
    m_spine = aa_mask(x - 22.5, aa) * m_cover
    spine_rgb = linear_grad(x, y, 12, 8, 22, 88, "#9E3E06", "#6B2602")
    cover_rgb = cover_rgb * (1.0 - m_spine[..., None]) + spine_rgb * m_spine[..., None]
    rgb, a = blend_layer(rgb, a, cover_rgb, m_cover)

    # 2. Inner Ivory Journal Page Stack (x=22..74, y=13..82, rx=6.0)
    sd_page = sd_round_rect(x, y, 48.0, 47.5, 26.0, 34.5, 6.0)
    m_page = aa_mask(sd_page, aa)
    rgb, a = add_drop_shadow(rgb, a, m_page, px_size, offset_x=1.2, offset_y=1.5, blur_radius=2.2, opacity=0.22)
    page_rgb = linear_grad(x, y, 22, 13, 74, 82, "#FAF9F5", "#DFE4EC")
    rgb, a = blend_layer(rgb, a, page_rgb, m_page)

    # Scenic photo header inside the journal page (x=27..69, y=19..46, rx=4.0)
    sd_header = sd_round_rect(x, y, 48.0, 32.5, 21.0, 13.5, 4.0)
    m_header = aa_mask(sd_header, aa) * m_page
    scenic_rgb = paint_scenic_landscape(x, y, aa, 27.0, 19.0, 69.0, 46.0, sun_xy=(59.0, 26.5), sun_r=4.2)
    rgb, a = blend_layer(rgb, a, scenic_rgb, m_header)

    # Top Crimson Bookmark Ribbon hanging from top edge (x=32..39, y=6..25)
    sd_rib = sd_round_rect(x, y, 35.5, 15.0, 3.6, 9.5, 2.0)
    m_rib = aa_mask(sd_rib, aa)
    rgb, a = blend_layer(rgb, a, linear_grad(x, y, 32, 6, 39, 25, "#FF5226", "#C42000"), m_rib)

    # Written journal lines below the photo header (y=53, 60.5, 68)
    sd_l1 = sd_round_rect(x, y, 45.0, 53.0, 17.5, 2.0, 2.0)
    sd_l2 = sd_round_rect(x, y, 41.0, 60.5, 13.5, 2.0, 2.0)
    sd_l3 = sd_round_rect(x, y, 38.0, 68.0, 10.5, 2.0, 2.0)
    m_lines = aa_mask(np.minimum(sd_l1, np.minimum(sd_l2, sd_l3)), aa) * m_page
    rgb, a = blend_layer(rgb, a, hex_rgb("#6E8092")[None, None, :], m_lines)

    # 3. Foreground Overlapping Sapphire Camera Lens / Compass Badge at bottom-right (cx=69, cy=69, r=22.5)
    sd_lens_outer = sd_circle(x, y, 69.0, 69.0, 22.5)
    m_lens_outer = aa_mask(sd_lens_outer, aa)
    rgb, a = add_drop_shadow(rgb, a, m_lens_outer, px_size, offset_x=-2.0, offset_y=2.4, blur_radius=4.0, opacity=0.40, color=(8, 18, 32))

    # Brushed silver-slate metallic lens bezel (#F0F4F8 -> #8A96A4)
    bezel_rgb = linear_grad(x, y, 47, 47, 91, 91, "#F2F5F8", "#7E8B99", c_mid="#B8C2CC", mid_pos=0.5)
    rgb, a = blend_layer(rgb, a, bezel_rgb, m_lens_outer)

    # Dark anodized inner ring (r=18.2)
    m_lens_ring = aa_mask(sd_circle(x, y, 69.0, 69.0, 18.2), aa)
    ring_rgb = linear_grad(x, y, 51, 51, 87, 87, "#2B3540", "#121820")
    rgb, a = blend_layer(rgb, a, ring_rgb, m_lens_ring)

    # Deep Sapphire Optical Glass element (r=14.8)
    m_glass = aa_mask(sd_circle(x, y, 69.0, 69.0, 14.8), aa)
    glass_rgb = linear_grad(x, y, 54, 54, 84, 84, "#3CD2FA", "#003B75", c_mid="#0078D4", mid_pos=0.48)
    rgb, a = blend_layer(rgb, a, glass_rgb, m_glass)

    # Inner aperture circle (r=7.2) in deeper indigo-blue (#002B59) with crisp cyan rim
    m_ap_rim = aa_mask(sd_ring(x, y, 69.0, 69.0, 7.6, 1.4), aa) * m_glass
    m_ap_core = aa_mask(sd_circle(x, y, 69.0, 69.0, 7.0), aa) * m_glass
    rgb, a = blend_layer(rgb, a, hex_rgb("#002854")[None, None, :], m_ap_core)
    rgb, a = blend_layer(rgb, a, hex_rgb("#7CE8FF")[None, None, :], m_ap_rim * 0.7)

    # Crisp optical lens specular reflection dots (top-left white glint + bottom-right warm amber glint)
    m_glint1 = aa_mask(sd_circle(x, y, 63.2, 63.2, 3.4), aa) * m_glass
    m_glint2 = aa_mask(sd_circle(x, y, 74.0, 74.0, 1.8), aa) * m_glass
    rgb, a = blend_layer(rgb, a, hex_rgb("#FFFFFF")[None, None, :], m_glint1 * 0.92)
    rgb, a = blend_layer(rgb, a, hex_rgb("#FFB900")[None, None, :], m_glint2 * 0.85)

    return to_pil(rgb, a)


def render_concept_f_mobile(px_size=512, shape="square"):
    """Mobile Rounded-Rectangle Edition of Concept F (Terracotta Journal + Ivory Page + Sapphire Lens)."""
    x, y, aa = make_grid(px_size)
    rgb = np.zeros((px_size, px_size, 3), dtype=np.float32)
    a = np.zeros((px_size, px_size), dtype=np.float32)

    if shape == "round":
        sd_bg = sd_circle(x, y, 50.0, 50.0, 46.0)
    else:
        sd_bg = sd_round_rect(x, y, 50.0, 50.0, 46.0, 46.0, 18.5)
    mask_bg = aa_mask(sd_bg, aa)

    # Terracotta leather cover backdrop + dark left spine (x < 19)
    cover_rgb = linear_grad(x, y, 4, 4, 96, 96, "#E87A24", "#9E4208", c_mid="#C65911", mid_pos=0.55)
    m_spine = aa_mask(x - 19.0, aa) * mask_bg
    spine_rgb = linear_grad(x, y, 4, 4, 19, 96, "#9E3E06", "#682402")
    cover_rgb = cover_rgb * (1.0 - m_spine[..., None]) + spine_rgb * m_spine[..., None]
    rgb, a = blend_layer(rgb, a, cover_rgb, mask_bg)

    # Ivory Journal Page inset (x=21..82, y=14..84, rx=9.0)
    sd_page = sd_round_rect(x, y, 51.5, 49.0, 30.5, 35.0, 9.0)
    m_page = aa_mask(sd_page, aa) * mask_bg
    rgb, a = add_drop_shadow(rgb, a, m_page, px_size, offset_x=1.0, offset_y=1.8, blur_radius=2.5, opacity=0.25)
    rgb, a = blend_layer(rgb, a, linear_grad(x, y, 21, 14, 82, 84, "#FAF9F5", "#DFE4EC"), m_page)

    # Scenic header inside page (x=26.5..76.5, y=20..47)
    sd_header = sd_round_rect(x, y, 51.5, 33.5, 25.0, 13.5, 5.0)
    m_header = aa_mask(sd_header, aa) * m_page
    scenic_rgb = paint_scenic_landscape(x, y, aa, 26.5, 20.0, 76.5, 47.0, sun_xy=(64.0, 27.5), sun_r=4.4)
    rgb, a = blend_layer(rgb, a, scenic_rgb, m_header)

    # Journal lines on left side of page
    sd_l1 = sd_round_rect(x, y, 44.0, 54.5, 16.5, 2.1, 2.1)
    sd_l2 = sd_round_rect(x, y, 40.0, 62.5, 12.5, 2.1, 2.1)
    sd_l3 = sd_round_rect(x, y, 37.5, 70.5, 10.0, 2.1, 2.1)
    m_lines = aa_mask(np.minimum(sd_l1, np.minimum(sd_l2, sd_l3)), aa) * m_page
    rgb, a = blend_layer(rgb, a, hex_rgb("#6E8092")[None, None, :], m_lines)

    # Sapphire Camera Lens Badge at bottom-right (cx=69.5, cy=69.5, r=21.0)
    sd_lens = sd_circle(x, y, 69.5, 69.5, 21.0)
    m_lens = aa_mask(sd_lens, aa) * mask_bg
    rgb, a = add_drop_shadow(rgb, a, m_lens, px_size, offset_x=-1.8, offset_y=2.0, blur_radius=3.5, opacity=0.38, color=(8, 18, 32))

    bezel_rgb = linear_grad(x, y, 48, 48, 90, 90, "#F2F5F8", "#7E8B99", c_mid="#B8C2CC", mid_pos=0.5)
    rgb, a = blend_layer(rgb, a, bezel_rgb, m_lens)

    m_ring = aa_mask(sd_circle(x, y, 69.5, 69.5, 17.0), aa) * mask_bg
    rgb, a = blend_layer(rgb, a, linear_grad(x, y, 52, 52, 86, 86, "#2B3540", "#121820"), m_ring)

    m_glass = aa_mask(sd_circle(x, y, 69.5, 69.5, 13.8), aa) * mask_bg
    rgb, a = blend_layer(rgb, a, linear_grad(x, y, 55, 55, 84, 84, "#3CD2FA", "#003B75", c_mid="#0078D4", mid_pos=0.48), m_glass)

    m_ap_rim = aa_mask(sd_ring(x, y, 69.5, 69.5, 7.0, 1.3), aa) * m_glass
    m_ap_core = aa_mask(sd_circle(x, y, 69.5, 69.5, 6.4), aa) * m_glass
    rgb, a = blend_layer(rgb, a, hex_rgb("#002854")[None, None, :], m_ap_core)
    rgb, a = blend_layer(rgb, a, hex_rgb("#7CE8FF")[None, None, :], m_ap_rim * 0.7)

    m_glint1 = aa_mask(sd_circle(x, y, 64.0, 64.0, 3.2), aa) * m_glass
    m_glint2 = aa_mask(sd_circle(x, y, 74.2, 74.2, 1.7), aa) * m_glass
    rgb, a = blend_layer(rgb, a, hex_rgb("#FFFFFF")[None, None, :], m_glint1 * 0.92)
    rgb, a = blend_layer(rgb, a, hex_rgb("#FFB900")[None, None, :], m_glint2 * 0.85)

    return to_pil(rgb, a)


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


def build_win11_lineup_v2(win_icons, mob_icons):
    ref = Image.open(REF_IMG_PATH).convert("RGBA")
    rw, rh = ref.size  # 969 x 205

    col_w = 194
    total_w = rw + col_w
    total_h = rh * 2 + 28
    board = Image.new("RGBA", (total_w, total_h), (33, 45, 49, 255))
    draw = ImageDraw.Draw(board)

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

    # Slot 6 on Row 1: Concept D (Polaroid Prints & Map Pin) alongside Paint..Snipping Tool
    slot6_cx = rw + col_w // 2 - 12
    icon_d_64 = win_icons["D"].resize((68, 68), Image.Resampling.LANCZOS)
    board.alpha_composite(icon_d_64, (slot6_cx - 34, 53))

    draw.rounded_rectangle([slot6_cx - 82, 18, slot6_cx + 82, 184], radius=12, outline=(255, 125, 70, 140), width=1)
    draw.text((slot6_cx, 146), "Photo Archive", fill=(242, 245, 247, 255), font=font_segoe_label, anchor="mm")
    draw.text((slot6_cx, 33), "NEW · 全新设计入列预览", fill=(255, 165, 110, 255), font=font_cjk_badge, anchor="mm")

    draw.line([(36, rh + 8), (total_w - 36, rh + 8)], fill=(54, 70, 76, 255), width=1)

    # Row 2: Compare all 6 icons (D, E, F Windows Fluent versions + D, E, F Mobile Squircle versions)
    row2_items = [
        ("方案 D · 拍立得与图钉", "Windows Fluent 版", win_icons["D"].resize((68, 68), Image.Resampling.LANCZOS), (255, 160, 115, 255)),
        ("方案 E · 时光档案盒", "Windows Fluent 版", win_icons["E"].resize((68, 68), Image.Resampling.LANCZOS), (255, 208, 100, 255)),
        ("方案 F · 游记手账与镜头", "Windows Fluent 版", win_icons["F"].resize((68, 68), Image.Resampling.LANCZOS), (110, 215, 255, 255)),
        ("方案 D · 拍立得与图钉", "移动端圆角矩形版", mob_icons["D"].resize((64, 64), Image.Resampling.LANCZOS), (140, 230, 180, 255)),
        ("方案 E · 时光档案盒", "移动端圆角矩形版", mob_icons["E"].resize((64, 64), Image.Resampling.LANCZOS), (140, 230, 180, 255)),
        ("方案 F · 游记手账与镜头", "移动端圆角矩形版", mob_icons["F"].resize((64, 64), Image.Resampling.LANCZOS), (140, 230, 180, 255)),
    ]

    slot_span = total_w // len(row2_items)
    y_base = rh + 20
    for idx, (title, subtitle, ic, badge_col) in enumerate(row2_items):
        cx = slot_span * idx + slot_span // 2
        iw, ih = ic.size
        board.alpha_composite(ic, (cx - iw // 2, y_base + 50 - (ih - 64) // 2))
        draw.text((cx, y_base + 138), title, fill=(240, 244, 246, 255), font=font_cjk_title, anchor="mm")
        draw.text((cx, y_base + 164), subtitle, fill=badge_col, font=font_cjk_sub, anchor="mm")

    out_path = os.path.join(OUT_DIR, "win11-lineup-v2.png")
    board.convert("RGB").save(out_path, quality=95)
    return out_path


def build_showcase_v2(win_icons, mob_icons):
    W, H = 1680, 1140
    sheet = Image.new("RGBA", (W, H), (22, 29, 33, 255))
    draw = ImageDraw.Draw(sheet)

    f_h1 = load_cjk_font(25, bold=True)
    f_h2 = load_cjk_font(18, bold=True)
    f_body = load_cjk_font(13, bold=False)
    f_small = load_cjk_font(12, bold=True)
    f_segoe_tb = load_segoe_font(13, bold=True)

    draw.text((48, 34), "Photo Archive — 全新三版 Logo 设计（跳出原蓝底虚线框架 · 多彩 Fluent 实物隐喻）", fill=(245, 248, 250, 255), font=f_h1)
    draw.text(
        (48, 70),
        "分别从【影像冲印与足迹图钉 (D)】、【十年按月归档卡片盒 (E)】、【硬壳游记手账与蓝宝石镜头 (F)】三个全新维度诠释产品，均含 Windows Fluent 版与移动端圆角矩形版",
        fill=(165, 182, 194, 255),
        font=f_body,
    )

    cards = [
        (
            "D",
            "方案 D：「拍立得相片叠与旅行图钉」",
            "错位双层相纸（底层暖金记忆 + 前景山海风光与手记摘要行）",
            "右上角立体珊瑚红定位图钉破界叠压，色彩明快、极具旅行影像辨识度",
            (245, 115, 65, 255),
        ),
        (
            "E",
            "方案 E：「时光档案盒与月份索引卡」",
            "岩石灰金属档案匣（呼应 Win11 Calculator/Clock 质感与金属铭牌）",
            "盒内阶梯露出琥珀金、珊瑚红月份索引耳标与蓝天远山照片卡，直扣 Archive",
            (245, 185, 65, 255),
        ),
        (
            "F",
            "方案 F：「游记手账本与蓝宝石镜头」",
            "暖赤陶皮革硬壳手账本 + 象牙白图文书页 + 绯红书签丝带",
            "右下角破界叠合银边蓝宝石光学镜头徽章，冷暖碰撞、诠释「影像成书」",
            (80, 185, 245, 255),
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
        draw.rounded_rectangle([x0, y0, x0 + card_w, y0 + card_h], radius=16, fill=(31, 42, 48, 255), outline=border_col, width=2)

        draw.text((x0 + 24, y0 + 20), title, fill=(245, 248, 250, 255), font=f_h2)
        draw.text((x0 + 24, y0 + 50), desc1, fill=(165, 180, 190, 255), font=f_body)
        draw.text((x0 + 24, y0 + 70), desc2, fill=(165, 180, 190, 255), font=f_body)

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
        im_16 = win_icons[key].resize((18, 18), Image.Resampling.LANCZOS)
        sheet.alpha_composite(im_16, (tb_x + 12, tb_y + 11))
        draw.text((tb_x + 38, tb_y + 20), "Photo Archive", fill=(70, 74, 80, 255), font=f_segoe_tb, anchor="lm")

    # Bottom section: Embedded Windows 11 Native Lineup Strip
    lineup_im = Image.open(os.path.join(OUT_DIR, "win11-lineup-v2.png")).convert("RGBA")
    lw, lh = lineup_im.size
    target_w = W - 96
    row1_crop = lineup_im.crop((0, 0, lw, 205))
    r1_h = int(round(205 * (target_w / lw)))
    row1_scaled = row1_crop.resize((target_w, r1_h), Image.Resampling.LANCZOS)
    sheet.alpha_composite(row1_scaled, (48, 816))

    out_path = os.path.join(OUT_DIR, "logo-design-showcase-v2.png")
    sheet.convert("RGB").save(out_path, quality=95)
    return out_path


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    win_icons = {
        "D": render_concept_d_windows(512),
        "E": render_concept_e_windows(512),
        "F": render_concept_f_windows(512),
    }
    mob_icons = {
        "D": render_concept_d_mobile(512, "square"),
        "D_round": render_concept_d_mobile(512, "round"),
        "E": render_concept_e_mobile(512, "square"),
        "E_round": render_concept_e_mobile(512, "round"),
        "F": render_concept_f_mobile(512, "square"),
        "F_round": render_concept_f_mobile(512, "round"),
    }

    for k in ["D", "E", "F"]:
        win_icons[k].save(os.path.join(OUT_DIR, f"logo-fluent-windows-{k}.png"))
        mob_icons[k].save(os.path.join(OUT_DIR, f"logo-mobile-rounded-{k}.png"))

    p1 = build_win11_lineup_v2(win_icons, mob_icons)
    p2 = build_showcase_v2(win_icons, mob_icons)
    print("Generated:", p1)
    print("Generated:", p2)


if __name__ == "__main__":
    main()
