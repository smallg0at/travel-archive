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

  const all = dayPhotos
    .filter((p) => p.gps && p.takenAt)
    .sort((a, b) => a.takenAt!.localeCompare(b.takenAt!));
  if (all.length < 3) return;

  // Excursions first, and the point-by-point test only over what they leave.
  // Otherwise a good photo is judged against the bad run next to it — the
  // first the capital photo after the a city run was flagged, and the run was not.
  flagExcursions(all);
  const located = all.filter((p) => !p.gpsSuspect);
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

/**
 * The fastest a real same-day round trip averages, there and back.
 *
 * Deliberately far below MAX_SPEED_KMH, which has to allow a single flight.
 * A round trip averages its whole elapsed time, boarding and all: a day trip
 * by air covers perhaps 1,200km in eight hours, 150km/h. The run this exists
 * for needed 765km/h to reach a city and back, before counting India.
 */
const MAX_ROUND_TRIP_KMH = 400;

/** Photos a stay needs, either side of a detour, to count as where the day really was. */
const MIN_ANCHOR_PHOTOS = 3;

/**
 * Flags runs of bad fixes that leave a place and come back to it too fast.
 *
 * The point-by-point test cannot see these. Underground at the Postal
 * Museum's Mail Rail on 2025-10-07 the phone logged four photos near
 * a city and then three in a city, India, before surfacing in the capital 45
 * minutes after it went down. Each bad photo was reachable from its bad
 * neighbour — same point, zero speed — so none was "unreachable from both",
 * and India appeared on the map of everywhere the owner has been.
 *
 * So: group the day into runs of nearby photos, and wherever the day returns
 * to a run it left, ask whether the detour in between could have been made in
 * the time. If going to its farthest point and back is faster than any real
 * round trip, and the detour has fewer photos than the stay on either side of
 * it, every photo in the detour is suspect.
 */
export function flagExcursions(located: PhotoRecord[]): void {
  const runs: PhotoRecord[][] = [];
  for (const photo of located) {
    const run = runs[runs.length - 1];
    if (run && haversineKm(run[0].gps!, photo.gps!) < MIN_JUMP_KM) run.push(photo);
    else runs.push([photo]);
  }

  for (let i = 0; i < runs.length - 2; i++) {
    const home = runs[i][0].gps!;
    // The next time the day is back where it was.
    let back = -1;
    for (let j = i + 2; j < runs.length; j++) {
      if (haversineKm(home, runs[j][0].gps!) < MIN_JUMP_KM) {
        back = j;
        break;
      }
    }
    if (back === -1) continue;

    const left = new Date(runs[i][runs[i].length - 1].takenAt!).getTime();
    const returned = new Date(runs[back][0].takenAt!).getTime();
    const hours = Math.max((returned - left) / 3_600_000, 1 / 60);
    const detour = runs.slice(i + 1, back);
    const farthest = Math.max(...detour.map((run) => haversineKm(home, run[0].gps!)));
    if ((2 * farthest) / hours <= MAX_ROUND_TRIP_KMH) continue;
    // And the detour has to be the minority on both sides. Otherwise one stale
    // fix reads as "back home" and condemns the real journey around it: a lone
    // a city point at 10:23 on 2026-05-27 flagged the whole road trip past
    // a town and a village. That point is the outlier, and the test below —
    // one point, unreachable both ways — is what catches it.
    const detourPhotos = detour.reduce((n, run) => n + run.length, 0);
    if (detourPhotos >= Math.min(runs[i].length, runs[back].length)) continue;
    // Solid on both sides. With one stuck coordinate interleaved through a
    // day — a city, 52 times at the identical point, between real stops on
    // the road north — single stuck fixes are runs of one, and must not be
    // taken for home.
    if (runs[i].length < MIN_ANCHOR_PHOTOS || runs[back].length < MIN_ANCHOR_PHOTOS) continue;
    // And nowhere else today. Every bad run found — a city, a city, a city,
    // a county — appears once and never again, while two sources interleaved
    // all day (the capital 146 times and Oxford 94 on 2023-08-12) visit each place
    // repeatedly. There is no telling which of those is real, so neither is
    // flagged.
    const recurs = runs.some(
      (run, r) => (r < i || r > back) && detour.some((d) => haversineKm(d[0].gps!, run[0].gps!) < MIN_JUMP_KM),
    );
    if (recurs) continue;

    for (const run of detour) for (const photo of run) photo.gpsSuspect = true;
    i = back - 1;
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
