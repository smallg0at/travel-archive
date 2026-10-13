/**
 * The errors a screenshot-passphrase operation can report, as a **code**.
 *
 * These messages are read by a person in a form, which means they are read in
 * Chinese, and the text itself cannot be written here: the server has one
 * language and the client has two. So the server says what happened *and* names
 * it, and the app turns the name into a sentence — the same division the job
 * phases use, and for the same reason: a sentence with numbers baked into it
 * cannot be translated, but a code with parameters can.
 *
 * The English `message` stays, and is used as the fallback: a code the client does
 * not know about — a newer server, an older page — is shown as it arrived rather
 * than as nothing.
 */
export type ScreenErrorCode =
  | "passphrase-too-short"
  | "passphrase-too-long"
  | "passphrase-too-common"
  | "passphrase-too-famous"
  | "passphrase-mismatch"
  | "descriptions-damaged"
  | "no-passphrase"
  | "key-store-unavailable"
  | "key-store-unreadable";

export class ScreenError extends Error {
  readonly code: ScreenErrorCode;
  readonly params: Record<string, string | number>;

  constructor(code: ScreenErrorCode, message: string, params: Record<string, string | number> = {}) {
    super(message);
    this.name = "ScreenError";
    this.code = code;
    this.params = params;
  }
}

/** True for anything this module classifies, whether it came from here or a `catch`. */
export function isScreenError(err: unknown): err is ScreenError {
  return err instanceof ScreenError;
}
