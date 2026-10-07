# Photo Archive — design brief

Written for a designer picking this up cold. The repo's README covers storage
and pipeline cost; this covers what the product *is*, because that is what has
been getting mocked up wrong.

---

## What it is

A **personal photo archive** over one person's OneDrive library: ~31,700 photos
across 123 months, 2016–2026. It does two things:

1. Shows the whole library, filed by month.
2. Turns selected stretches of it into something **written and readable** — an
   AI pass captions photos, transcribes text in them, groups each day into the
   places it was spent, and writes summaries. A trip becomes a document, not a
   folder.

The second part is the point. A grid of photos is what the app is trying to
stop being.

**It is a desktop app** (Electron shell around a local web app). Mobile is a
later, view-only client — it can read the archive but never generates anything.
Design desktop first; do not lead with phone screens.

---

## The single most important idea

**A day is a page, not a grid.** The hierarchy inside a trip is:

```
Day  (2026-08-19 · a city · day summary, ~70 words)
 └── Place  ("the museum", 12:52–15:20, 99 photos, place summary)
      ├── Cards        the things worth describing, sized by how much they matter
      └── "N more photos"   everything else, collapsed
 └── Place  ("the canals", 11:22–12:10, 5 photos)
 └── Transit ("walk along the canals", 10:50–11:17) — one collapsed line, not a place
```

Three rules the layout must respect:

- **A photo appears exactly once on a page.** Cards claim theirs; the grid gets
  the remainder.
- **A photo that only describes another** — a museum placard, a menu, a
  timetable — never appears on its own. Its transcribed text becomes the card's
  description, and its English rendering prints as a quote block inside the card.
- **Transit collapses.** Train and walking legs are part of the day but are not
  places in it.

### The card system

Cards sit on a **4-column grid**. Size is chosen by the model per card and is
what makes a page have shape instead of being a wall:

| size | span | budget per place | on-screen image height |
|---|---|---|---|
| `full` | 4 columns | max **1** | 380px |
| `half` | 2 columns | max **2** | 240px |
| `normal` | 1 column | up to **30** | 130px |

A card is: one or more images, a title, a short description, and optionally a
translated placard quote plus a collapsible "original text".

Real numbers from the reference trip, so mockups are honest: **725 cards across
125 places over 18 days — 125 full, 152 half, 448 normal.** A busy museum stop
can produce 28 cards. Design for density, not for four tidy cards a screen.

---

## Information architecture

The sidebar has **two sibling groups**, not a nesting:

```
Trips
  the train 1                    4685
2026
  September                        1873
  August                           4998
  July                             1922
  …
2025
  …
```

- **Trips are a second way into the same days, not a container for months.** The
  photos still appear under their month; a trip is a *reading* of part of the
  library.
- A trip **straddles months** (the reference trip runs 16 Aug – 2 Sep). Month is
  a storage detail, not a concept inside a trip. **There is no "filter by month"
  within a trip** — that would cut a continuous narrative in half at an
  arbitrary boundary.
- Months are grouped under year headings, newest first.

### A trip page, top to bottom

1. **Title + range** — "the train 1 · Sun 16 August 2026 – Wed 2 September 2026 · 18 days · 4,685 photos"
2. **Narrative** — the model's prose account of the whole trip, ~380 words, several paragraphs. This is the first thing you read.
3. **Places** — a row of chips (21 of them).
4. **Map** — see below.
5. **Then every day, in order**, each laid out as described above.

### The map

A **city-level overview in the style of a rail-network map**, not a
street-level map and not a heatmap. Circles for cities sized by how much time
was spent there, lines between them following the actual chronological route
(so a double-back draws twice), over a plain physical background — land, sea,
lakes, rivers, national borders — from bundled Natural Earth data. Zoomable.
Clicking a city scrolls to that city's section in the page.

It **lives inside the trip page**. It is not a global navigation tab.

23 cities on the reference trip. Precision bar: two cities ~55km apart must not
merge into one dot, nor two towns ~25km apart.

---

## Generation — the part that was missing entirely

This is a desktop app because it *does work*, not just displays it. A drawer
across the bottom of the content area runs jobs against the local pipeline:

- **Analyze** — captions photos in a date range. Costs money; shows an estimate
  before spending, and a live count while running.
- **Day summaries** — groups analyzed photos into places and writes the day and
  place summaries.
- **Trip** — writes the trip narrative over a **manually chosen date range**
  (never inferred — "one can move home somewhere else").

Jobs stream progress over SSE: phase, done/total, a scrolling log, and cancel.
**One job at a time.** A run over 18 days took ~35 minutes and 2,989 photos, so
progress needs to be readable from across the room, and reattach if the window
is reloaded mid-run.

Entry point today is a burger menu bottom-left with *Generate* and *Settings*.
That is known to be wrong and is on the list: these should sit in the sidebar
list alongside the months, always visible, Task-Manager style.

---

## Theming and print

Light-first. `:root` carries the light palette; dark is a
`prefers-color-scheme` override. Six tokens drive everything: `--bg`,
`--bg-muted`, `--text`, `--text-secondary`, `--border`, `--accent`. A user-facing
light/dark toggle is still to do.

There is a **Save as PDF** export that turns a trip into a self-contained
document (214 A4 pages for the reference trip). It prints cards only — never
the collapsed grids — because the export is for sharing.

---

## What the current mobile mockups got wrong

Recorded so the same corrections are not needed twice:

1. **Wrong platform.** Three phone screens; this is a desktop app.
2. **Months nested inside a trip.** They are siblings in the sidebar, and a trip
   deliberately crosses month boundaries.
3. **"Filter by month" chips inside a trip.** Not a concept here, and it splits
   a continuous narrative.
4. **The day rendered as a bare uniform photo grid.** This is precisely the
   design the app moved away from. Day → Place → sized cards → collapsed grid.
5. **No narrative, no place chips, no map** on the trip page.
6. **Map as a global bottom-tab.** It belongs inside a trip page.
7. **Generation absent entirely** — no jobs, no progress, no cost estimate.
8. **A search field** that does not exist in the product.
9. **Dark-only**, when the app is light-first.
10. **Inconsistent counts** (August 341 / September 4344 in one screen,
    341 / 1873 in another) — and backwards: September holds two days of an
    eighteen-day trip.

## Real data to design against

| | |
|---|---|
| library | ~31,700 photos, 123 months, 2016–2026 |
| reference trip | the train 1, 2026-08-16 → 09-02, 18 days, 4,685 photos |
| its segments | 125 places, 81 transit |
| its cards | 725 (125 full, 152 half, 448 normal) |
| photos in cards vs collapsed | 1,292 vs 2,367 |
| trip narrative | ~380 words; day summaries ~70 words; place summaries ~20 |
| cities on the map | 23 |
