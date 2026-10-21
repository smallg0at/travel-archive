/**
 * Where the passphrase lives, per surface.
 *
 * The passphrase is the only thing standing between the archive's copy of the
 * screenshot descriptions and anyone who has that copy, so it is never written
 * anywhere a reader could read it back: not in `localStorage`, not in the
 * archive, not in a cookie.
 *
 * Two places, and they are not the same thing:
 *
 *  - **This session.** The page holds it in memory. It is gone when the tab
 *    closes, and it cannot be read off the disk — which is what a browser and
 *    the phone have, and what they get whether or not anybody ticks a box.
 *  - **This machine.** The desktop shell's `safeStorage`, which encrypts with
 *    DPAPI: the value is bound to this Windows account on this machine, so
 *    another program, another disk or another user cannot unwrap it. It
 *    survives a restart, which is the whole point of asking for it.
 *
 * So the reader asks "keep it here", "keep it on this computer", "give it
 * back", "forget it" — and the surface decides what it can do. The phone will
 * grow a third place (a Keystore plugin); this file is where that lands, and
 * it is one more surface rather than a second mechanism.
 */

/** The passphrase this session is holding. */
let session: string | null = null;

/** The shell's key store, when there is one. */
function bridge(): ScreenKeyBridge | undefined {
  return window.electronAPI?.screenKey;
}

/**
 * Whether the passphrase can be kept past this session.
 *
 * `safeStorage` can be present and still refuse — a Linux box without a
 * keyring, a Windows account without a profile. The bridge answers, so the
 * form can offer "remember on this computer" only when remembering will work.
 */
export async function screenKeyCanPersist(): Promise<boolean> {
  const store = bridge();
  if (!store) return false;
  return store.available();
}

/**
 * Keep the passphrase.
 *
 * **Always for this session**, because that is what keeps the descriptions
 * open: a page that re-reads the file — a search, a reload of a month — must
 * not have to ask again, and must not drop what it had already opened.
 *
 * `persist` asks for more: the shell's key store, so it survives a restart. A
 * browser has no such store, so it never offers the choice — and the session's
 * copy is what it keeps.
 */
export async function rememberScreenKey(passphrase: string, persist = false): Promise<void> {
  session = passphrase;
  if (!persist) return;
  const store = bridge();
  if (!store) return;
  const ok = await store.set(passphrase);
  if (!ok) throw new Error("This shell's key store is not available.");
}

/**
 * The passphrase, from this session or from the shell's key store.
 *
 * The session's copy comes first: it is the one the reader just typed, and it
 * is the one the descriptions in hand were opened with.
 */
export async function recallScreenKey(): Promise<string | null> {
  if (session) return session;
  const store = bridge();
  return (await store?.get()) ?? null;
}

/**
 * Let it go.
 *
 * Both copies: the session's, and the shell's. A reader who says "forget it"
 * means it on this machine, not only until the tab closes.
 */
export async function forgetScreenKey(): Promise<void> {
  session = null;
  await bridge()?.forget();
}
