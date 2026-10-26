import { describe, expect, it } from "vitest";
import { pendingFromDeviceCode } from "../src/deviceCode.js";

/**
 * A scan started from the OOBE wizard failed with "Invalid time value" and
 * nothing else. The cause was MSAL calling `deviceCodeCallback` before it
 * validated the response: a rejected request arrives with every field
 * undefined, and `new Date(undefined).toISOString()` threw inside the
 * callback, masking the auth error. These tests pin the "cannot be used"
 * answer so the caller can stay quiet and let MSAL report the real failure.
 */

describe("pendingFromDeviceCode", () => {
  it("returns the code and a countdown for a complete answer", () => {
    const before = Date.now();
    const pending = pendingFromDeviceCode({
      userCode: "ABCD1234",
      verificationUri: "https://microsoft.com/link",
      expiresIn: 900,
      message: "To sign in, use a web browser…",
    });

    expect(pending).not.toBeNull();
    expect(pending?.code).toBe("ABCD1234");
    expect(pending?.url).toBe("https://microsoft.com/link");
    const expiresAt = Date.parse(pending!.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 900_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 900_000);
  });

  it("returns null for the rejected-request shape MSAL actually passes", () => {
    expect(
      pendingFromDeviceCode({
        userCode: undefined,
        verificationUri: undefined,
        expiresIn: undefined,
        message: undefined,
      }),
    ).toBeNull();
    expect(pendingFromDeviceCode(null)).toBeNull();
    expect(pendingFromDeviceCode(undefined)).toBeNull();
  });

  it("rejects a response whose lifetime is missing, zero or not a number", () => {
    const base = { userCode: "ABCD1234", verificationUri: "https://microsoft.com/link" };
    expect(pendingFromDeviceCode({ ...base })).toBeNull();
    expect(pendingFromDeviceCode({ ...base, expiresIn: 0 })).toBeNull();
    expect(pendingFromDeviceCode({ ...base, expiresIn: -60 })).toBeNull();
    expect(pendingFromDeviceCode({ ...base, expiresIn: Number.NaN })).toBeNull();
  });

  it("accepts a lifetime the endpoint sent as a numeric string", () => {
    // `expires_in` is a JSON number in the protocol, but a proxy or a test
    // double can quote it; refusing a usable answer would be worse than
    // coercing it.
    const pending = pendingFromDeviceCode({
      userCode: "ABCD1234",
      verificationUri: "https://microsoft.com/link",
      expiresIn: "900" as unknown as number,
    });
    expect(pending?.code).toBe("ABCD1234");
  });
});
