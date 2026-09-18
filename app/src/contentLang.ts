import type { DayRecord, TranslationFile } from "@travel-archive/shared";
import { applyEdits, textKey } from "@travel-archive/shared";
import { CONTENT_LANG_KEY, rememberPref } from "./prefs";

/**
 * The reader's language — one setting for both the archive's own text
 * (captions, day and stop text, cards, trip narratives) and the interface
 * around it, whose words are in `i18n/`.
 *
 * Nothing here may import `i18n/`: that module reads `contentLanguage()` while
 * it loads, so the dependency only runs one way. (`prefs.ts` is safe by the
 * same rule — it imports nothing but the backend client.)
 *
 * The second language lives in sidecar files beside the archive (see
 * `TranslationFile` in shared), keyed by a hash of the original text. So the
 * lookup is: hash the text about to be shown, and use the entry if there is
 * one. A text with no entry shows as written — never blank — which is also
 * what a day rewritten since the last translation looks like.
 *
 * Per archive rather than per browser now, like the theme: the local job server
 * holds it (prefs.ts), because the browser's own copy did not survive the
 * desktop shell being killed. Two people reading the same archive from
 * *different* machines still read it in different languages — nothing is
 * uploaded — but two windows onto the same server agree.
 */

export type ContentLang = "en" | "zh-Hans";

export const CONTENT_LANG_OPTIONS: { value: ContentLang; label: string }[] = [
  { value: "en", label: "English" },
  { value: "zh-Hans", label: "简体中文" },
];

function stored(): ContentLang {
  try {
    return localStorage.getItem(CONTENT_LANG_KEY) === "zh-Hans" ? "zh-Hans" : "en";
  } catch {
    return "en";
  }
}

const current: ContentLang = stored();
// The page's language is the content's: it is most of what is on screen, and
// it is what makes the browser pick Chinese glyphs rather than Japanese ones
// for the same code points.
document.documentElement.lang = current;

export function contentLanguage(): ContentLang {
  return current;
}

/**
 * A reload rather than a re-render: every view, the viewer and the caches
 * would all need to learn the change, and the URL already brings the reader
 * back to the same place.
 */
export function setContentLanguage(lang: ContentLang): void {
  // To the server first, and with `keepalive` so the reload below cannot cancel
  // it in flight — this is the one setting whose save is immediately followed
  // by the page going away. It is also the copy that outlives the browser's,
  // which is the point of prefs.ts.
  rememberPref({ contentLang: lang });
  try {
    localStorage.setItem(CONTENT_LANG_KEY, lang);
  } catch {
    // Storage blocked. The server has it, so the next launch reads it back and
    // applies it; there is nothing to reload into now.
    return;
  }
  location.reload();
}

let indexFile: TranslationFile | null = null;
const monthFiles = new Map<string, TranslationFile>();

export function useIndexTranslations(file: TranslationFile | null): void {
  indexFile = file;
  monthFiles.clear();
}

export function useMonthTranslations(month: string, file: TranslationFile | null): void {
  if (file) monthFiles.set(month, file);
  else monthFiles.delete(month);
}

/** Months that have a caption file in the current language. */
export function translatedMonths(): string[] {
  return indexFile?.parts ?? [];
}

/** The text in the reader's language, or as written when there is no entry. */
export function loc(text: string): string;
export function loc(text: string | null): string | null;
export function loc(text: string | null): string | null {
  if (current === "en" || !text) return text;
  const key = textKey(text);
  const hit = indexFile?.entries[key];
  if (hit) return hit.t;
  for (const file of monthFiles.values()) {
    const entry = file.entries[key];
    if (entry) return entry.t;
  }
  return text;
}

/**
 * A day as the reader sees it: its summary and stop text in their language,
 * with their own hand edits in that language over the top.
 *
 * The edits go on with the shared `applyEdits`, the same rule organize uses
 * for the original — anchored to a photo, so an edit follows its stop when the
 * day re-clusters. A copy: the record in the cache stays the original, which
 * is what the next render and the English view read. In English, the day as is.
 */
export function locDay(day: DayRecord): DayRecord {
  if (current === "en") return day;
  const segments = day.segments.map((s) => ({ ...s, title: loc(s.title), summary: loc(s.summary) }));
  const shown = applyEdits(loc(day.summary), segments, indexFile?.owner?.[day.date]);
  return { ...day, summary: shown.summary, segments: shown.segments };
}

/** `label` from the caller, which may import `i18n/` where this module may not. */
export function renderContentLanguageControl(label: string): HTMLElement {
  const select = document.createElement("select");
  select.className = "set-select";
  select.setAttribute("aria-label", label);
  // Not el(): an <option> parsed inside a <div> is dropped on the floor.
  for (const option of CONTENT_LANG_OPTIONS) {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    select.appendChild(node);
  }
  select.value = current;
  select.addEventListener("change", () => setContentLanguage(select.value as ContentLang));
  return select;
}
