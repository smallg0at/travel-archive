# How to work on this

This has been earned the hard way over the sessions, and is the most useful
thing in this file.

**Measure before asserting.** Nearly every confident diagnosis on this project
that was not backed by a measurement turned out to be wrong. Recent examples:
`will-change: transform` was added to fix compositing seams and guaranteed the
layer causing them; a transcript sizing bug was blamed on `<details>` when a
stale `max-height: 22vh` rule was capping it; the thumbnail bottleneck was
blamed on the server when the server did 13.6 requests/sec and the browser's
six-connection limit was the wall.

**A number your own code produced is not a measurement** until an independent
signal agrees. A cache-stats call memoised for 30s reported "0 files evicted"
when 1,082 had gone.

**Check the metric measures what you think.** "Only 5 of 24 images loaded" was
counting images inside collapsed `<details>` that are never meant to load.
"0 of 3,659 loaded" was a test jumping `scrollTop` before layout settled.

**Never edit CSS by slicing between markers.** Twice now that has silently
deleted unrelated blocks — and the second one was not fully found for weeks.
The whole `@media print` block went at `268d217` and the export ran without a
print stylesheet until 2026-09-08. **After any CSS edit, count `@media` blocks
and braces**, not just the selectors you meant to touch. Use anchored replacements of exact text and verify the
selector count afterwards.

**Before deleting a CSS rule, find out who builds that class.** A month-heading
redesign (`a1af269`) took the `.density-control` rules with it, because the
heading no longer used them — but `album.ts:120` and `theme.ts:108` still build
that class, so all three Settings controls (theme, thumbnail size, language)
lost their frame on the desktop *and* on the phone, where `mobile.css` only
layers flex and min-height on top of those base rules. The owner spotted it;
restored in `64e6473`. `grep` for the class name across `app/src` before
removing its rules, and remember that the phone may be styling on top of them.

**Watch for `display: …` beating `[hidden]`.** An author-origin `display` rule
overrides the UA's `[hidden] { display: none }`. This has bitten three times —
`.lightbox`, `.signin-banner`, `.job-form`. The remedy in the stylesheet is to
qualify the rule (`.job-progress:not([hidden]) { display: flex }`).

**A browser you are driving is not a browser someone is looking at.** A
backgrounded tab stops rendering, so `IntersectionObserver` never fires and lazy
images never load — which reads exactly like a regression. Twice now a "fix"
has been reported on the strength of such a reading. If a measurement says
nothing loaded, check that a *fresh* observer fires on an element you can see
before believing it.

Driven past that point: in a hidden tab `requestAnimationFrame` never runs
either (60s with zero frames), so grid thumbnails hydrate *never* — measured
0 of 31, repeatedly. The lever is the app's own **导出 PDF** button:
`printView` calls `hydrateAll` directly and skips the observer, loading every
image on the page whatever the tab's visibility. **Stub `window.print` first**
(`window.print = () => {}`) or the export reaches the real dialog and, with a
"Microsoft Print to PDF" default printer, drops a file in Downloads as the
side effect of a measurement. And `/thumb` is `immutable` for a year *in the
browser too*: a test that needs a 404 after a 200 has to change origin (or
bump `THUMB_CACHE_VERSION`), because the old bytes are still valid there.

---

## Method, learned the hard way

**Verify in the browser, not in the diff.** Chrome is driven through the
`claude-in-chrome` tools; the desktop shell can be inspected with
`--remote-debugging-port=9222` and a ~40-line CDP client, since it is not Chrome
and the extension cannot attach.

**When a file is the thing in question, read that file.** "Days out are missing
on the phone" produced three confident diagnoses across two sessions — a stale
server stripping the field, then the local mirror being ahead of the upload —
and all of them were inferred from downstream behaviour. One direct read of
`home.json` from OneDrive (via the pipeline's own auth) disproved both in a
minute: `schemaVersion: 2`, 17 excursions, `builtAt` byte-identical to the
mirror's. The real cause was that the device was signed out, so the file was
never requested at all. A signed-out app is worth recognising by that shape —
`getAccessToken()` throws, no metadata is fetched, and every feature reading it
looks *empty* rather than broken.

**Several sessions work in this tree at once.** Four, recently: this one, the
phone app, the basemap's China worldview, and an editor agent on the desktop
shell. Consequences that have actually bitten:

- **Check `git status` before assuming a broken file is yours.** A stale patch
  applied over a committed redesign left `album.ts`, `dayEdit.ts` and
  `style.css` with every rewritten line duplicated — the old copy first, never
  closed. CSS nesting made the stylesheet *parse*, silently nesting the rest of
  the file inside one selector. `git show HEAD:<file>` proved the committed
  state clean, which is what identified it as another session's in-flight work.
- **Ask before editing a shared renderer** (`tripMap.ts`, `search.ts`,
  `home.ts`, `archiveData.ts`) — the phone reuses them, and a peer may have
  uncommitted work in the same file.

**Precise measurement answers the wrong question when the question is "does
this look right."** The Fluent 2 sidebar refresh (`TODO.md`, 2026-09-09) spent
several rounds proving a chevron centered to 0.5px and a marker column's math
correct against the TreeView spec, while the actual defect was one level up —
TreeView was the wrong component archetype for what the design wanted
(Fluent's flatter NavDrawer). `getBoundingClientRect` verifies a claim once you
know what to check; it does not tell you whether you are checking the right
thing. Look at the screen first, especially when a critique is about how
something reads rather than whether it matches a spec.

**Cost is real.** `analyze` spends money per photo. The whole 18-day trip cost
under £8 for 4,181 photos on Gemini; on DeepSeek the same work is single-digit
yuan. Show an estimate before spending, and never re-run over the library
casually.

**The writing has a register, and it was chosen on purpose.** A trip narrative is
**a plain written account with the life left in it** — concrete, in order, in the
traveller's own voice. Warm is allowed; literary is not. Named and forbidden in
`tripPrompt`: interpretation ("what it meant"), closing flourishes and aphorisms
("it turned out to be enough"), metaphors, telling the reader how to feel, photo
counts and distances, and **naming the trip inside its own narrative**. Each of
those was a real output that had to be argued out of it.

**Rolling the dice does not change a voice.** Three runs on one input produced
the same travel-essay mode every time, so the register is the model's reading of
"write a diary", not sampling noise — a `prompt` change is the only lever. When a
generated text reads wrong, regenerate *after* fixing the prompt, not instead of.

**The second language is written, not translated.** `altInstructions` asks for the
twin `_alt` fields to be composed **directly** in that language; asking for "the
same content written in X" produced translationese in both providers — Gemini's
stored narratives read "低地国家以其充满活力的建筑奇观……迎接了我". And on the
OpenAI-compatible path the `_alt` fields must be listed in the JSON shape, or the
model is told about fields it cannot see (see the regressions above).
