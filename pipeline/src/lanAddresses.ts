import { networkInterfaces } from "node:os";

/**
 * The private IPv4 addresses this machine holds right now.
 *
 * Read per call rather than at import: a laptop that moves between networks
 * gets a new address, and a list captured at boot would keep printing the old
 * one — the failure the settings page exists to prevent. `internal` excludes
 * loopback, which is exactly the case that has no address to type.
 *
 * **Private ranges only.** The page's Content-Security-Policy enumerates the
 * same ranges (`staticApp.ts`'s `networkOrigins`), so an address outside them
 * would serve a page whose API calls the browser then refuses. A URL that
 * loads and cannot work is worse than no URL at all.
 */
export function lanIpv4Addresses(): string[] {
  const out: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      if (!isPrivateIpv4(address.address)) continue;
      if (!out.includes(address.address)) out.push(address.address);
    }
  }
  return out;
}

/**
 * The private ranges `networkOrigins` puts in the page's CSP: RFC 1918 only.
 *
 * Deliberately the same three ranges, not every non-public one. Link-local
 * (`169.254`) and carrier NAT (`100.64`) are absent from the policy, so a URL
 * on one would load the page and then have every API call refused.
 */
export function isPrivateIpv4(host: string): boolean {
  const [a, b] = host.split(".").map(Number);
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}
