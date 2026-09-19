/**
 * Screens as a stack, driven by the URL hash.
 *
 * The desktop replaces one content pane; a phone pushes pages and pops them.
 * Built on the browser's own history rather than an in-memory stack so that
 * the one Back the reader actually uses — Android's system back, which in a
 * Capacitor WebView goes back in WebView history — pops a screen instead of
 * leaving the app from three levels deep.
 *
 * Each screen stays in the DOM while it is covered, hidden, and gets its
 * scroll position back when it is uncovered. Re-rendering on the way back
 * would re-request every thumbnail and drop the reader at the top of a trip
 * they had scrolled halfway down.
 *
 * Tab roots are kept for the whole session: switching tabs and switching back
 * should find the home map drawn and the library where it was left.
 */

export type Tab = "home" | "trips" | "library" | "search";

export interface Route {
  pattern: RegExp;
  /** Builds the screen. Synchronous: a screen draws its own loading state and fills itself in. */
  render: (params: string[]) => HTMLElement;
  /** Set on the four roots; a sub-page leaves the tab bar on whichever tab it was reached from. */
  tab?: Tab;
}

interface Entry {
  hash: string;
  el: HTMLElement;
  scrollY: number;
}

export const TAB_ROOTS: Record<Tab, string> = {
  home: "#/",
  trips: "#/trips",
  library: "#/library",
  search: "#/search",
};

let routes: Route[] = [];
let host: HTMLElement;
let onTab: (tab: Tab) => void = () => {};

const stack: Entry[] = [];
const roots = new Map<string, Entry>();
/** Set by `replace`: the next hash change swaps the top page rather than covering it. */
let replacing = false;

function currentHash(): string {
  return location.hash && location.hash !== "#" ? location.hash : TAB_ROOTS.home;
}

function match(hash: string): { route: Route; params: string[] } | null {
  const path = decodeURIComponent(hash.slice(1));
  for (const route of routes) {
    const m = route.pattern.exec(path);
    if (m) return { route, params: m.slice(1) };
  }
  return null;
}

/**
 * How a page arrives, for mobile.css to animate: "push" slides in from the
 * right, "back" from the left, and "fade" is for a tab or a day stepped
 * sideways. Only the arriving page moves — the one leaving is hidden at once.
 * The document is the scroller, so keeping both on screen for a crossing
 * would mean lifting one out of the flow for the length of the animation;
 * the arriving page carrying the direction is what reads as native, and
 * costs nothing.
 *
 * The attribute comes off when the animation ends: a transform left on a
 * screen would make it the containing block for everything `position: fixed`
 * inside it, like the full-screen map.
 */
function arrive(el: HTMLElement, how: "push" | "back" | "fade"): void {
  el.removeAttribute("data-arrive");
  void el.offsetWidth; // restart, when the same page arrives twice in a row
  el.setAttribute("data-arrive", how);
  el.addEventListener("animationend", () => el.removeAttribute("data-arrive"), { once: true });
}

function cover(entry: Entry | undefined): void {
  if (!entry) return;
  entry.scrollY = window.scrollY;
  entry.el.hidden = true;
}

function uncover(entry: Entry): void {
  entry.el.hidden = false;
  // After un-hiding, in the same task: the layout exists again by the time
  // this runs, and doing it a frame later shows one frame at the top first.
  window.scrollTo(0, entry.scrollY);
}

function drop(entry: Entry): void {
  // A tab root is never removed, only hidden — it is kept for the session.
  if (roots.get(entry.hash) === entry) entry.el.hidden = true;
  else entry.el.remove();
}

function show(): void {
  const hash = currentHash();
  const top = stack.at(-1);
  if (top?.hash === hash) return;

  // Back: a page already underneath is the one being asked for. Searched
  // down the whole stack, not just one level, so that the history and the
  // stack cannot drift apart — they did when stepping day to day by
  // `location.replace`, which left Back to the trip building a second trip
  // page over three stale days.
  let below = -1;
  for (let i = stack.length - 2; i >= 0 && below < 0; i--) if (stack[i].hash === hash) below = i;
  if (below >= 0) {
    while (stack.length - 1 > below) drop(stack.pop()!);
    uncover(stack[below]);
    arrive(stack[below].el, "back");
    replacing = false;
    return;
  }

  const found = match(hash);
  if (!found) {
    location.replace(TAB_ROOTS.home);
    return;
  }
  const { route, params } = found;

  if (route.tab) {
    // A tab root clears the stack: tabs are places, not steps, and Back from
    // a tab should not replay the pages of another one.
    cover(top);
    while (stack.length) drop(stack.pop()!);
    let entry = roots.get(hash);
    if (!entry) {
      entry = { hash, el: route.render(params), scrollY: 0 };
      roots.set(hash, entry);
      host.appendChild(entry.el);
    }
    stack.push(entry);
    uncover(entry);
    // Not on the first page of the session: the app opens on it, it does not arrive.
    if (top) arrive(entry.el, "fade");
    onTab(route.tab);
    return;
  }

  const sideways = replacing && top && !roots.has(top.hash);
  if (sideways) drop(stack.pop()!);
  else cover(top);
  replacing = false;
  const entry: Entry = { hash, el: route.render(params), scrollY: 0 };
  host.appendChild(entry.el);
  stack.push(entry);
  window.scrollTo(0, 0);
  if (top) arrive(entry.el, sideways ? "fade" : "push");
}

export function startRouter(opts: { routes: Route[]; host: HTMLElement; onTab: (tab: Tab) => void }): void {
  routes = opts.routes;
  host = opts.host;
  onTab = opts.onTab;
  window.addEventListener("hashchange", show);
  show();
}

/** Pushes a page. */
export function go(hash: string): void {
  location.hash = hash;
}

/**
 * Swaps the current page for another without a history step — stepping to
 * the next day, where Back should still return to the trip, not walk back
 * through every day visited.
 */
export function replace(hash: string): void {
  replacing = true;
  location.replace(hash);
}

/**
 * Switches tab without adding a history step, so that Back from a tab leaves
 * the app (or returns to wherever it was opened from) rather than cycling
 * through every tab the reader has touched.
 */
export function switchTab(tab: Tab): void {
  const hash = TAB_ROOTS[tab];
  if (currentHash() === hash) {
    // The usual convention: tapping the tab you are on scrolls it to the top.
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  location.replace(hash);
}

/**
 * The app bar's back arrow. A page opened from outside — a deep link, or a
 * reload three levels down — has nothing under it to go back to, so it goes to
 * its tab instead of doing nothing.
 */
export function back(): void {
  if (stack.length > 1) history.back();
  else location.replace(TAB_ROOTS.home);
}

/** How many pages are stacked, the current tab root included. */
export function depth(): number {
  return stack.length;
}

/** Whether the page showing is a tab root, and which. Null on a pushed page. */
export function currentTab(): Tab | null {
  const top = stack.at(-1);
  if (!top) return null;
  return (Object.keys(TAB_ROOTS) as Tab[]).find((tab) => TAB_ROOTS[tab] === top.hash) ?? null;
}
