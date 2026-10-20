/**
 * Reading the encrypted screenshot descriptions, in the reader.
 *
 * The file itself is written by the job server (`pipeline/src/screenCaptions.ts`)
 * and travels with the archive. What this module does is the other half of
 * that: fetch the sealed envelope, open it with a passphrase this surface
 * holds, and hand the descriptions to the pages that can show them.
 *
 * Four rules shape it:
 *
 *  - **The plaintext never crosses a network.** The envelope is ciphertext and
 *    stays that way until it is open in this page. That is why there is no
 *    server-side decrypt on the read path: a server that handed out readable
 *    descriptions would make "who can read these" a question about the
 *    server's reach rather than about the passphrase.
 *  - **A missing passphrase is a state, not a failure.** The page shows the
 *    photographs and says the descriptions are locked; it never asks for a
 *    passphrase in the middle of reading something else.
 *  - **A wrong passphrase is loud.** It says "this is not the passphrase that
 *    wrote it" and names the key it wanted, because the alternative — reading
 *    as "nothing described yet" — invites a re-run that would destroy the
 *    hours of work already done.
 *  - **A passphrase is only kept once it has opened something.** The check
 *    comes before the store, so a mistyped passphrase never replaces a good
 *    one.
 */
import { loadMetadataFile } from "./archiveData";
import {
  cryptoAvailable,
  decryptScreenCaptions,
  passphraseProblem,
  ScreenCryptoError,
  type ScreenCaptionEntry,
  type ScreenCaptionsEnvelope,
} from "./screenCrypto";
import { screenKeySurface } from "./screenKey";
import { ui } from "./i18n";

/**
 * A failure from the passphrase side, in this reader's language.
 *
 * The server sends a code and its parameters; the app turns the name into a
 * sentence — the same division the job phases use, and for the same reason: a
 * sentence with numbers baked into it cannot be translated, but a code with
 * parameters can. The codes are shared with the server's own
 * (`pipeline/src/screenErrors.ts`), because the same thing can go wrong on
 * either side of the wire and the reader should not have to care which.
 *
 * An unknown code — a newer server than this page — falls back to the text
 * that came with it, so the answer is never blank.
 */
export function screenErrorText(failure: { error: string; code?: string; params?: Record<string, string | number> }): string {
  const p = failure.params ?? {};
  switch (failure.code) {
    case "passphrase-too-short":
      return ui.generate.screensErr.tooShort(Number(p.min ?? 12));
    case "passphrase-too-long":
      return ui.generate.screensErr.tooLong(Number(p.max ?? 256));
    case "passphrase-too-common":
      return ui.generate.screensErr.tooCommon;
    case "passphrase-too-famous":
      return ui.generate.screensErr.tooFamous;
    case "passphrase-mismatch":
      return ui.generate.screensErr.mismatch(String(p.wants ?? "?"), String(p.derives ?? "?"));
    case "descriptions-damaged":
      return ui.generate.screensErr.damaged;
    case "no-passphrase":
      return ui.generate.screensErr.noPassphrase;
    case "no-crypto":
      return ui.generate.screensNoCrypto;
    case "key-store-unavailable":
      return ui.generate.screensNoKeyStore;
    case "key-store-unreadable":
      return ui.generate.screensErr.keyStoreUnreadable(String(p.reason ?? ""));
    default:
      return failure.error;
  }
}

/** The file the archive keeps them in. */
export const SCREEN_CAPTIONS_FILE = "screen-captions.enc";

/**
 * What the reader knows about the descriptions, right now.
 *
 * `locked` and `unavailable` are the two that are not errors: one means the
 * passphrase is not here, the other that this origin cannot decrypt at all.
 */
export type ScreenCaptionsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; entries: Record<string, ScreenCaptionEntry> }
  | { status: "locked" }
  | { status: "unavailable" }
  | { status: "failed"; error: ScreenCryptoError };

let state: ScreenCaptionsState = { status: "idle" };
let pending: Promise<ScreenCaptionsState> | null = null;
/** The sealed file, once fetched. Ciphertext, so keeping it costs nothing. */
let envelope: ScreenCaptionsEnvelope | null | undefined;
const listeners = new Set<(state: ScreenCaptionsState) => void>();

function setState(next: ScreenCaptionsState): void {
  state = next;
  for (const listener of listeners) listener(next);
}

/** Told whenever the state changes — a page that is already drawn can fill itself in. */
export function onScreenCaptions(listener: (state: ScreenCaptionsState) => void): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

/** The state as it stands. */
export function screenCaptionsState(): ScreenCaptionsState {
  return state;
}

/** The descriptions, when they are open. */
export function screenCaptionsEntries(): Record<string, ScreenCaptionEntry> | null {
  return state.status === "ready" ? state.entries : null;
}

/** One photograph's description, or null when it has none (or nothing is open). */
export function screenCaptionFor(photoId: string): ScreenCaptionEntry | null {
  const entries = screenCaptionsEntries();
  return entries ? (entries[photoId] ?? null) : null;
}

/**
 * Forget what was loaded.
 *
 * Called when the passphrase changes or goes away: the descriptions in hand
 * were opened with the old one, and showing them after the reader has said
 * "forget it" would be wrong.
 */
export function forgetScreenCaptions(): void {
  pending = null;
  envelope = undefined;
  setState({ status: "idle" });
}

/** The sealed file, fetched once and kept. Null when the archive has none. */
async function fetchEnvelope(): Promise<ScreenCaptionsEnvelope | null> {
  if (envelope === undefined) {
    envelope = await loadMetadataFile<ScreenCaptionsEnvelope>(SCREEN_CAPTIONS_FILE, "screens");
  }
  return envelope;
}

/**
 * Open the descriptions, once.
 *
 * The passphrase is asked of the surface (the desktop shell's key store, or
 * this session's memory), the envelope is fetched the way every other archive
 * file is fetched, and the two are put together. A surface with no passphrase
 * never fetches the file: there is nothing it could do with it.
 */
export async function ensureScreenCaptions(): Promise<ScreenCaptionsState> {
  if (pending) return pending;
  const run = (async (): Promise<ScreenCaptionsState> => {
    if (!cryptoAvailable()) {
      const next: ScreenCaptionsState = { status: "unavailable" };
      setState(next);
      return next;
    }
    const passphrase = await screenKeySurface().recall();
    if (!passphrase) {
      const next: ScreenCaptionsState = { status: "locked" };
      setState(next);
      return next;
    }
    setState({ status: "loading" });
    try {
      const file = await fetchEnvelope();
      if (!file) {
        // No file: nothing has been described yet, or the archive predates the
        // pass. Not an error, and not the same as "locked".
        const next: ScreenCaptionsState = { status: "ready", entries: {} };
        setState(next);
        return next;
      }
      const open = await decryptScreenCaptions(file, passphrase);
      const next: ScreenCaptionsState = { status: "ready", entries: open.entries };
      setState(next);
      return next;
    } catch (err) {
      const error =
        err instanceof ScreenCryptoError ? err : new ScreenCryptoError("descriptions-damaged", (err as Error).message);
      const next: ScreenCaptionsState = { status: "failed", error };
      setState(next);
      return next;
    }
  })();
  pending = run;
  const settled = await run;
  // A failed load is not kept: the reader may have fixed the passphrase, and a
  // cached failure would keep saying "wrong passphrase" after they did.
  if (settled.status === "failed") pending = null;
  return settled;
}

/**
 * Try a passphrase — and keep it only once it has opened the file.
 *
 * The order is the point: the passphrase is checked against the file's own
 * fingerprint **before** it is written anywhere, so a mistyped passphrase never
 * replaces a good one. A store holding the wrong passphrase is a store that
 * has to be emptied by hand, and the error gives no way to tell which of the
 * two was wrong.
 *
 * `remember` is the surface's business: the desktop shell keeps it in the
 * Windows key store, a browser and the phone keep it for this session only.
 */
export async function unlockScreenCaptions(passphrase: string, remember = true): Promise<ScreenCaptionsState> {
  if (!cryptoAvailable()) {
    const next: ScreenCaptionsState = { status: "unavailable" };
    setState(next);
    return next;
  }
  const problem = passphraseProblem(passphrase);
  if (problem) {
    const next: ScreenCaptionsState = { status: "failed", error: problem };
    setState(next);
    return next;
  }
  pending = null;
  setState({ status: "loading" });
  try {
    const file = await fetchEnvelope();
    const entries = file ? (await decryptScreenCaptions(file, passphrase)).entries : {};
    if (remember) await screenKeySurface().remember(passphrase);
    const next: ScreenCaptionsState = { status: "ready", entries };
    setState(next);
    return next;
  } catch (err) {
    const error =
      err instanceof ScreenCryptoError ? err : new ScreenCryptoError("descriptions-damaged", (err as Error).message);
    const next: ScreenCaptionsState = { status: "failed", error };
    setState(next);
    return next;
  }
}

/**
 * Let the passphrase go.
 *
 * The descriptions in hand were opened with it, so they go too — and the
 * pages that were showing them fill themselves back in as empty.
 */
export async function lockScreenCaptions(): Promise<void> {
  await screenKeySurface().forget();
  forgetScreenCaptions();
}

/**
 * The number of descriptions this reader can see.
 *
 * Zero means either "none described yet" or "locked" — the two are told apart
 * by the state, not by this number.
 */
export function screenCaptionsCount(): number {
  const entries = screenCaptionsEntries();
  return entries ? Object.keys(entries).length : 0;
}

/**
 * A caption line for one photograph, filled in when the descriptions open.
 *
 * A page that shows photographs is drawn long before the descriptions are
 * decrypted — they need a passphrase and a fetch, and a page that waited for
 * both would show nothing until they landed. So the line is put in place empty
 * and filled in when the file opens; a photograph with no description leaves
 * nothing behind.
 *
 * The slots are held in one set and pruned when they are filled or when their
 * element has left the page, so a long scroll does not accumulate them.
 */
interface CaptionSlot {
  el: HTMLElement;
  id: string;
}
const slots = new Set<CaptionSlot>();

onScreenCaptions((state) => {
  if (state.status !== "ready") return;
  for (const slot of [...slots]) {
    if (!slot.el.isConnected) {
      slots.delete(slot);
      continue;
    }
    const entry = screenCaptionFor(slot.id);
    if (!entry) {
      slot.el.remove();
      slots.delete(slot);
      continue;
    }
    slot.el.textContent = entry.caption;
    slot.el.title = entry.tags.join(" · ");
    slot.el.hidden = false;
    slots.delete(slot);
  }
});

/**
 * The description of one photograph, as a line of text under it.
 *
 * Empty (and hidden) until there is something to say. The wording is the
 * model's own — it names the *kind* of screen and nothing on it — so it is
 * shown as it was written, with the coarse tags as a tooltip rather than as
 * more text.
 */
export function screenCaptionSlot(photoId: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "screen-caption";
  el.hidden = true;
  const slot: CaptionSlot = { el, id: photoId };
  slots.add(slot);
  // Already open: the listener above has run before this slot existed.
  const entry = screenCaptionFor(photoId);
  if (entry) {
    el.textContent = entry.caption;
    el.title = entry.tags.join(" · ");
    el.hidden = false;
    slots.delete(slot);
  }
  return el;
}
