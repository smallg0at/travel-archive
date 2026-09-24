import type { ArchiveIndexFile, PhotoRecord, SearchIndexFile } from "@travel-archive/shared";
import { dayMeta, loadIndex, loadMonth, loadSearchIndex } from "./archiveData";
import { el, hydrateAll, lazyImg } from "./photoUi";
import { ui } from "./i18n";

/**
 * Search across everything the archive has in words.
 *
 * A substring scan over one preloaded file, not an inverted index: the corpus
 * is 3.5MB of captions, tags and places, which a browser filters in a few
 * milliseconds, and substrings match 京都 inside Chinese text where a
 * word-boundary index would need a tokenizer for a language without spaces.
 *
 * Results are grouped by day rather than listed photo by photo. A query like
 * "cathedral" hits 40 photos across 9 days, and the day is what the reader
 * actually wants to open — the album has no page for "a photo".
 */

/** Below this a query matches most of the library; the view waits instead. */
const MIN_QUERY = 2;
/** Days rendered. Beyond this the answer is "narrow it down", not more scrolling. */
const MAX_DAYS = 40;
/** Thumbnails per day. The rest are reachable by opening the day. */
const MAX_PHOTOS_PER_DAY = 8;
/** Keystrokes settle before a scan, so holding a key down does not scan per character. */
const DEBOUNCE_MS = 120;

interface DayHit {
  date: string;
  /** Photo ids whose text matched, most relevant first (index order). */
  photos: string[];
  /** True when the day's own summary matched, not just its photos. */
  summaryMatched: boolean;
}

/** Every term must appear. Terms are ANDed because that is how narrowing reads. */
function matches(text: string, terms: string[]): boolean {
  for (const term of terms) if (!text.includes(term)) return false;
  return true;
}

/**
 * A photo row's text and tags, from either schema version.
 *
 * v1 stored `caption + tags + place` as one string, so its fourth element is
 * absent and the tags are unseen — the row still searches as it always did, and
 * a rebuilt index supplies the chips.
 */
function rowParts(row: SearchIndexFile["photos"][number]): { text: string; tags: string } {
  return { text: row[2] ?? "", tags: row[3] ?? "" };
}

function search(index: SearchIndexFile, query: string): { days: DayHit[]; trips: SearchIndexFile["trips"]; total: number } {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { days: [], trips: [], total: 0 };

  const byDate = new Map<string, DayHit>();
  const hit = (date: string): DayHit => {
    let entry = byDate.get(date);
    if (!entry) byDate.set(date, (entry = { date, photos: [], summaryMatched: false }));
    return entry;
  };

  let total = 0;
  for (const row of index.photos) {
    const { text, tags } = rowParts(row);
    if (!matches(`${text} ${tags}`, terms)) continue;
    total++;
    const cap = index.idPrefix + row[0];
    if (row[1]) hit(row[1]).photos.push(cap);
  }
  for (const [date, text] of index.days) {
    if (matches(text, terms)) hit(date).summaryMatched = true;
  }
  const trips = index.trips.filter(([, name]) => matches(name.toLowerCase(), terms));

  // Newest first, like every other list in the app.
  const days = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
  return { days, trips, total };
}

/** The photos of one day, from the month shard, in the order the index found them. */
async function photosFor(hit: DayHit): Promise<PhotoRecord[]> {
  const month = hit.date.slice(0, 7);
  const shard = await loadMonth(month).catch(() => null);
  if (!shard) return [];
  return hit.photos
    .slice(0, MAX_PHOTOS_PER_DAY)
    .map((id) => shard.photos[id])
    .filter(Boolean);
}

/** One line of the day's summary, around the first match, so the hit is visible. */
function snippet(text: string | null, terms: string[]): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return text.slice(0, 160) + (text.length > 160 ? "…" : "");
  const from = Math.max(0, at - 60);
  const to = Math.min(text.length, at + 100);
  return `${from > 0 ? "…" : ""}${text.slice(from, to).trim()}${to < text.length ? "…" : ""}`;
}

export interface SearchOptions {
  /**
   * Fetch the index when the box is first used rather than when it is drawn.
   * The home page carries a search box on every visit; the index is 6.5MB, and
   * a reader who came to look at the map should not pay for it — least of all
   * on a phone, where it comes over Graph.
   */
  lazy?: boolean;
  /** Told when results start or stop filling the space, so a host page can make room. */
  onActive?: (active: boolean) => void;
  /**
   * Opens a result's day. Passed in rather than imported from album.ts, so a
   * page with its own album — the mobile build — can use search without
   * bundling the desktop one; it also ended an album ↔ search import cycle.
   */
  onOpenDay: (date: string, section: { kind: "trip" | "month"; id: string }) => void;
  /**
   * Opens a thumbnail in the photo viewer, with the rest of its day's results
   * behind the arrow keys. A thumbnail used to open the day, like the heading,
   * which made the one thing that looks like a photo the one thing that could
   * not show it. Injected for the same reason as `onOpenDay`: the desktop
   * viewer brings the day editor with it. Without one, a thumbnail opens its
   * day, as it did before.
   */
  onOpenPhoto?: (photo: PhotoRecord, siblings: PhotoRecord[]) => void;
}

/** The search box and its results, ready to be placed wherever the caller wants them. */
export function mountSearch(opts: SearchOptions): HTMLElement {
  const page = el<HTMLDivElement>(`
    <div class="search-page">
      <div class="search-head">
        <input class="search-input" type="search" autocomplete="off" spellcheck="false" />
        <p class="search-status"></p>
      </div>
      <div class="search-results"></div>
    </div>
  `);
  const input = page.querySelector<HTMLInputElement>(".search-input")!;
  const status = page.querySelector<HTMLElement>(".search-status")!;
  const results = page.querySelector<HTMLElement>(".search-results")!;
  input.placeholder = ui.search.placeholder;
  input.setAttribute("aria-label", ui.search.placeholder);

  let loaded: Promise<{ index: SearchIndexFile; archive: ArchiveIndexFile } | null> | null = null;
  const load = () =>
    (loaded ??= (async () => {
      status.textContent = ui.search.loading;
      const [index, archive] = await Promise.all([loadSearchIndex(), loadIndex().catch(() => null)]);
      if (!index || !archive) {
        status.textContent = ui.search.unavailable;
        return null;
      }
      status.textContent = ui.search.ready(index.photos.length, index.days.length);
      return { index, archive };
    })());
  if (opts.lazy) input.addEventListener("focus", () => void load(), { once: true });
  else void load();

  let run = 0;
  const render = async (query: string) => {
    const mine = ++run;
    const data = await load();
    if (!data || mine !== run) return;
    const { index, archive } = data;
    const active = query.trim().length >= MIN_QUERY;
    opts.onActive?.(active);
    if (!active) {
      results.replaceChildren();
      status.textContent = ui.search.ready(index.photos.length, index.days.length);
      return;
    }
    const started = performance.now();
    const { days, trips, total } = search(index, query);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    status.textContent = ui.search.found(total, days.length, Math.max(1, Math.round(performance.now() - started)));

    const frag = document.createDocumentFragment();
    /** Where each day's thumbnails go, paired with the day, so the fill-in below needs no lookup. */
    const hosts: { day: DayHit; host: HTMLElement }[] = [];
    for (const [id, name, from, to] of trips) {
      const row = el<HTMLButtonElement>(`<button type="button" class="search-trip"></button>`);
      row.textContent = `${name} · ${from} – ${to}`;
      row.addEventListener("click", () => {
        document.querySelector<HTMLElement>(`#month-nav .month-link[data-pin-kind="trip"][data-pin-id="${CSS.escape(id)}"]`)?.click();
      });
      frag.appendChild(row);
    }

    for (const day of days.slice(0, MAX_DAYS)) {
      const meta = dayMeta(archive, day.date);
      const block = el<HTMLElement>(`
        <section class="search-day">
          <button type="button" class="search-day-head">
            <span class="search-day-date"></span>
            <span class="search-day-meta"></span>
          </button>
          <p class="search-day-summary"></p>
          <div class="search-day-photos"></div>
        </section>
      `);
      block.querySelector(".search-day-date")!.textContent = day.date;
      block.querySelector(".search-day-meta")!.textContent = [
        meta.place,
        day.photos.length ? ui.search.photosMatched(day.photos.length) : null,
      ]
        .filter(Boolean)
        .join(" · ");
      const summary = block.querySelector<HTMLElement>(".search-day-summary")!;
      const text = day.summaryMatched ? snippet(meta.summary, terms) : null;
      if (text) summary.textContent = text;
      else summary.remove();
      if (meta.section) block.querySelector(".search-day-head")!.addEventListener("click", () => opts.onOpenDay(day.date, meta.section!));
      hosts.push({ day, host: block.querySelector<HTMLElement>(".search-day-photos")! });
      frag.appendChild(block);
    }

    if (mine !== run) return;
    results.replaceChildren(frag);

    // Thumbnails after the text is on screen: a shard is a few hundred KB and
    // the reader can already see what was found while they load.
    for (const { day, host } of hosts) {
      if (mine !== run) return;
      if (!day.photos.length) continue;
      const photos = await photosFor(day);
      if (mine !== run) return;
      const images = photos.map((photo) => {
        const thumb = lazyImg(photo, "medium", "search-thumb");
        thumb.title = photo.caption ?? "";
        thumb.addEventListener("click", () => {
          if (opts.onOpenPhoto) opts.onOpenPhoto(photo, photos);
          else {
            const section = dayMeta(archive, day.date).section;
            if (section) opts.onOpenDay(day.date, section);
          }
        });
        // Wrapped so a video's poster can carry its play badge — an <img> is a
        // replaced element and cannot host the ::after the badge is drawn with.
        const cell = el<HTMLDivElement>(`<div class="search-cell"></div>`);
        cell.appendChild(thumb);
        host.appendChild(cell);
        return thumb;
      });
      void hydrateAll(images);
    }
  };

  let timer = 0;
  input.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void render(input.value), DEBOUNCE_MS);
  });

  /**
   * Run a query from outside — how a tag chip in the viewer searches.
   *
   * Exposed on the element rather than kept in module state, because the search
   * box is embedded in the home page and there is exactly one of it: whoever
   * mounted it holds the handle. Setting `value` as well as rendering is the
   * point — the reader has to see what is being searched for.
   */
  (page as HTMLElement & { runQuery?: (query: string) => void }).runQuery = (query: string) => {
    input.value = query;
    void render(query);
  };
  return page;
}

export function showSearch(open: Pick<SearchOptions, "onOpenDay" | "onOpenPhoto">): void {
  const page = mountSearch(open);
  document.getElementById("content")!.replaceChildren(page);
  page.querySelector<HTMLInputElement>(".search-input")!.focus();
}
