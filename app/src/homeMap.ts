import type { HomePlace } from "@travel-archive/shared";
import { contentLanguage } from "./contentLang";
import { ui } from "./i18n";
import type { MapPoint, PlaceMapOptions } from "./tripMap";

/**
 * The home map's points and options, for the desktop and the phone alike.
 *
 * Both home pages call `drawPlaceMap` with what this returns and add only
 * their own `onPick`. They used to pass their own options, and the phone
 * passed none of the clustering, so the two showed different maps of the same
 * library. Tuning clusters or labels here reaches both.
 */

/** The last comma-separated part of a place name: its country, in that name's language. */
function tail(name: string | null | undefined): string | null {
  if (!name) return null;
  const comma = name.lastIndexOf(",");
  return comma === -1 ? null : name.slice(comma + 1).trim();
}

/**
 * Country names in both languages, learnt from the places themselves.
 *
 * home.json's `country` is the English name's last part, or the endonym's
 * when a place has no English name — one place says "中国" where the rest say
 * "China". The names that do exist in both languages give the pairing, so
 * clusters group by one key per country and label it in the reader's language.
 */
function countryNames(places: HomePlace[]): { key: (p: HomePlace) => string | undefined; display: (key: string) => string } {
  const zhOf = new Map<string, string>();
  const enOf = new Map<string, string>();
  for (const place of places) {
    const en = tail(place.nameEn);
    // A Chinese endonym (城市, 中国) is as good as a Chinese name.
    const zh = tail(place.nameZh) ?? (/[一-鿿]/.test(place.name) ? tail(place.name) : null);
    if (en && zh) {
      zhOf.set(en, zh);
      enOf.set(zh, en);
    }
  }
  const key = (p: HomePlace) => (p.country ? (enOf.get(p.country) ?? p.country) : undefined);
  const display = (country: string) => (contentLanguage() === "zh-Hans" ? (zhOf.get(country) ?? country) : country);
  return { key, display };
}

/**
 * A place's label: its name without the country.
 *
 * The Chinese fallback is the endonym, never the English name: most places
 * carry no separate Chinese name, and for Beijing that is because `name` is
 * already 城市 — falling back to `nameEn` printed "Beijing" in the middle of a
 * Chinese map. The country is on the tooltip, not the label: at world scale
 * the label is there to say *which* dot this is, and "a city" does that alone.
 */
export function homePlaceLabel(place: HomePlace): string {
  const name = contentLanguage() === "zh-Hans" ? (place.nameZh ?? place.name) : (place.nameEn ?? place.name);
  const comma = name.indexOf(",");
  return comma === -1 ? name : name.slice(0, comma);
}

/**
 * The places as map points, smallest first.
 *
 * Biggest last, so on top: discs keep one size on screen, and at world zoom
 * the capital's was covered by its own suburbs if they came later — a tap on the
 * dot labelled "the capital" opened a village. `ordered[i]` is the place behind
 * point `i`, for `onPick`.
 */
export function homeMapPoints(places: HomePlace[]): { ordered: HomePlace[]; points: MapPoint[] } {
  const countries = countryNames(places);
  const ordered = [...places].sort((a, b) => a.photoCount - b.photoCount);
  const points = ordered.map((place) => ({
    key: place.name,
    name: homePlaceLabel(place),
    lat: place.lat,
    lon: place.lon,
    photoCount: place.photoCount,
    group: countries.key(place),
  }));
  return { ordered, points };
}

/** Everything but `onPick`. Pass `places` to name a cluster that is a whole country after it. */
export function homeMapOptions(places: HomePlace[]): PlaceMapOptions {
  const countries = countryNames(places);
  return {
    label: ui.home.mapLabel,
    zoomOut: "world",
    // Five hundred places at world zoom: merged where discs would touch,
    // weighted by photos, and type sized for a world rather than a trip.
    cluster: true,
    labelPx: 12.5,
    groupName: countries.display,
    clusterName: ui.map.clusterMore,
    groupsName: ui.map.clusterCountries,
    inView: ui.home.inView,
  };
}
