// ---------- 共享基础设施（core） ----------
// 由原 options/options.js 顶层 7 个全局对象拆出：config / dom / state / store / utils / runtimeConfig / services。
// 本模块无外部依赖，是模块图中第一个被完全求值的模块；所有类模块经 ES import 引用本模块导出物。

// ---------- config ----------
export const config = {
  // 视频重试
  VIDEO_RETRY_DELAYS: [200, 400, 600],
  VIDEO_RETRY_MAX: 3,
  VIDEO_RETRY_FALLBACK_DELAY: 1000,

  // 媒体熔断：窗口内失败密集超阈值时暂停媒体重试（网络异常降级）
  MEDIA_FAIL_WINDOW: 5000,
  MEDIA_FAIL_MAX: 10,
  MEDIA_BREAK_COOLDOWN: 15000,

  // 超时
  FETCH_RETRY_DELAY: 1000,
  SYNC_TIMEOUT: 30000,  // fallback; primary = runtimeConfig._cache?.timeoutRequest
  VIDEO_FALLBACK_TIMEOUT: 5000,

  // UI 延迟
  HOVER_PREVIEW_DELAY: 200,
  BLOB_REVOKE_DELAY: 10000,
  NOTE_AUTO_PLAY_INTERVAL: 3000,
  SEARCH_DEBOUNCE: 200,

  // 侧边栏
  SIDEBAR_SNAP_POINTS: [650, 0],
  SIDEBAR_SCROLL_THRESHOLD: 100,
  SIDEBAR_FILL_THRESHOLD: 50,
  SIDEBAR_IMG_PER_FRAME: 6,
  SIDEBAR_DRAG_THRESHOLD: 4,

  // 卡片（CARD_HEIGHT_OFFSET = 封面矩形外的信息块高度，8+18+2+16 = 44）
  CARD_SIZE_FALLBACK: 261,
  CARD_GAP: 11,
  CARD_HEIGHT_OFFSET: 44,

  // 详情页
  DETAIL_TITLE_MAX_LEN: 40,
  TOAST_DURATION: 2000,
  TOAST_ERROR_DURATION: 4500,
  DOWNLOAD_MAX_RETRY: 1,

  // 分块渲染
  RENDER_CHUNK_SIZE: 50,
  RENDER_BUILD_BUDGET_MS: 8,
  // 填充带（预填圈）：带键骨架进入滚动口+N 即触发填充。1600px ≈ 4 行——给结构填充
  // 后的封面探针留网络提前量（正常滚速下封面在入画前已提交）。取值须 < OBSERVE_CHUNK_SIZE
  // 的单圈行距（48 张 ≈ 6 行 ≈ 2400px）——哨兵链的观察前沿要永远盖得住填充带
  OBSERVER_ROOT_MARGIN: "1600px",
  OBSERVE_CHUNK_SIZE: 48,
  FILL_FRAME_BUDGET_MS: 8,
  // 卸载带：完整卡滚出滚动口+N 降级回骨架。与填充圈（1600px）保持 800px 滞回间隙——
  // 振幅超过间隙的往返滚动才会触发同一批卡反复填/降级（发生在屏外、探针走 HTTP 缓存，
  // 单次成本毫秒级），勿把两圈调到重合；任何闲置预热范围必须 ⊆ 卸载圈（圈外卡填完
  // 会被 unload IO 立即降级，fill→demote 对冲空转）
  UNLOAD_ROOT_MARGIN: "2400px",
  FAST_SCROLL_THRESHOLD: 300,
  // 预铺槽位上限 + 接近底部扩容阈值（剩余空间 < N 屏时倍增扩容）：
  // 活 DOM 规模由此封顶——切组拆卸、布局、绘制的 O(N) 成本全部以 N=已挂载数为分母
  GRID_PREMOUNT_CAP: 1500,
  // 筛选态（封闭视图）预铺上限：筛选视图全量已知、无「未来分页」占位需求，且每次
  // 筛选切换都全量拆建——预铺数直接决定切换的 DOM 成本；滚近底部由键控扩容
  // （#extendIfNeeded 键控分支）倍增补齐真实键卡
  GRID_PREMOUNT_CAP_FILTER: 600,
  GRID_EXTEND_THRESHOLD: 1.5,
  // 扩容单步新增槽位上限：深域（十万级 totalSlots）倍增到后段时单步会是数千上万张
  // 占位卡克隆 + 整容器布局的长任务——超出部分留待后续滚动 rAF 继续扩，小槽位段
  // 倍增语义不变（2S < S+步长时仍按倍增）
  GRID_EXTEND_STEP: 1000,
  // 停稳降级分帧预算：快滚期冻结的降级在停稳后成批积压（沿途数千张），一次性执行
  // 是数百毫秒单任务——按帧预算分帧执行且让位于填充队列
  DEMOTE_FRAME_BUDGET_MS: 8,
  // 网格媒体探针每帧派发配额（works 封面 + followings 头像；sidebar 窄列沿用
  // SIDEBAR_IMG_PER_FRAME）。滚入新带时数十张探针按 6/帧要摊十几帧——提到 10
  // 缩短起跑排队；派发只是 new Image()，实际网络并发由浏览器按 host 连接数自限
  GRID_IMG_PER_FRAME: 10,

  // 分组/存储
  TAB_SCROLL_THRESHOLD: 2,
  GROUP_NAME_MAX_LEN: 20,
  STORAGE_MAX_BYTES: 10 * 1024 * 1024,
  TRASH_GROUP_NAME: "稍后删除",

  // URL
  URL_BASE: "https://www.douyin.com",
  URL_USER_SELF: "https://www.douyin.com/user/self",
  URL_LIKE_TAB: "?showTab=like",
  URL_COLLECTION_TAB: "?showTab=favorite_collection",
  URL_FOLLOWING_TAB: "?showTab=following",

  // 域元数据：作品型三域（works/likes/favorites）同构 Work 记录，followings 独立结构
  WORK_LIKE_DOMAINS: ["works", "likes", "favorites"],
  DOMAINS_META: {
    works: { label: "作品", itemKey: "works", idKey: "awemeId", isFollowings: false },
    followings: { label: "关注", itemKey: "followings", idKey: "uid", isFollowings: true },
    likes: { label: "点赞", itemKey: "likes", idKey: "awemeId", isFollowings: false },
    favorites: { label: "收藏", itemKey: "favorites", idKey: "awemeId", isFollowings: false },
  },

  // 正则
  SEC_UID_REGEX: /^\/user\/([^/?]+)/,

  // 图标（运行时填充）
  icons: {},
};

// ---------- dom ----------
export const dom = {
  domainSwitch: document.querySelector(".domain-switch"),
  dsSlider: document.querySelector(".ds-slider"),
  groupTabs: document.querySelector("#groupTabs"),
  mainContainer: document.querySelector("#mainContainer"),
  emptyState: document.querySelector("#emptyState"),
  batchMove: document.querySelector("#btnBatchMove"),
  batchDelete: document.querySelector("#btnBatchDelete"),
  batchSelectAll: document.querySelector("#btnBatchSelectAll"),
  detailOverlay: document.querySelector("#detailOverlay"),
  detailClose: document.querySelector("#detailClose"),
  detailVideoContainer: document.querySelector("#detailVideoContainer"),
  detailVideoWrap: document.querySelector("#detailVideoWrap"),
  detailVideo: document.querySelector("#detailVideo"),
  detailImageContainer: document.querySelector("#detailImageContainer"),
  detailImage: document.querySelector("#detailImage"),
  detailAudio: document.querySelector("#detailAudio"),
  detailNavLeft: document.querySelector("#detailNavLeft"),
  detailNavRight: document.querySelector("#detailNavRight"),
  detailLoader: document.querySelector("#detailLoader"),
  detailProgress: document.querySelector("#detailProgress"),
  noteSegs: document.querySelector("#noteSegs"),
  detailOrder: document.querySelector("#detailOrder"),
  detailSwitchPrev: document.querySelector("#detailSwitchPrev"),
  detailSwitchNext: document.querySelector("#detailSwitchNext"),
  detailPlayBtn: document.querySelector("#detailPlayBtn"),
  detailTime: document.querySelector("#detailTime"),
  detailAuthor: document.querySelector("#detailAuthor"),
  detailTitle: document.querySelector("#detailTitle"),
  detailTitleText: document.querySelector("#detailTitleText"),
  detailCreateTime: document.querySelector("#detailCreateTime"),
  detailMuteBtn: document.querySelector("#detailMuteBtn"),
  detailRemoveBtn: document.querySelector("#detailRemoveBtn"),
  detailLoopBtn: document.querySelector("#detailLoopBtn"),
  detailDownloadBtn: document.querySelector("#detailDownloadBtn"),
  detailCounter: document.querySelector("#detailCounter"),
  detailCounterInput: document.querySelector("#detailCounterInput"),
  detailCounterTotal: document.querySelector("#detailCounterTotal"),
  detailBody: document.querySelector(".detail-body"),
  dialogOverlay: document.querySelector("#dialogOverlay"),
  // 弹窗四元素由 Dialog 动态指向顶层实例元素（仅 components/dialog.js 可写），即时访问自动命中顶层；
  // dialogOverlay 恒指基层，其 hidden 即「有无弹窗」全局信号
  dialogTitle: document.querySelector("#dialogTitle"),
  dialogBody: document.querySelector("#dialogBody"),
  dialogFooter: document.querySelector("#dialogFooter"),
  dialogClose: document.querySelector("#dialogClose"),
  fileInput: document.querySelector("#fileInput"),
  btnDataTools: document.querySelector("#btnDataTools"),
  btnSync: document.querySelector("#btnSync"),
  btnBatch: document.querySelector("#btnBatch"),
  btnGroupManage: document.querySelector("#btnGroupManage"),
  mainGrid: document.querySelector("#mainGrid"),
  errorState: document.querySelector("#errorState"),
  btnRetry: document.querySelector("#btnRetry"),
  btnAuthorImport: document.querySelector("#btnAuthorImport"),
  btnSettings: document.querySelector("#btnSettings"),
  menuStorage: document.querySelector("#menuStorage"),
  leftSidebar: document.querySelector("#leftSidebar"),
  btnSidebarToggle: document.querySelector("#btnSidebarToggle"),
  sidebar: document.querySelector("#sidebar"),
  sidebarBody: document.querySelector("#sidebarBody"),
  sidebarWorksGrid: document.querySelector("#sidebarWorksGrid"),
  sidebarLoader: document.querySelector("#sidebarLoader"),
  sidebarResizeHandle: document.querySelector("#sidebarResizeHandle"),
  sidebarWorkTemplate: document.querySelector("#sidebarWorkTemplate"),
  batchSaveToWorks: document.querySelector("#btnBatchSaveToWorks"),
  batchDownload: document.querySelector("#btnBatchDownload"),
  batchCount: document.querySelector("#batchCount"),
  searchBar: document.querySelector("#searchBar"),
  searchInput: document.querySelector("#searchInput"),
  sbCount: document.querySelector("#sbCount"),
  sbScope: document.querySelector("#sbScope"),
  sbScopeAuthor: document.querySelector("#sbScopeAuthor"),
  sbScopeTitle: document.querySelector("#sbScopeTitle"),
  sbWorkFilters: document.querySelector("#sbWorkFilters"),
  sbSort: document.querySelector("#sbSort"),
  sbWorkType: document.querySelector("#sbWorkType"),
  sbFollowFilters: document.querySelector("#sbFollowFilters"),
  sbFollowSort: document.querySelector("#sbFollowSort"),
  sbFollowed: document.querySelector("#sbFollowed"),
  sbUnfollowed: document.querySelector("#sbUnfollowed"),
  sbReverse: document.querySelector("#sbReverse"),
  btnCloseSearch: document.querySelector("#btnCloseSearch"),
  btnClearInBar: document.querySelector("#btnClearInBar"),
  btnSearchMenu: document.querySelector("#btnSearch"),
};

// ---------- state ----------
export const state = {
  domain: "works",
  works: [],
  followings: [],
  likes: [],
  favorites: [],
  currentGroupId: "all",
  batchMode: false,
  selectedIds: new Set(),
  activeDialog: null,
  currentFollowingSecUid: null,
  sidebarCursor: null,
  sidebarLoading: false,
  // 作者归属判定（方案A）：关注全集 uid 集合，全量加载不受分组影响；
  // followedUidsLoaded 标记加载成功，加载失败时保留旧集合并把“未关注”判定归零，避免误判全为未关注
  followedUids: new Set(),
  followedUidsLoaded: false,
  // 短操作弹窗锁：为 true 时禁止点击 X 关闭，待操作完成才解锁
  preventDialogClose: false,
  // 渐进加载的一次性预铺额度 { domain, groupId, total }：首页渲染时消费（renderCards
  // 读取后即清），按 total 一次铺满全量骨架，余页经 fillSlots 以键前缀自锚定回填
  gridSlots: null,
  // 域数据写入版本号：SearchBar 视图阶段缓存（#viewCache）的失效判据。store 的数据
  // 变更方法自动自增；绕过 store 封装的原地写入（main.js tryHeadInsert/applyStoreUpserts、
  // detail.removeWork 静默移除）与归属判定输入重载（services.loadFollowedUids）必须手动
  // 自增，否则缓存读到脏视图（红线见 docs/11「视图阶段缓存」）
  dataVersion: 0,
};

// ---------- store ----------
export const store = {
  _listeners: new Map(),

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event).delete(fn);
  },

  notify(event, ...args) {
    const fns = this._listeners.get(event);
    if (!fns) return;
    requestAnimationFrame(() => {
      fns.forEach((fn) => fn(...args));
    });
  },

  set(key, val) {
    const old = state[key];
    state[key] = val;
    if (old !== val) {
      // 域数据替换计入数据版本（domain/currentGroupId/batchMode 等非数据键不计）
      if (key === "followings" || config.WORK_LIKE_DOMAINS.includes(key)) state.dataVersion++;
      this.notify(key, val, old);
    }
  },

  // 触发 groups 数据重新加载（总是从 background 获取最新分组数据）
  refreshGroups() {
    this.notify("groups");
  },

  // 作品型三域通用的静默移除（按当前域数据源过滤）
  removeWorkLikeSilent(domain, idSet) {
    state[domain] = state[domain].filter((w) => !idSet.has(w.awemeId));
    state.dataVersion++;
  },

  // 分页渐进加载追加（作品型三域）：push 进域数组后发专属事件，与 set 的全量替换
  // 事件分流——避免逐页触发 refreshGridView 全量重渲（骨架闪烁 + 封面重探）。
  // start = push 前的域数组长度，作回填落点的上界提示：网格侧 #applyFill 以键前缀
  // 自锚定实际落点（删除会使 #slots 相对页序收缩，固定下标会整页写偏）。
  // 消费方（main.js）按筛选态决定按槽回填或静默累积
  appendWorkLike(domain, groupId, items, done) {
    const start = state[domain].length;
    state[domain].push(...items);
    state.dataVersion++;
    this.notify("work-like-appended", { domain, groupId, items, start, done });
  },

  removeFollowingsSilent(idSet) {
    state.followings = state.followings.filter((f) => !idSet.has(f.uid));
    state.dataVersion++;
  },

  spliceWork(idx, deleteCount = 1) {
    state.works.splice(idx, deleteCount);
    state.dataVersion++;
    this.notify("works", state.works);
  },
};

// ---------- utils ----------
export const utils = {
  pickHttpsUrl(url) {
    if (!url) return "";
    return url.startsWith("//") ? "https:" + url : url;
  },
  formatCount(num) {
    if (!num && num !== 0) return "0";
    const n = Number(num);
    if (n >= 10000) return (n / 10000).toFixed(1) + "w";
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return String(n);
  },
  getVideoUrl(work) {
    return this.pickHttpsUrl(work?.video || "");
  },
  // 背景图 url() 包装：转义引号/反斜杠（四网格/侧边栏/详情共用）
  cssUrl(url) {
    return `url("${url.replace(/["\\]/g, "\\$&")}")`;
  },
  secUidFromUrl(url) {
    if (!url) return "";
    const m = url.match(/\/user\/([^/?]+)/);
    return m ? m[1] : "";
  },
  formatCacheTime(ts) {
    if (!ts) return null;
    const d = new Date(ts);
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hour = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    if (d.toDateString() === new Date(now).toDateString()) return hour + ":" + min;
    return month + "/" + day + " " + hour + ":" + min;
  },
  // 关注者最近更新日期展示：今天 → "今天 HH:MM"，同年 → "M月D日 HH:MM"，更早 → "YYYY年M月D日"；无数据 → "—"
  formatUpdateTime(ts) {
    if (!ts) return "—";
    const d = new Date(ts);
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return "今天 " + hm;
    if (d.getFullYear() === now.getFullYear()) return d.getMonth() + 1 + "月" + d.getDate() + "日 " + hm;
    return d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日";
  },
  // 作品发布日期展示：create_time 为秒级 Unix 时间戳 → "YYYY-MM-DD"；缺失/0 返回空串（调用方隐藏日期位）
  formatPublishDate(sec) {
    if (!sec) return "";
    const d = new Date(sec * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  },
};

// ---------- runtimeConfig ----------
export const runtimeConfig = {
  KEY: "runtimeConfig",
  DEFAULTS: {
    timeoutRequest: 30000,
    timeoutSecurityStatus: 5000,
    syncWorksDelayMin: 500,
    syncWorksDelayMax: 1000,
    syncFollowingsDelayMin: 500,
    syncFollowingsDelayMax: 1000,
    syncFavoritesDelayMin: 500,
    syncFavoritesDelayMax: 1000,
    syncCollectionDelayMin: 500,
    syncCollectionDelayMax: 1000,
    cancelLikeDelayMin: 500,
    cancelLikeDelayMax: 1000,
    cancelCollectionDelayMin: 500,
    cancelCollectionDelayMax: 1000,
    syncBatchSize: 40,
    syncBatchPauseMin: 10000,
    syncBatchPauseMax: 20000,
    syncKeepaliveInterval: 2000,
    syncRetryMax: 2,
    calibrateFollowings: true,
  },
  _cache: null,
  async load() {
    if (this._cache) return this._cache;
    const stored = await chrome.storage.local.get(this.KEY);
    const cfg = stored[this.KEY];
    if (!cfg) {
      await chrome.storage.local.set({ [this.KEY]: { ...this.DEFAULTS } });
      this._cache = { ...this.DEFAULTS };
    } else {
      this._cache = { ...this.DEFAULTS, ...cfg };
    }
    return this._cache;
  },
  async save(values) {
    this._cache = { ...this.DEFAULTS, ...values };
    await chrome.storage.local.set({ [this.KEY]: this._cache });
    try {
      await services.bgMsg({ type: "RELOAD_CONFIG" });
    } catch (_) {}
  },
};

// ---------- services ----------
export const services = {
  // 网格渐进加载的全局代际计数：每次 loadDomainData 递增，作废所有在途分页循环
  _gridLoadSeq: 0,
  // 在途分页加载计数（并发加载各自 +1/-1，finally 保证必减）：STORE_CHANGED 增量收口
  // 的守卫输入——>0 时头插会与在途 fillSlots 的落点锚定交错（rAF 窗口内 start 基准
  // 过期），须整刷兜底（整刷重载本就会作废在途循环，口径最稳）
  _gridLoadCount: 0,

  bgMsg(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
        } else {
          resolve(res || {});
        }
      });
    });
  },

  async findSecUid() {
    // 配置面板填写的本地 secUid 优先（两模式通用）：它是用户显式指定的本人身份，
    // 比任意打开的 /user/* 标签页更可靠（后者可能是他人主页，同步「我的关注」会命中 2096）。
    const { independentMode, secUid } = await chrome.storage.local.get(["independentMode", "secUid"]);
    if (secUid && secUid !== "self") return secUid;

    // 未显式填写时，tab 模式回退到已打开的 /user/* 页面 URL
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs[0]?.url) {
      try {
        const m = new URL(tabs[0].url).pathname.match(config.SEC_UID_REGEX);
        if (m) return m[1];
      } catch (_) {}
    }
    const dt = await chrome.tabs.query({ url: "*://*.douyin.com/user/*" });
    for (const t of dt) {
      if (t.url?.includes("creator.douyin.com")) continue;
      try {
        const m2 = new URL(t.url).pathname.match(config.SEC_UID_REGEX);
        if (m2) return m2[1];
      } catch (_) {}
    }
    // 独立模式回退：background 经 uid cookie + im/user/info 兑换本人 sec_uid
    if (independentMode) {
      const res = await this.bgMsg({ type: "RESOLVE_SEC_UID" }).catch(() => {});
      if (res?.ok && res.secUid) return res.secUid;
    }
    return "";
  },

  async loadStats() {
    const res = await this.bgMsg({ type: "GET_STATS" });
    const s = res.stats || {};
    return {
      works: s.works || { total: 0, groupCounts: {} },
      followings: s.followings || { total: 0, groupCounts: {} },
      likes: s.likes || { total: 0, groupCounts: {} },
      favorites: s.favorites || { total: 0, groupCounts: {} },
      bytes: s.bytes || 0,
    };
  },

  // 作品型三域通用读取（works/likes/favorites 响应形状一致，仅 itemKey 不同）
  async loadWorkLikeItems(domain, groupId) {
    const meta = config.DOMAINS_META[domain];
    const res = await this.bgMsg({ type: "GET_" + domain.toUpperCase(), groupId });
    return (res[meta.itemKey] || []).filter((w) => w && w.awemeId);
  },

  async loadWorks(groupId) {
    // IDB 主键读取天然无重复
    return this.loadWorkLikeItems("works", groupId);
  },

  async loadFollowings(groupId) {
    const res = await this.bgMsg({ type: "GET_FOLLOWINGS", groupId: groupId || state.currentGroupId });
    return (res.followings || []).filter((f) => f && f.uid);
  },

  // 作者归属判定用关注全集（方案A）：全量加载不受分组影响，直接建 uid 集合。
  // 加载失败时保留旧集合并保持 followedUidsLoaded=false，避免把全部作品误判为「未关注」
  async loadFollowedUids() {
    const res = await this.bgMsg({ type: "GET_FOLLOWINGS", groupId: "all" }).catch(() => null);
    if (!res || !Array.isArray(res.followings)) return false;
    state.followedUidsLoaded = true;
    state.followedUids = new Set(res.followings.filter((f) => f && f.uid).map((f) => String(f.uid)));
    // 归属筛选（已关注/未关注）的判定输入变化：计入数据版本，视图缓存随之失效
    state.dataVersion++;
    return true;
  },

  async loadGroups(domain) {
    const res = await this.bgMsg({ type: "GET_GROUPS", domain: domain || state.domain });
    return res.groups || [];
  },

  isGridLoading() {
    return this._gridLoadCount > 0;
  },

  // 网格数据加载：作品型三域分页渐进（首页 store.set 即渲染，余量逐页 appendWorkLike，
  // 消费方决定追加渲染或静默累积）；followings 记录小，维持单发全量。
  // 翻页协议：page=0 取首页，后续以 bg 回传的 nextCursor（末条索引键）keyset 续传——
  // bg 端索引游标直出、无全量读取，首页延迟在几十毫秒量级。
  // _gridLoadSeq 为全局加载代际：任何新加载（切组/切域/STORE_CHANGED）作废在途旧循环；
  // 循环体内再校验当前域/分组，双保险防止旧页混入新视图
  async loadDomainData() {
    const groupId = state.currentGroupId;
    const domain = state.domain;
    this._gridLoadCount++;
    try {
      if (domain === "followings") {
        const data = await this.loadFollowings(groupId);
        if (state.currentGroupId !== groupId || state.domain !== domain) return;
        store.set(domain, data);
        return;
      }
      const meta = config.DOMAINS_META[domain];
      const seq = ++this._gridLoadSeq;
      const stale = () => seq !== this._gridLoadSeq || state.currentGroupId !== groupId || state.domain !== domain;
      const t0 = performance.now();
      let res = await this.bgMsg({ type: "GET_" + domain.toUpperCase(), groupId, page: 0 });
      if (res.error) throw new Error(res.error);
      if (stale()) return;
      // 预铺额度：首页响应携带 total，render 按它一次铺满全量骨架（未到达页为占位卡）
      state.gridSlots = { domain, groupId, total: res.total || 0 };
      store.set(domain, (res[meta.itemKey] || []).filter((w) => w && w.awemeId));
      let pages = 1;
      while (res.hasMore) {
        res = await this.bgMsg({ type: "GET_" + domain.toUpperCase(), groupId, cursor: res.nextCursor });
        if (res.error) {
          // 游标续页失败（SW 被强制重启等）：网格停在已加载部分，badge 数字为准，
          // 下次加载自愈；不自动重启避免循环
          console.warn("[DDM] grid load stopped:", res.error);
          break;
        }
        if (stale()) return;
        pages++;
        store.appendWorkLike(domain, groupId, (res[meta.itemKey] || []).filter((w) => w && w.awemeId), !res.hasMore);
      }
      console.debug(
        `[DDM] grid load ${domain}/${groupId}: ${pages} page(s) in ${Math.round(performance.now() - t0)}ms`,
      );
    } finally {
      this._gridLoadCount--;
    }
  },

  async deleteFollowings(uids) {
    return this.bgMsg({ type: "DELETE_FOLLOWINGS", uids });
  },

  async moveFollowings(uids, targetGroupId) {
    return this.bgMsg({ type: "MOVE_FOLLOWINGS", uids, targetGroupId });
  },

  // 找/建「稍后删除」分组并把条目移入（works/followings/likes/favorites 域通用；
  // moveFn(groupId) 按域完成实际移动，随后统一刷新域数据与分组）
  async moveToTrashGroup(domain, ids, moveFn) {
    const groupsRes = await this.bgMsg({ type: "GET_GROUPS", domain });
    const groups = groupsRes.groups || [];
    let trashGroup = groups.find((g) => g.name === config.TRASH_GROUP_NAME);
    if (!trashGroup) {
      const addRes = await this.bgMsg({ type: "ADD_GROUP", domain, name: config.TRASH_GROUP_NAME });
      if (addRes.ok) trashGroup = addRes.group;
    }
    if (trashGroup) {
      await moveFn(trashGroup.id);
      await this.loadDomainData();
      store.refreshGroups();
    }
    return trashGroup;
  },

  // 作品型三域通用删除/移动（DELETE_/MOVE_ + 域名大写）
  deleteWorkLike(domain, awemeIds) {
    return this.bgMsg({ type: "DELETE_" + domain.toUpperCase(), awemeIds });
  },

  moveWorkLike(domain, awemeIds, targetGroupId) {
    return this.bgMsg({ type: "MOVE_" + domain.toUpperCase(), awemeIds, targetGroupId });
  },
};
