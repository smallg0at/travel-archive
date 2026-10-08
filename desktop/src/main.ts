import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, session, shell, systemPreferences } from "electron";
import type { Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { serveApp } from "./static";
import {
  isDeviceCodePrompt,
  isHealthy,
  startPipelineServer,
  stopPipelineServer,
  waitForHealthy,
  type PipelineServer,
} from "./pipelineServer";

/**
 * Let Chromium decode HEVC through the platform, not ffmpeg.
 *
 * Electron ships no HEVC software decoder — Chromium's ffmpeg never includes
 * H.265 — so an HEVC original, which is most of this library's videos, would
 * simply fail to play. Since Electron 20 the platform decoder is compiled in
 * but off by default; this turns it on. On Windows that is Media Foundation,
 * which needs the "HEVC Video Extensions" package installed; where it is not,
 * or the GPU cannot decode the profile, the viewer's `canPlayType` probe fails
 * and it falls back to the poster frame rather than a black player.
 *
 * Must be before `app.whenReady()`, and there is no other `enable-features`
 * switch in this file for it to clobber.
 */
app.commandLine.appendSwitch("enable-features", "PlatformHEVCDecoderSupport");

/**
 * Path for debug screenshots in development, placed in OS %TEMP%.
 */
const DEBUG_SCREENSHOT_PATH = join(tmpdir(), "photo-archive-debug.png");

function captureDevScreenshot(win: BrowserWindow): void {
  if (PACKAGED || !win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();

  setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$bmp = New-Object System.Drawing.Bitmap(${bounds.width}, ${bounds.height})
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${bounds.x}, ${bounds.y}, 0, 0, (New-Object System.Drawing.Size(${bounds.width}, ${bounds.height})))
$bmp.Save('${DEBUG_SCREENSHOT_PATH.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
`;
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", psScript], (err) => {
      if (err) {
        console.error(`[dev] Screenshot failed: ${err.message}`);
      } else {
        console.log(`[dev] Screenshot saved to ${DEBUG_SCREENSHOT_PATH}`);
      }
    });
  }, 150);
}

/**
 * The desktop shell.
 *
 * It owns no application logic — it starts the two things that used to be two
 * terminal windows, opens one window on the app, and shuts them down again.
 * Everything visible is the same build that runs in a browser tab.
 *
 * **The window loads the app over HTTP on localhost, never file://.** MSAL's
 * redirect URI is `${window.location.origin}/auth.html` and has to match a URI
 * registered under Azure's "Single-page application" platform; file:// has a
 * null origin and a custom scheme cannot be registered as one. Serving the
 * built app over loopback HTTP is what lets the shell add nothing to app/src —
 * which is also what keeps a later mobile build working off the same dist/.
 */

/**
 * The shell's own port, registered in Azure as `http://localhost:17923/auth.html`.
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
const PIPELINE_PORT = Number(process.env.SERVE_PORT ?? 18419);

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

/**
 * The pipeline's `.env`, read here for the few settings the *shell* needs.
 *
 * The pipeline reads `.env` itself (via dotenv, in `pipeline/src/env.ts`), but
 * the shell binds its own static server before the child exists — and
 * `ARCHIVE_HOST` decides where that server listens. Without this the two would
 * disagree in exactly the confusing way: `ARCHIVE_HOST=0.0.0.0` in `.env` would
 * put the job server on the network while the page stayed on loopback, so a
 * family member would load nothing and the reason would be invisible.
 *
 * Deliberately tiny — `KEY=value`, `#` comments, optional quotes — because the
 * alternative is shipping a dotenv parser in the shell for two variables. The
 * same file is read by the real parser on the other side; anything this misses
 * is a setting the shell does not use.
 */
function readEnvFile(): Record<string, string> {
  const home = ARCHIVE_HOME ?? PIPELINE_DIR;
  const path = join(home, ".env");
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const value = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
      if (value) out[match[1]] = value;
    }
  } catch {
    // An unreadable `.env` is the pipeline's problem to report, not the shell's.
  }
  return out;
}

const ENV_FILE = readEnvFile();

/** A setting the shell needs: the real environment first, then `.env`. */
const setting = (name: string): string | undefined => process.env[name] || ENV_FILE[name];

/**
 * Where both servers listen. `0.0.0.0` is what lets the family read the archive
 * over the home network; loopback stays the default, and the password that gates
 * remote reading is the pipeline's business (pipeline/src/access.ts).
 */
const ARCHIVE_HOST = setting("ARCHIVE_HOST") ?? "127.0.0.1";

const APP_URL = `http://localhost:${APP_PORT}`;
const LOGIN_ORIGIN = "https://login.microsoftonline.com";

let staticServer: Server | null = null;
let pipeline: PipelineServer | null = null;
let mainWindow: BrowserWindow | null = null;

/** Device-code prompts are shown once; MSAL repeats the line while it polls. */
let deviceCodeShown = false;

/**
 * Recent child output, so a failure whose only trace was the console can
 * still be shown to a person. The job server keeps no logs of its own
 * (TODO.md), and the reason it refused to start used to live exactly here.
 */
const serverTail: string[] = [];

function log(line: string): void {
  // Goes to the terminal when started with `npm run --workspace desktop start`,
  // and is the only trace of the child otherwise.
  console.log(`[pipeline] ${line}`);

  serverTail.push(line);
  if (serverTail.length > 40) serverTail.shift();

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
 * The most plausible explanation among the lines the child has produced.
 *
 * Errors first — "Missing required env var: AZURE_CLIENT_ID" is the whole
 * answer to a fresh checkout with no `.env`, and it used to be a line in a
 * console nobody had open. Falling back to the last few lines keeps the
 * dialog honest when nothing matched rather than inventing a cause.
 */
function failureDetail(fallback: string): string {
  const err = serverTail.find((l) => /missing required|error:|EADDRINUSE|cannot find|refused/i.test(l));
  if (err) return err;
  if (serverTail.length) return serverTail.slice(-4).join("\n");
  return fallback;
}

/**
 * Windows the sign-in flow is allowed to open.
 *
 * `about:blank` is MSAL's synchronous placeholder popup; the login origin is
 * where it then navigates; and the app's own origin is where it lands at the
 * end, on the /auth.html bridge page that hands the response back to the opener.
 */
function isAuthWindowUrl(url: string): boolean {
  return url === "about:blank" || url.startsWith(LOGIN_ORIGIN) || url.startsWith(APP_URL);
}

/**
 * How long the window holds its "Starting…" page for the job server.
 *
 * Long enough for a cold start — the first launch after a boot, when Node and
 * the pipeline's modules come off a cold disk, was measurably slower than the
 * window and the app came up in fallback mode — and short enough that a server
 * which is never coming still costs little. A server that *exits* ends the
 * wait at once, so a fresh install with no `.env` is not held here at all.
 */
const STARTUP_WAIT_MS = 15_000;

/**
 * Shown while the job server starts, instead of the app.
 *
 * Painted by the shell, not the app, because the whole point is not to load
 * the app yet. It follows the system theme so it does not flash the wrong one
 * before the app's own theme applies.
 */
const STARTING_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<meta charset="utf-8"><title>Photo Archive</title>
<style>
  :root { color-scheme: light dark; }
  html, body { height: 100%; margin: 0; background: transparent; }
  body { display: flex; align-items: center; justify-content: center; gap: 12px;
         color: #6b6a64; --ring: #d9d7cf;
         font: 13px "Segoe UI Variable", "Segoe UI", system-ui, sans-serif; }
  @media (prefers-color-scheme: dark) { body { color: #9a988f; --ring: #3a3935; } }
  /* Matches the app's own loading spinner (style.css \`.trip-map-loading\`). */
  i { flex: none; width: 16px; height: 16px; border: 2px solid var(--ring);
      border-top-color: currentColor; border-radius: 50%;
      animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { i { animation-duration: 2.4s; } }
  p { margin: 0; }
</style>
<i></i><p>Starting the archive…</p>`)}`;

/** Set once the app itself may be shown — after the job server answers, or the wait above gives up. */
let appLoadable = false;

function loadApp(): void {
  appLoadable = true;
  void mainWindow?.loadURL(APP_URL);
}

function createWindow(): void {
  Menu.setApplicationMenu(null);

  const initialDark = nativeTheme.shouldUseDarkColors;
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#00000000",
      symbolColor: initialDark ? "#ffffff" : "#161614",
      /*
       * 48px, not 36px: the standard Win11 title bar height, and what Windows
       * Explorer uses. At 36px the search field had room to be only 24px tall
       * and sat in the middle of the band with the content card's top border
       * 6px under it, so it read as a floating strip resting on a line rather
       * than as part of the title bar. The app's own headers and the search
       * bar's offset are kept in step with this number in style.css —
       * `--titlebar-height`, and `html.desktop-shell #main-column`,
       * `#sidebar-resize`, `.search-bar`.
       */
      height: 48,
    },
    icon: join(__dirname, "../build/icon.png"),
    backgroundColor: "#00000000",
    backgroundMaterial: "mica",
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
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    // No automatic capture here any more: it ran 2.5s after every development
    // launch and said so, which is a line of noise in the shell output next to
    // the ones that matter (adopted, healthy, lagged). F9 still takes one when
    // there is something to look at — see the dev shortcuts below.
  });

  // Windows 11 DWM workaround: re-apply background material when regaining focus or restoring
  if (process.platform === "win32") {
    const refreshMaterial = () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setBackgroundMaterial("mica");
      }
    };
    mainWindow.on("focus", refreshMaterial);
    mainWindow.on("restore", refreshMaterial);
  }

  // Development shortcuts: F12 for DevTools, F5/Ctrl+R for reload, F8 for material, F9 for screenshot
  if (!PACKAGED) {
    const materials: Array<"mica" | "tabbed" | "acrylic"> = ["mica", "tabbed", "acrylic"];
    let matIdx = 0;

    mainWindow.webContents.on("before-input-event", (_event, input) => {
      if (input.type !== "keyDown") return;
      if (input.key === "F12" || ((input.control || input.meta) && input.shift && input.key.toLowerCase() === "i")) {
        if (mainWindow?.webContents.isDevToolsOpened()) {
          mainWindow.webContents.closeDevTools();
        } else {
          mainWindow?.webContents.openDevTools({ mode: "detach" });
        }
      } else if (input.key === "F5" || ((input.control || input.meta) && input.key.toLowerCase() === "r")) {
        if (input.shift || input.control) {
          mainWindow?.webContents.reloadIgnoringCache();
        } else {
          mainWindow?.webContents.reload();
        }
      } else if (input.key === "F8" && mainWindow) {
        matIdx = (matIdx + 1) % materials.length;
        const mat = materials[matIdx];
        mainWindow.setBackgroundMaterial(mat);
        console.log(`[dev] Switched backgroundMaterial to: ${mat}`);
      } else if (input.key === "F9" && mainWindow) {
        captureDevScreenshot(mainWindow);
      }
    });
  }


  /**
   * MSAL signs in through `window.open`, which Electron denies by default.
   *
   * Allowing it keeps the popup flow — the popup lands back on the app's own
   * origin at /auth.html, same origin as the opener, so the bridge page's
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

  void mainWindow.loadURL(appLoadable ? APP_URL : STARTING_PAGE);
  mainWindow.on("closed", () => (mainWindow = null));
}

/**
 * Dynamically adjust window controls overlay symbol color on theme switch.
 *
 * `"system"` is passed through rather than resolved here: `themeSource` going
 * back to `"system"` is what lets the window follow the desktop again, and the
 * symbol colour then has to be read from `shouldUseDarkColors` *after* the
 * change rather than from the argument.
 */
ipcMain.on("set-theme", (_event, theme: "light" | "dark" | "system") => {
  nativeTheme.themeSource = theme;
  const dark = nativeTheme.shouldUseDarkColors;
  mainWindow?.setTitleBarOverlay({
    color: "#00000000",
    symbolColor: dark ? "#ffffff" : "#161614",
    height: 36,
  });
  if (process.platform === "win32" && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundMaterial("mica");
  }
});

/**
 * Re-broadcasts the resolved colour scheme as the OS changes, so a window in
 * "system" keeps its frame in step.
 *
 * The page needs no equivalent listener — with `data-theme` absent the
 * `prefers-color-scheme` media query does that work in CSS — but the native
 * frame is drawn by Electron, not the page, so it has to be told.
 */
nativeTheme.on("updated", () => {
  if (nativeTheme.themeSource !== "system") return;
  const dark = nativeTheme.shouldUseDarkColors;
  mainWindow?.setTitleBarOverlay({
    color: "#00000000",
    symbolColor: dark ? "#ffffff" : "#161614",
    height: 36,
  });
});

function getSystemAccentColor(): string | null {
  try {
    if (process.platform === "win32") {
      const hex = systemPreferences.getAccentColor();
      if (hex) return `#${hex.slice(0, 6)}`;
    }
  } catch {
    // Ignore fallback
  }
  return null;
}

ipcMain.handle("get-system-accent", () => getSystemAccentColor());

/**
 * Starts the job server on demand — the action behind Settings' "start it
 * now" button, for a server that died after launch. Without it the only
 * remedies were restarting the whole app or a terminal.
 *
 * Deliberately mirrors the spawn at startup rather than sharing it:
 * startup's flow is entangled with `loadApp` and the ready race, and what
 * this path has to reproduce is only the three outcomes — already up,
 * started, or the reason it is not.
 */
ipcMain.handle("start-pipeline", async (): Promise<{ ok: boolean; error?: string }> => {
  if (await isHealthy(PIPELINE_PORT)) return { ok: true };

  // A child that exited leaves `pipeline` set but dead; replacing it is the
  // point of the button. A child that is alive but not answering gets an
  // explanation instead of a second process fighting for the port.
  if (pipeline?.child && pipeline.child.exitCode === null && !pipeline.adopted) {
    return { ok: false, error: `A server process is running but not answering on ${PIPELINE_PORT}.` };
  }

  try {
    pipeline = await startPipelineServer({
      cwd: ARCHIVE_HOME ?? PIPELINE_DIR,
      entry: PIPELINE_ENTRY,
      archiveHome: ARCHIVE_HOME,
      archiveHost: ARCHIVE_HOST,
      port: PIPELINE_PORT,
      onOutput: log,
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  if (await waitForHealthy(PIPELINE_PORT, 25_000)) return { ok: true };
  return { ok: false, error: failureDetail(`No answer on ${PIPELINE_PORT} within 25 seconds.`) };
});

if (process.platform === "win32") {
  systemPreferences.on("accent-color-changed", (_event, newColor) => {
    const formatted = `#${newColor.slice(0, 6)}`;
    mainWindow?.webContents.send("system-accent-changed", formatted);
  });
}

/**
 * Exports the current page to a PDF the renderer picked with app/src/print.ts,
 * without Chrome's print dialog — see preload.ts for why.
 *
 * `preferCSSPageSize` hands page size and margins to the app's own `@page`
 * rule (style.css) rather than duplicating it here; `displayHeaderFooter` is
 * false so no URL/date/title band is added, which is the entire point.
 */
ipcMain.handle("print-to-pdf", async (event, name?: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { ok: false, error: "No window" };

  // Named after what is open (a trip, a place). Strip characters Windows
  // forbids in file names, and fall back to the app name when nothing is left.
  const base =
    (typeof name === "string" ? name : "")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "Photo Archive";

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: "Export as PDF",
    defaultPath: `${base}.pdf`,
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

  // A taken port should only mean another copy of the shell — which the
  // single-instance lock already prevents — so this is a safety net rather
  // than the normal path. What is there is adopted only if it answers with
  // this app; anything else is reported, because showing the owner a
  // stranger's page as their archive is worse than not starting.
  const served = await serveApp(APP_DIST, APP_PORT, ARCHIVE_HOST);
  staticServer = served.kind === "serving" ? served.server : null;
  if (served.kind === "occupied") {
    dialog.showErrorBox(
      "Port in use",
      `Something else is already using ${APP_URL} (${served.by}), and it is not Photo Archive. ` +
        `Close it and start again, or set APP_PORT to another port.`,
    );
    app.quit();
    return;
  }
  log(
    served.kind === "serving"
      ? `Serving ${APP_DIST} on ${APP_URL}`
      : `Reusing the Photo Archive already serving ${APP_URL}`,
  );

  // The window opens at once, on a "Starting…" page, and the app loads into
  // it once the job server answers.
  //
  // It used to load the app immediately and let the server arrive behind it.
  // That stopped being harmless once the app began deciding things from its
  // one health check at startup — where photos come from, whether to offer
  // sign-in, the offline banner, the preferences sync. On the first launch
  // after a boot the server lost that race, and the app came up in fallback
  // mode, reading OneDrive directly, until a reload.
  //
  // Waiting is bounded (STARTUP_WAIT_MS) and ends early if the server dies,
  // which keeps what the old ordering was protecting: a fresh install with no
  // `.env`, where the server is certain to fail, still opens promptly.
  createWindow();

  void (async () => {
    try {
      // `npm run desktop:offline`: start the shell and deliberately not the job
      // server — for the window when the server is being repaired and a running
      // one would only get in the way of reproducing whatever is wrong with it.
      //
      // Deliberate, and the same state the catch below already produces when
      // the server cannot start, so nothing downstream is new: `pipeline` stays
      // unset, `stopServer` has nothing to stop, and the app reads OneDrive
      // directly with its own banner saying so.
      if (process.argv.includes("--no-pipeline")) {
        log("Job server skipped (--no-pipeline); the app runs read-only from OneDrive.");
        loadApp();
        return;
      }
      pipeline = await startPipelineServer({
        cwd: ARCHIVE_HOME ?? PIPELINE_DIR,
        entry: PIPELINE_ENTRY,
        archiveHome: ARCHIVE_HOME,
        archiveHost: ARCHIVE_HOST,
        port: PIPELINE_PORT,
        onOutput: log,
      });
    } catch (err) {
      // Not fatal: the archive still reads from OneDrive and only generation
      // is unavailable — the same read-only path the phone takes. Said out
      // loud, though: the thrown message is the actual reason (a missing
      // setting, an unbuilt pipeline), and a console nobody has open is not
      // a place to put it.
      log(`Job server unavailable: ${(err as Error).message}`);
      void dialog.showMessageBox({
        type: "error",
        title: "The archive server did not start",
        message: "The archive continues read-only: scanning, generation and jobs are unavailable.",
        detail: (err as Error).message,
        buttons: ["OK"],
      });
      loadApp();
      return;
    }

    const started = Date.now();
    const healthy = waitForHealthy(PIPELINE_PORT);
    const child = pipeline.child;
    const exited = new Promise<false>((done) => {
      if (!child) return;
      if (child.exitCode !== null) return done(false);
      child.once("exit", () => done(false));
    });
    const capped = new Promise<false>((done) => setTimeout(() => done(false), STARTUP_WAIT_MS));
    const ready = await Promise.race([healthy, exited, capped]);
    log(ready ? `Job server ready in ${Date.now() - started}ms` : `Loading the app without the job server after ${Date.now() - started}ms`);
    loadApp();

    // A server slower than the cap can still arrive; the app's own banner
    // (app/src/serverStatus.ts) notices within 30s and offers a reload.
    if (!ready && !(await healthy)) {
      log(`Job server did not become healthy on ${PIPELINE_PORT}; continuing read-only.`);
      // The common case behind this branch is a child that exited on its first
      // second with a reason — the dialog takes the reason from its own output
      // rather than making the reader guess.
      void dialog.showMessageBox({
        type: "error",
        title: "The archive server did not start",
        message: `It did not answer on port ${PIPELINE_PORT}. The archive continues read-only.`,
        detail: failureDetail(""),
        buttons: ["OK"],
      });
    }
  })();

  void warnIfUnconfigured();
}

// Electron allows a second instance to launch by default, which here would mean
// two processes fighting over both ports and, worse, two job servers writing the
// same archive. The archive lock would catch the write itself, but refusing the
// second window is the honest place to stop.
let lastAlreadyRunningNotice = 0;
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    // Focusing alone reads as "the double-click did nothing", especially when
    // the running copy belongs to a *different* install (dev shell versus the
    // installed app share one userData — see the shared-profile draft). So the
    // copy that is already here says so out loud. Debounced, because one
    // double-click can launch more than one process.
    if (Date.now() - lastAlreadyRunningNotice > 5000) {
      lastAlreadyRunningNotice = Date.now();
      new Notification({
        title: "Photo Archive",
        body: "Photo Archive is already running — its window has been brought to the front.",
      }).show();
    }
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
 * a job server left running would hold port 18419 and, if it were mid-write,
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
