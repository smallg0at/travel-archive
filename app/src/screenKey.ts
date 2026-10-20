/**
 * Where the passphrase lives, per surface.
 *
 * The passphrase is the only thing standing between the archive's copy of the
 * screenshot descriptions and anyone who has that copy, so it is never written
 * anywhere a reader could read it back: not in `localStorage`, not in the
 * archive, not in a cookie. What each surface can offer is different, and the
 * abstraction is written so that *the difference is the surface's business* —
 * the reader asks "remember this", "give it back", "forget it" and does not
 * care where it went.
 *
 * | surface | can keep it | where |
 * |---|---|---|
 * | the desktop shell | yes | Electron's `safeStorage` (DPAPI: per Windows user, per machine, not exportable) |
 * | a browser on localhost | no | this session's memory, and gone when the tab closes |
 * | the phone | no | the same, until the app is closed |
 * | a browser on the home network | no | it cannot decrypt at all — WebCrypto needs a secure context |
 *
 * The phone is the one that will want a key store later (a Keystore plugin),
 * and this file is where that lands: one more surface, not a second mechanism.
 */

/** What a surface can do with the passphrase. */
export interface ScreenKeySurface {
  /** Whether this surface can keep the passphrase past this session. */
  readonly persistent: boolean;
  /** Why it cannot, when it cannot — the reason a reader is told. */
  readonly reason: string | null;
  /** Keep the passphrase. Rejects when this surface cannot. */
  remember(passphrase: string): Promise<void>;
  /** The passphrase, or null when this surface holds none. */
  recall(): Promise<string | null>;
  /** Let it go. */
  forget(): Promise<void>;
}

/**
 * The session's memory.
 *
 * The honest floor: a passphrase that lives only in the running page cannot be
 * read off the disk, cannot be picked up by another program, and is gone when
 * the tab is closed. It is what a browser and the phone have until they are
 * given a key store.
 */
const memory = { value: null as string | null };

const memorySurface: ScreenKeySurface = {
  persistent: false,
  reason: "kept for this session only",
  async remember(passphrase: string) {
    memory.value = passphrase;
  },
  async recall() {
    return memory.value;
  },
  async forget() {
    memory.value = null;
  },
};

/**
 * The desktop shell's key store.
 *
 * `safeStorage` encrypts with DPAPI, which binds the value to this Windows
 * account on this machine: another user, another machine, or a copied file
 * cannot unwrap it. That is the same protection the job server's own key store
 * gives the passphrase it writes with, and it is the reason the desktop can
 * keep the passphrase at all while a browser cannot.
 */
const electronSurface: ScreenKeySurface = {
  persistent: true,
  reason: null,
  async remember(passphrase: string) {
    const bridge = window.electronAPI?.screenKey;
    if (!bridge) throw new Error("This shell has no key store.");
    const ok = await bridge.set(passphrase);
    if (!ok) throw new Error("This shell's key store is not available.");
  },
  async recall() {
    return (await window.electronAPI?.screenKey?.get()) ?? null;
  },
  async forget() {
    await window.electronAPI?.screenKey?.forget();
  },
};

/**
 * The surface this page is running on.
 *
 * The bridge is the test: the desktop shell's preload exposes it, and nothing
 * else does. A browser that happens to serve the same page has no bridge and
 * gets the session's memory.
 */
export function screenKeySurface(): ScreenKeySurface {
  return window.electronAPI?.screenKey ? electronSurface : memorySurface;
}

/**
 * Whether the shell's key store is actually usable.
 *
 * `safeStorage` can be present and still refuse — a Linux box without a
 * keyring, a Windows account without a profile. The bridge answers, so the
 * form can offer "remember" only when remembering will work.
 */
export async function screenKeyCanPersist(): Promise<boolean> {
  const bridge = window.electronAPI?.screenKey;
  if (!bridge) return false;
  return bridge.available();
}

/** Whether this page holds a passphrase at all. */
export async function hasScreenKey(): Promise<boolean> {
  return (await screenKeySurface().recall()) !== null;
}
