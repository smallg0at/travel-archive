import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { AppPrefs } from "@travel-archive/shared";
import { dataDir, dataFile } from "./paths.js";

/**
 * The app's interface preferences, kept beside the archive rather than in the
 * browser.
 *
 * `localStorage` was losing them on the desktop shell. Chromium commits its
 * LevelDB store on a clean shutdown, and the shell's renderer had been killed
 * often enough during development that it never did: `%APPDATA%\Photo
 * Archive\Local Storage\leveldb` held a `CURRENT` from 06/09 and a last table
 * from 11/09 while every launch wrote a fresh `000003.log` and orphaned the
 * previous session's. So the owner reset the theme, the thumbnail density and
 * the sidebar width on every launch. This server persists config to disk
 * already and is running whenever the shell is, so the state survives a kill
 * -9 here in a way it cannot there.
 *
 * Same shape as syncStore: a single small JSON file under `data/`, read once
 * and cached, rewritten whole. It is a handful of scalars — there is nothing
 * to be gained from anything cleverer, and a file the owner can read and edit
 * is worth more than a database.
 *
 * **Not part of the archive.** Nothing here is uploaded, nothing here takes
 * the archive lock, and losing the file costs the reader their theme rather
 * than any content. It is deliberately outside SCHEMA_VERSION for that reason:
 * a preference the next version does not recognise should be ignored, not a
 * refusal to open the archive.
 */

const FILE = "prefs.json";

/** Null throughout: "never set", which is what lets the app seed it. See AppPrefs. */
const DEFAULTS: AppPrefs = {
  theme: null,
  density: null,
  sidebarWidth: null,
  contentLang: null,
  navOpenGroups: null,
};

let cached: AppPrefs | null = null;

export async function readPrefs(): Promise<AppPrefs> {
  if (cached) return cached;
  try {
    // Sanitised on the way in as well as on the way out: the file is
    // hand-editable, and a value that has been edited to nonsense should fall
    // back to "never set" rather than reach the app.
    cached = { ...DEFAULTS, ...sanitise(JSON.parse(await readFile(dataFile(FILE), "utf-8")) as Record<string, unknown>) };
  } catch {
    // Absent or corrupt both mean "nothing has been set yet", which is the
    // normal state until the app first saves something.
    cached = { ...DEFAULTS };
  }
  return cached;
}

/**
 * Merges a patch in and writes the file.
 *
 * Only the keys present in the patch change, so the app can save one setting
 * without sending the rest — which is what every caller does, since each
 * control saves the moment it is used.
 */
export async function writePrefs(patch: Partial<AppPrefs>): Promise<AppPrefs> {
  const next = { ...(await readPrefs()), ...sanitise(patch as Record<string, unknown>, { partial: true }) };
  cached = next;
  await mkdir(dataDir(), { recursive: true });
  await writeFile(dataFile(FILE), `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return next;
}

/** The app's own bounds (app/src/chrome.ts). Repeated rather than imported: this is the outer check. */
const MIN_SIDEBAR_WIDTH = 150;
const MAX_SIDEBAR_WIDTH = 460;
/**
 * More than the nav could plausibly show — twelve years, their months and the
 * trips group. A cap rather than a count, so a new group kind does not need a
 * change here; it exists only so a malformed request cannot grow the file
 * without limit.
 */
const MAX_OPEN_GROUPS = 200;

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/**
 * Every value the app may store, validated field by field.
 *
 * This is a write endpoint on a server with no authentication of its own, so
 * the same rule as `configStore`'s allowlist applies: what arrives decides
 * nothing but what it is allowed to decide. Unknown names are dropped
 * silently — unlike `/config`, where a typo is a setting that never applies
 * and so has to be an error, a preference the app no longer sends is simply an
 * older version of the app talking to a newer server.
 *
 * `partial` keeps a patch's absent keys absent rather than turning them into
 * explicit nulls, which would clear settings the caller never mentioned — and
 * with it, a value that fails validation is dropped from the patch rather than
 * clearing the good one already stored. Nothing the app sends is ever null:
 * "system" is a real theme, not the absence of one, so there is no case where
 * a save is meant to reset a field to "never set".
 */
function sanitise(input: Record<string, unknown>, opts: { partial?: boolean } = {}): Partial<AppPrefs> {
  const out: Partial<AppPrefs> = {};
  const keep = <K extends keyof AppPrefs>(key: K, value: AppPrefs[K]) => {
    if (value !== null || !opts.partial) out[key] = value;
  };

  if (!opts.partial || "theme" in input) keep("theme", oneOf(input.theme, ["light", "dark", "system"] as const));
  if (!opts.partial || "density" in input) {
    keep("density", oneOf(input.density, ["compact", "comfortable", "spacious"] as const));
  }
  if (!opts.partial || "contentLang" in input) {
    keep("contentLang", oneOf(input.contentLang, ["en", "zh-Hans"] as const));
  }
  if (!opts.partial || "sidebarWidth" in input) {
    const width = typeof input.sidebarWidth === "number" && Number.isFinite(input.sidebarWidth)
      ? Math.round(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, input.sidebarWidth)))
      : null;
    keep("sidebarWidth", width);
  }
  if (!opts.partial || "navOpenGroups" in input) {
    const groups = Array.isArray(input.navOpenGroups)
      ? input.navOpenGroups.filter((v): v is string => typeof v === "string").slice(0, MAX_OPEN_GROUPS)
      : null;
    keep("navOpenGroups", groups);
  }

  return out;
}
