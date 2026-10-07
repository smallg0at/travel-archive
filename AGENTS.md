# AGENTS.md

`travel-archive` — a personal OneDrive photo archive (~31,700 photos, 2016–2026),
built as four workspaces: `shared/` (schema), `pipeline/` (jobs + local server),
`app/` (reader), `desktop/` (Electron shell).

## Read before working here

This file is the short entry point; the depth lives in the repo:

- **`HANDOFF.md`** — required reading. The invariants, and especially
  **"How to work on this"** (the most useful section in this repo).
- **`TODO.md`** — the live checklist; the only trustworthy source of what is
  outstanding.
- `README.md` — how the pipeline works. `docs/design-brief.md` — what the
  product is. `MOBILE-BRIEF.md` — the phone app.

Keep this file short; don't restate what those already cover.

## How to work

- **Run to completion when the user is away (AFK).** The user often leaves
  mid-task and expects it finished unattended. Do not stop to confirm reversible
  steps: pick the sensible option, say which you picked, and keep going. Stop and
  wait only for — destructive or irreversible operations (deleting data,
  force-push, mass rewrites, anything that spends money); genuine ambiguity where
  a wrong guess wastes the work; or a hard external blocker. If you must stop,
  end with a one-line `needs the user:` note.
- **Report progress.** On anything long, emit 1–3 lines per stage (roughly every
  8–10 tool calls): what you are doing, the current conclusion, any blocker.
  Never grind through dozens of tool calls in silence.
- **Measure before asserting** — see `HANDOFF.md` → "How to work on this".
- **Keep the docs alive.** A new durable lesson goes in `HANDOFF.md`; changed
  outstanding work goes in `TODO.md`.
