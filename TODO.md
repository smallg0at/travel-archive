# TODO

The open-item list is **not in this repository**. It lives in a private,
user-owned GitHub Project, because the entries carry measurements that name real
places, devices and dates, and this repository is meant to be public.

Its address and its ids are deliberately **not** written down here. This
repository is public, they would identify the owner, and an outsider could not
open a private project anyway. The machine-readable copy is `private/todo.json`
(gitignored): the project id, and the `Status` and `area` field ids with their
option ids. `scripts/todo.mjs` reads it and says so if it is missing; set
`TODO_CONFIG` to keep it somewhere else.

## Using it

`scripts/todo.mjs` is the CLI. Use it rather than hand-writing `gh` or GraphQL:
the raw surface is hostile — `gh project` has no item-read command, every field
value is an opaque option id, the item listing is eventually consistent, and
`gh` exits 0 whether or not anything happened. The script adds a read path for
one item, a read-back after every write, and failures that name the valid
options.

```powershell
# in an agent shell there is no PATH; docs/environment.md says how to reach node
node scripts\todo.mjs list                      # id, status, area, title — every item
node scripts\todo.mjs list --json
node scripts\todo.mjs show     <item-id>        # title, status, area, body
node scripts\todo.mjs add      --title "One-line summary" --area app --body-file tmp.md
node scripts\todo.mjs set-area <item-id> app
node scripts\todo.mjs set-body <item-id> --body-file evidence.md --append   # keep the body, add to it
node scripts\todo.mjs close    <item-id>
```

Exit codes: `0` **verified** · `1` failed · `2` usage · `3` written but not
visible yet (GitHub's read lag — re-check with `show`, do not repeat the write).

**Use a draft item, not a GitHub issue.** An issue would be public with the
repository; a draft item lives only in the Project. One-time auth is
`gh auth refresh -s project`.

The title is the one-line entry; the body is the measurement — what was
measured, what it means, what the fix is.

## Under the hood

Only needed to extend the script, or to go around it. The field and option ids
live in `private/todo.json`, next to the script that consumes them.

`--owner @me` does **not** work on this machine (`unknown owner type`); always
pass the login. And the item listing is **eventually consistent** — right after a
write it can under-report for minutes, and different query shapes return
different counts. A write returns a valid item id immediately, so do not
conclude it failed; the web UI is authoritative.

## Where the rest went

- The entries that were here were moved verbatim into the Project on
  2026-10-07 — copy on GitHub, nothing to keep in the repo.
- Everything closed before that, with the measurements that closed it, is in
  `private/TODO-history.md` — kept on disk, not committed (see
  `private/README.md`), because it is a travel history in prose.
