import { config as loadDotenv } from "dotenv";
import { homeFile } from "./paths.js";

// Not `dotenv/config`, which reads `.env` from process.cwd(). The desktop
// shell runs this from wherever Electron happened to start, and an installed
// app has no checkout to be "in" — so the file is addressed explicitly.
// `quiet` because a missing .env is normal for a fresh install: the app still
// reads the archive, and only generation is unavailable until one exists.

/**
 * The environment as it was *before* `.env` was read.
 *
 * Kept so the config form can tell you when a value you just saved is being
 * shadowed by a real environment variable — dotenv never overrides one, so the
 * saved value would work for this run and then silently lose to the machine's
 * own setting on the next start. That is precisely the kind of quiet wrongness
 * this project keeps paying for, so it is reported rather than left to be
 * discovered.
 */
const SHELL_ENV = new Set(Object.keys(process.env).filter((k) => process.env[k]));

/** Whether this name comes from the real environment rather than `.env`. */
export function shadowedByEnvironment(name: string): boolean {
  return SHELL_ENV.has(name);
}

loadDotenv({ path: homeFile(".env"), quiet: true });

/**
 * Configuration compiled into the bundle when the desktop installer is built.
 *
 * An installed app has no checkout and, on a fresh machine, no `.env` — and
 * `AZURE_CLIENT_ID` being *required* meant the job server refused to start at
 * all, so generation did not merely fail, it vanished. Baking the non-secret
 * settings at package time lets the server come up and report a specific
 * problem instead.
 *
 * **Fallback, never override.** `process.env` still wins, so a `.env` beside
 * the archive can correct anything baked into a build.
 *
 * Only non-secret values are ever baked — see the allowlist in
 * desktop/scripts/bundle-pipeline.mjs. API keys are not in it and must come
 * from the environment.
 *
 * `typeof` rather than a direct read: esbuild substitutes this identifier at
 * bundle time, and running from source it is simply not declared.
 */
declare const __BAKED_CONFIG__: Record<string, string> | undefined;
const baked: Record<string, string> =
  typeof __BAKED_CONFIG__ !== "undefined" && __BAKED_CONFIG__ ? __BAKED_CONFIG__ : {};

/** An environment variable, or the value baked in at package time. */
function fromEnv(name: string): string | undefined {
  return process.env[name] || baked[name] || undefined;
}

function required(name: string, fallback?: string): string {
  const value = fromEnv(name) ?? fallback;
  if (!value) {
    throw new Error(`Missing required env var: ${name} (copy pipeline/.env.example to pipeline/.env)`);
  }
  return value;
}

function readEnv() {
  return {
    azureClientId: required("AZURE_CLIENT_ID"),
    azureTenantId: fromEnv("AZURE_TENANT_ID") ?? "consumers",
    photosFolder: fromEnv("ONEDRIVE_PHOTOS_FOLDER") ?? "Pictures/Travel",
    metadataFolder: fromEnv("ONEDRIVE_METADATA_FOLDER") ?? "Apps/TravelArchive",
    geocodeContactEmail: fromEnv("GEOCODE_CONTACT_EMAIL") ?? "",

    // Inclusive `yyyy-mm` bounds on which month folders `scan` looks at, so you
    // can index a slice of a large library first. Either can be left unset for
    // an open end; both unset means every month folder. Overridable per-run
    // with `-- --from 2025-01 --to 2026-12`.
    scanFrom: fromEnv("SCAN_MONTH_FROM") || null,
    scanTo: fromEnv("SCAN_MONTH_TO") || null,

    // `pipeline serve` binds this port on 127.0.0.1 only — it holds OneDrive
    // credentials, so it must not be reachable from the LAN. That is also why
    // the phone is a read-only client: it talks to OneDrive directly, never to
    // this server.
    servePort: Number(fromEnv("SERVE_PORT") ?? 4319),

    /**
     * How many photos `analyze` captions at once.
     *
     * 4 was measured at ~37 photos/min against gemini-3.7-flash, which is far
     * under any paid-tier request limit — the binding constraint is OneDrive's
     * throttling, not the model. Raise it if Graph tolerates it; the backoff in
     * graph.ts is what makes that safe to try.
     */
    analyzeConcurrency: Math.max(1, Number(fromEnv("ANALYZE_CONCURRENCY") ?? 4)),

    // Which providers/*.ts implementation of AiProvider to use. Add more
    // providers by implementing the interface in providers/types.ts and
    // wiring a new case into providers/index.ts.
    aiProvider: fromEnv("AI_PROVIDER") ?? "anthropic",
    anthropicApiKey: fromEnv("ANTHROPIC_API_KEY"),
    anthropicModel: fromEnv("ANTHROPIC_MODEL") ?? "claude-opus-5",
    geminiApiKey: fromEnv("GEMINI_API_KEY"),
    // 3.7 over 3.8: tied on caption quality in the bake-off, marginally faster
    // (2093ms vs 2255ms median), 27% fewer thinking tokens, and it read a
    // German plaque correctly where 3.8 hallucinated a letter.
    geminiModel: fromEnv("GEMINI_MODEL") ?? "gemini-3.7-flash",
    // Thinking tokens bill as output and Gemini 3.x turns them on by default.
    // Unset leaves the model's default; 0 disables; -1 is explicit dynamic.
    geminiThinkingBudget:
      fromEnv("GEMINI_THINKING_BUDGET") === undefined ? undefined : Number(fromEnv("GEMINI_THINKING_BUDGET")),
    // The model `translate` uses, for whichever provider is active. Unset means
    // that provider's own model. Translation is bulk text where quality matters
    // least, so this is the setting for the cheapest model that will do.
    translateModel: fromEnv("TRANSLATE_MODEL"),

    // Network proxy settings
    proxySystemEnabled: fromEnv("PROXY_SYSTEM_ENABLED") === "true",
    proxyAiMode: (fromEnv("PROXY_AI_MODE") as "system" | "direct" | "custom") || "system",
    proxyAiUrl: fromEnv("PROXY_AI_URL") || "",
    proxyGraphMode: (fromEnv("PROXY_GRAPH_MODE") as "system" | "direct" | "custom") || "direct",
    proxyGraphUrl: fromEnv("PROXY_GRAPH_URL") || "",
  };
}

/**
 * The live configuration.
 *
 * A mutable object rather than a frozen snapshot so `reloadEnv` can update it
 * in place: everything already reads `env.x` at call time, so a reload reaches
 * every caller without any of them holding a stale copy. The one thing that
 * must not do this is a module-level capture like `const MODEL = env.model`,
 * which is why the providers construct their clients lazily.
 */
export const env = readEnv();

/**
 * Re-reads configuration after `.env` has been written at runtime.
 *
 * The Settings config form writes the file *and* sets `process.env` itself, so
 * this deliberately does not pass `override` to dotenv — a real environment
 * variable set by whoever launched the process still wins, which is the same
 * precedence as at startup.
 */
export function reloadEnv(): void {
  loadDotenv({ path: homeFile(".env"), quiet: true });
  Object.assign(env, readEnv());
}

