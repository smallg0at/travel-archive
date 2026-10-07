# Architecture and subsystems

The `Shape` section of `HANDOFF.md` gives the one-paragraph version; this is the detail.

## The phone's offline archive

The phone keeps every month's `PhotoRecords` in IndexedDB and opens from them
rather than the network. `offline.ts` runs one background pass over the whole
library (a quiet toast reports it; Settings › Offline shows the count, the bytes
and an off switch), and a launch asks OneDrive for a single listing of the
`photos` folder to diff each month's eTag and pull only the shards that moved —
so a month already kept is never re-downloaded. `loadMonthKept` is local-first,
and the index translations are read from their kept copy before first paint, so a
slow link costs freshness, never the first screen; coming back to the foreground
resumes a pass a backgrounded WebView stalled. The month caption files are kept
too, so an offline month reads in the reader's language. Measured on this
library: every month but one, the last being a shard the index lists but OneDrive
does not hold (a standing open item, seen as a Graph 404 for a month file the
drive lacks).

### Place names come from a local gazetteer, not a service

Reverse geocoding used to call Nominatim once a second per photo. Their usage
policy allows **4 requests a minute** for anything scheduled or running longer
than a day, which a library-wide captioning pass is, so it moved offline.

`pipeline/data/geo/` holds `places.tsv` (235,822 settlements — position,
population, and the name in its own language, English and Simplified Chinese)
and `countries.tsv`. Both are built from the GeoNames dumps by:

```
npm run geo:build --workspace pipeline
```

which needs `cities500.txt`, `alternateNamesV2.txt` and `countryInfo.txt`
downloaded into that folder first (see the script's header). The data folder is
gitignored, so a fresh clone must run this before analyzing anything; without
it, geocoding throws on the missing file. GeoNames is CC BY 4.0 — the credit
line in Settings (`settings.dataCredits`) is the attribution, and it must stay.

Lookups are ~57µs, so locating a 4,000-photo round is about a second where
Nominatim took 40 minutes. Street-level detail (a street address such as
"1 High Street") was dropped with the move: measured on this archive it reached
9% of captions, and street names 0.1%, for a second request per photo.

### Street level and POI names: investigated, decided against (2026-10-04)

`photo.near` (`{venue, street}`) has had **no writer since `2ffeefe`**, the
Nominatim → GeoNames move, so both fields are always null and the two places
that would use them — `captionContext.ts:23-24` and `analyze.ts:288-289` — are
dead code. The fields and the prompt lines are kept rather than deleted:
reviving the feature costs one writer plus a backfill, and the read end is
already built.

Four ways to fill it were examined. The evidence says none of them pays:

| Evidence | Figure |
|---|---|
| street names in captions | **0.1%** |
| street/venue words reaching a day summary | **2.00%** (41/2,048) |
| a neighbouring hint naming the subject | **0 of 20** (a museum visit, `types.ts:17-22`) |
| venue-hint A/B run in `scripts/bench-providers.mjs` | 0/6 and 1/6 — six photos at two places, half the calls never reaching the model |

- **GeoNames, extended to class S (spot) and R (road)** — the cheapest: CC BY
  4.0 stays and only `build-geo.mjs` changes. Not the same files, though —
  `cities500.txt` is class P only, so it needs the per-country `XX.zip`
  downloads. Density in the most sparsely covered country is unmeasured.
- **OSM extraction** — data-side fine, download-side awkward. The trips span a
  handful of countries in disconnected clusters, and Geofabrik slices by
  administration: a large country 1.5GB whole, 25–163MB a province, a whole
  continent 32.5GB — gigabytes bought for a few hundred square kilometres of
  interest. ODbL is workable (build `poi.tsv` locally, never commit it, credit
  line in Settings); the public Overpass instance has the same fair-use problem
  that killed Nominatim, so an OSM route means a file download, not an API.
- **Photon, self-hosted** — ruled out on size rather than licence: the planet
  database dump is **62.8GB** (JSON dump 26.9GB) and wants Java 21, OpenSearch
  and — per its own README — 64GB of RAM. Against a "tens of MB, loaded once
  at startup" target that is three orders of magnitude away. Photon's
  *regional JSON dumps* remain a reasonable way to obtain OSM data without
  running Photon.
- **Text extraction from the archive's own OCR** — zero new data and zero
  licence, and rejected on precision: what OCR reads is a departure board, a
  ticket, a menu or a map, and those name the destination rather than the
  place. A name being *in* the image is not the image being *of* it, and that
  failure mode would be quiet.

Standing gap, unrelated to POIs: **about 30% of the library has no place at
all** — a settlement lookup miss, not a venue miss.

---

## How captioning works, for when it is needed again

- **Context.** The prompt carries the camera's clock in words, the trip, the
  town, and the owner's note for the day. The town is looked up *before*
  captioning from the local gazetteer (`geocodeBeforeCaptioning` — no network,
  and no `data/geocode-cache.json`: that file was Nominatim's). `venue` and
  `street` are still declared on `CaptionContext` but always null, because
  nothing writes `photo.near` — see "Street level and POI names: investigated,
  decided against". Measured: a real place name added to 6 of 24 captions,
  nothing invented (an entry in the archived list). The name of a museum still
  first appears in the stop title.
- **Low image resolution** (`CAPTION_RESOLUTION`, `gemini.ts`) — ~600 input
  tokens a photo instead of 1,429, same naming, same transcriptions.
- **Batch** — Generate → Analyze → "As a batch": half price, results within a
  day (the test took 4 minutes), in files of 4,000 requests
  (`jobs/analyzeBatch.ts`). The server collects finished batches itself every
  ten minutes. `data/batches/analyze.json` records what was submitted and is
  the only way back to a batch being paid for — never delete it while one is
  open.
- **Activity** (sidebar, `app/src/activity.ts`) shows all of it: the running
  job live, thumbnail warming, every batch with its tokens and cost, and job
  history read from `data/jobs/` (so it survives restarts). When a job the page
  did not start ends — the server's own collect — it reloads the album once
  (`claimRefresh`, and `lastFinished` on `/health`, since a 15 s poll misses a
  collect that takes 0.3 s).

**The first whole-library submit (2026-09-11) was cut short.** One batch of
4,000 went in; the second was refused with HTTP 429 "You exceeded your current
quota", and the job ended there. The file had uploaded; `batches.create` was
what refused. Tier 1 allows **3M tokens queued across all open batches** for
Gemini 3.7 Flash (Google's rate-limits page; Tier 2 allows 400M), and one
4,000-photo file is ~2.6M — so at Tier 1 only one batch can be open at a time.
Submitting again is safe: photos already in an open batch are skipped. **Since
then the server submits the rest by itself**, one batch after each collect
(`autoSubmit` in `analyzeBatch.ts`; stop it from Activity). Photos that come
back without a caption are left out of later batches — run one interactive
Analyze at the end. While a batch is out the server also looks up places for the
next one (a `locate` job), so a round is Google's wait rather than an hour of
Nominatim followed by it.

At batch prices on gemini-3.7-flash (they double on 2027-01-01) a whole-library
run is about **$20**, measured on the first full batch: 4,000 photos for $3.40 —
578 input and 337 output tokens a photo (output, including thinking, above
the 250 estimated, and 62% of the cost). A photo that
comes back empty (RECITATION) stays uncaptioned — one interactive Analyze
afterwards picks those up with its fallback.

The i18n decision no longer blocks this: captions stay English and are
translated beside the archive.

**Day summaries are no longer the gap they were.** Measured 2026-09-20 from
`index.json`: **most eligible days are written**, against a small fraction
earlier that week. A handful remain unwritten, all inside trips, and a few dozen
written days are stale — their captioned set has moved on since the prose was
written. What is left of this is a rewrite at the owner's choosing, not a body
of work.

Still open and cheaper: day summaries are written in isolation, and the owner's
notes reach only the trip narrator.
