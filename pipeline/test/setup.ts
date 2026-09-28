import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolation: point the writable home (`.env`, `token-cache.json`, `data/`)
// at a fresh temp dir BEFORE any `env.ts` / `paths.ts` consumer is imported.
// Vitest runs this file before test modules, so `readEnv()` below (and in
// tests) sees the fakes, never the owner's real checkout.
process.env.ARCHIVE_HOME = mkdtempSync(join(tmpdir(), "travel-archive-test-"));
process.env.AZURE_CLIENT_ID ??= "ci-dummy-client-id";
process.env.ONEDRIVE_METADATA_FOLDER ??= "CI-FAKE-FOLDER-NEVER-USE";
process.env.GEOCODE_CONTACT_EMAIL ??= "ci@example.invalid";

// Belt and braces: even if a test reaches the network layer, graph.ts
// refuses live calls under CI/Vitest without an explicit opt-in.
process.env.CI ??= "1";
