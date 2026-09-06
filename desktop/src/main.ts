import { app, BrowserWindow, dialog, shell } from "electron";
import type { Server } from "node:http";
import { existsSync } from "node:fs";
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

// desktop/dist/main.js -> the repository root.
const ROOT = resolve(__dirname, "..", "..");
const APP_DIST = join(ROOT, "app", "dist");
const PIPELINE_DIR = join(ROOT, "pipeline");
const PIPELINE_ENTRY = join(PIPELINE_DIR, "dist", "serve.js");

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

  try {
    pipeline = await startPipelineServer({
      cwd: PIPELINE_DIR,
      entry: PIPELINE_ENTRY,
      port: PIPELINE_PORT,
      onOutput: log,
    });
  } catch (err) {
    // A missing pipeline build is not fatal: the archive still reads from
    // OneDrive, and only generation is unavailable. app/src/backend.ts already
    // hides the generate controls when /health does not answer — the same path
    // the phone takes.
    log(`Job server unavailable: ${(err as Error).message}`);
  }

  if (pipeline && !(await waitForHealthy(PIPELINE_PORT))) {
    log(`Job server did not become healthy on ${PIPELINE_PORT}; continuing read-only.`);
  }

  createWindow();
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
app.on("before-quit", () => {
  stopPipelineServer(pipeline);
  staticServer?.close();
});
process.on("exit", () => stopPipelineServer(pipeline));
