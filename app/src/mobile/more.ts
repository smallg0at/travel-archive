import { mountSearch } from "../search";
import { el } from "../photoUi";
import { renderThemeControl } from "../theme";
import { renderContentLanguageControl } from "../contentLang";
import { getActiveAccount } from "../msAuth";
import { cacheStats } from "../thumbCache";
import { keptStats } from "./cache";
import { allMonths, autoCacheEnabled, cacheAllNow, setAutoCacheEnabled } from "./offline";
import { ui } from "../i18n";
import { openDate } from "./day";
import { openViewer } from "./viewer";
import { note, pageBar, screen } from "./ui";
import { isNative } from "./native";
import { allowDevicePhotos, deviceLibrarySize, deviceStatus } from "./devicePhotos";
import {
  onScreenCaptions,
  screenCaptionsCount,
  screenCaptionsState,
  screenErrorText,
  unlockScreenCaptions,
} from "../screenCaptions";

/**
 * Search and Settings — the two screens that are mostly someone else's
 * controls in a phone-shaped frame.
 */

export function renderSearch(): HTMLElement {
  const page = screen("m-search");
  const head = el<HTMLElement>(`<header class="m-large-head"><h1></h1></header>`);
  head.querySelector("h1")!.textContent = ui.mobile.tabs.search;
  page.appendChild(head);
  // Lazy: search.json is 6.5MB, and a reader who opens the tab and leaves
  // should not pay for it. It is fetched when the field is first focused.
  // As on the desktop: a thumbnail opens that photo, with its day's others to
  // swipe through; the day's title opens the day.
  const search = mountSearch({
    lazy: true,
    onOpenDay: (date) => openDate(date),
    onOpenPhoto: (photo, siblings) => openViewer(siblings, Math.max(0, siblings.indexOf(photo))),
  });
  search.classList.add("m-search-host");
  page.appendChild(search);
  return page;
}

function group(title: string): { section: HTMLElement; body: HTMLElement } {
  const section = el<HTMLElement>(`<section class="m-section"><h2 class="m-section-title"></h2><div class="m-group m-settings-group"></div></section>`);
  section.querySelector("h2")!.textContent = title;
  return { section, body: section.querySelector<HTMLElement>(".m-group")! };
}

function row(label: string, control: HTMLElement | string): HTMLElement {
  const item = el<HTMLElement>(`<div class="m-setting"><span class="m-setting-label"></span></div>`);
  item.querySelector("span")!.textContent = label;
  if (typeof control === "string") item.appendChild(Object.assign(document.createElement("span"), { className: "m-setting-value", textContent: control }));
  else item.appendChild(control);
  return item;
}

/**
 * Photographs from this phone rather than from OneDrive (devicePhotos.ts).
 *
 * Off until asked for, and asked for from here: Android's permission dialog
 * says nothing about why an archive reader wants the camera folder, so the
 * sentence above the button has to.
 */
function devicePhotosRow(): HTMLElement {
  const section = el<HTMLElement>(`<div class="m-device-photos"></div>`);
  const draw = (granted: boolean) => {
    section.replaceChildren();
    if (granted) {
      const held = deviceLibrarySize();
      section.appendChild(row(ui.mobile.devicePhotos, held === null ? ui.mobile.devicePhotosOn : ui.mobile.devicePhotosCount(held)));
    } else {
      const allow = el<HTMLButtonElement>(`<button type="button" class="m-primary m-device-allow"></button>`);
      allow.textContent = ui.mobile.devicePhotosAllow;
      allow.addEventListener("click", async () => {
        allow.disabled = true;
        const on = await allowDevicePhotos();
        allow.disabled = false;
        if (on) draw(true);
        else section.appendChild(note(ui.mobile.devicePhotosRefused));
      });
      section.appendChild(row(ui.mobile.devicePhotos, ui.mobile.devicePhotosOff));
      section.appendChild(allow);
    }
    section.appendChild(note(ui.mobile.devicePhotosWhy));
  };
  void deviceStatus().then(({ granted }) => draw(granted));
  return section;
}

/**
 * The encrypted screenshot descriptions.
 *
 * The phone reads them from OneDrive and opens them **here**, in the app — the
 * same code the desktop uses (`app/src/screenCaptions.ts`), so the plaintext
 * never crosses the network and the two surfaces cannot drift apart. The
 * phone has no key store yet, so the passphrase is asked for once and kept for
 * this session only; the row says so rather than implying it is safe.
 */
function screenCaptionsGroup(): HTMLElement {
  const section = group(ui.mobile.screens);
  const state = row(ui.generate.screensOnDevice, "…");
  section.body.appendChild(state);
  section.body.appendChild(Object.assign(document.createElement("p"), { className: "m-note", textContent: ui.mobile.screensWhy }));

  const unlock = el<HTMLButtonElement>(`<button type="button" class="m-primary"></button>`);
  unlock.textContent = ui.generate.screensUnlock;
  section.body.appendChild(unlock);

  const box = el<HTMLDivElement>(`<div class="m-unlock"></div>`);
  box.hidden = true;
  const input = el<HTMLInputElement>(`<input type="password" autocomplete="current-password" spellcheck="false" />`);
  input.placeholder = ui.generate.screensPassEnter;
  const go = el<HTMLButtonElement>(`<button type="button" class="m-primary"></button>`);
  go.textContent = ui.generate.screensUnlock;
  const result = Object.assign(document.createElement("p"), { className: "m-note" });
  box.append(input, go, result);
  section.body.appendChild(box);

  const value = state.querySelector(".m-setting-value")!;
  const paint = (): void => {
    const s = screenCaptionsState();
    if (s.status === "ready") {
      value.textContent = ui.generate.screensOnDeviceCount(screenCaptionsCount());
    } else if (s.status === "unavailable") {
      value.textContent = ui.generate.screensNoCrypto;
    } else if (s.status === "failed") {
      value.textContent = screenErrorText({ error: s.error.message, code: s.error.code, params: s.error.params });
    } else {
      value.textContent = ui.generate.screensLocked;
    }
    unlock.hidden = s.status === "ready" || s.status === "unavailable";
  };
  onScreenCaptions(paint);
  paint();

  unlock.addEventListener("click", () => {
    box.hidden = false;
    result.textContent = "";
    input.focus();
  });
  const tryUnlock = async (): Promise<void> => {
    if (!input.value) return;
    go.disabled = true;
    result.textContent = ui.generate.screensOpening;
    const opened = await unlockScreenCaptions(input.value, false);
    go.disabled = false;
    if (opened.status === "ready") {
      box.hidden = true;
      input.value = "";
      paint();
      return;
    }
    if (opened.status === "failed") {
      result.textContent = screenErrorText({
        error: opened.error.message,
        code: opened.error.code,
        params: opened.error.params,
      });
    }
  };
  go.addEventListener("click", () => void tryUnlock());
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void tryUnlock();
  });
  return section.section;
}

export function renderSettings(): HTMLElement {
  const page = screen("m-settings");
  page.appendChild(pageBar(ui.nav.settings, "", { alwaysTitled: true }));

  const look = group(ui.theme.label);
  look.body.appendChild(renderThemeControl());
  page.appendChild(look.section);

  const language = group(ui.language.label);
  language.body.appendChild(renderContentLanguageControl(ui.language.label));
  page.appendChild(language.section);

  const account = group(ui.mobile.account);
  const who = row(ui.mobile.microsoftAccount, ui.settings.notSignedIn);
  account.body.appendChild(who);
  page.appendChild(account.section);
  void getActiveAccount().then((a) => {
    if (a) who.querySelector(".m-setting-value")!.textContent = a.name || a.username;
  });

  const storage = group(ui.mobile.cache);
  if (isNative) storage.body.appendChild(devicePhotosRow());
  const size = row(ui.mobile.thumbnails, "…");
  storage.body.appendChild(size);
  storage.body.appendChild(Object.assign(document.createElement("p"), { className: "m-note", textContent: ui.mobile.source }));
  page.appendChild(storage.section);
  void cacheStats()
    .then(({ count, bytes }) => {
      size.querySelector(".m-setting-value")!.textContent = ui.mobile.cacheSize(count, (bytes / 1e6).toFixed(1));
    })
    .catch(() => size.remove());

  // Keeping months offline, and seeing how much of the library is already
  // here. The auto pass runs at launch (offline.ts); this is where the reader
  // can watch it, stop it by turning it off, or force it now.
  const offline = group(ui.mobile.offlineGroup);
  const total = allMonths().length;
  const kept = row(ui.mobile.offlineKept, "…");
  offline.body.appendChild(kept);
  const refreshKept = () =>
    void keptStats()
      .then(({ months, bytes }) => {
        const sizeText = bytes ? ` · ${ui.mobile.cacheBytes((bytes / 1e6).toFixed(1))}` : "";
        kept.querySelector(".m-setting-value")!.textContent = ui.mobile.cacheMonths(months, total) + sizeText;
      })
      .catch(() => {});
  refreshKept();

  const auto = document.createElement("input");
  auto.type = "checkbox";
  auto.checked = autoCacheEnabled();
  auto.addEventListener("change", () => setAutoCacheEnabled(auto.checked));
  offline.body.appendChild(row(ui.mobile.autoCache, auto));

  const download = el<HTMLButtonElement>(`<button type="button" class="m-primary"></button>`);
  download.textContent = ui.mobile.cacheNow;
  download.addEventListener("click", () => {
    download.disabled = true;
    void cacheAllNow(allMonths()).finally(() => {
      download.disabled = false;
      refreshKept();
    });
  });
  offline.body.appendChild(download);
  offline.body.appendChild(Object.assign(document.createElement("p"), { className: "m-note", textContent: ui.mobile.autoCacheWhy }));
  page.appendChild(offline.section);

  // The screenshot descriptions are sealed; this is where they are opened.
  page.appendChild(screenCaptionsGroup());

  return page;
}
