import { defineConfig, type Plugin } from "vite";
import { resolve } from "node:path";

/**
 * The phone app's build, for Capacitor (see capacitor.config.ts).
 *
 * The desktop build (vite.config.ts) puts the phone page at /mobile/, beside
 * the desktop app at /. Inside the native app the phone page has to *be* the
 * root: the WebView opens `/`, and the MSAL bridge at /auth/ returns to `/`
 * once a redirect sign-in completes (auth/main.ts). So this build keeps only
 * the phone page and the bridge, and moves the phone page up to index.html.
 */
function phonePageAtRoot(): Plugin {
  return {
    name: "phone-page-at-root",
    enforce: "post",
    generateBundle(_options, bundle) {
      const page = bundle["mobile/index.html"];
      if (!page) throw new Error("mobile/index.html missing from the build");
      // Asset URLs in the page are absolute (/assets/...), so moving it up a
      // directory needs no rewriting.
      page.fileName = "index.html";
      delete bundle["mobile/index.html"];
      bundle["index.html"] = page;
    },
  };
}

export default defineConfig({
  plugins: [phonePageAtRoot()],
  build: {
    outDir: "dist-mobile",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        mobile: resolve(__dirname, "mobile/index.html"),
        auth: resolve(__dirname, "auth/index.html"),
      },
    },
  },
});
