package com.travelarchive.photos;

import android.net.Uri;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // The app's own plugins register before the bridge is built.
        registerPlugin(SystemBarsPlugin.class);
        registerPlugin(LocalPhotosPlugin.class);
        registerPlugin(CookiesPlugin.class);
        super.onCreate(savedInstanceState);
        bridge.setWebViewClient(new ReturnFromMicrosoft(bridge));
        // A single-page app's refresh token lasts 24 hours. After that MSAL
        // renews silently from a hidden iframe on login.microsoftonline.com,
        // which only works if that frame can read Microsoft's own sign-in
        // cookies — third-party ones here, under https://localhost, and
        // Android's WebView refuses those by default. Without this the app
        // would ask for a sign-in every day.
        CookieManager.getInstance().setAcceptThirdPartyCookies(bridge.getWebView(), true);
    }

    /**
     * Writes cookies to disk while the app can still be killed cleanly. The
     * WebView otherwise flushes on a timer, and the key that unlocks the kept
     * sign-in lives in one (keepSignInAcrossLaunches, src/mobile/native.ts).
     */
    @Override
    public void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    /**
     * Brings the WebView back into the app when Microsoft's sign-in sends it
     * home.
     *
     * The app is served from https://localhost by Capacitor intercepting
     * requests to that host — there is no server behind it. Microsoft ends
     * every sign-in, cancelled or completed, with an HTTP redirect to
     * https://localhost/auth/, and Chromium follows a redirect inside its
     * network stack without offering the new request to shouldInterceptRequest.
     * So that one hop went to the real network, found nothing listening, and
     * showed "Webpage not available" — reproduced on the phone with a
     * prompt=none request, whose immediate redirect failed exactly that way,
     * while the same URL loaded directly worked.
     *
     * The redirect is still offered here, flagged as one. Cancelling it and
     * loading the same URL afresh makes it an ordinary navigation, which the
     * local server does serve; the #fragment carrying the response survives.
     */
    static class ReturnFromMicrosoft extends BridgeWebViewClient {

        ReturnFromMicrosoft(Bridge bridge) {
            super(bridge);
        }

        /**
         * Photos this phone already holds, under /_device/ — see
         * LocalPhotosPlugin. Capacitor's own local server has nothing to serve
         * there, so the request is answered here instead, from MediaStore.
         */
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if ("localhost".equals(url.getHost()) && url.getPath() != null && url.getPath().startsWith("/_device/")) {
                return LocalPhotosPlugin.serve(view.getContext(), url);
            }
            /*
             * /auth/ serves the redirect-bridge page, as it does on the
             * desktop (desktop/src/static.ts, and the invariant in
             * HANDOFF.md). Capacitor's local server has no directory-index
             * resolution, so /auth/ falls through to index.html and the whole
             * app boots there instead — which broke msal-browser's silent
             * renewal: its hidden iframe lands on /auth/, msal waits for the
             * bridge's BroadcastChannel response, and the app that loaded
             * instead never sends one, so every renewal past the refresh
             * token's 24-hour life timed out. Serving the bridge here puts the
             * phone back in line with the desktop.
             */
            if ("localhost".equals(url.getHost()) && url.getPath() != null
                    && (url.getPath().equals("/auth") || url.getPath().equals("/auth/"))) {
                InputStream html = openAuthBridge(view);
                if (html != null) {
                    return new WebResourceResponse("text/html", "utf-8", html);
                }
            }
            return super.shouldInterceptRequest(view, request);
        }

        /** The built bridge page, from the bundled web assets, or null if it is not there. */
        private InputStream openAuthBridge(WebView view) {
            try {
                return new BufferedInputStream(view.getContext().getAssets().open("public/auth/index.html"));
            } catch (IOException e) {
                return null;
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (request.isRedirect() && request.isForMainFrame() && "localhost".equals(url.getHost())) {
                view.loadUrl(url.toString());
                return true;
            }
            return super.shouldOverrideUrlLoading(view, request);
        }
    }
}
