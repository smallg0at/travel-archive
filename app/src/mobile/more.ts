import { mountSearch } from "../search";
import { el } from "../photoUi";
import { renderThemeControl } from "../theme";
import { renderContentLanguageControl } from "../contentLang";
import { getActiveAccount } from "../msAuth";
import { cacheStats } from "../thumbCache";
import { ui } from "../i18n";
import { openDate } from "./day";
import { openViewer } from "./viewer";
import { note, pageBar, screen } from "./ui";
import { isNative } from "./native";
import { allowDevicePhotos, deviceLibrarySize, deviceStatus } from "./devicePhotos";

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

  return page;
}
