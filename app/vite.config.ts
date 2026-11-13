import { defineConfig } from "vite";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const APP_VERSION = (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version?: string })
  .version ?? "";

export default defineConfig({
  define: {
    // What the Settings > App pane reports. Baked at build time so the pane
    // says which bundle it is, not what package.json says now.
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      // Three entry points: the main app; the dedicated MSAL redirect bridge
      // page (auth.html) — see src/msalConfig.ts for why that has to be a
      // separate page rather than a route in the app; and the phone app
      // (mobile/index.html, src/mobile/), which shares the data layer but not
      // the layout. Built here too so it can be opened at /mobile/ on the
      // desktop, where the local server makes it quick to work on.
      input: {
        main: resolve(__dirname, "index.html"),
        auth: resolve(__dirname, "auth.html"),
        mobile: resolve(__dirname, "mobile/index.html"),
      },
    },
  },
});
