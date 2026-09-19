package com.travelarchive.photos;

import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        bridge.setWebViewClient(new ReturnFromMicrosoft(bridge));
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
