/**
 * The settings for the withheld screenshots.
 *
 * Three things live here, and none of them is a run: the passphrase the
 * descriptions are sealed under, the service on this machine that writes them,
 * and what this machine can open. Running the pass is a job, and jobs live in
 * Generate — the rule that keeps a page to one kind of thing. What is here is
 * what a job would be configured with.
 *
 * The reading side is here for the same reason the phone has it here: opening
 * the descriptions is not a job, it is a state of this device — how many it can
 * read, and what it takes to read them.
 */
import { ui } from "./i18n";
import { el } from "./photoUi";
import {
  setScreensPassphrase,
  screensStatus,
  type ScreensSetResult,
  type ScreensStatus,
} from "./backend";
import { providerChoice } from "./providerChoice";
import { button, row, section, setRowValue } from "./settingsUi";
import {
  forgetScreenCaptions,
  onScreenCaptions,
  screenCaptionsCount,
  screenCaptionsState,
  screenErrorText,
  unlockScreenCaptions,
  lockScreenCaptions,
} from "./screenCaptions";
import { recallScreenKey, screenKeyCanPersist } from "./screenKey";

export function screensSection(): HTMLElement {
  const s = section(ui.settings.screens);
  const body = s.querySelector(".set-body")!;

  // The note carries emphasis, so it is set as HTML: the words are ours, and
  // the difference between a warning and a paragraph is the whole point of
  // having it. The key says so (`...Html`), like every other note that does.
  const note = el<HTMLParagraphElement>(`<p class="set-note">${ui.generate.screensNoteHtml}</p>`);
  body.appendChild(note);

  // ---------------------------------------------------------------------
  // The passphrase: the key the descriptions are sealed under.
  //
  // It has to be in two places on a machine that both writes and reads: the
  // job server's key store (so a pass can seal what it describes) and this
  // surface's own store (so this device can open it). They are separate files
  // and either can be missing, so the row says which side it is reporting and
  // the action covers the gap that made this row read "not set" for ever: when
  // the server has no key but this device already holds one, the button hands
  // that key over in one click instead of asking for it twice.
  //
  // Only a genuinely new passphrase re-encrypts anything. The server checks the
  // typed value against the file first (see `planScreenPassphrase`), so the
  // same phrase is adopted as it stands and a wrong one is refused before
  // anything is written.
  // ---------------------------------------------------------------------
  const keyRow = row(ui.generate.screensPassphrase, "…");
  keyRow.classList.add("set-row-action");
  const setKey = button(ui.generate.screensPassSet, () => {});
  keyRow.appendChild(setKey);
  const keyNote = el<HTMLParagraphElement>(`<p class="set-note" hidden></p>`);
  const keyBox = el<HTMLDivElement>(`<div class="set-box" hidden></div>`);
  const keyWarning = el<HTMLParagraphElement>(`<p class="set-note"></p>`);
  keyWarning.textContent = ui.generate.screensPassWarning;
  const keyForm = el<HTMLDivElement>(`<div class="set-box-form"></div>`);
  const pass = el<HTMLInputElement>(
    `<input type="password" name="passphrase" autocomplete="new-password" spellcheck="false" />`,
  );
  pass.placeholder = ui.generate.screensPassNew;
  const pass2 = el<HTMLInputElement>(
    `<input type="password" name="passphrase2" autocomplete="new-password" spellcheck="false" />`,
  );
  pass2.placeholder = ui.generate.screensPassRepeat;
  const mismatch = el<HTMLParagraphElement>(`<p class="set-note tone-warn" hidden></p>`);
  mismatch.textContent = ui.generate.screensPassMismatch;
  const keyActions = el<HTMLDivElement>(`<div class="set-actions"></div>`);
  const keyCancel = button(ui.common.cancel, () => closeKeyBox());
  const keySave = button(ui.generate.screensPassSave, () => void saveKey(), "primary");
  keyActions.append(keyCancel, keySave);
  keyForm.append(pass, pass2, mismatch, keyActions);
  const keyResult = el<HTMLParagraphElement>(`<p class="set-note"></p>`);
  keyBox.append(keyWarning, keyForm, keyResult);
  body.append(keyRow, keyNote, keyBox);

  // ---------------------------------------------------------------------
  // The reading side: what this device can open, and what it takes.
  // ---------------------------------------------------------------------
  const deviceRow = row(ui.generate.screensOnDevice, "…");
  deviceRow.classList.add("set-row-action");
  const unlock = button(ui.generate.screensUnlock, () => {});
  const forget = button(ui.generate.screensForget, () => {}, "");
  forget.hidden = true;
  deviceRow.append(unlock, forget);
  body.appendChild(deviceRow);

  const unlockBox = el<HTMLDivElement>(`<div class="set-box" hidden></div>`);
  const unlockForm = el<HTMLDivElement>(`<div class="set-box-form"></div>`);
  const unlockPass = el<HTMLInputElement>(
    `<input type="password" name="unlock-passphrase" autocomplete="current-password" spellcheck="false" />`,
  );
  unlockPass.placeholder = ui.generate.screensPassEnter;
  // "Remember" only means something where there is a key store to remember in;
  // elsewhere the passphrase goes when the window closes, and the checkbox
  // would be a promise the surface cannot keep.
  const rememberRow = el<HTMLLabelElement>(`<label class="set-remember" hidden></label>`);
  const remember = el<HTMLInputElement>(`<input type="checkbox" name="remember" checked />`);
  rememberRow.append(remember, document.createTextNode(` ${ui.generate.screensRemember}`));
  const unlockActions = el<HTMLDivElement>(`<div class="set-actions"></div>`);
  const unlockCancel = button(ui.common.cancel, () => closeUnlockBox());
  const unlockSave = button(ui.generate.screensUnlock, () => void saveUnlock(), "primary");
  unlockActions.append(unlockCancel, unlockSave);
  unlockForm.append(unlockPass, rememberRow, unlockActions);
  const unlockResult = el<HTMLParagraphElement>(`<p class="set-note"></p>`);
  unlockBox.append(unlockForm, unlockResult);
  body.appendChild(unlockBox);

  // Forgetting is not a toggle: it drops the key this device holds, and if the
  // passphrase is not remembered elsewhere the descriptions go back behind a
  // prompt. One inline question, not a browser dialog — the same "a popup is
  // for confirmations only" rule the rest of the page keeps, without a modal.
  const forgetBox = el<HTMLDivElement>(`<div class="set-box" hidden></div>`);
  const forgetNote = el<HTMLParagraphElement>(`<p class="set-note"></p>`);
  forgetNote.textContent = ui.generate.screensForgetConfirm;
  const forgetActions = el<HTMLDivElement>(`<div class="set-actions"></div>`);
  const forgetCancel = button(ui.common.cancel, () => {
    forgetBox.hidden = true;
  });
  const forgetYes = button(ui.generate.screensForgetYes, () => void doForget(), "primary");
  forgetActions.append(forgetCancel, forgetYes);
  forgetBox.append(forgetNote, forgetActions);
  body.appendChild(forgetBox);

  // ---------------------------------------------------------------------
  // The service: the same chooser the archive's own model uses, over the
  // services that run on this machine. Only the list of candidates differs.
  // ---------------------------------------------------------------------
  // The service in force is `SCREENSHOT_PROVIDER` — a different variable from
  // the archive's own model — so it comes from the server's own report of it,
  // and the row is repainted from that report rather than from a copy this
  // page kept. That is what makes the choice show up as in force at once
  // instead of after a reload.
  const choice = providerChoice({
    envVar: "SCREENSHOT_PROVIDER",
    scope: "local",
    value: (config) => config.screenshotProvider,
    note: ui.generate.screensServiceNote,
    unknownService: ui.generate.screensServiceUnset,
  });
  body.appendChild(choice.el);

  // ---------------------------------------------------------------------
  // Painting
  // ---------------------------------------------------------------------

  /** The server's report, kept because the button's meaning depends on it. */
  let server: ScreensStatus | null = null;
  /** True when the button should hand the machine the key this device holds. */
  let adopt = false;

  /**
   * What the button means right now.
   *
   * Three meanings, and the wrong label is how "I set it and nothing happened"
   * starts: a machine with no key and this device holding one can be given that
   * key in a click; a machine with no key and no device key needs the phrase
   * typed; a machine that already has one is being changed.
   */
  const refreshKeyAction = (): void => {
    const device = screenCaptionsState().status === "ready";
    adopt = !!server && !server.hasKey && server.canStore && device;
    setKey.hidden = !server?.canStore;
    setKey.textContent = adopt
      ? ui.generate.screensPassAdopt
      : server?.hasKey
        ? ui.generate.screensPassChange
        : ui.generate.screensPassSet;
  };

  /**
   * The passphrase row's value: whether *this device* has opened them, which is
   * the question "is it unlocked or not". The server's key store is a different
   * file, so "set" and "locked" used to sit next to each other with nothing
   * saying how both could be true.
   */
  const paintKeyValue = (): void => {
    if (!server) return;
    const device = screenCaptionsState().status === "ready";
    setRowValue(
      keyRow,
      server.hasKey
        ? device
          ? ui.generate.screensKeySetOpen
          : ui.generate.screensKeySetLocked
        : !server.canStore
          ? ui.generate.screensNoKeyStore
          : device
            ? ui.generate.screensKeyOnDevice
            : ui.generate.screensKeyUnset,
    );
  };

  /** The server's side: the passphrase is in its key store, the service is chosen. */
  const paintServer = async (): Promise<void> => {
    server = await screensStatus();
    if (!server) {
      setRowValue(keyRow, ui.settings.unavailable);
      setKey.hidden = true;
      return;
    }
    paintKeyValue();
    refreshKeyAction();
    choice.refresh();
  };

  /** This device's side: how many it can open, and what it takes to open them. */
  const paintDevice = (): void => {
    const local = screenCaptionsState();
    const line = deviceRow;
    line.classList.remove("tone-warn");
    if (local.status === "unavailable") {
      setRowValue(line, ui.generate.screensNoCrypto);
      line.classList.add("tone-warn");
    } else if (local.status === "failed") {
      setRowValue(
        line,
        screenErrorText({ error: local.error.message, code: local.error.code, params: local.error.params }),
      );
      line.classList.add("tone-warn");
    } else if (local.status === "ready") {
      setRowValue(line, ui.generate.screensOnDeviceCount(screenCaptionsCount()));
    } else if (local.status === "loading") {
      setRowValue(line, ui.generate.screensOpening);
    } else {
      setRowValue(line, ui.generate.screensLocked);
    }
    const open = local.status === "ready";
    // While the form is open its own button is the only one: a second "unlock"
    // above it is the same action twice, and the reader has to guess which.
    unlock.hidden = open || local.status === "unavailable" || !unlockBox.hidden;
    forget.hidden = !open;
    paintKeyValue();
    refreshKeyAction();
  };

  // The state can change without this page being on screen — the reader may
  // unlock the descriptions in another tab — so the line follows the module.
  onScreenCaptions(() => paintDevice());
  paintDevice();
  void paintServer();

  // ---------------------------------------------------------------------
  // The passphrase
  // ---------------------------------------------------------------------

  const keyMatch = (): { first: string; ok: boolean } => {
    const first = pass.value.trim();
    const second = pass2.value.trim();
    const both = first.length > 0 && second.length > 0;
    return { first, ok: both && first === second };
  };

  const refreshKeySave = (): void => {
    const { ok } = keyMatch();
    keySave.disabled = !ok;
    mismatch.hidden = !pass.value || !pass2.value || ok;
  };

  const closeKeyBox = (): void => {
    keyBox.hidden = true;
    pass.value = "";
    pass2.value = "";
    keyResult.textContent = "";
    keyResult.classList.remove("tone-warn");
  };

  /** The outcome of a set, in the reader's language. */
  const doneText = (result: ScreensSetResult): string =>
    result.mode === "rotated"
      ? ui.generate.screensPassDone(result.described, result.fingerprint)
      : result.mode === "adopted"
        ? ui.generate.screensPassDoneAdopted(result.described, result.fingerprint)
        : ui.generate.screensPassDoneSet;

  /**
   * Hand the machine the passphrase this device already holds.
   *
   * The server still checks it against the file — so this cannot install a
   * wrong key even if the device's copy were stale — and an adopt does not
   * re-encrypt anything.
   */
  async function adoptFromDevice(): Promise<void> {
    const key = await recallScreenKey();
    if (!key) {
      // The state moved under us (forgotten in another tab): repaint and let
      // the button fall back to asking for the passphrase.
      await paintServer();
      return;
    }
    setKey.disabled = true;
    keyNote.hidden = false;
    keyNote.classList.remove("tone-warn");
    keyNote.textContent = ui.common.saving;
    try {
      const result = await setScreensPassphrase(key);
      if ("error" in result) {
        keyNote.textContent = screenErrorText(result);
        keyNote.classList.add("tone-warn");
        return;
      }
      keyNote.textContent = doneText(result);
      await paintServer();
    } catch (err) {
      keyNote.textContent = (err as Error).message;
      keyNote.classList.add("tone-warn");
    } finally {
      setKey.disabled = false;
    }
  }

  setKey.addEventListener("click", () => {
    if (adopt) {
      void adoptFromDevice();
      return;
    }
    keyBox.hidden = false;
    keyWarning.textContent = server?.hasKey
      ? ui.generate.screensPassWarning
      : ui.generate.screensPassWarningSet;
    keyResult.textContent = "";
    keyResult.classList.remove("tone-warn");
    refreshKeySave();
    pass.focus();
  });
  for (const field of [pass, pass2]) {
    field.addEventListener("input", refreshKeySave);
    // Enter is the way anyone finishes a two-field dialog.
    field.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      void saveKey();
    });
  }

  /**
   * The one path that writes a passphrase: both fields agree, so the value is
   * deliberate rather than a typo carried into the key store. The server then
   * decides whether it is the file's key (adopt) or a new one (rotate).
   */
  async function saveKey(): Promise<void> {
    const { first, ok } = keyMatch();
    if (!ok || keySave.disabled) return;
    keyResult.classList.remove("tone-warn");
    keyResult.textContent = ui.settings.providerCheckBusy;
    keySave.disabled = true;
    try {
      const result = await setScreensPassphrase(first);
      if ("error" in result) {
        keyResult.textContent = screenErrorText(result);
        keyResult.classList.add("tone-warn");
        return;
      }
      closeKeyBox();
      keyNote.hidden = false;
      keyNote.classList.remove("tone-warn");
      keyNote.textContent = doneText(result);

      // The machine has it now; this device should hold it too, so the two rows
      // agree and the descriptions open here without a second prompt. A rotation
      // rewrote the file, so the copy in hand has to go before re-opening it.
      forgetScreenCaptions();
      const opened = await unlockScreenCaptions(first, true);
      if (opened.status === "failed") {
        keyNote.textContent = screenErrorText({
          error: opened.error.message,
          code: opened.error.code,
          params: opened.error.params,
        });
        keyNote.classList.add("tone-warn");
      }
      await paintServer();
    } catch (err) {
      keyResult.textContent = (err as Error).message;
      keyResult.classList.add("tone-warn");
    } finally {
      refreshKeySave();
    }
  }

  // ---------------------------------------------------------------------
  // Opening them here
  // ---------------------------------------------------------------------

  const closeUnlockBox = (): void => {
    unlockBox.hidden = true;
    unlockPass.value = "";
    unlockResult.textContent = "";
    unlockResult.classList.remove("tone-warn");
    // The row's button comes back where it belongs, unless the descriptions are
    // open now (then paintDevice hides it for that reason instead).
    paintDevice();
  };

  unlock.addEventListener("click", () => {
    unlockBox.hidden = false;
    unlock.hidden = true;
    unlockResult.textContent = "";
    unlockResult.classList.remove("tone-warn");
    void screenKeyCanPersist().then((can) => {
      rememberRow.hidden = !can;
      remember.checked = can;
    });
    unlockPass.focus();
  });
  unlockCancel.addEventListener("click", closeUnlockBox);
  unlockPass.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void saveUnlock();
  });
  unlockSave.addEventListener("click", () => void saveUnlock());

  async function saveUnlock(): Promise<void> {
    const passphrase = unlockPass.value;
    if (!passphrase) return;
    unlockSave.disabled = true;
    unlockResult.classList.remove("tone-warn");
    unlockResult.textContent = ui.generate.screensOpening;
    try {
      const result = await unlockScreenCaptions(passphrase, remember.checked);
      if (result.status === "ready") {
        closeUnlockBox();
        paintDevice();
        return;
      }
      if (result.status === "failed") {
        unlockResult.textContent = screenErrorText({
          error: result.error.message,
          code: result.error.code,
          params: result.error.params,
        });
        unlockResult.classList.add("tone-warn");
      }
    } catch (err) {
      unlockResult.textContent = (err as Error).message;
      unlockResult.classList.add("tone-warn");
    } finally {
      unlockSave.disabled = false;
    }
  }

  forget.addEventListener("click", () => {
    forgetBox.hidden = false;
    forgetCancel.focus();
  });

  async function doForget(): Promise<void> {
    await lockScreenCaptions();
    forgetBox.hidden = true;
    closeUnlockBox();
  }

  return s;
}
