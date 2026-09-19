# Bundled basemap

`basemap.json` — **Natural Earth 50m**, public domain: land, lakes, rivers,
country boundary lines, and populated places for orientation. ~1.9MB raw,
650KB gzipped, imported dynamically so it is fetched only when a trip page
opens.

Rebuild with `app/scripts/build-basemap.mjs`, pointing it at the extracted
`50m_physical.zip` and `50m_cultural.zip` from naturalearthdata.com. The
archives are not in the repo; the generated file is.

## China's standard-map worldview

Natural Earth's default boundaries are de facto, which is not the PRC standard
map. After `build-basemap.mjs`, run `scripts/china-worldview.mjs --src <dir>`
(needs three GeoJSON files from `nvkelso/natural-earth-vector`, listed in the
script header). It removes the McMahon line, draws the South Tibet boundary
along the Assam foothills, and adds the nine-dash line as dashed `borders`.
It edits `basemap.json` in place and is idempotent, but a rebuild from the
shapefiles discards it — re-run it after every rebuild. `--diag` prints where
the two worldviews disagree.

Not done: Taiwan's status is only the absence of a border, and place labels
are unchanged.

## Why 50m, and why size is not the constraint

The app is served locally, so bytes are close to free. What costs is **DOM
nodes**: every ring is an SVG `<path>` the browser re-rasterises on each pan
frame. Measured on the a city-a city trip:

| source | nodes in DOM | median pan frame |
|---|---|---|
| 110m, everything drawn | 985 | 21 ms |
| 50m, everything drawn | 5,272 | 43 ms |
| **50m, culled to the view** | **24** | **17 ms** |

So the fix was not coarser data but drawing less of it. `renderTripMap` computes
a bounding box per ring once, then paints only what intersects the view (padded,
so ordinary panning never repaints). A trip map always looks at a small region,
which is what makes this so effective — and it means detail is nearly free.

An earlier attempt went the other way: pull 50m and run Douglas-Peucker to get
the file down. That solved the wrong problem, and the simplifier is gone.

**10m** would work for rendering under the same culling, but two things bite:
its cultural archive is 362MB (fetch the individual boundary/places layers from
`nvkelso/natural-earth-vector` instead), and parsing tens of MB of JSON on first
open is a visible delay. Not worth it for a city-level overview.

## Gotcha

Natural Earth's `scalerank` **0 is the most prominent tier, not a missing
value**. Filtering with `(scalerank || 99)` silently discards the largest
features — it dropped the 272 biggest lakes in the world on the first attempt.
Use `?? 99`.
