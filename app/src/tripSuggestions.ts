import { defineTrip, dismissTripSuggestion, tripSuggestions, type TripSuggestion } from "./backend";
import { contentLanguage } from "./contentLang";
import { el } from "./photoUi";
import { fmtDate, num, ui } from "./i18n";

/**
 * Trips the server found, listed under the trip form, each one click from
 * being a trip.
 *
 * The owner's complaint was the typing: every trip meant two dates and a name,
 * looked up by scrolling the album. The server now proposes ranges from where
 * the nights were spent (pipeline jobs/tripSuggest.ts); here each is a name
 * to accept or edit, and three answers:
 *
 * - **Create** makes it a trip with no story. Free and instant, and what most
 *   weekends away want.
 * - **Write its story** puts the range and name in the form above, for a trip
 *   worth a narrative — which costs a model call and needs day summaries.
 * - **Not a trip** hides it for good.
 */

/** Rows shown before "Show all": the newest, which are the ones still unfiled. */
const FIRST_ROWS = 6;

const zh = () => contentLanguage() === "zh-Hans";

function dateRange(start: string, end: string): string {
  const d = (s: string) => new Date(`${s}T12:00:00`);
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  const full: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
  if (start === end) return fmtDate(d(start), full);
  return `${fmtDate(d(start), sameYear ? { day: "numeric", month: "short" } : full)} – ${fmtDate(d(end), full)}`;
}

export interface SuggestionHooks {
  /** Puts a range and name into the trip form, for writing its story. */
  fill: (startDate: string, endDate: string, name: string) => void;
  /** The album changed: a trip now exists. */
  refresh: () => void;
}

export function mountTripSuggestions(box: HTMLElement, hooks: SuggestionHooks): void {
  let showAll = false;

  const render = (list: TripSuggestion[]) => {
    if (!list.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const head = el<HTMLElement>(`<div class="sug-head"><strong></strong><span class="sug-lead"></span></div>`);
    head.querySelector("strong")!.textContent = ui.generate.suggest.title(list.length);
    head.querySelector(".sug-lead")!.textContent = ui.generate.suggest.lead;
    const rows = (showAll ? list : list.slice(0, FIRST_ROWS)).map((s) => row(s, list));
    box.replaceChildren(head, ...rows);
    if (!showAll && list.length > FIRST_ROWS) {
      const more = el<HTMLButtonElement>(`<button type="button" class="sug-more"></button>`);
      more.textContent = ui.generate.suggest.showAll(list.length);
      more.addEventListener("click", () => {
        showAll = true;
        render(list);
      });
      box.appendChild(more);
    }
  };

  const row = (s: TripSuggestion, list: TripSuggestion[]) => {
    const item = el<HTMLElement>(`
      <div class="sug-row">
        <input type="text" class="sug-name" />
        <p class="sug-meta"></p>
        <p class="sug-places"></p>
        <div class="sug-actions">
          <button type="button" class="sug-create"></button>
          <button type="button" class="sug-story"></button>
          <button type="button" class="sug-dismiss"></button>
        </div>
        <p class="sug-error" hidden></p>
      </div>
    `);
    const name = item.querySelector<HTMLInputElement>(".sug-name")!;
    name.value = zh() ? s.name.zh : s.name.en;
    name.setAttribute("aria-label", ui.generate.name);
    // Inside the trip form: Enter there would submit it and start a paid
    // narrative for whatever the form holds.
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") e.preventDefault();
    });
    const home = (zh() ? s.home.zh : null) ?? s.home.en;
    item.querySelector(".sug-meta")!.textContent = [
      dateRange(s.startDate, s.endDate),
      ui.generate.suggest.nights(s.nights),
      ui.common.photos(s.photoCount),
      home ? ui.generate.suggest.fromHome(num(s.farthestKm), home) : null,
    ]
      .filter(Boolean)
      .join(" · ");
    item.querySelector(".sug-places")!.textContent =
      s.places
        .slice(0, 5)
        .map((p) => (zh() ? (p.zh ?? p.en) : p.en))
        .join(zh() ? "、" : ", ") +
      // Half the nights or more with no next morning to confirm them: the
      // range may have swallowed days out, or be one long day out.
      (s.unconfirmedNights * 2 > s.nights ? ` — ${ui.generate.suggest.uncertain}` : "");

    const error = item.querySelector<HTMLElement>(".sug-error")!;
    const buttons = [...item.querySelectorAll<HTMLButtonElement>("button")];
    const busy = (on: boolean) => buttons.forEach((b) => (b.disabled = on));
    const drop = () => {
      list.splice(list.indexOf(s), 1);
      render(list);
    };

    const create = item.querySelector<HTMLButtonElement>(".sug-create")!;
    create.textContent = ui.generate.suggest.create;
    create.title = ui.generate.suggest.createHint;
    create.addEventListener("click", async () => {
      busy(true);
      error.hidden = true;
      try {
        await defineTrip(s.startDate, s.endDate, name.value);
        drop();
        hooks.refresh();
      } catch (err) {
        error.textContent = (err as Error).message;
        error.hidden = false;
        busy(false);
      }
    });

    const story = item.querySelector<HTMLButtonElement>(".sug-story")!;
    story.textContent = ui.generate.suggest.story;
    story.addEventListener("click", () => hooks.fill(s.startDate, s.endDate, name.value));

    const dismiss = item.querySelector<HTMLButtonElement>(".sug-dismiss")!;
    dismiss.textContent = ui.generate.suggest.dismiss;
    dismiss.addEventListener("click", async () => {
      busy(true);
      try {
        await dismissTripSuggestion(s.startDate, s.endDate);
        drop();
      } catch (err) {
        error.textContent = (err as Error).message;
        error.hidden = false;
        busy(false);
      }
    });
    return item;
  };

  box.hidden = false;
  box.textContent = ui.generate.suggest.loading;
  void tripSuggestions().then((list) => {
    if (!list) {
      box.hidden = true;
      return;
    }
    render(list);
  });
}
