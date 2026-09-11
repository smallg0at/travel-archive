# TODO

State as of **2026-09-09**. The **the train 1** trip (2026-08-16 → 09-02, 18
days) is fully analyzed: 4,181 photos captioned, 28 days summarized, trip
narrative written, map rendering. That run cost **under £8**.

**30 open, 39 done.** The list grows because each session surfaces defects that
were previously invisible — most of what has been closed was found by measuring
rather than by planning. The cluster with real user-visible value still in it is
captions and summarizers, and it has now been deferred three times.

Open items are listed first in each section; fixes are kept below them
(collapsed under "Resolved") for the measurement detail they record — see
`HANDOFF.md` for how to run the project, the invariants that bite, and the
working practice this list was built with.

## Open issues

- [x] **UI style refresh — the whole app, not a patch.** Raised 2026-09-09,
      done the same day on `design/material-you-refresh` (merged to `main`
      at `04c71c6`, 19 commits). Landed on Fluent 2, after Material You was
      evaluated and rejected and a Windows Explorer screenshot from the owner
      set the direction.

      What it fixed from the original brief: real Fluent 2 color/type/radius/
      shadow tokens replacing the six-token vocabulary (`--surface-hover` and
      `--surface-selected` added — the recurring "hover/selection reads as a
      hole in dark mode" bug was always `--bg` being darker than `--bg-muted`
      with no "raised" token to reach for instead); every count now goes
      through `toLocaleString()`; row height and padding unified across
      headers and leaves.

      The column-alignment problem went through four iterations before it
      landed, each one a real correction, not a taste call:
      1. Marker/dot columns removed for a bare accent bar + bold text — fixed
         a literal gap between the selection bar and the label the owner
         pointed at directly ("MIND THE GAP...").
      2. Icons added to every row (year, month, trip) for Fluent-style
         icon-anchoring — overcorrected into an icon repeated ~12 times down
         the month list, flagged as pure noise.
      3. Icons stripped from every row, kept only on `Trips` — created a new
         problem: `Trips` and a year header are peer group headings that then
         started their label text at two different x positions.
      4. Landed state: **every group header** (`Trips`, each year) carries a
         leading icon (location pin / calendar) and shares one label axis;
         child rows (months, trips) carry no icon and are indented via padding
         (8px row padding + 16px icon + 10px gap = 34px) to land on that same
         axis. Verified numerically in Chrome against the real signed-in
         session — header and leaf labels agree to the pixel.

      **A working-practice lesson, not just a UI one**: several rounds here
      were spent proving a claim geometrically correct (chevron centering to
      0.5px, marker-column math against the TreeView spec) while the actual
      defect was one level up — the wrong component archetype (TreeView
      metaphor vs. Fluent's flatter NavDrawer), which no amount of measuring
      the thing in front of me would have caught. Precise measurement answers
      "is this correct against a spec"; it does not substitute for looking at
      the screen and asking whether the layout itself is the right shape.

      **Not done, on purpose**: the mobile horizontal strip is unchanged and
      still tracked separately below — it needs its own redesign, not a
      Fluent pass on top of a layout due to be replaced.

- [x] **Content in a second language — 简体中文 beside the English.** Raised by
      the owner 2026-09-10: two languages' worth of content stored together, and
      a text-only way to move existing content across by translation, quality
      not expected to be great. Built the same day to an approved plan:

      1. **Storage** — sidecars `i18n/zh-Hans/index.json` and
         `i18n/zh-Hans/photos/<yyyy-mm>.json`, keyed by `textKey()` of the
         original (HANDOFF, "Shape"). No schema bump; `index.json` and the
         shards are never written. Settings → Content language, per device;
         every display site goes through `loc()`, and anything untranslated
         shows as written.
      2. **Machine translation** — Generate → Translate (plan, then run),
         `jobs/translate.ts`. Text only, on Gemini `gemini-3.7-flash`, the
         configured provider (there is no Anthropic key); `TRANSLATE_MODEL`
         overrides. Captions stay English and are translated.
      3. **Native day and trip text** — organize and trip ask for an `_alt`
         twin of every text field in the same call and store it
         `via: "native"`, which a translation never overwrites.
      4. **Per-language edits** — an edit made while reading Chinese goes to
         the sidecar's `owner`, anchored like `StopEdit`; emptying a field
         hands it back to the translation.

      | | |
      |---|---|
      | whole archive, free plan | 6,557 texts, 608,847 chars |
      | September 2026, paid run | 948 texts, 16 calls, 51s, 36,498 in / 47,497 out tokens |
      | August captions, cancelled | stopped at 480 of 3,758; all 480 kept |
      | archive files after both runs and an edit cycle | byte-identical (sha256) |

      The first token estimate was 35% low on input (each item carries its key
      and kind as JSON); the constants are recalibrated from that run.

      Verified in the preview: a town fully Chinese — stop titles 9/9, card
      descriptions 48/48, day summaries 2/2, narrative, places, nav, tab title
      and the viewer; the train mixed exactly as translated (Sep 1–2 Chinese,
      the August days English); a Chinese stop edit survives a reload and
      clears back to the translation; English untouched throughout.

      **Not verified**: native generation against the real model — it costs an
      organize or trip call, the owner's to spend; sync pulling the sidecars on
      a `behind` machine; whether a stop title redraws at once after a Chinese
      save (read 4s after Save it still showed the old title — a save is 1.8s
      of index download plus the sidecar round trip, so probably still saving;
      after a reload it was right). One of a town's 48 card titles stayed
      English; not looked at.

      **Still to translate**: 5,129 texts — 3,278 August captions, 32 from
      2025-04, 1,819 day and trip texts outside September. Generate →
      Translate → Estimate first.

- [x] **A page refresh lost the reader's place — always back to the newest
      trip.** Raised by the owner 2026-09-10. `captureView` only kept the view
      across a re-render inside the running page; a browser refresh starts the
      module from nothing and fell through to the default.

      Fixed in `album.ts`: the view goes in the URL hash (`#month/2026-09`,
      `#trip/<id>`), written with `replaceState` on every nav click; the scroll
      offset goes in sessionStorage keyed by that hash, saved on scroll
      (debounced) and again on `pagehide`. A hash naming something that no
      longer exists falls back to the default.

      Restoring the offset was not enough on its own. Two things arrived
      *above* it after it was set, and scroll anchoring pushed the reader down
      by their height each time. Found by measuring which day sat at the top
      of the viewport before and after a refresh, the train left at 2000:

      | | restored at |
      |---|---|
      | first attempt | **2440** |
      | the trip map's space held while its import loads (`.trip-map-slot:empty`, 404px) | **2036** |
      | restore moved after the heading's pin and Save-as-PDF controls, which wrap it (36px) | **2001** |

      September 2026, left at 3000, restores at 3003.

      A testing note that nearly read as a bug: the preview pane is hidden,
      and hidden pages get **no scroll events at all** (0 delivered, rAF never
      fired), so the debounced save never ran there. `pagehide` fires on every
      unload regardless — it is why the test reflects real use, and it also
      covers a refresh pressed within the 250ms debounce.

      **Then, the same day, the two things left out**, plus page titles:

      - **Back and Forward move between views.** A reader's click pushes an
        entry; reopening a view — on load, after a re-render, on Back itself —
        replaces instead, so a refresh adds nothing. Every open goes through
        one `enter(hash)`, which saves the outgoing view's offset under *its*
        hash first: at `popstate` the URL already names the view being
        returned to, and saving under `location.hash` would have overwritten
        the offset about to be restored. Offsets are now a map per view.
      - **`#settings` and `#generate` are views too.** Generate only exists
        once a backend has answered and its panel is built, which on a refresh
        happens after the album renders — so it waits on
        `whenGenerationReady()` from `tripMode.ts`, and falls back to the
        default with no backend. This also keeps a reader on Generate when a
        finished job re-renders the album, where it used to jump to a trip.
      - **The tab title names the page** — "the train 1 · Photo Archive",
        "September 2026 · …", "Settings · …" — so the Back menu is readable.

      Verified in the preview: fresh load adds no entry; each click one; Back
      to the train at 2001 (left at 2000) and Forward to September at 3003
      (left at 3000); refresh on Settings and on Generate stays there; Back
      from Generate reaches Settings; titles follow; console clean. A trip
      regenerated under a new name mid-session (a town "Seaside Getaway" →
      "Coastal Weekend", new id) is the case the stale-hash fallback exists
      for — trip ids come from names, so an old link to one can go stale.

- [x] **Multi-select retime — and it is the performance fix, not a
      convenience.** Raised by the owner 2026-09-10 with the right instinct and
      the wrong worry: it does **not** need the gallery rebuilding. Selection is
      additive to `renderGrid` — a class, a modifier-click handler and an action
      bar. The lightbox is not involved. **Built the same day.**

      **Server** — `setPhotosTakenAt` in `pipeline/src/jobs/photoTime.ts`,
      `POST /photos/taken`. One lock; each touched shard read from Graph once;
      renames pooled four at a time; each touched shard saved once; the index
      read once and written only if a month summary changed. Partial success is
      a 200 with `results` and `errors`, because the renames that went through
      are real and must be recorded. Capped at 200. The single-photo route is
      now the batch of one, so there is one implementation.

      **App** — `app/src/retime.ts`. Ctrl/Cmd-click selects, Shift extends a
      run within a grid, a plain click toggles once anything is selected,
      Escape clears. EXIF-dated photos dim and cannot be selected. A bar docks
      at the bottom: date (prefilled from the first pick), hour or "Not known",
      Set time. Records are updated in place, like the single-photo control, so
      nothing reloads.

      **Decided by default, since the owner said "build it" without picking**:
      one hour for all of them, **a minute apart in page order** — every photo
      lands in the chosen hour and keeps its sequence. That makes 60 the most a
      batch can take with an hour set; "Not known" has no limit.

      **Verified**: a request where every item should be refused (two "already
      says", a duplicate, an EXIF photo, an unknown id) — all five refused with
      the right reason, in 3.7s, `index.json` untouched. The gestures, scripted
      in the preview: Ctrl → 1, Shift → 4 (4 expected), plain click → 3, EXIF
      click swallowed with no viewer, Escape → 0. Console clean.

      **Not verified**: a real batch rename — not run against the owner's
      library without asking, so the time for an actual batch is **unmeasured**.
      Expected shape: two Graph downloads, then the renames at four at a time,
      then one upload per touched shard.

      **Follow-up the same day, at the owner's call**: the month album no
      longer renders a day as stops and cards. It is the day's summary and one
      chronological grid, so every photo in the month can be selected — card
      photos and the placards bound to them included. The trip view keeps the
      curated page; card photos there still do not take selection, which is
      fine because the album now reaches them. Verified on September 2026: 758
      photos in grids, 0 stops, 0 cards, selection working; a town trip
      unchanged at 10 stops and 47 cards.

      What makes it worth doing is the cost per photo, measured against the real
      archive with 118 still to correct:

      | | |
      |---|---|
      | one retime, before | **6.5-8.7s** |
      | after skipping the index write when the month summary is unchanged | **5.1-5.9s** |
      | 118 photos at that rate | **~10 minutes of waiting** |

      Skipping the index write was worth little because **the reads dominate,
      not the writes**. `setPhotoTakenAt` calls `loadShard` and `loadIndex`,
      and both are Graph *downloads* — 823KB and 3.4MB — on a write path, which
      is deliberate: HANDOFF's invariant says a write path must not trust the
      mirror, because a mirror gone stale on another machine would be merged
      onto and uploaded over the newer copy. So every single photo costs about
      4MB down and 1MB up.

      And the deferred-upload machinery that would otherwise help is only half
      built: `saveIndex` calls `markDirty`/`markSynced` and sync's `ahead` state
      pushes the local index — but `saveShard` has no dirty tracking at all, and
      the push path uploads `index.json` only. Nothing debounces either.

      A batch endpoint collapses all of it: one `loadIndex`, one `loadShard`, N
      renames, one `saveShard`, one `saveIndex`. 118 photos become one round
      trip instead of 118. The renames themselves still cost a Graph call each,
      but those are small and can run pooled.

- [x] **The interface around the content is English only.** Content could be
      Chinese; the chrome could not. Measured 2026-09-10: roughly 150–250
      strings, 10 English-only plurals and a "photo(s)", 11 sentences glued
      together in code, 14 date and number calls following the browser's
      locale rather than an app setting.

      Done 2026-09-11 to an approved plan, the owner's call being **one
      language setting** for content and interface: Settings → Language, same
      storage key as the old Content language, so the choice carried over. The
      words are `app/src/i18n/` (HANDOFF, "Shape") — `zh-Hans.ts` is typed
      against `en.ts`, so a missing key fails `tsc`; plurals live in message
      functions; every date and number goes through `fmtDate`/`num` in the
      chosen language (English takes the browser's English variant, en-GB
      here). `index.html`'s nine strings are set from `main.ts`.

      Verified against the rebuilt bundle, by capturing every visible line of a
      trip, the viewer, a month, Settings and all four Generate tabs:

      - **English, before vs after** — identical apart from two intended
        changes: "1 photos" → "1 photo" and "Content language" → "Language".
      - **简体中文** — the same views plus the retime bar and the photo time
        editor have no interface words left in Latin script. What remains is
        names (OneDrive, API, Claude, Gemini, file paths), geocoded day places
        ("a town, United Kingdom"), basemap labels, and proper nouns inside
        translated text. Console clean.

      Left English on purpose: server and job log text, including job result
      keys ("summarized 3"). Not done: day `place` strings come from geocoding
      and are not in the translation sidecar; basemap labels would need a
      second name set; `render.ts:27` stop times are still sliced from UTC
      (the filename-clock item).

- [ ] **There is no incremental refresh — every change reloads the archive.**
      Raised by the owner 2026-09-10, and it is the shared cause behind three
      separate patches made this week rather than a defect of its own.

      A write calls `loadAndRender`, which re-fetches `index.json` (3.4MB) and
      rebuilds every view from scratch. Nothing knows *what* changed, so:

      - the reader lost their place, patched by capturing the selection and
        scroll offset before the reload (`captureView`);
      - `shardCache` kept serving the old photo record, so a corrected time did
        not appear until a manual refresh, patched by invalidating the months a
        write reports touching (`forgetMonths`);
      - the same cache is why **captions only appear after a page refresh**,
        which is still open further down this list.

      **One path now does it properly, as a worked example.** Correcting a
      photo's time was unusable at a reload per photo — 123 of them, the viewer
      closing each time — so `setPhotoTakenAt` returns the fields it changed,
      the app writes them into the record the cached shard already holds (the
      same object every view reads), and only that one panel is redrawn. No
      fetch, nothing else touched.

      What that path does not do, and a general fix would have to decide: the
      day is not regrouped, so a photo given a new hour stays where it sits
      until a reload. Mid-batch that is a feature; after the batch it is stale.

      Still outstanding for the writes that do reload — day rewrites and stop
      renames. Worth finishing before the next feature that writes to the
      archive, since that one would otherwise need a patch of its own.

- [ ] **Filename clocks are read as UTC but shown as local.** Found 2026-09-09
      while building the control below. `parseDateFromFileName` builds the
      instant with `Date.UTC(...)`, so a camera's local wall clock becomes a UTC
      instant — and the viewer then formats it for the reader, adding their
      offset. `IMG_20260818_124949.jpg` is stored `12:49:49Z` and shows as 13:49
      in UTC+1.

      The app is inconsistent with itself about it too: stop headings slice the
      raw UTC digits (`startTime.slice(11, 16)`), while the photo viewer runs
      `toLocaleString`. The same photo can read 12:49 under its stop and 13:49
      in the lightbox.

      Not fixed, because the right answer depends on what the stored instant is
      meant to be — the camera's wall clock or a true UTC instant — and changing
      it moves every filename-dated photo in the library. The new time control
      converts at its own edge so that what you type matches what the caption
      shows; that is a local fix, not the systemic one.

- [x] **Moving a photo to another day — rename the file.** Built 2026-09-10 as
      "set the date and time", which is the owner's better framing of it: the
      same rename can carry a *time*, which is what actually rescues these
      photos. A name with a date alone parses as `filename-date`, which is
      `timeSuspect` and lands at midnight, where `stops.ts` refuses to place it
      and appends it to the day's last stop; a name with both parses as
      `filename` and takes a real position in the day.

      `renameForTakenAt` rewrites only the first timestamp run and keeps its
      separators, so `IMG-20260907-WA0012.jpg` at 14:00 becomes
      `IMG-20260906-140000-WA0012.jpg` — a name `parseDateFromFileName` reads
      straight back. `POST /photos/<id>/taken` renames in OneDrive first (an
      archive written first would be undone by the next scan reading the old
      name), then updates the record, moving it between shards and rebuilding
      both month summaries when the date crosses a month.

      It refuses rather than guesses in two cases: a photo dated from EXIF,
      which outranks the filename so a rename would move nothing, and a name
      carrying no date to rewrite.

      In the app it is a control in the photo viewer, offered only on
      filename-dated photos. Verified end to end against real files: one photo
      given 15:30 came back `filename` and no longer suspect, and Graph
      confirmed OneDrive itself held the new name; clearing the time through the
      UI renamed it back and restored `filename-date`.

      The hour is a `<select>`, not `<input type="time">`. The time input was
      the first attempt and it silently half-worked: it yields an **empty
      string** until *both* halves are filled, and `step="3600"` only governs
      the stepper — so picking an hour and leaving the minutes alone read as
      "no time given" and saved the date by itself. Reported as "sometimes it
      just changes the date and not the time", which is exactly what it did. A
      select cannot be half answered.

      Hour granularity (minutes dropped at the input edge rather than in
      storage). Nobody remembers whether the
      museum was 14:10 or 14:25, and a minute field invites a precision the
      memory does not have — an hour already puts the photo in the right part of
      the day. Dropping at the input edge keeps zones with a half-hour offset
      correct: 15:00 in UTC+5:30 still stores 09:30Z and reads back as 15:00.

      Still open above: the timezone the filename clock is read in.

- [ ] **Moving a photo to another day — rename the file.** Raised 2026-09-09.
      WhatsApp saves land on the day they were *sent*, and the real day is
      unrecoverable from the file, so some photos need moving by hand.

      No override field is needed for the case that motivates this.
      `takenAtOf` (`pipeline/src/graph.ts`) tries EXIF first and falls back to
      the filename, and WhatsApp strips EXIF — so those photos are
      `dateSource: "filename-date"` and **renaming the file in OneDrive moves
      them**. It goes through the normal scan path, so the shard, the month
      counts and the day grouping all follow, including across months.

      Two caveats: it edits the source of truth, and a name carrying a date but
      no time still lands `timeSuspect`, so the photo is appended to the day's
      last place rather than placed in time.

      It does nothing for a photo that has EXIF — that would need a real
      override on the record, and grouping keyed off it in `organize`. Worth
      building only if a case turns up that renaming cannot reach.

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
- [x] **Day summaries had no way to see what a run would do.** Fixed
      2026-09-08, after running nine forced organize commands by hand and
      being unable to tell why six of them did nothing.

      `POST /jobs/organize/plan` answers the same question `runOrganize` asks,
      without spending anything, and Generate gained a **Preview** button beside
      "Write day summaries" — the counterpart to Analyze's estimate.

      The decision itself was factored into one `decideDay`, called by both the
      plan and the run, so a preview cannot drift from what the run will do.

      What it fixes, in the words of the cases that caused it:

      | scope | preview says |
      |---|---|
      | `2022-06-09` forced, which silently did nothing | `1 skipped — no analyzed photos yet, so run Analyze on them first` |
      | `2026-09-07` forced | `1 day would be rewritten` · `2026-09-07 (169)` |
      | `2026-09` forced | `5 days would be rewritten` with each date and count |
      | whole archive, unforced | `30 already up to date` · `1,983 skipped — no analyzed photos` |

      That last line is the shape of the archive: 2,013 days, ~30 with any
      analyzed photos. **"0 day(s) summarized" was the same message for
      "nothing changed", "nothing in scope" and "nothing here is analyzed"** —
      and the third is overwhelmingly the common one here, which is what made a
      working button look broken.

      Still not addressed, and the reason nine runs were needed: `--only` takes
      a single date or month, so there is no way to name several days at once.

- [x] **Whole-archive reads went to OneDrive with the mirror sitting on disk.**
      Fixed 2026-09-08, spotted by the owner watching `organize` sit on
      "Loading 123 month shard(s)…" after limiting the run to `2026-09`.

      Two separate things, and only one was a bug. **The count is not
      reducible**: `organize` rebuilds `index.sections` from the full set of
      days, so loading only the months named in `--only` would drop every other
      month's day pages from the index. The bug was the *source* —
      `loadAllShards` downloaded all 123 shards from OneDrive, one at a time,
      when byte-identical copies were in `pipeline/data/`.

      | | before | after |
      |---|---|---|
      | `loadIndexForReading` | ~1,200ms | **11ms** |
      | `loadAllShards`, 123 shards / 31,374 photos | ~123 × 650ms ≈ **80s** | **162ms** |
      | Estimate cost, trip range | 3,326ms | **278ms** |
      | Estimate cost, 9 months | 7,188ms | **269ms** |
      | Estimate cost, whole library | minutes | **318ms** |

      Read-only paths now use `loadIndexForReading` / `loadShardForReading`,
      which try the mirror and fall back to Graph. **Write paths deliberately
      still go through Graph**: a mirror made stale by a run on another machine
      would otherwise be merged onto and uploaded over the newer copy. Verified
      with an invalid token, so any Graph call would have failed loudly rather
      than passing silently — all 123 shards came from disk.

      Third time this exact mistake has been found in a different place
      (`/archive/status`, then `planAnalyze`, then `loadAllShards`). **If a code
      path only reads metadata, it should be reading the mirror.**

      Side effect worth knowing: a whole-library estimate is now practical,
      which is the number the analyze decision turns on — **23,401 photos**
      outstanding.

- [x] **PDF export was broken, in two independent ways.** Reported by the owner
      2026-09-08, fixed the same day.

      **The feature: a tainted canvas.** The export draws every card image onto
      a canvas and calls `toDataURL`. When thumbnails moved off same-origin
      `blob:` URLs onto the local server's own origin (port 4319 against the
      app's 4173), every image began tainting the canvas, and `toDataURL` threw
      `SecurityError`. The rejection escaped `printView`, so the export stopped
      at "Preparing" and never reached `window.print()` — no error surfaced,
      because nothing was listening for an unhandled rejection.

      Fixed with `crossOrigin: "anonymous"`, declared **per source** rather than
      blanket: `serve.ts` already answers with `Access-Control-Allow-Origin` for
      every registered app origin, but the Graph CDN links are not ours to
      guarantee, and setting it on a host that does not send the header makes
      the image fail to load outright. Proven on one image, one URL: plain
      `<img>` loads and the canvas is **tainted**; with the attribute it loads
      and the canvas is **clean**.

      **The UI: the print stylesheet did not exist.** `@media print` blocks by
      commit: `c65bc5b` 1 (1,426 css lines) → `268d217` **0** (1,124) →
      `9e8e2e4` 1, but only the `.page-export` one-liner. ~300 lines went in the
      marker-slicing accident HANDOFF warns about, and the later "restore
      Settings CSS" pass recovered the Settings half and missed this one. So the
      export had been running with no print stylesheet at all: the page printed
      as the on-screen flex shell (one page of a 170,947px document), the
      unreviewed roll (`.stop-more`, `.transit`) and verbatim OCR
      (`.card-source`) were no longer excluded from a file whose entire purpose
      is sharing, and `#print-progress` rendered as bare text in document flow
      instead of a centred pill. Recovered from `c65bc5b`, furniture list
      updated: `#menu`, `#job-drawer` and `#settings-panel` are gone, and
      `.page-pin` / `.page-pin-slot` needed adding.

      **A measurement lesson, again.** Mid-diagnosis the app appeared to load
      **zero** of 1,292 images, which looked like a fresh regression from the
      CORS change. It was not: a newly created `IntersectionObserver` also fired
      zero times on nine images sitting in the viewport, which cannot be true of
      a page that is painting. The tab was backgrounded and not rendering, so
      lazy loading never ran. **A browser being driven headless-ish is not a
      browser someone is looking at** — the owner's visible window showed the
      images loading normally. Two earlier entries in this list are the same
      mistake in different clothes.

      **A third cause, found only because the owner kept pushing.** After the
      CORS opt-in, some images loaded and some did not, and clearing the
      *server's* cache made no difference — because the broken copies were in
      the *browser's*. `cors()` set `Vary: Origin` only when the request carried
      an `Origin`. A thumbnail fetched without CORS was therefore cached
      `immutable, max-age=31536000` with no record that CORS mattered, and the
      browser then satisfied a later CORS request from that same entry, which
      has no `Access-Control-Allow-Origin`. The check failed in ~4ms — far too
      fast to look like a network problem, which is what made it read as random.

      Fixed by always sending `Vary: Origin`. Proven: before, `no-CORS <img>`
      then `CORS <img>` on one URL failed; after, the same sequence loads and
      the canvas is clean. Cache-busted URLs always worked, which is what
      isolated it to caching rather than to the server.

      The server fix alone was not enough: entries already cached are immutable
      for a year and a clear done *before* the fix just re-poisons on the next
      load. Measured after the `Vary` fix, on the app's own URLs: **63 of 200
      failed from cache while the same 200 succeeded with `cache: "reload"`**.
      So `THUMB_CACHE_VERSION` was added to `localThumbUrl` — bumping it changes
      every thumbnail URL and retires the poisoned entries outright, with no
      manual cache clearing. After it: 200/200 on a cold pass *and* 200/200 on a
      second pass served from cache, and 50/50 as real `<img crossorigin>` with
      a clean canvas.

      Image loading confirmed normal by the owner 2026-09-08, after three
      rounds — twice it was called fixed while it was not. The first miss
      trusted a backgrounded tab that was not rendering; the second fixed what
      *creates* bad cache entries without retiring the year's worth already
      stored. **The comparison that actually isolated it was default-cache
      against `cache: "reload"` over the same 200 URLs**, and it would have
      found the cause immediately had it been run first.

      Export confirmed good by the owner 2026-09-08 — a real PDF, produced
      after the stylesheet was restored. Closed.

- [x] **The left pane became 123 rows of scroll.** Fixed 2026-09-09 at the
      owner's request. Every year was expanded at once, so a pane holding
      twelve years of archive could show about one and a half of them; the year
      heading you were reading scrolled off the top and the months under it
      became bare numbers with no year attached.

      Years and Trips are now collapsible sections that remember what you left
      open (`nav-open-groups` in `localStorage`), each heading sticks while its
      own rows scroll past, and a collapsed year still carries its photo count
      so the pane reads as a summary rather than a row of lids. First run opens
      Trips and the newest year. The whole archive now fits without scrolling.

      Three things the browser caught that the diff did not:

      - Sticky siblings share a containing block, so every heading pinned to
        the top of the nav and stacked on the last. Each group is now its own
        `<section>`, which bounds the sticky range and lets the next section
        push the previous heading out.
      - The row opened automatically on load is always the newest trip, so
        revealing its group re-opened Trips on every reload and made collapsing
        it look broken. The reveal no longer writes to storage, and the
        automatic selection is taken from a group that is already open.
      - On the phone the nav is a horizontal strip, so a group must not become
        a block. `display: contents` on the section and the month list keeps the
        rows as direct flex children — scoped to `:not([hidden])`, since an
        unconditional `display` would defeat the attribute and pin every year
        open. Checked at 500px: `▸ Trips` and `▾ 2026` as chips with the year's
        months inline, and tapping a collapsed chip expands it in place.

- [x] **The collapsed pane worked but looked wrong.** Fixed 2026-09-09 on the
      owner's verdict that the first cut would "give you crap design awards".
      Three things were actually wrong, not just unlovely:

      - **Inverted hierarchy.** The year heading was 11px and dim above 13px
        bright months, so the parent read as a caption for its own children.
        The heading is now the larger, full-contrast element and the months are
        the secondary text.
      - **One glyph, two jobs.** The group twisty and the trip-row bullet were
        both `▸` in the same position, so a trip looked like a collapsed group.
        The twisty is now a CSS chevron that rotates off `aria-expanded` — no
        glyph to swap in JS — and trips get an accent dot.
      - **Hover and selection punched holes.** Both used `--bg`, which in dark
        mode is *darker* than the sidebar. Hover is now a `color-mix` lift and
        selection an accent tint with a bar on the rail.

      Months also sit on a rail under their heading, so they read as contained
      by the year rather than merely following it. Checked in both themes.

      Not done, deliberately: the phone's horizontal strip. It carries one fix —
      `:first-child` matched every heading once each group became its own
      `<section>` — and nothing cosmetic, because the mobile UX is due to be
      redesigned wholesale.

- [x] **A signed-out app showed nothing even with the whole archive on disk.**
      Found 2026-09-09 while testing the above in a browser with no Microsoft
      session. `main()` gated on `getActiveAccount()` and stopped at the banner,
      but `loadIndex` prefers the local job server's mirror and never got the
      chance. It now offers the sign-in and loads anyway: with no mirror the
      load raises `SignInRequiredError` and lands on exactly the same banner, so
      the phone's path is unchanged. Verified signed out — index, month shards
      and thumbnails all served from `127.0.0.1:4319`.

- [x] **The pin control moved from the sidebar row into the page heading.**
      Done 2026-09-08 at the owner's request. It used to be a 16px glyph inside
      the nav row, which put a per-item *action* in a list whose job is
      navigation: it needed a click-target exception inside the row's own
      handler, carried no label, and acted on something other than what you were
      looking at. It now sits beside "Save as PDF" with the words to say what it
      does — `☁ Keep on this device` / `▣ Kept on this device` — keeping the
      borrowed OneDrive vocabulary.

      Two things the browser caught that the diff did not:

      - It first used the **checked** `syncStatus()`, costing a Graph eTag round
        trip on every month and trip opened — **1,344ms against 181ms** for the
        cached call. Pins are local state in `sync.json`, so the comparison is
        irrelevant to them. This is the same mistake Settings made, found the
        same way. Revealing the Generate tool now asks `/health` instead, which
        is milliseconds.
      - Adding a second control to the heading squeezed the flex row and left a
        long trip name **wrapping mid-word**. The title is the last thing that
        should be squeezed, so it no longer shrinks and the meta line takes it
        instead; the heading also wraps rather than overflowing when narrow.
        Checked at 1288px and 747px, with no sideways overflow.

      Trade-off, deliberate: the sidebar no longer shows at a glance which
      months are pinned. Settings > Kept on this device still lists them.
      Verified: toggle on and off from both a trip and a month, with the
      server's pin list agreeing at each step and ending as it started.
- [x] **The missing-`.env` dialog told you to write a file by hand.** Fixed
      2026-09-08. It is now a **Settings > Generation** form: pick the provider,
      paste the API key, save. `GET /config` reports what is set, `POST /config`
      merges into `.env` and applies it to the running server.

      What made this tractable was checking when the dialog actually fires:
      `ARCHIVE_HOME` is set only in a **packaged** build, and a packaged build
      bakes every non-secret setting (`bundle-pipeline.mjs`), so the job server
      always starts and the one genuinely missing value is the provider's API
      key. No shell-side config server was needed — the server that serves the
      form is already running. Had that not held there would have been a
      chicken-and-egg: `env.ts` throws on a missing `AZURE_CLIENT_ID` at import,
      so with no baked config there is no backend to serve a form at all.

      Three things this needed beyond a form:

      - **The key has to take effect without a restart.** Both provider clients
        were built at import from `env`, so a key saved at runtime would have
        been ignored until the process restarted — the same "nothing happened"
        the form exists to avoid. They are now built lazily and rebuilt when the
        key changes, and `reloadEnv()` re-reads config in place.
      - **A strict allowlist of writable names.** This turns an HTTP request
        into lines the process reads as environment variables on next start;
        without it a request could set `NODE_OPTIONS` and get arbitrary code
        run. `AZURE_CLIENT_ID` is deliberately excluded — `auth.ts` builds MSAL
        once at import, so the form would be promising something it cannot do.
      - **Keys are write-only.** `/config` reports `keys: {anthropic, gemini}`
        as booleans and never returns a value.

      Also surfaced a real footgun on this machine: `GEMINI_API_KEY` is set as a
      **system environment variable**, and dotenv never overrides one — so a key
      saved in the form would work until the next restart and then silently lose
      to the machine's setting. `configStatus.shadowed` reports this and the
      form warns. Confirmed live: the real `/config` returns
      `shadowed: ["GEMINI_API_KEY"]`.

      Verified: fresh-install status; save writes `.env` and flips `ready` in
      the same process; `NODE_OPTIONS` rejected; a newline in a value rejected;
      and — the actual claim — a key written by the form reached Google, which
      answered `API key not valid` for the fake key, proving
      form → `.env` → reload → rebuilt client → real request with no restart.
      Then verified in the browser — which caught a defect that the diff would
      not have. The display was keyed on the **saved** provider rather than the
      **selected** one, so choosing Anthropic while Gemini was configured still
      read "Ready", still offered "Saved — type a new key to replace it", and
      still showed *Gemini's* shadow warning, for a provider with no key at all.
      It now describes the selection, with a distinct "Ready once saved" for a
      provider that has a key but is not the active one. Checked in both
      directions.
- [x] **The Gemini smoke test had silently stopped testing.** Fixed 2026-09-08,
      found by running it as the README says to after changing `gemini.ts`.
      `smoke-gemini.mjs` still passed the pre-v11 flat `photos` list where
      `SummarizeDayInput` has wanted `stops` for several schema versions, so
      `stops.map` threw on every run. Being `.mjs` nothing typechecked it. Both
      halves now pass against the real API.
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
- [x] **Photo captions are written with no context at all.** *(Plumbing built
      2026-09-09; reworked and re-measured 2026-09-11 — see the end of this
      entry. The first version's measurement comes first.)*

      `CaptionPhotoInput` now carries a `context` of `takenAt`, the geocoded
      `place`, and the six nearest already-written captions from the same day,
      framed in both providers as help for *naming* and never licence to
      describe what the image does not show.

      **Tested on 20 photos of the the railway museum stop (2026-08-18 s3), the
      TODO's own example, writing nothing.** Each was re-captioned with context
      and compared against its stored caption:

      | | result |
      |---|---|
      | context actually supplied | `Utrecht, Nederland` + 6 nearby captions, on all 20 |
      | captions naming the museum, before | **0 of 20** |
      | captions naming the museum, after | **0 of 20** |
      | captions that changed at all | 20 of 20 — paraphrase, 99 → 106 chars average |

      The reason is structural and was not visible from the code: **none of the
      three context fields carries the museum's name.** Reverse geocoding runs
      at `zoom=10` and returns a city; the neighbouring captions are themselves
      context-free descriptions of train interiors, so they cannot name what
      they do not know either. The name first exists in the *day* summary, which
      is written after captioning. Passing a photo its city and its neighbours'
      captions cannot tell it where it is.

      What the test did buy: slightly more specific descriptions ("suspended by
      leather straps", "in Dutch and English", "visitors walking ahead"). Real
      but marginal, and it costs ~200 input tokens on every photo — about +16%
      on the measured 1,227.

      Two routes that would actually deliver the headline benefit, neither yet
      taken:
      - **POI-level geocoding, free.** At `zoom=18` those coordinates return
        `Maliebaanstation` — the former station the museum occupies — against
        `Bloesemstraat` at 16 and `Utrecht` at 10. A named venue rather than a
        city, at no model cost. Not the museum's own name, so worth sampling
        across several stops before believing it.
      - **Caption after organize, not before.** The stop title *is* the name,
        and it exists by the time the day is summarized. That inverts the
        pipeline order for a second pass over photos worth re-describing.

      **Decision needed before any re-run**: keep the context (marginal gain,
      +16% input), keep it only once a POI geocode gives it something worth
      saying, or drop it. Nothing has been re-analyzed and no captions were
      overwritten.

      **Reworked 2026-09-11, the owner's call being "with context".** The
      context is now only fields that can name something: a street-level
      geocode (`zoom=18`, kept as a venue only when it is a real one —
      measured on twelve named stops it found the venue for five, and once
      offered a waste basket), the street, the trip, the owner's note for the
      day, and the camera's clock in words. The neighbour captions are gone —
      marginal above, and impossible in a batch. Geocoding now runs *before*
      captioning, cached on disk (`data/geocode-cache.json`).

      Re-run on 24 already-captioned photos from twelve named stops, writing
      nothing: **six new captions carry a place the old one lacked** —
      Maliebaanstation in Utrecht (the the railway museum's station),
      Karl-Liebknecht-Straße, the New Palace in a city, the a city railway,
      Burgstraße in Nuremberg, Jenbach. Nearby shop names offered as venues
      ("Stromma", "Belstaff", a builders' merchant) were ignored every time,
      and nothing was asserted that the image did not show. Still not the
      museum's own name: that first exists in the stop title.

      Same test at **low image resolution**: input 1,429 → 628 tokens a photo,
      the same places named, and 10 long transcriptions matching the stored
      text at 97% word overlap either way. Low is now the default
      (`CAPTION_RESOLUTION` in `gemini.ts`).

      Original entry follows.

- [x] **Photo captions are written with no context at all.** *Superseded by
      the entry above.* Confirmed at the
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
      this change; neighbouring days are the smaller half. Needs a marker on
      `DayRecord` for which mode produced it, and `segmentsAreCurrent()`
      extended so switching modes counts as stale.
- [x] **Koblenz is missing from the trip map.** Fixed 2026-09-09. **The guess
      in this entry was wrong** — `MAX_PLACE_SPAN_KM` lives in `app/src/tripMap.ts`
      and never touched it, and it was not merged into Boppard.

      Koblenz was a `transit` segment: 39 photos over 105 minutes, filed as
      travelling. `detectStops` splits a cluster whenever the anchor moves more
      than `MOVE_KM` (350m), which is the right question for separating a museum
      from the café beside it and the wrong one for a place you move *around*
      in. A cable car across the Rhine, Ehrenbreitstein Fortress and the
      Deutsches Eck are each further apart than that, so the visit shattered
      into clusters that were individually too small to be `substantial()`, and
      every one of them fell into the same transit run — together with the train
      back to Mainz, which is why the segment measured 63km end to end.

      The fix is a second pass at city scale (5km) over the runs that failed the
      first test. The bar for promotion is higher than `substantial()`, because
      everything reaching it has already failed once and the failure mode is
      promoting a train window into a destination. Each threshold came from a
      real false positive in the measurement:

      | rule | the case that required it |
      |---|---|
      | duration >= 25 min, not photo count alone | a 12-photo burst from a moving train at Bingen, over 4 minutes |
      | >= 6 located photos and measured span <= 5km | with no GPS every photo joins one cluster, so a 16-hour overnight ferry looked compact |
      | duration <= 4 hours | "Train to a port town", 974 minutes; "Train to a city", 581 |

      Measured across the trip's 81 transit runs: 19 promotions on the first
      rule, 16 with GPS evidence required, 13 with the duration cap — dominated
      by real visits (Koblenz, the Hafelekar cable car, the a city canal
      tour, Munich Altstadt).

      Verified: 2026-08-24 re-detects as `place Koblenz 39p 17:06-18:51` with
      "Train to Koblenz" and "Train to Mainz" correctly transit either side; the
      re-summarized day gives Koblenz 8 cards and names Ehrenbreitstein and
      Deutsches Eck; the marker is on the trip map.

      **Nothing else was re-summarized.** `segmentsAreCurrent()` cannot see an
      algorithm change, so every other day keeps its stored segments until
      forced — the day picker in Generate is how to choose which.
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
- [ ] Zoom-out reaches the whole world; cap at continental?
- [ ] Mobile view: design needs rethinking; a Figma would help.

### Resolved

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
- [x] **"Netherlands gets extra territory"** — basemap land/sea boundary looks
      wrong around Zeeland/Zuid-Holland; markers sit in water. Not investigated.
      Suspect the `ne_50m_land` outer-ring-only extraction, or the lakes layer.
	  User: Issue is Hoek van Holland is in the middle of the sea, resolved
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
- [x] Mobile view — **portrait layout cannot scroll.** Fixed 2026-09-06:
      `#main-column` had no `min-height: 0`, so once the <=700px rule turned
      `#app` into a column it could not shrink below its content, overflowed a
      `body` with `overflow: hidden`, and nothing scrolled. One line.

## Todo

- [x] **i18n — Chinese and English.** *Closed 2026-09-11: done as the two
      "Content in a second language" and "The interface around the content"
      items under Open issues. The storage turned out not to need a schema
      break — the second language is a sidecar beside the archive. Kept below
      for the original reasoning.* UI strings are the easy part and dates
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
- [x] **Gemini Batch API** — roughly half price, async, up to 24h. Not worth it
      for a 35-minute interactive run; worth building if backfilling the other
      ~14,000 photos (£20 vs £40 overnight).
      *Built 2026-09-11* (`jobs/analyzeBatch.ts`; HANDOFF, "The one piece of
      work"). Submit locates the photos, writes JSONL files of 4,000 requests
      from the server's thumbnail cache (Graph when missing), uploads and
      records each batch in `data/batches/analyze.json` the moment it exists;
      collect merges only into photos still uncaptioned, and the server runs
      it on a ten-minute timer. Round trip on 3 photos: accepted, finished in
      4 minutes, 3 of 3 captioned, 1,742 input / 749 output tokens — 581 and
      250 a photo, as estimated. The backlog is now 23,425, about $17 batched.
- [ ] **A batch submit dies at Google's queue quota and wastes its
      preparation.** 2026-09-11: the whole-library submit sent one file of
      4,000, then `batches.create` for the second answered 429
      RESOURCE_EXHAUSTED "You exceeded your current quota" after 43 minutes of
      locating and preparing; the job failed and the prepared JSONL was
      thrown away. The file had uploaded (331 MB); `batches.create` refused.
      Cause: Tier 1's **3M enqueued batch tokens** for Gemini 3.7 Flash across
      all open batches (Tier 2: 400M), and a 4,000-photo file is ~2.6M. Fix:
      treat 429 at submit as "stop here, keep what was sent" rather than a
      failure, and have the ten-minute collect submit the next file once a
      batch is collected — one open batch at a time on Tier 1.
- [x] **Activity — one page for everything the server does.** *Done
      2026-09-11* (`app/src/activity.ts`). Running job live with cancel,
      thumbnail warming (new counters on `/health`), batches with tokens and
      cost in $ and ≈£, and history from `data/jobs/` — 40 jobs back to 5 Sept
      after a restart. A collect started outside the page (0.3 s long) reloaded
      the album exactly once, seen as one extra `/archive/index` fetch; the
      first-poll and scan/sync exclusions keep launch from reloading. Checked
      in English, 简体中文 and at 375 px.

### Resolved

- [x] **Make this an app.** Electron shell in `desktop/`. `npm run desktop`.
- [x] **Light/dark mode toggle.** Done 2026-09-07, in Settings > Appearance.
      Three states, not two: Light, Dark and System, where System is the
      *absence* of `data-theme` so the media query keeps following the OS.
      Applied by an inline script in `index.html` before the stylesheet paints,
      or a reader who chose dark on a light system watches the page render
      light and flip.
- [x] **Print view / Save as PDF.** Menu entry on any view with cards. See
      `app/src/print.ts` and the `@media print` block at the end of
      `app/src/style.css`.

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
      exercised on a real phone. User: Tested, layout does not scroll.
- [ ] Zoom is centre-origin, so zooming does not follow the cursor.

Zoom resizes the photograph rather than scaling a layer. `transform: scale()`
promotes it to a composited layer that is rasterised once and GPU-stretched, and
those tile boundaries showed as thin lines across the picture at some levels.
`will-change: transform` — the usual advice — made that worse, since it
guarantees the very layer at fault. Setting a real width makes the browser
resample from the source: no seams at 152% or 506%, and sharper.

## Correctness / safety backlog

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
- [x] **`analyze` (CLI) and `serve` can run at once and clobber the same
      shard.** Fixed 2026-09-06 by `pipeline/src/lock.ts` — a pid lock at
      `data/.archive-lock`, held per write by all five CLI entry points, every
      server job and sync. See "Desktop shell" for the details.

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
