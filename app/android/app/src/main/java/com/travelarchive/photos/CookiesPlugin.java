package com.travelarchive.photos;

import android.webkit.CookieManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Writes the WebView's cookies to disk on demand.
 *
 * A cookie set from the page lives in memory until the WebView's own timer
 * gets to it or the activity pauses (MainActivity.onPause). Anything that
 * ends the process without a pause — a crash, "force stop", an install over
 * the top — loses it. Measured on the emulator: a cookie written from the
 * page, then `am force-stop`, was gone on the next launch.
 *
 * That cookie is the key to the kept sign-in (keepSignInAcrossLaunches in
 * src/mobile/native.ts): lose it and msal-browser cannot read the tokens it
 * encrypted, so it discards them and the app opens signed out. Hence a flush
 * the moment the key is written rather than only at the next pause.
 */
@CapacitorPlugin(name = "Cookies")
public class CookiesPlugin extends Plugin {

    @PluginMethod
    public void flush(PluginCall call) {
        CookieManager.getInstance().flush();
        call.resolve();
    }
}
