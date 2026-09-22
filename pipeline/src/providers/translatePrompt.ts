import type { TranslateInput } from "./types.js";

/** Names the model is given, rather than bare codes it might read loosely. */
export const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  "zh-Hans": "Simplified Chinese (简体中文)",
};

/**
 * One prompt for both providers, so a switch of provider does not also switch
 * what the translation is asked to do.
 *
 * The owner does not expect great quality, so this asks for faithful and plain
 * rather than polished — and above all for nothing *added*: a caption is read
 * as an observation, and a translation that embellishes one invents a fact.
 */
export function translatePrompt(input: TranslateInput): string {
  const from = LANGUAGE_NAMES[input.sourceLang] ?? input.sourceLang;
  const to = LANGUAGE_NAMES[input.targetLang] ?? input.targetLang;
  const examples = input.targetLang.startsWith("zh")
    ? " (for example 城市 for a city, 美泉宫 for Schönbrunn Palace)"
    : "";
  const opening = input.mixedSource
    ? `Translate the texts below into ${to}. They are written in whichever language each was photographed in — a museum label, a menu or a sign often prints the same thing in two or three languages at once.`
    : `Translate the texts below from ${from} into ${to}.`;
  return `${opening} They come from a personal travel photo archive: captions of single photos, names of places and stops, short summaries of days, card descriptions, English renderings of museum placards, and transcripts of the text in a photograph (a label, a menu, a note).

- Translate faithfully and plainly. Add nothing, explain nothing, leave nothing out.
- When a text repeats the same content in two or more languages — a bilingual label — translate that meaning **once** into ${to}. Do not print it once per language.
- Names of places, venues, artworks and dishes: use the established ${to} name where one exists${examples}. Where none exists, keep the original name as written.
- Keep numbers, dates and times as they are.
- A text already in ${to} is returned unchanged.
- Return exactly one item per input, with its key unchanged.

INPUT (JSON, one object per text; "kind" says what the text is):
${JSON.stringify(input.items)}`;
}
