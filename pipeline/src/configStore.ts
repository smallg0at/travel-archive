import type { ConfigStatus } from "@travel-archive/shared";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { env, reloadEnv, shadowedByEnvironment } from "./env.js";
import { homeFile } from "./paths.js";
import { getProxySettings, updateProxyDispatcher } from "./proxy.js";

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
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "ONEDRIVE_PHOTOS_FOLDER",
  "ONEDRIVE_METADATA_FOLDER",
  "GEOCODE_CONTACT_EMAIL",
  "PROXY_SYSTEM_ENABLED",
  "PROXY_AI_MODE",
  "PROXY_AI_URL",
  "PROXY_GRAPH_MODE",
  "PROXY_GRAPH_URL",
] as const;

export type WritableKey = (typeof WRITABLE)[number];

/** Secrets, which are reported as set-or-not and never sent back out. */
const SECRET: WritableKey[] = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY"];

export function configStatus(): ConfigStatus {
  const provider = env.aiProvider;
  const keys = { anthropic: Boolean(env.anthropicApiKey), gemini: Boolean(env.geminiApiKey) };
  return {
    path: homeFile(".env"),
    exists: existsSync(homeFile(".env")),
    provider,
    ready: provider === "gemini" ? keys.gemini : keys.anthropic,
    keys,
    photosFolder: env.photosFolder,
    metadataFolder: env.metadataFolder,
    geocodeContactEmail: env.geocodeContactEmail,
    anthropicModel: env.anthropicModel,
    geminiModel: env.geminiModel,
    shadowed: WRITABLE.filter(shadowedByEnvironment),
    proxy: getProxySettings(),
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
 * Merges values into `.env`, preserving the rest of the file.
 *
 * Rewrites the line for a key that is already present and appends the ones that
 * are not, so comments and any hand-written settings survive — this file is
 * still meant to be editable by hand.
 */
export async function saveConfig(patch: Partial<Record<WritableKey, string>>): Promise<ConfigStatus> {
  const entries = Object.entries(patch).filter(([k, v]) => WRITABLE.includes(k as WritableKey) && v !== undefined) as [
    WritableKey,
    string,
  ][];
  if (entries.length === 0) return configStatus();

  const path = homeFile(".env");
  let lines: string[] = [];
  try {
    lines = (await readFile(path, "utf-8")).split(/\r?\n/);
  } catch {
    // No file yet: a fresh install, which is the case this exists for.
  }

  for (const [key, value] of entries) {
    const rendered = serialize(key, value);
    const at = lines.findIndex((line) => new RegExp(`^\s*${key}\s*=`).test(line));
    if (at >= 0) lines[at] = rendered;
    else lines.push(rendered);
  }

  await writeFile(path, `${lines.join("\n").replace(/\n+$/, "")}\n`, "utf-8");

  // Set the live process too, then reload. Writing the file alone would leave
  // this run using the old values until a restart, which is exactly the
  // "nothing happened" the form is meant to avoid. Setting `process.env` and
  // then reloading also preserves the normal precedence, where a real
  // environment variable beats the file.
  for (const [key, value] of entries) process.env[key] = value;
  reloadEnv();
  updateProxyDispatcher();

  return configStatus();
}

/** Names this will accept, for the route to validate against. */
export function isWritableKey(name: string): name is WritableKey {
  return (WRITABLE as readonly string[]).includes(name);
}

export { SECRET as SECRET_KEYS };
