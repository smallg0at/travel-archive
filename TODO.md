# TODO

Open items, and nothing else. Everything closed — with the measurements that
closed it — lives in `docs/TODO-history.md`: a verbatim archive of this file
as of 2026-09-22, kept for the record and no longer maintained.

**20 open.** The list grows because each session surfaces defects that were
previously invisible — most of what has been closed was found by measuring
rather than by planning. Four sessions work on this at once (this one, the
phone app, the basemap's China worldview, and an editor agent on the desktop
shell), so entries name the commit that closed them.

What the library is, so the entries have a scale to read against: **~31,700
photos over 123 months**, ~29,300 captioned, ~340 days written up, 15 trips
defined. Generate → Translate → Estimate for what is left of the text.

## Open issues

- [ ] **A remote reader's Activity page stops updating job progress.** Raised
      by the owner 2026-10-04: on the home network the 进行中 box shows the job
      as it was when the page loaded, and the phase, bar and log then stay
      there. Three mechanisms meet here and only one was checked while fixing
      the missing section (5240d58): live updates come *solely* from
      `watchJob`, an SSE stream to `/jobs/:id/events`; the sidebar indicator's
      15s tick deliberately repaints only when `liveJobId === null`, leaving an
      attached job to its stream; and `refreshLists` early-returns when
      `canWrite()` is false, so a read-only client has no poller behind the
      stream either. A stream that silently drops — LAN, a sleeping page, a
      proxy that times out — is then never noticed or re-established, and
      nothing falls back. Establish first **whether the SSE frame reaches a LAN
      origin at all**, and whether the owner's own window still updates (not
      re-checked while writing this; if it does not, this is not a
      remote-access issue at all). If the frame does arrive, the cheap fix is a
      fallback: the indicator tick already fetches `health`, so repainting from
      it when the stream has been silent for N seconds costs one call every
      quarter of a minute. Shelved as ugly but not wrong.

- [ ] **The job server keeps no request log, so a failure on someone else's
      machine leaves no trace.** Raised 2026-09-25 after an iPad on the home
      network stopped loading pages while every other device was fine. The
      server prints a startup banner and a handful of handler messages, writes
      nothing to disk, and the shell discards the child's stdout, so there was
      nothing to read afterwards — not even whether the requests arrived. The
      four cases that need telling apart are "the request never reached the
      server", "it arrived and 500'd", "it was refused by the access gate" and
      "every step was 200 and the fault is in the page", and with no log there
      is no way to distinguish them. A `LOG_REQUESTS=1` switch (off by default,
      since it is noise for the owner's own window) writing `method path status
      remoteAddress` would answer all four. The iPad issue is intermittent and
      shelved until it recurs; turn this on first when it does.

- [ ] **"Thumbnail size" is a misnomer, and it governs one view.** Raised by
      the owner 2026-09-25, looking at the three buttons and asking whether they
      did anything. They do: `--album-cell` is set to 78/120/190px and reflows
      the grid. But that is all it does — it never changes which thumbnail is
      fetched, since `album.ts` states every grid thumbnail comes back at
      Graph's `large` (800px) regardless, and `object-fit: cover` then crops it
      into the cell. And `--album-cell` is read by exactly two grids,
      `.album-grid` and `.stop-grid`; the card layout, the search results and
      the day-view hero all size themselves and ignore it, so on a month
      rendered as cards the control does nothing at all. Either rename it to
      what it is ("grid density") or make it mean what it says by extending it
      to the card layout — the first is honest and cheap, the second is a
      feature.

- [ ] **Scan re-lists every month folder, because Graph gives no folder change
      token.** Raised 2026-09-23. On a full scan of 143 folders the write phase
      downloaded a shard per month even when nothing changed; the *upload* for
      unchanged months is now skipped (f543b1e), but the download is not. The
      obvious fix — a per-folder `cTag` — does not exist: on personal OneDrive a
      folder returns `eTag` and no `cTag` (verified 2026-09-23 against
      图片/本机照片/2009/05: `$select=cTag` comes back empty), and a folder's
      `eTag` is documented *not* to change for properties derived from its
      children (childCount, lastModifiedDateTime). The reliable signal is the
      **delta** endpoint (`/me/drive/root/delta?token=…`), which reports what
      was added, changed or deleted since a cursor — a rebuild of `scan`'s
      listing around a delta cursor, not a tag comparison.

- [ ] **Confirm the phone's sign-in now survives a hard kill.** Raised
      2026-09-20 by the phone session. The key that unlocks MSAL's kept
      tokens is a cookie, and a cookie written from the page lives in memory
      until the WebView flushes it — measured: a probe cookie written exactly
      that way was gone after `am force-stop`, which is why the app kept
      coming back signed out. `CookiesPlugin` now flushes it the moment it is
      written (ae5fbc6), but that build has not been tested: the emulator run
      that appeared to confirm it was carrying a stale web bundle, so the
      flush code was not in it, and the key probably survived on the
      WebView's own timer. The test: write a cookie, flush it through
      `Capacitor.Plugins.Cookies.flush()`, force-stop within a second or so,
      relaunch and look for it. The owner's emulator went down before it ran.
      Real proof is a sign-in on the phone that outlives an update.

- [ ] **The upload phase reports no progress.** Raised by the owner
      2026-09-18. `finish()` in `pipeline/src/jobs/analyzeBatch.ts` hands a
      ~300MB file to `ai.files.upload()` and the job sits on one message for
      minutes — the `done/total` still on screen is the *preparing* count that
      finished before it started. On a weak link that is the exact moment the
      reader needs to know whether anything is happening, and it is also when
      the upload retry may be quietly on attempt 2 of 3.

      The SDK's `files.upload` takes a path and exposes no progress callback,
      so this needs either its resumable-upload endpoint driven by hand (POST
      for a session URI, then PUT byte ranges, reporting after each) or, at
      the least, an elapsed-time line so the phase does not look hung.

- [ ] **There is no incremental refresh — every change reloads the archive.**
      Raised by the owner 2026-09-10, and it is the shared cause behind three
      separate patches made this week rather than a defect of its own.

      A write calls `loadAndRender`, which re-fetches `index.json` (~6MB) and
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

- [ ] The mirror is trusted without checking OneDrive at all. Worth a
      background revalidation (compare `generatedAt`, refetch if OneDrive is
      newer) once a second machine is ever in play.

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

- [ ] **Label suppression is aggressive** — 7 of 23 shown at the fitted view.
      Honest (they don't fit) and zooming reveals more, but the Randstad stays
      anonymous. Leader lines or offset placement would beat dropping.

- [ ] **Confirm `appId` `com.travelarchive.photos`** before installing it
      anywhere that matters — changing it later makes it a different app.

- [ ] iOS is not added — it needs a Mac with Xcode.

- [ ] **A trip's dates cannot be edited.** Rename and delete exist; the range
      does not. It matters now that trips are accepted from suggestions: the
      ones taken before the two night-rule corrections above may include a day
      or two spent at home, and the only way to fix one is to delete it and
      create it again.

- [ ] **An old job server silently strips new fields from `home.json`.** Seen
      2026-09-20: the desktop app's server was the build from before
      `excursions` existed, and its next write of the map index dropped the
      field — the days out disappeared from the album with nothing to say why.
      Schema drift between a running server and the app it serves is a class of
      bug, not one instance; a version on the file that the reader can compare
      would at least make it legible.

### Rasterise-at-print-size — one hand-test left

- [ ] **The margin is thinner than it looks — 5%, not the 13% q0.70 was chosen
      for.** Projected ~45-46 MB from the images alone; the finished PDF came in
      at 47.47 MB, so page structure costs ~5% on top, not the ~3% assumed. A
      slightly longer trip, or a few more `full` cards, will breach 50MB. If it
      does, q0.62 measured 38.2 MB and is the next stop.

- [ ] 45MB clears AI Studio (50MB) but not mail (25MB). An export scope choice
      is still the lever for that.

- [ ] For feeding Gemini specifically, a **text export** — narrative, day and
      stop summaries, card titles/descriptions, OCR — is ~19,000 words and a
      few hundred KB. Better than a PDF for questions about the trip; worse if
      the model needs to see the photographs. Probably worth having both.

- [ ] `window.print()` freezes the renderer while the dialog is open, so the
      tab cannot be driven by automation during it. Test print by hand.

## Desktop shell (2026-09-06)

- [ ] No code signing and no auto-update. Windows will show a SmartScreen
      warning on first run of an unsigned installer.
