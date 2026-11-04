/**
 * Whether this page is the installed app or a browser.
 *
 * Read off Capacitor's own global rather than through `mobile/native.ts`,
 * which pulls the router and the theme with it: this is asked by modules the
 * desktop page also imports.
 */
export const isPhoneSurface =
  (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.() === true;
