/**
 * Full-screen layers — the photo viewer, a bottom sheet — as history steps.
 *
 * On a phone, Back closes whatever is on top. Without a history entry for the
 * layer, Android's back would pop the *page* under an open photo, and the
 * viewer would be left floating over the wrong screen. So opening a layer
 * pushes a state with the same hash (the router ignores it: nothing it routes
 * on has changed), and the popstate that Back produces closes the layer.
 *
 * Closing from a button goes through history too, via `dismiss`, so the entry
 * is consumed rather than left behind for the next Back to find.
 */

interface Layer {
  close: () => void;
  closed?: () => void;
}

let active: Layer | null = null;

window.addEventListener("popstate", () => {
  if (!active) return;
  const layer = active;
  active = null;
  layer.close();
  layer.closed?.();
});

/** Registers an open layer. One at a time: opening a second closes the first without a history step. */
export function openLayer(close: () => void): void {
  if (active) {
    active.close();
    active = null;
    history.replaceState({ mLayer: true }, "");
  } else {
    history.pushState({ mLayer: true }, "");
  }
  active = { close };
}

/**
 * Closes the top layer. Resolves once history has actually stepped back, so a
 * caller that is about to navigate — a day picked from a sheet — does not race
 * the pop and have its own navigation undone.
 */
export function dismiss(): Promise<void> {
  if (!active) return Promise.resolve();
  const layer = active;
  return new Promise((resolve) => {
    layer.closed = resolve;
    history.back();
  });
}

export function layerOpen(): boolean {
  return active !== null;
}
