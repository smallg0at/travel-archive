"""Bring the cliff master's frame back to Argon's numbers, exactly.

The landscape stays as it is. Only the frame is restored, so that a later change
to the picture happens inside his card rather than inside a lookalike:

  card          #FFFFFF -> #E3E9F0, corner 8, shadow (-1.5,2.5) blur 4 @ 0.35
  paper edge    y 88..91  #C4CED9 -> #9FB0C2
  back card     #E4EAF0 -> #C5D0DC, with the amber photo behind (#FFB900 -> #E05319)
  caption       25.5,73.8 33x4 r2 and 25.5,79.8 22x4 r2, #6C8094 -> #506478
  amber tag     64.8,75.5 10.4x6 r3, #FFAA00 -> #E06A00
  pin           cone: head r12.5 at (76.5,22.5), tip y 45, tip r 2, rotate 12,
                #FF6E38 -> #E8430A (52%) -> #C82800, no rim light
  hole          r5 white at (76.5,22.5)
"""

import io
import re

HERE = r"C:/Code/proj/docs/logo-drafts"
src = io.open(f"{HERE}/gemini-cliff.svg", encoding="utf-8").read()
s = src

# --- gradients the frame needs, in Argon's own userSpaceOnUse coordinates ----
frame_defs = '''
    <linearGradient id="aCard" x1="18" y1="15" x2="82" y2="91" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#E3E9F0"/>
    </linearGradient>
    <linearGradient id="aBackCard" x1="12" y1="12" x2="70" y2="80" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#E4EAF0"/><stop offset="1" stop-color="#C5D0DC"/>
    </linearGradient>
    <linearGradient id="aBackPhoto" x1="16" y1="16" x2="65" y2="65" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFB900"/><stop offset="1" stop-color="#E05319"/>
    </linearGradient>
    <linearGradient id="aPaper" x1="18" y1="88" x2="82" y2="91" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#C4CED9"/><stop offset="1" stop-color="#9FB0C2"/>
    </linearGradient>
    <linearGradient id="aCaption" x1="24" y1="74" x2="60" y2="84" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#6C8094"/><stop offset="1" stop-color="#506478"/>
    </linearGradient>
    <linearGradient id="aTag" x1="65" y1="75" x2="75" y2="82" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFAA00"/><stop offset="1" stop-color="#E06A00"/>
    </linearGradient>
    <linearGradient id="aPin" x1="64" y1="10" x2="89" y2="45" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FF6E38"/><stop offset="0.52" stop-color="#E8430A"/><stop offset="1" stop-color="#C82800"/>
    </linearGradient>
    <clipPath id="aCardClip"><rect x="18" y="15" width="64" height="76" rx="8"/></clipPath>
'''
s = s.replace("  </defs>", frame_defs + "  </defs>", 1)

# --- shadows: Argon's offsets and strengths ---------------------------------
s = s.replace(
    'dx="-1.2" dy="2.4" stdDeviation="2.6" flood-color="#04101F" flood-opacity="0.34"',
    'dx="-1.5" dy="2.5" stdDeviation="4" flood-color="#061426" flood-opacity="0.35"',
)
s = s.replace(
    'dx="-1.8" dy="2.4" stdDeviation="3" flood-color="#0B1220" flood-opacity="0.4"',
    'dx="-1.8" dy="2.4" stdDeviation="3.5" flood-color="#0F141E" flood-opacity="0.38"',
)

# --- main card group --------------------------------------------------------
old_cards = re.search(
    r'  <!-- Back card -->.*?  </g>\n\n  <!-- Photo window -->', s, re.S
)
if not old_cards:
    raise SystemExit("card block not found")
new_cards = '''  <!-- Back card, as in Argon's original: the amber photo shows at its edges -->
  <g transform="rotate(-8.5 42 46)" filter="url(#backShadow)">
    <rect x="13" y="12" width="58" height="68" rx="7" fill="url(#aBackCard)"/>
    <rect x="17.7" y="18.5" width="47" height="46" rx="4.5" fill="url(#aBackPhoto)"/>
  </g>

  <!-- Front card -->
  <rect x="18" y="15" width="64" height="76" rx="8" fill="url(#aCard)" filter="url(#contact)"/>
  <g clip-path="url(#aCardClip)"><rect x="18" y="88" width="64" height="3" fill="url(#aPaper)"/></g>
  <path d="M18 88 h64 v-3 a8 8 0 0 1 -8 8 h-48 a8 8 0 0 1 -8 -8 z" fill="url(#aPaper)"/>

  <!-- Photo window -->'''
s = s[: old_cards.start()] + new_cards + s[old_cards.end():]

# --- caption, tag, pin ------------------------------------------------------
old_foot = s[s.index("  <!-- Caption strip"): s.index("</svg>")]
new_foot = '''  <!-- Caption strip & amber tag, Argon's sizes -->
  <rect x="25.5" y="73.8" width="33" height="4" rx="2" fill="url(#aCaption)"/>
  <rect x="25.5" y="79.8" width="22" height="4" rx="2" fill="url(#aCaption)"/>
  <rect x="64.8" y="75.5" width="10.4" height="6" rx="3" fill="url(#aTag)"/>

  <!-- Pin: Argon's tapered cone, head r12.5, tip r2 at y=43, rotated 12 -->
  <g filter="url(#pinShadow)" transform="rotate(12 76.5 22.5)">
    <path d="M64 22.5 A12.5 12.5 0 1 1 89 22.5 L78.5 43 A2 2 0 0 1 74.5 43 Z" fill="url(#aPin)"/>
  </g>
  <circle cx="76.5" cy="22.5" r="5" fill="#FFFFFF"/>
'''
s = s.replace(old_foot, new_foot)

io.open(f"{HERE}/argon-frame-cliff.svg", "w", encoding="utf-8").write(s)
print("written argon-frame-cliff.svg")
