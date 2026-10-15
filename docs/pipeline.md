# The pipeline

How the archive is stored and how the three passes build it.

## Storage layout — sharded, not one big file

Everything lives under `ONEDRIVE_METADATA_FOLDER`:

```
index.json              nav + day structure, no PhotoRecords (~6MB minified)
photos/2025-04.json     every PhotoRecord for that month (~200-400KB each)
photos/2025-05.json
```

This replaced a single `archive.json`, which doesn't survive contact with a
10k-photo library: it runs ~7MB minified, every run that added a handful of
photos re-uploaded all of it, and the app had to pull the whole thing before
painting anything. Sharding by month means `scan` writes only the months it
actually saw, and the app fetches one shard when you open a tab.

A record's shard is its **capture month**, not the folder it was filed under.
Those normally agree, but when they don't, the capture date is what the day
grouping and album headings go by, so the shard has to follow it. The folder is
the fallback for photos with no recoverable date at all.

One consequence worth knowing: with the nested `yyyy/mm` layout the month
folders are named bare `01`..`12`, so anything comparing folders must compare
**full paths** — `2025/01` and `2026/01` are otherwise indistinguishable. That's
what `wasCovered()` in `scan.ts` does when deciding whether a missing record
means "deleted from OneDrive" or "outside this run's range".

`pipeline/data/` mirrors the same tree locally, pretty-printed, for inspection.
The uploaded copies are minified — pretty-printing inflated them ~40% for no
benefit on a file that's re-uploaded whole.

## The three passes

```
npm run --workspace pipeline build

npm run --workspace pipeline scan                              # free, whole library
npm run --workspace pipeline scan -- --from 2025-01 --to 2026-12
npm run --workspace pipeline analyze -- --month 2025-04        # spends tokens
npm run --workspace pipeline organize                          # spends tokens
```

**`scan` costs nothing and needs no AI.** The photo library is filed by date,
and Graph returns `photo.takenDateTime`, `location` and `image` facets on the
*listing* response — so indexing a 10k-photo library downloads zero photo bytes
and makes zero model calls. This is what makes the album usable over the whole
library immediately. Bound it to a date range with `--from`/`--to` (or
`SCAN_MONTH_FROM`/`SCAN_MONTH_TO` in `.env`) to index a slice first.

Two folder layouts are recognized, since either is a reasonable way to file a
library — flat `yyyy-mm/` directly under the root, and nested `yyyy/mm/` with
bare month names (`01`..`12`), which is what this library actually uses.
Knowing each folder's month up front is what keeps a bounded scan cheap: only
folders in range get listed at all.

Photos also sit loose in some year folders and in the library root. Those are
scanned non-recursively as month-less folders, and each photo's shard comes
from its own capture date; a loose photo with no recoverable date has nowhere
to be filed and is skipped (the run reports how many). A bounded run filters
loose year folders on their year and skips the root entirely — otherwise
"2025 only" would drag in every stray file at the top level.

Capture time is resolved best-effort, in descending order of trustworthiness:
`photo.takenDateTime` (real EXIF) → the filename (`Screenshot_20250412_143022.png`
— screenshots usually have no EXIF at all but do encode the date, and for a
library that's a big mix of screenshots and everyday photos that covers a large
slice of it) → `fileSystemInfo.createdDateTime`, which degrades to the upload
time for anything copied in and so is a last resort rather than a peer.

**`analyze` is the only pass that spends tokens.** It downloads bytes and
describes photos where `analyzedAt === null`, so re-running is cheap and safe —
already-analyzed photos are skipped, and the shard is written after every month
so an interrupted run keeps its work. Scope it with `--month`, `--from`/`--to`,
and `--limit`. Since it has the bytes anyway, it backfills GPS and capture date
from real EXIF wherever Graph's facets came up empty, then reverse-geocodes.

**`organize` writes the day pages.** Only days with at least one analyzed photo
get summarized — there's nothing for the model to work from otherwise — and only
days whose photo set actually changed get a fresh call. Output goes into
`index.json`'s `sections`; the shards aren't touched.

`organize` survives a model outage rather than losing the run. A day the model
will not write keeps whatever text it had and stays stale, three failures in a
row stop the run, and the index is checkpointed every five written days —
before that, one 503 on the ninth day of a run discarded eight summaries that
had already been paid for.

Rescanning never discards AI work: `scan` merges, carrying forward captions,
tags, OCR text and geocoded places for photos it has seen before.

Two maintenance passes exist for the case where something the summary does
*not* depend on has changed underneath it, so that a paid re-run isn't needed
to clear the staleness:

```
npm run --workspace pipeline dayplaces    # copy each day's dominant place onto the day record
npm run --workspace pipeline accept-days  # accept the current photo set for already-written days
```

Neither calls a model. `dayplaces` exists because `npm run places` rewrites the
shards while `DayRecord.place` is written by organize, so re-placing a library
left 939 days both displaying the old name and marked stale. `accept-days`
covers days whose summary was written before a late caption arrived. A day
whose *prose* names the old place still names it — that half is a rewrite, at
the owner's choosing.

## Provider abstraction

`analyze.ts` and `organize.ts` never call the model directly — they call
`getProvider()` from `pipeline/src/providers/index.ts`, which returns whichever
implementation of the `AiProvider` interface (`pipeline/src/providers/types.ts`)
matches `AI_PROVIDER` in `.env`.

- `providers/gemini.ts` — the only provider today, via `@google/genai`, structured JSON output. **Verified working** against the real API (`pipeline/scripts/smoke-gemini.mjs` — run it any time after changing this file to sanity-check without needing OneDrive access). Default model is `gemini-3.6-flash`; `gemini-2.5-flash` was retired and returns a 404 pointing at the replacement, which is how the current default was picked.

To add another provider (a local model, a different vendor): implement
`captionPhoto` and `summarizeDay` per the `AiProvider` interface in a new
`providers/<name>.ts`, and add a case to the switch in `providers/index.ts`.

## Trips vs. everyday

Photo libraries that mix travel photos with daily snapshots and screenshots
have no reliable signal in *distance* to detect trips from — no clean day-gaps,
no clean geo-cluster. An early attempt was dropped because nothing separated a
trip's first day (105km from home) from an ordinary day out (87km).

So a trip is still an explicit record in `pipeline/data/trips.json`, but it no
longer has to be typed by hand — see **Trips propose themselves** below:

```json
[
  { "id": "trip-example-2025-01", "name": "An example trip", "startDate": "2025-01-01", "endDate": "2025-01-05" }
]
```

`organize.ts` (`tripDefs.ts`) slots any day whose date falls in
`[startDate, endDate]` into that trip. Any day not covered falls into a month
bucket instead. First matching range wins if ranges overlap, so keep them
non-overlapping — `POST /trips/define` refuses an overlap for that reason.

You can still write one by hand, or tell an agent *"look at the photos from
March 1–15 and call that the Japan trip"*. Mostly you accept a suggestion.

### Trips propose themselves

`pipeline/src/jobs/tripSuggest.ts` proposes ranges, and Generate's Trip tab
lists them with an editable name and three answers: **Create** (a trip with no
story — free, instant), **Write its story** (fills the generation form), and
**Not a trip** (remembered in `data/trip-suggestions-dismissed.json`).

The measure is **nights, not distances**. A day out ends at home however far it
went; a trip does not. So a night counts as away when the evening is more than
`AWAY_KM` (40km) from home *and* the next morning is not at home either — an
evening 200km out says where the camera was at six, not where its owner slept.
A run ends at the first morning spent at home, which stops a trip bridging a
photo-less day into the next one.

Home is not configured. It is the 0.2° grid cell holding nights in the most
distinct weeks within ±120 days of the day being judged, so it follows a move
between cities on its own — this library's does, after a move between cities.

It reproduced the hand-made trips exactly; every trip in this library was
proposed by it.

### Days out

The same pass (`findExcursions`) picks up the other half: a day that went
somewhere and came home the same night — home both sides, at least
`MIN_AWAY_PHOTOS` (10) photos away, and not already inside a defined trip.
There are a couple of dozen here, the furthest a few hundred kilometres out and
the nearest about 40km.

They need no trip page and get none. They ride in `home.json` as `excursions`
(`DayExcursion` in `shared/src/types.ts`), because they come from the same pass
over the same shards and every reader that fetches one fetches the other — so
the phone gets them for free.
