package com.travelarchive.photos;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Tells the launch screen that the first screen is on.
 *
 * The splash is held by MainActivity until this call (or a safety timeout), so
 * it is visible for exactly as long as the app has nothing to show — which is
 * the whole reason to have one. Capacitor's own splash plugin hides on a fixed
 * timer, which on this app meant it vanished while the archive was still being
 * read and left a blank page behind it.
 */
@CapacitorPlugin(name = "Splash")
public class SplashPlugin extends Plugin {

    @PluginMethod
    public void ready(PluginCall call) {
        MainActivity.markReady();
        call.resolve(new JSObject());
    }
}
