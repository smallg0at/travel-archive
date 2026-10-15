# History — regressions and measurements

Records, not rules. Kept because the measurements are the reasoning a future change has to answer to.

## Past regressions, now fixed

Two things reported by the owner turned out to trace back to one bad edit of
mine: I replaced a slice of `app/src/style.css` between two text markers and it
silently took everything in between.

- **Map styling** — recovered from `c65bc5b` and verified (380px canvas, sea
  colour, 23 city markers).
- **Settings performance** — fixed 2026-09-08. See the Resolved list in the
  archived TODO (`private/TODO-history.md`, not committed) for the two separate
  causes and the numbers.

The other two gaps were closed the same day: `scan` can now be triggered from
the app (`POST /jobs/scan`, three modes in Settings), and the missing-`.env`
dialog is now a **Settings > Generation** form that writes the key and applies
it without a restart. Both are in that same archived list.

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
raw JSON under `data/bakeoff/` (gitignored).

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
out of a museum's own name — so the any-word row is reported beside it; the gap
holds at 67% vs 92%.)

Caption latency: median 20–25 s a photo, p90 ~26–29 s. A six-image
`captionPhotos` batch returned all six in order in 57 s (9.5 s an image, ~2×
throughput) with no truncation, so the batch path itself is sound. Determinism
is weak: the same thumbnail twice gave an identical caption **1 of 8 times**
(content_type same 6/8, tag-set Jaccard 0.74) at temperature 0 — harmless when a
photo is captioned once, fatal to a naive A/B.

Day summaries: **3 of 5 attempts produced text** — one lost to the
`parseDaySummary` crash now in the private Project, one to a 195-second run that
returned "empty message" after five tries. Every one that produced text had
clean register (no photo counts, distances, trip name or flourish; read, not
only grepped).

### Verdict

**Caption: no-go as a stand-in for Gemini.** The schema path is solid (100%, no
truncation, batch works), but naming is 25 points down and the document tail is
bad: a four-language museum label came back as `Generationen` four times, and
one exhibit placard was replaced by an invented essay about the human body. It
is a plausible *supplement* — local, free, fine for unremarkable snapshots — not
a replacement.

**Day summary: no-go at the default load — and not the easier task.** The prose
and register are good, which is what the pure-text intuition expects; what fails
is everything around it — 26% of days do not fit the loaded context, the parse
crashes on a reply that omits a field, and a large day can come back empty.
Harden the parser and budget the day input to the context and it is worth a
second look; as shipped it cannot replace `organize`.

**Worst samples.**
- One photo of a German/French/Italian/English museum label; local
  `extracted_text` was `"Generationen\nGenerationen\nGenerationen\nGenerationen"`.
- An exhibit placard; local invented "God's Gift to Humanity… the human body is
  a marvel of engineering" (word-set Jaccard 0.08).
- One photo captioned "museum label" on one run and "museum plaque" on the
  next, with an identical image; 7 of 8 pairs moved like that.

### Object recognition on a museum day, and the concurrency crash (2026-10-07)

The follow-up question was narrower than "is it good": on a day that is mostly
artworks, does the model name the **specific** thing — the painter, the work —
or only describe the room? A 359-photo museum day (three museums in one city),
captioned by both models and scored against the museums' own placards: a proper
noun in a caption is *grounded* when it also appears in the OCR, *agreed* when
it appears in the cloud caption, and *neither* otherwise. On the 197 photos both
models completed:

| | e2b (2B) | e4b (4B) | cloud |
|---|---|---|---|
| proper noun grounded in OCR | 18 (9%) | **24 (12%)** | — |
| proper noun agreed with cloud | 18 (9%) | **32 (16%)** | — |
| named any specific subject | 22 (11%) | **33 (17%)** | — |
| document word-set Jaccard (median) | 0.49 | **0.58** | — |
| caption median latency | 12.7 s (∥4) | 15.5 s (∥2) | ~2 s |

Both describe more than they name, and neither approaches the cloud, which
names the landmarks and painters consistently. e4b is the better of the two —
it read a famous painting and its painter off a catalogue page where e2b read
"a group of harlots", and a metro-station name where e2b read "a public
transport monument" — but it still leaves most artworks as "a painting" or "a
plaque". The failure is **under-naming**, not invention (few proper nouns were
in neither source and wrong), with the occasional garbled read (e2b misspelled
the painter's name).

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
captioning should use two streams, not four; see the private Project for the
pipeline consequences (it runs four, and a 400 carrying `fetch failed` is not
retried).

Raw JSON: under `data/bakeoff/` (gitignored).


---

## A local captioner that is good enough (2026-10-13)

The 2026-10-07 pass asked whether a local model could stand in for the cloud on a
whole job and answered no. This one asks the narrower question the screenshot
pass actually needs — can a local model describe a photograph, and transcribe
what is written on it, without the photograph leaving the machine — and two
things changed the answer: a better model fits the card, and its thinking can be
turned off.

`qwen/qwen3.5-9b` (9B dense, vision, Apache 2.0, 5.4 GB at Q4_K_M) loads at
`ctx 8192 / parallel 2` in **6,166 MiB**, leaving about 1.7 GiB of the 8 GiB
card free. Measured against the same stored Gemini captions, same seed and pools,
one instance loaded, `reasoning_effort: "none"`:

| | n | cloud | gemma-4-e4b (thinking on) | gemma-4-e4b (off) | qwen3.5-9b (off) |
|---|---|---|---|---|---|
| naming: the stop title's key word named | 12 | 8 (67%) | 4–5 (33–42%) | 3 (25%) | **5 (42%)** |
| naming: any title word named | 12 | 10 (83%) | — | 5 (42%) | **8 (67%)** |
| document transcript, word-set Jaccard | 12 | — | 0.83–0.88 | 0.94 | **1.00** |
| transcript length, against the cloud's | 12 | 1.00 | 0.87–0.88 | 0.76 | **0.95** |
| documents that produced no text at all | 12 | 0 | 0 | 1 | **0** |
| median seconds for one caption | 12 | — | 24–33 | 5.6–8.0 | 11.5–12.3 |

The local path is no longer the weak one at transcription: Jaccard 1.00 and 0.95
of the cloud's length means it reads a page the way the cloud does. It loses
nothing measured here except wall clock, and it beats gemma-4-e4b on every
quality row. The 32-screenshot set says the same thing in prose —
`RJX13479 from a main station to an airport`,
`a scenic express from a junction to a city`, `a Google Maps route from one
museum to another` — against gemma's `a train journey schedule`. (The thinking-on
columns ran one sentence of the
brief earlier; that is not a controlled pair, though a sentence about script
fidelity does not explain 0.87 against 0.76.)

**Thinking is nearly all of the cost and none of the value here.** A question
whose answer is one word costs 168–192 completion tokens and 12–14 seconds with
thinking, 2 tokens and 0.6 seconds without; one caption generation passed **2,387
tokens** in the engine log before it was stopped, and our own `MAX_OUTPUT` ceiling
of 16,384 for a single caption would have let it run on. Four plausible ways to
turn it off are no-ops on this engine — `enable_thinking`, `chat_template_kwargs`,
`thinking`/`enable_reasoning`, and `/no_think` in a user or a system turn — and the
last is worse than nothing: the model spends the entire budget thinking and
answers with an empty string, which is also why a low `max_tokens` is not a safe
bound. `reasoning_effort: "none"` works, and is what the local presets now send.

**Do not turn it off for gemma.** Without thinking its transcription lost a
quarter of its volume (0.87 → 0.76 of the cloud's length) and one document in
twelve produced nothing. The knob is per provider rather than per model, so the
preset default is `none` — right for the recommended local model — with
`LMSTUDIO_REASONING_EFFORT=auto` as the escape hatch.

Two script-fidelity defects, both from the local model and neither present in the
archive's cloud-written Chinese (665,353 Han characters, of which 415 are
Traditional-only — and those are Qing-dynasty steles photographed in museums,
Traditional by nature):

- 舒适度 came back as 舒 followed by U+CF8C, a Hangul syllable: a cross-lingual
  look-alike, valid UTF-8, so a decode bug it is not.
- A 2017 Simplified school notice came back as 活動教室 / 體能 / 護膚 / 藝術 where
  the cloud read 活动教室 / 体能 / 护肤 / 艺术.

Both matter for the same reason — `extracted_text` is what content search matches
on, and 活動教室 can never match 活动教室. The caption brief now asks for the
script *and* the form (Chinese stays Chinese, never look-alike kana or Hangul,
never a Simplified↔Traditional conversion), and `test/captionPrompt.test.ts`
carries both examples so the sentences cannot quietly disappear.

The brief that cannot leak a chat moved to `screenshotPrompt.ts` the same day,
after being tried inside the ordinary caption brief and measured as too expensive
there: naming 42% → 25%, transcription 0.88 → 0.73 of the cloud's with one train
ticket suppressed outright, 24 → 32–37 seconds a call — paid on material that is
not private at all.
