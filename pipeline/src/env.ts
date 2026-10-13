import { readFileSync } from "node:fs";
import { config as loadDotenv, parse } from "dotenv";
import { homeFile } from "./paths.js";
import { levelFromLegacyBudget, parseThinkingLevel } from "./providers/geminiConfig.js";

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

/**
 * The environment as the **shell** set it, without anything `.env` contributed.
 *
 * Used when this process replaces itself (`serve.ts`'s `handOver`). Passing the
 * whole of `process.env` carries `.env`'s values into the child, and `dotenv`
 * never overrides an existing variable — so a setting edited in `.env` and then
 * "applied" by a restart would be silently ignored, and the server would come
 * back with exactly the value the reader was trying to change. That is the
 * difference between "restart to apply" working and being a lie: the child reads
 * the file itself and sees what is in it now.
 *
 * A variable truly exported by the shell still travels, because it beats `.env`
 * at boot too — see `shadowedByEnvironment`, which exists to warn about it.
 */
export function shellEnvironment(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of SHELL_ENV) out[name] = process.env[name];
  return out;
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

/**
 * The default analyze concurrency — which depends on where the model runs.
 *
 * 4 was measured for cloud captioning: ~37 photos/min against gemini-3.7-flash,
 * far under any paid-tier request limit, with OneDrive's throttling the binding
 * constraint rather than the model. A local vision model cannot take 4: at 4
 * concurrent streams LM Studio on the 8 GiB card logged "Channel Error" and
 * lost 104 of 359 calls, and at 2 it ran 199 of 200.
 *
 * So the default follows the provider's `scope`, which is the field that marks
 * a service as running on this machine in providers/index.ts. That module is
 * not imported here on purpose: it already imports this one.
 */
function defaultAnalyzeConcurrency(): number {
  const id = fromEnv("AI_PROVIDER") ?? "deepseek";
  return id === "ollama" || id === "lmstudio" ? 2 : 4;
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

    // The port the job server binds. Where it binds is `ARCHIVE_HOST`, below.
    // 18419 sits outside the usual dev range on purpose: the shell is on
    // 17923 and a preview on 4173, so all three can run at once.
    servePort: Number(fromEnv("SERVE_PORT") ?? 18419),

    /**
     * Where the job server listens. **Loopback unless asked otherwise.**
     *
     * `0.0.0.0` is the whole of "let the family read this from their own
     * computers": the app is self-contained, so a phone or laptop on the same
     * network gets the same archive with no server of its own. What it also
     * needs is `ARCHIVE_PASSWORD` — see access.ts — or the startup line will
     * say, loudly, that the archive is open to anything on the network.
     *
     * Both are editable from Settings now (remoteAccess.ts), and both are
     * decided here at startup: a saved value waits for a restart. The phone
     * reads through this server as well as through OneDrive — see
     * `ServerUnavailableError` in the app — so reachable-or-not is a choice,
     * not an assumption.
     */
    archiveHost: fromEnv("ARCHIVE_HOST") ?? "127.0.0.1",
    /** The shared password a remote reader types once. Unset means no gate. */
    archivePassword: fromEnv("ARCHIVE_PASSWORD"),

    /**
     * How many photos `analyze` captions at once.
     *
     * Defaults by where the model runs — 4 in the cloud, 2 on this machine; see
     * `defaultAnalyzeConcurrency` above for both measurements. Setting
     * ANALYZE_CONCURRENCY overrides it outright, and the backoff in graph.ts is
     * what makes a higher cloud value safe to try.
     */
    analyzeConcurrency: Math.max(1, Number(fromEnv("ANALYZE_CONCURRENCY") ?? defaultAnalyzeConcurrency())),

    // Which providers/*.ts implementation of AiProvider to use. Any id from
    // providers/index.ts's PRESETS; a new OpenAI-compatible service is a table
    // entry there plus `AI_PROVIDER=<id>`. Names are validated in getProvider.
    // A batch is one brief: the images in a single request are all from the same
    // pass, and mixing briefs inside one reply would make the result order the
    // only thing telling them apart.
    aiProvider: fromEnv("AI_PROVIDER") ?? "deepseek",
    /**
     * Which provider describes the screenshots nobody has vouched for — the ones
     * the allowlist keeps off the wire. It has to be a local service: the point
     * is that the image never leaves the machine, so the pass refuses a cloud id
     * out loud rather than quietly sending them (jobs/screenCaptions.ts). Unset
     * means the pass is off, and says so when asked to run.
     */
    screenshotProvider: fromEnv("SCREENSHOT_PROVIDER"),
    /**
     * No longer read from `.env`, and `screenshotPassphrase` is gone from this
     * type on purpose: the passphrase lives in the Windows key store (DPAPI, this
     * user), because one lying in plaintext beside the ciphertext defeats the
     * point of the ciphertext. `SCREENSHOT_PASSPHRASE` survives in the
     * environment only long enough for the startup migration to move an existing
     * value out of the file. See screenKeyStore.ts; losing it costs a re-run of
     * the describing, not the archive.
     */
    geminiApiKey: fromEnv("GEMINI_API_KEY"),
    // 3.7 over 3.8: tied on caption quality in the bake-off, marginally faster
    // (2093ms vs 2255ms median), 27% fewer thinking tokens, and it read a
    // German plaque correctly where 3.8 hallucinated a letter.
    geminiModel: fromEnv("GEMINI_MODEL") ?? "gemini-3.7-flash",
    // Thinking tokens bill as output and Gemini 3.x turns them on by default.
    // `GEMINI_THINKING_LEVEL` is the knob now — minimal/low/medium/high, unset
    // for the model's own default, which is the value Google tunes per model.
    //
    // The older `GEMINI_THINKING_BUDGET` is read and *mapped*, never sent:
    // Gemini 3.x was remapping it to a level, and upcoming models answer 400
    // INVALID_ARGUMENT to it instead (Google's deprecation notice, 2026-10). A
    // `.env` written before the change keeps its intent; a value that is not a
    // number is treated as unset rather than guessed at.
    geminiThinkingLevel:
      parseThinkingLevel(fromEnv("GEMINI_THINKING_LEVEL")) ??
      levelFromLegacyBudget(fromEnv("GEMINI_THINKING_BUDGET")),
    // The model `translate` uses, for whichever provider is active. Unset means
    // that provider's own model. Translation is bulk text where quality matters
    // least, so this is the setting for the cheapest model that will do.
    translateModel: fromEnv("TRANSLATE_MODEL"),

    // DeepSeek, used when AI_PROVIDER=deepseek. The default model is the
    // image-capable Flash: the JSON-output docs call it `deepseek-flash`, and
    // the older `deepseek-v4-flash-vision-exp` is a still-accepted alias. Its
    // plain `deepseek-v4-flash` is text-only.
    deepseekApiKey: fromEnv("DEEPSEEK_API_KEY"),
    deepseekBaseUrl: fromEnv("DEEPSEEK_BASE_URL") ?? "https://api.deepseek.com/v1",
    deepseekModel: fromEnv("DEEPSEEK_MODEL") ?? "deepseek-flash",

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
 * A setting read from disk **now**, not from the snapshot this process booted
 * with.
 *
 * Most settings can wait for a restart — they describe how the archive is
 * scanned or synced, and a restart is part of changing them. Two cannot: the
 * local screenshot pass's provider and passphrase, which are edited on the
 * Settings page and would otherwise need a server restart to take effect for no
 * reason at all.
 *
 * Precedence matches the loader's: a real environment variable wins over `.env`,
 * because that is the rule `loadDotenv` keeps at boot and two different rules for
 * the same key would be worse than the surprise.
 */
export function settingNow(key: string): string | undefined {
  const fromProcess = process.env[key];
  if (fromProcess) return fromProcess;
  try {
    const parsed = parse(readFileSync(homeFile(".env"), "utf-8")) as Record<string, string>;
    return parsed[key] || undefined;
  } catch {
    // No .env at all is a normal state (a packaged build has none).
    return undefined;
  }
}

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

