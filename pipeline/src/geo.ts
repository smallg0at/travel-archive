import type { GeoPoint, PhotoRecord } from "@travel-archive/shared";

/**
 * Flags GPS points that cannot be true, rather than points that are merely far
 * from the rest of their day.
 *
 * 92% of this library carries coordinates, so location is a major input to day
 * summaries — which makes a bad fix expensive. Phones write wrong coordinates
 * routinely: a cached fix from the last city, a screenshot that inherited
 * location from wherever it was saved, a photo of a photo.
 *
 * **The previous rule flagged anything >100km from the day's median, and that
 * was wrong in the case that matters most.** A travel day legitimately spans
 * countries: on 2026-09-02 the archive flew a city → a city → the capital, and
 * because the airport held the median, all 21 genuinely-correct the capital fixes were
 * marked suspect and dropped — from stop detection, from the day's place, and
 * from the map, which is why the city airport never appeared on it. 54 of that day's
 * photos were discarded as bad data. The days a travel archive most needs to
 * get right are exactly the days that rule broke.
 *
 * So the test is now physical rather than statistical: a fix is suspect when
 * reaching it from its neighbour in time would require an impossible speed. A
 * flight at 900km/h passes; a jump of 500km in two minutes does not. That
 * catches the actual failure — a stale or inherited coordinate appearing
 * mid-sequence — without punishing a day for moving.
 */

/**
 * Faster than any civilian journey, with headroom.
 *
 * Airliners cruise near 900km/h, and timestamps are only accurate to the
 * second, so short gaps inflate the implied speed badly — hence the floor
 * below rather than a tighter limit here.
 */
const MAX_SPEED_KMH = 1200;

/**
 * Gaps shorter than this are not used for a speed test. Two photos seconds
 * apart with a 200m GPS scatter imply hundreds of km/h, which says nothing
 * about either fix.
 */
const MIN_GAP_SECONDS = 90;

/**
 * A jump smaller than this is never suspect however fast it looks. Walking out
 * of a building and regaining signal moves a fix a few hundred metres
 * instantly; that is normal, not evidence of a wrong location.
 */
const MIN_JUMP_KM = 25;

const EARTH_RADIUS_KM = 6371;

export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The median is the point of using a median rather than a mean: it is not
 * dragged toward an outlier, so a single wrong fix can't move the reference far
 * enough to make itself look reasonable.
 */
export function medianPoint(points: GeoPoint[]): GeoPoint | null {
  if (points.length === 0) return null;
  return { lat: median(points.map((p) => p.lat)), lon: median(points.map((p) => p.lon)) };
}

/** Implied speed between two located photos, or null when the gap is too short to judge. */
function impliedSpeedKmh(a: PhotoRecord, b: PhotoRecord): number | null {
  if (!a.takenAt || !b.takenAt) return null;
  const seconds = Math.abs(new Date(b.takenAt).getTime() - new Date(a.takenAt).getTime()) / 1000;
  if (seconds < MIN_GAP_SECONDS) return null;
  const km = haversineKm(a.gps!, b.gps!);
  if (km < MIN_JUMP_KM) return 0;
  return km / (seconds / 3600);
}

/**
 * Marks `gpsSuspect` on one day's photos, mutating in place.
 *
 * A point is suspect only when it is unreachable from *both* the located photo
 * before it and the one after. Requiring both is what lets a real journey
 * through: the first fix after landing is unreachable from the one before it,
 * but perfectly reachable from the next, so it stands. A single stale
 * coordinate dropped into the middle of a sequence is unreachable in both
 * directions, and is flagged.
 *
 * Fewer than three located photos is left alone — there is not enough to say
 * which of two points is the odd one out, and guessing would be worse.
 */
export function flagGpsOutliers(dayPhotos: PhotoRecord[]): void {
  for (const photo of dayPhotos) photo.gpsSuspect = false;

  const located = dayPhotos
    .filter((p) => p.gps && p.takenAt)
    .sort((a, b) => a.takenAt!.localeCompare(b.takenAt!));
  if (located.length < 3) return;

  for (const [i, photo] of located.entries()) {
    const before = i > 0 ? impliedSpeedKmh(located[i - 1], photo) : null;
    const after = i < located.length - 1 ? impliedSpeedKmh(photo, located[i + 1]) : null;

    // Null means "no opinion" — too short a gap to judge — and must not count
    // as evidence against the point.
    const unreachableBefore = before !== null && before > MAX_SPEED_KMH;
    const unreachableAfter = after !== null && after > MAX_SPEED_KMH;
    const judged = before !== null || after !== null;

    photo.gpsSuspect =
      judged &&
      (before === null ? unreachableAfter : after === null ? unreachableBefore : unreachableBefore && unreachableAfter);
  }
}

/** Applies the per-day outlier check across a whole shard, grouping by capture date. */
export function flagGpsOutliersByDay(photos: PhotoRecord[]): void {
  const byDay = new Map<string, PhotoRecord[]>();
  for (const photo of photos) {
    const day = photo.takenAt ? photo.takenAt.slice(0, 10) : "undated";
    const list = byDay.get(day) ?? [];
    list.push(photo);
    byDay.set(day, list);
  }
  for (const dayPhotos of byDay.values()) flagGpsOutliers(dayPhotos);
}

/** The coordinates a day's place should be derived from — suspect points excluded. */
export function trustworthyPoints(dayPhotos: PhotoRecord[]): GeoPoint[] {
  return dayPhotos.filter((p) => p.gps && !p.gpsSuspect).map((p) => p.gps!);
}
