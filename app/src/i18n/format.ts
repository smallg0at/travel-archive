import { contentLanguage } from "../contentLang";

/**
 * Dates and numbers in the reader's language, not the browser's.
 *
 * Every `toLocale*` call used to pass `undefined`, which on this machine
 * (browser languages en-GB, zh-Hans-CN) gave English dates under an English
 * interface — but only by luck of the order. A reader who chose 简体中文 should
 * read 2026年9月6日 whatever the browser prefers, and one who chose English should
 * not get Chinese dates because the browser lists Chinese first. English still
 * takes the browser's own English (en-GB vs en-US) when it has one.
 */
const LOCALE =
  contentLanguage() === "zh-Hans"
    ? "zh-Hans-CN"
    : (navigator.languages.find((l) => /^en\b/i.test(l)) ?? "en-GB");

export function locale(): string {
  return LOCALE;
}

export function num(n: number): string {
  return n.toLocaleString(LOCALE);
}

/** Token counts as the Generate page quotes them: millions, two places. */
export function millions(n: number): string {
  return (n / 1e6).toFixed(2);
}

export function fmtDate(date: Date, options: Intl.DateTimeFormatOptions): string {
  return date.toLocaleDateString(LOCALE, options);
}

export function fmtDateTime(date: Date, options: Intl.DateTimeFormatOptions): string {
  return date.toLocaleString(LOCALE, options);
}
