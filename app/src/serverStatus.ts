import { checkHealth } from "./backend";
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

let banner: HTMLElement | null = null;

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
  document.body.prepend(banner);
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
export function initServerStatus(online: boolean): void {
  const startedAs: State = online ? "online" : "offline";
  let current = startedAs;

  if (!online && !dismissed()) show(ui.server.offline, null);

  setInterval(async () => {
    const next: State = (await checkHealth())?.ok ? "online" : "offline";
    if (next === current) return;
    current = next;
    // A change is news even if the old state was dismissed.
    try {
      sessionStorage.removeItem(DISMISSED_KEY);
    } catch {
      /* ignore */
    }
    const reload = { label: ui.server.reload, run: () => location.reload() };
    if (next === startedAs) {
      // Back to what the page was built for: nothing to do.
      if (banner) banner.hidden = next === "online";
      if (next === "offline") show(ui.server.offline, null);
    } else if (next === "online") {
      show(ui.server.back, reload);
    } else {
      show(ui.server.lost, reload);
    }
  }, POLL_MS);
}
