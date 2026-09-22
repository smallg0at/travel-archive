import { execFileSync } from "node:child_process";
import { Agent, Dispatcher, ProxyAgent, setGlobalDispatcher } from "undici";
import type { ProxyCategoryMode, ProxySettings } from "@travel-archive/shared";
import { env } from "./env.js";

/**
 * Detects the system proxy.
 * On Windows, queries Internet Settings in HKCU.
 * Falls back to standard environment variables (HTTPS_PROXY, HTTP_PROXY, ALL_PROXY).
 */
export function detectSystemProxy(): string | null {
  if (process.platform === "win32") {
    try {
      const enableOut = execFileSync(
        "reg.exe",
        ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyEnable"],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
      );
      if (/ProxyEnable\s+REG_DWORD\s+0x1/i.test(enableOut)) {
        const serverOut = execFileSync(
          "reg.exe",
          ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyServer"],
          { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
        );
        const m = serverOut.match(/ProxyServer\s+REG_SZ\s+(\S+)/i);
        if (m && m[1]) {
          let s = m[1];
          // Handle format: "http=127.0.0.1:7890;https=127.0.0.1:7890"
          if (s.includes("=")) {
            const httpsMatch = s.match(/(?:https|http)=([^;]+)/i);
            if (httpsMatch) s = httpsMatch[1];
          }
          return normalizeProxyUrl(s);
        }
      }
    } catch {
      // Registry read failed, fall through to env
    }
  }

  const envProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;
  if (envProxy) return normalizeProxyUrl(envProxy);

  return null;
}

export function normalizeProxyUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed) || /^socks5:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}

export function getProxySettings(): ProxySettings {
  const detected = detectSystemProxy();
  return {
    systemEnabled: env.proxySystemEnabled,
    systemDetected: detected,
    aiMode: env.proxyAiMode,
    aiUrl: normalizeProxyUrl(env.proxyAiUrl),
    graphMode: env.proxyGraphMode,
    graphUrl: normalizeProxyUrl(env.proxyGraphUrl),
  };
}

const directAgent = new Agent();
const proxyAgentCache = new Map<string, ProxyAgent>();

function getProxyAgent(url: string): ProxyAgent {
  let agent = proxyAgentCache.get(url);
  if (!agent) {
    agent = new ProxyAgent(url);
    proxyAgentCache.set(url, agent);
  }
  return agent;
}

function isAiHost(host: string): boolean {
  return (
    host.includes("googleapis.com") ||
    host.includes("anthropic.com") ||
    host.includes("openai.com")
  );
}

function isGraphHost(host: string): boolean {
  return (
    host.includes("graph.microsoft.com") ||
    host.includes("login.microsoftonline.com") ||
    host.includes("sharepoint.com") ||
    host.includes("1drv.ms")
  );
}

class CategoryRoutingDispatcher extends Dispatcher {
  private settings: ProxySettings;

  constructor(settings: ProxySettings) {
    super();
    this.settings = settings;
  }

  private pickAgent(origin: string): Dispatcher {
    let hostname = "";
    try {
      hostname = new URL(origin).hostname.toLowerCase();
    } catch {
      return directAgent;
    }

    // Never proxy local traffic
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
      return directAgent;
    }

    const { systemEnabled, systemDetected, aiMode, aiUrl, graphMode, graphUrl } = this.settings;

    if (isAiHost(hostname)) {
      if (aiMode === "custom" && aiUrl) {
        return getProxyAgent(aiUrl);
      }
      if (aiMode === "system" && systemEnabled && systemDetected) {
        return getProxyAgent(systemDetected);
      }
      return directAgent;
    }

    if (isGraphHost(hostname)) {
      if (graphMode === "custom" && graphUrl) {
        return getProxyAgent(graphUrl);
      }
      if (graphMode === "system" && systemEnabled && systemDetected) {
        return getProxyAgent(systemDetected);
      }
      return directAgent;
    }

    // Default for other hosts: follow system proxy if system proxy is enabled
    if (systemEnabled && systemDetected) {
      return getProxyAgent(systemDetected);
    }

    return directAgent;
  }

  dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
    const origin = typeof opts.origin === "string" ? opts.origin : opts.origin?.toString() ?? "";
    const agent = this.pickAgent(origin);
    return agent.dispatch(opts, handler);
  }
}

let activeDispatcher: CategoryRoutingDispatcher | null = null;

export function updateProxyDispatcher(settings?: ProxySettings): void {
  const current = settings ?? getProxySettings();
  activeDispatcher = new CategoryRoutingDispatcher(current);
  setGlobalDispatcher(activeDispatcher);
}

export function initProxyDispatcher(): void {
  updateProxyDispatcher();
}
