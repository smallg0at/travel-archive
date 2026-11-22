# travel-archive for DeepSeek Harness

Five **read-only** tools that let an agent read this photo archive: search it,
open a trip's story, look at one photo, and see what the pipeline is doing.

```
archive_status   is it healthy, how much is in it, what is the pipeline doing
archive_search   captions, tags, places and dates → photo ids (English or Chinese)
archive_trip     one trip: name, dates, places, narrative, day by day
archive_photo    one photo: date, place, caption, tags, thumbnail URL
archive_jobs     running job + recent history (read only — never starts one)
```

## Seeing the whole thing, not a slice

Every answer stops at 4000 characters, so "show me everything" has to be walked
rather than dumped. Three arguments do that, and they came from watching four
agents fail to answer questions the archive could have answered:

```
archive_trip day=2026-08-31     that one day, in full — every stop, not the first six
archive_trip offset=3 days=2    page through a long trip
archive_search offset=40        the next page of the same result
archive_search sort=oldest      walk a day forwards instead of backwards
archive_search brief=true       date · place · id only, forty rows at a time
```

The failures they replaced: `archive_trip(date=…)` used to start the day list at
day one whenever the requested date was outside the section or the section was a
month, so "what did I do on 31 August" answered about 16 August and then got
clipped; and a single day of 359 photos could only be seen ten at a time with no
way to ask for the rest, so agents guessed keywords instead of enumerating. Word
guessing has a characteristic failure: it looks like an empty archive.

It is a DeepSeek Harness *bundle*: a `cordis.patch.yml` that mounts one Host
plugin row, plus plain-JS code. No build step, no dependencies, no
`@deepseek-ai/*` import — a profile plugin resolves from its own directory
outward, lands inside `app.asar`, and cannot resolve those, so this file imports
`node:` built-ins only.

## Why it talks HTTP instead of reading the archive

`docs/invariants.md`: **the server is the only writer**. A plugin that opened
`index.json` itself would be a second reader that silently disagrees with it, and
the screenshot descriptions — deliberately never on disk, never in `search.json`
— only exist behind that server. So every tool is a GET against
`http://127.0.0.1:18419` (loopback, no auth of its own), exactly like the app.

The one thing that is *not* a GET is nothing: no tool starts a job. `analyze`
spends money, so starting it stays the owner's decision, in the app or a terminal.

## When the server is not running

Every route falls back to the `pipeline/data` mirror, which holds identical bytes
(a save writes local first). The answers then carry a first line saying so:

```
⚠ The server is not running (http://127.0.0.1:18419), so this comes from the
pipeline/data mirror and may lag OneDrive. start it: npm run build -w pipeline
&& npm run serve -w pipeline
```

What the mirror cannot answer, it says instead of guessing: `/health` and the
live job table are the server's memory (`archive_jobs` reads finished jobs off
`data/jobs/*.json` and labels them). If the mirror is unreadable too, the tool
**fails loudly** — naming the URL it tried, the file it tried, the reason, and
the command — rather than returning an empty list that an agent would report as
"there is nothing there".

## Reading it in Chinese

Pass `lang: "zh-Hans"` to `archive_search`, `archive_trip` or `archive_photo`.
Without `lang` nothing extra is read: the English originals are the archive's own
text.

Three traps are handled here, and each one was measured rather than assumed:

- **`search.json` lowercases its captions at build time.** A translation key
  computed from them matches *nothing* (measured: 0/1268 for 2024-11, against 4/4
  from the month shard). So a `lang` search reads `photos/<month>.json` — original
  capitalisation — plus `i18n/<lang>/photos/<month>.json`, which is why it
  requires `month=` or a range of at most 12 months instead of quietly falling
  back to English.
- **Translation keys are `textKey()`**, a cyrb53 variant in
  `shared/src/types.ts`. It is copied verbatim in `index.js` (importing it would
  need the repo's TypeScript built), and `smoke.mjs` checks the copy against the
  real translation file — a drifted copy fails the run instead of turning every
  translation into "missing".
- **`index.languages` is optional and often absent**, even when `i18n/zh-Hans/`
  is full. Available languages are therefore the union of that field and the
  directories on disk, so an archive can be read in Chinese without its index
  saying so.

Owner edits win over machine translations (`owner`/`tripOwner` in the index
sidecar), then the translation, then the original — a missing translation
degrades to English, never to nothing. Each translated answer reports its
coverage, so "2 hits" is never mistaken for "the archive says this twice".

## Choosing a photo without opening all of them

`archive_search brief=true` enumerates a day as `date · place · reference`, up
to 40 rows per call, and `offset=` walks the rest. The reference is a short id
(`p2615` for `2EDA5BB960073185!2615`): derived from the id rather than assigned,
so it is stable between calls and across languages. `archive_photo` takes it
back, along with the bare suffix or the full id. The reference is looked up as
given first and only then read as an alias, so a photo whose suffix literally
starts with `p` is not shadowed by the number after it. Ids whose suffix is not a
number (screen captures) are printed in full instead of getting a misleading
alias.

`archive_photo` answers the first question first — `Source: 4096×3072
(landscape, 1.33:1) · 5.5 MB original` — because the record already carries
`width`, `height` and `bytes`; nothing is downloaded to find out. Then the three
rendition URLs.

Measured, not assumed: `small` is a `404`, `Range` requests are ignored, and
renditions are built on demand, so the first fetch of a large photo can be slow
and a burst of them answers `503`. There is no 1280/1920 width step and no `?w=`
— that is a server change, not a plugin one, and it sits outside this
integration's read-only surface.

**Follow-up, when the server ships `?w=`.** The pipeline checkout already has it
under review: `?w=` on any of the three URLs, rounded **up** to a rung of
`160, 240, 320, 480, 640, 800, 960, 1280, 1920, 2560, 3200, 4096`, never enlarged
past the source, with `X-Image-Width` reporting the width actually delivered and
a `400` (not a silent fallback to the original) for a value that is not a width.
It is **not** in the running build yet, so the paragraph above is still the truth
here; once a package carries it, the three rendition lines in `runPhoto` should
say so, and `?w=abs` should stop looking like success.

## What it refuses to answer quietly

Five failures that look like answers, each found by breaking the server on
purpose and then fixed here:

| Situation | What happens now |
| --- | --- |
| Something answers `200` with HTML (an SPA shell, a proxy's error page) | `answered but not JSON`, and **no** mirror fallback: the server is talking, so its answer is the problem |
| `lang` names the archive's own source language | reading the originals — no `i18n/en/` lookup, so no 404 and no "0 hits" |
| A month's translation file the server refuses (403/421/500) | the search fails; only a `404` (that month is not translated yet) costs a month |
| `i18n/<lang>/` exists but holds no file | not a language: a directory left by a half-finished run would answer every lookup with nothing |
| A server that accepts the connection and never replies | one timeout, then the mirror for ten seconds — a remembered miss, not two timeouts per call. Short on purpose: a server started while you work must be noticed |

The read cache is bounded too (24 entries / 64 MB, evicted in use order): the
parsed `index.json` and `search.json` alone are ~17 MB, and an unbounded map is
how a plugin leaks its host.

Every answer is capped at 4000 characters, cut at the **last complete line** and
labelled with what was shown (`… truncated at 3748 of 7365 characters — narrow it
(month=, from/to, limit=, brief)`). A cut in the middle of a stop reads like a
short stop; a labelled cut reads like a list to continue with `offset=`.

## Install (the desktop profile)

The profile is `C:\Users\small\.dsh\profiles\desktop`. A bundle patch is applied
at **boot**, so this needs one restart of DeepSeek Harness at the end.

```powershell
# 1. back up the profile manifest
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\package.json" `
          "$env:USERPROFILE\.dsh\profiles\desktop\package.json.bak-travel-archive"

# 2. link the package into the profile (no network, no pnpm install)
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local\travel-archive" `
         -Target "C:\Code\proj\integrations\dsh"
```

then in `package.json`: add `"@local/travel-archive": "link:C:/Code/proj/integrations/dsh"`
to `dependencies`, and `"@local/travel-archive"` to the `dsh.profile.bundles`
array. Restart DeepSeek Harness.

`profile/cordis.patch.yml` is *not* touched: the bundle ships its own patch, and
the profile only has to list the package.

To change settings (a different port, or a copy installed outside this repo,
where the default `../../pipeline/data` no longer points at the archive), edit
`cordis.patch.yml` here — `baseUrl`, `dataDir`, `timeoutMs`, `cacheTtlMs`. A
config change re-runs the plugin, which clears its read cache.

### Uninstall

Delete the junction, remove the two lines from the profile `package.json`,
restore the `.bak`, restart. Nothing was written anywhere else.

## Checking it works

`smoke.mjs` mounts the plugin with a fake Host context, runs every tool against
the live server, and then against a dead port and a broken mirror. There is no
`node` on PATH here, so it runs on the Electron binary:

```powershell
$env:ELECTRON_RUN_AS_NODE=1
& 'C:\Users\small\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe' `
    -e "(async()=>{await import('file:///C:/Code/proj/integrations/dsh/smoke.mjs')})()"
```

Forward slashes matter: a backslash path inside `-e` is mangled by the Windows
argument parser. Every check prints PASS or FAIL, and a failure exits 1.

After a restart, the same thing through the real tools:

```
archive_status
archive_search q=Dalian
archive_search q=博物馆 month=2024-11 lang=zh-Hans
```

## Deliberately not here

Starting jobs (money), writing captions or translations back, client-side panels,
inline images (a thumbnail **URL** is returned; the reader turns it into pixels),
and decrypting the screenshot descriptions — those stay behind the reader, by
design. The project is still churning, so this stays a thin client of the HTTP
surface the app already uses: when the pipeline changes, it changes here too, and
when this plugin is wrong the smoke run says so.
