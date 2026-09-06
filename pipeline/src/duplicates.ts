import type { DuplicateKind, PhotoRecord } from "@travel-archive/shared";

/**
 * Finds photos that are redundant copies of another photo, so the album can
 * collapse them and the AI pass can skip them.
 *
 * This replaced a timestamp-window "burst detector", which was a mistake worth
 * recording. That heuristic grouped anything taken within N seconds, and the
 * numbers it produced were an artifact of the window rather than the library:
 * 10 seconds claimed 44% of photos were near-duplicates, 1 second claimed
 * 15.5%. Inspecting the groups showed what they really contained — 88% spanned
 * *zero* seconds because they were the same file stored twice, and the rest
 * were ordinary sequential photos that happened to be close together. It had
 * grouped an illustration with an unrelated sticker, and a statue with a
 * museum signboard photographed four seconds later.
 *
 * Measured against the real archive, the honest figure is 1.9%. So this looks
 * for the two signals that are actually precise instead:
 *
 *  1. Duplicate files — Windows and OneDrive append " 1", " 2", "(1)" when a
 *     name collides, so the copies differ only by that suffix while sharing
 *     dimensions and capture time.
 *  1b. The same bytes — identical capture instant, dimensions *and* file size.
 *     Independent of naming, so it catches copies whose names diverged. The two
 *     rules were measured against each other over the whole library and agree
 *     to within two groups (1102 vs 1100), which is what makes either
 *     trustworthy.
 *  2. Camera-labelled bursts — the phone writes `_BURST1`, `_BURST10` into the
 *     filename itself, which is ground truth rather than inference.
 *
 * Both are exact. Neither can hide content that isn't genuinely a repeat,
 * which is the failure mode that matters: paying to caption a redundant photo
 * costs a fraction of a cent, while hiding a museum placard loses something
 * from the archive permanently.
 */

/**
 * A copy suffix, which must be *separated* from the stem.
 *
 * This was `/[ _-]?\(?\d{1,2}\)?$/`, with the separator optional — so it
 * stripped the last one or two digits from any name ending in digits.
 * `IMG_20260830_100620 1.jpg` correctly became `IMG_20260830_100620.jpg`, but
 * its original `IMG_20260830_100620.jpg` became `IMG_20260830_1006.jpg`, and
 * the pair never matched. Detection only worked when *both* files carried a
 * suffix: 15 of 122 groups on one trip, and 324 copies library-wide against a
 * true 1,357.
 */
const DUP_SUFFIX = /(?:[ -]\d{1,2}|\s*\(\d{1,2}\))$/;
const BURST_TAG = /_BURST\d+/i;

/** "IMG_1234 2.jpg" -> "IMG_1234.jpg". Leaves names without a copy suffix alone. */
function stripCopySuffix(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  return `${stem.replace(DUP_SUFFIX, "").trim()}${ext}`;
}

/**
 * Copies must agree on name, pixel dimensions *and* capture time. Requiring
 * all three keeps genuinely different photos apart when a camera happens to
 * roll over to a colliding name.
 */
function duplicateKeyOf(photo: PhotoRecord): string {
  return `dup:${stripCopySuffix(photo.fileName)}|${photo.width}x${photo.height}|${photo.takenAt ?? "?"}`;
}

/**
 * Byte identity: same instant, same pixels, same file size. Two genuinely
 * different exposures do not collide on all three, and unlike the name rule
 * this needs no assumption about how the copies were named.
 */
function byteKeyOf(photo: PhotoRecord): string | null {
  if (!photo.takenAt || photo.width === null || photo.height === null) return null;
  return `bytes:${photo.takenAt}|${photo.width}x${photo.height}|${photo.bytes}`;
}

/** Everything before `_BURSTn` names the sequence the frame belongs to. */
function burstKeyOf(photo: PhotoRecord): string | null {
  if (!BURST_TAG.test(photo.fileName)) return null;
  return `burst:${photo.fileName.split(/_BURST/i)[0]}`;
}

/**
 * The copy to keep. Largest file wins: among byte-identical duplicates it's
 * arbitrary but stable, and among burst frames a blurry one compresses smaller,
 * so this leans toward the sharpest frame.
 */
function pickRepresentative(group: PhotoRecord[]): PhotoRecord {
  return group.reduce((best, photo) => (photo.bytes > best.bytes ? photo : best), group[0]);
}

/**
 * Assigns duplicate-group fields across one shard's photos, mutating in place.
 * Fields are cleared first so re-scanning re-derives them from scratch.
 */
export function assignDuplicates(photos: PhotoRecord[]): void {
  for (const photo of photos) {
    photo.duplicateGroupId = null;
    photo.duplicateKind = null;
    photo.isDuplicateRepresentative = false;
  }

  const groups = new Map<string, PhotoRecord[]>();
  for (const photo of photos) {
    // A camera-labelled burst wins over the copy-suffix rule: burst frames are
    // named `..._BURST1`, `..._BURST10`, which the suffix stripper would
    // otherwise fold together as if they were copies of one file.
    const key = burstKeyOf(photo) ?? byteKeyOf(photo) ?? duplicateKeyOf(photo);
    groups.set(key, [...(groups.get(key) ?? []), photo]);
  }

  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const kind: DuplicateKind = key.startsWith("burst:") ? "burst" : "exact";
    const representative = pickRepresentative(group);
    for (const photo of group) {
      photo.duplicateGroupId = `${kind}-${representative.id}`;
      photo.duplicateKind = kind;
      photo.isDuplicateRepresentative = photo.id === representative.id;
    }
  }
}

/**
 * The photos `analyze` should spend tokens on: everything except redundant
 * copies. A photo with no duplicate group is always included.
 */
export function analysisTargets(photos: PhotoRecord[]): PhotoRecord[] {
  return photos.filter((p) => !p.duplicateGroupId || p.isDuplicateRepresentative);
}
