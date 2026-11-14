/**
 * The licence texts, compiled in rather than fetched.
 *
 * They used to be read at runtime — IPC from `resources/` in the desktop shell,
 * and `fetch("/THIRD-PARTY-NOTICES.md")` everywhere else. The fetch was wrong
 * twice over: the file is not shipped to the web build, and this app's routing
 * answers unknown paths with index.html, so the pane rendered the whole app
 * markup inside a <pre> instead of failing. A `?raw` import has neither
 * problem: one source, resolved at build time, identical on every surface.
 */
import licenseText from "../../LICENSE?raw";
import noticesText from "../../THIRD-PARTY-NOTICES.md?raw";

export const legalText = {
  notices: noticesText,
  license: licenseText,
} as const;
