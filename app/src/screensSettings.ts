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
import { rekeyScreens, screensStatus } from "./backend";
import { providerChoice } from "./providerChoice";
import { button, row, section, setRowValue } from "./settingsUi";
import {
  onScreenCaptions,
  screenCaptionsCount,
  screenCaptionsState,
  screenErrorText,
  unlockScreenCaptions,
  lockScreenCaptions,
} from "./screenCaptions";
import { screenKeyCanPersist } from "./screenKey";

export function screensSection(): HTMLElement {
  const s = section(ui.settings.screens);
  const body = s.querySelector(".set-body")!;

  const note = el<HTMLParagraphElement>(`<p class="set-note"></p>`);
  note.textContent = ui.generate.screensNote;
  body.appendChild(note);

  // ---------------------------------------------------------------------
  // The passphrase: the key the descriptions are sealed under. It is set on
  // the machine that does the describing, and rotating it re-encrypts what is
  // already there — a different act from starting a pass, which is why it has
  // its own control and not a field in the run's form.
  // ---------------------------------------------------------------------
  const keyRow = row(ui.generate.screensPassphrase, "…");
  keyRow.classList.add("set-row-action");
  const rekey = button(ui.generate.screensPassChange, () => {});
  keyRow.appendChild(rekey);
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
  body.append(keyRow, keyBox);

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

  // ---------------------------------------------------------------------
  // The service: the same chooser the archive's own model uses, over the
  // services that run on this machine. Only the list of candidates differs.
  // ---------------------------------------------------------------------
  let service: string | null = null;
  const choice = providerChoice({
    envVar: "SCREENSHOT_PROVIDER",
    scope: "local",
    value: () => service,
    note: ui.generate.screensServiceNote,
  });
  body.appendChild(choice.el);

  // ---------------------------------------------------------------------
  // Painting
  // ---------------------------------------------------------------------

  /** The server's side: the passphrase is in its key store, the service is chosen. */
  const paintServer = async (): Promise<void> => {
    const status = await screensStatus();
    if (!status) {
      setRowValue(keyRow, ui.settings.unavailable);
      return;
    }
    setRowValue(
      keyRow,
      status.hasKey
        ? ui.generate.screensKeySet
        : status.canStore
          ? ui.generate.screensKeyUnset
          : ui.generate.screensNoKeyStore,
    );
    // The change button is for the machine's own key store; where there is
    // none, there is nothing to change.
    rekey.hidden = !status.canStore;
    service = status.provider;
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
    unlock.hidden = open || local.status === "unavailable";
    forget.hidden = !open;
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

  rekey.addEventListener("click", () => {
    keyBox.hidden = false;
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
   * The only path that rotates: both fields agree, so the value is deliberate
   * rather than a typo carried into the key store.
   */
  async function saveKey(): Promise<void> {
    const { first, ok } = keyMatch();
    if (!ok || keySave.disabled) return;
    keyResult.classList.remove("tone-warn");
    keyResult.textContent = ui.settings.providerCheckBusy;
    keySave.disabled = true;
    try {
      const keyed = await rekeyScreens(first);
      if ("error" in keyed) {
        keyResult.textContent = screenErrorText(keyed);
        keyResult.classList.add("tone-warn");
        return;
      }
      closeKeyBox();
      keyResult.textContent = ui.generate.screensPassDone(keyed.described, keyed.fingerprint);
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
  };

  unlock.addEventListener("click", () => {
    unlockBox.hidden = false;
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
    void lockScreenCaptions().then(() => {
      closeUnlockBox();
      paintDevice();
    });
  });

  return s;
}
