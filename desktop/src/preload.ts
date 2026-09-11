import { contextBridge, ipcRenderer } from "electron";

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
contextBridge.exposeInMainWorld("electronAPI", {
  printToPDF: (): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke("print-to-pdf"),
});
