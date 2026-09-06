import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    outDir: "dist",
    rollupOptions: {
      // Two entry points: the main app, and the dedicated MSAL redirect
      // bridge page (auth/index.html) — see src/msalConfig.ts for why the
      // latter has to be a separate page rather than a route in the app.
      input: {
        main: resolve(__dirname, "index.html"),
        auth: resolve(__dirname, "auth/index.html"),
      },
    },
  },
});
