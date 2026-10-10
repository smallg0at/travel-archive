import { contentLanguage, onContentLanguageApplied } from "../contentLang";
import { en, type Messages } from "./en";
import { zhHans } from "./zh-Hans";

/**
 * The interface's words, in the one language the reader chose.
 *
 * Chosen when this module loads, and changeable **once** after that while the
 * app is still starting: `restorePrefs` may learn the archive's language from
 * the server a moment later, but before anything has rendered — so it applies
 * it in place (see `contentLang.ts`), and the callback below is why this has
 * to be `let`. That is what removes the second load a mismatch used to cost:
 * the static English shell, a reload, then the real page.
 *
 * What the reader changes by hand still reloads (see `setContentLanguage`),
 * because by then a screen is on the page and swapping the table under it
 * would leave half of it in the old language. So nothing else has to be
 * re-read or re-rendered.
 *
 * Plain text unless a key ends in `Html`. Those few are static markup written
 * here — `<em>`, `<strong>`, `<code>` — and are the only ones that may be
 * interpolated into `el()` templates as markup; everything else goes in through
 * `textContent`, or into a template only where it cannot contain a `<`.
 */
export let ui: Messages = contentLanguage() === "zh-Hans" ? zhHans : en;

/**
 * A job phase id in the reader's language. The id comes from the pipeline, so
 * a phase this build has never heard of renders as itself rather than as
 * nothing — the same reason the table is a lookup and not a switch.
 */
export function jobPhase(id: string): string {
  return (ui.jobPhases as Record<string, string>)[id] ?? id;
}

onContentLanguageApplied((lang) => {
  ui = lang === "zh-Hans" ? zhHans : en;
});

export type { Messages };
export { fmtDate, fmtDateTime, locale, num } from "./format";
