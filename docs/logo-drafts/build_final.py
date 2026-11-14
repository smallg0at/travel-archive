"""Argon's layered D silhouette, with Gemini's window inside it."""

import io

SRC = r"C:/Code/proj/docs/logo-drafts/gemini-icon.svg"
OUT = r"C:/Code/proj/docs/logo-drafts/logo-d-final.svg"

s = io.open(SRC, encoding="utf-8").read()

# Defs the back card needs (Argon's version had a tilted card behind the front
# one; the masters I built since had dropped it, which flattened the mark).
extra_defs = '''    <linearGradient id="backCard" x1="0.2" y1="0" x2="0.7" y2="1">
      <stop offset="0" stop-color="#E9EEF4"/>
      <stop offset="1" stop-color="#C6D1DC"/>
    </linearGradient>
    <linearGradient id="backPhoto" x1="0.2" y1="0" x2="0.7" y2="1">
      <stop offset="0" stop-color="#B9C6D4"/>
      <stop offset="1" stop-color="#93A3B4"/>
    </linearGradient>
    <filter id="backShadow" x="-40%" y="-30%" width="180%" height="170%">
      <feDropShadow dx="0" dy="2.2" stdDeviation="3.2" flood-color="#061426" flood-opacity="0.24"/>
    </filter>
'''
s = s.replace("  </defs>", extra_defs + "  </defs>", 1)

back = '''  <!-- Back card, tilted, as in the original Concept D: the front card sits on
       it, which is what gives the mark its thickness. -->
  <g transform="rotate(-8.5 42 46)" filter="url(#backShadow)">
    <rect x="15" y="13" width="56" height="66" rx="7" fill="url(#backCard)"/>
    <rect x="19.5" y="18.5" width="47" height="45" rx="4.5" fill="url(#backPhoto)"/>
  </g>
'''

# Insert just before the front card's first rect.
anchor = '  <rect x="18" y="15" width="64" height="76" rx="9" fill="#000" opacity="0.01" filter="url(#ambient)"/>'
if anchor not in s:
    raise SystemExit("front card anchor not found")
s = s.replace(anchor, back + anchor, 1)

io.open(OUT, "w", encoding="utf-8").write(s)
print("written", OUT)
