import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import type { Server } from "node:http";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { serveApp } from "./static";
import {
  isDeviceCodePrompt,
  startPipelineServer,
  stopPipelineServer,
  waitForHealthy,
  type PipelineServer,
} from "./pipelineServer";

/**
 * The desktop shell.
 *
 * It owns no application logic — it starts the two things that used to be two
 * terminal windows, opens one window on the app, and shuts them down again.
 * Everything visible is the same build that runs in a browser tab.
 *
 * **The window loads the app over HTTP on localhost, never file://.** MSAL's
 * redirect URI is `${window.location.origin}/auth/` and has to match a URI
 * registered under Azure's "Single-page application" platform; file:// has a
 * null origin and a custom scheme cannot be registered as one. Serving the
 * built app over loopback HTTP is what lets the shell add nothing to app/src —
 * which is also what keeps a later mobile build working off the same dist/.
 */

/**
 * The shell's own port, registered in Azure as `http://localhost:17923/auth/`.
 *
 * Deliberately not 4173, which `run-preview.ps1` uses: a dedicated port means
 * the desktop app and a dev preview can run at the same time without one
 * having to detect and defer to the other.
 *
 * Changing it means registering the matching redirect URI in Azure — MSAL
 * derives it from `window.location.origin` (app/src/msalConfig.ts) — and adding
 * the origin to ALLOWED_ORIGINS in pipeline/src/serve.ts, or the app loads but
 * cannot reach the job server.
 */
const APP_PORT = Number(process.env.DESKTOP_PORT ?? 17923);
const PIPELINE_PORT = Number(process.env.SERVE_PORT ?? 4319);

/**
 * Where the built app and the pipeline live, which differs once installed.
 *
 * From a checkout, `desktop/dist/main.js` sits two levels below the repo root.
 * Packaged, both are copied into `resources/` as real directories rather than
 * into the asar archive — the pipeline because a child process has to execute
 * a real file on disk, and the app alongside it so the two stay consistent.
 */
const PACKAGED = app.isPackaged;
const ROOT = PACKAGED ? process.resourcesPath : resolve(__dirname, "..", "..");
const APP_DIST = PACKAGED ? join(ROOT, "app-dist") : join(ROOT, "app", "dist");
const PIPELINE_DIR = join(ROOT, "pipeline");
// Packaged, the server is one bundled ESM file (workspace hoisting means there
// is no pipeline/node_modules to ship); from a checkout it is the normal build.
const PIPELINE_ENTRY = PACKAGED
  ? join(PIPELINE_DIR, "dist", "server.mjs")
  : join(PIPELINE_DIR, "dist", "serve.js");

/**
 * The pipeline's writable home — see pipeline/src/paths.ts.
 *
 * Installed, the program directory is read-only, so `.env`, `token-cache.json`
 * and the whole `data/` mirror move to the per-user directory. Running from a
 * checkout this is left unset, and the pipeline falls back to `pipeline/`,
 * which is exactly where those files already are: nothing moves for anyone
 * working from source.
 */
const ARCHIVE_HOME = PACKAGED ? app.getPath("userData") : null;

const APP_URL = `http://localhost:${APP_PORT}`;
const LOGIN_ORIGIN = "https://login.microsoftonline.com";

let staticServer: Server | null = null;
let pipeline: PipelineServer | null = null;
let mainWindow: BrowserWindow | null = null;

/** Device-code prompts are shown once; MSAL repeats the line while it polls. */
let deviceCodeShown = false;

function log(line: string): void {
  // Goes to the terminal when started with `npm run --workspace desktop start`,
  // and is the only trace of the child otherwise.
  console.log(`[pipeline] ${line}`);

  if (isDeviceCodePrompt(line) && !deviceCodeShown) {
    deviceCodeShown = true;
    void dialog.showMessageBox({
      type: "info",
      title: "Sign in to OneDrive",
      message: "The archive pipeline needs to be signed in.",
      detail: line,
      buttons: ["Open microsoft.com/devicelogin", "Later"],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) void shell.openExternal("https://microsoft.com/devicelogin");
    });
  }
}

/**
 * Windows the sign-in flow is allowed to open.
 *
 * `about:blank` is MSAL's synchronous placeholder popup; the login origin is
 * where it then navigates; and the app's own origin is where it lands at the
 * end, on the /auth/ bridge page that hands the response back to the opener.
 */
function isAuthWindowUrl(url: string): boolean {
  return url === "about:blank" || url.startsWith(LOGIN_ORIGIN) || url.startsWith(APP_URL);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#161614",
    title: "Photo Archive",
    show: false,
    webPreferences: {
      // The renderer is an ordinary web page that talks to Graph and to
      // localhost over fetch. It needs no Node and gets none.
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, "preload.js"),
    },
  });

  // Paint only once there is something to see; otherwise the window flashes
  // white before the app's own theme applies.
  mainWindow.once("ready-to-show", () => mainWindow?.show());

  /**
   * MSAL signs in through `window.open`, which Electron denies by default.
   *
   * Allowing it keeps the popup flow — the popup lands back on the app's own
   * origin at /auth/, same origin as the opener, so the bridge page's
   * BroadcastChannel handoff works exactly as it does in a browser.
   * app/src/msAuth.ts already falls back to `loginRedirect` on
   * `popup_window_error`, so a denial here would still sign in; this is the
   * better path, not the only one.
   *
   * Anything that is not the login flow opens in the real browser instead of
   * silently becoming an unnavigable window inside the app.
   */
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // `about:blank` is not an edge case here, it is the normal first step.
    // msal-browser opens a blank popup *synchronously* so the click's user
    // activation is not spent while it builds the authorize URL, then points
    // that window at login.microsoftonline.com. Treating it as "some other
    // link" sent it to shell.openExternal — which made Windows ask which app
    // should open `about:blank`, handed MSAL a null window, and surfaced as
    // `popup_window_error`.
    if (isAuthWindowUrl(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: { width: 520, height: 700, autoHideMenuBar: true },
      };
    }
    // Only real web links go to the browser. Anything else is dropped rather
    // than handed to the shell, which would ask the OS to open a scheme the
    // page chose.
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  void mainWindow.loadURL(APP_URL);
  mainWindow.on("closed", () => (mainWindow = null));
}

/**
 * Exports the current page to a PDF the renderer picked with app/src/print.ts,
 * without Chrome's print dialog — see preload.ts for why.
 *
 * `preferCSSPageSize` hands page size and margins to the app's own `@page`
 * rule (style.css) rather than duplicating it here; `displayHeaderFooter` is
 * false so no URL/date/title band is added, which is the entire point.
 */
ipcMain.handle("print-to-pdf", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { ok: false, error: "No window" };

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: "Export as PDF",
    defaultPath: "Photo Archive.pdf",
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (canceled || !filePath) return { ok: false, error: "cancelled" };

  // The window is created with a dark backgroundColor (matching the app's own
  // screen theme) so it never flashes white before the page paints. printToPDF
  // paints that native colour into anything the page hasn't — the tail end of
  // the last page, any not-yet-composited region during the screen-to-print
  // layout swap — which is invisible on screen but shows up as black behind an
  // otherwise-white printed page. White for the capture only; restored after
  // regardless of success, so the screen never shows the wrong colour.
  const screenBackground = win.getBackgroundColor();
  win.setBackgroundColor("#ffffff");
  try {
    const data = await event.sender.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
    });
    await writeFile(filePath, data);
    return { ok: true, path: filePath };
  } finally {
    win.setBackgroundColor(screenBackground);
  }
});

/**
 * A fresh install has no `.env`, so the job server cannot start.
 *
 * That is not a broken state — the app signs in and reads the whole archive
 * from OneDrive, because `VITE_AZURE_CLIENT_ID` is baked into the build at
 * compile time. Only *generation* needs the pipeline's own credentials. But
 * without a word of explanation the Generate controls would simply be absent,
 * which reads as a bug rather than as "not configured yet".
 *
 * This fires only when `ARCHIVE_HOME` is set, which is only in a packaged
 * build — and a packaged build has every non-secret setting baked in (see
 * desktop/scripts/bundle-pipeline.mjs), so the job server does start and the
 * one genuinely missing value is the AI provider's key. That is why this can
 * now send you to Settings > Generation instead of asking you to write a file:
 * the server that serves that form is already running.
 */
async function warnIfUnconfigured(): Promise<void> {
  if (!ARCHIVE_HOME || existsSync(join(ARCHIVE_HOME, ".env"))) return;

  const { response } = await dialog.showMessageBox({
    type: "info",
    title: "Generation not configured",
    message: "The archive will open, but summaries cannot be generated yet.",
    detail:
      `Add your AI provider's API key under Settings > Generation and you are ` +
      `done — everything else is already configured in this build.\n\n` +
      `Browsing and reading the archive works without it.`,
    buttons: ["Continue", "Open the settings folder"],
    defaultId: 0,
  });
  // The folder is the second button now rather than the first: it is the escape
  // hatch for editing `.env` by hand, not the instruction it used to be.
  if (response === 1) void shell.openPath(ARCHIVE_HOME);
}

async function startup(): Promise<void> {
  if (!existsSync(join(APP_DIST, "index.html"))) {
    dialog.showErrorBox(
      "The app is not built",
      `${APP_DIST} has no index.html.\n\nRun "npm run --workspace app build" and start again.`,
    );
    app.quit();
    return;
  }

  // null means the port was already taken. On a dedicated port that should
  // only happen if another copy of the shell is up — which the single-instance
  // lock already prevents — so this is a safety net rather than the normal
  // path, and loading what is there beats refusing to start.
  staticServer = await serveApp(APP_DIST, APP_PORT);
  log(staticServer ? `Serving ${APP_DIST} on ${APP_URL}` : `Reusing whatever already serves ${APP_URL}`);

  // The window opens as soon as the app can be served, and the job server
  // starts behind it. Waiting for the server first cost a fresh install the
  // full 20s health timeout staring at nothing — the one machine where it is
  // guaranteed to fail is the one that has no `.env` yet. app/src/backend.ts
  // polls /health and reveals the generate controls when it answers, so a
  // server that arrives a second after the window is not a problem.
  createWindow();

  void (async () => {
    try {
      pipeline = await startPipelineServer({
        cwd: ARCHIVE_HOME ?? PIPELINE_DIR,
        entry: PIPELINE_ENTRY,
        archiveHome: ARCHIVE_HOME,
        port: PIPELINE_PORT,
        onOutput: log,
      });
    } catch (err) {
      // Not fatal: the archive still reads from OneDrive and only generation
      // is unavailable — the same read-only path the phone takes.
      log(`Job server unavailable: ${(err as Error).message}`);
      return;
    }
    if (!(await waitForHealthy(PIPELINE_PORT))) {
      log(`Job server did not become healthy on ${PIPELINE_PORT}; continuing read-only.`);
    }
  })();

  void warnIfUnconfigured();
}

// Electron allows a second instance to launch by default, which here would mean
// two processes fighting over both ports and, worse, two job servers writing the
// same archive. The archive lock would catch the write itself, but refusing the
// second window is the honest place to stop.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(startup);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on("window-all-closed", () => app.quit());

/**
 * Stop the child before exiting.
 *
 * `before-quit` covers the ordinary path. The `exit` handler is the backstop:
 * a job server left running would hold port 4319 and, if it were mid-write,
 * the archive lock too — leaving the next launch refusing to work for reasons
 * nothing on screen could explain.
 */
/**
 * Push whatever the renderer has stored to disk before the process goes.
 *
 * Chromium keeps `localStorage` in a LevelDB under the userData directory and
 * commits it on a clean shutdown. This one had not committed in days: on
 * 2026-09-11 that store held a `CURRENT` dated 06/09 and a last `.ldb` table
 * dated 11/09, while every launch wrote a fresh `000003.log` and left the
 * previous session's — 20KB of MSAL keys, theme and content language — behind
 * as an orphaned `000004.log` that was never recovered. That is the signature
 * of the renderer being killed rather than quitting, which this machine has
 * done repeatedly.
 *
 * The real fix is elsewhere: the settings now live in the job server's own
 * file (pipeline/src/prefsStore.ts), which survives a kill -9 outright. This
 * is the belt-and-braces half, and it only helps on the paths that reach
 * `before-quit` at all — a force-kill or a power cut reaches nothing, which is
 * precisely why it could not be the fix on its own.
 */
function flushRendererStorage(): void {
  try {
    void session.defaultSession.flushStorageData();
  } catch {
    // Nothing here is worth failing a quit over.
  }
}

app.on("before-quit", () => {
  flushRendererStorage();
  stopPipelineServer(pipeline);
  staticServer?.close();
});
process.on("exit", () => stopPipelineServer(pipeline));
