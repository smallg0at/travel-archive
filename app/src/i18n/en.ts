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
    signInPrompt: "Sign in to load your photos.",
    signInButton: "Sign in with Microsoft",
    resizeHandle: "Drag to resize · double-click to reset",
    loadingArchive: "Loading archive…",
    signInToLoadArchive: "Sign in to load your archive.",
    loadGap: "This part of the archive is not on this machine yet — it is being fetched from OneDrive. Reload in a moment.",
    failedToLoad: (message: string) => `Failed to load archive: ${message}`,
    failedToStart: (message: string) => `Failed to start: ${message}`,
    emptyArchiveHtml: `The archive is empty. The scan found no photos — check the photos folder under Settings → Library and scan again.`,
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
    saving: "Saving…",
    cancel: "Cancel",
    close: "Close",
    back: "Back",
    edit: "Edit",
    fit: "Fit",
    date: "Date",
    from: "From",
    to: "To",
    reset: "Reset",
    starting: "Starting…",
    checking: "Checking…",
    everything: "Everything",
    photos: (n: number) => count(n, "photo", "photos"),
    days: (n: number) => count(n, "day", "days"),
    loading: (what: string) => `Loading ${what}…`,
    signInToLoad: (what: string) => `Sign in to load ${what}.`,
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
    keptTitle: "Photos here are kept on this device and are never evicted to make room.",
    keepTitle: "Fetch these photos and keep them on this device.",
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
    loadingFull: "Loading full resolution…",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
  },

  edit: {
    noteLabel: "Note for the summarizer — kept, and used every time this day is rewritten",
    notePlaceholder: "e.g. the 11:00 stop is the railway museum; the morning was a write-off.",
    summaryLabel: "Day summary",
    rewrite: "Rewrite this day",
    nothingChanged: "Nothing changed.",
    saved: "Saved.",
    savedStale: "Saved. The note has changed, so the next day-summaries run will rewrite this day — or press Rewrite this day.",
    rewriting: "Rewriting…",
    rewriteCancelled: "Rewrite cancelled.",
    rewriteFailed: (message: string) => `Rewrite failed: ${message}`,
    unknownError: "unknown error",
    renameTrip: "Rename trip",
    deleteTrip: "Delete trip",
    confirmDeleteTrip: "Press again to delete — its days and photos stay",
    tripNameLabel: "Trip name",
    editTripStory: "Edit the text",
    tripStoryLabel: "Trip story",
    tripStoryNote:
      "Your own wording for this trip, in the language you are reading. It stands until you ask for a new one — a translate run and a regeneration both leave it alone.",
    tripStoryCleared: "Cleared. Save to hand the text back to the model.",
    regenerate: "Write it again",
    regenerateNote:
      "Add anything the photographs could not know — what a place was, why the day mattered — and the story is written again with it. The current text is replaced.",
    regenerateNotesLabel: "Anything to add (optional)",
    regenerateRun: "Write the story",
    rewritten: "Rewritten.",
    rename: "Rename",
    stopSummaryPlaceholder: "What happened here (optional)",
  },

  time: {
    notKnown: "Not known",
    hourLabel: "Time (hour)",
    set: "Set the time",
    change: "Change the time",
    note: "Renames the file in OneDrive, so it survives a rescan. To set several at once, Ctrl-click them in the day's grid.",
    savedAs: (fileName: string) => `Saved as ${fileName}.`,
    pickDate: "Pick a date first.",
  },

  retime: {
    toolbar: "Set the time of the selected photos",
    hour: "Hour",
    setTime: "Set time",
    clear: "Clear",
    selected: (n: number) => `${num(n)} selected`,
    tooMany: "At most 60 photos fit in one hour a minute apart — select fewer, or choose “Not known”.",
    saving: (n: number) => `Saving ${num(n)}…`,
    result: (set: number, refused: number, firstError: string | null) => {
      const done = `Set ${count(set, "photo", "photos")}.`;
      return refused ? `${done} ${num(refused)} refused: ${firstError}` : `${done} The day regroups on the next reload.`;
    },
  },

  print: {
    preparing: (done: number, total: number) => `Preparing ${count(total, "photo", "photos")} — ${num(done)} of ${num(total)}`,
    sizing: (done: number, total: number) => `Sizing ${count(total, "photo", "photos")} — ${num(done)} of ${num(total)}`,
    savingPdf: "Saving the PDF…",
    openingPrint: "Opening the print dialog…",
    waitingForWindow: "Bring this window to the front to finish — a hidden page cannot be printed.",
    exportFailed: (error: string) => `Export failed: ${error}`,
  },

  server: {
    offline:
      "Local server is offline — running in fallback mode, reading straight from OneDrive. Everything will be much slower. Start it with npm run desktop.",
    back: "The local server is running again. Reload to use it.",
    lost: "The local server stopped responding. Reload to switch to fallback mode.",
    gated: "The archive server needs the access password again. Reload to enter it.",
    reload: "Reload",
  },

  gate: {
    title: "Photo Archive",
    note: "This archive is shared on the home network. Enter the password to read it. Viewing only — nothing here can be changed from this device.",
    placeholder: "Shared password",
    submit: "Open",
  },

  home: {
    inView: (photos: number, places: number) => `${count(photos, "photo", "photos")} in ${count(places, "place", "places")} in view`,
    openDay: "Open this day",
    title: "Everywhere",
    mapLabel: "A world map of every place in this archive",
    totals: (photos: number, places: number, countries: number) =>
      `${num(photos)} photos placed across ${num(places)} places in ${count(countries, "country", "countries")}.`,
    noMap: "No places yet — run a scan, then Day summaries, to put this library on the map.",
    photos: (n: number) => count(n, "photo", "photos"),
    placeMeta: (photos: number, days: number) => `${count(photos, "photo", "photos")} on ${count(days, "day", "days")}`,
    thenTitle: "On this day",
    thenNearTitle: "Around this time",
    nothingToday: "Nothing was photographed on this date, or near it, in any year.",
    yearsAgo: (n: number) => (n === 0 ? "this year" : n === 1 ? "a year ago" : `${num(n)} years ago`),
  },

  map: {
    loading: "Loading map…",
    label: (trip: string) => `Cities visited on ${trip}`,
    unnamed: "Unnamed stop",
    expand: "Expand",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    /** A cluster on the home map: its biggest place, and how many more it holds. */
    clusterMore: (biggest: string, more: number) => `${biggest} +${more}`, /* User fix. */
    /** A cluster across borders, by its countries, most photos first. */
    clusterCountries: (countries: string[]) =>
      countries.length <= 2 ? countries.join(" & ") : `${countries.slice(0, 2).join(", ")} +${countries.length - 2}`,
  },

  theme: { label: "Theme", light: "Light", dark: "Dark", system: "System" },

  language: { label: "Language" },

  setup: {
    loading: "Preparing setup…",
    title: "Set up your photo archive",
    langTitle: "Language",
    signTitle: "Sign in the archive server",
    signNote: "Scanning, thumbnails and every job run through it — it needs one Microsoft sign-in.",
    signedIn: "Signed in",
    signingIn: "Waiting for authorization…",
    signInBtn: "Sign in with Microsoft",
    codeHint: "Open this link in a browser and enter the code:",
    continue: "Continue",
    needSignIn: "Sign in to continue",
    folderTitle: "Photo folder",
    check: "Confirm",
    browse: "Browse…",
    monthHint: "Expected layout: yyyy-mm (or yyyy/mm) subfolders.",
    change: "Change",
    checking: "Confirming…",
    folderExists: (count: number, months: number) => `Exists · ${count} entries · ${months} period folders`,
    notFound: "Not found — it must be a folder in your OneDrive.",
    noToken: "Sign in first, then confirm again.",
    pickUp: "Up one level",
    pickEmpty: "No subfolders here.",
    pickChoose: "Choose this folder",
    pickClose: "Close",
    needFolder: "Confirm the photo folder to continue",
    unchecked: "Not confirmed yet",
    back: "Back",
    aiTitle: "Generation (optional)",
    aiNote:
      "Generation captions every photo and writes the day and trip summaries — that text is what content search, the timeline and the album cards read. Without it, the archive is photos sorted by date.",
    aiSend: "Photos are sent to the selected service (local ones never leave this machine). Keys are stored only in this machine's .env.",
    aiSkipNote:
      "Skipping is fine: scanning and browsing do not depend on it. Captions, summaries and content search can be added later under Settings → Generation.",
    keySet: "✓ Key is set — leave the box blank to keep it.",
    keyMissing: "No key for this service yet: fill the box, or skip and configure later.",
    needKey: "Add the key, or skip",
    keyTyped: "The key is checked when you press Continue.",
    platformLink: "Get a key on the platform ↗",
    keyRejected: (reason: string) => `Invalid key: ${reason}`,
    cannotReach: (reason: string) => `Cannot reach this service: ${reason}`,
    aiKeyHint: "API key (leave blank to keep the saved one)",
    skip: "Skip — configure later in Settings",
    scanTitle: "First scan",
    scanNote: "The scan lists your folders and builds the archive index. It downloads no photos.",
    startScan: "Start the first scan",
    scanFailed: "The scan failed.",
    retry: "Try again",
    scanDone: (photos: number, months: number) => `${photos.toLocaleString()} photos · ${months} months`,
    openArchive: "Open the archive",
    existingTitle: "An archive already exists",
    existingNote:
      "This Microsoft account already has an archive in OneDrive, so this machine is taking a copy of its metadata first. Nothing is scanned again, and nothing already in the archive is overwritten.",
    existingSyncing: "Bringing the archive to this machine…",
    existingDone: (months: number | null) =>
      months ? `Copied · ${months} months` : "Copied to this machine",
    existingFailed: "The sync failed.",
    starting: "Starting…",
  },
  settings: {
    loading: "Loading settings…",
    syncState: {
      "in-sync": "In sync",
      behind: "OneDrive has newer changes",
      ahead: "This device has changes not uploaded",
      conflict: "Both changed since the last sync",
      "never-synced": "Never synced",
      offline: "Not signed in",
    } satisfies Record<SyncState, string>,
    never: "never",
    justNow: "just now",
    minutesAgo: (n: number) => `${n} min ago`,
    hoursAgo: (n: number) => `${n} h ago`,
    conflictLead:
      "Both this device and OneDrive changed since the last sync. Choose which copy survives — this is not merged.",
    thisDevice: "This device",
    oneDrive: "OneDrive",
    uploadMine: "Upload mine (overwrites OneDrive)",
    replaceMine: "Replace mine (discards local changes)",
    ofTotal: (done: number, total: number) => ` — ${num(done)} of ${num(total)}`,
    failed: (message: string) => `Failed: ${message}`,
    finished: "Finished.",

    localServer: "Local server",
    background: "Start at sign-in",
    startServer: "Start the job server now",
    startServerBusy: "Starting…",
    startServerFailed: "The job server could not be started.",
    backgroundNote:
      "Runs the job server in the background from the moment you sign in, with no window of its own. The desktop app finds it already running and uses it rather than starting a second copy — so closing the window no longer takes the archive away from the phone, or from anyone on the home network. Its output goes to data\\serve.log beside it.",
    backgroundUnsupported: "Sign-in start-up is only available on Windows.",
    backgroundOn: "Start the job server when I sign in",
    backgroundWhere: (command: string) => `Registered to start: ${command}`,
    backgroundForeign: (command: string) =>
      `Registered for a different archive home — signing in starts that one, not this: ${command}`,
    notify: "Notifications",
    notifyNote:
      "Sent by the job server on its own machine, so they appear only where it runs — no window needed, and nothing leaves the network. Work you started announces itself when it finishes; a job that failed announces itself whatever started it.",
    notifySuccess: "Announce work I started when it finishes",
    notifyFailures: "Announce a job that failed",
    notifyTest: "Send a test notification",
    notifyTested: "Sent — it should be in your notifications now.",
    notifyTestFailed: "Not sent:",
    remote: "Remote access",
    remoteNote:
      "What the job server is bound to. Reading elsewhere needs the shared password; writing is this machine's either way. Saved changes wait for a restart.",
    remoteHost: "Listening on",
    remotePassword: "Shared password",
    remoteLogFile: "Log file",
    remotePasswordSet: "Set",
    remotePasswordUnset: "Not set",
    remoteExpose: "Let this network read the archive",
    remoteOpen: "Open to the network with no password — anyone on it can read the archive.",
    remoteSaved: (what: string) => `Saved settings differ from what is running — restart to apply: ${what}`,
    remoteNewPassword: "New password",
    remoteSetPassword: "Save password",
    remoteClearPassword: "Clear password",
    restart: "Restart the server",
    restarting: "Restarting — the page reconnects on its own.",
    restartFailed: "The server did not come back. Its output is in data\\serve.log.",
    noServer:
      "No local server is running, so the archive is being read directly from OneDrive and images are cached in this browser only. Sync, pinning and generation need the desktop app.",

    library: "Library",
    notSignedIn: "Not signed in.",
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
        "Scans from the month of the last scan onwards. Photos deleted from OneDrive in earlier months are not noticed — run a full scan occasionally to catch those.",
      full: "Lists every month folder. The only mode that notices photos deleted from OneDrive anywhere in the library.",
      range: "Scans only the months you pick. Photos deleted outside that range are left alone.",
    },
    scanNow: "Scan now",

    generation: "Generation",
    provider: "AI provider",
    apiKey: "API key",
    savedReady: "Saved. Generation is ready.",
    saved: "Saved.",
    unavailable: "Unavailable",
    ready: "Ready",
    readyOnceSaved: "Ready once saved",
    noKey: "No API key — generation is unavailable",
    keySaved: "Saved — type a new key to replace it",
    keyPaste: "Paste your API key",
    keyNote: (path: string) => `Stored in ${path}. Only generation needs this; browsing and reading the archive do not.`,
    shadowed: (name: string) =>
      `${name} is also set as a system environment variable, which wins over this file when the app restarts. Change it there, or unset it, for a key saved here to survive.`,

    providerTableNote:
      "Pick the backend captions, day summaries and translations run on. Each is separate — switching submits the one row you save. Keys are stored in the file above and never sent back.",
    providersLocal: "On this machine",
    providersCloud: "Online services",
    providerBaseUrl: "Endpoint",
    providerModel: "Model",
    providerSaveUse: "Save and use",
    providerActive: "In use",
    providerCheck: "Check",
    providerCheckBusy: "Checking…",
    providerCheckOk: "✓ Key accepted",
    providerCheckUnreachable: (reason: string) => `No answer: ${reason}`,
    photosFolderNote:
      "A change is checked first: only a folder that exists is saved, and it takes effect on the next scan.",
    providerKeySet: "Key saved",
    providerKeyMissing: "No key",
    providerLocalNoKey: "Local service — no key needed",
    providerBatchOk: "Batch available (half price, within a day)",
    providerNoBatch: "No batch — captions run immediately",
    providerOpenAiHint: "Any OpenAI-compatible endpoint works here.",
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
    proxyNote: "Control whether AI calls and OneDrive sync route through a proxy.",
    proxySaved: "Proxy settings saved.",

    sync: "Sync",
    checkingOneDrive: "Checking OneDrive…",
    lastChecked: "Last checked",
    lastSynced: "Last synced",
    checkNow: "Check now",
    syncNow: "Sync now",

    kept: "Kept on this device",
    nothingPinned:
      "Nothing is pinned. Open a trip or a month and choose “Keep on this device” to keep its photos here — they are fetched when you sync and are never evicted to make room.",
    pinTrip: "Trip",
    pinMonth: "Month",
    withOriginals: "with originals",
    unpin: "Unpin",
    includeOriginals: "Keep full-size too",
    thumbnailsOnly: "Thumbnails only",
    autoCheck: "Check for changes when the app starts",
    checkEvery: "And while it runs, check every",
    interval: (minutes: number) =>
      minutes === 0 ? "Never" : minutes < 60 ? `${minutes} minutes` : `${minutes / 60} hour${minutes === 60 ? "" : "s"}`,

    appearance: "Appearance",
    sidebarWidth: "Sidebar width",

    storage: "Local storage",
    files: (n: number) => count(n, "file", "files"),
    metadata: "Archive metadata",
    thumbnails: "Thumbnails",
    originals: "Full-size photos",
    total: "Total",
    clearThumbnails: "Clear thumbnails",
    clearOriginals: "Clear full-size photos",
    dataCredits: "Place names from GeoNames (CC BY 4.0). Map outlines from Natural Earth (public domain).",
    storageNote: "Pinned items are kept even when clearing. Anything else is fetched again when needed.",
  },

  generate: {
    tabs: { trip: "Trip", analyze: "Analyze", organize: "Day summaries", translate: "Translate", screens: "Screens (local)" },

    suggest: {
      loading: "Looking for trips…",
      title: (n: number) => (n === 1 ? "1 possible trip" : `${n} possible trips`),
      lead: "Found from the nights spent away from home. Create one as it is, or write its story with the form above.",
      nights: (n: number) => (n === 1 ? "1 night" : `${n} nights`),
      fromHome: (km: string, home: string) => `up to ${km} km from ${home}`,
      uncertain: "some nights uncertain",
      create: "Create trip",
      createHint: "Gathers these days under this name. No story is written, and nothing is spent.",
      story: "Write its story…",
      dismiss: "Not a trip",
      showAll: (n: number) => `Show all ${n}`,
    },
    tripNoteHtml:
      "Writes the story of a trip from its <em>day summaries</em> — so run Analyze and Day summaries for the range first, or it will have nothing to work from.",
    notes: "Notes (optional)",
    notesPlaceholder: "Anything worth knowing — plans, who you were with, what the trip was for.",
    documents: "Context documents (.txt, .md)",
    name: "Name (blank = let the model propose one)",
    writeNarrative: "Write the narrative",
    tripAllowMissing: "Write it anyway if most days have no summary yet",

    screensNote:
      "Describes the screenshots nobody has vouched for — the private ones the allowlist keeps away from the cloud model, so <strong>nothing on your archive page and nobody else's sees them</strong>. A model on this machine does the looking, and it is told to name only <em>what kind of screen</em> it is: a chat conversation, an ID card, a passport page, a screen showing account numbers. Nothing on it is transcribed. The descriptions are encrypted with the passphrase below before they are uploaded, so the copy on OneDrive is unreadable — this machine is the only thing that can read them.",
    screensService: "Service (this machine)",
    screensPassphrase: "Passphrase",
    screensKeySet: "set · kept in this machine's key store",
    screensKeyUnset: "not set",
    screensPassChange: "Change",
    screensPassNew: "new passphrase",
    screensPassRepeat: "repeat it",
    screensPassMismatch: "The two do not match yet.",
    screensPassSave: "Save",
    screensPassWarning:
      "Changing it re-encrypts every description; the old one stops working at once, and the new one is kept for this Windows user only. Lose it and the only way back is describing them again.",
    screensPassDone: (count: number, fingerprint: string) =>
      `changed — ${count} descriptions re-encrypted (key ${fingerprint})`,
    /**
     * The passphrase rules and refusals, worded here rather than on the server.
     * The server sends a code and its parameters (screenErrors.ts); these turn
     * them into a sentence. An unknown code falls back to the server's own text,
     * so a newer server never renders nothing.
     */
    screensErr: {
      tooShort: (min: number) => `At least ${min} characters — this is the only thing protecting the descriptions.`,
      tooLong: (max: number) => `At most ${max} characters.`,
      tooCommon: "That is one of the first things anyone would try — a dictionary, or the same character over and over.",
      tooFamous: "That is the most-quoted passphrase on the internet. It is a good shape — make it yours instead.",
      mismatch: (wants: string, derives: string) =>
        `Not the passphrase this file was written with: it wants key ${wants}, this derives ${derives}.`,
      damaged: "The file could not be decrypted — written with a different passphrase, or damaged.",
      noPassphrase: "No passphrase is stored on this machine yet.",
      keyStoreUnreadable: (reason: string) =>
        `The stored passphrase cannot be read on this Windows account (${reason}). It is protected per user and per machine.`,
    },
    screensCheck: "Check",
    screensStart: "Describe screens",
    screensDescribed: (n: number) => (n === 1 ? "1 screen described" : `${n} screens described`),
    screensNoPassphrase: "No passphrase yet — the descriptions are encrypted before upload, so one is needed first.",
    screensNoKeyStore: "This machine has no key store, so the screenshot pass cannot run here: the passphrase is kept in the Windows key store (DPAPI), and nothing reads it from a file.",
    screensNoLocal: "No service on this machine to use — install and start Ollama or LM Studio first.",
    screensRunning: "A run is going; its progress is in Activity.",

    analyzeNoteHtml:
      "Captions every photo in the range that has never been looked at, one model call each. <strong>This is the step that costs money</strong> — check the estimate first. Re-running is safe: photos that already have a caption are skipped. <em>Leave a date blank to leave that end open</em> — both blank means the whole archive.",
    estimateCost: "Estimate cost",
    analyze: "Analyze",
    nothingToAnalyze:
      "Nothing to analyze in that range — already done, or filtered out as duplicates and withheld screenshots.",
    analyzePlan: (photos: number, months: number, input: number, output: number) =>
      `${count(photos, "photo", "photos")} across ${count(months, "month", "months")} — about ${millions(input)}M input and ${millions(output)}M output tokens.`,
    batchLabel: "As a batch — half price, results within a day, collected automatically",
    batchEstimate: "As a batch, about half that.",
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
      "Turns the captions from Analyze into day pages: groups each day into the places you stopped, names them, and picks what to show. One text-only model call per day — no images, so it is cheap. <strong>Run this after Analyze and before Trip.</strong>",
    months: "Months",
    monthOption: (month: string, photos: number) => `${month} · ${count(photos, "photo", "photos")}`,
    includeUnchanged: "Include days that have not changed",
    findDays: "Find days to summarise",
    noDays: "No days need summarising here.",
    canSummarise: (n: number) => `${count(n, "day", "days")} can be summarised.`,
    reuse: (n: number) => `${num(n)} already up to date, or outside this scope`,
    noAnalyzed: (n: number) => `${num(n)} have no analyzed photos yet — run Analyze on them first`,
    outOfScope: (n: number) => `${num(n)} outside this scope`,
    undated: (n: number) => `${num(n)} have no usable date`,
    small: (n: number, min: number) => `${num(n)} have ${min} usable photos or fewer and aren't part of a trip — left without a summary`,
    planDay: (date: string, photos: number) => `${date} · ${count(photos, "usable photo", "usable photos")}`,
    truncated: "Only the first 300 are listed — narrow it by month to see the rest.",
    selectNone: "Select none",
    selectAll: "Select all",
    nothingSelected: "Nothing selected",
    summarise: (n: number) => `Summarise ${count(n, "day", "days")}`,
    couldNotCheck: (message: string) => `Could not check: ${message}`,

    translateNote:
      "Puts text the archive already has into 简体中文, beside the English — captions, day pages and trips. Text only, no photos are sent, so it is far cheaper than Analyze. Machine translation: expect plain rather than polished. Re-running translates only what is new or has changed.",
    whatToTranslate: "What to translate",
    translateScopes: { all: "Everything", day: "Day pages and trips", captions: "Photo captions" },
    estimate: "Estimate",
    translate: "Translate",
    nothingToTranslate: (strings: number) => `Nothing to translate — all ${num(strings)} texts in scope already have one.`,
    translatePlan: (missing: number, strings: number, chars: number, input: number, output: number) =>
      `${num(missing)} of ${num(strings)} texts need translating (${num(chars)} characters) — roughly ${millions(input)}M input and ${millions(output)}M output tokens. The run reports the real counts.`,
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
    placeholder: "Search captions, places and summaries",    loading: "Loading the search index…",
    unavailable: "Nothing to search yet — run Analyze and Day summaries first.",
    signIn: "Sign in to search the archive.",
    serverDown: "The archive server is not answering — this device reads through it.",
    offline: "Offline — the search index is fetched once and kept from then on.",
    retry: "Couldn't fetch the search index — try again in a moment.",
    ready: (photos: number, days: number) => `${num(photos)} photos and ${num(days)} days ready to search.`,
    found: (photos: number, days: number, ms: number) =>
      `${num(photos)} ${photos === 1 ? "photo" : "photos"} across ${num(days)} ${days === 1 ? "day" : "days"} · ${num(ms)}ms`,
    photosMatched: (n: number) => `${num(n)} matching`,
    none: "Nothing matched.",
    count: (photos: number, days: number) =>
      `${num(photos)} ${photos === 1 ? "photo" : "photos"} across ${num(days)} ${days === 1 ? "day" : "days"}`,
    inSummary: "in the day's summary",
  },

  activity: {
    loading: "Loading activity…",
    now: "Now",
    idle: "Nothing is running.",
    deviceCode: "Waiting for sign-in: open this in a browser and enter the code",
    waitingForGoogle: (photos: number, ago: string) =>
      `Nothing is running here. Waiting for Google: ${count(photos, "photo", "photos")}, submitted ${ago} ago.`,
    readyToCollect: (photos: number) =>
      `Google has finished ${count(photos, "photo", "photos")}; they are collected within ten minutes.`,
    batches: "Caption batches",
    noBatches: "No caption batches have been submitted.",
    /** The local-render gaps — shown only while one is present, in Activity. */
    noSharp: "Local thumbnails are unavailable: the image library (sharp) failed to load.",
    noHeic: "HEIC decoding is unavailable (heic-decode failed to load).",
    noFfmpeg:
      "ffmpeg was not found — video posters and DNG thumbnails cannot be rendered here. Install it and restart the app.",
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
      `${spent} spent on collected batches, at batch prices${waiting ? ` · ${count(waiting, "photo", "photos")} still with Google` : ""}.`,
    autoSubmit: (waiting: boolean, since: string) =>
      `Submitting the rest automatically, one batch at a time — Google's queue holds one for this account. ${
        waiting ? "The next goes in once the batch below has been collected." : "The next goes in shortly."
      } On since ${since}.`,
    stopAutoSubmit: "Stop automatic submit",
    autoSubmitStopped: "Automatic submit stopped. Batches already with Google are still collected.",
    thumbnails: "Thumbnails",
    warming: (done: number, total: number, failed: number, finished: boolean) =>
      `${finished ? "Cached" : "Caching"} ${num(done)} of ${num(total)}${failed ? ` · ${num(failed)} unavailable` : ""}`,
    history: "Recent jobs",
    noHistory: "No jobs have run yet.",
    duration: (ms: number) => {
      const seconds = Math.round(ms / 1000);
      if (seconds < 60) return `${seconds} s`;
      const minutes = Math.round(seconds / 60);
      return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
    },
    noServer: "Activity needs the local server, which the desktop app runs.",
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
      "Sign in with the Microsoft account whose OneDrive holds the archive. The photos stay in OneDrive — this app only reads them.",
    sessionExpired: "Your Microsoft session has expired.",
    signInAgain: "Sign in",
    archiveUpdated: "The archive has changed since this copy.",
    refresh: "Refresh",
    offline: "Offline — showing what this phone has kept.",
    trips: "Trips",
    daysOut: "Days out",
    seeAll:"See all",
    noTrips: "No trips yet. Trips are defined in the desktop app.",
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
    noPhotos: "No photos on this day.",
    stops: "Stops",
    moreInCard: (n: number) => `+${num(n)}`,
    info: "Details",
    fullResolution: "Full resolution",
    counter: (i: number, n: number) => `${num(i)} / ${num(n)}`,
    account: "Account",
    microsoftAccount: "Microsoft account",
    thumbnails: "Thumbnails",
    devicePhotos: "Photos on this phone",
    devicePhotosOn: "On",
    devicePhotosOff: "Off",
    devicePhotosCount: (photos: number) => `On · ${count(photos, "photo", "photos")} on this phone`,
    devicePhotosAllow: "Use the photos on this phone",
    devicePhotosWhy:
      "Most of this archive was taken on this phone and is still in its camera folder. Shown from there, they open at once and cost no data; anything missing still comes from OneDrive. The photos are only read, and nothing is sent anywhere.",
    devicePhotosRefused: "Android refused access. You can allow it in Settings › Apps › Photo Archive › Permissions.",
    signedInAs: (name: string) => `Signed in as ${name}`,
    cache: "Stored on this phone",
    cacheSize: (photos: number, mb: string) => `${count(photos, "thumbnail", "thumbnails")} · ${mb} MB`,
    source: "Reading directly from OneDrive. Generating captions and summaries needs the desktop app.",
    autoCache: "Keep months offline",
    offlineGroup: "Offline",
    offlineKept: "Months kept",
    autoCacheWhy:
      "Downloads every month's photo records in the background, so the library opens at once and works with no signal. Pictures stay on OneDrive and load as you scroll.",
    cacheMonths: (kept: number, total: number) => `${num(kept)} of ${num(total)} months kept`,
    cacheBytes: (mb: string) => `${mb} MB`,
    cacheNow: "Download all months now",
    caching: (done: number, total: number) => `Caching months… ${num(done)}/${num(total)}`,
    cachedDone: (n: number) => `Available offline: ${count(n, "month", "months")}.`,
    cachedStopped: "Stopped. Progress is kept.",
    tapPlace: "Pinch to zoom · tap a place to see its days",
  },
};

export type Messages = typeof en;
