/// <reference types="vite/client" />

/**
 * The shell's key store for the screenshot passphrase.
 *
 * `safeStorage` encrypts with DPAPI — per Windows account, per machine — so
 * the value cannot be read by another program or lifted off the disk. The
 * bridge never sends the value anywhere: it is written and read by the shell
 * itself, and the page only ever asks for it back.
 */
interface ScreenKeyBridge {
  /** Whether the key store can be used at all on this machine. */
  available(): Promise<boolean>;
  /** The passphrase, or null when the store holds none. */
  get(): Promise<string | null>;
  /** Keep a passphrase. False when the key store refused it. */
  set(passphrase: string): Promise<boolean>;
  /** Let it go. */
  forget(): Promise<void>;
}

interface ElectronAPI {
  printToPDF?(name?: string): Promise<{ ok: boolean; path?: string; error?: string }>;
  setTheme?(theme: "light" | "dark" | "system"): void;
  getSystemAccent?(): Promise<string | null>;
  onSystemAccentChanged?(cb: (color: string) => void): void;
  /** Shell-only: start the job server when it is not answering (desktop shell). */
  startPipeline?(): Promise<{ ok: boolean; error?: string }>;
  /** Shell-only: the passphrase store (safeStorage). Absent in a browser. */
  screenKey?: ScreenKeyBridge;
}

interface Window {
  electronAPI?: ElectronAPI;
}

interface ImportMetaEnv {
  readonly VITE_AZURE_CLIENT_ID: string;
  readonly VITE_AZURE_TENANT_ID: string;
  /** Must match ONEDRIVE_METADATA_FOLDER in pipeline/.env — that's where the app reads index.json and photos/ from. */
  readonly VITE_ONEDRIVE_METADATA_FOLDER: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
