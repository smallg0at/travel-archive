import { LANGUAGE_NAMES } from "./translatePrompt.js";
import type { NativeText } from "./types.js";

/**
 * Asking a summarizer to write a second language natively, in the same call.
 *
 * Every text field gets a twin ending in `_alt`, on the same object. Siblings
 * rather than a second parallel block, because a parallel block has to line up
 * by position with the first — and the providers drop highlights whose photo
 * ids do not survive validation, which would shift every Chinese card onto the
 * wrong English one. A twin cannot drift from the field it sits beside.
 *
 * The result is a list of (original, twin) pairs, stored as `native` entries
 * keyed by the original text (see `TranslationFile`), exactly where a machine
 * translation of the same text would go — and outranking one.
 */

/** Field names that carry prose or names the app shows, in either provider's schema. */
const TEXT_FIELDS = new Set(["summary", "title", "description", "document_translation", "name", "narrative", "places"]);

type SchemaNode = { properties?: Record<string, unknown>; required?: string[]; items?: unknown };

/**
 * A copy of `schema` with an `_alt` twin beside every text field.
 *
 * The twin is a copy of the original field's own schema, so it keeps however
 * that provider spells "nullable" (Gemini's `nullable: true`) without this
 * needing to know.
 */
export function withAltFields<T>(schema: T, lang: string): T {
  const name = LANGUAGE_NAMES[lang] ?? lang;
  const copy = structuredClone(schema) as unknown;
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as SchemaNode;
    if (n.properties) {
      for (const key of Object.keys(n.properties)) {
        walk(n.properties[key]);
        if (!TEXT_FIELDS.has(key)) continue;
        const original = n.properties[key] as Record<string, unknown>;
        n.properties[`${key}_alt`] = {
          ...structuredClone(original),
          description: `The same content as "${key}", written in ${name}.`,
        };
        if (n.required?.includes(key)) n.required.push(`${key}_alt`);
      }
    }
    if (n.items) walk(n.items);
  };
  walk(copy);
  return copy as T;
}

/** The prompt paragraph that goes with `withAltFields`. Empty when no second language is asked for. */
export function altInstructions(lang: string | null | undefined): string {
  if (!lang) return "";
  const name = LANGUAGE_NAMES[lang] ?? lang;
  return `

ALSO IN ${name.toUpperCase()}: every text field has a twin whose name ends in "_alt". Fill each twin with the same content written in ${name} — the same facts, the same names and about the same length. It is the same page in a second language, not a second, different summary. Use the established ${name} name for a place or a thing where one exists. For document_translation_alt, render the placard itself in ${name}, not the English rendering of it.`;
}

function pushPair(pairs: [string, string][], original: string, alt: string): void {
  const a = original.trim();
  const b = alt.trim();
  if (a && b) pairs.push([a, b]);
}

/** Every (original, twin) the model filled in both languages, anywhere in its JSON. */
export function altPairs(node: unknown, pairs: [string, string][] = []): [string, string][] {
  if (Array.isArray(node)) {
    for (const item of node) altPairs(item, pairs);
    return pairs;
  }
  if (!node || typeof node !== "object") return pairs;
  const record = node as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key.endsWith("_alt")) continue;
    const value = record[key];
    const alt = record[`${key}_alt`];
    if (TEXT_FIELDS.has(key)) {
      if (typeof value === "string" && typeof alt === "string") pushPair(pairs, value, alt);
      else if (Array.isArray(value) && Array.isArray(alt)) {
        value.forEach((v, i) => {
          if (typeof v === "string" && typeof alt[i] === "string") pushPair(pairs, v, alt[i] as string);
        });
      }
    }
    if (value && typeof value === "object") altPairs(value, pairs);
  }
  return pairs;
}

/** The provider's `native` result: null when no second language was asked for. */
export function nativeText(lang: string | null | undefined, parsed: unknown, extra: [string, string][] = []): NativeText | null {
  if (!lang) return null;
  return { lang, pairs: [...altPairs(parsed), ...extra] };
}
