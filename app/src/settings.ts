import type { ArchiveStatus, SyncState, SyncStatus } from "@travel-archive/shared";
import {
  archiveStatus,
  clearCache,
  saveSyncSettings,
  setPin,
  startSync,
  syncStatus,
  watchJob,
  type ConflictChoice,
} from "./backend";
import { el } from "./photoUi";
import { renderDensityControl } from "./album";
import { resetSidebarWidth } from "./chrome";

/**
 * Settings, as a page rather than a popup.
 *
 * It used to be a 230px floating panel holding two controls, which is no longer
 * anywhere near enough: sync needs a status, a resolver and progress, and
 * "what is kept on this device" needs a list. It renders into `#content` like a
 * trip or a month and is reached from the sidebar, which is also what the
 * burger menu was asked to become.
 *
 * Everything here is read from the server. With no server — the phone — the
 * page says so rather than showing dead controls, since the archive is still
 * perfectly readable without one.
 */

const STATE_LABEL: Record<SyncState, string> = {
  "in-sync": "In sync",
  behind: "OneDrive has newer changes",
  ahead: "This device has changes not uploaded",
  conflict: "Both changed since the last sync",
  "never-synced": "Never synced",
  offline: "Not signed in",
};

/** Green for settled, amber for "something to do", red only for a real decision. */
const STATE_TONE: Record<SyncState, string> = {
  "in-sync": "ok",
  behind: "warn",
  ahead: "warn",
  conflict: "bad",
  "never-synced": "warn",
  offline: "muted",
};

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function relative(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

function section(title: string): HTMLElement {
  const node = el<HTMLElement>(`<section class="set-section"><h3></h3><div class="set-body"></div></section>`);
  node.querySelector("h3")!.textContent = title;
  return node;
}

function row(label: string, value: string): HTMLElement {
  const node = el<HTMLDivElement>(`<div class="set-row"><span></span><b></b></div>`);
  node.querySelector("span")!.textContent = label;
  node.querySelector("b")!.textContent = value;
  return node;
}

function button(label: string, onClick: () => void, kind = ""): HTMLButtonElement {
  const b = el<HTMLButtonElement>(`<button type="button" class="set-btn ${kind}"></button>`);
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

/**
 * The conflict resolver.
 *
 * Two choices, each named for what it does to the data rather than which side
 * it prefers — "keep local" never says whether the other copy survives, and
 * both of these destroy one copy. Shown with both timestamps so the choice is
 * informed rather than a coin toss.
 */
function conflictBlock(status: SyncStatus, rerun: (r: ConflictChoice) => void): HTMLElement {
  const box = el<HTMLElement>(`
    <div class="set-conflict">
      <p class="set-conflict-lead"></p>
      <div class="set-conflict-sides"></div>
      <div class="set-conflict-actions"></div>
    </div>
  `);
  box.querySelector(".set-conflict-lead")!.textContent =
    "Both this device and OneDrive changed since the last sync. Choose which copy survives — this is not merged.";

  const sides = box.querySelector(".set-conflict-sides")!;
  sides.appendChild(row("This device", relative(status.localGeneratedAt)));
  sides.appendChild(row("OneDrive", relative(status.remoteLastModified)));

  const actions = box.querySelector(".set-conflict-actions")!;
  actions.appendChild(button("Upload mine (overwrites OneDrive)", () => rerun("upload-mine"), "danger"));
  actions.appendChild(button("Replace mine (discards local changes)", () => rerun("replace-mine"), "danger"));
  return box;
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;

/** Stops the panel's polling. Called when the view changes. */
export function releaseSettings(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

export async function showSettings(): Promise<void> {
  const content = document.getElementById("content")!;
  releaseSettings();
  content.replaceChildren(el(`<div class="loading">Loading settings…</div>`));

  const [sync, archive] = await Promise.all([syncStatus(), archiveStatus()]);
  const frag = document.createDocumentFragment();
  frag.appendChild(el(`<div class="month-heading"><h1>Settings</h1><span></span></div>`));

  if (!sync) {
    // No backend. Not an error state: the archive reads from OneDrive and the
    // phone lives here permanently.
    const none = section("Local server");
    none.querySelector(".set-body")!.append(
      el(
        `<p class="set-note">No local server is running, so the archive is being read directly from OneDrive and images are cached in this browser only. Sync, pinning and generation need the desktop app.</p>`,
      ),
    );
    frag.appendChild(none);
    content.replaceChildren(frag);
    return;
  }

  frag.appendChild(librarySection(archive));
  frag.appendChild(syncSection(sync));
  frag.appendChild(offlineSection(sync));
  frag.appendChild(storageSection(sync));
  frag.appendChild(appearanceSection());

  content.replaceChildren(frag);

  // The status changes underneath while a sync runs; a page showing "Behind"
  // after it finished would be worse than no page.
  refreshTimer = setInterval(() => {
    if (!document.querySelector(".set-section")) return releaseSettings();
    void syncStatus().then((next) => {
      if (!next) return;
      const stale = document.querySelector(".set-sync-state");
      if (stale) applyState(stale as HTMLElement, next);
    });
  }, 5000);
}

function applyState(node: HTMLElement, status: SyncStatus): void {
  node.textContent = STATE_LABEL[status.state];
  node.className = `set-sync-state tone-${STATE_TONE[status.state]}`;
}

function librarySection(archive: ArchiveStatus | null): HTMLElement {
  const s = section("Library");
  const body = s.querySelector(".set-body")!;
  if (!archive?.signedIn) {
    body.appendChild(el(`<p class="set-note">Not signed in.</p>`));
    return s;
  }
  body.appendChild(row("Photos", archive.totals.photos.toLocaleString()));
  body.appendChild(row("Described by AI", archive.totals.analyzed.toLocaleString()));
  body.appendChild(row("Days summarised", archive.totals.days.toLocaleString()));
  body.appendChild(row("Trips and months", archive.totals.sections.toLocaleString()));
  body.appendChild(row("Schema version", `v${archive.schemaVersion}`));
  return s;
}

function syncSection(status: SyncStatus): HTMLElement {
  const s = section("Sync");
  const body = s.querySelector(".set-body")!;

  const state = el<HTMLElement>(`<div class="set-sync-state"></div>`);
  applyState(state, status);
  body.appendChild(state);
  body.appendChild(row("Last checked", relative(status.checkedAt)));
  body.appendChild(row("Last synced", relative(status.syncedAt)));

  const progress = el<HTMLDivElement>(`<div class="set-progress" hidden></div>`);

  const run = (resolve?: ConflictChoice) => {
    progress.hidden = false;
    progress.textContent = "Starting…";
    void startSync(resolve ? { resolve } : {})
      .then((job) => {
        const stop = watchJob(job.id, (j) => {
          const p = j.progress;
          progress.textContent =
            j.status === "running"
              ? `${p.message ?? p.phase}${p.total ? ` — ${p.done} of ${p.total}` : ""}`
              : j.status === "failed"
                ? `Failed: ${j.error}`
                : "Sync complete.";
          if (j.status !== "running" && j.status !== "queued") {
            stop();
            void showSettings();
          }
        });
      })
      .catch((err: Error) => (progress.textContent = err.message));
  };

  const actions = el<HTMLDivElement>(`<div class="set-actions"></div>`);
  actions.appendChild(button("Check now", () => run(), ""));
  if (status.state !== "conflict") actions.appendChild(button("Sync now", () => run(), "primary"));
  body.appendChild(actions);

  if (status.state === "conflict") body.appendChild(conflictBlock(status, run));
  body.appendChild(progress);
  return s;
}

function offlineSection(status: SyncStatus): HTMLElement {
  const s = section("Kept on this device");
  const body = s.querySelector(".set-body")!;

  if (status.pins.length === 0) {
    body.appendChild(
      el(
        `<p class="set-note">Nothing is pinned. Pin a trip or a month in the sidebar to keep its photos on this device — they are fetched when you sync and are never evicted to make room.</p>`,
      ),
    );
  } else {
    for (const pin of status.pins) {
      const r = el<HTMLDivElement>(`<div class="set-row set-pin"><span></span></div>`);
      r.querySelector("span")!.textContent = `${pin.kind === "trip" ? "Trip" : "Month"} · ${pin.id}${pin.originals ? " · with originals" : ""}`;
      r.appendChild(
        button("Unpin", () => {
          void setPin({ ...pin, pinned: false }).then(() => showSettings());
        }),
      );
      body.appendChild(r);
    }
  }

  const auto = el<HTMLLabelElement>(
    `<label class="set-check"><input type="checkbox"><span>Check for changes when the app starts</span></label>`,
  );
  const box = auto.querySelector("input") as HTMLInputElement;
  box.checked = true;
  box.addEventListener("change", () => void saveSyncSettings({ autoSyncOnLaunch: box.checked }));
  body.appendChild(auto);
  return s;
}

function appearanceSection(): HTMLElement {
  const s = section("Appearance");
  const body = s.querySelector(".set-body")!;

  const density = el<HTMLDivElement>(`<div class="set-row"><span>Thumbnail size</span></div>`);
  density.appendChild(renderDensityControl());
  body.appendChild(density);

  const sidebar = el<HTMLDivElement>(`<div class="set-row"><span>Sidebar width</span></div>`);
  sidebar.appendChild(button("Reset", resetSidebarWidth));
  body.appendChild(sidebar);
  return s;
}

function storageSection(status: SyncStatus): HTMLElement {
  const s = section("Local storage");
  const body = s.querySelector(".set-body")!;
  const { metadataBytes, thumbnails, originals } = status.storage;

  body.appendChild(row("Archive metadata", mb(metadataBytes)));
  const files = (n: number) => `${n.toLocaleString()} file${n === 1 ? "" : "s"}`;
  body.appendChild(row("Thumbnails", `${files(thumbnails.count)} · ${mb(thumbnails.bytes)}`));
  body.appendChild(row("Full-size photos", `${files(originals.count)} · ${mb(originals.bytes)}`));
  body.appendChild(row("Total", mb(metadataBytes + thumbnails.bytes + originals.bytes)));

  const actions = el<HTMLDivElement>(`<div class="set-actions"></div>`);
  // Pinned files survive: clearing a cache must not silently undo "keep this".
  for (const [label, category] of [
    ["Clear thumbnails", "thumbnails"],
    ["Clear full-size photos", "originals"],
  ] as const) {
    actions.appendChild(
      button(label, () => {
        void clearCache(category).then(() => showSettings());
      }),
    );
  }
  body.appendChild(actions);
  body.appendChild(
    el(`<p class="set-note">Pinned items are kept even when clearing. Anything else is fetched again when needed.</p>`),
  );
  return s;
}
