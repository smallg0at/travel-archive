import { afterEach, describe, expect, it } from "vitest";
import type { PhotoRecord } from "@travel-archive/shared";
import { env } from "../src/env.js";
import { screenProviderId, screenTargets } from "../src/jobs/screenCaptions.js";
import {
  decryptScreenCaptions,
  encryptScreenCaptions,
  emptyScreenCaptions,
  screenCaptionsFile,
} from "../src/screenCaptions.js";

/**
 * The local screenshot pass exists so that the photographs nobody has vouched
 * for can be described without leaving this machine — and, since the descriptions
 * do travel with the archive, so that the copy on OneDrive is unreadable. Four
 * things can go wrong quietly and none of them shows up in a type:
 *
 *  - a cloud provider id, which would upload exactly those screenshots;
 *  - a filter that lets an allowlisted photo (or an already-described one)
 *    through, which is cost and, in the first case, the point inverted;
 *  - a description stored in the clear, in a file that syncs;
 *  - a wrong passphrase reading as "nothing described yet", which would silently
 *    start over on hours of work.
 *
 * The first two are tested here and the last two below.
 */

const ORIGINAL = env.screenshotProvider;
afterEach(() => {
  env.screenshotProvider = ORIGINAL;
});

/** A camera photo: the gate reads `screenshot: null` as "an AI pass may look". */
const camera = (id: string, over: Partial<PhotoRecord> = {}): PhotoRecord =>
  ({ id, fileName: `IMG_${id}.jpg`, takenAt: "2026-01-01T10:00:00.000Z", screenshot: null, ...over }) as PhotoRecord;

/** A screen that was photographed and nobody has vouched for: what this pass is for. */
const withheld = (id: string, takenAt = "2026-01-01T10:00:00.000Z"): PhotoRecord =>
  ({
    id,
    fileName: `Screenshot_${id}_com.tencent.mm.jpg`,
    takenAt,
    screenshot: { sourceApp: "com.tencent.mm", analyzable: false },
  }) as PhotoRecord;

/** A screenshot the allowlist admits (a rail app): the ordinary caption pass takes it. */
const allowed = (id: string): PhotoRecord =>
  ({
    id,
    fileName: `Screenshot_${id}_ch.sbb.mobile.android.b2c.jpg`,
    takenAt: "2026-01-01T10:00:00.000Z",
    screenshot: { sourceApp: "ch.sbb.mobile.android.b2c", analyzable: true },
  }) as PhotoRecord;

describe("which provider may describe screenshots", () => {
  it("refuses to run with nothing configured, and says what to set", () => {
    expect(() => screenProviderId("")).toThrow(/SCREENSHOT_PROVIDER/);
    expect(() => screenProviderId(undefined)).toThrow(/SCREENSHOT_PROVIDER/);
  });

  it("refuses a cloud service out loud rather than sending the screens", () => {
    for (const id of ["gemini", "deepseek", "openrouter"]) {
      expect(() => screenProviderId(id), id).toThrow(/local|cloud/i);
    }
  });

  it("accepts a service on this machine", () => {
    for (const id of ["lmstudio", "ollama"]) {
      expect(screenProviderId(id)).toBe(id);
    }
  });

  it("names an unknown id as unknown rather than as a cloud service", () => {
    expect(() => screenProviderId("openai")).toThrow(/Unknown SCREENSHOT_PROVIDER/);
  });
});

describe("which screenshots a run describes", () => {
  it("takes the withheld ones, not the allowlisted ones", () => {
    // A camera photo passes the gate and is the caption pass's business; a rail
    // app screenshot is admitted by the allowlist and goes the same way. Only a
    // screen nobody vouched for is this pass's.
    const targets = screenTargets([camera("0001"), allowed("sbb"), withheld("wechat")], {});
    expect(targets.map((p) => p.id)).toEqual(["wechat"]);
  });

  it("skips what has already been described, so a resume costs nothing", () => {
    expect(screenTargets([withheld("wechat")], {})).toHaveLength(1);
    expect(screenTargets([withheld("wechat")], { wechat: { caption: "a chat conversation" } })).toHaveLength(0);
  });

  it("goes oldest first, because a run may stop before it finishes", () => {
    const targets = screenTargets([withheld("newer", "2026-01-01T00:00:00.000Z"), withheld("older", "2020-01-01T00:00:00.000Z")], {});
    expect(targets.map((p) => p.id)).toEqual(["older", "newer"]);
  });
});

describe("where a description is kept", () => {
  it("is the mirrored metadata tree, because it syncs with everything else", () => {
    // The first design kept this local-only; a file that exists on one computer
    // and is lost with it is a second data path to maintain. It syncs now.
    expect(screenCaptionsFile()).toMatch(/screen-captions\.enc$/);
    expect(screenCaptionsFile()).toMatch(/[\\/]data[\\/]/);
  });

  it("carries nothing readable in the uploaded envelope", () => {
    const file = emptyScreenCaptions();
    file.entries["photo-1"] = {
      caption: "a photographed ID card",
      tags: ["id-card"],
      model: "lmstudio",
      at: "2026-10-13T00:00:00.000Z",
    };
    const envelope = encryptScreenCaptions(file, "correct horse battery staple");
    const uploaded = JSON.stringify(envelope);
    // The one thing that must never be true of a file on OneDrive.
    expect(uploaded).not.toContain("ID card");
    expect(uploaded).not.toContain("id-card");
    expect(uploaded).not.toContain("photo-1");
    expect(uploaded).not.toContain("correct horse");
  });

  it("round-trips with the same passphrase", () => {
    const file = emptyScreenCaptions();
    file.entries["photo-1"] = { caption: "a chat conversation", tags: ["chat"], model: "lmstudio", at: "2026-10-13T00:00:00.000Z" };
    const back = decryptScreenCaptions(encryptScreenCaptions(file, "hunter2"), "hunter2");
    expect(back.entries["photo-1"].caption).toBe("a chat conversation");
    expect(back.entries["photo-1"].tags).toEqual(["chat"]);
  });

  it("refuses a wrong passphrase instead of reading as empty", () => {
    // Silently starting over would look exactly like a fresh archive and would
    // throw away hours of work, so this has to be the loud failure.
    const envelope = encryptScreenCaptions(emptyScreenCaptions(), "right");
    expect(() => decryptScreenCaptions(envelope, "wrong")).toThrow(/different SCREENSHOT_PASSPHRASE/);
  });

  it("refuses a tampered envelope", () => {
    const envelope = encryptScreenCaptions(emptyScreenCaptions(), "right");
    const bytes = Buffer.from(envelope.ct, "base64");
    bytes[0] ^= 0xff;
    expect(() => decryptScreenCaptions({ ...envelope, ct: bytes.toString("base64") }, "right")).toThrow(/damaged/);
  });

  it("uses a fresh salt and nonce for every save", () => {
    // A reused nonce under one key is the one way GCM fails completely.
    const file = emptyScreenCaptions();
    const a = encryptScreenCaptions(file, "same");
    const b = encryptScreenCaptions(file, "same");
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });
});
