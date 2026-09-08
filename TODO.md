# TODO

State as of **2026-09-07**. The **the train 1** trip (2026-08-16 → 09-02, 18
days) is fully analyzed: 4,181 photos captioned, 28 days summarized, trip
narrative written, map rendering. That run cost **under £8**.

**31 open, 18 done.** The list grows because each session surfaces defects that
were previously invisible — most of what has been closed was found by measuring
rather than by planning. The cluster with real user-visible value still in it is
captions and summarizers, and it has now been deferred three times.

### Done 2026-09-07

- Thumbnails and originals off browser storage onto a local disk cache, warmed
  ahead of the browser: fast-scroll p50 **10,608ms → 4ms**.
- Archive metadata served from the local mirror: `index.json` **1,237-3,289ms →
  34ms**, zero OneDrive round trips on load.
- Two-way sync with eTag freshness, pins ("always keep on this device"), and a
  real Settings page. Sidebar gained pins and a fixed tool strip.
- Light / dark / system theme.
- Photo viewer rebuilt: card-scoped, two columns, image strip, zoom and pan.
- Generate is a page like Settings; the drawer and the last of the floating
  furniture are gone. Save as PDF moved into the page heading, so it cannot be
  pressed while a trip is still loading.

See `HANDOFF.md` for how to run the project, the invariants that bite, and the
working practice this list was built with.

## Open issues


- [x] **Settings is slow and rebuilds on every button press.** Fixed 2026-09-08.
      Two separate causes, both measured before anything was changed:

      | | before | after |
      |---|---|---|
      | `GET /archive/status` | 668-1,835ms | **19-30ms** |
      | opening Settings (blocking, from the app origin) | ~1.0-1.8s, one sample 10.4s | **30-104ms** |
      | `GET /sync/status` (checked) | 687-1,365ms | unchanged, now off the critical path |

      `archive/status` was calling `loadIndex(token)`, which **downloads the
      whole 2.5MB `index.json` from OneDrive** to report five counts. The
      identical bytes were already on disk — `/archive/index` had been moved to
      the local mirror in the previous session and this endpoint was simply left
      behind. Reading locally parses in 8-11ms.

      The eTag comparison is genuinely a Graph round trip and cannot be made
      fast, so it was taken off the open path instead: `GET /sync/status?cached=1`
      replays the last computed state from `sync.json` (new `lastState` field)
      and marks it `stale`, the page paints that, and the checked answer replaces
      it in place when it lands. The label says "Checking OneDrive…" meanwhile
      rather than presenting an unverified state as current.

      The re-render was separate: every button called `showSettings()`, which
      tore down `#content` and repaid both round trips. Sections now register an
      updater and the page mutates in place.

      Two things measuring caught that guessing would not have:
      **the 4,727 `stat` calls were not the bottleneck** — 231-296ms serially and
      memoised anyway (parallelised to 43-53ms regardless, since it grows with
      the library); and `clearCache` never invalidated that 30s memo, so the
      storage figures would have redrawn stale — the same trap as the "0 files
      evicted" reading when 1,082 had gone. Now invalidated explicitly on both
      clear and evict.

      Verified in the browser by the owner after a signed-in pass. The numbers
      above are from the server and from `fetch` on the app's own origin, which
      also confirms CORS still passes.
- [x] **No way to re-index the library from the app.** Fixed 2026-09-08.
      `scan` was CLI-only: all its logic sat in a private `runMain()` reading
      `process.argv` and writing to the console, unlike `analyze` and
      `organize`, which were already split so the CLI and the job server run
      the same code. Extracted to `pipeline/src/jobs/scan.ts` (`runScan`), with
      `pipeline/src/scan.ts` reduced to the CLI front end; `POST /jobs/scan`
      runs it as a normal cancellable job.

      It lives in **Settings, not Generate** — it is maintenance, costs nothing
      and is the thing you run routinely, where Generate is for the passes that
      spend money. Three modes:

      | mode | range |
      |---|---|
      | Since the last scan | from the month of `lastScanAt`, open upper bound |
      | The whole library | unbounded |
      | A month range | what you pick |

      The mode is resolved **on the server** (`resolveRange`), so what
      "incremental" means lives next to the deletion rule it interacts with
      rather than in the page. Incremental starts at the month of the last scan
      rather than the one after it, because that month was still being added to
      when it ran. Never scanned degrades to a full run. `lastScanAt` is
      recorded only when a run actually completes — moving the baseline past a
      cancelled run's unlisted months would strand them forever.

      Verified: mode resolution against a throwaway `ARCHIVE_HOME` (all four
      cases); the route started, reported phases and cancelled cleanly with the
      archive's mtimes unchanged; the CLI still range-filters identically; and
      the range pickers toggle in both directions in the browser.

      One measurement lesson repeated: the first probe reported the
      never-scanned case wrongly, because `syncStore` memoises `sync.json` in a
      module-level `cached` and the cache-busting import only reloaded
      `scan.js`, not its static import. One process per case gave the right
      answer. **A number your own probe produced still needs its own check.**
- [x] **Closing Settings during a scan lost the progress.** Reported and fixed
      2026-09-08, caught by the owner running a whole-library scan. Reopening
      Settings showed an idle Scan button with the job still running
      underneath, and no way to see how far along it was.

      Cause: Settings is rebuilt on every open, so the `watchJob` subscription
      died with the old DOM. The Generate panel does not have this bug because
      it is deliberately constructed **once** and moved into the page — the
      note in `tripMode.ts` says exactly that, and the new Settings sections
      did not inherit it.

      Fixed by asking `/health` for the running job on open and reattaching to
      it (`followRunningJob`), rather than remembering an id locally — so it
      also picks up a job started from the CLI, from another tab, or before a
      page reload. Subscriptions are now tracked and dropped in
      `releaseSettings`, which they were not before: every visit leaked one.

      The Sync section had the identical defect and got the identical fix.

      Verified against the live scan: progress on first open (81 of 123),
      gone to Generate, back to Settings still ticking (74 → 76 of 123), with
      the button correctly disabled throughout.

- [ ] **A month emptied on OneDrive leaves a ghost month.** Deleting the *last*
      photo of a month folder (or the folder itself) leaves its records and its
      sidebar entry in place forever, with a photo count for photos that no
      longer exist.

      The deletion sweep in `jobs/scan.ts` only visits months present in
      `scannedByShard`, and that map is built from photos actually *found* — so
      a month with zero photos is never loaded, never swept and never
      rewritten. `index.months` is then rebuilt from a `summaries` map seeded
      with the existing `index.months`, so the stale entry survives the
      `photoCount > 0` filter.

      Deleting *some* photos from a month is handled correctly; this is only
      the emptied-month case. **Read from the code, not reproduced** —
      confirming it means deleting real photos from OneDrive. Judged unlikely
      enough to defer. The fix, when wanted: on an unbounded run, sweep every
      month in the index rather than only the touched ones.
- [ ] [App]Still asks for making an .env with no change in text. This should go into settings eventually
- [x] **Fast scrolling floods the thumbnail server.** Fixed 2026-09-07 by
      warming the cache ahead of the browser (`POST /thumb/warm`, called when a
      trip or month renders). Measured on the same fast scroll to the bottom:

      | | cold | warm |
      |---|---|---|
      | requests served | 169 | **883** |
      | p50 | 10,608ms | **4ms** |
      | p90 | 22,537ms | **7ms** |
      | max | 24,586ms | **11ms** |

      The diagnosis was worth measuring rather than guessing. The server was
      never the constraint — 30 requests fired straight at it finished in 2.2s
      (13.6/sec) with no queueing — it was the browser's ~6 connections per
      host on HTTP/1.1, with each cold request costing a ~2.7s Graph round trip
      behind it. Warming at a concurrency the browser cannot reach turns every
      request into a disk read, at which point six at a time is ~1,500 images
      per second and the cap stops mattering.
      **WebSocket and per-day chunking were both considered and rejected on
      that evidence**: they would optimise the disk-to-browser leg, which is
      4ms, and both cost `<img src>` — bytes would arrive in JS, needing blob
      URLs, their own lifecycle and their own cache, which is the IndexedDB
      situation this work just removed. HTTP/2 would be the principled fix for
      the connection cap but browsers require TLS, so localhost would need a
      self-signed certificate and its warnings.
- [x] **Full-resolution photos are never cached.** Fixed 2026-09-07: originals
      go through the same store under `data/thumbs/full/`, with their own 4GB
      budget so that a few hundred lightbox opens cannot evict tens of
      thousands of thumbnails. Measured: **1,160ms cold, 36ms warm** for a
      4.2MB original, against the HAR's 893ms Graph 302 plus a 682ms download
      on *every* open.
- [x] **Warming made page loads slower.** Reported and confirmed 2026-09-07.
      Background warming competes with the app's own Graph traffic — the
      `index.json` and month shards it must have before it can render at all.
      One sample each: 5,745ms of shard fetches with a previous warm run still
      going, against 4,021ms with the loop killed, one shard inflating from
      1,335ms to 3,313ms. Fixed by superseding: a new warm request cancels the
      previous run, so a reload replaces rather than adds, and concurrency
      dropped 8 -> 4 since this runs while the user is waiting.
      Also parallelised the month shards in `showTrip`, which were awaited one
      at a time. Confirmed structurally — the two shards now start on the same
      millisecond — though **not by wall clock**: Graph latency for a single
      file swung between 1,237ms and 3,289ms across runs, so single-sample
      timings here mean little.
- [x] **Archive metadata came from OneDrive on every load.** Fixed
      2026-09-07. `index.json` is **2.4MB** and strictly blocking — the months
      a trip spans are unknown until it lands — and every month shard came the
      same way. Meanwhile every pipeline run had been writing byte-identical
      copies to `data/`, sitting unused. Now served by `GET /archive/index` and
      `GET /archive/shard/:month`:

      | | over Graph | from the mirror |
      |---|---|---|
      | index.json | 1,237-3,289ms | **34ms** |
      | all metadata | 4,253-5,745ms | **918ms** |
      | OneDrive round trips | 3 | **0** |

      Safe because the writer is singular: the server is the only thing that
      writes the archive and the phone is read-only by design, so the mirror
      can only go stale if the pipeline ran on another machine — where a `scan`
      restores it. The app falls back to Graph when no server answers, which is
      the phone's normal path.
- [ ] The mirror is trusted without checking OneDrive at all. Worth a
      background revalidation (compare `generatedAt`, refetch if OneDrive is
      newer) once a second machine is ever in play.
- [ ] Warming still fires for the whole view. For a 4,998-photo month that is a
      lot of Graph traffic triggered by opening a tab. Warm the first few days
      and extend on scroll.

- [ ] **Tell the summarizer things, and correct what it wrote.** Two related
      abilities, both missing:
      (a) *before* — a free-text box on the Day summaries job, the way trips
      already accept `notes`, so the owner can say "this is the the railway museum"
      or "the morning was a write-off" and have it reach the model;
      (b) *after* — regenerate a single day or stop with an added instruction,
      and edit the resulting title, summary or card text **by hand**, with the
      edit surviving the next `organize` run.
      (b) is the one with teeth: `segmentsAreCurrent()` decides when to
      re-summarize, so a hand-edited day needs a marker that means "leave this
      alone", or the next run silently discards the correction. Any direct-edit
      feature also needs somewhere to write to — the app is a pure reader today
      and the server is the only writer.

- [ ] **Photo captions are written with no context at all.** Confirmed at the
      source: `CaptionPhotoInput` is `{ imageBase64, mediaType }` and nothing
      else, so the model sees one image and a static prompt. It cannot know a
      blue carriage is in the the railway museum; the *day* summarizer can, because
      it sees every caption, the place and the placard OCR together. The photo
      record already has `takenAt` and a geocoded `place` — passing those plus
      the stop's other captions costs ~20 input tokens a photo.
      Two cautions: context invites the model to assert things it cannot see
      (the same worry `placeFromMetadataOnly` already encodes), so the prompt
      must frame it as a hint for naming, not licence; and **the fix only helps
      photos analyzed afterwards**, so the benefit needs a paid re-run over the
      4,181 already captioned.
      **Owner's decision: happy to redo, but not yet — small-scale test
      first.** So: implement, run over one stop (~20 photos), compare captions
      before and after by hand, and only then decide on the full re-run. Do it
      in the same pass as the Chinese rerun below, not separately — otherwise
      the library gets paid for twice.
- [ ] **Day summaries are written in isolation.** `SummarizeDayInput` carries
      the date, place and stops, and nothing about the days either side or the
      trip they belong to — so day N cannot know N-1 ended in a city or that
      N+1 is a city. Proposal (user's): two modes. `organize` keeps writing
      standalone summaries for ordinary days, and the **trip** job re-summarizes
      the days in its range with neighbouring context before writing the
      narrative. ~18 extra calls for this trip.
      **The context that matters most is the owner's own**, not just the
      neighbouring days: `notes` and `documents` — the pasted itinerary or
      trip-planning conversation — currently reach `summarizeTrip` and nothing
      else. The day summarizer is guessing at things the owner already wrote
      down. Passing those down into per-day summarization is the substance of
      this change; neighbouring days are the smaller half. Needs a marker on `DayRecord`
      for which mode produced it, and `segmentsAreCurrent()` extended so
      switching modes counts as stale.
- [x] **Thumbnails no longer depend on browser storage.** Fixed 2026-09-07.
      The IndexedDB cache was written when there was no backend and the phone
      was the target; with a local server it was the wrong place — per browser
      (which is why Floorp refetched everything), erased when a privacy-minded
      browser clears site data, and degrading to network-only *in silence*.
      `pipeline/src/thumbStore.ts` now keeps a disk cache under
      `data/thumbs/<size>/`, served by `GET /thumb/:size/:itemId`. Measured:
      cold 2,726ms through Graph, warm **24ms** off disk. The URL is keyed on
      the item id and never changes, so it is marked immutable and the
      browser's own HTTP cache works on top — something the short-lived CDN
      links could never allow, and the original reason a cache of our own
      existed at all.
      The seam is `app/src/photoSource.ts`, a `ThumbnailSource` rather than an
      if/else, because **the phone should eventually read the camera folder off
      the device** instead of fetching photographs back out of OneDrive that
      are already sitting on it. Three implementations: local server (done),
      Graph + IndexedDB (the fallback, and the phone today), device filesystem
      (not built). Verified in the desktop app: all loaded thumbnails came from
      `127.0.0.1:4319`, no blob URLs, no CDN.
- [x] Cache status in Settings — done. With no server the page says so plainly
      rather than showing dead controls, which is the phone's normal state.


- [ ] **Koblenz is missing from the trip map.** It is in the trip's `places`
      list but produces no city marker. Likely caught by the new
      `MAX_PLACE_SPAN_KM` rule (a Rhine-valley train leg) or merged into
      Boppard. Not yet investigated.
- [x] **"Netherlands gets extra territory"** — basemap land/sea boundary looks
      wrong around Zeeland/Zuid-Holland; markers sit in water. Not investigated.
      Suspect the `ne_50m_land` outer-ring-only extraction, or the lakes layer.
	  User: Issue is Hoek van Holland is in the middle of the sea, resolved
- [ ] **the city airport never appears on the map.** The photos are correct and now
      trusted (18 of 21 UK fixes), geocoded to the capital region / City of the capital.
      They land in a single **transit** segment (13:42–21:58 "Flight to the capital
      City") and `citiesOf` only builds markers from `place` segments. Needs a
      decision, not a fix: either transit segments contribute markers (putting
      airports/stations on the map generally), or `detectStops` splits a transit
      block when it crosses a large distance.
- [ ] **Label suppression is aggressive** — 7 of 23 shown at the fitted view.
      Honest (they don't fit) and zooming reveals more, but the Randstad stays
      anonymous. Leader lines or offset placement would beat dropping.
- [ ] **Captions only appear after a page refresh.** `shardCache` in
      `app/src/archiveData.ts` caches each month's shard per session and never
      invalidates, so a finished job updates OneDrive but not the open tab. The
      job panel already re-renders on completion; it needs to clear that cache.
- [x] **Photos in cards are fixed height — poor in portrait.** Fixed
      2026-09-06. The strip now takes `aspect-ratio: calc(var(--img-count) *
      var(--card-cell))`, so height follows width and each *cell* keeps a
      photograph's shape however many photos share the card. Measured at 554px
      wide: cell ratios were 0.46-3.1 depending on width and count (three
      landscape shots rendered as vertical slivers); now a stable 1.49-1.50 for
      full/half and 1.76-1.78 for normal, at every count. Desktop geometry is
      unchanged by design — a two-photo full card computes to 395px against the
      380px it was hardcoded at.
- [x] **Burger menu** — done 2026-09-07. Generate, Save as PDF and Settings are
      rows in the sidebar now, always visible; the floating burger and the
      230px settings popup are gone.
- [ ] Zoom-out reaches the whole world; cap at continental?
- Mobile view:
  - [x] **Portrait layout cannot scroll.** Fixed 2026-09-06: `#main-column`
        had no `min-height: 0`, so once the <=700px rule turned `#app` into a
        column it could not shrink below its content, overflowed a `body` with
        `overflow: hidden`, and nothing scrolled. One line.
  - [ ] Design needs rethinking; a Figma would help.

## Todo

- [x] **Make this an app.** Electron shell in `desktop/`. `npm run desktop`.
- [x] **Light/dark mode toggle.** Done 2026-09-07, in Settings > Appearance.
      Three states, not two: Light, Dark and System, where System is the
      *absence* of `data-theme` so the media query keeps following the OS.
      Applied by an inline script in `index.html` before the stylesheet paints,
      or a reader who chose dark on a light system watches the page render
      light and flip.
- [ ] **i18n — Chinese and English.** UI strings are the easy part and dates
      are already locale-aware (`toLocaleDateString(undefined, ...)`). The hard
      part is that **the archive's prose is model output stored in one
      language**: captions, place and day summaries, the trip narrative, and
      `documentTranslation` (which currently renders foreign placards *into
      English*). Switching the UI does not translate any of it. Three options,
      none free:
      (a) generate both languages at analyze/organize time — doubles output
      tokens and doubles the schema's prose fields;
      (b) store one and translate on demand — cheap to store, a per-view cost,
      and the translation is not stable between viewings;
      (c) generate in the chosen language and regenerate to switch — cheapest,
      but switching language means paying for the archive again.
      Any of them turns the prose fields into per-locale maps, so it is a
      schema break (v13 -> v14).
      **Owner's sequencing: do this after captions and summarizers, and make
      the large-scale rerun produce Chinese.** That makes the storage shape
      decision blocking rather than optional — it has to be settled before the
      rerun, because the rerun is the thing that would otherwise be paid for
      twice. Note `documentTranslation` currently renders foreign placards
      *into English* specifically; under a Chinese UI that target changes too.
- [ ] Trip management — rename, delete.
- [x] **Print view / Save as PDF.** Menu entry on any view with cards. See
      `app/src/print.ts` and the `@media print` block at the end of
      `app/src/style.css`.
- [ ] **Gemini Batch API** — roughly half price, async, up to 24h. Not worth it
      for a 35-minute interactive run; worth building if backfilling the other
      ~14,000 photos (£20 vs £40 overnight).

## Sharing / export (2026-09-05)

`Save as PDF` in the burger menu. Print-to-PDF was chosen because it is the one
format this archive can emit that the *recipient* can open: Chrome rasterises
every thumbnail into the file, so it needs no Microsoft account, no token and
no network. Nothing in it points back at OneDrive.

**What is exported is deliberately less than what is on screen**, and the rule
is enforced in the stylesheet, not in script, so expanding a section by hand
before printing still cannot put it in the file:

- Cards only. The `.stop-more` grids and `.transit` strips are always hidden.
  Measured reason: of the trip's 125 screenshots, **114 live in exactly those
  two collapsed regions** and have never been reviewed. The 11 that reach cards
  are all travel apps (DB Navigator, Eurail, rail maps) — checked by hand.
- A placard's English rendering prints; the verbatim OCR behind `.card-source`
  does not.
- Zero photos in the trip carry a `sensitive` flag (all 4,064 checked).

**Confirmed end to end on 2026-09-05**: produced a clean 95 MB PDF of the whole
the train 1 trip. Verified by the owner; the file itself has not been opened
here.

Measured on the the train 1 trip:

| | |
|---|---|
| images exported / in the page | **1,292 of 3,659** |
| already in the local thumb cache | **1,292 of 1,292** — no Graph calls |
| prepare pass (hydrate + decode) | **19.7s**, warm cache |
| Chrome print render | **45-60s** before, **20s** after |
| total wall clock | **~65-80s** before, **~53s** after |
| output file | **95 MB** before, **47.47 MB** after |
| image payload in the page | 92.5 MB JPEG, avg 73 KB |
| pages at A4 | **214** (725 cards over 18 days) |

### Rasterise-at-print-size — done, needs one hand-test

The 95MB came from embedding every card image at Graph's `large` (800px box)
while the slot it prints into is 46-95mm. `app/src/print.ts` now re-renders each
image to its actual print slot at **200 dpi**, applying the same `object-fit:
cover` crop the page does (pixels outside the crop were being embedded at full
resolution despite never being visible), then re-encodes at **JPEG q0.70**.

Quality chosen by measurement against the 50MB cap, over all 1,292 images:

| quality | export |
|---|---|
| 0.82 | 54.3 MB — over |
| 0.75 | 47.0 MB — 6% margin, too close |
| **0.70** | **43.6 MB** — 13% margin |
| 0.62 | 38.2 MB |

Measured result of the shipped path: **1,187 images re-encoded to 36.8 MB**,
105 left untouched, ~45 MB of images against 92.5 MB before. Prepare +
sizing ran **33.2s**.

**Confirmed 2026-09-06: 47.47 MB, Chrome render 20s.** Under AI Studio's 50MB
cap. Against the 95 MB / 45-60s starting point: **half the size, a third of the
render time**, no visible quality cost.

- [ ] **The margin is thinner than it looks — 5%, not the 13% q0.70 was chosen
      for.** Projected ~45-46 MB from the images alone; the finished PDF came in
      at 47.47 MB, so page structure costs ~5% on top, not the ~3% assumed. A
      slightly longer trip, or a few more `full` cards, will breach 50MB. If it
      does, q0.62 measured 38.2 MB and is the next stop.

Two findings worth keeping:

- **A downscale can make a JPEG bigger.** Graph's thumbnails are already well
  compressed, so re-encoding at q0.70 made **41% of `full` card images larger**
  — they only shrink 800px -> 669px, where `half`/`normal` drop to ~409px and
  shrink reliably. `rasterise()` now keeps whichever is smaller and returns
  null otherwise. Worth 2.7MB, and it makes the pass safe by construction
  rather than by tuning.
- **`canvas.toBlob` is timer-throttled in a background tab.** Measured 1008ms
  per image hidden vs 6.3ms for synchronous `toDataURL` — an export started and
  then left for another tab would have taken 21 minutes instead of 33 seconds.
  The encode is now synchronous, and the progress yield is skipped entirely when
  `document.hidden` (nothing to repaint, and the yield is throttled too).
  *This is also why my first timing of the pass was wrong:* I measured it in a
  backgrounded tab and read the throttling as a real cost.

- [ ] 45MB clears AI Studio (50MB) but not mail (25MB). An export scope choice
      is still the lever for that.
- [ ] For feeding Gemini specifically, a **text export** — narrative, day and
      stop summaries, card titles/descriptions, OCR — is ~19,000 words and a
      few hundred KB. Better than a PDF for questions about the trip; worse if
      the model needs to see the photographs. Probably worth having both.
- [ ] `window.print()` freezes the renderer while the dialog is open, so the
      tab cannot be driven by automation during it. Test print by hand.

## Desktop shell (2026-09-06)

`npm run desktop`. One window; no terminals. `desktop/src/main.ts` serves
`app/dist` on **17923**, starts (or adopts) `pipeline serve` on 4319, opens the
window, and shuts down what it started. **Nothing in `app/src` changed**, so
`dist/` still feeds a later Capacitor build.

**The shell has its own port** rather than sharing 4173 with `run-preview.ps1`,
so the desktop app and a dev preview can run at once. Changing it means two
things move together: the Azure SPA redirect URI (MSAL derives it from
`window.location.origin`) and `ALLOWED_ORIGINS` in `pipeline/src/serve.ts` —
miss the second and the window loads and the archive renders, but every job
request fails CORS and generation just looks unavailable. Registered as
`http://localhost:17923/auth`.

Electron over WebView2 despite WebView2 Runtime v153 and .NET 10 SDK both being
installed and ~20x smaller: the job server is Node and must run either way.
Electron bundles Node (v22.22.0, matching the project's 22.18), so
`ELECTRON_RUN_AS_NODE` spawns it with no dependency on fnm's `node` being on
`PATH` — which a GUI-launched app has never set up. Revisit if memory or start
time becomes a real complaint.

Verified: `/auth/` serves the bridge and `/auth` serves the app (matching Vite,
and load-bearing for the popup handoff); sign-in completes and the archive
renders; an existing job server is adopted, not duplicated, and is left running
on quit; a server the shell started dies with it; no stale lock; and a job
started from the app is refused while a CLI writer holds the archive lock —
`"Another archive writer is running: analyze (CLI) ..."`.

- [x] **Packaged.** `npm run package` builds a 90MB per-user NSIS installer
      (`desktop/release/Photo Archive Setup 0.1.0.exe`), installing to
      %LOCALAPPDATA%\Programs with Start-menu and desktop shortcuts, no admin
      prompt. Icon is generated by `desktop/scripts/make-icon.mjs` — a PNG
      written with zlib and no image dependency.
- [ ] No code signing and no auto-update. Windows will show a SmartScreen
      warning on first run of an unsigned installer.
- [ ] The static server reuses whatever already owns its port, but that path
      was only reasoned about, not exercised. Much less likely to matter now
      that the shell has a dedicated port; the single-instance lock covers the
      realistic case.
- [ ] Renderer shows Electron's "insecure resources / no CSP" warnings. Benign
      over loopback HTTP, and they disappear once packaged, but a CSP would be
      better than living with them.

### Packaging (2026-09-06)

Three things had to change before an installed build could work.

**Paths split into two kinds** (`pipeline/src/paths.ts`). Writable per-user
state — `.env`, `token-cache.json`, `redaction-terms.json`, all of `data/` —
resolves from `ARCHIVE_HOME`, which the shell sets to its userData directory;
read-only config that ships with the build (`screenshot-apps.json`) resolves
from the module. Previously these were interleaved by accident, some relative
to `process.cwd()` and some to `import.meta.url`, so installed the token cache
would have been written inside a read-only asar and sign-in would have failed.
A checkout is unaffected: with `ARCHIVE_HOME` unset everything falls back to
`pipeline/`, exactly where it already was. Side benefit — the server now runs
from any working directory, verified from `C:\`.

**The pipeline is bundled, not copied** (`desktop/scripts/bundle-pipeline.mjs`).
npm workspaces hoist dependencies to the root, so there is no
`pipeline/node_modules` to ship and copying the root tree would drag in
Electron and Vite. esbuild produces one 2.8MB ESM file. It must be ESM: under
CJS esbuild leaves `import.meta.url` empty and `paths.ts` would look for the
allowlist in the wrong directory. The output path matters for the same
reason — the bundle sits one level below `screenshot-apps.json`, mirroring
`dist/` in a checkout.

**Non-secret config is baked at package time.** `AZURE_CLIENT_ID` is
*required*, so without it the job server refused to start at all and
generation did not fail visibly — it was simply absent. Eight settings are
compiled in from the building machine's `.env` via an esbuild `define`, as a
**fallback** to `process.env` so a runtime `.env` still overrides. An
allowlist, not a blocklist, so a key added later cannot be swept in.
Verified: the packaged app starts healthy with no `.env` present at all.

- Note that `GEMINI_API_KEY` is a **User environment variable** on this
  machine, not in `.env` — which is why generation works in the packaged app
  (Electron passes `process.env` to the child). A machine without that
  variable needs the key in `.env`.
- The installer carries the baked folder paths and geocode email, so treat
  the .exe as personal. Nothing personal is committed to the repository.

### Debugging Electron without a browser extension

The window loads the same `http://localhost:4173` as a browser tab, so **UI
work is still debugged in Chrome exactly as before**. For the renderer inside
Electron, launch with `--remote-debugging-port=9222`; `127.0.0.1:9222/json`
lists targets and a WebSocket to one drives CDP. Node 22 has a global
`WebSocket`, so the client is ~40 lines and needs no dependencies. That is how
the sign-in failure below was found.

## Sync and Settings (2026-09-07)

One local library that syncs, replacing six caches that each answered "is this
fresh?" differently. `npm run desktop` or the preview; Settings is a sidebar row.

- **Freshness is an eTag.** `GET /sync/status` asks Graph for `index.json`'s
  eTag without downloading it. The same question via `/content` is 2.4MB and
  measured 1,237-3,289ms.
- **Two-way.** clean+moved pulls, dirty+unchanged pushes, dirty+moved is a
  conflict that stops and asks. The resolver is two buttons named for what they
  do — *Upload mine (overwrites OneDrive)* and *Replace mine (discards local
  changes)* — because "keep local" never says whether the other copy survives.
- **Pins are OneDrive's "always keep on this device".** Cloud/filled markers in
  the sidebar; pinned items are fetched on sync and never evicted.
- **Warming only on dwell.** 2s on a view before the bounded 200-photo
  look-ahead fires, cancelled on leaving. Measured: a 700ms glance costs
  **0** requests; staying costs 1.

Verified: launch metadata done at **644ms** with **0** Graph calls; pins
round-trip and survive a 95MB cap against 309MB of cache; `behind` detected from
a mismatched eTag; a pull fetched 62 files and returned to `in-sync`.

Three bugs found by testing, not reasoning:

- **Two routes could never share a path.** The dispatcher 405'd on the first
  pattern match instead of continuing, so `GET /sync/pins` shadowed the POST.
- **Eviction stopped applying entirely.** Filtering pinned files out *before*
  summing meant 386MB of cache measured as 70MB, so the cap never triggered.
  Pinned bytes now count toward the budget; only unpinned ones are deleted.
- **A glance still warmed.** The dwell timer was cancelled by `showTrip` and
  `showMonth` but not by navigating to Settings, so clicking away still fired
  it two seconds later. Every exit cancels now.

Still to build. Light/dark, i18n and trip management are tracked under **Todo**
above rather than repeated here; the Settings page is simply where they land.

- [ ] The periodic sync timer — the setting is stored and honoured by the
      server, but nothing in the UI sets the interval yet.
- [ ] Pin "include originals" — the API takes it, the UI never sets it.

## Photo viewer (2026-09-07)

Opened from a **card**, not a lone image. A card is the unit the archive
curates — one subject, its description, the placard that explains it and one to
three photographs — and opening a single image threw all of that away at the
moment someone was looking closest.

Layout is a row: photograph left at full height, two panels right. What the
*card* is about above, what *this photograph* is below, and the card's other
images in a strip beneath. Arrow keys and the strip move between them; zoom is
wheel or the controls, with drag to pan.

**Ordinary photographs still work as before** — album months, collapsed "more
photos" grids and transit strips have no card, so `openPhoto` hides the card
section and the strip entirely rather than showing an empty one.

Verified: card panel with placard text, per-image panel switching, strip
selection, arrows wrapping 2-1-2-0, zoom 100/150/fit, panning, and the
no-card path.

- [ ] The viewer is desktop-shaped. Below 900px it stacks, but that has not been
      exercised on a real phone.User: Tested, layout does not scroll.
- [ ] Zoom is centre-origin, so zooming does not follow the cursor.

Zoom resizes the photograph rather than scaling a layer. `transform: scale()`
promotes it to a composited layer that is rasterised once and GPU-stretched, and
those tile boundaries showed as thin lines across the picture at some levels.
`will-change: transform` — the usual advice — made that worse, since it
guarantees the very layer at fault. Setting a real width makes the browser
resample from the source: no seams at 152% or 506%, and sharper.

## Correctness / safety backlog

- [x] **`analyze` (CLI) and `serve` can run at once and clobber the same
      shard.** Fixed 2026-09-06 by `pipeline/src/lock.ts` — a pid lock at
      `data/.archive-lock`, held per write by all five CLI entry points, every
      server job and sync. See "Desktop shell" for the details.
- [ ] **`trip` proceeds when most days have no summary** — warns in a scrolling
      log, then writes a full narrative anyway. Should refuse without an
      explicit override. A paid-for result that reads as authoritative but is
      ungrounded is the worst failure mode here.
- [ ] Guard in `analysisTargets()` (pipeline/src/duplicates.ts): if a duplicate
      group's representative is deleted at source, survivors keep a dead
      `duplicateGroupId` and are never analyzed. Self-heals on the next scan.
- [ ] `dedupe` command — delete duplicate files from OneDrive. sha256 only,
      dry-run default, recycle bin. **Needs explicit approval and a shown dry
      run.** Now worth more: real duplicate count is 1,357, not 324.
- [ ] Re-run analyze for the 2 photos that failed `503 UNAVAILABLE` on
      2026-09-05. Not lost — `analyzedAt` is still null — and the retry added
      afterwards should prevent a repeat.

## Repository (2026-09-06)

`git init`, private repo. Nothing sensitive is tracked — verified with
`git check-ignore` rather than by reading the ignore file.

Ignored: `.env` / `.env.*` (keeping `.env.example`), `token-cache.json` (a live
OneDrive refresh token — that is the account, not just the archive), `data/`
(~22MB; every record carries a filename, OneDrive path, GPS fix, caption and
transcript, so it is a searchable location history), `redaction-terms.json`
(**the owner's name in plain text — the whole point of the file is that no
pattern can find these strings**), and `*.pdf` so an exported trip cannot be
committed by accident.

- `pipeline/data/trips.json` — **moved** from `pipeline/trips.json` on
  2026-09-06. It is travel history (trip names and exact date ranges), so it
  belongs with the archive data, not beside the source. `tripDefs.ts` now owns
  the path and exports it; `jobs/trip.ts` had kept a second copy of the same
  filename, which is how a reader and a writer drift apart. A root-level file
  is migrated into `data/` automatically on first read.
- `pipeline/screenshot-apps.json` stays tracked: it is curated policy with a
  long explanatory comment, and belongs in the repo. It does reveal which
  travel apps are installed — acceptable in a private repo, worth revisiting if
  it ever goes public.
- **`TODO.md` is why the repo is private.** It is a travel history in prose —
  exact dates, the full route, photo counts. Nothing secret line by line, but
  on an account tied to a real name it publishes where the owner was and when.
  Making it public means moving the trip specifics into a local-only file
  first.

## Operational notes

- **`serve` does not pick up a rebuilt pipeline.** Restart it after any schema
  or code change or it fails with a schema-version mismatch. Worth printing the
  schema version at startup.
- **`ANALYZE_CONCURRENCY`** (env, default 4) is read at server start, so
  changing it needs a restart. 4 measured ~37 photos/min; the 2,991-photo run
  averaged ~85/min. The ceiling has not been established — OneDrive throttling
  is the expected limit, not Gemini.
- **Run order is Analyze → Day summaries → Trip.** `trip` reads only day
  summaries, never photos. Skipping the middle step is why an early trip
  narrative covered 18 days with data for 4.
- Empty "Limit to a date" in Day summaries means *consider* all days, not
  rewrite all days. Days with no analyzed photos are skipped entirely.

## Recently fixed (2026-09-05)

- `gpsSuspect` rewritten from statistical to physical. It flagged anything
  >100km from the day's median, so a travel day's minority end was discarded —
  54 photos on 09-02 alone, including every the capital fix. Now flags only a fix
  unreachable at >1200km/h from **both** temporal neighbours. Trip-wide: 26
  suspects across 18 days.
- The geocode sweep was **unreachable**: early returns in both `runAnalyze` and
  the CLI skipped it whenever a month had nothing left to caption — exactly when
  a previously-suspect photo needs it. 50 places filled in for 09-02.
- **Journeys were becoming cities.** A long train with sparse indoor GPS looks
  stationary to `detectStops`, became a "place", and was plotted at the journey
  midpoint under a passed-through town's name — "a city to a city by ICE"
  appeared as *a city*, 156km off. Now rejected by a 30km span limit plus a
  40% place-name agreement threshold. Worst city error is now **2km**.
- Duplicate detection: the copy-suffix regex made its separator optional, so it
  mangled un-suffixed originals and only matched when *both* files had a suffix.
  324 → **1,357** redundant copies library-wide.
- Graph 429/401 backoff and token refresh; Gemini 429/5xx retry; shard
  checkpoints every 150 photos.
- Trip map: overlap-safe labels, country names no longer drawn as cities, coarse
  points merged into nearby real cities, double-backs drawn, expand overlay.

## Notes for future logging

Traps that cost real time here, kept so they are not rediscovered:

- **Measure before asserting.** Estimates on this project were wrong by an order
  of magnitude, and several confident diagnoses were wrong: Ollama crashes read
  as OOM twice; prompt field order blamed for a model failure (an A/B refuted
  it); a layout enum blamed on the model when the schema allowed one value per
  day; duplicates quoted at 1.9% when the detector's own regex was broken.
- **A number produced by your own code is not a measurement** until checked
  against an independent signal.
- **`display: flex` in author CSS beats `[hidden]`.** Bitten three times —
  `.lightbox`, `.signin-banner`, `.job-form`. Audit for rules setting a
  non-`none` display on anything toggled via the `hidden` property.
- **Natural Earth `scalerank` 0 is the most prominent tier**, not a missing
  value. `?? 99`, never `|| 99`.
- **Do not diagnose an animation from a screenshot.**
- **Staleness checks must compare what the model was actually shown**, and must
  be updated whenever a stored shape gains a required field (`segmentsAreCurrent`).
- **Do not invent identity.** Renaming a coarse point after the nearest gazetteer
  town produced plausible, wrong cities ("The Hague" beside "Den Haag"). Merge
  into something known, or leave it unnamed.
- **A larger stated maximum raises output even when it is never reached.**
  Raising the card cap 20 → 30 took one stop from 10 cards to 28; nothing had
  ever hit 20.

- **MSAL opens `about:blank` first.** It creates the popup synchronously so the
  click's user activation is not spent building the authorize URL, then points
  that window at the login origin. An Electron `setWindowOpenHandler` that only
  allows the login origin therefore sends `about:blank` to `shell.openExternal`
  — Windows asks which app should open it, MSAL gets a null window, and it
  surfaces as `popup_window_error`, which looks like a popup blocker.
- **A synthetic click is not a user gesture for the whole promise chain.**
  Driving sign-in through CDP reproduced a *different* failure than the real
  click: `signIn()` awaits `ensureInitialized()` before `loginPopup()`, and that
  await spent the activation, so `window.open` returned null for reasons
  unrelated to the actual bug. Two different causes, one error code — check
  which one you are looking at before fixing anything.
- **The trailing slash in the MSAL redirect URI is Vite's requirement, not
  Azure's.** `msalConfig.ts` says the registration must match "including the
  trailing slash", but the sentence that follows explains the real reason:
  Vite's dev/preview server resolves `auth/index.html` only for the exact path
  `/auth/`, and `/auth` falls through to the SPA fallback. Azure itself
  tolerates the difference — every redirect URI in this app registration is
  registered without the slash and all of them work. Read the whole comment
  before quoting half of it as a constraint.

