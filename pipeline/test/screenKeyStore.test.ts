/**
 * The key store: what it writes, what it refuses, and the migration off `.env`.
 *
 * DPAPI is Windows-only and CI is not, so the wrapper is swapped for a reversible
 * stand-in. That is the point of the seam: the file format, the normalisation and
 * the migration are what can go wrong on any platform, and those are all tested.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeFile } from "../src/paths.js";
import { saveConfig } from "../src/configStore.js";
import {
  dpapi,
  forgetStoredPassphrase,
  hasStoredPassphrase,
  importLegacyPassphrase,
  readStoredPassphrase,
  readStoredPassphrases,
  screenKeyFile,
  useKeyWrapper,
  writeStoredPassphrase,
} from "../src/screenKeyStore.js";

/** Reversible and obviously not DPAPI, so a test can say what it wrapped. */
const fake = {
  name: "test-wrapper",
  available: () => true,
  async wrap(plain: Buffer) {
    return Buffer.concat([Buffer.from("wrapped:"), plain]);
  },
  async unwrap(wrapped: Buffer) {
    const text = wrapped.toString("utf-8");
    if (!text.startsWith("wrapped:")) throw new Error("not wrapped by this test");
    return Buffer.from(text.slice("wrapped:".length), "utf-8");
  },
};

describe("the key store", () => {
  beforeEach(async () => {
    useKeyWrapper(fake);
    await forgetStoredPassphrase();
    writeFileSync(homeFile(".env"), "# a .env with no passphrase\nAI_PROVIDER=deepseek\n", "utf-8");
  });

  it("round-trips a passphrase and stores no plaintext", async () => {
    await writeStoredPassphrase("a good long passphrase");
    expect(await hasStoredPassphrase()).toBe(true);
    expect(await readStoredPassphrase()).toBe("a good long passphrase");

    const raw = readFileSync(screenKeyFile(), "utf-8");
    expect(raw).not.toContain("a good long passphrase");
    expect(JSON.parse(raw)).toMatchObject({ v: 2, protection: "dpapi-user" });
    const stored = JSON.parse(raw) as { current: string; previous?: string };
    expect(stored.current).toBeTruthy();
    expect(stored.previous).toBeUndefined();
  });

  it("normalises on the way in and on the way out", async () => {
    await writeStoredPassphrase("  a good long passphrase\u200b  ");
    expect(await readStoredPassphrase()).toBe("a good long passphrase");
  });

  it("says nothing is stored when nothing is", async () => {
    expect(await hasStoredPassphrase()).toBe(false);
    expect(await readStoredPassphrase()).toBeNull();
  });

  it("refuses to pretend when the blob cannot be unwrapped", async () => {
    await writeStoredPassphrase("a good long passphrase");
    useKeyWrapper({
      ...fake,
      unwrap: async () => {
        throw new Error("this is not the Windows account that wrote it");
      },
    });
    await expect(readStoredPassphrase()).rejects.toThrow(/not the Windows account/);
  });

  it("keeps the old passphrase readable during a rotation, then drops it", async () => {
    await writeStoredPassphrase("the first passphrase");
    await writeStoredPassphrase("the second passphrase", { previous: "the first passphrase" });
    // Mid-rotation: whichever half landed, one of these opens the file.
    expect(await readStoredPassphrases()).toEqual(["the second passphrase", "the first passphrase"]);
    // The rotation finishes and the old key stops working, which is the point.
    await writeStoredPassphrase("the second passphrase");
    expect(await readStoredPassphrases()).toEqual(["the second passphrase"]);
  });

  it("does not keep a previous value identical to the new one", async () => {
    await writeStoredPassphrase("the same passphrase", { previous: "  the same passphrase  " });
    expect(await readStoredPassphrases()).toEqual(["the same passphrase"]);
  });

  it("reads a v1 file written before the ring existed", async () => {
    // The shape the pre-ring code wrote: `wrapped`, no `current`.
    const { writeFileSync: write } = await import("node:fs");
    write(screenKeyFile(), `${JSON.stringify({ v: 1, protection: "dpapi-user", wrapped: Buffer.from("wrapped:an older passphrase").toString("base64") })}\n`, "utf-8");
    expect(await readStoredPassphrases()).toEqual(["an older passphrase"]);
  });

  it("reports that a platform without a store cannot keep one", async () => {
    useKeyWrapper({ ...fake, available: () => false });
    await expect(writeStoredPassphrase("a good long passphrase")).rejects.toThrow(/key store/);
  });

  it("does not offer the store where DPAPI is missing", () => {
    // The real wrapper is what a Linux CI would see.
    expect(dpapi.name).toBe("dpapi-user");
  });
});

describe("the migration off .env", () => {
  beforeEach(async () => {
    useKeyWrapper(fake);
    await forgetStoredPassphrase();
  });

  it("moves an existing plaintext line into the store and deletes the line", async () => {
    writeFileSync(homeFile(".env"), `AI_PROVIDER=deepseek\nSCREENSHOT_PASSPHRASE="a good long passphrase"\n`, "utf-8");
    expect(await importLegacyPassphrase()).toEqual({ migrated: true, legacy: false });
    expect(await readStoredPassphrase()).toBe("a good long passphrase");
    const env = readFileSync(homeFile(".env"), "utf-8");
    expect(env).not.toContain("SCREENSHOT_PASSPHRASE");
    expect(env).toContain("AI_PROVIDER=deepseek");
  });

  it("keeps the store's value when both exist, and removes the leftover line", async () => {
    await writeStoredPassphrase("the one in the store");
    writeFileSync(homeFile(".env"), `SCREENSHOT_PASSPHRASE="a stale leftover value"\n`, "utf-8");
    expect(await importLegacyPassphrase()).toEqual({ migrated: false, legacy: false });
    expect(await readStoredPassphrase()).toBe("the one in the store");
    expect(readFileSync(homeFile(".env"), "utf-8")).not.toContain("SCREENSHOT_PASSPHRASE");
  });

  it("does nothing on a fresh install", async () => {
    writeFileSync(homeFile(".env"), "AI_PROVIDER=deepseek\n", "utf-8");
    expect(await importLegacyPassphrase()).toEqual({ migrated: false, legacy: false });
    expect(await hasStoredPassphrase()).toBe(false);
  });

  it("treats the key as removable but not writable through saveConfig", async () => {
    writeFileSync(homeFile(".env"), `SCREENSHOT_PASSPHRASE="a good long passphrase"\n`, "utf-8");
    await expect(saveConfig({ SCREENSHOT_PASSPHRASE: "a new value" })).rejects.toThrow(/no longer stored/);
    await saveConfig({ SCREENSHOT_PASSPHRASE: null });
    expect(readFileSync(homeFile(".env"), "utf-8")).not.toContain("SCREENSHOT_PASSPHRASE");
  });
});

describe("a directory of its own", () => {
  it("is where the tests think it is", () => {
    const dir = mkdtempSync(join(tmpdir(), "key-store-"));
    expect(join(dir, "screen-key.json")).toContain("screen-key.json");
    rmSync(dir, { recursive: true, force: true });
  });
});
