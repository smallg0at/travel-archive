import type { ArchiveIndexFile, PhotoShard, TranslatePlan, TranslateScope, TranslationFile } from "@travel-archive/shared";
import { CONTENT_LANGUAGES, textKey } from "@travel-archive/shared";
import { getAccessToken } from "../auth.js";
import { getProvider } from "../providers/index.js";
import { env } from "../env.js";
import {
  emptyTranslations,
  loadIndex,
  loadIndexForReading,
  loadShardForReading,
  loadTranslations,
  loadTranslationsForReading,
  readTranslationsLocal,
  saveTranslations,
  translationParts,
} from "../archiveStore.js";
import { pooled, type ProgressFn } from "./analyze.js";
import { mayBeAnalyzed } from "../screenshots.js";
import { withheldFromSummaries } from "../sensitive.js";

/**
 * Putting text the archive already has into a second language.
 *
 * Text only — no image is sent — so this is the cheap way to a second
 * language: re-running the captioner or the summarizers in it would pay for
 * vision and for writing all over again. The owner does not expect great
 * quality; what matters is that it is cheap, resumable and never *adds* to the
 * text (see translatePrompt.ts).
 *
 * Results go to the language's sidecar files (see `TranslationFile`), keyed by
 * the original text, so nothing in the archive itself changes.
 */

export interface TranslateOptions {
  lang: string;
  scope: TranslateScope;
  /**
   * One month (`yyyy-mm`), or null for everything. Narrows what is translated,
   * never what is kept: entries are only dropped when nothing in the whole
   * archive refers to them.
   */
  only: string | null;
}

export interface TranslateResult {
  translated: number;
  failed: number;
  /** Entries dropped because no day or trip text refers to them any more. */
  dropped: number;
  batches: number;
  inputTokens: number;
  outputTokens: number;
}

type SourceKind = "caption" | "title" | "summary" | "description" | "placard" | "narrative" | "place" | "name" | "transcript";

interface Source {
  key: string;
  text: string;
  kind: SourceKind;
}

/** Per call. Small enough that one bad batch loses little and a retry is cheap. */
const BATCH_ITEMS = 60;
const BATCH_CHARS = 8000;
/** Batches between checkpoint saves, the way analyze saves every 150 photos. */
const SAVE_EVERY_BATCHES = 10;
/**
 * Months read at once before translating starts. Each is a mirror shard plus a
 * Graph download of that month's file; sequentially that is 123 round trips
 * before the first call, which is the "Reading the archive..." wait.
 */
const PREPARE_CONCURRENCY = 6;

/**
 * Measured on the first real run (September 2026 into zh-Hans, 948 texts,
 * 85,388 characters, 16 calls on gemini-3.7-flash): 36,498 input and 47,497
 * output tokens. The first guess — 0.25 in and 0.6 out per character — came in
 * 35% low on input, because each item carries its key and kind as JSON. One
 * run's worth of evidence; the run always reports the true counts.
 */
const TOKENS_IN_PER_CHAR = 0.36;
const TOKENS_OUT_PER_CHAR = 0.56;
const PROMPT_TOKENS_PER_BATCH = 350;

export function parseTranslateOptions(body: {
  lang?: unknown;
  scope?: unknown;
  only?: unknown;
}): TranslateOptions | { error: string } {
  const lang = typeof body.lang === "string" ? body.lang : "";
  if (!(CONTENT_LANGUAGES as readonly string[]).includes(lang)) {
    return { error: `lang must be one of: ${CONTENT_LANGUAGES.join(", ")}` };
  }
  const scope = body.scope ?? "all";
  if (scope !== "day" && scope !== "captions" && scope !== "all") {
    return { error: 'scope must be "day", "captions" or "all"' };
  }
  const only = body.only ?? null;
  if (only !== null && (typeof only !== "string" || !/^\d{4}-\d{2}$/.test(only))) {
    return { error: "only must be a month, yyyy-mm" };
  }
  return { lang, scope, only };
}

function add(sources: Map<string, Source>, text: string | null | undefined, kind: SourceKind): void {
  if (!text || !text.trim()) return;
  const key = textKey(text);
  if (!sources.has(key)) sources.set(key, { key, text, kind });
}

/**
 * Every day, stop, card and trip text the app shows. Month buckets contribute
 * their days but not their names — the app labels a month itself.
 *
 * With `only`, the days in that month and any trip with a day in it.
 */
export function dayTextSources(index: ArchiveIndexFile, only: string | null = null): Map<string, Source> {
  const sources = new Map<string, Source>();
  const wanted = (date: string) => only === null || date.startsWith(only);
  for (const section of index.sections) {
    if (section.kind === "trip" && section.days.some((d) => wanted(d.date))) {
      add(sources, section.name, "name");
      add(sources, section.narrative, "narrative");
      for (const place of section.places ?? []) add(sources, place, "place");
    }
    for (const day of section.days) {
      if (!wanted(day.date)) continue;
      add(sources, day.summary, "summary");
      for (const segment of day.segments ?? []) {
        add(sources, segment.title, "title");
        add(sources, segment.summary, "summary");
        for (const highlight of segment.highlights ?? []) {
          add(sources, highlight.title, "title");
          add(sources, highlight.description, "description");
          add(sources, highlight.documentTranslation, "placard");
        }
      }
    }
  }
  return sources;
}

/**
 * A month's per-photo text: its caption, and the text inside the photograph —
 * a label, a menu, a note — as `transcript`. Tags are left out: the app never
 * shows them.
 *
 * A transcript is sent only for a photo the archive would analyze at all. A
 * screenshot nobody approved, or one a redaction flag withholds from summaries,
 * carries private text and is never handed to a model; `caption` needs no such
 * gate because analyze only ever wrote one for photos that passed it.
 */
function captionSources(shard: PhotoShard): Map<string, Source> {
  const sources = new Map<string, Source>();
  for (const photo of Object.values(shard.photos)) {
    add(sources, photo.caption, "caption");
    if (mayBeAnalyzed(photo) && !withheldFromSummaries(photo)) add(sources, photo.extractedText, "transcript");
  }
  return sources;
}

/** Months anyone has captioned — the rest have nothing to translate. */
function captionMonths(index: ArchiveIndexFile, only: string | null): string[] {
  return index.months.filter((m) => m.analyzedCount > 0 && (only === null || m.month === only)).map((m) => m.month);
}

function missingOf(sources: Map<string, Source>, file: TranslationFile): Source[] {
  return [...sources.values()].filter((s) => !file.entries[s.key]);
}

const charsOf = (list: Source[]) => list.reduce((n, s) => n + s.text.length, 0);

function batchesOf(items: Source[]): Source[][] {
  const batches: Source[][] = [];
  let current: Source[] = [];
  let chars = 0;
  for (const item of items) {
    if (current.length && (current.length >= BATCH_ITEMS || chars + item.text.length > BATCH_CHARS)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += item.text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** What a run would translate, spending nothing. Reads the mirror only. */
export async function planTranslate(opts: TranslateOptions): Promise<TranslatePlan> {
  const token = await getAccessToken();
  const index = await loadIndexForReading(token);
  const indexFile = await loadTranslationsForReading(token, opts.lang, "index");

  const parts: TranslatePlan["parts"] = [];
  let batches = 0;
  const tally = (part: string, sources: Map<string, Source>, file: TranslationFile) => {
    const missing = missingOf(sources, file);
    batches += batchesOf(missing).length;
    parts.push({ part, strings: sources.size, missing: missing.length, missingChars: charsOf(missing) });
  };

  if (opts.scope !== "captions") tally("index", dayTextSources(index, opts.only), indexFile);
  if (opts.scope !== "day") {
    for (const month of captionMonths(index, opts.only)) {
      const sources = captionSources(await loadShardForReading(token, month));
      if (sources.size === 0) continue;
      // The mirror alone: a month with no caption file yet would otherwise
      // cost a OneDrive round trip just to learn that it is empty.
      const file = (await readTranslationsLocal(opts.lang, month)) ?? emptyTranslations(opts.lang, month);
      tally(month, sources, file);
    }
  }

  const missingChars = parts.reduce((n, p) => n + p.missingChars, 0);
  return {
    lang: opts.lang,
    scope: opts.scope,
    strings: parts.reduce((n, p) => n + p.strings, 0),
    missing: parts.reduce((n, p) => n + p.missing, 0),
    missingChars,
    estimatedInputTokens: Math.round(missingChars * TOKENS_IN_PER_CHAR + batches * PROMPT_TOKENS_PER_BATCH),
    estimatedOutputTokens: Math.round(missingChars * TOKENS_OUT_PER_CHAR),
    parts,
  };
}

/**
 * The language the day and trip summarizers also write in. The owner's
 * decision (2026-09-10): captions stay English and are translated; day and
 * trip text is written natively in both.
 */
export const NATIVE_LANGUAGE: string = CONTENT_LANGUAGES[0];

/**
 * Stores what a summarizer wrote in the second language, as `native` entries
 * keyed by the English it sits beside.
 *
 * Called after the English is saved, never before and never on a cancelled
 * run — the same rule the index follows. A failure here is reported rather
 * than thrown: the English is already saved and paid for, and the next
 * translate run fills whatever is missing with a machine translation.
 */
export async function saveNativeText(
  token: string,
  lang: string,
  pairs: [string, string][],
  onProgress: ProgressFn,
): Promise<number> {
  if (pairs.length === 0) return 0;
  try {
    const file = await loadTranslations(token, lang, "index");
    file.parts ??= [];
    file.owner ??= {};
    for (const [original, text] of pairs) file.entries[textKey(original)] = { t: text, via: "native" };
    await saveTranslations(token, lang, "index", file);
    onProgress({ message: `${pairs.length} text(s) written in ${lang} by the summarizer itself.` });
    return pairs.length;
  } catch (err) {
    onProgress({
      message: `The ${lang} text could not be saved (${(err as Error).message}); a translate run will fill it in.`,
    });
    return 0;
  }
}

interface Work {
  part: string;
  file: TranslationFile;
  missing: Source[];
}

/**
 * Translates whatever in scope has no entry yet.
 *
 * Runs inside the archive lock like every job (server/jobs.ts). The language
 * files are loaded from Graph, not the mirror: this writes them, and a mirror
 * gone stale on another machine would be merged onto and uploaded over the
 * newer copy (HANDOFF.md).
 *
 * Captions are read from the mirror all the same — reading every captioned
 * shard from Graph would add a round trip per month to a job that does not
 * write shards. The cost of a stale mirror there is a caption translated late,
 * which is why entries are never *dropped* from caption files: only the day
 * text, whose source is the Graph copy of the index, is pruned.
 */
export async function runTranslate(
  opts: TranslateOptions,
  onProgress: ProgressFn,
  signal?: AbortSignal,
): Promise<TranslateResult> {
  const provider = getProvider();
  const token = await getAccessToken();
  const result: TranslateResult = { translated: 0, failed: 0, dropped: 0, batches: 0, inputTokens: 0, outputTokens: 0 };

  onProgress({ phase: "planning", message: "Reading the archive..." });
  const index = await loadIndex(token);
  const indexFile = await loadTranslations(token, opts.lang, "index");
  indexFile.parts ??= [];
  indexFile.owner ??= {};

  const work: Work[] = [];
  if (opts.scope !== "captions") {
    // A day rewritten or a title corrected leaves its old text's entry with
    // nothing pointing at it. Judged against the *whole* index even when the
    // run is narrowed to a month, or every other month's text would go.
    const everything = dayTextSources(index);
    for (const key of Object.keys(indexFile.entries)) {
      if (!everything.has(key)) {
        delete indexFile.entries[key];
        result.dropped++;
      }
    }
    const sources = opts.only ? dayTextSources(index, opts.only) : everything;
    work.push({ part: "index", file: indexFile, missing: missingOf(sources, indexFile) });
  }
  if (opts.scope !== "day") {
    // Every month's file and shard, read concurrently and reporting progress:
    // sequentially this is one Graph round trip per month before any call is
    // made, which on a slow link is the whole "Reading the archive..." wait and
    // shows no count while it happens. `pooled` preserves the month order.
    const months = captionMonths(index, opts.only);
    const prepared: (Work | null)[] = new Array(months.length).fill(null);
    let read = 0;
    await pooled(
      months.map((month, i) => ({ month, i })),
      PREPARE_CONCURRENCY,
      async ({ month, i }) => {
        if (signal?.aborted) return;
        const sources = captionSources(await loadShardForReading(token, month));
        if (sources.size > 0) {
          const file = await loadTranslations(token, opts.lang, month);
          const missing = missingOf(sources, file);
          if (missing.length) prepared[i] = { part: month, file, missing };
        }
        onProgress({
          phase: "planning",
          done: ++read,
          total: months.length,
          message: `Reading the archive… ${read}/${months.length}`,
        });
      },
    );
    for (const item of prepared) if (item) work.push(item);
  }

  const total = work.reduce((n, w) => n + w.missing.length, 0);
  onProgress({
    phase: "translating",
    done: 0,
    total,
    message: total === 0 ? "Nothing to translate — everything in scope already has an entry." : `${total} text(s) to translate.`,
  });

  let done = 0;
  for (const w of work) {
    if (signal?.aborted) break;
    if (w.missing.length === 0) continue;

    let saving: Promise<void> = Promise.resolve();
    let sinceSave = 0;
    const checkpoint = () => {
      saving = saving
        .then(() => saveTranslations(token, opts.lang, w.part, w.file))
        .catch((err) => onProgress({ message: `Checkpoint for ${w.part} failed: ${(err as Error).message}` }));
    };

    await pooled(batchesOf(w.missing), env.analyzeConcurrency, async (batch) => {
      // Checked per batch, so a cancel stops within one call and keeps the rest.
      if (signal?.aborted) return;
      const wanted = new Set(batch.map((s) => s.key));
      try {
        const out = await provider.translate({
          sourceLang: "en",
          targetLang: opts.lang,
          items: batch.map(({ key, text, kind }) => ({ key, text, kind })),
          // A transcript is in whatever language the sign was written in, and a
          // bilingual one prints the same thing twice; the prompt then asks for
          // the meaning once rather than once per language.
          mixedSource: batch.some((s) => s.kind === "transcript"),
        });
        result.batches++;
        result.inputTokens += out.usage?.promptTokens ?? 0;
        result.outputTokens += (out.usage?.outputTokens ?? 0) + (out.usage?.thoughtsTokens ?? 0);
        for (const item of out.items) {
          const text = item.text?.trim();
          if (!text || !wanted.has(item.key)) continue;
          // Text the summarizer wrote in this language outranks a translation.
          if (w.file.entries[item.key]?.via !== "native") w.file.entries[item.key] = { t: text, via: "mt" };
          wanted.delete(item.key);
          result.translated++;
        }
      } catch (err) {
        onProgress({ message: `${w.part}: a batch of ${batch.length} failed — ${(err as Error).message.slice(0, 160)}` });
      }
      // Anything the model skipped stays missing, and the next run picks it up.
      result.failed += wanted.size;
      done += batch.length;
      onProgress({ phase: "translating", done, total });
      if (++sinceSave >= SAVE_EVERY_BATCHES) {
        sinceSave = 0;
        checkpoint();
      }
    });

    await saving;
    // Saved even when cancelled — an interrupted run keeps what it paid for.
    if (w.part !== "index") {
      onProgress({ phase: "saving", message: `Saving ${w.part} captions...` });
      await saveTranslations(token, opts.lang, w.part, w.file);
      if (!indexFile.parts.includes(w.part)) indexFile.parts.push(w.part);
    }
  }

  // The language index last: it names the caption files that now exist, so it
  // must not be written before they are. `parts` is re-derived from the files
  // rather than carried forward: an accumulated list can only lose months (see
  // translationParts), and a run whose scope never touched captions would then
  // write a shorter one.
  const actualParts = await translationParts(token, opts.lang);
  const partsChanged = JSON.stringify(actualParts) !== JSON.stringify([...indexFile.parts].sort());
  indexFile.parts = actualParts;
  if (work.length > 0 || result.dropped > 0 || partsChanged) {
    onProgress({ phase: "saving", message: "Saving day and trip text..." });
    await saveTranslations(token, opts.lang, "index", indexFile);
  }

  onProgress({
    phase: signal?.aborted ? "cancelled" : "done",
    done,
    total,
    message: `${result.translated} translated, ${result.failed} left for next time, ${result.dropped} stale entr${result.dropped === 1 ? "y" : "ies"} dropped — ${result.inputTokens.toLocaleString()} input and ${result.outputTokens.toLocaleString()} output tokens.`,
  });
  return result;
}
