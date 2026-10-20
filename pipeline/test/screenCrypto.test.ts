/**
 * The other end of the contract: the reader's decryption against the
 * server's encryption.
 *
 * The descriptions are written by the pipeline (Node's crypto) and opened by
 * the app (WebCrypto plus a JavaScript scrypt). Two implementations of the
 * same envelope, in two languages, with nothing in the repo able to stop them
 * drifting apart — and the failure mode is the worst kind: "this is not the
 * passphrase that wrote it", for a passphrase that is right.
 *
 * So this file pins the two together:
 *
 *  - the **key vector** already in `screenKey.test.ts` — a passphrase, a salt
 *    and the key they must produce. The reader has to derive that exact key,
 *    or every description in the archive is unreadable on the phone.
 *  - the **envelope**: one the pipeline writes, opened by the reader, and the
 *    other way round, so the associated data and the tag order cannot drift.
 *  - the **passphrase funnel**: the reader normalises exactly as the server
 *    does, because a passphrase that differs by one invisible character is a
 *    different passphrase.
 */
import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import {
  decryptScreenCaptions as decryptOnServer,
  encryptScreenCaptions as encryptOnServer,
  emptyScreenCaptions,
} from "../src/screenCaptions.js";
import {
  deriveKey as deriveKeyOnServer,
  keyFingerprint as fingerprintOnServer,
  normalizePassphrase as normalizeOnServer,
} from "../src/screenKey.js";
import {
  decryptScreenCaptions as decryptOnReader,
  deriveKey as deriveKeyOnReader,
  keyFingerprint as fingerprintOnReader,
  normalizePassphrase as normalizeOnReader,
  ScreenCryptoError,
} from "../../app/src/screenCrypto";

const KDF = { N: 1 << 15, r: 8, p: 1 };

/** The same vector the server's own test pins — see `screenKey.test.ts`. */
const SALT_B64 = "AAECAwQFBgcICQoLDA0ODw==";
const PASSPHRASE = "correct horse battery staple";
const EXPECTED_KEY_HEX = "7a8e34241db898d59175c696538c417467a975ffe569068425f16188d3159c58";
const EXPECTED_FP = "EF44-4715";

describe("the reader derives the key the server derives", () => {
  it("matches the pinned vector, byte for byte", async () => {
    const key = await deriveKeyOnReader(PASSPHRASE, new Uint8Array(Buffer.from(SALT_B64, "base64")), KDF);
    expect(Buffer.from(key).toString("hex")).toBe(EXPECTED_KEY_HEX);
  });

  it("names it with the same fingerprint, so the two can compare", async () => {
    const key = await deriveKeyOnReader(PASSPHRASE, new Uint8Array(Buffer.from(SALT_B64, "base64")), KDF);
    expect(await fingerprintOnReader(key)).toBe(EXPECTED_FP);
  });

  it("agrees with the server on a passphrase nobody can retype by eye", async () => {
    const salt = new Uint8Array(Buffer.alloc(16, 3));
    const messy = "  proud  bathtub  nine  ";
    const server = deriveKeyOnServer(messy, Buffer.from(salt), KDF);
    const reader = await deriveKeyOnReader(messy, salt, KDF);
    expect(Buffer.from(reader).toString("hex")).toBe(server.toString("hex"));
  });
});

describe("the passphrase funnel is the same on both sides", () => {
  const cases = [
    "  correct horse battery  ",
    "pass\u200bword\u2060with\ufeffmarks",
    "pass\u202eword",
    "café passphrase",
    "cafe\u0301 passphrase",
    "Mixed CASE  with  spaces",
  ];
  for (const value of cases) {
    it(`normalises ${JSON.stringify(value)} the same way`, () => {
      expect(normalizeOnReader(value)).toBe(normalizeOnServer(value));
    });
  }
});

describe("the reader opens what the server wrote", () => {
  it("reads a description written by the pipeline", async () => {
    const file = emptyScreenCaptions();
    file.entries["2EDA5BB960073185!50970"] = {
      caption: "A screenshot of a chat conversation.",
      tags: ["chat"],
      model: "lmstudio",
      at: "2026-10-14T00:00:00.000Z",
      date: "2026-03-02",
    };
    const envelope = encryptOnServer(file, "a good long passphrase");
    const opened = await decryptOnReader(envelope, "a good long passphrase");
    expect(opened.entries["2EDA5BB960073185!50970"].caption).toBe("A screenshot of a chat conversation.");
    expect(opened.entries["2EDA5BB960073185!50970"].tags).toEqual(["chat"]);
    expect(opened.entries["2EDA5BB960073185!50970"].date).toBe("2026-03-02");
  });

  it("opens an envelope whose passphrase was typed with invisible characters", async () => {
    const envelope = encryptOnServer(emptyScreenCaptions(), "typed with spaces");
    await expect(decryptOnReader(envelope, " typed with spaces \u200b")).resolves.toBeTruthy();
  });

  it("refuses a wrong passphrase by name, not as 'nothing described yet'", async () => {
    const envelope = encryptOnServer(emptyScreenCaptions(), "a good long passphrase");
    await expect(decryptOnReader(envelope, "a different long one")).rejects.toThrow(/not the one/);
    await expect(decryptOnReader(envelope, "a different long one")).rejects.toBeInstanceOf(ScreenCryptoError);
  });

  it("says 'damaged' rather than 'wrong passphrase' when it cannot tell", async () => {
    // An envelope written before the fingerprint existed: a wrong key and a
    // flipped byte look the same, and the honest answer is the cautious one.
    const envelope = encryptOnServer(emptyScreenCaptions(), "a good long passphrase");
    delete envelope.fp;
    await expect(decryptOnReader(envelope, "another long passphrase")).rejects.toThrow(/could not be decrypted/i);
  });

  it("refuses a tampered envelope", async () => {
    const envelope = encryptOnServer(emptyScreenCaptions(), "a good long passphrase");
    const bytes = Buffer.from(envelope.ct, "base64");
    bytes[0] ^= 0xff;
    await expect(decryptOnReader({ ...envelope, ct: bytes.toString("base64") }, "a good long passphrase")).rejects.toThrow(
      /could not be decrypted/i,
    );
  });
});

describe("the server still opens what the reader's key names", () => {
  it("agrees on the fingerprint, which is what the reader checks first", async () => {
    const envelope = encryptOnServer(emptyScreenCaptions(), "a good long passphrase");
    const salt = Buffer.from(envelope.kdf.salt, "base64");
    const serverKey = deriveKeyOnServer("a good long passphrase", salt, KDF);
    const readerKey = await deriveKeyOnReader("a good long passphrase", new Uint8Array(salt), KDF);
    expect(envelope.fp).toBe(fingerprintOnServer(serverKey));
    expect(envelope.fp).toBe(await fingerprintOnReader(readerKey));
  });

  it("and the server's own decrypt still round-trips", () => {
    const file = emptyScreenCaptions();
    file.entries["x"] = { caption: "A photographed ID card.", tags: ["id-card"], model: "lmstudio", at: "2026-10-14T00:00:00.000Z" };
    expect(decryptOnServer(encryptOnServer(file, "a good long passphrase"), "a good long passphrase")).toEqual(file);
  });
});
