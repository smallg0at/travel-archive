"""
Build the Concept D master with the photograph itself inside the Polaroid.

Hand-drawing the ridge from measured coordinates kept turning into a grey
swoosh: the Nordkette's identity is its jagged silhouette, and six hand-placed
polygons cannot hold it. So the window carries a posterised crop — the real
silhouette, reduced to a handful of flat colours so it belongs to an icon — and
everything around it (card, depth, pin) stays vector.

Output: logo-d-nordkette.svg (rebuildable any time from the frame).
"""

import base64
import io
import os

from PIL import Image, ImageEnhance

HERE = r"C:/Code/proj/docs/logo-drafts"
SRC = r"C:/Users/small/Downloads/11-14-26-195515.png"
BOX = (0, 330, 760, 1030)

# 52x48 is the window; render it at 8x so the master holds up at 512.
TILE = (52 * 8, 48 * 8)

im = Image.open(SRC).convert("RGB").crop(BOX)
im = im.resize(TILE, Image.LANCZOS)
# Posterise: fewer colours keep it reading as an icon rather than a photo, and
# the flat areas survive being shrunk to 32px far better than gradients do.
im = im.quantize(colors=14, method=Image.MEDIANCUT).convert("RGB")
# Lift saturation and contrast a touch: the frame is shot into the sun, and at
# 64px its washed sky turns grey.
im = ImageEnhance.Color(im).enhance(1.32)
im = ImageEnhance.Contrast(im).enhance(1.05)
im = ImageEnhance.Brightness(im).enhance(1.05)

buf = io.BytesIO()
im.save(buf, format="PNG", optimize=True)
b64 = base64.b64encode(buf.getvalue()).decode("ascii")
im.save(os.path.join(HERE, "nordkette-window.png"))
print("window raster:", im.size, len(b64) // 1024, "KB base64")

svg = f'''<?xml version="1.0" encoding="UTF-8"?>
<!--
  Concept D, master.

  The window carries the Nordkette frame itself — crop x 0..760, y 330..1030,
  posterised to 14 colours at 8x and slightly lifted in saturation. Hand-drawn
  geometry was tried first and could not hold the ridge's jagged silhouette,
  which is the one thing that makes this range recognisable. Around it,
  everything is vector: the Polaroid, its two shadows, the top-edge highlight,
  the inner shadow at the photograph's edge, the caption margin, and the pin
  with its rim light and contact shadow.

  The window is mirrored relative to the frame: there the ridge enters from the
  right, exactly where the pin sits.
-->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="512" height="512" role="img" aria-label="Photo Archive">
  <defs>
    <linearGradient id="card" x1="0.15" y1="0" x2="0.7" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="0.62" stop-color="#F7FAFC"/>
      <stop offset="1" stop-color="#E4EBF2"/>
    </linearGradient>
    <linearGradient id="pin" x1="0.15" y1="0" x2="0.55" y2="1">
      <stop offset="0" stop-color="#FF8B57"/>
      <stop offset="0.35" stop-color="#F0521A"/>
      <stop offset="0.75" stop-color="#D03104"/>
      <stop offset="1" stop-color="#A81F00"/>
    </linearGradient>
    <linearGradient id="innerShade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0B2743" stop-opacity="0.22"/>
      <stop offset="0.14" stop-color="#0B2743" stop-opacity="0"/>
      <stop offset="0.88" stop-color="#0B2743" stop-opacity="0"/>
      <stop offset="1" stop-color="#0B2743" stop-opacity="0.16"/>
    </linearGradient>
    <linearGradient id="topLight" x1="0" y1="0" x2="0.2" y2="1">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.9"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="view">
      <rect x="24" y="21" width="52" height="48" rx="5"/>
    </clipPath>
    <clipPath id="cardClip">
      <rect x="18" y="15" width="64" height="76" rx="9"/>
    </clipPath>
    <filter id="ambient" x="-40%" y="-30%" width="180%" height="180%">
      <feDropShadow dx="0" dy="3.6" stdDeviation="4.6" flood-color="#061426" flood-opacity="0.26"/>
    </filter>
    <filter id="contact" x="-30%" y="-25%" width="160%" height="160%">
      <feDropShadow dx="-0.6" dy="1.3" stdDeviation="1.2" flood-color="#04101F" flood-opacity="0.34"/>
    </filter>
    <filter id="pinShadow" x="-70%" y="-50%" width="240%" height="230%">
      <feDropShadow dx="-2" dy="3.2" stdDeviation="2.8" flood-color="#0B1220" flood-opacity="0.42"/>
    </filter>
  </defs>

  <rect x="18" y="15" width="64" height="76" rx="9" fill="#000" opacity="0.01" filter="url(#ambient)"/>
  <rect x="18" y="15" width="64" height="76" rx="9" fill="url(#card)" filter="url(#contact)"/>

  <g clip-path="url(#cardClip)">
    <rect x="18" y="15" width="64" height="4" fill="url(#topLight)" opacity="0.75"/>
    <path d="M18 85.5 h64 v-2.5 a9 9 0 0 1 -9 9 h-46 a9 9 0 0 1 -9 -9 z" fill="#BFCAD6" opacity="0.55"/>
  </g>

  <g clip-path="url(#view)">
    <image x="0" y="21" width="52" height="48" transform="translate(76 0) scale(-1 1)"
           href="data:image/png;base64,{b64}" preserveAspectRatio="none"/>
    <rect x="24" y="21" width="52" height="48" fill="url(#innerShade)"/>
  </g>

  <rect x="26" y="75.6" width="32" height="3.2" rx="1.6" fill="#63788C" opacity="0.9"/>
  <rect x="26" y="81.2" width="20" height="2.8" rx="1.4" fill="#63788C" opacity="0.5"/>
  <rect x="64.2" y="75.4" width="9.4" height="5.8" rx="2.2" fill="#F0A11E"/>
  <rect x="64.2" y="75.4" width="9.4" height="2.4" rx="1.2" fill="#FFC049" opacity="0.75"/>

  <ellipse cx="77.6" cy="41.5" rx="6.2" ry="1.5" fill="#122033" opacity="0.2"/>
  <g filter="url(#pinShadow)" transform="rotate(12 77 21)">
    <path d="M77 9.6 a11.2 11.2 0 0 1 11.2 11.2 c0 7.6 -8.3 14 -11.2 20.1 c-2.9 -6.1 -11.2 -12.5 -11.2 -20.1 A11.2 11.2 0 0 1 77 9.6 Z" fill="url(#pin)"/>
  </g>
  <path d="M77 11.4 a9.4 9.4 0 0 0 -9.1 7.2 c1.6 -3.4 5 -5.7 9.1 -5.7 c1.5 0 2.9 0.3 4.1 0.9 a9.4 9.4 0 0 0 -4.1 -2.4 Z" fill="#FFD9C7" opacity="0.5" transform="rotate(12 77 21)"/>
  <circle cx="77" cy="20.8" r="4.1" fill="#FFFFFF"/>
  <circle cx="77" cy="20.4" r="3.4" fill="#F4F7FA"/>
</svg>
'''

with io.open(os.path.join(HERE, "logo-d-nordkette.svg"), "w", encoding="utf-8") as fh:
    fh.write(svg)
print("svg written", len(svg) // 1024, "KB")
