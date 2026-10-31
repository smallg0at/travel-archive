/**
 * A photograph is a second level under the view it was opened from.
 *
 * `#trip/<id>/photo/<photoId>`, `#month/<id>/photo/<photoId>`,
 * `#home/photo/<photoId>`. The view is the prefix rather than a side channel,
 * so Back returns to exactly the page the photograph came from — the card's
 * grid, the search results, the home page — and the strip can be rebuilt from
 * that view's own data on a cold load.
 *
 * **What the URL cannot carry is which list was clicked.** Opening a card's
 * photograph gives the card's pictures; opening the same photograph from a
 * stop's grid gives the day's. Both are `#trip/<id>/photo/<photoId>`, and the
 * difference is real: the strip is a property of the gesture, not of the
 * address. Within one session the list that was clicked is kept in memory;
 * after a reload the photograph is restored inside its day, which is the only
 * list the archive can rebuild without knowing what the reader was doing.
 */

import type { ArchiveIndexFile, PhotoRecord } from "@travel-archive/shared";
import { loadMonth } from "./archiveData";

/** The view hash a photograph was opened over, without its `/photo/…` tail. */
export function splitPhoto(hash: string): { view: string; photoId: string | null } {
  // Matched from the right: a trip id may itself contain a slash.
  const at = hash.lastIndexOf("/photo/");
  if (at <= 0) return { view: hash, photoId: null };
  return { view: hash.slice(0, at), photoId: decodeURIComponent(hash.slice(at + 7)) };
}

/** The address of a photograph over `view`. */
export function photoHash(view: string, photoId: string): string {
  return `${view}/photo/${encodeURIComponent(photoId)}`;
}

// --- What the archive knows about the view on screen -----------------------

let baseView = "#home";
let index: ArchiveIndexFile | null = null;

/** Called by the album on every navigation: the page under any photograph. */
export function setBaseView(hash: string): void {
  baseView = splitPhoto(hash).view;
}

/** The index, so a photograph can be found inside its trip without a round trip. */
export function setIndex(next: ArchiveIndexFile): void {
  index = next;
}

/** The view the reader is looking at, photograph or not. */
export function currentBaseView(): string {
  const { view } = splitPhoto(location.hash);
  return view || baseView;
}

/**
 * The photographs to put beside a photograph being opened from the address.
 *
 * Only the two views that carry their own dates can answer: a trip knows its
 * days, and a month is a shard. `#home/photo/…` and `#search/photo/…` name a
 * view that spans the whole library, and the archive has no photo-to-shard
 * index to search — those addresses work while the session is alive and
 * degrade to the plain view after a reload, which is the honest outcome
 * rather than a viewer that opens on nothing.
 */
export async function resolveSession(
  photoId: string,
): Promise<{ photos: PhotoRecord[]; index: number } | null> {
  const month = monthFor(photoId);
  if (!month) return null;

  let photos: Record<string, PhotoRecord>;
  try {
    photos = (await loadMonth(month)).photos;
  } catch {
    return null;
  }
  const photo = photos[photoId];
  if (!photo) return null;

  // The day, not the month: a strip of a month's photographs is a different
  // thing to browse than the day the reader was looking at.
  const date = (photo.takenAt ?? "").slice(0, 10);
  const siblings = Object.values(photos)
    .filter((p) => (p.takenAt ?? "").slice(0, 10) === date)
    .sort((a, b) => (a.takenAt ?? "").localeCompare(b.takenAt ?? ""));
  const at = siblings.findIndex((p) => p.id === photoId);
  return { photos: siblings.length ? siblings : [photo], index: Math.max(at, 0) };
}

/**
 * Which month shard holds a photograph.
 *
 * A month view names it outright. Everything else is looked up in the index's
 * trip days, which is what lets a home-page or search link survive a reload:
 * most of those photographs belong to a trip, and a trip's days carry their
 * photo ids. A photograph outside every trip is only reachable while the
 * session that opened it is alive — the archive has no photo-to-shard index to
 * search, and scanning eighty shards to satisfy one link is not a trade worth
 * making.
 */
function monthFor(photoId: string): string | null {
  const view = currentBaseView();
  if (view.startsWith("#month/")) return decodeURIComponent(view.slice("#month/".length));
  if (!index) return null;
  for (const section of index.sections) {
    const day = section.days.find((d) => d.photoIds.includes(photoId));
    if (day) return day.date.slice(0, 7);
  }
  return null;
}
