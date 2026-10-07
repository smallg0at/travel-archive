# TODO

The open-item list is **not in this repository**. It lives in a private,
user-owned GitHub Project, because the entries carry measurements that name real
places, devices and dates, and this repository is meant to be public.

**the private project** — project `travel-archive`,
`public=false`, deliberately **not** linked to this repo.

| | |
|---|---|
| project id | `PVT_the_private_project` |
| `Status` field | `PVTSSF_lAHOAdS-ts4BmFV8zhkvuIo` — Todo `f75ad846`, In Progress `47fc9ee4`, Done `98236657` |
| `area` field | `PVTSSF_lAHOAdS-ts4BmFV8zhkvvRs` — analyze `a436d721`, app `790b78b7`, desktop `219cbb8c`, map `a42e6712`, phone `d5e4b3f9`, print `9518c8d3`, providers `394afc3f`, remote `f92357ae`, scan `3cd4cc4f`, server `58c019bd`, summarize `fdc08c84`, sync `edea46cd`, trips `154eac38`, ui `24dc71d2` |

## Reading it

```powershell
gh project item-list 2 --owner smallg0at                 # or open the URL
```

## Adding or changing an item

**Use a draft item, not a GitHub issue.** An issue would be public with the
repository; a draft item lives only in the Project. One-time auth first:
`gh auth refresh -s project`.

```powershell
# add one — title is the one-line entry, body is the measurement
$item = gh project item-create 2 --owner smallg0at `
  --title "One-line summary of the item" `
  --body "What was measured, what it means, what the fix is." --format json | ConvertFrom-Json

# set its area (option ids from `gh project field-list 2 --owner smallg0at`)
gh project item-edit --id $item.id --project-id PVT_the_private_project `
  --field-id PVTSSF_lAHOAdS-ts4BmFV8zhkvvRs --single-select-option-id <area-option-id>

# close it -> Status = Done
gh project item-edit --id $item.id --project-id PVT_the_private_project `
  --field-id PVTSSF_lAHOAdS-ts4BmFV8zhkvuIo --single-select-option-id 98236657
```

`--owner @me` does **not** work on this machine (`unknown owner type`); always
pass the login. And the Project's item list is **eventually consistent** — right
after creating, `gh project item-list` can under-report for minutes and
different queries return different counts. Creation returns a valid item id
immediately, so do not conclude it failed; the web UI is authoritative.

## Where the rest went

- The 25 entries that were here were moved verbatim into the Project on
  2026-10-07 — copy on GitHub, nothing to keep in the repo.
- Everything closed before that, with the measurements that closed it, is in
  `private/TODO-history.md` — kept on disk, not committed (see
  `private/README.md`), because it is a travel history in prose.
