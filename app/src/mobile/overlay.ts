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
 *
 * Layers stack only when asked to (`nested`): the viewer's info sheet sits on
 * the viewer, and Back should take off the sheet and leave the photo. Any
 * other layer replaces what is open, without a history step.
 */

interface Layer {
  close: () => void;
  closed?: () => void;
}

const stack: Layer[] = [];

window.addEventListener("popstate", () => {
  const layer = stack.pop();
  if (!layer) return;
  layer.close();
  layer.closed?.();
});

/** Registers an open layer, on top of the open one when `nested`, else in its place. */
export function openLayer(close: () => void, opts: { nested?: boolean } = {}): void {
  if (stack.length && !opts.nested) {
    // Replacing: close everything open and reuse the top entry. (Nothing opens
    // a layer over a nested one today; if something did, the entry under it
    // would cost one Back that visibly does nothing.)
    for (const layer of stack.splice(0).reverse()) layer.close();
    history.replaceState({ mLayer: true }, "");
  } else {
    history.pushState({ mLayer: true }, "");
  }
  stack.push({ close });
}

/**
 * Closes the top layer. Resolves once history has actually stepped back, so a
 * caller that is about to navigate — a day picked from a sheet — does not race
 * the pop and have its own navigation undone.
 */
export function dismiss(): Promise<void> {
  const layer = stack.at(-1);
  if (!layer) return Promise.resolve();
  return new Promise((resolve) => {
    layer.closed = resolve;
    history.back();
  });
}

/** Whether `close` belongs to the layer on top — for a layer that can also be closed from outside. */
export function isTopLayer(close: () => void): boolean {
  return stack.at(-1)?.close === close;
}

export function layerOpen(): boolean {
  return stack.length > 0;
}
