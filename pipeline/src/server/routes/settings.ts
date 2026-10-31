/**
 * The routes that change how this install behaves: autostart, remote access,
 * the screens passphrase, the first-run wizard, appearance, and the restart.
 */

import { getAccessToken, getCachedAccessToken, getPendingDeviceCode, hasCachedAccount } from "../../auth.js";
import { autostartStatus, setAutostart } from "../../autostart.js";
import { env, settingNow } from "../../env.js";
import { allowThroughFirewall, firewallStatus } from "../../firewall.js";
import { GraphError, listChildFolderNames, listFolderFileNames, monthUnder } from "../../graph.js";
import { readOobe, writeOobe } from "../../oobeStore.js";
import { writePrefs } from "../../prefsStore.js";
import { remoteAccessStatus, remotePorts, setRemoteAccess } from "../../remoteAccess.js";
import { planScreenPassphrase, setScreenPassphrase } from "../../screenCaptions.js";
import { passphraseProblem } from "../../screenKey.js";
import { canStorePassphrase, hasStoredPassphrase } from "../../screenKeyStore.js";
import { readSync } from "../../syncStore.js";
import { json, readJsonBody, type Route } from "../http.js";
import * as jobs from "../jobs.js";
import { handOver, planRestart } from "../restart.js";
import { type AppPrefs } from "@travel-archive/shared";
import { isScreenError } from "../../screenErrors.js";
import type { RouteContext } from "./context.js";

/**
 * How a screenshot-passphrase failure is reported.
 *
 * The English text *and* a name for it. The app words these for its own language
 * — see `screenErrors.ts` for why the sentence cannot be written on the server —
 * and falls back to the text when it meets a code it does not know.
 */
function screenFailure(err: unknown): { error: string; code?: string; params?: Record<string, string | number> } {
  if (isScreenError(err)) return { error: err.message, code: err.code, params: err.params };
  return { error: err instanceof Error ? err.message : String(err) };
}

/** The routes, in the order they were written; the dispatcher keeps looking after a method mismatch. */
export const settingsRoutes = (ctx: RouteContext): Route[] => [
  /**
   * Sign-in start-up is asked only by the machine it applies to.
   *
   * The write was already local (`canWrite`); the read answered anyone holding
   * the shared password with absolute paths under the owner's home directory —
   * harmless, and none of a family reader's business. The UI never asks
   * remotely: the section lives in the writable block, so a remote Settings
   * page does not fetch this at all.
   */
  [
    /^\/settings\/autostart$/,
    "GET",
    async (req, res) => {
      if (!ctx.access.isLocal(req)) {
        return json(res, 403, { error: "Sign-in start-up belongs to the machine the server is running on" });
      }
      json(res, 200, await autostartStatus());
    },
  ],

  [
    /^\/settings\/autostart$/,
    "POST",
    async (req, res) => {
      const body = await readJsonBody<{ enabled?: unknown }>(req);
      if (typeof body.enabled !== "boolean") {
        return json(res, 400, { error: "enabled must be true or false" });
      }
      try {
        json(res, 200, await setAutostart(body.enabled));
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    },
  ],
  /**
   * How far the local screenshot pass has got — and whether it could run.
   *
   * Local only, like the sign-in start-up row above and for a stronger reason:
   * these descriptions exist because the screens they describe are nobody
   * else's business, so a remote reader is told nothing at all. The panel that
   * shows this is inside the writable block, so a remote Settings page never asks.
   *
   * Nothing here decrypts any more: the count comes from `/screens/entries`,
   * which the reader asks for itself. This route only answers "can this machine
   * do the pass at all".
   */
  [
    /^\/screens\/status$/,
    "GET",
    async (req, res) => {
      if (!ctx.access.isLocal(req)) {
        return json(res, 403, { error: "Local screenshot descriptions belong to the machine the server is running on" });
      }
      const job = jobs.runningJob();
      json(res, 200, {
        provider: settingNow("SCREENSHOT_PROVIDER") ?? null,
        hasKey: await hasStoredPassphrase(),
        canStore: canStorePassphrase(),
        running: job?.kind === "screens",
      });
    },
  ],
  /**
   * Give this machine the passphrase the descriptions are encrypted under.
   *
   * Its own route rather than a key in `/config`, because it is not a setting
   * that can simply be overwritten: the file on OneDrive is encrypted with a
   * passphrase, so setting one is either the same one (the store was missing
   * it, nothing to re-encrypt) or a new one (re-encrypt in the same breath) —
   * `planScreenPassphrase` reads that from the file. The value goes into the
   * machine's key store, not into `.env`, where it would be plaintext beside
   * the ciphertext. Local only, and it travels one way: it is never sent back.
   */
  [
    /^\/screens\/passphrase$/,
    "POST",
    async (req, res) => {
      if (!ctx.access.isLocal(req)) {
        return json(res, 403, { error: "Local screenshot descriptions belong to the machine the server is running on" });
      }
      const body = await readJsonBody<{ passphrase?: unknown }>(req);
      const raw = typeof body.passphrase === "string" ? body.passphrase : "";
      const problem = passphraseProblem(raw);
      if (problem) return json(res, 400, screenFailure(problem));
      // `?check=1` answers "what would setting this do" and writes nothing.
      // Added after a *test* rotated the real passphrase: a mutation endpoint
      // should not be the only way to ask.
      const checkOnly = new URL(req.url ?? "/", "http://local").searchParams.get("check") === "1";
      try {
        const token = await getAccessToken();
        if (checkOnly) {
          const plan = await planScreenPassphrase(token, raw);
          return json(res, 200, {
            ok: true,
            would: plan.mode,
            described: plan.file ? Object.keys(plan.file.entries).length : 0,
          });
        }
        json(res, 200, await setScreenPassphrase(token, raw));
      } catch (err) {
        json(res, checkOnly ? 409 : 400, screenFailure(err));
      }
    },
  ],
  /**
   * Who may reach this server, as it is running and as it is saved.
   *
   * Readable by anyone who can read the archive — it says whether a password
   * exists, never what it is — and writable only by this machine, like every
   * other setting that changes what the server does. The password travels one
   * way: `null` or an empty string clears it, and neither is ever sent back.
   */
  [
    /^\/settings\/remote$/,
    "GET",
    async (req, res) => json(res, 200, await remoteAccessStatus(ctx.access.isLocal(req))),
  ],
  /**
   * What setup still needs, as the server sees it — plus the device code
   * while one is pending.
   *
   * Loopback only, and deliberately so: the code signs *this* machine's
   * archive into a Microsoft account, so a remote reader holding it could
   * link their own. `/health` keeps answering everyone with the boolean;
   * this route exists for the page that has to show a code.
   */
  [
    /^\/oobe$/,
    "GET",
    async (req, res) => {
      if (!ctx.access.isLocal(req)) return json(res, 403, { error: "Local only" });
      const signedIn = await hasCachedAccount();
      const neverScanned = !(await readSync()).lastScanAt;
      return json(res, 200, {
        signedIn,
        deviceCode: getPendingDeviceCode(),
        photosFolderValidatedAt: (await readOobe()).photosFolderValidatedAt ?? null,
        neverScanned,
        // Only worth asking when everything local says "first run": an account
        // that already has an archive is exactly what makes the wizard
        // unnecessary, and it is the one fact this machine cannot answer alone.
        archiveExists: neverScanned && signedIn ? await ctx.archiveAlreadyExists() : false,
        photosFolder: env.photosFolder,
      });
    },
  ],
  /**
   * Starts the device-code sign-in, if one is not already waiting.
   *
   * The flow blocks until a human enters the code, so the answer to this
   * request is only "the prompt is (re)starting": the page reads the actual
   * code from `GET /oobe`, which is loopback-only for the same reason this
   * one is.
   */
  [
    /^\/oobe\/signin$/,
    "POST",
    async (req, res) => {
      if (!ctx.access.isLocal(req)) return json(res, 403, { error: "Local only" });
      if (getPendingDeviceCode()) return json(res, 202, { pending: true });
      if (await hasCachedAccount()) return json(res, 200, { signedIn: true });
      void getAccessToken()
        .then(() => console.log("  setup: sign-in completed"))
        .catch((err) => console.warn(`  setup sign-in failed: ${(err as Error).message}`));
      return json(res, 202, { pending: true });
    },
  ],
  /**
   * Probes a photo folder; with `confirm`, stamps the configured one as agreed.
   *
   * A missing folder answers `not-found` with **200** — it is an answer, not a
   * transport failure, and the page has to be able to render it. Confirmation
   * writes `photosFolderValidatedAt`: the record that a human agreed to this
   * folder. It does **not** start anything — the first scan runs from the
   * wizard's own last page, because the folder can still be changed while
   * the wizard is open (see `scanIfDue`).
   * The path itself is never written here (it travels through `POST /config`,
   * so there stays one way to change a setting): `path` only *asks* about a
   * candidate, and the stamp is refused for anything but the folder that is
   * actually configured — validating `A` must never agree to `B`.
   */
  [
    /^\/oobe\/folder$/,
    "POST",
    async (req, res) => {
      if (!ctx.access.isLocal(req)) return json(res, 403, { error: "Local only" });
      const body = await readJsonBody<{ confirm?: unknown; path?: unknown }>(req);
      const target = typeof body.path === "string" && body.path.trim() ? body.path.trim() : env.photosFolder;
      const token = await getCachedAccessToken();
      if (!token) return json(res, 200, { state: "no-token", path: target });
      try {
        const names = await listFolderFileNames(token, target);
        // Period folders: top-level `yyyy-mm`/`yyyy` as always, plus bare
        // `01`..`12` when the target itself is a year — the same rule the
        // scan applies (monthUnder), so a green number and a real scan can
        // never disagree again (the 2025-subfolder test showed 0/0 as green).
        const months = names.filter(
          (n) => /^\d{4}-\d{2}$/.test(n) || /^\d{4}$/.test(n) || monthUnder(target, n) !== null,
        ).length;
        if (body.confirm === true && target === env.photosFolder) {
          await writeOobe({ photosFolderValidatedAt: new Date().toISOString() });
        }
        return json(res, 200, { state: "ok", path: target, count: names.length, months });
      } catch (err) {
        if (err instanceof GraphError && err.status === 404) {
          return json(res, 200, { state: "not-found", path: target });
        }
        return json(res, 502, { error: (err as Error).message });
      }
    },
  ],

  [
    /^\/oobe\/folders$/,
    "GET",
    async (req, res) => {
      if (!ctx.access.isLocal(req)) return json(res, 403, { error: "Local only" });
      const path = new URL(req.url ?? "/", "http://localhost").searchParams.get("path") ?? "";
      const token = await getCachedAccessToken();
      if (!token) return json(res, 200, { state: "no-token", path, folders: [] });
      try {
        const folders = await listChildFolderNames(token, path);
        return json(res, 200, { path, folders: folders.slice(0, 500), truncated: folders.length > 500 });
      } catch (err) {
        if (err instanceof GraphError && err.status === 404) {
          return json(res, 200, { state: "not-found", path, folders: [] });
        }
        return json(res, 502, { error: (err as Error).message });
      }
    },
  ],

  [
    /^\/settings\/remote$/,
    "POST",
    async (req, res) => {
      const body = await readJsonBody<{ exposed?: unknown; password?: unknown }>(req);
      if (body.exposed !== undefined && typeof body.exposed !== "boolean") {
        return json(res, 400, { error: "exposed must be true or false" });
      }
      if (body.password !== undefined && body.password !== null && typeof body.password !== "string") {
        return json(res, 400, { error: "password must be a string, null to clear, or absent to leave alone" });
      }
      // An empty box is the same intent as the clear button, not a password
      // nobody could type.
      const password = body.password === "" ? null : body.password;
      try {
        json(
          res,
          200,
          await setRemoteAccess({ exposed: body.exposed as boolean | undefined, password: password as string | null | undefined }),
        );
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    },
  ],
  /**
   * The Windows Firewall rule that lets the phone reach this page and API.
   *
   * Local only: it describes and changes *this machine's* firewall, and a
   * remote reader has neither the standing nor the need to see it. The add is
   * a write like every other, so an exposed server refuses it to anyone but
   * the owner's own machine — before elevation is ever attempted.
   */
  [
    /^\/settings\/firewall$/,
    "GET",
    async (req, res) => {
      if (!ctx.access.isLocal(req)) return json(res, 403, { error: "Local only" });
      json(res, 200, await firewallStatus(remotePorts()));
    },
  ],

  [
    /^\/settings\/firewall\/allow$/,
    "POST",
    async (req, res) => {
      if (!ctx.access.isLocal(req)) return json(res, 403, { error: "Local only" });
      // This request stays open while Windows waits for the UAC answer (or the
      // reader ignores it), which is why the UI says what it is waiting for
      // rather than leaving a button looking dead.
      json(res, 200, await allowThroughFirewall(remotePorts()));
    },
  ],
  /**
   * Restart — the only way a saved remote-access change, or a wedged server,
   * can be applied from where the reader is standing.
   *
   * Answered *before* anything closes: the response has to get out while the
   * listener is still listening, and the handover that follows is allowed to
   * take up to twenty seconds without the client waiting on it.
   */
  [
    /^\/server\/restart$/,
    "POST",
    async (_req, res) => {
      const plan = await planRestart();
      if (!plan.ok) return json(res, 409, plan);
      json(res, 200, { ok: true, restarting: true });
      setTimeout(() => void handOver(plan.entry, ctx.restartHost), 300);
    },
  ],

  [
    /^\/prefs$/,
    "POST",
    async (req, res) => {
      // Validation is `writePrefs`'s, not this route's: the field rules belong
      // beside the file they are written to, and the app is not the only thing
      // that could post here.
      const body = await readJsonBody<Partial<AppPrefs>>(req);
      json(res, 200, await writePrefs(body));
    },
  ],
];
