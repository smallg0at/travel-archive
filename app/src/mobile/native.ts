import { Capacitor, registerPlugin } from "@capacitor/core";
import { effectiveTheme } from "../theme";
import { App } from "@capacitor/app";
import { dismiss, layerOpen } from "./overlay";
import { back, currentTab, depth, switchTab } from "./router";

/**
 * What only the installed app does. In a browser — including this page opened
 * on the desktop at /mobile/ — none of it runs.
 */
export const isNative = Capacitor.isNativePlatform();

/**
 * Keeps the Microsoft sign-in across launches of the app.
 *
 * msal-browser encrypts the tokens it keeps in localStorage with a key held in
 * a *session* cookie, `msal.cache.encryption` (LocalStorage.mjs in the
 * package), so a closed browser forgets the sign-in. Android's WebView ends
 * the session whenever the process goes: Android reclaiming the app, an
 * update, a swipe away. The key was lost each time, MSAL discarded the tokens
 * it could no longer read, and the app opened on its kept index, signed out —
 * seen on the emulator after a reinstall, with localStorage down to
 * `msal.version`.
 *
 * So once MSAL has made or read its key, the same cookie is written back with
 * a year's expiry. That makes the key exactly as durable as the tokens it
 * protects, which, inside the app's own sandbox, is the durability an
 * installed app's sign-in should have. The browser build is left alone.
 * Call after MSAL has initialized.
 */
export function keepSignInAcrossLaunches(): void {
  if (!isNative) return;
  const name = "msal.cache.encryption";
  const raw = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  if (!raw) return;
  // The value is written back exactly as read (MSAL encoded it), with MSAL's
  // own Secure and SameSite=None, so its next read finds what it wrote.
  document.cookie = `${name}=${raw}; max-age=${365 * 24 * 3600}; path=/; secure; samesite=None`;
}

/** MainActivity's own plugin (android/.../SystemBarsPlugin.java). */
const SystemBars = registerPlugin<{ setStyle(options: { dark: boolean; color: string | null }): Promise<void> }>("SystemBars");

/** The page's background as #rrggbb, which is what Android's Color.parseColor reads. */
function pageColor(): string | null {
  const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g)?.map(Number) ?? [];
  if (r === undefined || b === undefined) return null;
  return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
}

/**
 * Keeps the status and navigation bars part of the page: its background behind
 * them, and icons readable over it — dark on the light theme, light on the dark. Follows the theme actually showing —
 * an explicit choice in Settings (the `data-theme` attribute) or, with none,
 * the system's — and every later change of either.
 */
let syncBars: () => void = () => {};
/** A colour the bars take instead of the page's, while something full-screen covers it. */
let barsOverride: string | null = null;

/**
 * Bars in `color`, with light icons, until called again with null — for the
 * photo viewer, which is black whatever the theme, and would otherwise sit
 * under a white status bar on the light one.
 */
export function overrideSystemBars(color: string | null): void {
  barsOverride = color;
  syncBars();
}

export function followThemeInSystemBars(): void {
  if (!isNative) return;
  let last = "";
  const sync = (syncBars = () => {
    const dark = barsOverride !== null || effectiveTheme() === "dark";
    const color = barsOverride ?? pageColor();
    if (`${dark}${color}` === last) return;
    last = `${dark}${color}`;
    void SystemBars.setStyle({ dark, color }).catch((err) => console.error("System bars:", err));
  });
  sync();
  new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", sync);
}

/**
 * Android's back button, by the platform's own convention: close what is on
 * top, else go back a page, else go to the first tab, else leave the app.
 *
 * Not WebView history, which is what Capacitor falls back to without this.
 * After a redirect sign-in that history holds Microsoft's login pages, so
 * Back from the home screen would have walked the reader back into them.
 */
export function initBackButton(): void {
  if (!isNative) return;
  void App.addListener("backButton", () => {
    if (layerOpen()) void dismiss();
    else if (depth() > 1) back();
    else if (currentTab() !== "home") switchTab("home");
    else void App.exitApp();
  });
}
