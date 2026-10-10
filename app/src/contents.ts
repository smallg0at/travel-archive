import { el } from "./photoUi";
import { ui } from "./i18n";

/**
 * A contents list beside a long page — every day, and the stops of the day
 * being read — that follows the reader and jumps on a click.
 *
 * A long trip is 18 days and several thousand photos on one page, and the
 * only way to reach day 12 was to scroll there; the trip map's cities jumped
 * to a stop, but only for places the map could label. The list is built from
 * the sections already on the page, so it can never name a day that is not
 * there, and it costs nothing when the page has only a couple of days.
 */

export interface ContentsEntry {
  target: HTMLElement;
  label: string;
  meta?: string;
  /** A short accent label above the row — "Day out", so an outing is visible in the list. */
  kicker?: string;
  stops: { target: HTMLElement; label: string }[];
}

const JUMP_MARGIN = 16;
/** A section is the current one once its top has passed this far down the pane. */
const READING_LINE = 120;
/** A page this short is seen whole; it gets no panel. */
const MIN_ENTRIES = 3;

/**
 * Brings a section to the top of the pane. Instant, then re-aligned on the
 * next frame and once images have had a moment — the page is still growing
 * as thumbnails land (see `scrollToStop` in album.ts for how that was found).
 */
export function jumpTo(target: HTMLElement): void {
  const content = document.getElementById("content");
  if (!content) return;
  const align = () => {
    const offset = target.getBoundingClientRect().top - content.getBoundingClientRect().top + content.scrollTop;
    content.scrollTop = Math.max(0, offset - JUMP_MARGIN);
  };
  align();
  requestAnimationFrame(align);
  window.setTimeout(align, 400);
}

/** The index of the last target whose top is above `line`, or -1. Targets are in page order. */
function lastPassed(targets: HTMLElement[], line: number): number {
  let found = -1;
  for (const [i, target] of targets.entries()) {
    if (target.getBoundingClientRect().top <= line) found = i;
    else break;
  }
  return found;
}

/**
 * The page with its contents beside it, or the page alone when it is short.
 * The panel's scroll listener removes itself once the page is replaced.
 */
export function withContents(body: DocumentFragment, entries: ContentsEntry[]): Node {
  if (entries.length < MIN_ENTRIES) return body;

  const wrap = el<HTMLDivElement>(`
    <div class="has-contents">
      <div class="page-main"></div>
      <nav class="page-contents"><h2></h2><ol></ol></nav>
    </div>
  `);
  wrap.querySelector(".page-main")!.appendChild(body);
  const nav = wrap.querySelector<HTMLElement>(".page-contents")!;
  nav.setAttribute("aria-label", ui.album.contents);
  nav.querySelector("h2")!.textContent = ui.album.contents;
  const list = nav.querySelector("ol")!;

  const dayItems: HTMLLIElement[] = [];
  const stopButtons: { button: HTMLButtonElement; target: HTMLElement }[][] = [];
  /** Re-marks the current day once a jump has finished moving the page; set below. */
  let settle: () => void = () => {};
  const go = (target: HTMLElement) => {
    jumpTo(target);
    settle();
  };
  for (const entry of entries) {
    const li = el<HTMLLIElement>(
      `<li class="toc-day"><button type="button"><span class="toc-kicker"></span><span class="toc-label"></span><span class="toc-meta"></span></button></li>`,
    );
    const kicker = li.querySelector<HTMLElement>(".toc-kicker")!;
    if (entry.kicker) {
      kicker.textContent = entry.kicker;
      li.classList.add("is-kicked");
    } else kicker.remove();
    // Day labels, places and stop titles are text — the titles are model output.
    li.querySelector(".toc-label")!.textContent = entry.label;
    const meta = li.querySelector<HTMLElement>(".toc-meta")!;
    if (entry.meta) meta.textContent = entry.meta;
    else meta.remove();
    li.querySelector("button")!.addEventListener("click", () => go(entry.target));

    const stops: { button: HTMLButtonElement; target: HTMLElement }[] = [];
    // A one-stop day is its own heading; listing the stop again adds nothing.
    if (entry.stops.length > 1) {
      const sub = el<HTMLOListElement>(`<ol class="toc-stops"></ol>`);
      for (const stop of entry.stops) {
        const button = el<HTMLButtonElement>(`<button type="button" class="toc-stop"></button>`);
        button.textContent = stop.label;
        button.addEventListener("click", () => go(stop.target));
        const item = document.createElement("li");
        item.appendChild(button);
        sub.appendChild(item);
        stops.push({ button, target: stop.target });
      }
      li.appendChild(sub);
    }
    list.appendChild(li);
    dayItems.push(li);
    stopButtons.push(stops);
  }

  const content = document.getElementById("content")!;
  const dayTargets = entries.map((e) => e.target);
  let frame = 0;
  let seen = false;
  let current = -1;
  let currentStop: HTMLButtonElement | null = null;

  const update = () => {
    frame = 0;
    if (!nav.isConnected) {
      // Replaced by another view — this listener's page is gone.
      if (seen) content.removeEventListener("scroll", onScroll);
      return;
    }
    seen = true;
    const line = content.getBoundingClientRect().top + READING_LINE;
    const day = Math.max(0, lastPassed(dayTargets, line));
    if (day !== current) {
      dayItems[current]?.classList.remove("is-active");
      dayItems[day].classList.add("is-active");
      current = day;
      // The current day kept in view inside the panel. Its own scrollTop, not
      // scrollIntoView, which would also move the page being read.
      const item = dayItems[day];
      if (item.offsetTop < nav.scrollTop || item.offsetTop + item.offsetHeight > nav.scrollTop + nav.clientHeight) {
        nav.scrollTop = Math.max(0, item.offsetTop - nav.clientHeight / 3);
      }
    }
    const stops = stopButtons[day];
    const s = lastPassed(
      stops.map((x) => x.target),
      line,
    );
    const next = s >= 0 ? stops[s].button : null;
    if (next !== currentStop) {
      currentStop?.classList.remove("is-active");
      next?.classList.add("is-active");
      currentStop = next;
    }
  };
  const onScroll = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  content.addEventListener("scroll", onScroll, { passive: true });
  // After the caller has put the page in place and restored its scroll. A
  // timer, not a frame: a window that is not drawing runs no frames, and the
  // first highlight should not wait for it to be looked at.
  window.setTimeout(update, 0);
  // A jump re-aligns for 400ms (jumpTo); mark where it landed after that,
  // rather than trusting the scroll events in between.
  settle = () => window.setTimeout(update, 450);
  return wrap;
}
