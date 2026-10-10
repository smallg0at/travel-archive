import type { PhotoRecord } from "@travel-archive/shared";

/**
 * Splits a day into the places it was spent, and the moving about in between.
 *
 * A day page that lists 490 photos under one heading is a dump, not a record of
 * a day. What a person actually did is a handful of stops — a palace, a museum,
 * a restaurant — with travel between them, and that shape is already in the
 * data: photos cluster in space and time around each stop.
 *
 * Deterministic and free. GPS and timestamps come from the scan pass, so this
 * costs no tokens and runs before anything is sent to a model — the model then
 * names and describes stops it did not have to find.
 *
 * **Transit is kept, not discarded.** A third of this archive's travel days are
 * photographs taken from trains, and they are part of the day. They are simply
 * not *places*, so they collapse behind one line instead of taking a heading of
 * their own.
 */

/** A new cluster begins when the anchor moves further than this. */
const MOVE_KM = 0.35;
/** ...or when this long passes with no photos, wherever you are. */
const GAP_MINUTES = 75;

/**
 * What makes a cluster a place rather than a pause. Either test passes: a busy
 * museum visit trips the photo count in minutes, while a long slow lunch trips
 * the duration on a handful of photos.
 *
 * Tuned by hand against three real days. Lower and a passing tram-window
 * snapshot claimed its own heading; higher and a six-photo, 27-minute pause
 * stopped being a stop.
 */
const MIN_PHOTOS = 12;
const MIN_MINUTES = 25;

/**
 * A second pass, at the scale of a town rather than a street corner.
 *
 * `MOVE_KM` asks "did I walk somewhere else", which is the right question for
 * splitting a museum from the café next to it and the wrong one for a place you
 * move *around* in. Koblenz was the case that showed it: a cable car across the
 * Rhine, a fortress and the Deutsches Eck are each more than 350m apart, so the
 * visit shattered into clusters that were individually too small to be
 * substantial, and every one of them fell into the same transit run — 39 photos
 * over 105 minutes, filed as travelling. The trip map only marks `place`
 * stops, so Koblenz was on the trip's list of places and nowhere on its map.
 *
 * So the runs that failed the first test get clustered again at city scale, and
 * a cluster that looks like a visit is promoted. The bar is deliberately higher
 * than `substantial()`, because everything here has already failed that test
 * once and the failure mode is turning a train window into a destination:
 *
 * - **duration, not just count.** A 12-photo burst from a moving train at
 *   Bingen lasted four minutes; the count alone would have promoted it.
 * - **located photos, and a measured span.** With no GPS every photo joins one
 *   cluster and "within 5km" means nothing — that is how a 16-hour overnight
 *   ferry looked compact.
 * - **an upper bound on duration.** A stop of more than four hours inside a
 *   transit run *is* the transit: the ferry, the long-haul train.
 */
const CITY_KM = 5;
const PROMOTE_MIN_MINUTES = 25;
const PROMOTE_MAX_MINUTES = 240;
const PROMOTE_MIN_PHOTOS = 8;
const PROMOTE_MIN_LOCATED = 6;

export type StopKind = "place" | "transit";

export interface Stop {
  kind: StopKind;
  photos: PhotoRecord[];
  startTime: string;
  endTime: string;
}

function distanceKm(a: [number, number], b: [number, number]): number {
  const [lat1, lon1] = a;
  const [lat2, lon2] = b;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function minutesBetween(a: string, b: string): number {
  return Math.abs(new Date(b).getTime() - new Date(a).getTime()) / 60000;
}

function pointOf(photo: PhotoRecord): [number, number] | null {
  // Suspect fixes are excluded rather than trusted: one bad point would end the
  // current cluster and start a spurious one somewhere else entirely.
  if (!photo.gps || photo.gpsSuspect) return null;
  return [photo.gps.lat, photo.gps.lon];
}

/**
 * Groups a day's photos into stops, in time order.
 *
 * The anchor is the first located photo of a cluster, not a running centroid:
 * walking a few hundred metres along a street would otherwise drag the anchor
 * with it and never trip the threshold, so a whole afternoon of wandering would
 * read as one place.
 */
/**
 * Whether this photo's clock time was measured rather than invented.
 *
 * `filename-date` means the name carried a date and no time, so the stored
 * moment is midnight. Sorted in with everything else it lands *first*, and the
 * gap rule below then opens the day with a stop that never happened — 125
 * WhatsApp saves in this archive did exactly that. Their day is still right,
 * which is what they are grouped under; only their position within it is
 * unknown.
 */
function timeIsReal(photo: PhotoRecord): boolean {
  return photo.dateSource !== "filename-date";
}

/**
 * An arrival: the end of a day's last transit run, when the run finished far
 * from where it began and there are photos at the far end.
 *
 * An evening arrival by air was the case. The day's last 8 hours were one run,
 * "Flight to <city>", and the photos taken after landing were in it — too few
 * and too spread between the airport and the hotel to pass `isVisit`. The trip
 * map marks only places, so the city the day ended in was nowhere on it, and
 * nothing later in the day named it either. Only for the day's last run with
 * nothing *located* after it: a located place later in the day already covers
 * wherever the traveller got to, and an unlocated one cannot be mapped.
 *
 * The tail is walked back from the last located photo while photos stay
 * within `ARRIVAL_CITY_KM` — wider than `CITY_KM`, since an airport is rarely
 * 5km from the city it serves.
 */
const ARRIVAL_FROM_KM = 50;
const ARRIVAL_CITY_KM = 25;
const ARRIVAL_MIN_LOCATED = 3;

function arrivalTail(photos: PhotoRecord[]): PhotoRecord[] | null {
  const located = photos
    .map((photo, i) => ({ i, point: pointOf(photo) }))
    .filter((x): x is { i: number; point: [number, number] } => x.point !== null);
  if (located.length <= ARRIVAL_MIN_LOCATED) return null;
  const last = located[located.length - 1].point;
  let start = located[located.length - 1].i;
  let inCity = 0;
  for (let k = located.length - 1; k >= 0; k--) {
    if (distanceKm(located[k].point, last) > ARRIVAL_CITY_KM) break;
    start = located[k].i;
    inCity++;
  }
  // The whole run in one city is not a journey that arrived anywhere.
  if (inCity < ARRIVAL_MIN_LOCATED || start === located[0].i) return null;
  if (distanceKm(located[0].point, last) < ARRIVAL_FROM_KM) return null;
  return photos.slice(start);
}

/** `splitArrival` is only switched off to measure what it changes. */
export function detectStops(dayPhotos: PhotoRecord[], opts: { splitArrival?: boolean } = {}): Stop[] {
  const splitArrival = opts.splitArrival ?? true;
  const dated = dayPhotos.filter((p) => p.takenAt);
  const ordered = dated
    .filter(timeIsReal)
    .sort((a, b) => (a.takenAt ?? "").localeCompare(b.takenAt ?? ""));

  // Kept, not dropped: a summarized day renders only its segments, so a photo
  // in no stop is a photo that vanishes from the album. They are attached to
  // the day's last stop below, after the real ones have decided its shape.
  const untimed = dated.filter((p) => !timeIsReal(p));

  if (ordered.length === 0) {
    // Nothing measured all day. One stop rather than none, so the photos still
    // appear; the times are the midnights, which is all there is.
    if (untimed.length === 0) return [];
    return [
      {
        kind: "place",
        photos: untimed,
        startTime: untimed[0].takenAt!,
        endTime: untimed[untimed.length - 1].takenAt!,
      },
    ];
  }

  const clusters: PhotoRecord[][] = [];
  let current: PhotoRecord[] = [];
  let anchor: [number, number] | null = null;

  for (const photo of ordered) {
    const point = pointOf(photo);
    const movedAway = point !== null && anchor !== null && distanceKm(point, anchor) > MOVE_KM;
    const longPause =
      current.length > 0 && minutesBetween(current[current.length - 1].takenAt!, photo.takenAt!) > GAP_MINUTES;

    if (current.length === 0 || movedAway || longPause) {
      if (current.length > 0) clusters.push(current);
      current = [];
      anchor = point;
    }
    // A photo with no GPS joins whatever cluster is open; an indoor shot is not
    // evidence of having gone anywhere.
    if (point !== null && anchor === null) anchor = point;
    current.push(photo);
  }
  if (current.length > 0) clusters.push(current);

  const substantial = (cluster: PhotoRecord[]) =>
    cluster.length >= MIN_PHOTOS ||
    minutesBetween(cluster[0].takenAt!, cluster[cluster.length - 1].takenAt!) >= MIN_MINUTES;

  const stops: Stop[] = [];
  /** Stops made by `arrivalTail` — passed over when placing the untimed photos below. */
  const arrivals = new Set<Stop>();
  let pending: PhotoRecord[][] = [];

  const span = (photos: PhotoRecord[]): { located: number; km: number } => {
    const points = photos.map(pointOf).filter((p): p is [number, number] => p !== null);
    let km = 0;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) km = Math.max(km, distanceKm(points[i], points[j]));
    }
    return { located: points.length, km };
  };

  /** Whether a city-scale cluster inside a transit run is really a visit. */
  const isVisit = (photos: PhotoRecord[]): boolean => {
    if (photos.length < PROMOTE_MIN_PHOTOS) return false;
    const minutes = minutesBetween(photos[0].takenAt!, photos[photos.length - 1].takenAt!);
    if (minutes < PROMOTE_MIN_MINUTES || minutes > PROMOTE_MAX_MINUTES) return false;
    const { located, km } = span(photos);
    return located >= PROMOTE_MIN_LOCATED && km <= CITY_KM;
  };

  const pushStop = (kind: StopKind, photos: PhotoRecord[]) => {
    if (photos.length === 0) return;
    stops.push({ kind, photos, startTime: photos[0].takenAt!, endTime: photos[photos.length - 1].takenAt! });
  };

  /**
   * Emits the pending run, promoting any city-scale cluster in it that looks
   * like a visit and keeping the rest as transit — in time order, so the day
   * still reads forwards.
   */
  const flushTransit = (atDayEnd = false) => {
    if (pending.length === 0) return;
    let photos = pending.flat();
    pending = [];

    let arrival: PhotoRecord[] = [];
    if (atDayEnd && splitArrival) {
      arrival = arrivalTail(photos) ?? [];
      photos = photos.slice(0, photos.length - arrival.length);
    }

    let run: PhotoRecord[] = [];
    let anchor: [number, number] | null = null;
    const groups: PhotoRecord[][] = [];
    for (const photo of photos) {
      const point = pointOf(photo);
      if (point !== null && anchor !== null && distanceKm(point, anchor) > CITY_KM) {
        groups.push(run);
        run = [];
        anchor = point;
      }
      if (point !== null && anchor === null) anchor = point;
      run.push(photo);
    }
    if (run.length > 0) groups.push(run);

    let travelling: PhotoRecord[] = [];
    for (const group of groups) {
      if (isVisit(group)) {
        pushStop("transit", travelling);
        travelling = [];
        pushStop("place", group);
      } else {
        travelling.push(...group);
      }
    }
    pushStop("transit", travelling);
    if (arrival.length > 0) {
      pushStop("place", arrival);
      arrivals.add(stops[stops.length - 1]);
    }
  };

  const located = (photos: PhotoRecord[]) => photos.some((p) => pointOf(p) !== null);
  for (const [i, cluster] of clusters.entries()) {
    if (substantial(cluster)) {
      // Nothing located for the rest of the day means no later stop can put
      // where the journey ended on the map, so this run's end is an arrival —
      // a day that ends in seven hotel photos with no GPS after the flight.
      flushTransit(!clusters.slice(i).some(located));
      pushStop("place", cluster);
    } else {
      pending.push(cluster);
    }
  }
  flushTransit(true);

  // The untimed photos join the day's last *place*. Their own start/end are not
  // merged in, so the stop keeps the times that were actually measured rather
  // than being stretched back to midnight.
  //
  // A place rather than simply the last stop: transit collapses behind a single
  // line in the app, and a day that ends in transit — which would have buried
  // 119 photos there. Falling back to the last stop only when the day has no
  // place at all. Appending rather than prepending because it cannot then
  // change how the day opens, and because a WhatsApp save is dated when it
  // landed rather than when it was taken.
  //
  // It does associate them with that stop's place, which is a guess. The day is
  // flagged `timeUncertain` so the summarizer is told not to narrate when
  // things happened, but the guess is why this is worth revisiting if these
  // ever become more than a fraction of a day.
  //
  // Not an arrival, when there is another place: a few photos taken after
  // getting off a train would otherwise carry every undated photo of the day —
  // one day thirty of them moved from one place to a four-photo arrival.
  if (untimed.length > 0 && stops.length > 0) {
    const places = stops.map((s, i) => (s.kind === "place" ? i : -1)).filter((i) => i >= 0);
    const settled = places.filter((i) => !arrivals.has(stops[i]));
    const lastPlace = settled.pop() ?? places.pop();
    stops[lastPlace ?? stops.length - 1].photos.push(...untimed);
  }

  return stops;
}
