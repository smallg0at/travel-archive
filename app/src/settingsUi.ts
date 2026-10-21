/**
 * The settings page's small pieces.
 *
 * They live here rather than in `settings.ts` because two modules build
 * sections now: the settings page itself, and the section that describes the
 * withheld screenshots. A shared helper that only one of them can reach is a
 * helper that will be copied the first time someone needs it twice.
 */
import { el } from "./photoUi";

/** A titled block on the settings page. */
export function section(title: string): HTMLElement {
  const node = el<HTMLElement>(`<section class="set-section"><h3></h3><div class="set-body"></div></section>`);
  node.querySelector("h3")!.textContent = title;
  return node;
}

/** A label and a value, side by side. */
export function row(label: string, value: string): HTMLElement {
  const node = el<HTMLDivElement>(`<div class="set-row"><span></span><b></b></div>`);
  node.querySelector("span")!.textContent = label;
  node.querySelector("b")!.textContent = value;
  return node;
}

/** Rewrites a row built by `row()`, so a refresh does not rebuild the section. */
export function setRowValue(node: HTMLElement, value: string): void {
  node.querySelector("b")!.textContent = value;
}

/**
 * A row whose value is a file path. Machine text, so it wears `.is-path`
 * instead of the row's headline style: mono, muted, capped and ellipsised at
 * the tail — the head is the part that differs between archive homes, so it
 * is what survives truncation — with the whole line on hover for copying.
 */
export function setPathValue(node: HTMLElement, value: string): void {
  setRowValue(node, value);
  node.classList.add("is-path");
  node.querySelector("b")!.title = value;
}

export function button(label: string, onClick: () => void, kind = ""): HTMLButtonElement {
  const b = el<HTMLButtonElement>(`<button type="button" class="set-btn ${kind}"></button>`);
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

/** A labelled input, for the provider rows. */
export function labelledInput(label: string, control: string): HTMLLabelElement {
  const node = el<HTMLLabelElement>(`<label class="set-scan-field"><span></span></label>`);
  node.querySelector("span")!.textContent = label;
  node.insertAdjacentHTML("beforeend", control);
  return node;
}
