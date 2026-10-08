/// <reference types="vite/client" />

interface ElectronAPI {
  printToPDF?(name?: string): Promise<{ ok: boolean; path?: string; error?: string }>;
  setTheme?(theme: "light" | "dark" | "system"): void;
  getSystemAccent?(): Promise<string | null>;
  onSystemAccentChanged?(cb: (color: string) => void): void;
  /** Shell-only: start the job server when it is not answering (desktop shell). */
  startPipeline?(): Promise<{ ok: boolean; error?: string }>;
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
