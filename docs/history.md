# History — regressions and measurements

Records, not rules. Kept because the measurements are the reasoning a future change has to answer to.

## Past regressions, now fixed

Two things reported by the owner turned out to trace back to one bad edit of
mine: I replaced a slice of `app/src/style.css` between two text markers and it
silently took everything in between.

- **Map styling** — recovered from `c65bc5b` and verified (380px canvas, sea
  colour, 23 city markers).
- **Settings performance** — fixed 2026-09-08. See `TODO.md`'s Resolved list
  for the two separate causes and the numbers.

The other two gaps were closed the same day: `scan` can now be triggered from
the app (`POST /jobs/scan`, three modes in Settings), and the missing-`.env`
dialog is now a **Settings > Generation** form that writes the key and applies
it without a restart. Both are in `TODO.md`'s Resolved list.

**2026-09-24 — a day of "it was already broken by the fix."** Worth reading as a
class, because three of the four were self-inflicted within the same session:

- **Save-as-PDF had not disappeared; its button was never created.**
  `addExportButton` ran `if (!canPrint()) return` while the header was still
  being built, before any photograph existed in the DOM. The count was always
  zero, so the button never appeared on any page. The check is deferred now.
  (A second, real defect in the same area: `exportableImages` and `slotPxFor`
  knew only the card layout, so a grid export would have embedded full-size
  images.)
- **The print toast could not be cancelled and would not go away.** Two separate
  causes: nothing checked for an interruption during the encode loop (fixed with
  an `AbortSignal` and a Cancel button), and then `#print-progress` grew an
  unconditional `display: flex` — my own addition of that button — which
  outranked `[hidden]` and left it on screen forever.
- **A nested job's work was overwritten by the caller's stale copy.** `runTrip`
  summarises missing days via `runOrganize`, which saves the index; `runTrip`
  then re-bucketed days from the copy it had read *before* that, writing the
  empty days back. Symptom: "1 day summarized", and the day still had no summary.
- **The `_alt` second-language fields were never requested.** The instruction
  said "every text field has a twin ending in `_alt`", but on the OpenAI-compatible
  path the only place those fields exist is the JSON shape in the prompt, and it
  listed none of them. Gemini got them from `withAltFields` in its schema, so
  only Gemini wrote them.


---

## Local models, measured (2026-10-07)

Can an LM Studio model stand in for the cloud model on the two things the AI
layer does — caption a photo and summarise a day? Asked because Ollama is
retired and a local call costs nothing. Measured on `google/gemma-4-e4b` at
`127.0.0.1:1234/v1` against the **stored Gemini captions and day summaries
already in the archive**, so the comparison spent nothing — no Gemini call was
made. Harness: `pipeline/scripts/bench-local.mjs`, read-only, seed 20261007;
raw JSON under `data/bakeoff/local-2026-10-07{,-ctx12k}/` (gitignored).

**Two defects surfaced before any quality number did.**

1. LM Studio answers **400** to OpenAI's
   `response_format:{"type":"json_object"}` (it accepts only `json_schema` or
   `text`), and the `ollama` preset's unset `jsonMode` sends exactly that — so
   the very first caption call failed. LM Studio is a different service from
   Ollama (port, and this), so it now has its own preset (`lmstudio`,
   `jsonMode: "prompt"`); the prompts already ask for one JSON object and
   `looseJson` unwraps a fence, so nothing else changed. The running app was
   switched to it through the Settings save path and reported `ready`.
2. LM Studio JIT-loads the model at **8,192** tokens although its ceiling is
   131,072. A day summary needs ~13,160, so it is refused with
   `exceed_context_size_error`. A 12,288 load worked and rescued days that
   failed at 8,192; **16,384 would not load at all** on this 8 GiB card
   (`llama-server` died at 38% — measured 7,156 MiB at 12,288 and
   7,349–7,461 MiB at 8,192). 93 of 357 written days (26%; median day 3,371
   tokens, p90 15,056) do not fit 8,192. Buying context with CPU offload does
   not work either: 32,768 loads only at `--gpu 0.5`, where generation fell to
   ~7 t/s (17 W on a 115 W card — CPU-bound) and the largest day (345 photos)
   died with `fetch failed` after **25.7 minutes**. The route that does work is
   the smaller model: `gemma4-e2b` at 65,536 in full offload (6,225 MiB)
   summarised that same day in **45.6 s**, register-clean though less specific
   than the cloud. On this card, longer context means a smaller model.

Optional knobs written to `.env` for the run and their final value:
`AI_PROVIDER` (set to `lmstudio`, **restored to `deepseek`**), and
`LMSTUDIO_BASE_URL` / `LMSTUDIO_MODEL` / `LMSTUDIO_API_KEY` (left in place,
matching the preset). `PROXY_AI_MODE` was left at `system`: `proxy.ts` never
proxies `localhost`/`127.0.0.1`, so the local endpoint was never at risk of the
proxy and Gemini stayed reachable for nothing (no Gemini call was made).

### What it produced

| | n | local | cloud (same sample) | cloud (whole pool) |
|---|---|---|---|---|
| caption schema OK | 123 model calls | **123 (100%)** | — | — |
| `finish_reason` stop (no truncation) | 123 | 123 | — | — |
| naming: the stop title's key word named | 12 | **5 (42%)** | 8 (67%) | 304/448 (68%) |
| naming: any title word named | 12 | **8 (67%)** | 11 (92%) | 392/448 (88%) |
| document transcript, word-set Jaccard | 12 | **median 0.79** (length 0.78×) | — | — |
| invented place names, hand-checked | 30 | **0** | — | — |
| day register violations | 3 produced | **0** | — | — |

The naming denominators are the whole pool — every camera photo whose own OCR
carries a word of its day's stop title (448), not the 144 the cloud missed. On
the sample the cloud named 67% of the key words and the local model 42%: **25
points lower, past the 10-point bar**, and of the four the cloud missed the
local named **none**. (The key word alone is a weak name sometimes — "Making"
from "Museum of Making" — so the any-word row is reported beside it; the gap
holds at 67% vs 92%.)

Caption latency: median 20–25 s a photo, p90 ~26–29 s. A six-image
`captionPhotos` batch returned all six in order in 57 s (9.5 s an image, ~2×
throughput) with no truncation, so the batch path itself is sound. Determinism
is weak: the same thumbnail twice gave an identical caption **1 of 8 times**
(content_type same 6/8, tag-set Jaccard 0.74) at temperature 0 — harmless when a
photo is captioned once, fatal to a naive A/B.

Day summaries: **3 of 5 attempts produced text** — one lost to the
`parseDaySummary` crash now in TODO, one to a 195-second run that returned
"empty message" after five tries. Every one that produced text had clean
register (no photo counts, distances, trip name or flourish; read, not only
grepped).

### Verdict

**Caption: no-go as a stand-in for Gemini.** The schema path is solid (100%, no
truncation, batch works), but naming is 25 points down and the document tail is
bad: a four-language museum label came back as `Generationen` four times, and
"Cradle to Grave" was replaced by an invented essay about the human body. It is
a plausible *supplement* — local, free, fine for unremarkable snapshots — not a
replacement.

**Day summary: no-go at the default load — and not the easier task.** The prose
and register are good, which is what the pure-text intuition expects; what fails
is everything around it — 26% of days do not fit the loaded context, the parse
crashes on a reply that omits a field, and a large day can come back empty.
Harden the parser (TODO) and budget the day input to the context and it is worth
a second look; as shipped it cannot replace `organize`.

**Worst samples.**
- `IMG_20260917_105733 1.jpg` — a German/French/Italian/English museum label;
  local `extracted_text` was `"Generationen\nGenerationen\nGenerationen\nGenerationen"`.
- `IMG_20230812_144804.jpg` — the "Cradle to Grave" placard; local invented
  "God's Gift to Humanity… the human body is a marvel of engineering"
  (word-set Jaccard 0.08).
- `IMG_20230809_121619.jpg` — captioned "museum label" one run and "museum
  plaque" the next, with an identical image; 7 of 8 pairs moved like that.

### Object recognition on a museum day, and the concurrency crash (2026-10-07)

The follow-up question was narrower than "is it good": on a day that is mostly
artworks, does the model name the **specific** thing — the painter, the work —
or only describe the room? Day 2026-08-31 (a city: the palace, another museum,
the museum Museum; 359 photos) captioned by both models and scored
against the museum's own placards: a proper noun in a caption is *grounded* when
it also appears in the OCR, *agreed* when it appears in the cloud caption, and
*neither* otherwise. On the 197 photos both models completed:

| | e2b (2B) | e4b (4B) | cloud |
|---|---|---|---|
| proper noun grounded in OCR | 18 (9%) | **24 (12%)** | — |
| proper noun agreed with cloud | 18 (9%) | **32 (16%)** | — |
| named any specific subject | 22 (11%) | **33 (17%)** | — |
| document word-set Jaccard (median) | 0.49 | **0.58** | — |
| caption median latency | 12.7 s (∥4) | 15.5 s (∥2) | ~2 s |

Both describe more than they name, and neither approaches the cloud, which
names Schönbrunn, the the palace and the painter consistently. e4b is the better of
the two — it read "Hunters in the Snow" and "Pieter the painter" off a catalogue
page where e2b read "a group of harlots", and "U4-Station Schönbrunn" where e2b
read "a public transport monument" — but it still leaves most artworks as "a
painting" or "a plaque". The failure is **under-naming**, not invention (few
proper nouns were in neither source and wrong), with the occasional garbled read
(e2b turned "Pieter the painter the Elder" into "Pietre Brugel d. Á.").

**The run also produced the sharpest operational finding of the day.** e2b at
`--concurrency 4` crashed the LM Studio engine once: it logged `Channel Error`
and JIT-reloaded the model at the **default 8,192**, and **104 of 359 calls
failed** (91 `fetch failed` in flight at the crash, 4 unloaded, 4 context
exceeded, 2 the model's own bad JSON). VRAM was not exhausted (6.3 of 8.0 GB)
and the GPU sat at 68 °C, so it is the parallel multimodal path rather than
memory or heat — though the tightness shows up elsewhere: at `--parallel 2` the
engine logged `alloc: failed to allocate memory for prompt cache state` and cut
the prefix cache to 2,137 MiB, which is why single calls felt slower (no prefix
reuse). **e4b at `--concurrency 2` did not crash** (199 of 200). Batch local
captioning should use two streams, not four; see the TODO for the pipeline
consequences (it runs four, and a 400 carrying `fetch failed` is not retried).

Raw JSON: `data/bakeoff/local-2026-08-31-{e2b,e4b}/` (gitignored).


