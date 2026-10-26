import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { env } from "./env.js";
import { archiveHome, moduleFile } from "./paths.js";
import { gazetteerStats } from "./geocodeOffline.js";
import { loadScreenshotAllowlist } from "./screenshots.js";
import { renderCapability } from "./localThumb.js";
import { runningPorts } from "./remoteAccess.js";
import { servesThisApp } from "./staticApp.js";

/**
 * What this build actually has, answered by the build itself.
 *
 * Every packaging failure so far looked the same from the outside — the app
 * worked from a checkout and not once installed — and every one was found by
 * a user's failed run rather than by a check. `/health` is the wrong place for
 * this: it is polled and must stay cheap. This is asked once, by
 * `scripts/smoke-package.mjs` and by support, and it names what is missing
 * instead of leaving it to be inferred.
 *
 * No secret is ever included. Keys are reported as present or absent, never by
 * value, and the route is loopback-only (see serve.ts).
 */
export interface BuildInfo {
  version: string;
  commit: string | null;
  dirty: boolean;
  builtAt: string;
}

export interface Diagnostics {
  runtime: { node: string; electron: string | null; platform: string };
  build: BuildInfo | null;
  /** Writable per-user state; loopback callers only. */
  home: string;
  config: {
    azureClientId: "set" | "missing";
    azureTenantId: string;
    metadataFolder: string;
    photosFolder: string;
    aiProvider: string;
  };
  payload: {
    gazetteer: { places: number; countries: number } | { error: string };
    screenshotAllowlist: number;
    pageServed: boolean;
    ffmpegBesideCode: boolean;
  };
  render: { images: boolean; heif: boolean; ffmpeg: string | null };
}

async function buildInfo(): Promise<BuildInfo | null> {
  try {
    return JSON.parse(await readFile(moduleFile("build-info.json"), "utf-8")) as BuildInfo;
  } catch {
    return null;
  }
}

export async function diagnostics(): Promise<Diagnostics> {
  const [build, gazetteer, allowlist, render, pageServed] = await Promise.all([
    buildInfo(),
    gazetteerStats().catch((error: Error) => ({ error: error.message })),
    loadScreenshotAllowlist(),
    renderCapability(),
    // Asked, not assumed: when the desktop shell is running it serves the page
    // itself, and this server's own `appServer` is null even though a phone can
    // load the archive perfectly well.
    servesThisApp(runningPorts.page),
  ]);

  return {
    runtime: {
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      platform: process.platform,
    },
    build,
    home: archiveHome(),
    config: {
      azureClientId: env.azureClientId ? "set" : "missing",
      azureTenantId: env.azureTenantId,
      metadataFolder: env.metadataFolder,
      photosFolder: env.photosFolder,
      aiProvider: env.aiProvider,
    },
    payload: {
      gazetteer,
      screenshotAllowlist: allowlist.length,
      pageServed,
      // A packaged install carries ffmpeg only if someone bundled it; finding
      // one on PATH is this machine's luck, not the payload's property.
      ffmpegBesideCode: existsSync(moduleFile(process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg")),
    },
    render,
  };
}
