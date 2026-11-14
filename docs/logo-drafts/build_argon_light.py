"""Argon's frame; window carries the Naze Tower, pin ends in a point.

Two changes from argon-frame-light:

  pin     the tapered cone with a rounded tip is replaced by one that closes to
          a point at y=45: arcs leave the head at the tangent points, then bow
          inward and meet at the tip.
  tower   the slender white lighthouse becomes the Naze Tower - an octagonal
          brick tower, thicker and taller, crenellated, no lantern room, no flag.
          Brick #C08055 to #8A5334, with the lit face on the left.
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

CX, CY, R, TIP_Y = 76.5, 22.5, 12.5, 45.0
ALPHA = math.acos(R / (TIP_Y - CY))
TX, TY = R * math.sin(ALPHA), R * math.cos(ALPHA)
LEFT = (CX - TX, CY + TY)
RIGHT = (CX + TX, CY + TY)

# Sides bow in from the tangents and meet at a point.
PIN = (
    f"M{LEFT[0]:.2f} {LEFT[1]:.2f} "
    f"A{R} {R} 0 1 1 {RIGHT[0]:.2f} {RIGHT[1]:.2f} "
    f"C{RIGHT[0] - 2.0:.2f} 35.6, {CX + 2.2:.2f} 40.0, {CX:.2f} {TIP_Y} "
    f"C{CX - 2.2:.2f} 40.0, {LEFT[0] + 2.0:.2f} 35.6, {LEFT[0]:.2f} {LEFT[1]:.2f} Z"
)

# Naze Tower: octagonal, tapering, crenellated. Base y 58.4, top y 37.4.
TOWER = '''
      <ellipse cx="33.2" cy="58.4" rx="6.2" ry="1.3" fill="#043F63" opacity="0.45"/>
      <!-- body: lit left face and shaded right face meet at a soft fold -->
      <path d="M29.4 58.4 L30.6 39.4 L35.8 39.4 L37 58.4 Z" fill="url(#brick)"/>
      <path d="M33.2 39.4 L35.8 39.4 L37 58.4 L33.4 58.4 Z" fill="url(#brickSide)"/>
      <!-- the fold between the two faces -->
      <path d="M33.2 39.4 L33.4 58.4" stroke="#7B4A30" stroke-width="0.35" opacity="0.35"/>
      <!-- crenellations: four merlons on a slightly wider band -->
      <rect x="30.1" y="36.6" width="6.2" height="2.9" rx="0.35" fill="url(#brick)"/>
      <rect x="30.1" y="36.6" width="3.1" height="2.9" fill="url(#brickSide)" opacity="0.55"/>
      <g fill="#C98A5E">
        <rect x="30.2" y="35.6" width="1.3" height="1.5"/>
        <rect x="31.9" y="35.6" width="1.3" height="1.5"/>
        <rect x="33.6" y="35.6" width="1.3" height="1.5"/>
        <rect x="35.3" y="35.6" width="1.1" height="1.5"/>
      </g>
      <g fill="#7B4A30" opacity="0.75">
        <rect x="31.5" y="36" width="1.2" height="1.2"/>
        <rect x="33.2" y="36" width="1.2" height="1.2"/>
        <rect x="34.9" y="36" width="1.2" height="1.2"/>
      </g>
      <!-- doorway and two slit windows -->
      <path d="M32.1 58.4 L32.1 55.1 A1.1 1.1 0 0 1 34.3 55.1 L34.3 58.4 Z" fill="#5B3620" opacity="0.8"/>
      <rect x="32.5" y="47.6" width="1.4" height="2.2" rx="0.5" fill="#5B3620" opacity="0.7"/>
      <rect x="32.5" y="42.4" width="1.4" height="1.9" rx="0.5" fill="#5B3620" opacity="0.6"/>
'''

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
    <linearGradient id="brick" x1="29.4" y1="37" x2="35.4" y2="58" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#C98A5E"/><stop offset="0.55" stop-color="#B2704A"/><stop offset="1" stop-color="#8A5334"/>
    </linearGradient>
    <linearGradient id="brickSide" x1="33.4" y1="37" x2="37" y2="58" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#A8683F"/><stop offset="1" stop-color="#6E4028"/>
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
{TOWER}
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
print("written: pointed pin, Naze Tower")
