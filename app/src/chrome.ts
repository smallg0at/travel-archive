/**
 * Window furniture: a draggable sidebar edge, and the drawer the job panel
 * lives in.
 *
 * The drawer exists because the panel was originally squeezed into a fixed
 * 200px sidebar alongside 61 months of navigation — a form with three date
 * fields and a notes box does not belong in a column that narrow.
 *
 * The floating burger and settings popup that used to live here are gone:
 * Generate, Settings and Save as PDF are rows in the sidebar now, always
 * visible, which is how it was asked for.
 */

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
 * The generation drawer, opened from the menu. Returns the element the job
 * panel mounts into, or null when there is no drawer — which is the phone,
 * where there is no backend to generate with.
 */
export function initJobDrawer(): HTMLElement | null {
  const drawer = document.getElementById("job-drawer");
  if (!drawer) return null;
  return document.getElementById("job-host");
}

/**
 * Opens or closes the generation drawer.
 *
 * Called from the sidebar now rather than a floating burger: Generate and
 * Settings belong in the same list as the months, always visible.
 */
export function toggleJobDrawer(): boolean {
  const drawer = document.getElementById("job-drawer");
  if (!drawer) return false;
  drawer.hidden = !drawer.hidden;
  return !drawer.hidden;
}

/**
 * Resets the sidebar to its default width. Lives here because the width and its
 * storage key do, and is called from the Settings page.
 */
export function resetSidebarWidth(): void {
  applyWidth(DEFAULT_WIDTH);
  try {
    localStorage.setItem(WIDTH_KEY, String(DEFAULT_WIDTH));
  } catch {
    /* not persisting is fine; it still applies for this session */
  }
}
