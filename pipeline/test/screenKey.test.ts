/**
 * The passphrase funnel — the contract every surface has to honour.
 *
 * The pinned vector at the bottom is the point of this file. The phone will
 * implement the same two steps in JavaScript (WebCrypto for AES-GCM, a JS scrypt
 * for the KDF), and nothing in this repo can stop the two implementations from
 * drifting apart. A fixed passphrase and a fixed salt with a fixed expected key
 * can: if the phone derives `bd4f…` where this derives something else, the test
 * vector says which one moved.
 */
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";import {
  MAX_PASSPHRASE_CHARS,
  MIN_PASSPHRASE_CHARS,
  deriveKey,
  keyFingerprint,
  normalizePassphrase,
  passphraseProblem,
} from "../src/screenKey.js";
import { ScreenError, isScreenError } from "../src/screenErrors.js";
import {
  decryptScreenCaptions,
  encryptScreenCaptions,
  emptyScreenCaptions,
} from "../src/screenCaptions.js";

const KDF = { N: 1 << 15, r: 8, p: 1 };

describe("normalizePassphrase", () => {
  it("trims the edges — the only silent change", () => {
    expect(normalizePassphrase("  correct horse battery  ")).toBe("correct horse battery");
  });

  it("removes invisible characters instead of refusing them", () => {
    // A zero-width space pasted out of a web page, a BOM, and a bidi mark: each
    // is untypeable, so rejecting would leave a passphrase nobody can reproduce.
    expect(normalizePassphrase("pass\u200bword\u2060with\ufeffmarks")).toBe("passwordwithmarks");
    expect(normalizePassphrase("pass\u202eword")).toBe("password");
  });

  it("composes characters, so NFC and NFD type the same key", () => {
    const composed = "café passphrase";                 // é as one code point
    const decomposed = "cafe\u0301 passphrase";         // e + combining acute
    expect(composed).not.toBe(decomposed);
    expect(normalizePassphrase(composed)).toBe(normalizePassphrase(decomposed));
  });

  it("keeps everything a person can see, including case and inner spaces", () => {
    const value = "  Mixed CASE  with  spaces and 表情🙂 !!  ";
    expect(normalizePassphrase(value)).toBe("Mixed CASE  with  spaces and 表情🙂 !!");
    // No case folding, no collapsing: both would shrink the space of secrets.
    expect(normalizePassphrase("AbC")).not.toBe(normalizePassphrase("abc"));
    expect(normalizePassphrase("a  b")).not.toBe(normalizePassphrase("a b"));
  });
});

describe("passphraseProblem", () => {
  it("refuses what is too short, too long, or nothing but invisibles", () => {
    expect(passphraseProblem("short")?.code).toBe("passphrase-too-short");
    expect(passphraseProblem("short")?.params).toEqual({ min: MIN_PASSPHRASE_CHARS });
    expect(passphraseProblem("              ")?.code).toBe("passphrase-too-short");
    expect(passphraseProblem("\u200b\u200b\u200b\u200b\u200b\u200b\u200b\u200b\u200b\u200b\u200b\u200b")?.code).toBe("passphrase-too-short");
    expect(passphraseProblem("x".repeat(MAX_PASSPHRASE_CHARS + 1))?.code).toBe("passphrase-too-long");
    expect(passphraseProblem("x".repeat(MAX_PASSPHRASE_CHARS + 1))?.params).toEqual({ max: MAX_PASSPHRASE_CHARS });
    expect(passphraseProblem("xv9Kp2mQ4wZr")).toBeNull();
    // A single character repeated is long enough and still hopeless, so it is
    // caught by the same rule as the dictionary words rather than by length.
    expect(passphraseProblem("x".repeat(MIN_PASSPHRASE_CHARS))?.code).toBe("passphrase-too-common");
  });

  it("catches the passphrases a form asking for 12 characters produces", () => {
    // Everything here is long enough; length is not what is wrong with it.
    for (const value of ["password1234", "123456789012", "qwertyuiop12", "Welcome123456", "aaaaaaaaaaaa"]) {
      expect(passphraseProblem(value)?.code, value).toBe("passphrase-too-common");
    }
  });

  it("recognises the famous one by name, and does not call it weak", () => {
    expect(passphraseProblem("correct horse battery staple")?.code).toBe("passphrase-too-famous");
    // It is long, so nothing else would have caught it; the message is a
    // compliment with a suggestion, not a rejection on strength.
    expect(passphraseProblem("correct horse battery staple")?.message).toMatch(/good shape/);
  });

  it("names the failure so a client can word it in its own language", () => {
    // The code travels with the sentence: the app renders Chinese, the server
    // only knows English, and the numbers have to survive the trip.
    expect(passphraseProblem("short")).toBeInstanceOf(ScreenError);
    expect(isScreenError(passphraseProblem("short"))).toBe(true);
  });
});

describe("deriveKey + fingerprint", () => {
  it("is stable for one passphrase and salt, and changes with either", () => {
    const salt = Buffer.alloc(16, 7);
    const a = deriveKey("a passphrase here", salt, KDF);
    const b = deriveKey("a passphrase here", salt, KDF);
    const c = deriveKey("a different one here", salt, KDF);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    expect(a.length).toBe(32);
  });

  it("derives the same key from the messy variant of a passphrase", () => {
    const salt = Buffer.alloc(16, 9);
    const messy = "\u200b  proud  bathtub  nine  \u2060";
    expect(deriveKey(messy, salt, KDF).equals(deriveKey("proud  bathtub  nine", salt, KDF))).toBe(true);
  });
});

/**
 * The cross-implementation vector. The phone's JavaScript must produce exactly
 * this key from exactly this passphrase and salt, and the same fingerprint.
 */
describe("the shared vector (the phone must match this)", () => {
  const SALT_B64 = "AAECAwQFBgcICQoLDA0ODw==";
  const PASSPHRASE = "correct horse battery staple";
  const EXPECTED_KEY_HEX = "7a8e34241db898d59175c696538c417467a975ffe569068425f16188d3159c58";
  const EXPECTED_FP = "EF44-4715";

  it("derives the pinned key", () => {
    const key = deriveKey(PASSPHRASE, Buffer.from(SALT_B64, "base64"), KDF);
    expect(key.toString("hex")).toBe(EXPECTED_KEY_HEX);
  });

  it("names it with the pinned fingerprint", () => {
    const key = deriveKey(PASSPHRASE, Buffer.from(SALT_B64, "base64"), KDF);
    expect(keyFingerprint(key)).toBe(EXPECTED_FP);
  });
});

describe("the envelope", () => {
  it("round-trips, and names the key it wants", () => {
    const file = emptyScreenCaptions();
    file.entries["2EDA5BB960073185!50970"] = {
      caption: "A screenshot of a chat conversation.",
      tags: ["chat"],
      model: "lmstudio",
      at: "2026-10-14T00:00:00.000Z",
    };
    const envelope = encryptScreenCaptions(file, "a good long passphrase");
    expect(envelope.fp).toBe(keyFingerprint(deriveKey("a good long passphrase", Buffer.from(envelope.kdf.salt, "base64"), KDF)));
    expect(decryptScreenCaptions(envelope, "a good long passphrase")).toEqual(file);
  });

  it("says 'wrong passphrase' rather than 'damaged' when it can tell", () => {
    const envelope = encryptScreenCaptions(emptyScreenCaptions(), "a good long passphrase");
    expect(() => decryptScreenCaptions(envelope, "a different long one")).toThrow(/is not the one/);
  });

  it("still opens an envelope written before fingerprints existed", () => {
    const envelope = encryptScreenCaptions(emptyScreenCaptions(), "a good long passphrase");
    delete envelope.fp;
    expect(() => decryptScreenCaptions(envelope, "a good long passphrase")).not.toThrow();
    expect(() => decryptScreenCaptions(envelope, "another long passphrase")).toThrow(/Could not decrypt/);
  });

  it("does not care how messy the passphrase was at either end", () => {
    const envelope = encryptScreenCaptions(emptyScreenCaptions(), " typed with spaces \u200b");
    expect(() => decryptScreenCaptions(envelope, "typed with spaces")).not.toThrow();
    expect(() => decryptScreenCaptions(envelope, "  typed  with  spaces  ")).toThrow();
  });

  it("carries no readable content", () => {
    const file = emptyScreenCaptions();
    file.entries["x"] = { caption: "A photographed ID card.", tags: ["id-card"], model: "lmstudio", at: "2026-10-14T00:00:00.000Z" };
    const raw = JSON.stringify(encryptScreenCaptions(file, "a good long passphrase"));
    expect(raw).not.toContain("ID card");
    expect(raw).not.toContain("id-card");
    expect(raw).not.toContain("2EDA");
    expect(raw).not.toContain("a good long passphrase");
  });

  it("fails loudly on a flipped byte", () => {
    const envelope = encryptScreenCaptions(emptyScreenCaptions(), "a good long passphrase");
    const ct = Buffer.from(envelope.ct, "base64");
    ct[10] ^= 0x01;
    envelope.ct = ct.toString("base64");
    expect(() => decryptScreenCaptions(envelope, "a good long passphrase")).toThrow(/Could not decrypt/);
  });
});

describe("a random salt per write", () => {
  it("never writes the same ciphertext twice", () => {
    const a = encryptScreenCaptions(emptyScreenCaptions(), "a good long passphrase");
    const b = encryptScreenCaptions(emptyScreenCaptions(), "a good long passphrase");
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.ct).not.toBe(b.ct);
    expect(randomBytes(4).length).toBe(4);
  });
});
