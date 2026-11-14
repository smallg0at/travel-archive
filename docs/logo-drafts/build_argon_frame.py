"""Faithful SVG rebuild of Argon's Concept D (Windows variant).

Every number here is taken from render_logos_v2.py's render_concept_d_windows
and paint_scenic_landscape, in the same 0..100 space:

  back card     centre (42,46)  half 29x34  r7  rotate -8.5
                fill #E4EAF0 -> #C5D0DC, shadow dy 2.2 blur 3.2 @ 0.24
  back photo    centre (41.2,41.5) half 23.5x23 r4.5, #FFB900 -> #E05319
  front card    x 18..82 y 15..91 r8, #FFFFFF -> #E3E9F0, shadow (-1.5,2.5)
                blur 4 @ 0.35; paper edge y 88..91 #C4CED9 -> #9FB0C2
  window        x 24..76 y 21..69 r5
  sky           vertical #5CE4FF -> #28B8F7 (55%) -> #108EE2
  sun           (36,33) r 6.2, #FFE46B -> #FF9900
  hill 1        y=21+48*0.64-48*0.24*exp(-((nx-0.34)/0.36)^2), #2AD6A8 -> #0B806C
  hill 2        y=21+48*0.77-48*0.22*exp(-((nx-0.74)/0.38)^2), #0E8AB8 -> #05476E
  caption       42,75.8 hw16.5 hh2 r2 and 36.5,81.8 hw11 hh2 r2, #6C8094 -> #506478
  amber tag     70,78.5 hw5.2 hh3 r2.5, #FFAA00 -> #E06A00
  pin           cone: head r12.5 at (76.5,22.5), tip y=45, tip r 2.0, rotate 12
                #FF6E38 -> #C82800 (mid #E8430A at 52%), shadow (-1.8,2.4)
  hole          white circle r5 at (76.5,22.5)
"""

import math

W = 2  # curve sampling step, in the 100-unit space


def hill_path(base, depth, peak, width, vy0, vh, vx0, vx1):
    """Sample Argon's gaussian ridge into a polyline, then close it at the base."""
    pts = []
    x = vx0
    while x <= vx1 + 1e-9:
        nx = (x - vx0) / (vx1 - vx0)
        y = vy0 + vh * base - vh * depth * math.exp(-(((nx - peak) / width) ** 2))
        pts.append((round(x, 2), round(y, 2)))
        x += W
    d = f"M{pts[0][0]} {pts[0][1]} " + " ".join(f"L{p[0]} {p[1]}" for p in pts[1:])
    return d + f" L{vx1} 69 L{vx0} 69 Z"


VX0, VX1, VY0, VH = 24.0, 76.0, 21.0, 48.0
HILL1 = hill_path(0.64, 0.24, 0.34, 0.36, VY0, VH, VX0, VX1)
HILL2 = hill_path(0.77, 0.22, 0.74, 0.38, VY0, VH, VX0, VX1)

DOC = f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="512" height="512" role="img" aria-label="Photo Archive">
  <defs>
    <linearGradient id="card" x1="18" y1="15" x2="82" y2="91" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#E3E9F0"/>
    </linearGradient>
    <linearGradient id="backCard" x1="12" y1="12" x2="70" y2="80" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#E4EAF0"/><stop offset="1" stop-color="#C5D0DC"/>
    </linearGradient>
    <linearGradient id="backPhoto" x1="16" y1="16" x2="65" y2="65" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFB900"/><stop offset="1" stop-color="#E05319"/>
    </linearGradient>
    <linearGradient id="paper" x1="18" y1="88" x2="82" y2="91" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#C4CED9"/><stop offset="1" stop-color="#9FB0C2"/>
    </linearGradient>
    <linearGradient id="sky" x1="24" y1="21" x2="24" y2="69" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#5CE4FF"/><stop offset="0.55" stop-color="#28B8F7"/><stop offset="1" stop-color="#108EE2"/>
    </linearGradient>
    <linearGradient id="sun" x1="29.8" y1="26.8" x2="42.2" y2="39.2" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFE46B"/><stop offset="1" stop-color="#FF9900"/>
    </linearGradient>
    <linearGradient id="hill1" x1="24" y1="40.2" x2="76" y2="69" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2AD6A8"/><stop offset="1" stop-color="#0B806C"/>
    </linearGradient>
    <linearGradient id="hill2" x1="24" y1="47.4" x2="76" y2="69" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0E8AB8"/><stop offset="1" stop-color="#05476E"/>
    </linearGradient>
    <linearGradient id="caption" x1="24" y1="74" x2="60" y2="84" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#6C8094"/><stop offset="1" stop-color="#506478"/>
    </linearGradient>
    <linearGradient id="tag" x1="65" y1="75" x2="75" y2="82" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFAA00"/><stop offset="1" stop-color="#E06A00"/>
    </linearGradient>
    <linearGradient id="pin" x1="64" y1="10" x2="89" y2="45" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FF6E38"/><stop offset="0.52" stop-color="#E8430A"/><stop offset="1" stop-color="#C82800"/>
    </linearGradient>
    <clipPath id="view"><rect x="24" y="21" width="52" height="48" rx="5"/></clipPath>
    <filter id="cardShadow" x="-30%" y="-20%" width="170%" height="160%">
      <feDropShadow dx="-1.5" dy="2.5" stdDeviation="4" flood-color="#061426" flood-opacity="0.35"/>
    </filter>
    <filter id="backShadow" x="-30%" y="-20%" width="170%" height="160%">
      <feDropShadow dx="0" dy="2.2" stdDeviation="3.2" flood-color="#081426" flood-opacity="0.24"/>
    </filter>
    <filter id="pinShadow" x="-60%" y="-40%" width="230%" height="200%">
      <feDropShadow dx="-1.8" dy="2.4" stdDeviation="3.5" flood-color="#0F141E" flood-opacity="0.38"/>
    </filter>
  </defs>

  <g transform="rotate(-8.5 42 46)" filter="url(#backShadow)">
    <rect x="13" y="12" width="58" height="68" rx="7" fill="url(#backCard)"/>
    <rect x="17.7" y="18.5" width="47" height="46" rx="4.5" fill="url(#backPhoto)"/>
  </g>

  <rect x="18" y="15" width="64" height="76" rx="8" fill="url(#card)" filter="url(#cardShadow)"/>
  <path d="M18 88 h64 v-3 a8 8 0 0 1 -8 8 h-48 a8 8 0 0 1 -8 -8 z" fill="url(#paper)"/>

  <g clip-path="url(#view)">
    <rect x="24" y="21" width="52" height="48" fill="url(#sky)"/>
    <circle cx="36" cy="33" r="6.2" fill="url(#sun)"/>
    <path d="{HILL1}" fill="url(#hill1)"/>
    <path d="{HILL2}" fill="url(#hill2)"/>
  </g>

  <rect x="25.5" y="73.8" width="33" height="4" rx="2" fill="url(#caption)"/>
  <rect x="25.5" y="79.8" width="22" height="4" rx="2" fill="url(#caption)"/>
  <rect x="64.8" y="75.5" width="10.4" height="6" rx="3" fill="url(#tag)"/>

  <g filter="url(#pinShadow)" transform="rotate(12 76.5 22.5)">
    <path d="M64 22.5 A12.5 12.5 0 1 1 89 22.5
             L78.5 43 A2 2 0 0 1 74.5 43 Z" fill="url(#pin)"/>
  </g>
  <circle cx="76.5" cy="22.5" r="5" fill="#FFFFFF"/>
</svg>
'''

with open(r"C:/Code/proj/docs/logo-drafts/argon-frame.svg", "w", encoding="utf-8") as fh:
    fh.write(DOC)
print("written argon-frame.svg")
