package com.travelarchive.photos;

import android.graphics.Color;
import android.view.Window;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Dark or light icons in the status and navigation bars, over the page's own
 * background colour, as the page asks.
 *
 * The page draws under both bars, so their icons sit on the page's own
 * background — and that follows the theme chosen in the app, which need not
 * be the system's. Left to the system, a light page under a dark-mode phone
 * had white icons on white. The page knows which it is showing; this only
 * carries that across (src/mobile/native.ts).
 */
@CapacitorPlugin(name = "SystemBars")
public class SystemBarsPlugin extends Plugin {

    @PluginMethod
    public void setStyle(PluginCall call) {
        boolean dark = Boolean.TRUE.equals(call.getBoolean("dark", false));
        String color = call.getString("color");
        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            // The WebView is inset from both bars (adjustMarginsForEdgeToEdge),
            // so what shows behind them is the window itself — white by
            // default, a white band above and below a dark page. Paint it the
            // page's own background.
            if (color != null) {
                try {
                    window.getDecorView().setBackgroundColor(Color.parseColor(color));
                } catch (IllegalArgumentException e) {
                    // Not a colour Android can read; keep the last one.
                }
            }
            WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(window, window.getDecorView());
            // "Light" bars are the ones with dark icons, for a light page.
            bars.setAppearanceLightStatusBars(!dark);
            bars.setAppearanceLightNavigationBars(!dark);
            call.resolve(new JSObject());
        });
    }
}
