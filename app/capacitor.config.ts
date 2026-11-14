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
    /**
     * The WebView's origin. Not Capacitor's default `localhost`: MSAL derives
     * its redirect URI from `window.location.origin`, and
     * `https://archive.local/auth.html` is the one registered in Azure. The
     * name is also why the app is not filed under "localhost" by Android's
     * password managers and site settings, where every other WebView app
     * shares that bucket.
     */
    hostname: "archive.local",
    androidScheme: "https",
    /**
     * Microsoft's sign-in pages, allowed to load inside the app.
     *
     * Capacitor sends every other site to the phone's browser, and a sign-in
     * finished there can never hand its code back: the redirect lands on
     * https://archive.local/auth.html in the browser, which is not this app.
     * The SPA platform in Azure also only accepts https redirect URIs, so
     * there is no custom-scheme deep link to return by instead.
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
  plugins: {
    /**
     * Image bytes go through the native HTTP stack, not the WebView's.
     *
     * OneDrive hands out pre-authenticated CDN links on
     * `my.microsoftpersonalcontent.com`, and that host stopped sending
     * `Access-Control-Allow-Origin` on 2026-11-13 — every thumbnail and every
     * original died at the CORS check inside the WebView while the same URL
     * worked fine outside it. A native request is not subject to CORS, so the
     * bytes arrive; see graphHttp.ts for where it is used.
     *
     * The plugin's own patch of `window.fetch` stays OFF. With it on, MSAL's
     * token request also went through the bridge, and Entra answered
     * `AADSTS90023 invalid_request` — the request arrives without the page's
     * Origin, and a SPA-registered redirect URI is only served on the strength
     * of that header. Sign-in then failed a few seconds after the redirect, and
     * the "session expired" banner came straight back. Requests we want native
     * are made explicitly through CapacitorHttp in graphHttp.ts, which needs no
     * global patch.
     */
    CapacitorHttp: { enabled: false },
  },
};

export default config;
