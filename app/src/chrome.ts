/**
 * Window furniture: the draggable sidebar edge.
 *
 * The burger menu, the settings popup and the generation drawer that used to
 * live here are all gone. Settings and Generate are pages reached from the
 * sidebar, and Save as PDF sits in the heading of the page it exports — where
 * it cannot be pressed before that page exists.
 */

const WIDTH_KEY = "sidebar-width";
/* 230, not 210: measured against "a town Seaside Getaway" (24 characters,
   an entirely normal trip name length) truncating at the old default. No
   fixed width avoids truncation for arbitrary user-chosen trip names — that
   would need 270px for this one name alone, and a longer one would just move
   the goalpost — so this is a proportionate step, not an attempt to eliminate
   ellipsis entirely. The drag handle exists for exactly the remaining case. */
const DEFAULT_WIDTH = 230;
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
