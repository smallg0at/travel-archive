import { readFile } from "node:fs/promises";
import type { PhotoRecord, ScreenshotPolicy } from "@travel-archive/shared";

/**
 * Decides which screenshots may be described by an AI model, from a
 * user-maintained allowlist of source apps.
 *
 * Screenshots are 5.7% of this library and the part most likely to hold private
 * data — WeChat threads, Outlook, SMS, banking, rail tickets carrying names and
 * ID numbers, and browser captures that could contain literally anything.
 *
 * This replaced a local vision model that was asked to judge each screenshot.
 * Two things killed that idea. The runtime was unusable: Ollama crashed on
 * roughly half of all calls with an idle GPU, identically with and without a
 * constrained-output schema. And when it did answer it was wrong more often
 * than not — it filed a game as a private message, called a train departure
 * board "generic UI", and excluded a rail ticket the prompt explicitly told it
 * to keep.
 *
 * Android writes the source app's package into the screenshot filename, which
 * is a far better signal than a 2B model's opinion: it is exact, free, instant,
 * and auditable. So the policy is **default-deny** — a screenshot is analyzable
 * only if its app is listed. Anything unrecognised (including every browser
 * capture, and the ~9% with no package in the name) is kept in the album and
 * simply never described or summarized.
 *
 * Excluding is not deleting. Nothing is hidden from the user's own archive;
 * only the AI passes are held back.
 */

const ALLOWLIST_FILE = new URL("../screenshot-apps.json", import.meta.url);

/** Android screenshot names end in the source app's package: `Screenshot_<when>_<package>.jpg`. */
const PACKAGE_IN_NAME = /_([a-z][a-z0-9_]*(?:\.[a-z0-9_]+){1,})(?:-edit)?\.[a-z0-9]+$/i;

export function isScreenshot(fileName: string): boolean {
  return /^screenshot/i.test(fileName);
}

export function packageOf(fileName: string): string | null {
  return fileName.match(PACKAGE_IN_NAME)?.[1] ?? null;
}

interface AllowlistFile {
  include?: string[];
}

/**
 * Loads the allowlist. A missing or unreadable file yields an empty list, which
 * means *nothing* is analyzable — the safe direction to fail in. A typo should
 * cost some captions, never a leaked conversation.
 */
export async function loadScreenshotAllowlist(): Promise<string[]> {
  try {
    const raw = await readFile(ALLOWLIST_FILE, "utf-8");
    const parsed = JSON.parse(raw) as AllowlistFile;
    return (parsed.include ?? []).map((s) => s.toLowerCase());
  } catch {
    return [];
  }
}

/**
 * Matching is a case-insensitive substring test rather than an exact package
 * name, so one entry can cover a family (`hafas` catches both the German and
 * Austrian rail apps) and the file stays readable for a human to edit.
 */
export function screenshotPolicyFor(fileName: string, allowlist: string[]): ScreenshotPolicy {
  const sourceApp = packageOf(fileName);
  if (!sourceApp) return { sourceApp: null, analyzable: false };

  const lower = sourceApp.toLowerCase();
  return { sourceApp, analyzable: allowlist.some((entry) => lower.includes(entry)) };
}

/**
 * Whether an AI pass may look at this photo at all. Camera photos always may;
 * a screenshot only if its source app is allowlisted. This is the single gate
 * every AI pass must consult — it is what keeps private screenshots off the
 * wire, so it belongs in one place rather than being re-derived per caller.
 */
export function mayBeAnalyzed(photo: PhotoRecord): boolean {
  return photo.screenshot === null || photo.screenshot.analyzable;
}
