"""Argon's frame, landscape reduced to one hill plus a lighthouse on the left.

His own window was a cyan sky, a golden sun, an emerald hill and a teal hill. For
the desktop/Fluent icon the brief is: drop the light hill and the sun, keep the
teal ridge, and put a lighthouse on the left where the sun used to balance the
composition. The pin's taper is smoothed too — a straight-sided cone reads as a
triangle glued to a circle once it is large.
"""

import math

W = 2
VX0, VX1, VY0, VH = 24.0, 76.0, 21.0, 48.0


def hill_path(base, depth, peak, width):
    pts = []
    x = VX0
    while x <= VX1 + 1e-9:
        nx = (x - VX0) / (VX1 - VX0)
        y = VY0 + VH * base - VH * depth * math.exp(-(((nx - peak) / width) ** 2))
        pts.append((round(x, 2), round(y, 2)))
        x += W
    d = f"M{pts[0][0]} {pts[0][1]} " + " ".join(f"L{p[0]} {p[1]}" for p in pts[1:])
    return d + f" L{VX1} 69 L{VX0} 69 Z"


HILL_TEAL = hill_path(0.77, 0.22, 0.74, 0.38)

# Pin: tangents from the tip touch the head at 56.25deg, so the sides leave the
# circle there and bow into the tip instead of running straight to it.
CX, CY, R, TIP_Y = 76.5, 22.5, 12.5, 45.0
ALPHA = math.degrees(math.acos(R / (TIP_Y - CY)))  # 56.25
TX = R * math.sin(math.radians(ALPHA))
TY = R * math.cos(math.radians(ALPHA))
LEFT_T = (CX - TX, CY + TY)
RIGHT_T = (CX + TX, CY + TY)

PIN = (
    f"M{LEFT_T[0]:.2f} {LEFT_T[1]:.2f} "
    f"A{R} {R} 0 1 1 {RIGHT_T[0]:.2f} {RIGHT_T[1]:.2f} "
    f"C{RIGHT_T[0] - 1.2:.2f} 34.2, {CX + 2.6:.2f} 38.6, {CX + 2.0:.2f} 43 "
    f"A2 2 0 0 1 {CX - 2.0:.2f} 43 "
    f"C{CX - 2.6:.2f} 38.6, {LEFT_T[0] + 1.2:.2f} 34.2, {LEFT_T[0]:.2f} {LEFT_T[1]:.2f} Z"
)

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
    <linearGradient id="hill" x1="24" y1="47.4" x2="76" y2="69" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0E8AB8"/><stop offset="1" stop-color="#05476E"/>
    </linearGradient>
    <linearGradient id="tower" x1="29" y1="40" x2="37" y2="58" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF"/><stop offset="0.55" stop-color="#F1F6FA"/><stop offset="1" stop-color="#C3D0DC"/>
    </linearGradient>
    <linearGradient id="towerSide" x1="35" y1="40" x2="38" y2="58" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#D6E2EC"/><stop offset="1" stop-color="#A9B9C8"/>
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
    <clipPath id="aCardClip"><rect x="18" y="15" width="64" height="76" rx="8"/></clipPath>
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
  <g clip-path="url(#aCardClip)"><rect x="18" y="88" width="64" height="3" fill="url(#paper)"/></g>

  <g clip-path="url(#view)">
    <rect x="24" y="21" width="52" height="48" fill="url(#sky)"/>
    <path d="{HILL_TEAL}" fill="url(#hill)"/>

    <!-- Lighthouse on the left, where the sun used to sit: slender, white, dark cap -->
    <g>
      <ellipse cx="33" cy="58.2" rx="4.6" ry="1.2" fill="#043F63" opacity="0.45"/>
      <path d="M31.4 58 L30.9 42.6 L35.1 42.6 L34.6 58 Z" fill="url(#tower)"/>
      <path d="M33.4 42.6 L35.1 42.6 L34.6 58 L33.2 58 Z" fill="url(#towerSide)" opacity="0.85"/>
      <rect x="30.4" y="40.8" width="5.2" height="1.9" rx="0.6" fill="#1F2A36"/>
      <path d="M30.9 40.8 L33 38.9 L35.1 40.8 Z" fill="#2B3947"/>
      <rect x="31.6" y="44.6" width="2.8" height="1.2" rx="0.4" fill="#1F2A36" opacity="0.75"/>
      <rect x="31.2" y="52.6" width="3.6" height="1.4" rx="0.5" fill="#EAF1F6"/>
      <rect x="31.4" y="56.4" width="3.2" height="1.4" rx="0.5" fill="#D9E3EC"/>
    </g>
  </g>

  <rect x="25.5" y="73.8" width="33" height="4" rx="2" fill="url(#caption)"/>
  <rect x="25.5" y="79.8" width="22" height="4" rx="2" fill="url(#caption)"/>
  <rect x="64.8" y="75.5" width="10.4" height="6" rx="3" fill="url(#tag)"/>

  <g filter="url(#pinShadow)" transform="rotate(12 {CX} {CY})">
    <path d="{PIN}" fill="url(#pin)"/>
  </g>
  <circle cx="{CX}" cy="{CY}" r="5" fill="#FFFFFF"/>
</svg>
'''

with open(r"C:/Code/proj/docs/logo-drafts/argon-frame-light.svg", "w", encoding="utf-8") as fh:
    fh.write(DOC)
print("written argon-frame-light.svg; pin tangents", round(LEFT_T[0], 2), round(LEFT_T[1], 2))
