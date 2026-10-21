/**
 * One place that knows what a model service is, and one place that offers one.
 *
 * Two screens choose a model: Settings' Generation table (the archive's model,
 * every service) and Settings' screenshot section (a service on this machine,
 * and nothing else). The rules that matter — a local service needs no key, a
 * cloud one does; a check reports and never gates — and the wording that says
 * so must live once, or the same service gets two different stories depending
 * on where the reader looks. The rows live here for the same reason: one
 * implementation, two instances, and only the list of candidates differs.
 */
import type { ConfigStatus, ProviderOption } from "@travel-archive/shared";
import { ui } from "./i18n";
import { getConfig, saveConfig, validateGeneration } from "./backend";
import { el } from "./photoUi";
import { button, labelledInput } from "./settingsUi";

/** A provider's name in the reader's language; keyed by the stable preset id. */
export function providerName(option: ProviderOption): string {
  return (ui.settings.providers as Record<string, string>)[option.id] ?? option.label;
}

/** Whether a service can be used as it stands, and how to say it without lying. */
export function keyState(option: ProviderOption): { text: string; warn: boolean } {
  if (option.hasKey) return { text: ui.settings.providerKeySet, warn: false };
  // A local service is ready without a key: saying "no key" about LM Studio is
  // the same lie as asking it for one.
  if (option.scope === "local") return { text: ui.settings.providerLocalNoKey, warn: false };
  return { text: ui.settings.providerKeyMissing, warn: true };
}

/** Whether this service would work right now, key or no key. */
export function usableAsIs(option: ProviderOption | undefined): boolean {
  return !!option && (option.hasKey || option.scope === "local");
}

/** The services that run on this machine — the only ones a local pass may use. */
export function localOptions(providers: ProviderOption[]): ProviderOption[] {
  return providers.filter((p) => p.scope === "local");
}

/**
 * Ask a service whether it answers, as one line ready to show. Never a gate: a
 * service that happens to be down should still be saveable.
 */
export async function checkProvider(id: string, typedKey?: string): Promise<{ text: string; warn: boolean }> {
  const result = await validateGeneration(id, typedKey);
  if (result.ok) return { text: ui.settings.providerCheckOk, warn: false };
  if (result.kind === "auth") return { text: ui.setup.keyRejected(result.detail), warn: true };
  return { text: ui.settings.providerCheckUnreachable(result.detail), warn: true };
}

/** A group of services, under the heading that names where they run. */
function providerGroup(title: string): HTMLDivElement {
  const root = el<HTMLDivElement>(`<div class="set-provider-group"></div>`);
  const heading = el<HTMLHeadingElement>(`<h3 class="set-provider-group-title"></h3>`);
  heading.textContent = title;
  root.append(heading);
  return root;
}

export interface ProviderChoiceOptions {
  /**
   * The variable the choice is written to: `AI_PROVIDER` for the archive's
   * model, `SCREENSHOT_PROVIDER` for the one that describes the withheld
   * screenshots. The per-service fields (endpoint, model, key) are the same
   * either way — they are the service's own settings, not the choice's.
   */
  envVar: string;
  /** Offer only the services that run on this machine. */
  scope?: "local";
  /**
   * The service in force, if the caller knows it. It is given the settings the
   * server reported, because the archive's own model is one of them and the
   * caller should not have to fetch it a second time.
   *
   * It may name a service the server did not report — the screenshot section
   * reads `SCREENSHOT_PROVIDER`, which is a different variable from the
   * archive's own model — and then no row is drawn as in force and the status
   * line says the service in force is not one of these, rather than calling it
   * "unavailable", which would be false of a service this page cannot see.
   */
  value?: (config: ConfigStatus) => string | null;
  /**
   * What to say when the service in force is not one of the rows. Left out,
   * the chooser says the service is unavailable, which is true of a service it
   * cannot see and false of one the server simply has not been told about.
   */
  unknownService?: string;
  /** The line above the rows. */
  note?: string;
  /** Told after a service is saved, so the page can repaint. */
  onSaved?(config: ConfigStatus | null): void;
}

export interface ProviderChoice {
  /** The rows, to be put in a section. */
  el: HTMLElement;
  /** Asks the server for the settings again and repaints. */
  refresh(): void;
}

/**
 * The chooser: one collapsible row per service, grouped by where it runs.
 *
 * A row is a header (name, whether it is in force, whether it has a key) that
 * opens in place to its fields; only one is open at a time. The group is the
 * `scope` the server reports, not a guess from the id. Keeping the inputs
 * mounted means one save can repaint the others without the reader losing
 * half-typed text.
 */
export function providerChoice(opts: ProviderChoiceOptions): ProviderChoice {
  const root = el<HTMLDivElement>(`<div class="set-provider-choice"></div>`);
  const state = el<HTMLElement>(`<div class="set-sync-state"></div>`);
  root.appendChild(state);

  const note = el<HTMLParagraphElement>(`<p class="set-note"></p>`);
  note.textContent = opts.note ?? ui.settings.providerTableNote;
  root.appendChild(note);

  const groups = {
    local: providerGroup(ui.settings.providersLocal),
    cloud: providerGroup(ui.settings.providersCloud),
  };
  root.append(groups.local, groups.cloud);

  /**
   * One collapsible row per backend, built once, then updated in place.
   */
  interface Row {
    id: string;
    scope: "local" | "cloud";
    root: HTMLDivElement;
    head: HTMLButtonElement;
    panel: HTMLDivElement;
    keyInput: HTMLInputElement;
    note: HTMLElement;
    summary: HTMLElement;
    badge: HTMLElement;
    button: HTMLButtonElement;
    expanded: boolean;
    paint: (option: ProviderOption, active: boolean) => void;
  }
  const rows: Row[] = [];

  let openRow: Row | null = null;
  const setExpanded = (row: Row, expand: boolean) => {
    row.expanded = expand;
    row.panel.hidden = !expand;
    row.head.setAttribute("aria-expanded", String(expand));
    row.root.classList.toggle("is-open", expand);
    if (expand) openRow = row;
    else if (openRow === row) openRow = null;
  };

  const makeRow = (scope: "local" | "cloud"): Row => {
    const rowRoot = el<HTMLDivElement>(`<div class="set-provider"></div>`);
    const head = el<HTMLButtonElement>(
      `<button type="button" class="set-provider-head" aria-expanded="false"></button>`,
    );
    const name = el<HTMLSpanElement>(`<span class="set-provider-name"></span>`);
    const badge = el<HTMLSpanElement>(`<span class="set-provider-badge"></span>`);
    const summary = el<HTMLSpanElement>(`<span class="set-provider-summary"></span>`);
    const chevron = el<HTMLSpanElement>(`<span class="set-provider-chevron" aria-hidden="true">›</span>`);
    head.append(name, badge, summary, chevron);

    const panel = el<HTMLDivElement>(`<div class="set-provider-panel" hidden></div>`);
    const fields = el<HTMLDivElement>(`<div class="set-provider-fields"></div>`);
    const urlField = labelledInput(ui.settings.providerBaseUrl, `<input type="text" name="baseUrl" spellcheck="false" />`);
    const modelField = labelledInput(ui.settings.providerModel, `<input type="text" name="model" spellcheck="false" />`);
    const keyField = labelledInput(
      ui.settings.apiKey,
      `<input type="password" name="key" autocomplete="off" spellcheck="false" />`,
    );
    fields.append(urlField, modelField, keyField);

    const rowNote = el<HTMLElement>(`<p class="set-note"></p>`);
    // Where the key comes from, the same link the wizard offers: a provider
    // row asking for a key without saying where to get one is half a row.
    const getKey = el<HTMLAnchorElement>(`<a class="setup-link" target="_blank" rel="noreferrer" hidden></a>`);
    getKey.textContent = ui.setup.platformLink;
    const status = el<HTMLDivElement>(`<div class="set-progress" hidden></div>`);
    const actions = el<HTMLDivElement>(`<div class="set-provider-actions"></div>`);
    const checkButton = button(ui.settings.providerCheck, () => void check());
    const useButton = button(ui.settings.providerSaveUse, () => {}, "primary");
    actions.append(checkButton, useButton);
    panel.append(fields, rowNote, getKey, status, actions);
    rowRoot.append(head, panel);
    groups[scope].appendChild(rowRoot);

    const urlInput = urlField.querySelector("input") as HTMLInputElement;
    const modelInput = modelField.querySelector("input") as HTMLInputElement;
    const keyInput = keyField.querySelector("input") as HTMLInputElement;

    const row: Row = {
      id: "",
      scope,
      root: rowRoot,
      head,
      panel,
      keyInput,
      note: rowNote,
      summary,
      badge,
      button: useButton,
      expanded: false,
      paint(option, active) {
        row.id = option.id;
        name.textContent = providerName(option);
        badge.textContent = active ? ui.settings.providerActive : "";
        badge.hidden = !active;
        badge.classList.toggle("tone-ok", active);
        rowRoot.classList.toggle("is-active", active);
        // The collapsed header carries the one thing worth seeing without
        // opening it: whether this backend can be used as it stands, key or no
        // key.
        const key = keyState(option);
        summary.textContent = key.text;
        summary.classList.toggle("tone-warn", key.warn);
        // The endpoint only means something for an OpenAI-compatible service —
        // Gemini's own client has it baked in.
        urlField.hidden = !option.editable.baseUrl;
        urlInput.value = option.baseUrl ?? "";
        modelInput.value = option.model;
        urlInput.placeholder = option.baseUrl ?? "";
        keyInput.placeholder = option.hasKey ? ui.settings.keySaved : ui.settings.keyPaste;
        const batch = option.supportsBatch ? ui.settings.providerBatchOk : ui.settings.providerNoBatch;
        rowNote.textContent = `${key.text} · ${batch}`;
        rowNote.classList.toggle("tone-warn", key.warn);
        getKey.hidden = !option.platformUrl;
        if (option.platformUrl) getKey.href = option.platformUrl;
        // Never disabled, not even for the backend already in use: its key or
        // model is exactly what one comes here to fix, and a disabled button
        // with no reason reads as a broken page.
      },
    };

    /**
     * A check the reader asks for, not a gate: it reports what the provider
     * answered and never blocks saving — a wrong key is the reader's to fix,
     * and a service that happens to be down should not stop them either.
     */
    const check = async () => {
      const typed = keyInput.value.trim();
      status.hidden = false;
      status.classList.remove("tone-warn");
      status.textContent = ui.settings.providerCheckBusy;
      const result = await checkProvider(row.id, typed || undefined);
      status.textContent = result.text;
      status.classList.toggle("tone-warn", result.warn);
    };

    head.addEventListener("click", () => {
      const expand = !row.expanded;
      if (expand && openRow && openRow !== row) setExpanded(openRow, false);
      setExpanded(row, expand);
    });
    keyInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") useButton.click();
    });
    return row;
  };

  let latest: ConfigStatus | null = null;

  /** The services this instance offers. */
  const candidates = (): ProviderOption[] => {
    const all = latest?.providers ?? [];
    return opts.scope === "local" ? localOptions(all) : all;
  };

  const render = () => {
    if (!latest) {
      state.textContent = ui.settings.unavailable;
      state.className = "set-sync-state tone-muted";
      return;
    }
    const activeId = opts.value ? opts.value(latest) : null;
    const active = candidates().find((p) => p.id === activeId);
    // A local service is ready without a key: saying "no key" of LM Studio is
    // the same lie as asking it for one.
    const usable = !!active && (active.hasKey || active.scope === "local");
    // Three states, not two: nothing chosen, a service the server named that
    // is not on offer here, and a service that is in force and usable. The
    // middle one is the screenshot section's — the service in force there is
    // chosen in a different place, so it is not necessarily one of these rows.
    state.textContent = !activeId
      ? ui.settings.noServiceChosen
      : usable
        ? `${providerName(active)} · ${ui.settings.ready}`
        : active
          ? ui.settings.noKey
          : (opts.unknownService ?? ui.settings.unavailable);
    state.className = `set-sync-state tone-${usable ? "ok" : "warn"}`;

    // Rows exist for every provider the server knows, created on first sight
    // into the group its scope names, so the order within a group is the
    // server's.
    for (const option of candidates()) {
      let row = rows.find((r) => r.id === option.id);
      if (!row) {
        row = makeRow(option.scope ?? "cloud");
        rows.push(row);
        row.button.addEventListener("click", () => void save(row!));
      }
      row.paint(option, option.id === activeId);
    }
    groups.local.hidden = !candidates().some((p) => p.scope === "local");
    groups.cloud.hidden = !candidates().some((p) => p.scope === "cloud");
  };

  /**
   * Writes one row. Only the fields that row uses, so saving DeepSeek cannot
   * blank Gemini's model, and vice versa.
   */
  const save = async (row: Row) => {
    if (!latest) return;
    const option = latest.providers.find((p) => p.id === row.id);
    if (!option) return;
    const rowRoot = row.root;
    const key = row.keyInput;
    const url = rowRoot.querySelector<HTMLInputElement>('input[name="baseUrl"]')!;
    const model = rowRoot.querySelector<HTMLInputElement>('input[name="model"]')!;
    const status = rowRoot.querySelector<HTMLElement>(".set-progress")!;

    const patch: Record<string, string> = { [opts.envVar]: option.id };
    const prefix = option.id.toUpperCase();
    if (option.editable.baseUrl && url.value.trim()) patch[`${prefix}_BASE_URL`] = url.value.trim();
    if (option.editable.model && model.value.trim()) patch[`${prefix}_MODEL`] = model.value.trim();
    // Write a model for Gemini too, under the name its own code reads.
    if (option.id === "gemini" && model.value.trim()) patch.GEMINI_MODEL = model.value.trim();
    const typed = key.value.trim();
    if (typed) patch[option.apiKeyEnv] = typed;

    status.hidden = false;
    status.textContent = ui.common.saving;
    row.button.disabled = true;
    try {
      const next = await saveConfig(patch);
      key.value = "";
      status.textContent = next.ready ? ui.settings.savedReady : ui.settings.saved;
      latest = next;
      opts.onSaved?.(next);
      render();
      setExpanded(row, false);
    } catch (err) {
      status.textContent = (err as Error).message;
      row.button.disabled = false;
    }
  };

  const load = async () => {
    latest = await getConfig();
    render();
  };

  render();
  void load();
  return { el: root, refresh: () => void load() };
}

