import type { Messages } from "./en";
import { millions, num } from "./format";

/**
 * The interface in 简体中文. Written by hand, not by the translate job: these are
 * a few hundred short strings the reader meets on every page, and they are
 * checked against `Messages` so none can go missing.
 *
 * Spaces around Latin words and numbers, full-width punctuation — the usual
 * mainland convention. Brand and file names (OneDrive, Microsoft, .txt) stay
 * as they are.
 */
export const zhHans: Messages = {
  app: {
    title: "照片档案",
    signInPrompt: "登录后即可加载照片。",
    signInButton: "使用 Microsoft 账户登录",
    resizeHandle: "拖动调整宽度 · 双击恢复默认",
    loadingArchive: "正在加载档案…",
    signInToLoadArchive: "登录后即可加载照片档案。",
    failedToLoad: (message) => `档案加载失败：${message}`,
    failedToStart: (message) => `启动失败：${message}`,
    emptyArchiveHtml: `照片档案为空。请运行 <code>npm run --workspace pipeline scan</code> 为照片建立索引。`,
  },

  common: {
    save: "保存",
    saving: "正在保存…",
    cancel: "取消",
    close: "关闭",
    back: "返回",
    edit: "编辑",
    fit: "适应窗口",
    date: "日期",
    from: "开始",
    to: "结束",
    reset: "重置",
    starting: "正在启动…",
    checking: "正在检查…",
    everything: "全部",
    photos: (n) => `${num(n)} 张照片`,
    days: (n) => `${num(n)} 天`,
    loading: (what) => `正在加载 ${what}…`,
    signInToLoad: (what) => `登录后即可加载 ${what}。`,
  },

  nav: {
    home: "首页",
    trips: "旅行",
    generate: "生成",
    activity: "活动",
    search: "搜索",
    settings: "设置",
    savePdf: "导出 PDF",
    kept: "▣ 已保存在本机",
    keep: "☁ 保存到本机",
    keptTitle: "此处的照片保存在本机，绝不会因释放空间而被自动清理。",
    keepTitle: "下载这些照片并保留在本机。",
  },

  album: {
    dayOut: "当日往返",
    dayOutFar: (km: string) => `距家 ${km} 公里`,
    dayMode: { label: "这一天的显示方式", trip: "行程", gallery: "相册" },
    undated: "无日期",
    thumbnailSize: "缩略图大小",
    contents: "目录",
    density: { compact: "小", comfortable: "中", spacious: "大" },
  },

  day: {
    morePhotos: (n) => `还有 ${num(n)} 张照片`,
    originalText: "原文",
    fromPlacards: (n) => (n === 1 ? "说明牌原文" : `${num(n)} 处说明牌原文`),
  },

  viewer: {
    thisPhoto: "当前照片",
    transcribed: "识别文字",
    loadingFull: "正在加载原图…",
    zoomIn: "放大",
    zoomOut: "缩小",
  },

  edit: {
    noteLabel: "给摘要模型的备注——永久保留，每次重新生成该日内容时均会生效",
    notePlaceholder: "例如：11:00 那一站是 the railway museum；上午基本上没安排活动。",
    summaryLabel: "当天摘要",
    rewrite: "重写这一天",
    nothingChanged: "内容未更改。",
    saved: "已保存。",
    savedStale: "已保存。备注已更改，下次运行“当天摘要”时将重新生成该日内容——也可立即点击“重写这一天”。",
    rewriting: "正在重写…",
    rewriteCancelled: "重写已取消。",
    rewriteFailed: (message) => `重写失败：${message}`,
    unknownError: "未知错误",
    renameTrip: "重命名旅行",
    deleteTrip: "删除旅行",
    confirmDeleteTrip: "再次点击确认删除——日程与照片仍会保留",
    tripNameLabel: "旅行名称",
    rewritten: "已重写。",
    rename: "重命名",
    stopSummaryPlaceholder: "在此处的活动记录（可选）",
  },

  time: {
    notKnown: "未知",
    hourLabel: "时间（整点）",
    set: "设置时间",
    change: "更改时间",
    note: "将直接在 OneDrive 中重命名文件，因此重新扫描后依然有效。如需批量设置，可在当天照片网格中按住 Ctrl 键点击多选。",
    savedAs: (fileName) => `已保存，文件名为 ${fileName}。`,
    pickDate: "请先选择日期。",
  },

  retime: {
    toolbar: "批量设置所选照片的时间",
    hour: "时间",
    setTime: "设置时间",
    clear: "清除",
    selected: (n) => `已选 ${num(n)} 张`,
    tooMany: "每分钟一张照片，一小时最多容纳 60 张——请减少所选数量，或选择“未知”。",
    saving: (n) => `正在保存 ${num(n)} 张…`,
    result: (set, refused, firstError) => {
      const done = `已设置 ${num(set)} 张照片。`;
      return refused ? `${done}其中 ${num(refused)} 张被拒绝：${firstError}` : `${done}重新加载后当天照片将按新时间重新分组。`;
    },
  },

  print: {
    preparing: (done, total) => `正在准备照片（${num(done)} / ${num(total)}）`,
    sizing: (done, total) => `正在调整照片尺寸（${num(done)} / ${num(total)}）`,
    savingPdf: "正在保存 PDF…",
    openingPrint: "正在打开打印对话框…",
    exportFailed: (error) => `导出失败：${error}`,
  },

  server: {
    offline: "本地服务器未运行——当前处于降级模式，直接从 OneDrive 读取，速度会变慢很多。请使用 npm run desktop 启动。",
    back: "本地服务器已恢复运行。刷新页面即可正常使用。",
    lost: "本地服务器已停止响应。刷新页面可切换至降级模式。",
    reload: "刷新",
  },

  home: {
    inView: (photos: number, places: number) => `当前视野内 ${num(places)} 个地点，共 ${num(photos)} 张照片`,
    openDay: "查看当天",
    title: "足迹",
    mapLabel: "档案中所有地点的世界地图",
    totals: (photos: number, places: number, countries: number) =>
      `${num(photos)} 张照片，分布于 ${num(countries)} 个国家的 ${num(places)} 个地点。`,
    noMap: "暂无地点信息——请先运行“扫描”，再生成“当天摘要”，让照片在地图上呈现。",
    photos: (n: number) => `${num(n)} 张照片`,
    placeMeta: (photos: number, days: number) => `${num(days)} 天 · 共 ${num(photos)} 张照片`,
    thenTitle: "历史上的今天",
    thenNearTitle: "往年此时",
    nothingToday: "往年此时及前后均未拍摄过照片。",
    yearsAgo: (n: number) => (n === 0 ? "今年" : `${num(n)} 年前`),
  },

  map: {
    loading: "正在加载地图…",
    label: (trip) => `“${trip}”途经城市`,
    unnamed: "未命名地点",
    expand: "展开",
    zoomIn: "放大",
    zoomOut: "缩小",
    clusterMore: (biggest: string, more: number) => `${biggest} 等 ${more + 1} 处`,
    clusterCountries: (countries: string[]) =>
      countries.length <= 2 ? countries.join(" 和 ") : `${countries.slice(0, 2).join("、")}等 ${countries.length} 国`, /* User fix. */
  },

  theme: { label: "主题", light: "浅色", dark: "深色", system: "跟随系统" },

  language: { label: "语言" },

  settings: {
    loading: "正在加载设置…",
    syncState: {
      "in-sync": "已同步",
      behind: "OneDrive 上有较新的更改",
      ahead: "本机有尚未上传的更改",
      conflict: "上次同步后两端均有更改",
      "never-synced": "从未同步",
      offline: "未登录",
    },
    never: "从未",
    justNow: "刚刚",
    minutesAgo: (n) => `${n} 分钟前`,
    hoursAgo: (n) => `${n} 小时前`,
    conflictLead: "本机与 OneDrive 在上次同步后均有更改。请选择保留哪个版本——两端内容不会合并。",
    thisDevice: "本机",
    oneDrive: "OneDrive",
    uploadMine: "上传本机更改（覆盖 OneDrive）",
    replaceMine: "采用 OneDrive 版本（舍弃本机更改）",
    ofTotal: (done, total) => ` · ${num(done)} / ${num(total)}`,
    failed: (message) => `失败：${message}`,
    finished: "已完成。",

    localServer: "本地服务器",
    noServer:
      "本地服务器未运行，照片档案将直接从 OneDrive 读取，且图片仅缓存在当前浏览器中。同步、保存至本机以及生成功能均需使用桌面端应用。",

    library: "照片库",
    notSignedIn: "未登录。",
    photos: "照片",
    analyzed: "已由 AI 生成说明",
    days: "已生成摘要天数",
    sections: "旅行与月份",
    schema: "数据结构版本",

    scan: "扫描",
    lastScanned: "上次扫描",
    whatToScan: "扫描范围",
    scanModes: { incremental: "自上次扫描以来", full: "整个照片库", range: "指定月份范围" },
    scanNotes: {
      incremental:
        "从上次扫描所在的月份起继续扫描。在更早月份中从 OneDrive 删除的照片不会被检测到——建议偶尔运行一次完整扫描以检测并清理。",
      full: "扫描所有月份文件夹。这是唯一能够检测到照片库中任意位置从 OneDrive 所删除照片的方式。",
      range: "仅扫描所选月份。该范围之外已删除的照片不会做任何变动。",
    },
    scanNow: "立即扫描",

    generation: "生成",
    provider: "AI 服务商",
    apiKey: "API 密钥",
    savedReady: "已保存。可以开始生成了。",
    saved: "已保存。",
    unavailable: "不可用",
    ready: "就绪",
    readyOnceSaved: "保存后即可使用",
    noKey: "未配置 API 密钥——无法使用生成功能",
    keySaved: "已保存——输入新密钥可直接替换",
    keyPaste: "粘贴 API 密钥",
    keyNote: (path) => `保存在 ${path}。仅生成功能需要此密钥；浏览与查看照片档案无需配置。`,
    shadowed: (name) =>
      `${name} 已在系统环境变量中设置，应用重启时系统环境变量优先于本文件中的值。请在系统设置中修改或删除该变量，此处保存的密钥才会生效。`,

    sync: "同步",
    checkingOneDrive: "正在检查 OneDrive…",
    lastChecked: "上次检查",
    lastSynced: "上次同步",
    checkNow: "立即检查",
    syncNow: "立即同步",

    kept: "保存在本机的内容",
    nothingPinned:
      "暂无保存在本机的内容。打开任意旅行或月份，选择“保存到本机”，相应照片便会保存在本地——同步时下载，且绝不会因释放空间而被自动清理。",
    pinTrip: "旅行",
    pinMonth: "月份",
    withOriginals: "含原图",
    unpin: "取消保存",
    includeOriginals: "同时保存原图",
    thumbnailsOnly: "仅缩略图",
    autoCheck: "应用启动时检查更改",
    checkEvery: "运行期间检查频率",
    interval: (minutes) => (minutes === 0 ? "从不" : minutes < 60 ? `${minutes} 分钟` : `${minutes / 60} 小时`),

    appearance: "外观",
    sidebarWidth: "侧栏宽度",

    storage: "本地存储",
    files: (n) => `${num(n)} 个文件`,
    metadata: "档案元数据",
    thumbnails: "缩略图",
    originals: "原图",
    total: "合计",
    clearThumbnails: "清除缩略图",
    clearOriginals: "清除原图",
    dataCredits: "地名数据来自 GeoNames（CC BY 4.0）。地图轮廓来自 Natural Earth（公有领域）。",
    storageNote: "即使执行清理，保存在本机的内容仍会保留。其余内容将在需要时重新下载。",
  },

  generate: {
    tabs: { trip: "旅行", analyze: "分析", organize: "当天摘要", translate: "翻译" },

    suggest: {
      loading: "正在查找旅行…",
      title: (n: number) => `${n} 个可能的旅行`,
      lead: "根据在外过夜的行程记录自动检测。可直接创建旅行，或在上方表单中撰写游记。",
      nights: (n: number) => `${n} 晚`,
      fromHome: (km: string, home: string) => `距 ${home} 最远 ${km} 公里`,
      uncertain: "部分过夜地点待确认",
      create: "创建旅行",
      createHint: "将这些日期的记录归入此名称下。不撰写游记，亦不产生任何费用。",
      story: "撰写游记…",
      dismiss: "不是旅行",
      showAll: (n: number) => `显示全部 ${n} 个`,
    },
    tripNoteHtml:
      "根据<em>当天摘要</em>撰写旅行游记——因此请先对该日期范围运行“分析”与“当天摘要”，否则将缺少生成素材。",
    notes: "备注（可选）",
    notesPlaceholder: "任何值得记录的信息——行程规划、同行人员、旅行目的等。",
    documents: "背景文档（.txt、.md）",
    name: "旅行名称（留空则由模型自动建议）",
    writeNarrative: "撰写游记",
    tripAllowMissing: "即使大部分日期尚未生成摘要，仍继续撰写",

    analyzeNoteHtml:
      "为范围内所有尚未处理的照片生成说明，每张照片调用一次模型。<strong>此步骤会产生 API 费用</strong>——请先查看费用估算。重复运行是安全的：已有说明的照片会被自动跳过。",
    estimateCost: "估算费用",
    analyze: "分析",
    nothingToAnalyze: "该日期范围内没有需要分析的照片——均已完成分析，或已被作为重复照片和隐藏截图过滤。",
    analyzePlan: (photos, months, input, output) =>
      `${num(photos)} 张照片，跨越 ${num(months)} 个月——预计消耗约 ${millions(input)}M 输入 token、${millions(output)}M 输出 token。`,
    batchLabel: "使用批量任务（Batch）——费用减半，24 小时内完成，自动收取结果",
    batchEstimate: "若使用批量任务，费用约为一半。",
    batchesTitle: "批量任务",
    batchState: {
      pending: "等待中",
      running: "运行中",
      succeeded: "可收取",
      failed: "失败",
      cancelled: "已取消",
      expired: "已过期",
      collected: "已收取",
    },
    batchRow: (when, photos, state, applied) =>
      `${when} · ${num(photos)} 张照片 · ${state}${applied !== null ? ` · 已生成说明 ${num(applied)} 张` : ""}`,
    collectNow: "立即收取",

    organizeNoteHtml:
      "将“分析”生成的照片说明整理为单日页面：按经停地点对每天进行分组并命名，挑选精选照片展示。每天仅需一次纯文本模型调用（不发送图片），费用极低。<strong>请在“分析”之后、“旅行”之前运行。</strong>",
    months: "月份",
    monthOption: (month, photos) => `${month} · ${num(photos)} 张照片`,
    includeUnchanged: "包含未发生变动的日期",
    findDays: "查找待生成摘要的日期",
    noDays: "当前范围内没有需要生成摘要的日期。",
    canSummarise: (n) => `可为 ${num(n)} 天生成摘要。`,
    reuse: (n) => `${num(n)} 天已是最新，或超出当前范围`,
    noAnalyzed: (n) => `${num(n)} 天尚无已分析的照片——请先对其运行“分析”`,
    outOfScope: (n) => `${num(n)} 天超出当前范围`,
    undated: (n) => `${num(n)} 天缺少有效日期`,
    small: (n, min) => `${num(n)} 天照片不超过 ${min} 张且不属于任何旅行——跳过生成摘要`,
    planDay: (date, photos) => `${date} · ${num(photos)} 张照片`,
    truncated: "仅显示前 300 天——可按月份缩小范围查看其余内容。",
    selectNone: "全不选",
    selectAll: "全选",
    nothingSelected: "未选择",
    summarise: (n) => `为 ${num(n)} 天生成摘要`,
    couldNotCheck: (message) => `无法检查：${message}`,

    translateNote:
      "将档案中现有文字翻译为简体中文并与英文并列展示——包括照片说明、单日页面与旅行游记。仅发送文字而不发送照片，因此费用远低于“分析”。当前使用机器翻译，译文风格偏朴实直白。重复运行仅会翻译新增或变更的内容。",
    whatToTranslate: "翻译内容",
    translateScopes: { all: "全部", day: "单日页面与旅行游记", captions: "照片说明" },
    estimate: "估算",
    translate: "翻译",
    nothingToTranslate: (strings) => `暂无需要翻译的内容——范围内的 ${num(strings)} 条文字均已有译文。`,
    translatePlan: (missing, strings, chars, input, output) =>
      `${num(strings)} 条文字中有 ${num(missing)} 条待翻译（共 ${num(chars)} 个字符）——预计消耗约 ${millions(input)}M 输入 token、${millions(output)}M 输出 token。实际数量以运行结果为准。`,
    couldNotEstimate: (message) => `无法估算：${message}`,

    jobKind: {
      scan: "扫描",
      analyze: "分析",
      organize: "当天摘要",
      trip: "旅行",
      sync: "同步",
      translate: "翻译",
      collect: "收取结果",
      locate: "地理定位",
    },
    jobStatus: {
      queued: "排队中",
      running: "运行中",
      done: "已完成",
      failed: "失败",
      cancelled: "已取消",
    },
    jobFailed: (message) => `失败：${message}`,
  },

  search: {
    placeholder: "搜索说明、地点与摘要",
    loading: "正在加载搜索索引…",
    unavailable: "暂无可搜索内容——请先运行“分析”与“当天摘要”。",
    ready: (photos, days) => `${num(photos)} 张照片、${num(days)} 天记录已可供搜索。`,
    found: (photos, days, ms) => `${num(photos)} 张照片，分布于 ${num(days)} 天 · ${num(ms)} 毫秒`,
    photosMatched: (n) => `匹配 ${num(n)} 张`,
  },

  activity: {
    loading: "正在加载活动…",
    now: "进行中",
    idle: "当前没有正在运行的任务。",
    waitingForGoogle: (photos, ago) => `本机暂无运行中的任务。正在等待 Google 处理：${num(photos)} 张照片，于 ${ago}前提交。`,
    readyToCollect: (photos) => `Google 已处理完毕 ${num(photos)} 张照片，将在 10 分钟内自动收取。`,
    batches: "照片说明批量任务",
    noBatches: "尚未提交过照片说明批量任务。",
    batchDetail: (applied, failed, input, output, cost) => {
      const parts: string[] = [];
      if (applied !== null) parts.push(`已生成说明 ${num(applied)} 张`);
      if (failed) parts.push(`${num(failed)} 张未生成说明`);
      if (input !== null && output !== null) parts.push(`输入 ${num(input)} / 输出 ${num(output)} token`);
      if (cost !== null) parts.push(cost);
      return parts.join(" · ");
    },
    money: (usd, gbp) => `${usd}（约合 ${gbp}）`,
    batchTotal: (spent, waiting) =>
      `已收取的批量任务按批处理价格共计 ${spent}${waiting ? `，另有 ${num(waiting)} 张照片仍在由 Google 处理中` : ""}。`,
    autoSubmit: (waiting, since) =>
      `正在自动提交其余照片，每次一批——当前账户在 Google 队列中一次仅可容纳一批任务。${
        waiting ? "下方批次收取后，将自动提交下一批。" : "下一批任务即将提交。"
      }已自 ${since} 开启。`,
    stopAutoSubmit: "停止自动提交",
    autoSubmitStopped: "已停止自动提交。已在 Google 处理中的批量任务仍将自动收取。",
    thumbnails: "缩略图",
    warming: (done, total, failed, finished) =>
      `${finished ? "已缓存" : "正在缓存"} ${num(done)} / ${num(total)}${failed ? ` · ${num(failed)} 张无法获取` : ""}`,
    history: "近期任务",
    noHistory: "暂无历史任务记录。",
    duration: (ms) => {
      const seconds = Math.round(ms / 1000);
      if (seconds < 60) return `${seconds} 秒`;
      const minutes = Math.round(seconds / 60);
      return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
    },
    noServer: "“活动”面板需要本地服务器支持，请启动桌面端应用。",
  },

  mobile: {
    tabs: { home: "首页", trips: "旅行", library: "图库", search: "搜索" },
    back: "返回",
    signInTitle: "照片档案",
    signInLead: "请使用存放照片档案的 OneDrive 所属 Microsoft 账户登录。照片仍安全保存在 OneDrive 中，本应用仅进行读取。",
    sessionExpired: "Microsoft 登录会话已过期。",
    signInAgain: "重新登录",
    archiveUpdated: "云端档案已有更新。",
    refresh: "刷新",
    offline: "处于离线状态——仅显示手机已保留的内容。",
    trips: "旅行",
    daysOut: "当日往返",
    seeAll: "查看全部",
    noTrips: "暂无旅行记录。旅行行程需在桌面端应用中创建与设定。",
    tripMeta: (days: number, photos: number) => `${num(days)} 天 · ${num(photos)} 张照片`,
    dayN: (n: number) => `第 ${num(n)} 天`,
    dayOf: (n: number, total: number) => `第 ${num(n)} 天，共 ${num(total)} 天`,
    readMore: "展开",
    readLess: "收起",
    places: "地点",
    days: "日程",
    route: "路线",
    previousDay: "前一天",
    nextDay: "后一天",
    noPhotos: "当天没有拍摄照片。",
    stops: "途经点",
    moreInCard: (n: number) => `+${num(n)}`,
    info: "详情",
    fullResolution: "原图",
    counter: (i: number, n: number) => `${num(i)} / ${num(n)}`,
    account: "账户",
    microsoftAccount: "Microsoft 账户",
    thumbnails: "缩略图",
    devicePhotos: "手机相册照片",
    devicePhotosOn: "已开启",
    devicePhotosOff: "未开启",
    devicePhotosCount: (photos: number) => `已开启 · 手机相册匹配到 ${num(photos)} 张照片`,
    devicePhotosAllow: "使用手机相册照片",
    devicePhotosWhy:
      "档案中的大多数照片就是用这台手机拍摄的，且仍保存在相册中。直接从本地相册读取可秒开且不消耗流量；手机中缺失的照片仍会从 OneDrive 获取。本应用仅读取照片，绝不会上传至任何其他地方。",
    devicePhotosRefused: "Android 系统权限请求被拒绝。可在「设置 › 应用 › Photo Archive › 权限」中手动开启。",
    signedInAs: (name: string) => `已登录：${name}`,
    cache: "手机本地存储",
    cacheSize: (photos: number, mb: string) => `${num(photos)} 张缩略图 · ${mb} MB`,
    source: "直接从 OneDrive 读取数据。生成照片说明与摘要需使用桌面端应用。",
    autoCache: "离线保存全部月份",
    offlineGroup: "离线",
    offlineKept: "已保留月份",
    autoCacheWhy:
      "在后台下载每个月的照片记录，让图库即开即用、无信号也能浏览。照片仍保存在 OneDrive，滚动时按需加载。",
    cacheMonths: (kept: number, total: number) => `已保留 ${num(kept)}/${num(total)} 个月`,
    cacheBytes: (mb: string) => `${mb} MB`,
    cacheNow: "立即下载全部月份",
    caching: (done: number, total: number) => `正在缓存月份… ${num(done)}/${num(total)}`,
    cachedDone: (n: number) => `已可离线使用：${num(n)} 个月。`,
    cachedStopped: "已停止，进度已保留。",
    tapPlace: "双指缩放 · 点击地点查看相应日程",
  },
};
