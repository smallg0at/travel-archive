import { healthResult, type HealthFailure } from "./backend";
import { ui } from "./i18n";

/**
 * Says so when the local job server is not answering.
 *
 * Without it, a missing server looked like a slow app. The fallback is real
 * and deliberate — `archiveData.ts` reads straight from OneDrive when there is
 * no mirror — but it is a different machine's worth of latency: `index.json`
 * measured 1,237–3,289ms over Graph against a few ms from the mirror, and
 * every thumbnail becomes a Graph lookup that the app's own throttling
 * earns 429s on. The owner opened the app in Chrome with the server off and
 * had no way to tell that was the reason.
 *
 * Also the other direction: a server that stops mid-session, or starts after
 * the page loaded. Either way the page chose its photo source at startup
 * (`main.ts`), so the honest remedy is a reload, and the banner offers one.
 *
 * Polled, because nothing pushes. The request is to loopback and times out in
 * 1.5s; once every 30s is nothing.
 */

const POLL_MS = 30_000;
/** Per tab, not per install: on a phone, where no server ever exists, it would otherwise reappear on every launch. */
const DISMISSED_KEY = "server-banner-dismissed";

type State = "online" | "offline";

/** Whether a failed probe was the password rather than the server. */
const isAuth = (failure: HealthFailure | null): boolean => failure === "auth";

let banner: HTMLElement | null = null;

/**
 * The stack both transient notes live in (`#toasts`, in index.html).
 *
 * Created here when absent rather than assumed: the phone's page has no static
 * shell, and `serverStatus` is the module that needs it either way.
 */
function toastHost(): HTMLElement {
  const existing = document.getElementById("toasts");
  if (existing) return existing;
  const made = document.createElement("div");
  made.id = "toasts";
  document.body.appendChild(made);
  return made;
}

function ensureBanner(): HTMLElement {
  if (banner) return banner;
  banner = document.createElement("div");
  banner.className = "server-banner";
  banner.setAttribute("role", "status");
  banner.hidden = true;
  banner.innerHTML = `<span class="server-banner-text"></span><button type="button" class="server-banner-action"></button><button type="button" class="server-banner-close"></button>`;
  banner.querySelector<HTMLButtonElement>(".server-banner-close")!.textContent = "×";
  banner.querySelector<HTMLButtonElement>(".server-banner-close")!.title = ui.common.close;
  banner.querySelector(".server-banner-close")!.addEventListener("click", () => {
    banner!.hidden = true;
    try {
      sessionStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      /* the banner simply comes back next time */
    }
  });
  toastHost().appendChild(banner);
  return banner;
}

function dismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function show(text: string, action: { label: string; run: () => void } | null): void {
  const node = ensureBanner();
  node.querySelector(".server-banner-text")!.textContent = text;
  const button = node.querySelector<HTMLButtonElement>(".server-banner-action")!;
  button.hidden = !action;
  if (action) {
    button.textContent = action.label;
    button.onclick = action.run;
  }
  node.hidden = false;
}

/**
 * Starts watching. `online` is the answer `main.ts` already got at startup, so
 * the first paint needs no second request.
 */
export function initServerStatus(online: boolean, failure: HealthFailure | null = null): void {
  const startedAs: State = online ? "online" : "offline";
  let current = startedAs;

  // A 401 at startup *is* the gate being shown — its own explanation. A banner
  // underneath it (z-index 60 under the gate's 100) added nothing but a false
  // claim that the server was not running.
  if (!online && !isAuth(failure) && !dismissed()) show(ui.server.offline, null);

  /**
   * One failed probe is not a dead server.
   *
   * The job server is one Node process, and writing the index is a
   * multi-megabyte `JSON.stringify` that holds its event loop — long enough
   * for `/health` to exceed `HEALTH_TIMEOUT_MS`, which is why that timeout was
   * raised to 8s (see backend.ts). It can still lose that race, and the reader
   * then saw "stopped responding" over a server that was busy working. Two
   * misses in a row, a minute apart, is a server that is actually gone.
   *
   * Recovery is never delayed: one success is proof it is back.
   */
  let misses = 0;
  /** What the failed probe said, kept for the message if it does go offline. */
  let lastFailure: HealthFailure | null = null;

  setInterval(async () => {
    const result = await healthResult();
    let next: State;
    if (result.ok) {
      misses = 0;
      lastFailure = null;
      next = "online";
    } else if (++misses < 2) {
      return;
    } else {
      lastFailure = result.failure;
      next = "offline";
    }
    if (next === current) return;
    current = next;
    // A change is news even if the old state was dismissed.
    try {
      sessionStorage.removeItem(DISMISSED_KEY);
    } catch {
      /* ignore */
    }
    const reload = { label: ui.server.reload, run: () => location.reload() };
    // The password having lapsed says so; otherwise the page says the state it
    // was built for (offline) or that it lost a server it had (lost).
    const offlineText = isAuth(lastFailure) ? ui.server.gated : next === startedAs ? ui.server.offline : ui.server.lost;
    if (next === startedAs) {
      // Back to what the page was built for: nothing to do.
      if (banner) banner.hidden = next === "online";
      if (next === "offline") show(offlineText, null);
    } else if (next === "online") {
      show(ui.server.back, reload);
    } else {
      show(offlineText, reload);
    }
  }, POLL_MS);
}
