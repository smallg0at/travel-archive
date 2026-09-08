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
 * Tuned by hand against three real days. Lower and a city's tram-window
 * shots each claimed their own heading; higher and the the pavilion (6 photos over
 * 27 minutes) stopped being a stop.
 */
const MIN_PHOTOS = 12;
const MIN_MINUTES = 25;

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

export function detectStops(dayPhotos: PhotoRecord[]): Stop[] {
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
  let pending: PhotoRecord[][] = [];

  const flushTransit = () => {
    if (pending.length === 0) return;
    const photos = pending.flat();
    stops.push({
      kind: "transit",
      photos,
      startTime: photos[0].takenAt!,
      endTime: photos[photos.length - 1].takenAt!,
    });
    pending = [];
  };

  for (const cluster of clusters) {
    if (substantial(cluster)) {
      flushTransit();
      stops.push({
        kind: "place",
        photos: cluster,
        startTime: cluster[0].takenAt!,
        endTime: cluster[cluster.length - 1].takenAt!,
      });
    } else {
      pending.push(cluster);
    }
  }
  flushTransit();

  // The untimed photos join the day's last *place*. Their own start/end are not
  // merged in, so the stop keeps the times that were actually measured rather
  // than being stretched back to midnight.
  //
  // A place rather than simply the last stop: transit collapses behind a single
  // line in the app, and 2026-09-07 ends in transit — which would have buried
  // 119 photos there. Falling back to the last stop only when the day has no
  // place at all. Appending rather than prepending because it cannot then
  // change how the day opens, and because a WhatsApp save is dated when it
  // landed rather than when it was taken.
  //
  // It does associate them with that stop's place, which is a guess. The day is
  // flagged `timeUncertain` so the summarizer is told not to narrate when
  // things happened, but the guess is why this is worth revisiting if these
  // ever become more than a fraction of a day.
  if (untimed.length > 0 && stops.length > 0) {
    const lastPlace = stops.map((s, i) => (s.kind === "place" ? i : -1)).filter((i) => i >= 0).pop();
    stops[lastPlace ?? stops.length - 1].photos.push(...untimed);
  }

  return stops;
}
