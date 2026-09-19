import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The phone app: src/mobile/, built on its own by vite.mobile.config.ts into
 * dist-mobile/ so that the WebView's root is the phone page, not the desktop.
 *
 * `appId` is the Android package name and the iOS bundle id. It cannot change
 * after the app is installed anywhere without it becoming a different app, so
 * pick it for good before the first release; nothing has been released yet.
 */
const config: CapacitorConfig = {
  appId: "com.travelarchive.photos",
  appName: "Photo Archive",
  webDir: "dist-mobile",
  server: {
    // Android serves the app from https://localhost (Capacitor's default,
    // stated here because sign-in depends on it): MSAL's redirect URI is
    // `${origin}/auth/`, so https://localhost/auth/ is what has to be
    // registered in Azure as a Single-page application redirect URI.
    androidScheme: "https",
    /**
     * Microsoft's sign-in pages, allowed to load inside the app.
     *
     * Capacitor sends every other site to the phone's browser, and a sign-in
     * finished there can never hand its code back: the redirect lands on
     * https://localhost/auth/ in the browser, which is not this app. The SPA
     * platform in Azure also only accepts https and localhost redirect URIs,
     * so there is no custom-scheme deep link to return by instead.
     *
     * Capacitor's docs call this "not intended for production". The trade is
     * deliberate for a personal archive installed by its owner: the only pages
     * allowed are Microsoft's own login hosts, and what it costs is that
     * sign-in runs in the app's WebView rather than the system browser — so
     * passkeys and a browser's saved Microsoft session are not available to it.
     */
    allowNavigation: ["login.microsoftonline.com", "login.live.com", "account.live.com", "login.microsoft.com"],
  },
  android: {
    // Android 15 draws apps edge to edge whatever they ask. "auto" gives the
    // WebView margins for the status and navigation bars there, which is
    // what mobile.css's env(safe-area-inset-*) padding expects on phones
    // where the WebView reports no insets of its own.
    adjustMarginsForEdgeToEdge: "auto",
  },
};

export default config;
