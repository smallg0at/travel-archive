#!/usr/bin/env node
/**
 * todo.mjs — the CLI for this repo's open-item list.
 *
 * The list is a private, user-owned GitHub Project rather than a file in the
 * repo, so a public repository never carries the entries' measurements. This
 * script is the supported way to read and write it, because the raw surface is
 * hostile to anything that has to reason about it:
 *
 *   - `gh project` has no item-read command at all, so confirming a write means
 *     hand-writing GraphQL with a node lookup and a union spread;
 *   - every field value is an opaque option id that itself has to be looked up;
 *   - the item listing lags by minutes and disagrees with itself between query
 *     shapes, so "did it work?" is unanswerable for a while;
 *   - `gh` exits 0 whether or not the thing happened.
 *
 * So this wraps `gh api graphql` once and adds the three things that make an
 * interface usable by an agent:
 *
 *   1. a read path for one item (`show`);
 *   2. a read-back after every write, so success is measured, not assumed;
 *   3. loud, specific failure — an unknown area lists the valid ones.
 *
 * In the agent shell there is no PATH; see docs/environment.md for how to reach
 * node. This script runs *under* node, so there is nothing to look up here:
 *
 *   node scripts/todo.mjs list
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// --- the project, from a file that is not committed --------------------------
//
// The Project is private and its ids identify its owner, so they live in
// `private/todo.json` (gitignored) rather than in this file: a repository meant
// to be public should not carry a pointer to somebody's private project, and an
// outsider could not use it anyway. Set TODO_CONFIG to keep the file elsewhere.

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = process.env.TODO_CONFIG ?? join(REPO, "private", "todo.json");

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    fail(
      `no ${CONFIG_PATH}. That file holds the private Project's ids and is not ` +
        `committed; see TODO.md for what it contains. Set TODO_CONFIG to point elsewhere.`,
    );
  }
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    fail(`could not parse ${CONFIG_PATH}: ${err.message}`);
  }
}

const config = loadConfig();
const PROJECT_ID = config.projectId;
const STATUS = config.status;
const AREA = config.area;

if (!PROJECT_ID || !STATUS?.field || !STATUS.options || !AREA?.field || !AREA.options) {
  fail(`${CONFIG_PATH} needs projectId, status.{field,options} and area.{field,options}`);
}

// --- talking to GitHub -------------------------------------------------------

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

/** One GraphQL round trip. The body goes in as JSON on stdin so that nothing
 *  in the query or the body ever meets a shell. */
function graphql(query, variables) {
  const input = JSON.stringify({ query, variables });
  let out;
  try {
    out = execFileSync("gh", ["api", "graphql", "--input", "-"], {
      input,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const detail = String(err.stderr || err.stdout || err.message || "").trim();
    fail(`gh api graphql failed: ${detail}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    fail(`gh api graphql returned something that is not JSON: ${out.slice(0, 200)}`);
  }
  if (parsed.errors?.length) {
    fail(`GraphQL: ${parsed.errors.map((e) => e.message).join("; ")}`);
  }
  return parsed.data;
}

/** The fields `show` and `list` render. A draft item carries its own title and
 *  body; an issue or PR carries a title here and its text lives on GitHub. */
const ITEM = `
  id
  content {
    __typename
    ... on DraftIssue { id title body }
    ... on Issue { title }
    ... on PullRequest { title }
  }
  fieldValues(first: 30) {
    nodes {
      ... on ProjectV2ItemFieldSingleSelectValue {
        name
        field { ... on ProjectV2SingleSelectField { name } }
      }
    }
  }
`;

function shape(node) {
  if (!node) return null;
  const pick = (fieldName) => {
    for (const value of node.fieldValues?.nodes ?? []) {
      if (value?.field?.name === fieldName) return value.name ?? null;
    }
    return null;
  };
  return {
    id: node.id,
    // The DraftIssue node has its own id, and it is the one
    // `updateProjectV2DraftIssue` wants. Only a draft has one.
    draftId: node.content?.__typename === "DraftIssue" ? node.content.id ?? null : null,
    title: node.content?.title ?? "(no title)",
    body: node.content?.body ?? "",
    status: pick("Status"),
    area: pick("area"),
  };
}

function readItem(id) {
  const data = graphql(
    `query($id: ID!) { node(id: $id) { ... on ProjectV2Item { ${ITEM} } } }`,
    { id },
  );
  return shape(data.node);
}

function listItems() {
  const items = [];
  let after = null;
  for (;;) {
    const data = graphql(
      `query($id: ID!, $after: String) {
         node(id: $id) {
           ... on ProjectV2 {
             items(first: 100, after: $after) {
               totalCount
               pageInfo { hasNextPage endCursor }
               nodes { ${ITEM} }
             }
           }
         }
       }`,
      { id: PROJECT_ID, after },
    );
    const connection = data.node.items;
    for (const node of connection.nodes) items.push(shape(node));
    if (!connection.pageInfo.hasNextPage) {
      return { total: connection.totalCount, items };
    }
    after = connection.pageInfo.endCursor;
  }
}

function createDraft(title, body) {
  const data = graphql(
    `mutation($p: ID!, $t: String!, $b: String!) {
       addProjectV2DraftIssue(input: { projectId: $p, title: $t, body: $b }) {
         projectItem { id }
       }
     }`,
    { p: PROJECT_ID, t: title, b: body },
  );
  return data.addProjectV2DraftIssue.projectItem.id;
}

function setOption(itemId, fieldId, optionId) {
  graphql(
    `mutation($p: ID!, $i: ID!, $f: ID!, $o: String!) {
       updateProjectV2ItemFieldValue(
         input: { projectId: $p, itemId: $i, fieldId: $f, value: { singleSelectOptionId: $o } }
       ) { projectV2Item { id } }
     }`,
    { p: PROJECT_ID, i: itemId, f: fieldId, o: optionId },
  );
}

/**
 * Rewrite a draft item's body.
 *
 * The mutation takes the *DraftIssue* node's id, not the ProjectV2Item's — the
 * two are different nodes and passing the item id is rejected. The payload
 * returns `draftIssue`, not `projectItem` (asking for that field is rejected),
 * and nothing in it proves the write: the read-back does that.
 *
 * The input goes over as a variable object so only the keys present are sent —
 * title and body are both optional, and a field left out means "leave it alone".
 */
function updateDraftBody(draftIssueId, fields) {
  graphql(
    `mutation($input: UpdateProjectV2DraftIssueInput!) {
       updateProjectV2DraftIssue(input: $input) { draftIssue { id } }
     }`,
    { input: { draftIssueId, ...fields } },
  );
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read the item back until it shows what was asked for.
 *
 * The write itself returning is not proof, and neither is one read: the item
 * listing is eventually consistent, so a miss straight after a write may just
 * be lag. Retry briefly; if it still disagrees, say exactly that and exit 3 —
 * "written, not yet visible" is a different fact from "failed", and conflating
 * them is how an agent ends up writing the same thing twice.
 *
 * A check value is normally the exact expected value, and may also be a
 * predicate — for anything where the bytes are not the contract, such as a
 * body GitHub may normalise whitespace in.
 */
function readVerified(itemId, checks) {
  let last = null;
  for (const delay of [0, 1500, 3000]) {
    if (delay) sleepSync(delay);
    const item = readItem(itemId);
    if (!item) {
      last = `${itemId} reads back as nothing at all`;
      continue;
    }
    const wrong = Object.entries(checks).filter(([key, want]) => {
      const actual = item[key] ?? null;
      return typeof want === "function" ? !want(actual) : actual !== want;
    });
    if (!wrong.length) return item;
    last = wrong
      .map(([key, want]) => {
        const actual = item[key] ?? null;
        if (typeof want === "function") {
          const shown = actual === null ? "(unset)" : `${JSON.stringify(String(actual).slice(0, 50))} (${String(actual).length} chars)`;
          return `${key}=${shown} (failed the check)`;
        }
        return `${key}="${actual ?? "(unset)"}" (wanted "${want}")`;
      })
      .join(", ");
  }
  console.error(`WROTE, UNVERIFIED: the mutation was accepted but the read back still shows ${last}.`);
  console.error("GitHub's project reads lag by minutes — do not repeat the write.");
  console.error(`Re-check later with:  todo.mjs show ${itemId}`);
  process.exit(3);
}

// --- the command line --------------------------------------------------------

function usage(stream = console.log, code = 0) {
  stream(`todo.mjs — read and write this repo's open-item list (a private GitHub Project)

  list [--json]
  show <item-id> [--json]
  add --title "..." [--area <area>] [--body "..." | --body-file <path>]
  set-area <item-id> <area>
  set-body <item-id> [--body "..." | --body-file <path>] [--append]
  close <item-id>

areas: ${Object.keys(AREA.options).join(", ")}

set-body replaces the item's body, or with --append keeps it and adds the new
text after a --- rule (the way to attach a measurement to an existing entry).
GitHub may normalise whitespace, so the read-back checks the content, not the
exact bytes.

exit: 0 verified · 1 failed · 2 usage · 3 written but not visible yet`);
  process.exit(code);
}

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return { positional, flags };
}

function areaOption(name) {
  const key = String(name).trim().toLowerCase();
  if (!(key in AREA.options)) {
    fail(`unknown area "${name}". Valid: ${Object.keys(AREA.options).join(", ")}`);
  }
  return key;
}

function pad(text, width) {
  return String(text).padEnd(width);
}

const { positional, flags } = parse(process.argv.slice(2));
const [verb, ...rest] = positional;

switch (verb) {
  case undefined:
  case "help":
  case "--help":
    usage(verb === undefined ? console.error : console.log, verb === undefined ? 2 : 0);
    break;

  case "list": {
    const { total, items } = listItems();
    items.sort(
      (a, b) =>
        String(a.area ?? "").localeCompare(String(b.area ?? "")) || a.title.localeCompare(b.title),
    );
    if (flags.json) {
      console.log(JSON.stringify({ total, listed: items.length, items }, null, 2));
      break;
    }
    const done = items.filter((item) => item.status === "Done").length;
    console.log(`${total} items (${done} Done)`);
    if (total !== items.length) {
      console.log(`(GitHub's count and the listing disagree right now: it says ${total}, this read returned ${items.length}. The listing lags — not a bug in this script.)`);
    }
    for (const item of items) {
      console.log(
        `${pad(item.status ?? "(none)", 11)} ${pad(item.area ?? "(none)", 11)} ${item.id}  ${item.title}`,
      );
    }
    break;
  }

  case "show": {
    const id = rest[0];
    if (!id) usage(console.error, 2);
    const item = readItem(id);
    if (!item) fail(`no project item with id ${id}`);
    if (flags.json) {
      console.log(JSON.stringify(item, null, 2));
      break;
    }
    console.log(`id:     ${item.id}`);
    console.log(`title:  ${item.title}`);
    console.log(`status: ${item.status ?? "(none)"}`);
    console.log(`area:   ${item.area ?? "(unset)"}`);
    if (item.body.trim()) {
      console.log("--- body ---");
      console.log(item.body.trimEnd());
    }
    break;
  }

  case "add": {
    const title = typeof flags.title === "string" ? flags.title : null;
    if (!title) usage(console.error, 2);
    let body = "";
    if (typeof flags["body-file"] === "string") {
      try {
        body = readFileSync(flags["body-file"], "utf8");
      } catch (err) {
        fail(`could not read --body-file ${flags["body-file"]}: ${err.message}`);
      }
    } else if (typeof flags.body === "string") {
      body = flags.body;
    }
    const area = typeof flags.area === "string" ? areaOption(flags.area) : null;

    const id = createDraft(title, body);
    if (area) setOption(id, AREA.field, AREA.options[area]);
    const item = area ? readVerified(id, { area }) : readItem(id);
    if (!item) fail(`created ${id} but it does not read back`);
    console.log(
      `created ${item.id}  status=${item.status ?? "(none)"}  area=${item.area ?? "(unset)"}  ${item.title}`,
    );
    break;
  }

  case "set-area": {
    const [id, name] = rest;
    if (!id || !name) usage(console.error, 2);
    const area = areaOption(name);
    setOption(id, AREA.field, AREA.options[area]);
    const item = readVerified(id, { area });
    console.log(`${item.id}  area=${item.area}  ${item.title}`);
    break;
  }

  case "set-body": {
    const id = rest[0];
    if (!id) usage(console.error, 2);
    let incoming = "";
    if (typeof flags["body-file"] === "string") {
      try {
        incoming = readFileSync(flags["body-file"], "utf8");
      } catch (err) {
        fail(`could not read --body-file ${flags["body-file"]}: ${err.message}`);
      }
    } else if (typeof flags.body === "string") {
      incoming = flags.body;
    } else {
      usage(console.error, 2);
    }
    const before = readItem(id);
    if (!before) fail(`no project item with id ${id}`);
    if (!before.draftId) {
      fail(
        `${id} is not a draft item: its title and body live on the GitHub content (an issue or PR), ` +
          `and updateProjectV2DraftIssue only edits drafts.`,
      );
    }
    const next = flags.append
      ? `${before.body.trimEnd()}\n\n---\n\n${incoming.trim()}\n`
      : incoming;
    updateDraftBody(before.draftId, { body: next });
    const item = readVerified(id, {
      body: (actual) => String(actual ?? "").trim() === next.trim(),
    });
    console.log(
      `body ${flags.append ? "appended to" : "replaced on"} ${item.id}  (${next.length} chars)  ${item.title}`,
    );
    break;
  }

  case "close": {
    const id = rest[0];
    if (!id) usage(console.error, 2);
    setOption(id, STATUS.field, STATUS.options.done);
    const item = readVerified(id, { status: "Done" });
    console.log(`closed ${item.id}  ${item.title}`);
    break;
  }

  default:
    console.error(`ERROR: unknown command "${verb}"`);
    usage(console.error, 2);
}
