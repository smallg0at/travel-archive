import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required env var: ${name} (copy pipeline/.env.example to pipeline/.env)`);
  }
  return value;
}

export const env = {
  azureClientId: required("AZURE_CLIENT_ID"),
  azureTenantId: process.env.AZURE_TENANT_ID ?? "consumers",
  photosFolder: process.env.ONEDRIVE_PHOTOS_FOLDER ?? "Pictures/Travel",
  metadataFolder: process.env.ONEDRIVE_METADATA_FOLDER ?? "Apps/TravelArchive",
  geocodeContactEmail: process.env.GEOCODE_CONTACT_EMAIL ?? "",

  // Inclusive `yyyy-mm` bounds on which month folders `scan` looks at, so you
  // can index a slice of a large library first. Either can be left unset for
  // an open end; both unset means every month folder. Overridable per-run
  // with `-- --from 2025-01 --to 2026-12`.
  scanFrom: process.env.SCAN_MONTH_FROM || null,
  scanTo: process.env.SCAN_MONTH_TO || null,

  // `pipeline serve` binds this port on 127.0.0.1 only — it holds OneDrive
  // credentials, so it must not be reachable from the LAN. That is also why
  // the phone is a read-only client: it talks to OneDrive directly, never to
  // this server.
  servePort: Number(process.env.SERVE_PORT ?? 4319),

  /**
   * How many photos `analyze` captions at once.
   *
   * 4 was measured at ~37 photos/min against gemini-3.7-flash, which is far
   * under any paid-tier request limit — the binding constraint is OneDrive's
   * throttling, not the model. Raise it if Graph tolerates it; the backoff in
   * graph.ts is what makes that safe to try.
   */
  analyzeConcurrency: Math.max(1, Number(process.env.ANALYZE_CONCURRENCY ?? 4)),

  // Which providers/*.ts implementation of AiProvider to use. Add more
  // providers by implementing the interface in providers/types.ts and
  // wiring a new case into providers/index.ts.
  aiProvider: process.env.AI_PROVIDER ?? "anthropic",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-opus-5",
  geminiApiKey: process.env.GEMINI_API_KEY,
  // 3.7 over 3.8: tied on caption quality in the bake-off, marginally faster
  // (2093ms vs 2255ms median), 27% fewer thinking tokens, and it read a
  // German plaque correctly where 3.8 hallucinated a letter.
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-3.7-flash",
  // Thinking tokens bill as output and Gemini 3.x turns them on by default.
  // Unset leaves the model's default; 0 disables; -1 is explicit dynamic.
  geminiThinkingBudget:
    process.env.GEMINI_THINKING_BUDGET === undefined ? undefined : Number(process.env.GEMINI_THINKING_BUDGET),
};
