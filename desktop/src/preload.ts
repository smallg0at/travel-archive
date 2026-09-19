import { contextBridge, ipcRenderer } from "electron";

// Mark root element so CSS can apply Mica translucency only inside the desktop shell
if (typeof document !== "undefined") {
  if (document.documentElement) {
    document.documentElement.classList.add("desktop-shell");
  } else {
    window.addEventListener("DOMContentLoaded", () => {
      document.documentElement.classList.add("desktop-shell");
    });
  }
}

// Enable Ctrl+R and F5 reloads inside the desktop shell
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r") || e.key === "F5") {
      e.preventDefault();
      window.location.reload();
    }
  });
}

/**
 * The renderer's only bridge into the main process: exporting a PDF without
 * Chrome's print dialog.
 *
 * `window.print()` always shows the OS dialog and, worse, its "headers and
 * footers" toggle defaults on and is not scriptable. `webContents.printToPDF`
 * is the same Chromium print pipeline with none of that — no dialog, no
 * header/footer, one call — but it only exists in the main process. This
 * exposes exactly that one call and nothing else.
 */
// Read and apply initial accent color
void ipcRenderer.invoke("get-system-accent").then((accent: string | null) => {
  if (accent && typeof document !== "undefined") {
    document.documentElement.style.setProperty("--accent", accent);
  }
});

contextBridge.exposeInMainWorld("electronAPI", {
  printToPDF: (): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke("print-to-pdf"),
  setTheme: (theme: "light" | "dark"): void =>
    ipcRenderer.send("set-theme", theme),
  getSystemAccent: (): Promise<string | null> =>
    ipcRenderer.invoke("get-system-accent"),
  onSystemAccentChanged: (callback: (color: string) => void): void => {
    ipcRenderer.on("system-accent-changed", (_event, color: string) => callback(color));
  },
});

