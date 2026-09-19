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
    signInPrompt: "登录后即可加载你的照片。",
    signInButton: "使用 Microsoft 帐户登录",
    resizeHandle: "拖动调整宽度 · 双击恢复默认",
    loadingArchive: "正在加载档案…",
    signInToLoadArchive: "登录后即可加载你的档案。",
    failedToLoad: (message) => `档案加载失败：${message}`,
    failedToStart: (message) => `启动失败：${message}`,
    emptyArchiveHtml: `档案是空的。运行 <code>npm run --workspace pipeline scan</code> 为照片建立索引。`,
  },

  common: {
    save: "保存",
    saving: "正在保存…",
    cancel: "取消",
    close: "关闭",
    edit: "编辑",
    fit: "适应窗口",
    date: "日期",
    from: "开始",
    to: "结束",
    reset: "重置",
    starting: "正在开始…",
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
    keptTitle: "这里的照片保存在本机，不会为了腾出空间而被清除。",
    keepTitle: "下载这些照片并保存在本机。",
  },

  album: {
    undated: "无日期",
    thumbnailSize: "缩略图大小",
    contents: "目录",
    density: { compact: "小", comfortable: "中", spacious: "大" },
  },

  day: {
    morePhotos: (n) => `另外 ${num(n)} 张照片`,
    originalText: "原文",
    fromPlacards: (n) => (n === 1 ? "说明牌原文" : `${num(n)} 块说明牌的原文`),
  },

  viewer: {
    thisPhoto: "这张照片",
    transcribed: "识别出的文字",
    loadingFull: "正在加载原图…",
    zoomIn: "放大",
    zoomOut: "缩小",
  },

  edit: {
    noteLabel: "给摘要模型的备注——会一直保留，每次重写这一天时都会用到",
    notePlaceholder: "例如：11:00 那一站是 the railway museum；上午什么也没做成。",
    summaryLabel: "当天摘要",
    rewrite: "重写这一天",
    nothingChanged: "没有改动。",
    saved: "已保存。",
    savedStale: "已保存。备注有改动，下次运行“当天摘要”时会重写这一天——也可以现在点“重写这一天”。",
    rewriting: "正在重写…",
    rewriteCancelled: "重写已取消。",
    rewriteFailed: (message) => `重写失败：${message}`,
    unknownError: "未知错误",
    renameTrip: "重命名旅行",
    deleteTrip: "删除旅行",
    confirmDeleteTrip: "再按一次确认删除——日子和照片都会保留",
    tripNameLabel: "旅行名称",
    rewritten: "已重写。",
    rename: "重命名",
    stopSummaryPlaceholder: "在这里做了什么（可选）",
  },

  time: {
    notKnown: "不确定",
    hourLabel: "时间（整点）",
    set: "设置时间",
    change: "更改时间",
    note: "会在 OneDrive 中重命名文件，所以重新扫描后依然有效。要一次设置多张，在当天的网格里按住 Ctrl 点击它们。",
    savedAs: (fileName) => `已保存，文件名为 ${fileName}。`,
    pickDate: "请先选择日期。",
  },

  retime: {
    toolbar: "设置所选照片的时间",
    hour: "时间",
    setTime: "设置时间",
    clear: "清除",
    selected: (n) => `已选 ${num(n)} 张`,
    tooMany: "每分钟一张，一小时最多只能放 60 张——请少选一些，或选择“不确定”。",
    saving: (n) => `正在保存 ${num(n)} 张…`,
    result: (set, refused, firstError) => {
      const done = `已设置 ${num(set)} 张照片。`;
      return refused ? `${done}${num(refused)} 张被拒绝：${firstError}` : `${done}下次重新加载时，当天会重新分组。`;
    },
  },

  print: {
    preparing: (done, total) => `正在准备 ${num(total)} 张照片——${num(done)}/${num(total)}`,
    sizing: (done, total) => `正在调整 ${num(total)} 张照片的尺寸——${num(done)}/${num(total)}`,
    savingPdf: "正在保存 PDF…",
    openingPrint: "正在打开打印对话框…",
    exportFailed: (error) => `导出失败：${error}`,
  },

  server: {
    offline: "本地服务器未运行 — 当前为降级模式，直接从 OneDrive 读取，速度会慢很多。请用 npm run desktop 启动。",
    back: "本地服务器已恢复运行。刷新页面即可使用。",
    lost: "本地服务器已停止响应。刷新页面以切换到降级模式。",
    reload: "刷新",
  },

  home: {
    openDay: "打开这一天",
    title: "足迹",
    mapLabel: "档案中所有地点的世界地图",
    totals: (photos: number, places: number, countries: number) =>
      `${num(photos)} 张照片，分布在 ${num(countries)} 个国家的 ${num(places)} 个地点。`,
    noMap: "还没有地点信息 — 先运行扫描，再生成每日摘要。",
    photos: (n: number) => `${num(n)} 张照片`,
    placeMeta: (photos: number, days: number) => `${num(days)} 天，共 ${num(photos)} 张照片`,
    thenTitle: "历史上的今天",
    thenNearTitle: "这些天",
    nothingToday: "这个日期前后没有拍过照片。",
    yearsAgo: (n: number) => (n === 0 ? "今年" : `${num(n)} 年前`),
  },

  map: {
    loading: "正在加载地图…",
    label: (trip) => `“${trip}”途经的城市`,
    unnamed: "未命名的地点",
    expand: "展开",
  },

  theme: { label: "主题", light: "浅色", dark: "深色", system: "跟随系统" },

  language: { label: "语言" },

  settings: {
    loading: "正在加载设置…",
    syncState: {
      "in-sync": "已同步",
      behind: "OneDrive 上有更新的改动",
      ahead: "本机有尚未上传的改动",
      conflict: "上次同步后两边都有改动",
      "never-synced": "从未同步",
      offline: "未登录",
    },
    never: "从未",
    justNow: "刚刚",
    minutesAgo: (n) => `${n} 分钟前`,
    hoursAgo: (n) => `${n} 小时前`,
    conflictLead: "本机和 OneDrive 在上次同步后都有改动。请选择保留哪一份——两者不会合并。",
    thisDevice: "本机",
    oneDrive: "OneDrive",
    uploadMine: "上传本机的（覆盖 OneDrive）",
    replaceMine: "改用 OneDrive 的（丢弃本机改动）",
    ofTotal: (done, total) => `——${num(done)}/${num(total)}`,
    failed: (message) => `失败：${message}`,
    finished: "已完成。",

    localServer: "本地服务器",
    noServer:
      "本地服务器没有运行，所以档案直接从 OneDrive 读取，图片只缓存在这个浏览器里。同步、保存到本机和生成都需要桌面应用。",

    library: "照片库",
    notSignedIn: "未登录。",
    photos: "照片",
    analyzed: "已由 AI 描述",
    days: "已写摘要的天数",
    sections: "旅行与月份",
    schema: "数据结构版本",

    scan: "扫描",
    lastScanned: "上次扫描",
    whatToScan: "扫描范围",
    scanModes: { incremental: "自上次扫描以来", full: "整个照片库", range: "指定月份范围" },
    scanNotes: {
      incremental:
        "从上次扫描的那个月开始扫描。更早月份里从 OneDrive 删除的照片不会被发现——偶尔运行一次完整扫描来处理这些。",
      full: "列出每个月份文件夹。只有这种方式能发现照片库中任何位置从 OneDrive 删除的照片。",
      range: "只扫描你选的月份。范围之外删除的照片保持不变。",
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
    noKey: "没有 API 密钥——无法生成",
    keySaved: "已保存——输入新密钥即可替换",
    keyPaste: "粘贴你的 API 密钥",
    keyNote: (path) => `保存在 ${path}。只有生成需要它；浏览和阅读档案不需要。`,
    shadowed: (name) =>
      `${name} 同时也设成了系统环境变量，应用重启后它会覆盖这个文件里的值。请在系统里修改或删除它，这里保存的密钥才能保留下来。`,

    sync: "同步",
    checkingOneDrive: "正在检查 OneDrive…",
    lastChecked: "上次检查",
    lastSynced: "上次同步",
    checkNow: "立即检查",
    syncNow: "立即同步",

    kept: "保存在本机的内容",
    nothingPinned:
      "还没有保存任何内容到本机。打开一次旅行或一个月份，选择“保存到本机”，它的照片就会留在这里——同步时下载，永远不会为了腾出空间而被清除。",
    pinTrip: "旅行",
    pinMonth: "月份",
    withOriginals: "含原图",
    unpin: "取消保存",
    includeOriginals: "同时保存原图",
    thumbnailsOnly: "仅缩略图",
    autoCheck: "应用启动时检查更改",
    checkEvery: "运行期间，每隔多久检查一次",
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
    storageNote: "即使清除，保存到本机的内容也会保留。其余内容需要时会重新下载。",
  },

  generate: {
    tabs: { trip: "旅行", analyze: "分析", organize: "当天摘要", translate: "翻译" },

    tripNoteHtml:
      "根据<em>当天摘要</em>写出一次旅行的故事——所以请先对这段日期运行“分析”和“当天摘要”，否则它没有素材可用。",
    notes: "备注（可选）",
    notesPlaceholder: "任何值得一提的事——计划、同行的人、旅行的目的。",
    documents: "背景文档（.txt、.md）",
    name: "名称（留空则由模型提议）",
    writeNarrative: "撰写游记",
    tripAllowMissing: "即使大多数日子还没有摘要，也照样撰写",

    analyzeNoteHtml:
      "为范围内所有还没看过的照片写说明，每张调用一次模型。<strong>这是花钱的一步</strong>——请先查看估算。重复运行是安全的：已有说明的照片会被跳过。",
    estimateCost: "估算费用",
    analyze: "分析",
    nothingToAnalyze: "这段日期内没有需要分析的照片——已经分析过，或作为重复照片和不公开的截图被过滤掉了。",
    analyzePlan: (photos, months, input, output) =>
      `${num(photos)} 张照片，分布在 ${num(months)} 个月——约 ${millions(input)}M 输入 token、${millions(output)}M 输出 token。`,
    batchLabel: "批量提交——半价，一天内出结果，自动收取",
    batchEstimate: "批量提交约为一半。",
    batchesTitle: "批量任务",
    batchState: {
      pending: "等待中",
      running: "运行中",
      succeeded: "可以收取",
      failed: "失败",
      cancelled: "已取消",
      expired: "已过期",
      collected: "已收取",
    },
    batchRow: (when, photos, state, applied) =>
      `${when} · ${num(photos)} 张照片 · ${state}${applied !== null ? ` · 已写说明 ${num(applied)} 张` : ""}`,
    collectNow: "立即收取",

    organizeNoteHtml:
      "把“分析”写出的说明整理成每天的页面：把每一天按停留的地点分组、命名，并挑选要展示的内容。每天一次纯文本模型调用——不发送图片，所以很便宜。<strong>请在“分析”之后、“旅行”之前运行。</strong>",
    months: "月份",
    monthOption: (month, photos) => `${month} · ${num(photos)} 张照片`,
    includeUnchanged: "包括没有变化的日子",
    findDays: "查找要写摘要的日子",
    noDays: "这里没有需要写摘要的日子。",
    canSummarise: (n) => `可以为 ${num(n)} 天写摘要。`,
    reuse: (n) => `${num(n)} 天已是最新，或不在此范围内`,
    noAnalyzed: (n) => `${num(n)} 天还没有分析过的照片——请先对它们运行“分析”`,
    outOfScope: (n) => `${num(n)} 天不在此范围内`,
    undated: (n) => `${num(n)} 天没有可用的日期`,
    small: (n, min) => `${num(n)} 天照片不超过 ${min} 张且不属于任何旅程——不写摘要`,
    planDay: (date, photos) => `${date} · ${num(photos)} 张照片`,
    truncated: "只列出了前 300 天——按月份缩小范围可查看其余的。",
    selectNone: "全部取消",
    selectAll: "全选",
    nothingSelected: "未选择",
    summarise: (n) => `为 ${num(n)} 天写摘要`,
    couldNotCheck: (message) => `无法检查：${message}`,

    translateNote:
      "把档案里已有的文字翻译成简体中文，与英文并存——包括照片说明、每天的页面和旅行。只发送文字、不发送照片，所以比“分析”便宜得多。这是机器翻译：译文会比较朴素。重复运行只会翻译新增或改动过的内容。",
    whatToTranslate: "翻译内容",
    translateScopes: { all: "全部", day: "每天的页面和旅行", captions: "照片说明" },
    estimate: "估算",
    translate: "翻译",
    nothingToTranslate: (strings) => `没有需要翻译的——范围内的 ${num(strings)} 条文字都已有译文。`,
    translatePlan: (missing, strings, chars, input, output) =>
      `${num(strings)} 条文字中有 ${num(missing)} 条需要翻译（${num(chars)} 个字符）——约 ${millions(input)}M 输入 token、${millions(output)}M 输出 token。实际数量以运行结果为准。`,
    couldNotEstimate: (message) => `无法估算：${message}`,

    jobKind: {
      scan: "扫描",
      analyze: "分析",
      organize: "当天摘要",
      trip: "旅行",
      sync: "同步",
      translate: "翻译",
      collect: "收取结果",
      locate: "定位",
    },
    jobStatus: {
      queued: "排队中",
      running: "运行中",
      done: "完成",
      failed: "失败",
      cancelled: "已取消",
    },
    jobFailed: (message) => `失败：${message}`,
  },

  search: {
    placeholder: "搜索说明、地点与摘要",
    loading: "正在加载搜索索引…",
    unavailable: "还没有可搜索的内容——请先运行“分析”和“当天摘要”。",
    ready: (photos, days) => `${num(photos)} 张照片、${num(days)} 天可供搜索。`,
    found: (photos, days, ms) => `${num(photos)} 张照片，分布在 ${num(days)} 天 · ${num(ms)} 毫秒`,
    photosMatched: (n) => `${num(n)} 张匹配`,
  },

  activity: {
    loading: "正在加载活动…",
    now: "正在进行",
    idle: "当前没有运行中的任务。",
    waitingForGoogle: (photos, ago) => `本机没有运行中的任务。正在等待 Google：${num(photos)} 张照片，${ago}前提交。`,
    readyToCollect: (photos) => `Google 已处理完 ${num(photos)} 张照片，将在十分钟内收取。`,
    batches: "照片说明批量任务",
    noBatches: "还没有提交过照片说明批量任务。",
    batchDetail: (applied, failed, input, output, cost) => {
      const parts: string[] = [];
      if (applied !== null) parts.push(`已写说明 ${num(applied)} 张`);
      if (failed) parts.push(`${num(failed)} 张没有说明`);
      if (input !== null && output !== null) parts.push(`输入 ${num(input)}、输出 ${num(output)} token`);
      if (cost !== null) parts.push(cost);
      return parts.join(" · ");
    },
    money: (usd, gbp) => `${usd}（约 ${gbp}）`,
    batchTotal: (spent, waiting) =>
      `已收取的批量任务按批量价格共计 ${spent}${waiting ? `，另有 ${num(waiting)} 张照片仍在 Google 处理中` : ""}。`,
    autoSubmit: (waiting, since) =>
      `正在自动提交其余照片，每次一批——此账户的 Google 队列一次只能容纳一批。${
        waiting ? "下面这一批收取后，会提交下一批。" : "下一批即将提交。"
      }自 ${since} 起开启。`,
    stopAutoSubmit: "停止自动提交",
    autoSubmitStopped: "已停止自动提交。已在 Google 处理的批量任务仍会被收取。",
    thumbnails: "缩略图",
    warming: (done, total, failed, finished) =>
      `${finished ? "已缓存" : "正在缓存"} ${num(done)} / ${num(total)}${failed ? ` · ${num(failed)} 张无法获取` : ""}`,
    history: "最近的任务",
    noHistory: "还没有运行过任务。",
    duration: (ms) => {
      const seconds = Math.round(ms / 1000);
      if (seconds < 60) return `${seconds} 秒`;
      const minutes = Math.round(seconds / 60);
      return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
    },
    noServer: "“活动”需要本地服务器，也就是桌面应用。",
  },

  mobile: {
    tabs: { home: "首页", trips: "旅行", library: "图库", search: "搜索" },
    back: "返回",
    signInTitle: "你的照片档案",
    signInLead: "请用存有档案的 OneDrive 所属的 Microsoft 账户登录。照片仍保存在 OneDrive 中，本应用只读取它们。",
    sessionExpired: "Microsoft 登录已过期。",
    signInAgain: "登录",
    archiveUpdated: "档案已有更新。",
    refresh: "刷新",
    offline: "当前离线，仅显示本机已保存的内容。",
    trips: "旅行",
    seeAll: "全部",
    noTrips: "还没有旅行。旅行需在桌面应用中设定。",
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
    noPhotos: "这一天没有照片。",
    stops: "地点",
    moreInCard: (n: number) => `+${num(n)}`,
    info: "详情",
    fullResolution: "原图",
    counter: (i: number, n: number) => `${num(i)} / ${num(n)}`,
    account: "账户",
    microsoftAccount: "Microsoft 账户",
    thumbnails: "缩略图",
    signedInAs: (name: string) => `已登录：${name}`,
    cache: "保存在本机",
    cacheSize: (photos: number, mb: string) => `${num(photos)} 张缩略图 · ${mb} MB`,
    source: "直接从 OneDrive 读取。生成说明和摘要需要桌面应用。",
    tapPlace: "双指缩放 · 点按地点查看日期",
  },
};
