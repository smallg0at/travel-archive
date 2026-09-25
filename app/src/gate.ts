import { accessStatus, signInShared } from "./backend";
import { ui } from "./i18n";

/**
 * The shared-password gate, shown when the archive is read from another machine.
 *
 * The job server holds the rule (pipeline/src/access.ts): reading needs a
 * password when it is exposed on the network, writing is the owner's machine
 * alone. This is the half the reader sees. It exists as its own screen rather
 * than a banner because without it there would be no archive to show — the
 * server answers 401 to everything, and the app would otherwise report a broken
 * backend, which is exactly what a wrong password is not.
 *
 * **The owner never sees it.** On loopback the server says `gated: false`, and
 * this resolves without a prompt; the same code path just does nothing.
 */

let overlay: HTMLElement | null = null;

function mount(): HTMLElement {
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.className = "gate";
  overlay.innerHTML = `
    <form class="gate-card">
      <h1 class="gate-title"></h1>
      <p class="gate-note"></p>
      <input class="gate-input" type="password" autocomplete="current-password" spellcheck="false" />
      <button class="gate-submit" type="submit"></button>
      <p class="gate-error tone-warn" hidden></p>
    </form>
  `;
  overlay.querySelector(".gate-title")!.textContent = ui.gate.title;
  overlay.querySelector(".gate-note")!.textContent = ui.gate.note;
  (overlay.querySelector(".gate-input") as HTMLInputElement).placeholder = ui.gate.placeholder;
  overlay.querySelector(".gate-submit")!.textContent = ui.gate.submit;
  return overlay;
}

function show(message?: string): void {
  const node = mount();
  const error = node.querySelector<HTMLElement>(".gate-error")!;
  error.hidden = !message;
  if (message) error.textContent = message;
  if (!node.isConnected) document.body.appendChild(node);
  node.querySelector<HTMLInputElement>(".gate-input")!.focus();
}

function hide(): void {
  overlay?.remove();
}

/**
 * Resolves once the archive may be read — immediately when it needs no password.
 *
 * Called before the first render: anything drawn earlier would be an app that
 * cannot fetch a photograph, which is worse than a moment of nothing.
 */
export async function requireAccess(): Promise<void> {
  const status = await accessStatus();
  // No server, or a server that is not gated: nothing to ask. The gate is about
  // a server that exists and refuses, not about one that is absent.
  if (!status?.gated || status.signedIn) return;

  const node = mount();
  const form = node.querySelector<HTMLFormElement>(".gate-card")!;
  const input = node.querySelector<HTMLInputElement>(".gate-input")!;
  const submit = node.querySelector<HTMLButtonElement>(".gate-submit")!;

  await new Promise<void>((resolve) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submit.disabled = true;
      void signInShared(input.value)
        .then(() => {
          hide();
          resolve();
        })
        .catch((err: Error) => {
          // The server's own wording: "Wrong password".
          show(err.message);
          input.select();
          submit.disabled = false;
        });
    });
    show();
  });
}
