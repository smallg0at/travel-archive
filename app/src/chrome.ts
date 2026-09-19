/**
 * Window furniture: the draggable sidebar edge & collapsible WinUI 3 Navigation View.
 */

import { rememberPref, SIDEBAR_WIDTH_KEY as WIDTH_KEY } from "./prefs";

const DEFAULT_WIDTH = 230;
const MIN_WIDTH = 150;
const MAX_WIDTH = 460;
const NARROW_BREAKPOINT = 768;
const COLLAPSED_KEY = "sidebar-collapsed";

function isNarrow(): boolean {
  return window.innerWidth <= NARROW_BREAKPOINT;
}

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

function storeWidth(px: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(px));
  } catch {
    // Not persisting locally is fine; the width still applies for this session.
  }
  rememberPref({ sidebarWidth: px });
}

export function isSidebarCollapsed(): boolean {
  return document.documentElement.classList.contains("sidebar-collapsed");
}

export function isDrawerOpen(): boolean {
  return document.documentElement.classList.contains("sidebar-drawer-open");
}

export function openDrawer(): void {
  document.documentElement.classList.add("sidebar-drawer-open");
}

export function closeDrawer(): void {
  document.documentElement.classList.remove("sidebar-drawer-open");
}

/**
 * Closes the sidebar drawer if it's currently open as an overlay (on narrow screens).
 * Called by nav item click handlers so navigation immediately reveals the selected view.
 */
export function closeSidebarIfOverlay(): void {
  if (isDrawerOpen()) {
    closeDrawer();
  }
}

export function toggleSidebar(): void {
  if (isNarrow()) {
    if (isDrawerOpen()) closeDrawer();
    else openDrawer();
  } else {
    const collapsed = !isSidebarCollapsed();
    document.documentElement.classList.toggle("sidebar-collapsed", collapsed);
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // Ignore storage errors
    }
  }
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
    storeWidth(sidebar.getBoundingClientRect().width);
  };

  handle.addEventListener("pointerdown", (event) => {
    if (isNarrow()) return;
    dragging = true;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing");
  });
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);

  handle.addEventListener("dblclick", () => {
    applyWidth(DEFAULT_WIDTH);
    storeWidth(DEFAULT_WIDTH);
  });
}

/**
 * Initializes the collapsible navigation toggles, scrim backdrop, and keyboard shortcuts.
 */
export function initSidebarNav(): void {
  // Restore persisted collapsed state on wide screens
  try {
    if (!isNarrow() && localStorage.getItem(COLLAPSED_KEY) === "1") {
      document.documentElement.classList.add("sidebar-collapsed");
    }
  } catch {
    // Ignore storage errors
  }

  const toggleBtn = document.getElementById("nav-toggle");
  const toggleMainBtn = document.getElementById("nav-toggle-main");
  const scrim = document.getElementById("sidebar-scrim");

  toggleBtn?.addEventListener("click", () => {
    if (isNarrow()) {
      closeDrawer();
    } else {
      toggleSidebar();
    }
  });

  toggleMainBtn?.addEventListener("click", () => {
    if (isNarrow()) {
      openDrawer();
    } else {
      document.documentElement.classList.remove("sidebar-collapsed");
      try {
        localStorage.setItem(COLLAPSED_KEY, "0");
      } catch {
        // Ignore
      }
    }
  });

  scrim?.addEventListener("click", () => {
    closeDrawer();
  });

  // Global keyboard shortcuts
  window.addEventListener("keydown", (event) => {
    // Ctrl+B / Cmd+B toggles sidebar
    if ((event.ctrlKey || event.metaKey) && (event.key === "b" || event.key === "B")) {
      event.preventDefault();
      toggleSidebar();
      return;
    }

    // Escape closes drawer if open
    if (event.key === "Escape" && isDrawerOpen()) {
      event.preventDefault();
      closeDrawer();
    }
  });

  // Window resize handler: auto-close drawer if screen widens
  window.addEventListener("resize", () => {
    if (!isNarrow() && isDrawerOpen()) {
      closeDrawer();
    }
  });
}

/**
 * Resets the sidebar to its default width. Lives here because the width and its
 * storage key do, and is called from the Settings page.
 */
export function resetSidebarWidth(): void {
  applyWidth(DEFAULT_WIDTH);
  storeWidth(DEFAULT_WIDTH);
}
