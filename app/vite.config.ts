import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    outDir: "dist",
    rollupOptions: {
      // Three entry points: the main app; the dedicated MSAL redirect bridge
      // page (auth/index.html) — see src/msalConfig.ts for why that has to be
      // a separate page rather than a route in the app; and the phone app
      // (mobile/index.html, src/mobile/), which shares the data layer but not
      // the layout. Built here too so it can be opened at /mobile/ on the
      // desktop, where the local server makes it quick to work on.
      input: {
        main: resolve(__dirname, "index.html"),
        auth: resolve(__dirname, "auth/index.html"),
        mobile: resolve(__dirname, "mobile/index.html"),
      },
    },
  },
});
