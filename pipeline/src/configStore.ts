import type { ConfigStatus, ProviderOption } from "@travel-archive/shared";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { env, reloadEnv, shadowedByEnvironment } from "./env.js";
import { homeFile } from "./paths.js";
import { getProxySettings, updateProxyDispatcher } from "./proxy.js";
import { PRESETS } from "./providers/index.js";

/**
 * Reading and writing the pipeline's own `.env` at runtime.
 *
 * A fresh install used to be told to go and write that file by hand, which is
 * the only step in the whole product that asked the user to edit a config file
 * — and the dialog saying so could not even say what was already correct.
 *
 * Only *generation* needs any of this. The archive reads fine without it: the
 * app's Azure client id is compiled into the build, and a packaged install
 * carries the non-secret pipeline settings baked in too (see
 * desktop/scripts/bundle-pipeline.mjs). So on the machines where the "not
 * configured" dialog actually appears, the one genuinely missing value is the
 * AI provider's API key.
 */

/**
 * The only names this may write. **An allowlist, deliberately.**
 *
 * This endpoint turns an HTTP request into lines of a file that the process
 * reads as environment variables on its next start. Without a fixed list, a
 * request could set `NODE_OPTIONS` and get arbitrary code executed the next
 * time the server came up. The server is loopback-only, but that is a reason
 * to keep the blast radius small rather than to skip the check.
 *
 * `AZURE_CLIENT_ID` is *not* here on purpose: `auth.ts` builds its MSAL client
 * once at import, so changing it would not take effect until a restart and the
 * form would be promising something it cannot deliver. It is baked into every
 * packaged build anyway.
 */
const WRITABLE = [
  "AI_PROVIDER",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_MODEL",
  "DEEPSEEK_BASE_URL",
  "SILICONFLOW_API_KEY",
  "SILICONFLOW_MODEL",
  "SILICONFLOW_BASE_URL",
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_MODEL",
  "DASHSCOPE_BASE_URL",
  "ZHIPU_API_KEY",
  "ZHIPU_MODEL",
  "ZHIPU_BASE_URL",
  "MOONSHOT_API_KEY",
  "MOONSHOT_MODEL",
  "MOONSHOT_BASE_URL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "OPENROUTER_BASE_URL",
  "OLLAMA_API_KEY",
  "OLLAMA_MODEL",
  "OLLAMA_BASE_URL",
  "LMSTUDIO_API_KEY",
  "LMSTUDIO_MODEL",
  "LMSTUDIO_BASE_URL",
  "ONEDRIVE_PHOTOS_FOLDER",
  "ONEDRIVE_METADATA_FOLDER",
  "GEOCODE_CONTACT_EMAIL",
  // Remote access: whether the server is reachable beyond this machine, and
  // the shared password that then gates reading. Both are decided at startup
  // (server.listen and makeAccess), which is why saving them reports
  // "restart to apply" rather than taking effect — see remoteAccess.ts.
  //
  // ARCHIVE_HOST is not free-form here: a value `server.listen` cannot bind
  // leaves a server that never starts again, discovered at the next sign-in.
  // The two states the form offers are the two this accepts.
  "ARCHIVE_HOST",
  "ARCHIVE_PASSWORD",
  "PROXY_SYSTEM_ENABLED",
  "PROXY_AI_MODE",
  "PROXY_AI_URL",
  "PROXY_GRAPH_MODE",
  "PROXY_GRAPH_URL",
  // Desktop notifications. Three switches, read live by the job when it ends,
  // so saving one takes effect on the next job rather than at a restart.
  //
  // NOTIFY_BANNER is deliberately *not* surfaced in Settings yet: silent
  // delivery (SuppressPopup — Action Center only, no banner) was measured
  // working, but the switch has not earned a place in the form until someone
  // has lived with both. It is settable by hand for that experiment.
  "NOTIFY_SUCCESS",
  "NOTIFY_FAILURES",
  "NOTIFY_BANNER",
  // The local screenshot pass: which service on this machine describes the
  // screens nobody has vouched for. Read live by the job at the moment it starts
  // (settingNow), so saving it takes effect on the next run rather than at a
  // restart.
  //
  // SCREENSHOT_PASSPHRASE is deliberately *not* here any more, and not merely
  // unwritable through the form: it lives in the Windows key store (DPAPI, this
  // user) because a passphrase lying in plaintext beside the ciphertext defeats
  // the point of the ciphertext. See DEPRECATED.
  "SCREENSHOT_PROVIDER",
] as const;

/**
 * Keys that used to live in `.env` and must not come back.
 *
 * They can be *removed* through `saveConfig` — which is how the startup
 * migration deletes the plaintext line it just imported — and nothing else.
 */
const DEPRECATED = ["SCREENSHOT_PASSPHRASE"] as const;

/**
 * Values that are switches rather than text: `1` on, `0` off, absent meaning
 * on. A typo here would be a setting that never applies, which is why
 * `saveConfig` refuses it loudly instead of writing it.
 */
const FLAGS = ["NOTIFY_SUCCESS", "NOTIFY_FAILURES", "NOTIFY_BANNER"] as const;

export type WritableKey = (typeof WRITABLE)[number];

/**
 * Secrets, which are reported as set-or-not and never sent back out.
 *
 * Every provider's key variable ends in `_API_KEY`, so it is matched by that
 * suffix rather than listed — a new service added to PRESETS cannot be
 * forgotten here and leak its key into a response.
 */
const SECRET = WRITABLE.filter((k) => k.endsWith("_API_KEY")) as WritableKey[];

export function configStatus(): ConfigStatus {
  const provider = env.aiProvider;
  const keys = { gemini: Boolean(env.geminiApiKey) };
  const providers: ProviderOption[] = PRESETS.map((p) => ({
    id: p.id,
    label: p.label,
    kind: p.kind,
    scope: p.scope ?? "cloud",
    baseUrl: process.env[`${p.id.toUpperCase()}_BASE_URL`] || p.baseUrl || null,
    model: process.env[`${p.id.toUpperCase()}_MODEL`] || p.model,
    apiKeyEnv: p.apiKeyEnv,
    hasKey: Boolean(process.env[p.apiKeyEnv]),
    platformUrl: p.platformUrl ?? null,
    supportsBatch: p.kind === "gemini",
    editable: { baseUrl: p.kind === "openai", model: true, apiKey: true },
  }));
  const selected = providers.find((p) => p.id === provider);
  return {
    path: homeFile(".env"),
    exists: existsSync(homeFile(".env")),
    provider,
    providers,
    ready: Boolean(selected?.hasKey),
    keys,
    photosFolder: env.photosFolder,
    metadataFolder: env.metadataFolder,
    geocodeContactEmail: env.geocodeContactEmail,
    geminiModel: env.geminiModel,
    shadowed: WRITABLE.filter(shadowedByEnvironment),
    proxy: getProxySettings(),
    // Read live, not from `env`: `saveConfig` writes process.env and reloads,
    // and a switch whose saved value did not appear in the answer would make
    // the Settings checkbox snap back on every save.
    notify: {
      success: process.env.NOTIFY_SUCCESS !== "0",
      failures: process.env.NOTIFY_FAILURES !== "0",
    },
  };
}

/**
 * A value safe to put on one line of a `.env`.
 *
 * A newline in a value would end the line and start another assignment, which
 * is the same injection the allowlist above exists to prevent — so it is
 * rejected rather than escaped. Everything else is quoted, which keeps spaces,
 * `#` and trailing whitespace intact.
 */
function serialize(key: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`${key} must not contain a line break`);
  return `${key}="${value.replace(/(["\$`])/g, "\$1")}"`;
}

/**
 * The hosts this accepts for `ARCHIVE_HOST`.
 *
 * Not free form: `server.listen` binds whatever it is given, and a value it
 * cannot bind is a server that never starts again — that failure arrives at
 * the next sign-in with nothing on screen to explain it. `0.0.0.0` is the
 * whole of "let the family read this"; the two loopbacks are the private
 * default. Anything else stays available to someone editing `.env` by hand.
 */
const HOST_VALUES = ["127.0.0.1", "localhost", "0.0.0.0"] as const;

/**
 * Merges values into `.env`, preserving the rest of the file; `null` removes
 * the line.
 *
 * Rewrites the line for a key that is already present and appends the ones that
 * are not, so comments and any hand-written settings survive — this file is
 * still meant to be editable by hand. Removal is a first-class operation
 * rather than an empty string: `ARCHIVE_PASSWORD=""` would leave the gate on
 * with a password nobody could type.
 */
/**
 * A patch to `.env`.
 *
 * Writable keys take a value or `null` (remove the line); a deprecated key can
 * only be removed — `null` is the sole thing its type accepts, so "write the
 * old passphrase back into the file" cannot be expressed, let alone run.
 */
export type ConfigPatch = Partial<Record<WritableKey, string | null>> &
  Partial<Record<(typeof DEPRECATED)[number], null>>;

export async function saveConfig(patch: ConfigPatch): Promise<ConfigStatus> {
  const entries = Object.entries(patch).filter(([k, v]) => WRITABLE.includes(k as WritableKey) && v !== undefined) as [
    WritableKey,
    string | null,
  ][];
  // Deprecated keys can be *removed* and nothing else — the type says so, and so
  // does this: `SCREENSHOT_PASSPHRASE` moved into the machine's key store, and a
  // plaintext copy beside the ciphertext is the thing being removed.
  const removals = Object.entries(patch).filter(
    ([k, v]) => (DEPRECATED as readonly string[]).includes(k) && v === null,
  ) as [string, null][];
  for (const [key, value] of Object.entries(patch)) {
    if ((DEPRECATED as readonly string[]).includes(key) && value !== null && value !== undefined) {
      throw new Error(`${key} is no longer stored in .env; it is kept in the machine's key store.`);
    }
  }
  if (entries.length === 0 && removals.length === 0) return configStatus();

  for (const [key, value] of entries) {
    if (key === "ARCHIVE_HOST" && value !== null && !(HOST_VALUES as readonly string[]).includes(value)) {
      throw new Error(`${value} is not a host this server can bind; use one of ${HOST_VALUES.join(", ")}`);
    }
    if ((FLAGS as readonly string[]).includes(key) && value !== null && value !== "0" && value !== "1") {
      throw new Error(`${value} is not a switch value; use 1 (on) or 0 (off)`);
    }
  }

  const path = homeFile(".env");
  let lines: string[] = [];
  try {
    lines = (await readFile(path, "utf-8")).split(/\r?\n/);
  } catch {
    // No file yet: a fresh install, which is the case this exists for.
  }

  for (const [key, value] of [...entries, ...removals]) {
    const at = lines.findIndex((line) => new RegExp(`^\s*${key}\s*=`).test(line));
    if (value === null) {
      if (at >= 0) lines.splice(at, 1);
      continue;
    }
    const rendered = serialize(key, value);
    if (at >= 0) lines[at] = rendered;
    else lines.push(rendered);
  }

  await writeFile(path, `${lines.join("\n").replace(/\n+$/, "")}\n`, "utf-8");

  // Set the live process too, then reload. Writing the file alone would leave
  // this run using the old values until a restart, which is exactly the
  // "nothing happened" the form is meant to avoid. Setting `process.env` and
  // then reloading also preserves the normal precedence, where a real
  // environment variable beats the file.
  //
  // For remote access this is deliberately *not* the server's answer: listen
  // and makeAccess take theirs from `.env` at startup, and `remoteAccess.ts`
  // keeps that first reading so the form can say "saved, restart to apply"
  // rather than claiming a change that has not happened.
  for (const [key, value] of entries) {
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  reloadEnv();
  updateProxyDispatcher();

  return configStatus();
}

/**
 * What `.env` holds, for a status that has to compare *saved* against
 * *running*. Quotes come off the way `serialize` put them on; a key the file
 * does not mention comes back absent, meaning its default applies next start.
 */
export async function readSavedEnv(): Promise<Partial<Record<WritableKey, string>>> {
  let text = "";
  try {
    text = await readFile(homeFile(".env"), "utf-8");
  } catch {
    return {};
  }
  const out: Partial<Record<WritableKey, string>> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1] as WritableKey;
    if (!WRITABLE.includes(key)) continue;
    out[key] = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/** Names this will accept, for the route to validate against. */
export function isWritableKey(name: string): name is WritableKey {
  return (WRITABLE as readonly string[]).includes(name);
}

export { SECRET as SECRET_KEYS };
