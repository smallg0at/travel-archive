import type { DayRecord, TranslationFile, TripRecord } from "@travel-archive/shared";
import { applyEdits, textKey } from "@travel-archive/shared";
import { CONTENT_LANG_KEY, rememberPref } from "./prefs";
import { registerLanguageApplier } from "./language";

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

/**
 * A first run with nothing stored answers in the browser's own language.
 *
 * The archive's own answer, if the job server has one, is applied in place a
 * moment later (see the applier below) — so this guess only stands where the
 * archive has no preference of its own: a phone with no server beside it, or a
 * first-ever launch. Without it that case was English for everyone, and a
 * Chinese reader stayed on the wrong language until they found a refresh.
 *
 * Simplified Chinese is the archive's only non-English language, so a primary
 * tag of `zh` maps there — a Traditional-region reader would otherwise be
 * handed English, which is further from what they read than Simplified is.
 *
 * The **first** tag decides, because `navigator.languages` is the reader's
 * ordered preference and its first entry is the language their own interface is
 * already in. Deciding on "any tag that mentions Chinese" would put English in
 * front of a browser that merely lists Chinese as a fallback.
 */
function detect(): ContentLang {
  const tags: readonly string[] =
    navigator.languages && navigator.languages.length > 0
      ? navigator.languages
      : navigator.language
        ? [navigator.language]
        : [];
  const primary = tags.find((tag) => typeof tag === "string" && tag.trim().length > 0);
  return primary && /^zh\b/i.test(primary) ? "zh-Hans" : "en";
}

/** `null` when nothing is stored — that case belongs to `detect()`, not to "en". */
function stored(): ContentLang | null {
  try {
    const raw = localStorage.getItem(CONTENT_LANG_KEY);
    return raw === "zh-Hans" || raw === "en" ? raw : null;
  } catch {
    return null;
  }
}

let current: ContentLang = stored() ?? rememberDetection();

/**
 * Recorded at once rather than re-derived every load: `prefs.ts` reads this key
 * to decide what it owes the server, and a browser that never records its
 * answer will keep disagreeing with a server that has one.
 */
function rememberDetection(): ContentLang {
  const lang = detect();
  try {
    localStorage.setItem(CONTENT_LANG_KEY, lang);
  } catch {
    // Storage blocked: the guess still holds for this session, and prefs.ts
    // keeps a disagreement it cannot settle from reloading for ever.
  }
  return lang;
}
// The page's language is the content's: it is most of what is on screen, and
// it is what makes the browser pick Chinese glyphs rather than Japanese ones
// for the same code points.
document.documentElement.lang = current;

/** Who else has to learn when the language changes — `i18n/`, never imported here. */
type LanguageListener = (lang: ContentLang) => void;
const listeners = new Set<LanguageListener>();

export function onContentLanguageApplied(listener: LanguageListener): void {
  listeners.add(listener);
}

/**
 * The archive's language, learned from the server during startup and applied
 * where nothing has been drawn yet: `restorePrefs` is awaited before
 * `localiseShell` (main.ts) and before `start` (mobile/main.ts).
 *
 * In place rather than by reloading. At this point the language-dependent
 * things that exist are this module's answer, `i18n`'s table and the static
 * shell's English — and all three are switched here, so no wrong language is
 * ever on screen and the page is not loaded twice. `prefs.ts` keeps its reload
 * for a caller with no applier registered, so this is only ever an
 * improvement over what was there.
 */
registerLanguageApplier((lang) => {
  current = lang;
  document.documentElement.lang = lang;
  try {
    localStorage.setItem(CONTENT_LANG_KEY, lang);
  } catch {
    // Storage blocked: every lookup reads `current`, so this session is right
    // regardless, and the server already holds the answer for the next one.
  }
  for (const listener of listeners) listener(lang);
});

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

/**
 * A trip as the reader sees it: its narrative and name in their language, with
 * the corrections written in that language over the top.
 *
 * The narrative counterpart to `locDay`, and the same two layers in the same
 * order — the translation first, then the owner's own text where they wrote it.
 * `TranslationFile.tripOwner` holds the other languages' corrections and
 * `TripRecord.edits` the original's, so an edit made while reading Chinese does
 * not overwrite the English one and vice versa.
 */
export function locTrip(trip: TripRecord): TripRecord {
  if (current === "en") return trip;
  const edits = indexFile?.tripOwner?.[trip.id];
  return {
    ...trip,
    name: edits?.name || loc(trip.name),
    narrative: edits?.narrative || loc(trip.narrative),
  };
}

/**
 * A day's searchable text in the reader's language: summary, place, note and
 * every stop, each through `loc` — which returns it unchanged when there is no
 * translation, so English behaves exactly as before.
 *
 * The pipeline builds one English blob per day (`jobs/searchIndex.ts`) and the
 * search index only ever holds that, so a query typed in the reader's language
 * has to be matched against the translation as well. Both search boxes — the
 * phone's page and the desktop's title-bar bar — do it through this, so the two
 * cannot drift apart on what counts as a match.
 */
export function localizedDayText(day: DayRecord): string {
  const segments = (day.segments ?? []).flatMap((seg) => [loc(seg.title), loc(seg.summary)]);
  return [loc(day.summary), loc(day.place), day.note, ...segments].filter(Boolean).join(" ").toLowerCase();
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
