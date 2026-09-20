import { readFile, writeFile } from "node:fs/promises";
import type { ArchiveIndexFile, DayExcursion, PhotoRecord, PhotoShard } from "@travel-archive/shared";
import { getAccessToken } from "../auth.js";
import { loadAllShards, loadIndexForReading } from "../archiveStore.js";
import { dataFile } from "../paths.js";
import { loadTripDefinitions, type TripDefinition } from "../tripDefs.js";

/**
 * Trips proposed from where the nights were spent, for the owner to accept.
 *
 * Detecting trips from GPS was tried once and dropped (see jobs/trip.ts): it
 * measured each *day's* distance from a fixed home, and no threshold separated
 * a trip from a day out — a real trip's first day sat 105km from home, an
 * ordinary day out at 87km. This measures something else: **where each night
 * was spent**. A day out, however far, ends at home; a trip, however near —
 * a town is 75km from the capital — has a night somewhere else. The night is the
 * last fixes of one day, and it is confirmed when the next morning starts in
 * the same place.
 *
 * Home is not fixed either. It is the place with nights in the most distinct
 * weeks within a few months either side, so it follows a move and is not
 * outvoted by one long, heavily photographed trip — eighteen nights away are
 * three weeks, and home has nights in a dozen.
 *
 * These are suggestions only. Nothing is written until the owner accepts one,
 * and a range the owner has already defined is never proposed over.
 */

/** A night further than this from home was spent away. a town is 75km from the capital. */
const AWAY_KM = 40;
/** Days without a located photo that a trip may span, between two nights away. */
const MAX_GAP_DAYS = 3;
/** Nights either side of a date that decide where home was then. */
const HOME_WINDOW_DAYS = 120;
/** A photo this far from home belongs to the trip's places rather than its edges. */
const PLACE_KM = AWAY_KM;
/** The morning must start this near the evening before for the night to be sure. */
const SAME_NIGHT_KM = 50;
/**
 * Photos away from home a suggestion needs. Below this it is one photo from a
 * night out, or a stray fix: 1 photo in Basildon, 2 at Badaling.
 */
const MIN_AWAY_PHOTOS = 10;

const CJK = /[一-鿿]/;

export interface TripSuggestion {
  startDate: string;
  endDate: string;
  nights: number;
  photoCount: number;
  /** Furthest photo from home, in km. */
  farthestKm: number;
  /** Most-photographed places away from home, biggest first, in English and Chinese. */
  places: { en: string; zh: string | null; photos: number }[];
  /** Countries visited other than home's, most photos first. */
  countries: { en: string; zh: string | null }[];
  /** A name to start from, in both languages. The owner is expected to change it. */
  name: { en: string; zh: string };
  /** Where home was measured to be, for the "why" line. */
  home: { en: string | null; zh: string | null };
  /** Nights the next morning did not confirm (a day without photos followed). */
  unconfirmedNights: number;
}

interface Fix {
  lat: number;
  lon: number;
}

interface DayGeo {
  date: string;
  morning: Fix;
  evening: Fix;
  photos: PhotoRecord[];
}

function km(a: Fix, b: Fix): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The median of a few fixes, so one stray point cannot move a night. */
function middle(fixes: PhotoRecord[]): Fix {
  return { lat: median(fixes.map((p) => p.gps!.lat)), lon: median(fixes.map((p) => p.gps!.lon)) };
}

const dayNumber = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

/** "a city" from "a city, Austria"; the country from the last part. */
const head = (name: string) => name.split(",")[0].trim();
const tail = (name: string) => {
  const comma = name.lastIndexOf(",");
  return comma === -1 ? name.trim() : name.slice(comma + 1).trim();
};

/**
 * Where the nights around each day were spent, as a grid of ~20km cells;
 * home is the cell (with its neighbours) that has nights in the most distinct
 * weeks within HOME_WINDOW_DAYS.
 */
function homeFinder(nights: { day: number; at: Fix }[]): (day: number) => Fix | null {
  const CELL = 0.2;
  const cellOf = (f: Fix) => [Math.floor(f.lat / CELL), Math.floor((f.lon * Math.cos((f.lat * Math.PI) / 180)) / CELL)];
  const cells = nights.map((n) => ({ ...n, cell: cellOf(n.at) }));
  const cache = new Map<number, Fix | null>();
  return (day: number) => {
    const week = Math.floor(day / 7);
    if (cache.has(week)) return cache.get(week)!;
    const near = cells.filter((n) => Math.abs(n.day - day) <= HOME_WINDOW_DAYS);
    const weeks = new Map<string, Set<number>>();
    for (const n of near) {
      // A night counts for its own cell and its neighbours, so a home on a
      // cell boundary is not split in two.
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const key = `${n.cell[0] + dy},${n.cell[1] + dx}`;
          let set = weeks.get(key);
          if (!set) weeks.set(key, (set = new Set()));
          set.add(Math.floor(n.day / 7));
        }
      }
    }
    let best: string | null = null;
    let bestWeeks = 0;
    for (const [key, set] of weeks) {
      if (set.size > bestWeeks) {
        best = key;
        bestWeeks = set.size;
      }
    }
    let home: Fix | null = null;
    // Two weeks at least: with fewer, "home" would be wherever the only trip was.
    if (best && bestWeeks >= 2) {
      const [cy, cx] = best.split(",").map(Number);
      const members = near.filter((n) => Math.abs(n.cell[0] - cy) <= 1 && Math.abs(n.cell[1] - cx) <= 1);
      home = { lat: median(members.map((m) => m.at.lat)), lon: median(members.map((m) => m.at.lon)) };
    }
    cache.set(week, home);
    return home;
  };
}

/**
 * Each day that has GPS, in order, with where it started and ended.
 *
 * Shared by the trip suggestions and the day excursions below, so both agree
 * on what a day's evening was and where home was that week.
 */
function dayGeography(index: ArchiveIndexFile, shards: Map<string, PhotoShard>): DayGeo[] {
  const days: DayGeo[] = [];
  for (const day of index.sections.flatMap((s) => s.days).sort((a, b) => a.date.localeCompare(b.date))) {
    const shard = shards.get(day.date.slice(0, 7));
    if (!shard) continue;
    const located = day.photoIds
      .map((id) => shard.photos[id])
      .filter((p): p is PhotoRecord => Boolean(p?.gps && !p.gpsSuspect && p.takenAt))
      .sort((a, b) => a.takenAt!.localeCompare(b.takenAt!));
    if (!located.length) continue;
    days.push({
      date: day.date,
      morning: middle(located.slice(0, 3)),
      evening: middle(located.slice(-3)),
      photos: located,
    });
  }
  return days;
}

/**
 * Where each day's night was spent: away, or at home.
 *
 * The evening alone is not enough. A day out usually ends with its photos
 * still at the destination — the last of the light, the platform, the train —
 * so an evening 200km from home says where the camera was at six, not where
 * its owner slept. The next morning settles it: a morning at home means the
 * night was too, however late the last photo was taken. Only when the next
 * morning is unknown, or is itself away, does the evening decide.
 *
 * Getting this wrong went both ways: York and a city were offered as
 * one-night trips, and genuine days out were hidden behind the same mistake.
 */
function nightsAway(days: DayGeo[], homeAt: (day: number) => Fix | null): boolean[] {
  return days.map((day, i) => {
    const home = homeAt(dayNumber(day.date));
    if (!home) return false;
    if (km(day.evening, home) <= AWAY_KM) return false;
    const next = days[i + 1];
    const nextMorning = next && dayNumber(next.date) === dayNumber(day.date) + 1 ? next.morning : null;
    if (nextMorning && km(nextMorning, home) <= AWAY_KM) return false;
    return true;
  });
}

export function suggestTrips(
  index: ArchiveIndexFile,
  shards: Map<string, PhotoShard>,
  defined: TripDefinition[],
  dismissed: Set<string> = new Set(),
): TripSuggestion[] {
  const days = dayGeography(index, shards);

  const homeAt = homeFinder(days.map((d) => ({ day: dayNumber(d.date), at: d.evening })));
  const away = nightsAway(days, homeAt);

  // Chinese names where the gazetteer has none: a Chinese place's endonym is
  // Chinese already (漠河 where the English is Mohe), and a country's name is
  // learnt from any photo that has one.
  const countryZh = new Map<string, string>();
  for (const d of days) {
    for (const p of d.photos) {
      if (p.placeNames?.zh) countryZh.set(tail(p.placeNames.en), tail(p.placeNames.zh));
    }
  }
  const zhOf = (p: PhotoRecord) => {
    if (p.placeNames?.zh) return head(p.placeNames.zh);
    return p.place && CJK.test(p.place) ? head(p.place) : null;
  };
  /** Home's own name: the named evening nearest it, from the days around. */
  const homeNameAt = (day: number, home: Fix) => {
    let best: PhotoRecord | null = null;
    let bestKm = Infinity;
    for (const d of days) {
      if (Math.abs(dayNumber(d.date) - day) > HOME_WINDOW_DAYS) continue;
      const p = d.photos[d.photos.length - 1];
      if (!p.placeNames) continue;
      const distance = km(p.gps!, home);
      if (distance < bestKm) {
        best = p;
        bestKm = distance;
      }
    }
    return best ? { en: head(best.placeNames!.en), zh: zhOf(best), country: tail(best.placeNames!.en) } : null;
  };

  const suggestions: TripSuggestion[] = [];
  let i = 0;
  while (i < days.length) {
    if (!away[i]) {
      i++;
      continue;
    }
    // A run of nights away, allowing short gaps with no located photo.
    let last = i;
    const wokeAway = (index: number) => {
      const home = homeAt(dayNumber(days[index].date));
      return !home || km(days[index].morning, home) > AWAY_KM;
    };
    while (
      last + 1 < days.length &&
      away[last + 1] &&
      dayNumber(days[last + 1].date) - dayNumber(days[last].date) <= MAX_GAP_DAYS + 1 &&
      // A morning at home ends the trip, whatever the evening does. Over a gap
      // with no photos the evening alone chained two separate outings into one:
      // the Essex coast (24-27 June) ran on through 29 June, which began 3km
      // from home, and swallowed a Milton Keynes overnight after it.
      wokeAway(last + 1)
    ) {
      last++;
    }
    // The day home: the next day with photos, when it is the very next day.
    const next = days[last + 1];
    const endIndex = next && dayNumber(next.date) === dayNumber(days[last].date) + 1 ? last + 1 : last;
    const run = days.slice(i, endIndex + 1);
    const home = homeAt(dayNumber(days[i].date))!;

    const startDate = days[i].date;
    const endDate = days[endIndex].date;
    const nights = dayNumber(days[last].date) - dayNumber(startDate) + 1;
    let unconfirmed = 0;
    for (let k = i; k <= last; k++) {
      const following = days[k + 1];
      if (!following || dayNumber(following.date) !== dayNumber(days[k].date) + 1 || km(days[k].evening, following.morning) > SAME_NIGHT_KM) {
        unconfirmed++;
      }
    }
    i = last + 1;

    const overlapsDefined = defined.some((t) => t.startDate <= endDate && t.endDate >= startDate);
    if (overlapsDefined || dismissed.has(`${startDate}..${endDate}`)) continue;

    const photos = run.flatMap((d) => d.photos);
    const homeName = homeNameAt(dayNumber(startDate), home);
    let farthest = 0;
    let awayPhotos = 0;
    const placeCount = new Map<string, { en: string; zh: string | null; photos: number }>();
    const countryCount = new Map<string, { en: string; zh: string | null; photos: number }>();
    for (const p of photos) {
      const distance = km(p.gps!, home);
      farthest = Math.max(farthest, distance);
      if (distance <= PLACE_KM) continue;
      awayPhotos++;
      const names = p.placeNames;
      if (!names) continue;
      const place = placeCount.get(names.en) ?? { en: head(names.en), zh: zhOf(p), photos: 0 };
      place.photos++;
      placeCount.set(names.en, place);
      const country = tail(names.en);
      const c = countryCount.get(country) ?? { en: country, zh: countryZh.get(country) ?? null, photos: 0 };
      c.photos++;
      countryCount.set(country, c);
    }
    const places = [...placeCount.values()].sort((a, b) => b.photos - a.photos);
    // Home's country is where the trip started from, not somewhere it went.
    const countries = [...countryCount.values()]
      .filter((c) => c.en !== homeName?.country)
      .sort((a, b) => b.photos - a.photos);
    if (!places.length || awayPhotos < MIN_AWAY_PHOTOS) continue;

    suggestions.push({
      startDate,
      endDate,
      nights,
      photoCount: photos.length,
      farthestKm: Math.round(farthest),
      places: places.slice(0, 8),
      countries: countries.map(({ en, zh }) => ({ en, zh })),
      name: nameFor(places, countries),
      home: { en: homeName?.en ?? null, zh: homeName?.zh ?? null },
      unconfirmedNights: unconfirmed,
    });
  }
  return suggestions.reverse();
}

/**
 * A first name for the trip: its countries when it crossed borders, its main
 * places when it did not. "Austria, Slovakia & Hungary"; "a city &
 * Inverness". Deliberately plain — a model could do better, but a name is the
 * one field the owner changes anyway, and this costs nothing.
 */
function nameFor(
  places: { en: string; zh: string | null; photos: number }[],
  countries: { en: string; zh: string | null; photos: number }[],
): { en: string; zh: string } {
  const list = (items: string[], and: string, comma: string) =>
    items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(comma)}${and}${items[items.length - 1]}`;
  // A country only counts as a destination when a fair share was spent there,
  // not when a train crossed a corner of it.
  const total = countries.reduce((n, c) => n + c.photos, 0);
  const visited = countries.filter((c) => c.photos >= Math.max(10, total * 0.08)).slice(0, 3);
  const picked = visited.length >= 2 ? visited : places.filter((p) => p.photos >= places[0].photos * 0.25).slice(0, 2);
  return {
    en: list(picked.map((p) => p.en), " & ", ", "),
    zh: list(picked.map((p) => p.zh ?? p.en), "和", "、"),
  };
}

/**
 * Ranges the owner said were not trips, as "start..end". Kept beside
 * trips.json, with the rest of the owner's data, so a dismissed suggestion
 * stays dismissed. A range whose detection later shifts by a day comes back —
 * rare, and better than hiding a trip that was never looked at.
 */
const DISMISSED_FILE = dataFile("trip-suggestions-dismissed.json");

async function loadDismissed(): Promise<string[]> {
  try {
    return JSON.parse(await readFile(DISMISSED_FILE, "utf-8")) as string[];
  } catch {
    return [];
  }
}

export async function dismissTripSuggestion(startDate: string, endDate: string): Promise<void> {
  const dismissed = await loadDismissed();
  const key = `${startDate}..${endDate}`;
  if (!dismissed.includes(key)) dismissed.push(key);
  await writeFile(DISMISSED_FILE, `${JSON.stringify(dismissed.sort(), null, 2)}
`, "utf-8");
}

/**
 * The suggestions, from the local mirror: read-only, nothing spent. Reading
 * every shard is ~38MB of JSON; the detection itself takes ~140ms.
 */
export async function listTripSuggestions(): Promise<TripSuggestion[]> {
  const token = await getAccessToken();
  const index = await loadIndexForReading(token);
  const shards = await loadAllShards(token, index);
  return suggestTrips(index, shards, await loadTripDefinitions(), new Set(await loadDismissed()));
}

/**
 * Days out: went somewhere, came home the same night.
 *
 * The counterpart to a trip. A trip is nights away; this is the day that has
 * none — a town and back, Derby and back — which the album otherwise shows
 * as an ordinary heading over a grid of photos, indistinguishable from a
 * Tuesday at home. It needs no trip page and no definition: it is one day, and
 * the app gives it a card in its month.
 *
 * Measured the same way as the suggestions above, so the two cannot disagree:
 * the day's evening must be home (or it is the start of a trip), and enough of
 * its photos must be far enough from home to be an outing rather than an
 * errand.
 */
export function findExcursions(index: ArchiveIndexFile, shards: Map<string, PhotoShard>): DayExcursion[] {
  const days = dayGeography(index, shards);
  const homeAt = homeFinder(days.map((d) => ({ day: dayNumber(d.date), at: d.evening })));
  const away = nightsAway(days, homeAt);
  // Days already inside a trip have a page of their own; a card there would be
  // a second voice on the same day.
  const inTrip = new Set(index.sections.filter((s) => s.kind === "trip").flatMap((s) => s.days.map((d) => d.date)));

  const excursions: DayExcursion[] = [];
  for (const [i, day] of days.entries()) {
    if (inTrip.has(day.date)) continue;
    const home = homeAt(dayNumber(day.date));
    if (!home) continue;
    // Home at both ends. Tonight at home is what separates a day out from the
    // first day of a trip; last night at home separates it from the last day
    // of one, which also comes home — the a city trip's third day came back
    // 224km and read as a day out until the night before was checked. Where
    // there is no photo the day before to judge by, the morning stands in.
    const previous = days[i - 1];
    const sleptHome =
      previous && dayNumber(previous.date) === dayNumber(day.date) - 1
        ? !away[i - 1]
        : km(day.morning, home) <= AWAY_KM;
    if (away[i] || !sleptHome) continue;

    let farthest = 0;
    let awayPhotos = 0;
    const places = new Map<string, { name: string; en: string | null; zh: string | null; photos: number }>();
    for (const photo of day.photos) {
      const distance = km(photo.gps!, home);
      if (distance > farthest) farthest = distance;
      if (distance <= AWAY_KM) continue;
      awayPhotos++;
      if (!photo.place) continue;
      const key = photo.place;
      const place = places.get(key) ?? {
        name: head(photo.place),
        en: photo.placeNames ? head(photo.placeNames.en) : null,
        zh: zhNameOf(photo),
        photos: 0,
      };
      place.photos++;
      places.set(key, place);
    }
    if (awayPhotos < MIN_AWAY_PHOTOS) continue;
    const [best] = [...places.values()].sort((a, b) => b.photos - a.photos);
    if (!best) continue;

    excursions.push({
      date: day.date,
      name: best.name,
      nameEn: best.en,
      nameZh: best.zh,
      awayKm: Math.round(farthest),
      photoCount: awayPhotos,
    });
  }
  return excursions;
}

/** A Chinese name for a place: the gazetteer's, or the endonym when it is already Chinese. */
function zhNameOf(photo: PhotoRecord): string | null {
  if (photo.placeNames?.zh) return head(photo.placeNames.zh);
  return photo.place && CJK.test(photo.place) ? head(photo.place) : null;
}
