import { mountSearch } from "../search";
import { el } from "../photoUi";
import { renderThemeControl } from "../theme";
import { renderContentLanguageControl } from "../contentLang";
import { getActiveAccount } from "../msAuth";
import { cacheStats } from "../thumbCache";
import { ui } from "../i18n";
import { openDate } from "./day";
import { pageBar, screen } from "./ui";

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
  const search = mountSearch({ lazy: true, onOpenDay: (date) => openDate(date) });
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
