/**
 * Turning MSAL's device-code answer into the countdown the sign-in page shows.
 *
 * Kept apart from auth.ts so it can be tested without an Azure client id:
 * auth.ts builds a `PublicClientApplication` at module load and therefore
 * cannot be imported by a test that has no environment.
 */

export interface PendingDeviceCode {
  url: string;
  code: string;
  /** ISO timestamp — the page counts down from it. */
  expiresAt: string;
}

export interface DeviceCodeAnswer {
  userCode?: string;
  verificationUri?: string;
  expiresIn?: number;
  message?: string;
}

/**
 * The pending code, or null when the answer cannot be used.
 *
 * MSAL calls `deviceCodeCallback` **before** it validates the response, so a
 * rejected request arrives here with every field undefined. Building a Date
 * from that produced `RangeError: Invalid time value`, which surfaced to the
 * user as a scan failing for no stated reason and replaced the real cause.
 * Null here lets the caller stay quiet and let MSAL raise what went wrong.
 */
export function pendingFromDeviceCode(answer: DeviceCodeAnswer | null | undefined): PendingDeviceCode | null {
  const expiresIn = Number(answer?.expiresIn);
  if (!answer?.userCode || !answer.verificationUri) return null;
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) return null;
  return {
    url: answer.verificationUri,
    code: answer.userCode,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}
