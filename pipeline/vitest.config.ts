import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
    /**
     * The two `localThumb` tests that reach the real decoders pay for a cold
     * `import("heic-decode")` (a WASM build) and an `ffmpeg -version` probe:
     * about 400ms on a warm machine, over five seconds on a CI runner whose
     * file cache is cold — which is exactly vitest's default. These are loads,
     * not hangs, so the timeout is raised rather than the assertion weakened;
     * the hooks get the same allowance for the same reason.
     */
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
