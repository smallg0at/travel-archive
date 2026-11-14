"""Concept D, cliff edition, drawn in layers rather than one gradient.

The mottling problem is not solved by adding noise. It is solved by giving the
chalk two distinct planes, a soil shadow hanging under the crest, vertical run
striations at very low contrast, two flint bands, and a foot that has a contact
shadow, a cool bounce off the sea, and a cobble strip. The road is drawn as two
edges with grass between them, because a single pale stroke disappears against
the downland.
"""

# Striations: fixed, so the result is reproducible. (x, y, width, height, opacity)
STRIATIONS = [
    (11.0, 35.6, 0.30, 7.4, 0.09), (12.1, 34.8, 0.22, 9.6, 0.12),
    (13.4, 34.2, 0.40, 6.2, 0.07), (14.6, 33.4, 0.24, 11.2, 0.11),
    (16.0, 32.9, 0.34, 8.0, 0.08), (17.2, 32.3, 0.20, 10.4, 0.13),
    (18.6, 31.8, 0.42, 7.6, 0.07), (20.1, 31.3, 0.24, 9.2, 0.10),
    (21.4, 30.9, 0.30, 6.4, 0.12), (22.8, 30.6, 0.20, 8.8, 0.09),
    (24.2, 30.3, 0.36, 7.0, 0.11), (25.6, 30.2, 0.22, 9.8, 0.08),
    (27.0, 30.2, 0.30, 6.6, 0.12), (28.4, 30.5, 0.20, 8.2, 0.10),
    (29.8, 31.0, 0.34, 7.2, 0.09), (31.0, 31.8, 0.22, 9.0, 0.11),
    (11.8, 39.4, 0.22, 6.8, 0.08), (15.2, 37.6, 0.30, 8.4, 0.09),
    (19.4, 36.2, 0.20, 7.2, 0.11), (23.0, 35.2, 0.34, 8.8, 0.08),
    (26.6, 34.8, 0.22, 6.6, 0.10), (29.2, 35.6, 0.30, 7.4, 0.09),
    (13.0, 41.6, 0.20, 5.6, 0.09), (17.4, 40.2, 0.28, 6.4, 0.08),
    (21.8, 39.2, 0.20, 5.8, 0.10), (25.4, 39.0, 0.26, 6.2, 0.08),
    (10.4, 34.8, 0.9, 9.0, 0.10), (12.6, 33.2, 0.6, 11.5, 0.13),
    (14.2, 32.4, 1.1, 13.0, 0.09), (16.4, 31.4, 0.5, 10.0, 0.12),
    (18.2, 30.8, 0.8, 12.5, 0.11), (20.0, 30.4, 0.45, 8.5, 0.14),
    (21.6, 30.0, 0.7, 10.5, 0.10), (23.4, 29.8, 0.5, 7.5, 0.13),
    (25.2, 29.8, 0.9, 9.5, 0.09), (27.0, 30.2, 0.55, 11.0, 0.12),
    (28.8, 31.0, 0.7, 8.0, 0.11), (30.6, 32.2, 0.5, 9.5, 0.13),
    (11.6, 38.0, 0.7, 8.0, 0.08), (15.6, 36.6, 0.5, 9.5, 0.10),
    (19.0, 35.4, 0.8, 10.5, 0.08), (22.6, 34.4, 0.5, 9.0, 0.11),
    (26.2, 34.2, 0.7, 10.0, 0.09), (29.4, 35.4, 0.5, 8.0, 0.10),
]

DOC = f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="512" height="512" role="img" aria-label="Photo Archive">
  <defs>
    <linearGradient id="backCard" x1="0.2" y1="0" x2="0.7" y2="1">
      <stop offset="0" stop-color="#E9EEF4"/><stop offset="1" stop-color="#C6D1DC"/>
    </linearGradient>
    <linearGradient id="card" x1="0.15" y1="0" x2="0.7" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/><stop offset="0.62" stop-color="#F8FAFC"/><stop offset="1" stop-color="#E6ECF3"/>
    </linearGradient>

    <linearGradient id="sky" x1="0.1" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="#DCEAF3"/><stop offset="0.45" stop-color="#B6D3E6"/><stop offset="1" stop-color="#8FBBD6"/>
    </linearGradient>
    <linearGradient id="sea" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="#6FA4AE"/><stop offset="0.45" stop-color="#3F7E8C"/><stop offset="1" stop-color="#2A6573"/>
    </linearGradient>
    <linearGradient id="seaShade" x1="0" y1="0" x2="1" y2="0.4">
      <stop offset="0" stop-color="#1F4C5C" stop-opacity="0.55"/><stop offset="1" stop-color="#1F4C5C" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="down" x1="0.15" y1="0" x2="0.75" y2="1">
      <stop offset="0" stop-color="#B7B072"/><stop offset="0.4" stop-color="#96995A"/><stop offset="1" stop-color="#5F6A34"/>
    </linearGradient>
    <linearGradient id="downLit" x1="0" y1="0" x2="0.5" y2="1">
      <stop offset="0" stop-color="#D8CB94" stop-opacity="0.9"/><stop offset="1" stop-color="#C0AE72" stop-opacity="0"/>
    </linearGradient>

    <linearGradient id="chalkLit" x1="0.1" y1="0" x2="0.55" y2="1">
      <stop offset="0" stop-color="#FFFEF8"/><stop offset="0.6" stop-color="#F7F1E4"/><stop offset="1" stop-color="#E8DFCC"/>
    </linearGradient>
    <linearGradient id="chalkTurn" x1="0" y1="0" x2="1" y2="0.6">
      <stop offset="0" stop-color="#CDBFAB"/><stop offset="0.5" stop-color="#B7A894"/><stop offset="1" stop-color="#9C8E7B"/>
    </linearGradient>
    <linearGradient id="soilShadow" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7A6547" stop-opacity="0.34"/>
      <stop offset="0.55" stop-color="#7A6547" stop-opacity="0.10"/>
      <stop offset="1" stop-color="#7A6547" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="footShade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#6E6255" stop-opacity="0"/><stop offset="1" stop-color="#6E6255" stop-opacity="0.42"/>
    </linearGradient>
    <linearGradient id="bounce" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="#8FC4C6" stop-opacity="0"/><stop offset="1" stop-color="#8FC4C6" stop-opacity="0.22"/>
    </linearGradient>
    <linearGradient id="cobble" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0" stop-color="#9E9384"/><stop offset="1" stop-color="#6E665A"/>
    </linearGradient>
    <linearGradient id="tower" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#FFFFFF"/><stop offset="0.5" stop-color="#F6F1E6"/><stop offset="1" stop-color="#CBC1AE"/>
    </linearGradient>
    <linearGradient id="pin" x1="0.15" y1="0" x2="0.55" y2="1">
      <stop offset="0" stop-color="#FF8B57"/><stop offset="0.35" stop-color="#F0521A"/>
      <stop offset="0.75" stop-color="#D03104"/><stop offset="1" stop-color="#A81F00"/>
    </linearGradient>
    <linearGradient id="innerShade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0B2743" stop-opacity="0.18"/><stop offset="0.16" stop-color="#0B2743" stop-opacity="0"/>
      <stop offset="0.88" stop-color="#0B2743" stop-opacity="0"/><stop offset="1" stop-color="#0B2743" stop-opacity="0.12"/>
    </linearGradient>
    <linearGradient id="topLight" x1="0" y1="0" x2="0.2" y2="1">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.9"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>

    <clipPath id="view"><rect x="24" y="21" width="52" height="48" rx="5"/></clipPath>
    <clipPath id="cardClip"><rect x="18" y="15" width="64" height="76" rx="8"/></clipPath>
    <clipPath id="chalkClip">
      <path d="M8.6 48 L8.9 36.4 L10.4 34.2 L12.6 33.2 L15.6 32.2 L18.6 31.2 L21.6 30.4 L24.6 29.8 L27.4 29.3 L29.8 29.1 L31.2 30.2 L30.5 31.6 L31.6 32.4 L33.3 33.2 L33.9 36.2 L34.2 48 Z"/>
    </clipPath>

    <filter id="backShadow" x="-40%" y="-30%" width="180%" height="170%">
      <feDropShadow dx="0" dy="2.2" stdDeviation="3.2" flood-color="#061426" flood-opacity="0.24"/>
    </filter>
    <filter id="contact" x="-30%" y="-25%" width="160%" height="160%">
      <feDropShadow dx="-1.2" dy="2.4" stdDeviation="2.6" flood-color="#04101F" flood-opacity="0.34"/>
    </filter>
    <filter id="pinShadow" x="-70%" y="-50%" width="240%" height="230%">
      <feDropShadow dx="-1.8" dy="2.4" stdDeviation="3" flood-color="#0B1220" flood-opacity="0.4"/>
    </filter>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="1.1"/></filter>
    <filter id="softer" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="2.6"/></filter>
  </defs>

  <g transform="rotate(-8.5 42 46)" filter="url(#backShadow)">
    <rect x="15" y="13" width="56" height="66" rx="7" fill="url(#backCard)"/>
  </g>
  <rect x="18" y="15" width="64" height="76" rx="8" fill="url(#card)" filter="url(#contact)"/>
  <g clip-path="url(#cardClip)"><rect x="18" y="15" width="64" height="4" fill="url(#topLight)" opacity="0.7"/></g>

  <g clip-path="url(#view)">
    <g transform="translate(24 21)">
      <rect width="52" height="48" fill="url(#sky)"/>

      <!-- sea, horizon at 28.6, meeting the shore at the bottom left -->
      <path d="M0 28.6 H26 C22.6 32.4 18 36.4 13.4 40 C9 43.4 4.4 46 0 47.2 Z" fill="url(#sea)"/>
      <path d="M0 28.6 H26" stroke="#D3E4E8" stroke-width="0.45" opacity="0.6"/>
      <!-- the headland's long shadow falling across the water -->
      <path d="M0 33.4 C6 35.6 12 39.4 18 44 L13.4 47.6 C8 43.4 3.4 39.4 0 37.8 Z" fill="url(#seaShade)" filter="url(#softer)"/>

      <!-- downland: the plateau the lighthouse stands on -->
      <path d="M9.6 40 C9.8 36.4 10.4 33.6 11 31.6 C14 29.4 18 27.6 22.6 26.6 C28 25.4 34 24.6 40 24.2 C46 23.8 49.6 23.6 52 23.6 V48 H9.6 Z" fill="url(#down)"/>
      <path d="M11 31.6 C14 29.4 18 27.6 22.6 26.6 C28 25.4 34 24.6 40 24.2 C44 23.9 47 23.8 49.4 23.7 C43 25.6 35.4 27.2 28 28.6 C21 29.9 14.6 32.2 9.6 35.8 Z" fill="url(#downLit)"/>
      <!-- crest edge, the one bright line on the land -->
      <path d="M12.4 30.4 C16.6 28.2 21.6 26.6 27 25.8 C33 24.9 40 24.4 46 24.2" fill="none" stroke="#E8DCA8" stroke-width="0.55" opacity="0.75"/>

      <!-- road: two edges with grass between them, so it cannot vanish -->
      <path d="M12.8 33.4 C18 31.6 24 30.4 30 29.8 C36 29.2 42 28.8 47 28.6"
            fill="none" stroke="#D9CCA8" stroke-width="0.34" opacity="0.85"/>
      <path d="M12.4 34.6 C18 32.9 24 31.8 30 31.2 C36 30.6 42 30.2 47 30.1"
            fill="none" stroke="#C6B58C" stroke-width="0.3" opacity="0.55"/>
      <!-- the loop that turns back toward the cliff -->
      <path d="M20 31.4 C21.6 34 21 36.6 18.6 38.4 C16.6 39.9 14.4 40.6 12.4 40.4"
            fill="none" stroke="#CFC09A" stroke-width="0.3" opacity="0.5"/>

      <!-- chalk: lit plane -->
      <path d="M8.6 48 L8.9 36.4 L10.4 34.2 L12.6 33.2 L15.6 32.2 L18.6 31.2 L21.6 30.4 L24.6 29.8 L27.4 29.3 L29.8 29.1 L31.2 30.2 L30.5 31.6 L31.6 32.4 L33.3 33.2 L33.9 36.2 L34.2 48 Z"
            fill="url(#chalkLit)"/>
      <!-- chalk: the plane turning away, right of the fold -->
      <path d="M31.2 30.2 L30.5 31.6 L31.6 32.4 L33.3 33.2 L33.9 36.2 L34.2 48 H30.6 L30.9 37.6 Z"
            fill="url(#chalkTurn)" opacity="0.95"/>
      <g clip-path="url(#chalkClip)">
        <!-- soil shadow hanging under the crest -->
        <path d="M8.6 29 L12 31.4 L16 30.4 L20 29.6 L24 28.9 L28 28.4 L31.4 28.4 L32 35 L8.6 36 Z" fill="url(#soilShadow)"/>
        <!-- run striations -->
        {' '.join(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{w/2:.2f}" fill="#8C8880" opacity="{o}"/>' for x, y, w, h, o in STRIATIONS)}
        <!-- two flint bands -->
        <path d="M12 36.4 C16 35.9 20 35.7 24 35.9 C26 36 28 36.2 29.6 36.5" fill="none" stroke="#9C948A" stroke-width="0.55" opacity="0.38"/>
        <path d="M14 41.2 C18 40.7 22 40.6 25.6 40.9 C28 41.1 30 41.4 31.6 41.8" fill="none" stroke="#9C948A" stroke-width="0.45" opacity="0.3"/>
        <!-- warm staining low on the face -->
        <path d="M8.6 44.6 L14 43.9 L20 43.8 L26 44.2 L30.2 44.8 L34.2 45.6 V48 H8.6 Z" fill="#B99A6B" opacity="0.14"/>
        <!-- foot shadow and the cool bounce off the sea -->
        <path d="M8.6 45.2 L14 44.6 L20 44.6 L26 45 L30.2 45.4 L34.2 46 V48 H8.6 Z" fill="url(#footShade)"/>
        <path d="M8.6 46.4 L14 45.8 L20 45.8 L26 46.2 L30.2 46.6 L34.2 47.1 V48 H8.6 Z" fill="url(#bounce)"/>
      </g>
      <!-- the hard light edge where the sun catches the fold -->
      <path d="M31.2 30.2 L30.5 31.6 L31.6 32.4 L33.3 33.2" fill="none" stroke="#FFFDF4" stroke-width="0.4" opacity="0.9"/>

      <!-- cobbles between surf and chalk -->
      <path d="M0 46.4 C4.6 45.4 9 43.6 13 41.2 L15.4 44.6 C11 46.9 6 48 0 48 Z" fill="url(#cobble)" opacity="0.85"/>
      <path d="M0 47.4 C4.4 46.6 8.6 45.2 12.2 43.2" fill="none" stroke="#4F4A42" stroke-width="0.5" opacity="0.35"/>

      <!-- lighthouse, raised, on the crest -->
      <g>
        <ellipse cx="34.4" cy="25.2" rx="3.4" ry="1" fill="#3B4227" opacity="0.28"/>
        <path d="M33.2 25.1 L32.9 16.6 L35.9 16.6 L35.6 25.1 Z" fill="url(#tower)"/>
        <rect x="32.5" y="15.6" width="3.9" height="1.3" rx="0.5" fill="#2E3A44"/>
        <path d="M32.9 15.6 L34.4 14.2 L35.9 15.6 Z" fill="#3A4753"/>
        <rect x="33.1" y="18.6" width="2.6" height="0.7" rx="0.35" fill="#2E3A44" opacity="0.7"/>
        <rect x="32.6" y="23.9" width="4.1" height="1.2" rx="0.5" fill="#EDE7D8"/>
      </g>
    </g>
    <rect x="24" y="21" width="52" height="48" fill="url(#innerShade)"/>
  </g>

  <rect x="24" y="75.8" width="33" height="2" rx="1" fill="#6C8094" opacity="0.85"/>
  <rect x="24" y="81.8" width="22" height="2" rx="1" fill="#6C8094" opacity="0.5"/>
  <rect x="66" y="75.5" width="10" height="6" rx="2.5" fill="#F0A11E"/>

  <g filter="url(#pinShadow)" transform="rotate(12 76.5 22.5)">
    <path d="M76.5 10 a12.5 12.5 0 0 1 12.5 12.5 c0 8.4 -9.2 15.6 -12.5 22.5 c-3.3 -6.9 -12.5 -14.1 -12.5 -22.5 A12.5 12.5 0 0 1 76.5 10 Z" fill="url(#pin)"/>
  </g>
  <path d="M76.5 12 a10.4 10.4 0 0 0 -10 7.6 c1.8 -3.6 5.6 -6 10 -6 c1.6 0 3.2 0.35 4.5 1 a10.4 10.4 0 0 0 -4.5 -2.6 Z" fill="#FFD9C7" opacity="0.5" transform="rotate(12 76.5 22.5)"/>
  <circle cx="76.5" cy="22.4" r="5" fill="#FFFFFF"/>
</svg>
'''

with open(r"C:/Code/proj/docs/logo-drafts/logo-d-cliff2.svg", "w", encoding="utf-8") as fh:
    fh.write(DOC)
print("written logo-d-cliff2.svg")
