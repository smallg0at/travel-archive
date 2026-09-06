/**
 * Window furniture: a draggable sidebar edge, and the drawer the job panel
 * lives in.
 *
 * Both exist because the panel was originally squeezed into a fixed 200px
 * sidebar alongside 61 months of navigation — a form with three date fields and
 * a notes box does not belong in a column that narrow, and the column could not
 * be widened to suit it.
 */

import { canPrint, printView } from "./print";

const WIDTH_KEY = "sidebar-width";
const DEFAULT_WIDTH = 210;
const MIN_WIDTH = 150;
const MAX_WIDTH = 460;

function applyWidth(px: number): void {
  document.documentElement.style.setProperty("--sidebar-width", `${px}px`);
}

function storedWidth(): number {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(value) && value >= MIN_WIDTH && value <= MAX_WIDTH) return value;
  } catch {
    // Storage blocked — the default width still applies.
  }
  return DEFAULT_WIDTH;
}

/** Drag the sidebar's right edge to resize it. Width persists per browser. */
export function initSidebarResize(): void {
  applyWidth(storedWidth());

  const handle = document.getElementById("sidebar-resize");
  const sidebar = document.getElementById("sidebar");
  if (!handle || !sidebar) return;

  let dragging = false;

  const move = (event: PointerEvent) => {
    if (!dragging) return;
    const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, event.clientX - sidebar.getBoundingClientRect().left));
    applyWidth(width);
  };

  const stop = (event: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    handle.releasePointerCapture(event.pointerId);
    document.body.classList.remove("resizing");
    try {
      localStorage.setItem(WIDTH_KEY, String(sidebar.getBoundingClientRect().width));
    } catch {
      // Not persisting is fine; the width still applies for this session.
    }
  };

  handle.addEventListener("pointerdown", (event) => {
    dragging = true;
    handle.setPointerCapture(event.pointerId);
    // Suppresses text selection and the I-beam cursor mid-drag, which otherwise
    // makes the whole page look like it is being selected.
    document.body.classList.add("resizing");
  });
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);

  // Double-click resets, so a sidebar dragged to 150px is recoverable without
  // knowing that the width was stored at all.
  handle.addEventListener("dblclick", () => {
    applyWidth(DEFAULT_WIDTH);
    try {
      localStorage.setItem(WIDTH_KEY, String(DEFAULT_WIDTH));
    } catch {
      /* see above */
    }
  });
}

/**
 * The burger menu: one button that expands into a labelled list.
 *
 * Bare floating icons were unreadable — a "+" and a hamburger tell you nothing
 * about what they do. The list carries icon *and* label, and collapses back to
 * a single button so it never competes with the photographs.
 */
function closeMenu(): void {
  const items = document.getElementById("menu-items");
  const toggle = document.getElementById("menu-toggle");
  if (!items || !toggle) return;
  items.hidden = true;
  toggle.setAttribute("aria-expanded", "false");
  toggle.classList.remove("open");
}

function closeSettings(): void {
  const panel = document.getElementById("settings-panel");
  if (panel) panel.hidden = true;
}

/**
 * The generation drawer, opened from the menu. Returns the element the job
 * panel mounts into, or null when there is no drawer — which is the phone,
 * where there is no backend to generate with.
 */
export function initJobDrawer(): HTMLElement | null {
  const drawer = document.getElementById("job-drawer");
  const entry = document.getElementById("menu-generate");
  if (!drawer || !entry) return null;

  entry.hidden = false;
  entry.addEventListener("click", () => {
    drawer.hidden = !drawer.hidden;
    entry.classList.toggle("active", !drawer.hidden);
    closeSettings();
    closeMenu();
  });

  return document.getElementById("job-host");
}

/**
 * The PDF export entry.
 *
 * Separate from the print logic itself so that the menu owns only the wiring:
 * what leaves the machine is decided in print.ts and the print stylesheet.
 */
export function initPrint(): void {
  const entry = document.getElementById("menu-print");
  if (!entry) return;

  entry.addEventListener("click", () => {
    closeMenu();
    closeSettings();
    void printView();
  });
}

/**
 * Settings: thumbnail density and a sidebar reset. Density used to be repeated
 * in the heading of every month and trip page, which put a control in the
 * middle of the content it affected.
 */
export function initSettings(densityControl: HTMLElement): void {
  const panel = document.getElementById("settings-panel");
  const entry = document.getElementById("menu-settings");
  const menu = document.getElementById("menu");
  const items = document.getElementById("menu-items");
  const toggle = document.getElementById("menu-toggle");
  if (!panel || !entry || !menu || !items || !toggle) return;

  document.getElementById("settings-density")?.appendChild(densityControl);
  document.getElementById("settings-reset-sidebar")?.addEventListener("click", () => {
    applyWidth(DEFAULT_WIDTH);
    try {
      localStorage.setItem(WIDTH_KEY, String(DEFAULT_WIDTH));
    } catch {
      /* not persisting is fine */
    }
  });

  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    items.hidden = !items.hidden;
    toggle.setAttribute("aria-expanded", String(!items.hidden));
    toggle.classList.toggle("open", !items.hidden);
    // Recomputed as the menu opens rather than on navigation: showing a month
    // is a click handler that returns nothing, so there is no navigation event
    // to hook — and the menu opening is the only moment the entry can be seen.
    if (!items.hidden) {
      const print = document.getElementById("menu-print");
      if (print) print.hidden = !canPrint();
    }
  });

  entry.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    entry.classList.toggle("active", !panel.hidden);
    closeMenu();
  });

  // Click anywhere else to dismiss. A menu that only closes via its own button
  // is a menu people leave open over their photographs.
  document.addEventListener("click", (event) => {
    const target = event.target as Node;
    if (!menu.contains(target)) closeMenu();
    if (!panel.contains(target) && !menu.contains(target)) {
      panel.hidden = true;
      entry.classList.remove("active");
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    closeMenu();
    closeSettings();
  });
}
