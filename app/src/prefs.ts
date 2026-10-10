import type { AppPrefs } from "@travel-archive/shared";
import { getPrefs, isLocalMachine, savePrefs } from "./backend";
import { applyLanguage } from "./language";

/**
 * Interface preferences, held by the local job server and mirrored into
 * `localStorage`.
 *
 * **Why the server holds them.** On the desktop shell `localStorage` was not
 * surviving a launch. Chromium commits its LevelDB store on a clean shutdown,
 * and this renderer had been killed often enough that it never did — the
 * store under `%APPDATA%\Photo Archive` had a `CURRENT` from 06/09 and a last
 * table from 11/09, while each launch wrote a new `000003.log` and left the
 * previous session's 20KB one orphaned. Everything in there went with it: the
 * MSAL token cache, the theme, the language. The job server writes to an
 * ordinary file and is running whenever the shell is, so it keeps this through
 * a kill that Chromium cannot.
 *
 * **Why `localStorage` stays.** It is not a cache that could be dropped. With
 * no server — a phone, or any browser reading OneDrive directly, which is a
 * supported state rather than a failure — it is the only store there is. It is
 * also the only one that can be read *synchronously*, which the theme needs
 * before first paint and the content language needs before `i18n/` loads.
 *
 * So the server is the durable copy and the browser is the fast one. Reads go
 * to the browser, as they always did; writes go to both; and one fetch at
 * startup reconciles them, which is where a wiped store gets its settings
 * back.
 *
 * Nothing here may import `i18n/` — `contentLang.ts` is one of this module's
 * callers, and it loads before `i18n/` does.
 */

/** The `localStorage` names, owned here so the two halves cannot drift apart. */
export const THEME_KEY = "theme";
export const DENSITY_KEY = "album-density";
export const SIDEBAR_WIDTH_KEY = "sidebar-width";
export const CONTENT_LANG_KEY = "content-language";
export const OPEN_GROUPS_KEY = "nav-open-groups";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Storage blocked (private browsing). Defaults apply, and the server copy
    // is still read below — which is how a locked-down browser on the desktop
    // still gets the owner's theme.
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not persisting locally is survivable: the setting holds for this session
    // and the server has it for the next one.
  }
}

/**
 * What the browser currently holds, in the server's shape.
 *
 * An absent theme is "system" rather than "never set", because that is exactly
 * what absence means to `theme.ts` — it stores the choice as the *absence* of
 * `data-theme` so the media query can do the work. The other four are null
 * when absent, so that a first run does not push a default the owner never
 * chose.
 */
function local(): AppPrefs {
  const theme = read(THEME_KEY);
  const density = read(DENSITY_KEY);
  const lang = read(CONTENT_LANG_KEY);
  const width = Number(read(SIDEBAR_WIDTH_KEY));
  const groups = read(OPEN_GROUPS_KEY);

  let navOpenGroups: string[] | null = null;
  try {
    const parsed: unknown = groups ? JSON.parse(groups) : null;
    if (Array.isArray(parsed)) navOpenGroups = parsed.filter((v): v is string => typeof v === "string");
  } catch {
    // A value from an older shape. Treated as unset rather than as an error.
  }

  return {
    theme: theme === "light" || theme === "dark" ? theme : "system",
    density: density === "compact" || density === "comfortable" || density === "spacious" ? density : null,
    sidebarWidth: Number.isFinite(width) && width > 0 ? width : null,
    // As `contentLang.ts` reads it: anything that is not Simplified Chinese is
    // English. Absence is a real answer here rather than "never set", so that
    // a server holding "en" against an untouched browser does not read as a
    // disagreement and cost a reload. Absence is also now rare: `contentLang.ts`
    // writes what it detected from the browser while it loads, so this line
    // mainly runs when storage cannot be written at all.
    contentLang: lang === "zh-Hans" ? "zh-Hans" : "en",
    navOpenGroups,
  };
}

/**
 * Set before a language reload, so a browser that cannot write `localStorage`
 * at all reloads once and then gives up rather than looping forever on a
 * disagreement it has no way to settle.
 */
const RELOADED_KEY = "prefs-restored";

function reloadOnce(): void {
  try {
    if (sessionStorage.getItem(RELOADED_KEY)) return;
    sessionStorage.setItem(RELOADED_KEY, "1");
  } catch {
    // No session storage to hold the guard, so no reload: a wrong language for
    // this session beats a page that reloads without end.
    return;
  }
  location.reload();
}

/** Which restored settings the caller has to re-apply, because it read them before this ran. */
export interface Restored {
  theme: boolean;
  density: boolean;
}

/**
 * Reconciles the two stores, once, before anything is rendered.
 *
 * Per setting: if the server has never been told, it is told what this browser
 * holds — so the first launch after this change adopts the existing setup
 * rather than resetting it. If the server has a value and this browser
 * disagrees, the server wins, because the case this exists for is a browser
 * that has just lost everything.
 *
 * The content language cannot be applied in place: `contentLang.ts` reads it
 * while it loads and `i18n/` reads *that* while **it** loads, so by the time
 * this runs both are fixed for the life of the page. Restoring it therefore
 * reloads, which is the same thing changing it by hand already does.
 *
 * Returns without touching anything when no server answers — the browser's own
 * copy is then the only copy, and it is already in use.
 */
export async function restorePrefs(): Promise<Restored> {
  const restored: Restored = { theme: false, density: false };

  const server = await getPrefs();
  if (!server) return restored;

  // A remote reader is a guest on someone else's archive: its appearance is
  // its own, kept in this browser, while the machine holding the archive keeps
  // whatever its owner chose. Without this the page adopted the server's
  // theme on load and then silently lost whatever the guest picked, because
  // the server refuses a write from another machine (see the write gate in
  // serve.ts) and the next reconcile put the server's value back.
  if (!isLocalMachine) return restored;

  const mine = local();
  const seed: Partial<AppPrefs> = {};

  if (server.theme === null) seed.theme = mine.theme;
  else if (server.theme !== mine.theme) {
    // "system" is stored as the absence of the key — see theme.ts.
    if (server.theme === "system") {
      try {
        localStorage.removeItem(THEME_KEY);
      } catch {
        /* as in write() */
      }
    } else write(THEME_KEY, server.theme);
    restored.theme = true;
  }

  if (server.density === null) {
    if (mine.density) seed.density = mine.density;
  } else if (server.density !== mine.density) {
    write(DENSITY_KEY, server.density);
    restored.density = true;
  }

  if (server.sidebarWidth === null) {
    if (mine.sidebarWidth !== null) seed.sidebarWidth = mine.sidebarWidth;
  } else if (server.sidebarWidth !== mine.sidebarWidth) {
    write(SIDEBAR_WIDTH_KEY, String(server.sidebarWidth));
  }

  if (server.navOpenGroups === null) {
    if (mine.navOpenGroups) seed.navOpenGroups = mine.navOpenGroups;
  } else if (JSON.stringify(server.navOpenGroups) !== JSON.stringify(mine.navOpenGroups)) {
    write(OPEN_GROUPS_KEY, JSON.stringify(server.navOpenGroups));
  }

  if (Object.keys(seed).length > 0) savePrefs(seed);

  // Last, and on its own: this one ends the page rather than returning to it.
  if (server.contentLang === null) {
    if (mine.contentLang) savePrefs({ contentLang: mine.contentLang });
  } else if (server.contentLang !== mine.contentLang) {
    // Learned late, applied where nothing has been drawn: by now the reader has
    // seen only the static shell, so `ui`, `loc` and <html lang> can all be
    // switched in place. That is what removes the second load a mismatch used
    // to cost — the English shell, a reload, then the page again.
    // A caller with no applier registered (no i18n loaded) still reloads.
    if (!applyLanguage(server.contentLang)) {
      write(CONTENT_LANG_KEY, server.contentLang);
      reloadOnce();
    }
  }

  return restored;
}

/** One setting, to both stores. The browser's copy is the caller's; this is the server's. */
export function rememberPref(patch: Partial<AppPrefs>): void {
  // Only the machine holding the archive keeps a durable copy of these; for a
  // remote reader the browser's copy is the only one, which is where the
  // caller has already put it.
  if (isLocalMachine) savePrefs(patch);
}
