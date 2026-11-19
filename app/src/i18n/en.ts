import type { AnalyzeBatchState, JobKind, JobStatus, SyncState } from "@travel-archive/shared";
import { millions, num } from "./format";

/**
 * The interface in English — the source every other language is checked
 * against. `Messages` is this object's type, so a translation missing a key, or
 * with a function where a string belongs, does not compile.
 *
 * Anything with a number in it is a function, which is where the plural lives:
 * English has two forms, Chinese one, and neither needs a rule engine.
 */

const count = (n: number, one: string, many: string) => `${num(n)} ${n === 1 ? one : many}`;

export const en = {
  app: {
    title: "Photo Archive",
    signInPrompt: "Sign in to load your photos",
    signInButton: "Sign in with Microsoft",
    resizeHandle: "Drag to resize, or double-click to reset",
    loadingArchive: "Loading archive",
    signInToLoadArchive: "Sign in to load your archive",
    loadGap: "This part of the archive is not on this machine yet; it is fetching from OneDrive. Reload in a moment.",
    failedToLoad: (message: string) => `Failed to load archive: ${message}`,
    failedToStart: (message: string) => `Failed to start: ${message}`,
    emptyArchiveHtml: `The archive is empty. Check the photos folder under Settings → Library and scan again.`,
  },

  /**
   * The pipeline's phase ids in words. These are stable identifiers, not
   * prose, so this is a lookup rather than a translation of a sentence — and
   * the English table stays the source of the key set, so a language missing
   * one does not compile. An id no table has met yet renders as itself (see
   * `jobPhase`), which is how a new phase shows up instead of showing blank.
   */
  jobPhases: {
    starting: "Starting",
    "signing-in": "Waiting for sign-in",
    loading: "Loading",
    listing: "Listing folders",
    saving: "Writing",
    done: "Done",
    cancelled: "Cancelled",
    geocoding: "Locating",
    analyzing: "Analyzing",
    planning: "Planning",
    downloading: "Downloading",
    uploading: "Uploading",
    preparing: "Preparing",
    merging: "Merging",
    summarizing: "Summarizing",
    narrating: "Writing the trip",
    translating: "Translating",
    checking: "Checking",
    pulling: "Pulling",
    pushing: "Pushing",
    media: "Fetching photos",
  },

  common: {
    save: "Save",
    saving: "Saving",
    cancel: "Cancel",
    close: "Close",
    back: "Back",
    edit: "Edit",
    fit: "Fit",
    date: "Date",
    from: "From",
    to: "To",
    reset: "Reset",
    starting: "Starting",
    checking: "Checking",
    everything: "Everything",
    photos: (n: number) => count(n, "photo", "photos"),
    days: (n: number) => count(n, "day", "days"),
    loading: (what: string) => `Loading ${what}`,
    signInToLoad: (what: string) => `Sign in to load ${what}`,
  },

  nav: {
    home: "Home",
    trips: "Trips",
    generate: "Generate",
    activity: "Activity",
    search: "Search",
    settings: "Settings",
    savePdf: "Save as PDF",
    kept: "▣ Kept on this device",
    keep: "☁ Keep on this device",
    keptTitle: "Kept copies on this device are never removed to free space",
    keepTitle: "Download these photos as a kept copy on this device",
  },

  album: {
    /** The banner over a day that went somewhere and came home the same night. */
    dayOut: "Day out",
    dayOutFar: (km: string) => `${km} km from home`,
    /** Reading a day out: its written page, or the plain grid every other day shows. */
    dayMode: { label: "How to show this day", trip: "Trip", gallery: "Gallery" },
    undated: "Undated",
    /**
     * Named for what it does. It sets the grid's spacing, not the size of a
     * thumbnail: every grid thumbnail is fetched at Graph's `large` (800px)
     * regardless, and only the cell is sized — see album.ts.
     */
    gridDensity: "Grid density",
    /** Hover text on a cell whose picture nothing can render — see photoUi.ts. */
    noPreview: "No preview for this photo",
    /** A cell whose bytes could not be fetched (as opposed to a photo that has none). */
    retry: "Click to try again",
    /** Top strip, shown only while reads are failing — see contentStatus.ts. */
    contentOffline: "You are offline; only kept copies on this device can be shown",
    contentRemote:
      "OneDrive is not returning photos right now. Check the service status before assuming the archive is at fault.",
    contentCheckStatus: "Service status",
    contents: "Contents",
    density: { compact: "Small", comfortable: "Medium", spacious: "Large" },
  },

  day: {
    morePhotos: (n: number) => `${num(n)} more ${n === 1 ? "photo" : "photos"}`,
    originalText: "Original text",
    fromPlacards: (n: number) => (n === 1 ? "From the placard" : `From ${num(n)} placards`),
  },

  viewer: {
    thisPhoto: "This photo",
    transcribed: "Transcribed text",
    tags: "Tags",
    loadingFull: "Loading original",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    copy: "Copy",
    copying: "Preparing",
    copied: "Copied",
    copyFailed: "Couldn't copy",
    copyTitle: "Copy this photo to the clipboard",
  },

  edit: {
    noteLabel: "Note for the summarizer (kept and used every time this day is rewritten)",
    notePlaceholder: "e.g. the 11:00 stop is the railway museum; nothing planned in the morning",
    summaryLabel: "Day summary",
    rewrite: "Rewrite this day",
    nothingChanged: "Nothing changed",
    saved: "Saved",
    savedStale: "Saved. Because the note changed, the next day-summaries run will rewrite this day (or press Rewrite this day).",
    rewriting: "Rewriting",
    rewriteCancelled: "Rewrite cancelled",
    rewriteFailed: (message: string) => `Rewrite failed: ${message}`,
    unknownError: "unknown error",
    renameTrip: "Rename trip",
    deleteTrip: "Delete trip",
    confirmDeleteTrip: "Press again to delete (its days and photos stay)",
    tripNameLabel: "Trip name",
    editTripStory: "Edit the text",
    tripStoryLabel: "Trip story",
    tripStoryNote:
      "Your own text for this trip in the current language. Translation and regeneration leave it untouched until you replace it.",
    tripStoryCleared: "Cleared. Save to hand the text back to the model.",
    regenerate: "Write it again",
    regenerateNote:
      "Add context the photos cannot show (where a place was or why the day mattered) and rewrite the story. This replaces the current text.",
    regenerateNotesLabel: "Anything to add (optional)",
    regenerateRun: "Write the story",
    rewritten: "Rewritten",
    rename: "Rename",
    stopSummaryPlaceholder: "What happened here (optional)",
  },

  time: {
    notKnown: "Not known",
    hourLabel: "Time (hour)",
    set: "Set the time",
    change: "Change the time",
    note: "Renames the file in OneDrive, so it survives a rescan. To set several at once, Ctrl-click them in the day's grid.",
    savedAs: (fileName: string) => `Saved as ${fileName}`,
    pickDate: "Pick a date first",
  },

  retime: {
    toolbar: "Set the time of the selected photos",
    hour: "Hour",
    setTime: "Set time",
    clear: "Clear",
    selected: (n: number) => `${num(n)} selected`,
    tooMany: "At most 60 photos fit in one hour, one minute apart; select fewer or choose “Not known”",
    saving: (n: number) => `Saving ${num(n)}`,
    result: (set: number, refused: number, firstError: string | null) => {
      const done = `Set ${count(set, "photo", "photos")}.`;
      return refused ? `${done} ${num(refused)} refused: ${firstError}` : `${done} The day regroups on the next reload.`;
    },
  },

  print: {
    preparing: (done: number, total: number) => `Preparing ${count(total, "photo", "photos")} (${num(done)} of ${num(total)})`,
    sizing: (done: number, total: number) => `Sizing ${count(total, "photo", "photos")} (${num(done)} of ${num(total)})`,
    savingPdf: "Saving the PDF",
    openingPrint: "Opening the print dialog",
    waitingForWindow: "Bring this window to the front to print",
    exportFailed: (error: string) => `Export failed: ${error}`,
  },

  server: {
    offline:
      "Local server is offline, so the app is reading straight from OneDrive and will run slower. Start it with npm run desktop.",
    back: "The local server is running again. Reload to use it.",
    lost: "The local server stopped responding. Reload to switch to fallback mode.",
    gated: "The archive server needs the access password again. Reload to enter it.",
    reload: "Reload",
  },

  gate: {
    title: "Photo Archive",
    note: "This archive is shared on the home network. Enter the password to view it; nothing can be changed from this device.",
    placeholder: "Shared password",
    submit: "Open",
    mobileVersion: "Open the phone version",
    desktopVersion: "Open the desktop version",
  },

  home: {
    inView: (photos: number, places: number) => `${count(photos, "photo", "photos")} in ${count(places, "place", "places")} in view`,
    openDay: "Open this day",
    title: "Everywhere",
    mapLabel: "A world map of every place in this archive",
    totals: (photos: number, places: number, countries: number) =>
      `${num(photos)} photos across ${num(places)} places in ${count(countries, "country", "countries")}`,
    noMap: "No places yet; run Scan, then Day summaries, to show this library on the map",
    photos: (n: number) => count(n, "photo", "photos"),
    placeMeta: (photos: number, days: number) => `${count(photos, "photo", "photos")} on ${count(days, "day", "days")}`,
    thenTitle: "On this day",
    thenNearTitle: "Around this time",
    nothingToday: "No photos on or near this date in any year",
    yearsAgo: (n: number) => (n === 0 ? "this year" : n === 1 ? "a year ago" : `${num(n)} years ago`),
  },

  map: {
    loading: "Loading map",
    label: (trip: string) => `Cities visited on ${trip}`,
    unnamed: "Unnamed stop",
    expand: "Expand",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    /** A cluster on the home map: its biggest place, and how many more it holds. */
    clusterMore: (biggest: string, more: number) => `${biggest} +${num(more)}`, /* User fix. */
    /** A cluster across borders, by its countries, most photos first. */
    clusterCountries: (countries: string[]) =>
      countries.length <= 2 ? countries.join(" & ") : `${countries.slice(0, 2).join(", ")} +${num(countries.length - 2)}`,
  },

  theme: { label: "Theme", light: "Light", dark: "Dark", system: "System" },

  language: { label: "Language" },

  setup: {
    loading: "Preparing setup",
    title: "Set up your photo archive",
    langTitle: "Language",
    signTitle: "Sign in the archive server",
    signNote: "Scanning, thumbnails, and all jobs run through the archive server and require one Microsoft sign-in",
    signedIn: "Signed in",
    signingIn: "Waiting for authorization",
    signInBtn: "Sign in with Microsoft",
    codeHint: "Open this link in a browser and enter the code:",
    continue: "Continue",
    needSignIn: "Sign in to continue",
    folderTitle: "Photo folder",
    check: "Confirm",
    browse: "Browse",
    monthHint: "Expected layout: yyyy-mm (or yyyy/mm) subfolders",
    change: "Change",
    checking: "Confirming",
    folderExists: (count: number, months: number) => `Exists · ${count} entries · ${months} month folders`,
    notFound: "Not found (it must be a folder in your OneDrive)",
    noToken: "Sign in first, then confirm again",
    pickUp: "Up one level",
    pickEmpty: "No subfolders here",
    pickChoose: "Choose this folder",
    pickClose: "Close",
    needFolder: "Confirm the photo folder to continue",
    unchecked: "Not confirmed yet",
    back: "Back",
    aiTitle: "Generation (optional)",
    aiNote:
      "Generation writes photo captions, day summaries, and trip stories for search, the timeline, and album cards. Without it, the archive is sorted by date only.",
    aiSend: "Photos are sent to the selected service unless you choose a local one. Keys stay on this machine only.",
    aiSkipNote:
      "You can skip this. Scanning and browsing work without it, and you can set it up later in Settings → Generation.",
    keySet: "✓ Key is set (leave the box blank to keep it)",
    keyMissing: "No key for this service yet; enter one or skip for now",
    needKey: "Add the key, or skip",
    keyTyped: "The key is checked when you press Continue",
    platformLink: "Get a key on the platform ↗",
    keyRejected: (reason: string) => `Invalid key: ${reason}`,
    cannotReach: (reason: string) => `Cannot reach this service: ${reason}`,
    aiKeyHint: "API key (leave blank to keep the saved one)",
    skip: "Skip (configure later in Settings)",
    scanTitle: "First scan",
    scanNote: "Lists your folders and builds the archive index without downloading photos",
    startScan: "Start the first scan",
    scanFailed: "The scan failed",
    retry: "Try again",
    scanDone: (photos: number, months: number) => `${photos.toLocaleString()} photos · ${months} months`,
    openArchive: "Open the archive",
    existingTitle: "An archive already exists",
    existingNote:
      "This Microsoft account already has an archive in OneDrive, so this machine will copy its index first without re-scanning or overwriting anything.",
    existingSyncing: "Copying the archive to this machine",
    existingDone: (months: number | null) =>
      months ? `Copied · ${num(months)} months` : "Copied to this machine",
    existingFailed: "The sync failed",
    starting: "Starting",
  },
  settings: {
    loading: "Loading settings",
    syncState: {
      "in-sync": "In sync",
      behind: "OneDrive has newer changes",
      ahead: "This device has changes not uploaded",
      conflict: "Both changed since the last sync",
      "never-synced": "Never synced",
      offline: "Not signed in",
    } satisfies Record<SyncState, string>,
    never: "Never",
    justNow: "Just now",
    minutesAgo: (n: number) => `${num(n)} min ago`,
    hoursAgo: (n: number) => `${num(n)} h ago`,
    conflictLead:
      "Both this device and OneDrive changed since the last sync. Choose which copy to keep; changes will not be merged.",
    thisDevice: "This device",
    oneDrive: "OneDrive",
    uploadMine: "Upload mine (overwrites OneDrive)",
    replaceMine: "Replace mine (discards local changes)",
    ofTotal: (done: number, total: number) => ` (${num(done)} of ${num(total)})`,
    failed: (message: string) => `Failed: ${message}`,
    finished: "Finished",

    localServer: "Local server",
    background: "Start at sign-in",
    startServer: "Start the archive server now",
    startServerBusy: "Starting",
    startServerFailed: "Could not start the archive server",
    backgroundNote:
      "Starts the archive server in the background when you sign in, with no window. Closing the app window will no longer disconnect your phone or other devices on the home network.",
    backgroundUnsupported: "Sign-in start-up is only available on Windows",
    backgroundOn: "Start the archive server when I sign in",
    backgroundWhere: (command: string) => `Registered to start: ${command}`,
    backgroundForeign: (command: string) =>
      `Registered for a different archive home (signing in starts that one, not this): ${command}`,
    notify: "Notifications",
    notifyNote:
      "Shown only on this computer without opening a window. Tasks you start notify when finished; failed tasks always notify.",
    notifySuccess: "Announce work I started when it finishes",
    notifyFailures: "Announce a job that failed",
    notifyTest: "Send a test notification",
    notifyTested: "Sent; it should be in your notifications now",
    notifyTestFailed: "Not sent:",
    remote: "Remote access",
    remoteNote:
      "Controls network access to the archive server. Other devices need the shared password to read; changes can only be made on this computer. Restart to apply saved changes.",
    remoteHost: "Listening on",
    remotePassword: "Shared password",
    remoteLogFile: "Log file",
    remotePasswordSet: "Set",
    remotePasswordUnset: "Not set",
    remoteExpose: "Let this network read the archive",
    remoteOpen: "Open to the network without a password; anyone on this network can read the archive",
    remoteSaved: (what: string) => `Saved settings differ from what is running (restart to apply): ${what}`,
    remoteNewPassword: "New password",
    remoteSetPassword: "Save password",
    remoteClearPassword: "Clear password",
    remoteLocalOnly:
      "Reachable on this machine only. Allow network reading and restart to open it from a phone or another computer.",
    remoteOpenHere: "Open this in a browser, or scan the code beside an address for the phone layout:",
    remoteQr: "Show the QR code",
    remoteQrTitle: "Scan this on the phone",
    remoteQrClose: "Close",
    remoteNoAddress:
      "Open to the network, but no local network address was found. Check your network connection, then restart the server.",
    remoteNoPage:
      "Open to the network, but the reader page is not responding. Open the desktop app window or reinstall the app.",
    remoteCopy: "Copy",
    remoteCopied: "Copied",
    remoteCopyFailed: "Copy failed; select it by hand",
    remotePorts: (ports: number[]) => ports.join(", "),
    firewallLabel: "Firewall",
    firewallNeeds: "Allow the firewall rule so other devices can connect",
    firewallPublicNetwork: (profile: string) =>
      `Windows treats this network as “${profile}”, so a private-network rule cannot apply. Switch the network to Private, then reload.`,
    firewallAllowed: "Allowed",
    firewallAllow: "Allow",
    firewallRuleDetail: (ports: string, rule: string) =>
      `Adds Windows Firewall rule “${rule}” for TCP ${ports} on private networks`,
    firewallViaNamed: (rule: string, ports: string) =>
      `Rule “${rule}” allows TCP ${ports} on private networks`,
    firewallViaProgram: (rule: string) => `Allowed by Windows under rule “${rule}”`,
    firewallWaiting: "Waiting for Windows",
    firewallUnreadable: "Could not read the firewall state. Raw output:",
    firewallFailed: "Not added:",
    restart: "Restart the server",
    restarting: "Restarting; the page will reconnect automatically",
    restartFailed: "The server did not restart. Check the log file for details.",
    noServer:
      "No local server is running, so photos are read straight from OneDrive and cached in this browser. Sync, kept copies, and generation require the desktop app.",

    library: "Library",
    aboutHeading: "About",
    aboutTagline: "A photo archive that runs on your computer and stays yours",
    updates: "Updates",
    updateCheck: "Check for updates",
    updateChecking: "Checking",
    updateNone: "You are on the latest version",
    updateAvailable: (version: string) => `Version ${version} is available`,
    updateDownloading: (percent: number) => `Downloading ${percent}%`,
    updateReady: (version: string) => `Version ${version} is ready`,
    updateInstall: "Restart to install",
    updateFailed: (message: string) => `Could not check: ${message}`,
    updateNoRelease: "No update information has been published yet",
    updateDevBuild: "This build runs from source and does not self-update",
    updateDirtyBuild: "This build includes uncommitted changes and does not self-update",
    dataSources: "Data",
    licenceLoading: "Reading",
    noticesThirdPartyHint: "libvips (LGPL-3.0-or-later), sharp, Noto Serif SC, …",
    noticesLicenseHint: "AGPL-3.0-or-later",
    appInfo: "This app",
    version: "Version",
    serverVersion: "Pipeline",
    serverVersionUnknown: "Not answering",
    groups: {
      archive: "Archive",
      sync: "Sync and scanning",
      generate: "Generation",
      access: "Access",
      app: "App",
    },
    notices: "Licences",
    noticesNote:
      "Uses libvips (LGPL-3.0-or-later) for local image processing. The buttons below open the licence files shipped with the app.",
    noticesThirdParty: "Third-party notices",
    noticesLicense: "This app's licence",
    noticesFailed: "Could not open that file",
    notSignedIn: "Not signed in",
    photos: "Photos",
    analyzed: "Described by AI",
    days: "Days summarised",
    sections: "Trips and months",
    schema: "Schema version",

    scan: "Scan",
    lastScanned: "Last scanned",
    whatToScan: "What to scan",
    scanModes: { incremental: "Since the last scan", full: "The whole library", range: "A month range" },
    scanNotes: {
      incremental:
        "Scans from the month of the last scan onwards. Run a full scan occasionally to catch photos deleted in earlier months.",
      full: "Scans every month folder and detects photos deleted anywhere in the library.",
      range: "Scans only the months you pick. Photos deleted outside that range are left alone.",
    },
    scanNow: "Scan now",

    generation: "Generation",
    screens: "Screenshot descriptions",
    provider: "AI provider",
    apiKey: "API key",
    savedReady: "Saved. Generation is ready.",
    saved: "Saved",
    unavailable: "Unavailable",
    /** No service is in force yet. Not the same as "unavailable". */
    noServiceChosen: "No service chosen yet",
    ready: "Ready",
    readyOnceSaved: "Ready once saved",
    noKey: "No API key (generation is unavailable)",
    keySaved: "Saved (type a new key to replace it)",
    keyPaste: "Paste your API key",
    keyNote: (path: string) => `Stored in ${path}. Only generation needs this; browsing and reading the archive do not.`,
    shadowed: (name: string) =>
      `${name} is also set in system environment variables, which override keys saved here on restart. Update or remove it there if needed.`,

    providerTableNote:
      "Choose the AI service used for captions, day summaries, and translations. Each row saves separately; keys stay on this machine.",
    providersLocal: "On this machine",
    providersCloud: "Online services",
    providerBaseUrl: "Endpoint",
    providerModel: "Model",
    providerSaveUse: "Save and use",
    providerActive: "In use",
    providerCheck: "Check",
    providerCheckBusy: "Checking",
    providerCheckOk: "✓ Key accepted",
    providerCheckUnreachable: (reason: string) => `No answer: ${reason}`,
    photosFolderNote:
      "Changes are checked before saving and take effect on the next scan",
    providerKeySet: "Key saved",
    providerKeyMissing: "No key",
    providerLocalNoKey: "Local service (no key needed)",
    providerBatchOk: "Batch available (half price, within a day)",
    providerNoBatch: "No batch (captions run immediately)",
    providerOpenAiHint: "Works with any OpenAI-compatible endpoint",
    /**
     * Provider display names, keyed by the preset id the server reports. This is
     * the one place a provider name is translated; the server's `label` stays
     * English and is the fallback for an id this map does not know yet, so a new
     * backend added to `PRESETS` still renders before its name is translated.
     */
    providers: {
      deepseek: "DeepSeek",
      gemini: "Google Gemini",
      siliconflow: "SiliconFlow (硅基流动)",
      dashscope: "Alibaba DashScope (Qwen)",
      zhipu: "Zhipu (智谱 GLM)",
      moonshot: "Moonshot (Kimi)",
      openrouter: "OpenRouter",
      ollama: "Local (Ollama)",
      lmstudio: "Local (LM Studio)",
    },

    proxy: "Network proxy",
    proxySystem: "System proxy",
    proxySystemDetected: (url: string) => `Detected: ${url}`,
    proxySystemNone: "No system proxy detected",
    proxyAi: "AI provider (Gemini)",
    proxyGraph: "Microsoft Graph (OneDrive)",
    proxyModes: {
      system: "Follow system proxy",
      direct: "Direct (no proxy)",
      custom: "Custom proxy",
    },
    proxyCustomPlaceholder: "e.g. http://127.0.0.1:7890",
    proxyNote: "Choose whether AI calls and OneDrive sync use a proxy",
    proxySaved: "Proxy settings saved",

    sync: "Sync",
    checkingOneDrive: "Checking OneDrive",
    lastChecked: "Last checked",
    lastSynced: "Last synced",
    checkNow: "Check now",
    syncNow: "Sync now",

    kept: "Kept copies",
    nothingPinned:
      "No kept copies. Open a trip or month and choose “Keep on this device” to download its photos and keep them from being cleared.",
    pinTrip: "Trip",
    pinMonth: "Month",
    withOriginals: "with originals",
    unpin: "Unpin",
    includeOriginals: "Keep originals too",
    thumbnailsOnly: "Thumbnails only",
    autoCheck: "Check for changes when the app starts",
    checkEvery: "And while it runs, check every",
    interval: (minutes: number) =>
      minutes === 0 ? "Never" : minutes < 60 ? `${num(minutes)} minutes` : `${num(minutes / 60)} hour${minutes === 60 ? "" : "s"}`,

    appearance: "Appearance",
    sidebarWidth: "Sidebar width",

    storage: "Local storage",
    files: (n: number) => count(n, "file", "files"),
    metadata: "Archive metadata",
    thumbnails: "Thumbnails",
    originals: "Originals",
    total: "Total",
    clearThumbnails: "Clear thumbnails",
    clearOriginals: "Clear originals",
    dataCredits: "Place names from GeoNames (CC BY 4.0). Map outlines from Natural Earth (public domain).",
    storageNote: "Kept copies are never removed when clearing. Everything else is downloaded again when needed.",
  },

  generate: {
    tabs: { trip: "Trip", analyze: "Analyze", organize: "Day summaries", translate: "Translate", screens: "Screens (local)" },

    suggest: {
      loading: "Looking for trips",
      title: (n: number) => (n === 1 ? "1 possible trip" : `${num(n)} possible trips`),
      lead: "Detected from nights spent away from home. Create a trip directly, or write its story above.",
      nights: (n: number) => (n === 1 ? "1 night" : `${num(n)} nights`),
      fromHome: (km: string, home: string) => `up to ${km} km from ${home}`,
      uncertain: "some nights uncertain",
      create: "Create trip",
      createHint: "Gathers these days under this name without writing a story or spending anything",
      story: "Write its story",
      dismiss: "Not a trip",
      showAll: (n: number) => `Show all ${num(n)}`,
    },
    tripNoteHtml:
      "Writes a trip story from its <em>day summaries</em>. Run Analyze and Day summaries for these dates first.",
    notes: "Notes (optional)",
    notesPlaceholder: "Plans, who you were with, or why you went",
    documents: "Context documents (.txt, .md)",
    name: "Name (blank = let the model propose one)",
    writeNarrative: "Write the narrative",
    tripAllowMissing: "Write it anyway if most days have no summary yet",

    screensNoteHtml:
      "Private screenshots are described on this computer and <strong>never leave it</strong>, and their descriptions <strong>stay off your archive pages</strong>. Only the <em>screen type</em> is noted (a chat, an ID card), and each description is locked with the passphrase below before it is uploaded.",
    screensRunNote:
      "Describes screenshots across the library using the service and passphrase set in Settings.",
    screensService: "Service (this machine)",
    /**
     * The service in force is not one of the rows on offer. The screenshot
     * pass may only use a service that runs here, so a cloud one has to be
     * replaced before the pass can run.
     */
    screensServiceUnset: "The selected service is not local; choose a local service first",
    screensServiceNote:
      "Runs locally on this computer so screenshots never leave it.",
    screensPassphrase: "Passphrase",
    screensKeySet: "Set (saved in this computer's key store)",
    screensKeyUnset: "Not set",
    /** The server has no key, but this device holds one that already opens the file. */
    screensKeyOnDevice: "Not set (this device already has a passphrase)",
    /** The machine can seal new descriptions; this device has not opened the old ones here. */
    screensKeySetLocked: "Set (locked on this device)",
    screensKeySetOpen: "Set (unlocked on this device)",
    screensPassSet: "Set",
    /** One click: hand the machine the passphrase this device already holds. */
    screensPassAdopt: "Use it",
    screensPassChange: "Change",
    screensPassNew: "New passphrase",
    screensPassRepeat: "Repeat passphrase",
    screensPassMismatch: "Passphrases do not match",
    screensPassSave: "Save",
    screensPassWarning:
      "Changing the passphrase re-locks all descriptions for this Windows account only. If you lose it, screenshots must be described again.",
    screensPassWarningSet:
      "Checked against existing descriptions first; if it does not unlock them, nothing changes. New descriptions are locked with this passphrase, so if you lose it they must be described again.",
    screensPassDone: (count: number, fingerprint: string) =>
      `Changed: ${count} descriptions updated (key ${fingerprint})`,
    screensPassDoneAdopted: (count: number, fingerprint: string) =>
      `Saved: unlocks ${count === 1 ? "1 existing description" : `${count} existing descriptions`} (key ${fingerprint})`,
    screensPassDoneSet: "Set",
    /**
     * The passphrase rules and refusals, worded here rather than on the server.
     * The server sends a code and its parameters (screenErrors.ts); these turn
     * them into a sentence. An unknown code falls back to the server's own text,
     * so a newer server never renders nothing.
     */
    screensErr: {
      tooShort: (min: number) => `Use at least ${min} characters`,
      tooLong: (max: number) => `Use at most ${max} characters`,
      tooCommon: "Too predictable: avoid dictionary words or repeated characters",
      tooFamous: "This passphrase is too well known; choose something unique",
      mismatch: (wants: string, derives: string) =>
        `Wrong passphrase (expected key ${wants}, got ${derives})`,
      damaged: "Could not unlock the file: wrong passphrase or damaged data",
      noPassphrase: "No passphrase saved on this computer",
      keyStoreUnreadable: (reason: string) =>
        `Cannot read the saved passphrase on this Windows account (${reason})`,
    },
    screensCheck: "Check",
    screensStart: "Describe screens",
    screensNoPassphrase: "Set a passphrase before running",
    screensNoKeyStore: "This system cannot store a passphrase securely, so screenshot descriptions cannot run here",
    screensNoLocal: "Install and start Ollama or LM Studio first",
    screensRunning: "Already running; check Activity for progress",
    screensReady: "Ready",
    /**
     * The read side: what this device can open. The descriptions are opened
     * here rather than on the server, so the passphrase is asked for here and
     * kept by this surface — the desktop shell's key store, or the session's
     * memory where there is none.
     */
    screensOnDevice: "On this device",
    screensOnDeviceCount: (n: number) => (n === 1 ? "1 description readable here" : `${num(n)} descriptions readable here`),
    screensUnlock: "Unlock",
    screensForget: "Forget",
    screensForgetConfirm:
      "Forget the passphrase on this device? Descriptions stay locked until you enter it again.",
    screensForgetYes: "Forget",
    screensPassEnter: "Passphrase",
    screensRemember: "Remember on this computer",
    screensRememberPhone: "Remember on this phone",
    screensLocked: "Locked: enter the passphrase to view",
    screensOpening: "Unlocking",
    screensNoCrypto:
      "Cannot unlock over an insecure connection (requires HTTPS or localhost)",

    analyzeNoteHtml:
      "Writes captions for unanalyzed photos in the date range. <strong>This step uses paid API calls</strong>, so check the estimate first. Photos with captions are skipped; <em>leave either date blank</em> to leave that end open (both blank covers the whole archive).",
    estimateCost: "Estimate cost",
    analyze: "Analyze",
    nothingToAnalyze:
      "Nothing to analyze in this range",
    analyzePlan: (photos: number, months: number, input: number, output: number) =>
      `${count(photos, "photo", "photos")} across ${count(months, "month", "months")}, about ${millions(input)}M input and ${millions(output)}M output tokens.`,
    batchLabel: "Run as a batch (half price, results within a day, collected automatically)",
    batchEstimate: "Half price as a batch.",
    batchesTitle: "Batches",
    batchState: {
      pending: "waiting",
      running: "running",
      succeeded: "ready to collect",
      failed: "failed",
      cancelled: "cancelled",
      expired: "expired",
      collected: "collected",
    } satisfies Record<AnalyzeBatchState | "collected", string>,
    batchRow: (when: string, photos: number, state: string, applied: number | null) =>
      `${when} · ${count(photos, "photo", "photos")} · ${state}${applied !== null ? ` · ${num(applied)} captioned` : ""}`,
    collectNow: "Collect now",

    organizeNoteHtml:
      "Groups captions from Analyze into day pages by stop, names each place, and selects featured photos. <strong>Run this after Analyze and before Trip.</strong>",
    months: "Months",
    monthOption: (month: string, photos: number) => `${month} · ${count(photos, "photo", "photos")}`,
    includeUnchanged: "Include days that have not changed",
    findDays: "Find days to summarise",
    noDays: "No days need summarising",
    canSummarise: (n: number) => `${count(n, "day", "days")} ready to summarise`,
    reuse: (n: number) => `${num(n)} already up to date, or outside this scope`,
    noAnalyzed: (n: number) => `${num(n)} have no analyzed photos yet (run Analyze first)`,
    outOfScope: (n: number) => `${num(n)} outside this scope`,
    undated: (n: number) => `${num(n)} have no usable date`,
    small: (n: number, min: number) => `${num(n)} have ${min} usable photos or fewer and are not part of a trip`,
    planDay: (date: string, photos: number) => `${date} · ${count(photos, "usable photo", "usable photos")}`,
    truncated: "Showing the first 300 days; narrow by month to see the rest",
    selectNone: "Select none",
    selectAll: "Select all",
    nothingSelected: "Nothing selected",
    summarise: (n: number) => `Summarise ${count(n, "day", "days")}`,
    couldNotCheck: (message: string) => `Could not check: ${message}`,

    translateNote:
      "Translates existing captions, day pages, and trips into 简体中文 alongside the English text. Text-only, and skips anything already translated.",
    whatToTranslate: "What to translate",
    translateScopes: { all: "Everything", day: "Day pages and trips", captions: "Photo captions" },
    estimate: "Estimate",
    translate: "Translate",
    nothingToTranslate: (strings: number) => `Nothing to translate: all ${num(strings)} texts are up to date`,
    translatePlan: (missing: number, strings: number, chars: number, input: number, output: number) =>
      `${num(missing)} of ${num(strings)} texts to translate (${num(chars)} chars), about ${millions(input)}M input and ${millions(output)}M output tokens. The run reports the real counts.`,
    couldNotEstimate: (message: string) => `Could not estimate: ${message}`,

    // Lower case, as the server's own names: this line reads like a log.
    jobKind: {
      scan: "scan",
      analyze: "analyze",
      organize: "organize",
      trip: "trip",
      sync: "sync",
      translate: "translate",
      collect: "collect",
      locate: "locate",
      // Not one word, unlike the others: this pass runs on this machine only,
      // and the label is the only place a reader sees that.
      screens: "screens (local)",
    } satisfies Record<JobKind, string>,
    jobStatus: {
      queued: "queued",
      running: "running",
      done: "done",
      failed: "failed",
      cancelled: "cancelled",
    } satisfies Record<JobStatus, string>,
    jobFailed: (message: string) => `failed: ${message}`,
  },

  search: {
    placeholder: "Search captions, places and summaries",    loading: "Loading the search index",
    unavailable: "Nothing to search yet: run Analyze and Day summaries first",
    signIn: "Sign in to search the archive",
    serverDown: "Archive server is not responding",
    offline: "Offline: showing the cached search index",
    retry: "Could not load the search index; try again later",
    ready: (photos: number, days: number) => `${num(photos)} photos and ${num(days)} days ready to search`,
    found: (photos: number, days: number, ms: number) =>
      `${num(photos)} ${photos === 1 ? "photo" : "photos"} across ${num(days)} ${days === 1 ? "day" : "days"} · ${num(ms)}ms`,
    photosMatched: (n: number) => `${num(n)} matching`,
    none: "No results",
    count: (photos: number, days: number) =>
      `${num(photos)} ${photos === 1 ? "photo" : "photos"} across ${num(days)} ${days === 1 ? "day" : "days"}`,
    inSummary: "in the day's summary",
  },

  activity: {
    loading: "Loading activity",
    now: "Now",
    idle: "No jobs running",
    deviceCode: "Waiting for sign-in: open this in a browser and enter the code",
    waitingForGoogle: (photos: number, ago: string) =>
      `Waiting for Google: ${count(photos, "photo", "photos")}, submitted ${ago} ago.`,
    readyToCollect: (photos: number) =>
      `Google finished ${count(photos, "photo", "photos")}; collecting within 10 minutes.`,
    batches: "Caption batches",
    noBatches: "No caption batches submitted",
    /** The local-render gaps — shown only while one is present, in Activity. */
    noSharp: "Local thumbnails unavailable (sharp failed to load)",
    noHeic: "HEIC decoding unavailable (heic-decode failed to load)",
    noFfmpeg:
      "ffmpeg not found: install it and restart for video and DNG thumbnails",
    batchDetail: (
      applied: number | null,
      failed: number | null,
      input: number | null,
      output: number | null,
      cost: string | null,
    ) => {
      const parts: string[] = [];
      if (applied !== null) parts.push(`${num(applied)} captioned`);
      if (failed) parts.push(`${num(failed)} without a caption`);
      if (input !== null && output !== null) parts.push(`${num(input)} input, ${num(output)} output tokens`);
      if (cost !== null) parts.push(cost);
      return parts.join(" · ");
    },
    /** `usd` and `gbp` arrive formatted, e.g. "$1.23" and "£0.97". */
    money: (usd: string, gbp: string) => `${usd} (≈${gbp})`,
    batchTotal: (spent: string, waiting: number) =>
      `${spent} spent on collected batches${waiting ? `, ${count(waiting, "photo", "photos")} still pending` : ""}`,
    autoSubmit: (waiting: boolean, since: string) =>
      `Auto-submitting remaining photos one batch at a time. ${
        waiting ? "The next batch submits after the one below is collected." : "The next batch submits shortly."
      } Started ${since}.`,
    stopAutoSubmit: "Stop automatic submit",
    autoSubmitStopped: "Automatic submit stopped. Batches already submitted will still be collected.",
    thumbnails: "Thumbnails",
    warming: (done: number, total: number, failed: number, finished: boolean) =>
      `${finished ? "Cached" : "Caching"} ${num(done)} of ${num(total)}${failed ? ` · ${num(failed)} unavailable` : ""}`,
    history: "Recent jobs",
    noHistory: "No jobs have run yet",
    duration: (ms: number) => {
      const seconds = Math.round(ms / 1000);
      if (seconds < 60) return `${num(seconds)} s`;
      const minutes = Math.round(seconds / 60);
      return minutes < 60 ? `${num(minutes)} min` : `${num(Math.floor(minutes / 60))} h ${num(minutes % 60)} min`;
    },
    noServer: "Activity requires the desktop app's local server",
  },

  /**
   * The phone app (src/mobile/). A separate block rather than reusing the
   * desktop's words, because the phone's screens are its own: tabs where the
   * desktop has a sidebar, a day as its own page where the desktop scrolls a
   * whole trip, and no generation at all.
   */
  mobile: {
    tabs: { home: "Home", trips: "Trips", library: "Library", search: "Search" },
    back: "Back",
    signInTitle: "Your photo archive",
    signInLead:
      "Sign in with the Microsoft account whose OneDrive holds your archive. Photos stay in OneDrive and are read-only here.",
    sessionExpired: "Microsoft session expired",
    signInAgain: "Sign in",
    archiveUpdated: "The archive has been updated",
    refresh: "Refresh",
    loadingArchive: (seconds: number) => `Loading archive from OneDrive (${num(seconds)} s)`,
    offline: "Offline: showing kept copies on this phone",
    trips: "Trips",
    daysOut: "Days out",
    seeAll:"See all",
    noTrips: "No trips yet; create trips in the desktop app",
    tripMeta: (days: number, photos: number) => `${count(days, "day", "days")} · ${count(photos, "photo", "photos")}`,
    dayN: (n: number) => `Day ${num(n)}`,
    dayOf: (n: number, total: number) => `Day ${num(n)} of ${num(total)}`,
    readMore: "Read more",
    readLess: "Show less",
    places: "Places",
    days: "Days",
    route: "Route",
    previousDay: "Previous day",
    nextDay: "Next day",
    noPhotos: "No photos on this day",
    stops: "Stops",
    moreInCard: (n: number) => `+${num(n)}`,
    info: "Details",
    share: "Share",
    shareTitle: "Share this photo",
    shareLoading: "Loading photo",
    shareOriginal: "Share the original",
    shareCard: "Share a card",
    cardCaption: "Caption",
    cardDate: "Date",
    cardPlace: "Place",
    cardStyle: "Card style",
    cardGallery: "Gallery",
    cardEditorial: "Editorial",
    cardTextSource: "Text",
    cardSourceTitle: "Title",
    cardSourceCaption: "Photo caption",
    cardSourceCustom: "Custom",
    shareWorking: "Creating card",
    shareFailed: "Could not share",
    fullResolution: "Original",
    counter: (i: number, n: number) => `${num(i)} / ${num(n)}`,
    account: "Account",
    microsoftAccount: "Microsoft account",
    thumbnails: "Thumbnails",
    devicePhotos: "Photos on this phone",
    devicePhotosOn: "On",
    devicePhotosOff: "Off",
    devicePhotosCount: (photos: number) => `On (${count(photos, "photo", "photos")} on this phone)`,
    devicePhotosAllow: "Use the photos on this phone",
    devicePhotosWhy:
      "Reads matching photos directly from your phone's camera folder to save data and load faster. Missing photos still load from OneDrive, and nothing is uploaded.",
    devicePhotosRefused: "Android denied permission. Enable it in Settings › Apps › Photo Archive › Permissions.",
    signedInAs: (name: string) => `Signed in as ${name}`,
    cache: "Stored on this phone",
    cacheSize: (photos: number, mb: string) => `${count(photos, "thumbnail", "thumbnails")} · ${mb} MB`,
    source: "Reading directly from OneDrive. Generating captions and summaries needs the desktop app.",
    autoCache: "Keep months offline",
    offlineGroup: "Offline",
    offlineKept: "Kept copies",
    screens: "Screenshot descriptions",
    screensWhy:
      "Private screenshots are described on your computer and locked with a passphrase before upload. Enter the passphrase once per session to read them on this phone.",
    autoCacheWhy:
      "Downloads month indexes in the background so the library opens offline. Photos stay in OneDrive and load as you scroll.",
    cacheMonths: (kept: number, total: number) => `${num(kept)} of ${num(total)} months kept`,
    cacheBytes: (mb: string) => `${mb} MB`,
    cacheNow: "Download all months now",
    caching: (done: number, total: number) => `Caching months ${num(done)}/${num(total)}`,
    cachedDone: (n: number) => `Available offline: ${count(n, "month", "months")}`,
    cachedStopped: "Stopped, progress saved",
    tapPlace: "Pinch to zoom, or tap a place to see its days",
  },
};

export type Messages = typeof en;
