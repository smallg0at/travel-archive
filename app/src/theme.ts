/**
 * Light, dark, or whatever the system says.
 *
 * "System" is the default and is a real third state, not a synonym for one of
 * the other two: it has to keep following the OS when that changes, which a
 * two-way toggle cannot express. It is stored as the *absence* of
 * `data-theme`, so the media query in style.css does the work and nothing has
 * to listen for OS changes.
 *
 * Applied from an inline script in index.html before the stylesheet paints —
 * see the note there. Reading it from a module would leave a light page
 * flashing dark, which is worse than not offering the choice.
 */

import { ui } from "./i18n";
import { rememberPref, THEME_KEY } from "./prefs";

function syncElectronTheme(): void {
  try {
    window.electronAPI?.setTheme?.(effectiveTheme());
  } catch {
    // Ignore outside Electron
  }
}

function applyAccentColor(color: string): void {
  document.documentElement.style.setProperty("--accent", color);
}

if (typeof window !== "undefined") {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (readTheme() === "system") syncElectronTheme();
  });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      syncElectronTheme();
      void window.electronAPI?.getSystemAccent?.().then((color) => {
        if (color) applyAccentColor(color);
      });
    });
  } else {
    syncElectronTheme();
    void window.electronAPI?.getSystemAccent?.().then((color) => {
      if (color) applyAccentColor(color);
    });
  }

  window.electronAPI?.onSystemAccentChanged?.((color) => {
    applyAccentColor(color);
  });
}

export type Theme = "light" | "dark" | "system";

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Storage blocked (private browsing). The OS preference still applies.
  }
  return "system";
}

/**
 * The attribute only, with nothing stored. For the startup path, where the
 * theme has just been restored from the server into `localStorage` and the
 * inline script in index.html painted the page before it arrived — saving it
 * again there would only send the server back the value it just supplied.
 */
export function showTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  syncElectronTheme();
}

export function applyTheme(theme: Theme): void {
  showTheme(theme);

  try {
    if (theme === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Not persisting is fine; the choice still holds for this session.
  }
  // And to the server, which is the copy that survives the renderer being
  // killed — see prefs.ts.
  rememberPref({ theme });
}

/** Which theme is actually showing, with "system" resolved. */
export function effectiveTheme(): "light" | "dark" {
  const chosen = readTheme();
  if (chosen !== "system") return chosen;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const LABELS: Record<Theme, string> = { light: ui.theme.light, dark: ui.theme.dark, system: ui.theme.system };

/**
 * The three-way control. Same shape as the thumbnail density control beside it,
 * because they are the same kind of choice and should not look like two
 * different ideas.
 */
export function renderThemeControl(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "density-control";
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", ui.theme.label);

  const current = readTheme();
  for (const option of ["light", "dark", "system"] as Theme[]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = LABELS[option];
    if (option === current) button.classList.add("active");
    button.addEventListener("click", () => {
      applyTheme(option);
      wrap.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      button.classList.add("active");
    });
    wrap.appendChild(button);
  }
  return wrap;
}
