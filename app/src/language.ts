import type { ContentLang } from "./contentLang";

/**
 * How a language learned *after* the page's modules were loaded gets applied
 * without reloading.
 *
 * `prefs.ts` learns the archive's language from the server while the app is
 * starting — after `contentLang.ts` (which imports `prefs.ts`) has already
 * fixed its answer, but before anything has been drawn. It cannot import
 * `contentLang` to change that (a cycle) and it cannot import `i18n` either
 * (which imports `contentLang`, making the same cycle one step longer).
 *
 * This module imports nothing but a type, and a type import is erased at
 * runtime, so it has no edges at all: the two sides that may not import each
 * other meet here.
 */

let applier: ((lang: ContentLang) => void) | null = null;

/** Registered while `contentLang.ts` loads, which is before `main()` runs. */
export function registerLanguageApplier(fn: (lang: ContentLang) => void): void {
  applier = fn;
}

/** `false` when nothing has registered — the caller falls back to reloading. */
export function applyLanguage(lang: ContentLang): boolean {
  if (!applier) return false;
  applier(lang);
  return true;
}
