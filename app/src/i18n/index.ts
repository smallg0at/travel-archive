import { contentLanguage } from "../contentLang";
import { en, type Messages } from "./en";
import { zhHans } from "./zh-Hans";

/**
 * The interface's words, in the one language the reader chose.
 *
 * Fixed for the life of the page: changing the language reloads (see
 * `setContentLanguage`), so nothing here has to be re-read or re-rendered.
 *
 * Plain text unless a key ends in `Html`. Those few are static markup written
 * here — `<em>`, `<strong>`, `<code>` — and are the only ones that may be
 * interpolated into `el()` templates as markup; everything else goes in through
 * `textContent`, or into a template only where it cannot contain a `<`.
 */
export const ui: Messages = contentLanguage() === "zh-Hans" ? zhHans : en;

export type { Messages };
export { fmtDate, fmtDateTime, locale, num } from "./format";
