/**
 * The phone's key store for the screenshot passphrase.
 *
 * `app/src/screenKey.ts` asks for a `ScreenKeyBridge`; the desktop shell answers
 * with Electron's `safeStorage`. On the installed app there is no
 * `window.electronAPI`, so this supplies the third surface the file has been
 * waiting for: `android/.../ScreenKeyPlugin.java`, which keeps an AES-GCM key
 * inside the Android Keystore and only ever writes ciphertext to disk.
 *
 * Loaded lazily, because `screenKey.ts` is shared with the browser and the
 * desktop, and this module's only job is to exist on a phone.
 */

/** Capacitor's own shape, which `screenKey.ts` does not otherwise need. */
interface NativeScreenKeyPlugin {
  available(): Promise<{ available: boolean }>;
  set(options: { value: string }): Promise<{ ok: boolean }>;
  get(): Promise<{ value: string | null }>;
  forget(): Promise<void>;
}

/**
 * Whether this page is running inside the installed app rather than a browser.
 *
 * Re-exported from `surface.ts`, which the share path reads too: one definition,
 * because a second copy is how these drift.
 */
import { isPhoneSurface } from "./surface";
export { isPhoneSurface };

let cached: ScreenKeyBridge | null | undefined;

/** The bridge, or null on a surface with no key store. Cheap after the first call. */
export async function nativeScreenKey(): Promise<ScreenKeyBridge | null> {
  if (cached !== undefined) return cached;
  if (!isPhoneSurface) {
    cached = null;
    return cached;
  }
  try {
    const { registerPlugin } = await import("@capacitor/core");
    const plugin = registerPlugin<NativeScreenKeyPlugin>("ScreenKey");
    cached = {
      available: () => plugin.available().then((r) => r.available === true).catch(() => false),
      get: () => plugin.get().then((r) => r.value ?? null).catch(() => null),
      set: (passphrase: string) => plugin.set({ value: passphrase }).then((r) => r.ok === true).catch(() => false),
      forget: async () => {
        await plugin.forget().catch(() => {});
      },
    };
  } catch {
    cached = null;
  }
  return cached;
}
