/**
 * Refuse a response this runtime cannot decode safely.
 *
 * Node 22.23.3 and earlier, and Node 24.22.0, ship a Brotli decoder with an
 * out-of-bounds write that permits remote code execution
 * (CVE-2026-111497). Electron 45 and every supported Electron line still carry
 * those Node builds as of 2026-10-27, so the fix has to wait for a vendor
 * rebuild — but nothing here ever asks for Brotli, and a server has no business
 * sending it when `Accept-Encoding` did not include it.
 *
 * `fetch` decompresses lazily when the body is read, so cancelling as soon as
 * the headers arrive means the decoder never sees the bytes. That is not a
 * complete fix (a provider SDK doing its own fetch is outside this), and it is
 * deliberately a hard failure: a response we refuse is a bug to investigate,
 * not something to fall back from silently.
 */
export function assertNoBrotli(response: Response, url: string): void {
  const encoding = response.headers.get("content-encoding");
  if (!encoding) return;
  const brotli = encoding
    .split(",")
    .some((part) => part.trim().toLowerCase() === "br");
  if (!brotli) return;

  void response.body?.cancel().catch(() => {});
  throw new Error(
    `Refused a Brotli-encoded response from ${forLog(url)}: ` +
      `this runtime's decoder is unpatched (CVE-2026-111497). ` +
      `Retry later, or set the service to gzip — the request never asked for Brotli.`,
  );
}

/**
 * The origin and path, never the query: OneDrive download URLs carry a
 * short-lived pre-authenticated token there, and an error message ends up in
 * job logs the user can open.
 */
function forLog(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "an external host";
  }
}
