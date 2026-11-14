# Handoff to Argon — Concept D, final direction

## What is decided

Concept D is the icon: a white Polaroid card with a coral map pin breaking out of
its top-right corner. Of the six concepts this was the only one whose silhouette
survives at small sizes, and the only one whose meaning (a photograph with a
place attached) matches the product.

The landscape inside the card's window is drawn from one frame: the chalk cliff
at Beachy Head, looking along the coast. Ask the owner for the two files — the
frame and the same frame with the coastline traced on it (red for the coast,
purple for the road, yellow for the cobble beach). Those two images are the
brief; everything below is what was learned trying to draw them.

## Where the work stands

- `docs/logo-drafts/gemini-cliff.svg` — the master. Pure vector, no raster.
- `gemini-cliff-256.png`, `-128.png`, `-64.png` — renders for review.
- `docs/logo-drafts/logo-d-gemini-sheet.png` — frame, annotated frame, icon
  ladder in one image.

## Fixed geometry (do not redesign)

```
canvas          viewBox="0 0 100 100", 512 master
back card       <g transform="rotate(-8.5 42 46)"> rect 15,13 56x66 r7
front card      rect 18,15 64x76 r8, soft contact shadow
photo window    rect 24,21 52x48 r5, clipped
caption strip   bars at 24,75.8 (33x2) and 24,81.8 (22x2)
amber tag       rect 66,75.5 10x6 r2.5, #F0A11E
pin             head r 12.5 at (76.5,22.5), tip y=45, white hole r=5,
                rotated 12° about (76.5,22.5), drop shadow + rim light on the
                upper left
```

Inside the window, work in a 0..52 x 0..48 coordinate system under
`<g transform="translate(24 21)">`.

## The composition (from the traced frame)

- Sky across the top, roughly the upper 45% — the landscape sits about 10% lower
  than the frame's crop so the sky has room.
- Sea enters from the left, horizon about a third down, a pale surf band where it
  meets the shore.
- The chalk cliff is the largest single mass: one sheet, evenly lit, warm white,
  with the coastline's signature S-curve as its outline. A sharp N-shaped kink
  low on the face is character — keep it, but the inner plane should be only a
  shade darker than the face, not a grey wall.
- The downland is a band along the top of the chalk, not a hill: a plateau
  carrying the road and the lighthouse.
- The lighthouse stands on the crest, slender and taller than life so it survives
  at 128. White tower, dark cap, a small plinth.
- A cobble strip (grey-brown, 2-3 units) sits between the surf and the chalk, with
  a darker waterline above it. Without it the chalk appears to drop into the sea.

## Surface rules — the part that took the longest

Chalk is not a gradient. A single vertical gradient over the whole face reads as
cloth. What works:

1. **Soil shadow under the crest** — a band 5-6 units deep, warm brown, opacity
   0.3 at the rim falling to 0. This is what makes it a cliff rather than a
   white slope.
2. **Run striations** — 12-18 shapes, width 0.2-0.45 units (never wider), height
   5-11, scattered, not evenly spaced, cool grey `#8C8880` at 0.07-0.13 opacity,
   fading at both ends. Wider bars read as pleats; even spacing reads as a
   pattern; either one kills it.
3. **Two flint bands** — broken horizontal strokes 0.45-0.55 wide, `#9C948A` at
   0.3, at roughly 45% and 65% of the face height.
4. **Ochre staining low down** — `#B99A6B` at 0.14 over the bottom fifth.
5. **Foot** — a tight contact shadow (0.35) where chalk meets ground, and just
   below it a cool bounce off the sea (`#8FC4C6`, 0.18-0.22). That pair is what
   seats the mass in the scene.
6. **No large shaded plane on the chalk.** The photograph is evenly lit and the
   first attempts that modelled a second plane looked like a wall.

## The road

One open ribbon, left shoulder to right edge, 3-4 units below the crest at every
point, a shallow S in the middle, paler fill with slightly darker edges. Three
ways to get it wrong, all tried: a hairline (invisible), a stroke that reaches
the rim (a car drives off the cliff), a curve that turns back on itself (a road
to nowhere).

## Sizes

256 and 128 are the design targets. 32 and below get a separate simplified mark —
white card, one dark mass, one coral dot — drawn on the pixel grid rather than
downscaled; that pass does not exist yet.

## What is left

1. The small-size mark (16/24/32).
2. Export set, all from the one master: app favicon, the mark inside the app's
   About pane, Android adaptive icon (foreground + background layers, 66% safe
   area), `.ico` with 16/24/32/48/64/128/256, and the splash mark (single colour).
3. The mobile squircle variant, if the Android icon should keep the card's white
   margin — it needs its own optical adjustment.

## How to check a change

```
node -e "const sharp=require('sharp');(async()=>{const b=await sharp('docs/logo-drafts/gemini-cliff.svg',{density:144}).png().toBuffer();for(const s of [256,128])await sharp(b).resize(s,s).png().toFile('docs/logo-drafts/check-'+s+'.png')})()"
```

Then look at 256 and 128 — not at 512. If a detail is invisible at 128 and it is
not one of the five shapes listed above, it is decoration and can go.
