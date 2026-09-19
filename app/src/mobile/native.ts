import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { dismiss, layerOpen } from "./overlay";
import { back, currentTab, depth, switchTab } from "./router";

/**
 * What only the installed app does. In a browser — including this page opened
 * on the desktop at /mobile/ — none of it runs.
 */
export const isNative = Capacitor.isNativePlatform();

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
