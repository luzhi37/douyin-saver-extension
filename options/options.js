// ---------- config ----------
const config = {
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

  // 卡片
  CARD_SIZE_FALLBACK: 261,
  CARD_GAP: 9,
  CARD_HEIGHT_OFFSET: 35,

  // 详情页
  DETAIL_TITLE_MAX_LEN: 40,
  TOAST_DURATION: 2000,
  TOAST_ERROR_DURATION: 4500,
  DOWNLOAD_MAX_RETRY: 1,

  // 分块渲染
  RENDER_CHUNK_SIZE: 50,
  OBSERVER_ROOT_MARGIN: "200px",
  OBSERVE_CHUNK_SIZE: 48,
  FILL_FRAME_BUDGET_MS: 8,
  UNLOAD_ROOT_MARGIN: "1200px",

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

  // 正则
  SEC_UID_REGEX: /^\/user\/([^/?]+)/,

  // 图标（运行时填充）
  icons: {},
};

// ---------- dom ----------
const dom = {
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
  detailImgCounter: document.querySelector("#detailImgCounter"),
  detailNavLeft: document.querySelector("#detailNavLeft"),
  detailNavRight: document.querySelector("#detailNavRight"),
  detailLoader: document.querySelector("#detailLoader"),
  detailProgressSlider: document.querySelector("#detailProgressSlider"),
  detailPlayBtn: document.querySelector("#detailPlayBtn"),
  detailTime: document.querySelector("#detailTime"),
  detailAuthor: document.querySelector("#detailAuthor"),
  detailTitle: document.querySelector("#detailTitle"),
  detailMuteBtn: document.querySelector("#detailMuteBtn"),
  detailRemoveBtn: document.querySelector("#detailRemoveBtn"),
  detailLoopBtn: document.querySelector("#detailLoopBtn"),
  detailSyncBtn: document.querySelector("#detailSyncBtn"),
  detailDownloadBtn: document.querySelector("#detailDownloadBtn"),
  detailCounter: document.querySelector("#detailCounter"),
  detailBody: document.querySelector(".detail-body"),
  dialogOverlay: document.querySelector("#dialogOverlay"),
  dialogTitle: document.querySelector("#dialogTitle"),
  dialogBody: document.querySelector("#dialogBody"),
  dialogFooter: document.querySelector("#dialogFooter"),
  dialogClose: document.querySelector("#dialogClose"),
  fileInput: document.querySelector("#fileInput"),
  btnImport: document.querySelector("#btnImport"),
  btnExport: document.querySelector("#btnExport"),
  btnSync: document.querySelector("#btnSync"),
  btnReset: document.querySelector("#btnReset"),
  btnBatch: document.querySelector("#btnBatch"),
  btnGroupManage: document.querySelector("#btnGroupManage"),
  mainGrid: document.querySelector("#mainGrid"),
  errorState: document.querySelector("#errorState"),
  btnMenu: document.querySelector("#btnMenu"),
  menuDropdown: document.querySelector("#menuDropdown"),
  menuStorage: document.querySelector("#menuStorage"),
  btnRetry: document.querySelector("#btnRetry"),
  btnSettings: document.querySelector("#btnSettings"),
  sidebar: document.querySelector("#sidebar"),
  sidebarBody: document.querySelector("#sidebarBody"),
  sidebarWorksGrid: document.querySelector("#sidebarWorksGrid"),
  sidebarLoader: document.querySelector("#sidebarLoader"),
  sidebarResizeHandle: document.querySelector("#sidebarResizeHandle"),
  sidebarWorkTemplate: document.querySelector("#sidebarWorkTemplate"),
  btnFavorites: document.querySelector("#btnFavorites"),
  btnCollections: document.querySelector("#btnCollections"),
  batchCount: document.querySelector("#batchCount"),
  filterBar: document.querySelector("#filterBar"),
  filterBarText: document.querySelector("#filterBarText"),
  btnClearFilter: document.querySelector("#btnClearFilter"),
  searchBar: document.querySelector("#searchBar"),
  searchInput: document.querySelector("#searchInput"),
  sbScope: document.querySelector("#sbScope"),
  sbScopeAuthor: document.querySelector("#sbScopeAuthor"),
  sbScopeTitle: document.querySelector("#sbScopeTitle"),
  sbWorkFilters: document.querySelector("#sbWorkFilters"),
  sbSort: document.querySelector("#sbSort"),
  sbFollowFilters: document.querySelector("#sbFollowFilters"),
  sbFollowSort: document.querySelector("#sbFollowSort"),
  sbReverse: document.querySelector("#sbReverse"),
  btnCloseSearch: document.querySelector("#btnCloseSearch"),
  btnClearInBar: document.querySelector("#btnClearInBar"),
  btnSearchMenu: document.querySelector("#btnSearch"),
};

// ---------- state ----------
const state = {
  domain: "works",
  works: [],
  followings: [],
  currentGroupId: "all",
  batchMode: false,
  selectedIds: new Set(),
  activeDialog: null,
  currentFollowingSecUid: null,
  sidebarCursor: null,
  sidebarLoading: false,
  // Favorites 内部状态：仅 Favorites class 读写，不需 store.set() 响应式通知
  favoriteWorks: [],
  favoriteFetching: false,
  cancelingFavorites: false,
  collectionWorks: [],
  collectionFetching: false,
  cancelingCollections: false,
  // 短操作弹窗锁：为 true 时禁止点击 X 关闭，待操作完成才解锁
  preventDialogClose: false,
};

// ---------- store ----------
const store = {
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
    if (old !== val) this.notify(key, val, old);
  },

  // 触发 groups 数据重新加载（总是从 background 获取最新分组数据）
  refreshGroups() {
    this.notify("groups");
  },

  updateWork(awemeId, newWork) {
    const idx = state.works.findIndex((w) => w.awemeId === awemeId);
    if (idx === -1) return false;
    state.works[idx] = newWork;
    this.notify("work-updated", awemeId, newWork);
    return true;
  },

  removeWorksSilent(idSet) {
    state.works = state.works.filter((w) => !idSet.has(w.awemeId));
  },

  removeFollowingsSilent(idSet) {
    state.followings = state.followings.filter((f) => !idSet.has(f.uid));
  },

  spliceWork(idx, deleteCount = 1) {
    state.works.splice(idx, deleteCount);
    this.notify("works", state.works);
  },
};

// ---------- utils ----------
const utils = {
  SPINNER_HTML: '<div class="spinner"></div>',
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
  secUidFromUrl(url) {
    if (!url) return "";
    const m = url.split("/user/");
    return m.length > 1 ? m[1].split("?")[0] : "";
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
};

// ---------- 检索：搜索/排序 ----------
// 数据层过滤（docs/UI_IMPROVEMENTS.md 建议5）：state.works/followings 保持全量，
// 网格与 Detail 统一从视图函数取列表；VirtualGrid 按 id 解析点击，不受过滤影响
class SearchBar {
  static SEARCH_SCOPE_LABELS = { author: "作者", title: "标题", id: "ID" };
  static SEARCH_SORT_LABELS = { authorCount: "作者作品数" };
  static SEARCH_FOLLOWINGS_SORT_LABELS = { works: "作品数" };

  #searchState = {
    keyword: "",
    scope: "all", // all 综合 | author 作者(昵称) | title 标题 | id 作品ID/UID
    sort: "saved", // saved 保存时间 | authorCount 作者作品数（仅作品域）
    followingsSort: "followers", // followers 粉丝数 | works 作品数（仅关注域）
    reverse: false, // 逆序（翻转最终顺序，两域共用）
  };

  #debounceTimer = 0;

  constructor() {
    this.#bindEvents();
  }

  // ---------- 数据层：过滤与排序视图 ----------
  isFilterActive() {
    if (!this.#searchState.keyword.trim() && !this.#searchState.reverse) return false;
    return state.domain === "works"
      ? this.#searchState.sort !== "saved"
      : this.#searchState.followingsSort !== "followers";
  }

  // 关键词按「范围」取匹配字段（docs/UI_IMPROVEMENTS.md 建议5）
  #matchWork(work, kw) {
    switch (this.#searchState.scope) {
      case "author":
        return (work.nickname || "").toLowerCase().includes(kw) || String(work.uid || "").toLowerCase().includes(kw);
      case "title":
        return (work.desc || "").toLowerCase().includes(kw);
      case "id":
        return String(work.awemeId).toLowerCase().includes(kw);
      default:
        return (
          (work.desc || "").toLowerCase().includes(kw) ||
          (work.nickname || "").toLowerCase().includes(kw) ||
          String(work.awemeId).toLowerCase().includes(kw)
        );
    }
  }

  getWorksView() {
    const kw = this.#searchState.keyword.trim().toLowerCase();
    let list = state.works;
    if (kw) list = list.filter((w) => this.#matchWork(w, kw));
    if (this.#searchState.sort === "authorCount") {
      // 作者作品数按全库口径统计（关键词只决定哪些条目参与展示）。
      // 作者先按作品数降序排名、同数按 key 定序，保证同一作者的作品相邻；簇内按保存时间降序
      const counts = new Map();
      for (const w of state.works) {
        const key = w.uid || w.nickname || "";
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const rank = new Map(
        [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || (a < b ? -1 : 1)).map((k, i) => [k, i]),
      );
      const authorKey = (w) => w.uid || w.nickname || "";
      list = [...list].sort((a, b) => (rank.get(authorKey(a)) ?? 0) - (rank.get(authorKey(b)) ?? 0) || (b.savedAt || 0) - (a.savedAt || 0));
    } else {
      // 保存时间（savedAt）降序为基准，与 storage 层默认返回顺序一致
      list = [...list].sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    }
    if (this.#searchState.reverse) list.reverse();
    return list;
  }

  getFollowingsView() {
    const kw = this.#searchState.keyword.trim().toLowerCase();
    // 关注域无标题维度：title 范围（域切换残留）按昵称处理。
    // 无关键词也须拷贝后再排序，不得原地改动 state.followings
    let list = kw
      ? state.followings.filter((f) => {
          switch (this.#searchState.scope) {
            case "author":
            case "title":
              return (f.nickname || "").toLowerCase().includes(kw);
            case "id":
              return String(f.uid).toLowerCase().includes(kw);
            default:
              return (f.nickname || "").toLowerCase().includes(kw) || String(f.uid).toLowerCase().includes(kw);
          }
        })
      : [...state.followings];
    // 计数字段仅由校准写入、未校准占位为 0，排序时自然沉底；同数按 uid 定序保证稳定
    const field = this.#searchState.followingsSort === "works" ? "awemeCount" : "followerCount";
    list.sort((a, b) => (b[field] || 0) - (a[field] || 0) || String(a.uid).localeCompare(String(b.uid)));
    if (this.#searchState.reverse) list.reverse();
    return list;
  }

  // ---------- UI 同步 ----------
  updateFilterBar() {
    const parts = [];
    const kw = this.#searchState.keyword.trim();
    if (kw) parts.push(`${SearchBar.SEARCH_SCOPE_LABELS[this.#searchState.scope] || "关键词"} "${kw}"`);
    if (state.domain === "works") {
      if (this.#searchState.sort !== "saved") parts.push(SearchBar.SEARCH_SORT_LABELS[this.#searchState.sort]);
    } else if (this.#searchState.followingsSort !== "followers") {
      parts.push(SearchBar.SEARCH_FOLLOWINGS_SORT_LABELS[this.#searchState.followingsSort]);
    }
    if (this.#searchState.reverse) parts.push("逆序");
    // 搜索栏展开期间控件状态自可见，摘要条隐藏避免两行重复
    if (!parts.length || !this.isFilterActive() || this.#isSearchBarOpen()) {
      dom.filterBar.classList.add("hidden");
      return;
    }
    dom.filterBarText.textContent = parts.join(" · ");
    dom.filterBar.classList.remove("hidden");
  }

  // 域切换后搜索栏的域相关联动：排序段显隐（两域各有排序维度）/范围段文案/占位符/分段选中
  syncForDomain() {
    const isWorks = state.domain === "works";
    dom.sbWorkFilters.classList.toggle("hidden", !isWorks);
    dom.sbFollowFilters.classList.toggle("hidden", isWorks);
    this.syncScopeUIForDomain();
    this.#updateSearchPlaceholder();
    this.syncSegUI();
  }

  // store.on("domain") 的搜索栏联动入口：摘要条常刷；搜索栏展开期间才同步域差异
  onDomainChanged() {
    this.updateFilterBar();
    if (this.#isSearchBarOpen()) this.syncForDomain();
  }

  // 筛选变化后的统一入口：重渲当前域网格 + 同步筛选条
  refreshGridView() {
    if (state.domain === "works") worksGrid.renderCards();
    else followingsGrid.renderFollowingCards();
    this.updateFilterBar();
  }

  syncSegUI() {
    dom.sbScope.querySelectorAll(".sb-seg-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.scope === this.#searchState.scope);
    });
    dom.sbSort.querySelectorAll(".sb-seg-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.sort === this.#searchState.sort);
    });
    dom.sbFollowSort.querySelectorAll(".sb-seg-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.fsort === this.#searchState.followingsSort);
    });
    dom.sbReverse.checked = this.#searchState.reverse;
  }

  // 范围段的域差异：「标题」仅作品域；关注域下「作者」按钮文案为「昵称」，残留 title 范围回退综合
  syncScopeUIForDomain() {
    const isWorks = state.domain === "works";
    dom.sbScopeTitle.classList.toggle("hidden", !isWorks);
    dom.sbScopeAuthor.textContent = isWorks ? "作者" : "昵称";
    if (!isWorks && this.#searchState.scope === "title") this.#searchState.scope = "all";
  }

  #updateSearchPlaceholder() {
    const placeholders = state.domain === "works"
      ? { all: "搜索标题 / 作者 / ID", author: "输入作者昵称或 UID", title: "输入作品标题文案", id: "输入作品 ID" }
      : { all: "搜索昵称 / UID", author: "输入昵称", title: "输入昵称", id: "输入 UID" };
    dom.searchInput.placeholder = placeholders[this.#searchState.scope] || placeholders.all;
  }

  #isSearchBarOpen() {
    return !dom.searchBar.classList.contains("hidden");
  }

  #updateSearchMenuLabel() {
    dom.btnSearchMenu.textContent = this.#isSearchBarOpen() ? "收起搜索" : "搜索";
  }

  // ---------- 展开 / 收起 ----------
  openSearchBar() {
    if (this.#isSearchBarOpen()) return;
    dom.searchBar.classList.remove("hidden");
    // 排序段随域显隐；逆序复选框两域共用
    this.syncForDomain();
    dom.searchInput.value = this.#searchState.keyword;
    this.updateFilterBar();
    this.#updateSearchMenuLabel();
    dom.searchInput.focus();
    dom.searchInput.select();
  }

  closeSearchBar() {
    if (!this.#isSearchBarOpen()) return;
    dom.searchBar.classList.add("hidden");
    this.updateFilterBar();
    this.#updateSearchMenuLabel();
  }

  toggleSearchBar() {
    if (this.#isSearchBarOpen()) this.closeSearchBar();
    else this.openSearchBar();
  }

  applySearchInput() {
    clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => {
      this.#searchState.keyword = dom.searchInput.value;
      this.refreshGridView();
    }, config.SEARCH_DEBOUNCE);
  }

  clearSearchFilters() {
    this.#searchState.keyword = "";
    this.#searchState.scope = "all";
    this.#searchState.sort = "saved";
    this.#searchState.followingsSort = "followers";
    this.#searchState.reverse = false;
    dom.searchInput.value = "";
    this.syncScopeUIForDomain();
    this.#updateSearchPlaceholder();
    this.syncSegUI();
    this.refreshGridView();
  }

  // ---------- 事件绑定 ----------
  #bindEvents() {
    dom.searchInput.addEventListener("input", () => this.applySearchInput());
    dom.sbScope.addEventListener("click", (e) => {
      const btn = e.target.closest(".sb-seg-btn");
      if (!btn) return;
      this.#searchState.scope = btn.dataset.scope;
      this.syncSegUI();
      this.#updateSearchPlaceholder();
      this.refreshGridView();
    });
    dom.sbSort.addEventListener("click", (e) => {
      const btn = e.target.closest(".sb-seg-btn");
      if (!btn) return;
      this.#searchState.sort = btn.dataset.sort;
      this.syncSegUI();
      this.refreshGridView();
    });
    dom.sbFollowSort.addEventListener("click", (e) => {
      const btn = e.target.closest(".sb-seg-btn");
      if (!btn) return;
      this.#searchState.followingsSort = btn.dataset.fsort;
      this.syncSegUI();
      this.refreshGridView();
    });
    dom.sbReverse.addEventListener("change", () => {
      this.#searchState.reverse = dom.sbReverse.checked;
      this.refreshGridView();
    });
    dom.btnClearInBar.addEventListener("click", () => this.clearSearchFilters());
    dom.btnCloseSearch.addEventListener("click", () => this.closeSearchBar());
    dom.btnClearFilter.addEventListener("click", () => this.clearSearchFilters());
    dom.btnSearchMenu.addEventListener("click", () => this.toggleSearchBar());
  }
}

const search = new SearchBar();

// ---------- runtimeConfig ----------
const runtimeConfig = {
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
const services = {
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
    const { independentMode, secUid } = await chrome.storage.local.get(["independentMode", "secUid"]);
    if (independentMode && secUid && secUid !== "self") return secUid;
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
      bytes: s.bytes || 0,
    };
  },

  async loadWorks(groupId) {
    // IDB 主键读取天然无重复；主键已统一为 string 存储，仅在遇到历史 number 主键时才拷贝归一化
    const res = await this.bgMsg({ type: "GET_WORKS", groupId });
    return (res.works || [])
      .filter((w) => w && w.awemeId)
      .map((w) => (typeof w.awemeId === "string" ? w : { ...w, awemeId: String(w.awemeId) }));
  },

  async loadFollowings(groupId) {
    const res = await this.bgMsg({ type: "GET_FOLLOWINGS", groupId: groupId || state.currentGroupId });
    return (res.followings || [])
      .filter((f) => f && f.uid)
      .map((f) => (typeof f.uid === "string" ? f : { ...f, uid: String(f.uid) }));
  },

  async loadGroups(domain) {
    const res = await this.bgMsg({ type: "GET_GROUPS", domain: domain || state.domain });
    return res.groups || [];
  },

  async loadDomainData() {
    const groupId = state.currentGroupId;
    const domain = state.domain;
    const data = domain === "works"
      ? await this.loadWorks(groupId)
      : await this.loadFollowings(groupId);
    if (state.currentGroupId !== groupId || state.domain !== domain) return;
    store.set(domain === "works" ? "works" : "followings", data);
  },

  async deleteFollowings(uids) {
    return this.bgMsg({ type: "DELETE_FOLLOWINGS", uids });
  },

  async moveFollowings(uids, targetGroupId) {
    return this.bgMsg({ type: "MOVE_FOLLOWINGS", uids, targetGroupId });
  },

  async refreshSingleWork(awemeId) {
    const res = await this.bgMsg({ type: "SYNC_WORKS", awemeIds: [awemeId] });
    if (!res || !res.requestId) throw new Error("NO_SYNC");
    const done = await new Promise((resolve) => {
      const handler = (msg) => {
        if (msg.type === "SYNC_DONE" && msg.requestId === res.requestId) {
          chrome.runtime.onMessage.removeListener(handler);
          resolve(msg);
        }
      };
      chrome.runtime.onMessage.addListener(handler);
      setTimeout(() => {
        chrome.runtime.onMessage.removeListener(handler);
        resolve(null);
      }, runtimeConfig._cache?.timeoutRequest || config.SYNC_TIMEOUT);
    });
    if (!done || !done.ok) throw new Error("SYNC_FAILED");
    const workRes = await this.bgMsg({ type: "GET_WORK", awemeId });
    return workRes.work || null;
  },

  isWorksData(data) {
    if (data.works && Array.isArray(data.works)) return data.works.length > 0;
    return false;
  },

  isFollowingsData(data) {
    if (data.followings && Array.isArray(data.followings)) return data.followings.length > 0;
    return false;
  },
};

// ---------- VirtualGrid ----------
class VirtualGrid {
  #observer = null;
  #unloadObserver = null;
  #fillQueue = [];
  #drainRafId = 0;
  #pendingSkeletons = [];
  #sentinelCard = null;
  #itemMap = new Map();
  #chunkRaf = 0;
  #scrollRafId = 0;
  #boundClickHandler = null;
  #container = null;
  #skeletonClass = "";
  #itemClass = "";
  #itemKey = "";
  #dataAttr = "";
  #emptyMsg = "";
  #emptyHint = "";

  constructor({ container, itemClass, skeletonClass, itemKey, emptyMsg, emptyHint }) {
    this.#container = container;
    this.#itemClass = itemClass;
    this.#skeletonClass = skeletonClass;
    this.#itemKey = itemKey;
    this.#dataAttr = itemKey.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
    this.#emptyMsg = emptyMsg || "";
    this.#emptyHint = emptyHint || "";
    this.#boundClickHandler = this.#onClick.bind(this);
    this.#container.addEventListener("click", this.#boundClickHandler);
    // 键盘激活与点击共用同一条 handleClick 路径（docs/UI_IMPROVEMENTS.md 建议7）：
    // 勾选圆 Enter/Space 切换选中；卡片根节点 Enter 等价整卡点击
    this.#container.addEventListener("keydown", (e) => this.#onKeydown(e));
    dom.mainGrid.addEventListener("scroll", () => this.#scheduleCatchUp(), { passive: true });
  }

  get skeletonClass() {
    return this.#skeletonClass;
  }

  render(items, emptyMsg, emptyHint) {
    cancelAnimationFrame(this.#chunkRaf);
    this.#chunkRaf = 0;
    // wipe 前先停媒体：卡片摘除后 pointerout 永不触发，游离的播放中 video 会继续出声
    this.stopAllMedia();
    this.#container.className = "main-container";
    this.#container.innerHTML = "";
    dom.emptyState.classList.add("hidden");
    dom.errorState.classList.add("hidden");

    // 先完全重置实例状态（含空列表分支），避免残留 observer/队列影响后续渲染
    if (this.#observer) {
      this.#observer.disconnect();
      this.#observer = null;
    }
    if (this.#unloadObserver) {
      this.#unloadObserver.disconnect();
      this.#unloadObserver = null;
    }
    this.#pendingSkeletons = [];
    this.#sentinelCard = null;
    this.#itemMap = new Map(items.map((item) => [item[this.#itemKey], item]));
    cancelAnimationFrame(this.#drainRafId);
    this.#drainRafId = 0;
    this.#fillQueue = [];

    if (items.length === 0) {
      dom.emptyState.classList.remove("hidden");
      dom.emptyState.querySelector("p").textContent = emptyMsg;
      dom.emptyState.querySelector(".empty-hint").textContent = emptyHint;
      this.#container.classList.add("hidden");
      return;
    }

    dom.emptyState.classList.add("hidden");
    this.#container.classList.remove("hidden");

    const skelTmpl = this.#getSkeletonTemplate();
    let index = 0;

    const renderChunk = () => {
      const fragment = document.createDocumentFragment();
      const end = Math.min(index + config.RENDER_CHUNK_SIZE, items.length);
      const chunkNodes = [];

      for (let i = index; i < end; i++) {
        const card = skelTmpl.content.cloneNode(true).firstElementChild;
        card.dataset[this.#itemKey] = items[i][this.#itemKey];
        chunkNodes.push(card);
        fragment.appendChild(card);
      }

      this.#container.appendChild(fragment);
      index = end;

      this.#observeNewSkeletons(chunkNodes);

      if (index < items.length) {
        this.#chunkRaf = requestAnimationFrame(renderChunk);
      } else {
        this.#finishRender();
      }
    };

    renderChunk();
  }

  removeItems(idSet) {
    for (const id of idSet) {
      this.#itemMap.delete(id);
      const card = this.#container.querySelector(`[data-${this.#dataAttr}="${id}"]`);
      if (card) {
        if (this.#observer) this.#observer.unobserve(card);
        if (this.#unloadObserver) this.#unloadObserver.unobserve(card);
        if (card === this.#sentinelCard) {
          // 哨兵被删除会导致观察圈断链、后续骨架永不填充，立刻续接
          this.#sentinelCard = null;
          this.#extendObservation();
        }
        this.clearCard(card);
        card.remove();
      }
    }
    if (this.#container.children.length === 0) {
      this.#container.classList.add("hidden");
      dom.emptyState.classList.remove("hidden");
      dom.emptyState.querySelector("p").textContent = this.#emptyMsg;
      dom.emptyState.querySelector(".empty-hint").textContent = this.#emptyHint;
    }
  }

  // 中止未完成的分块渲染（域切换时调用，防止旧域骨架卡/observer 残留到共享容器）
  abortRender() {
    this.stopAllMedia();
    cancelAnimationFrame(this.#chunkRaf);
    this.#chunkRaf = 0;
    if (this.#observer) {
      this.#observer.disconnect();
      this.#observer = null;
    }
    if (this.#unloadObserver) {
      this.#unloadObserver.disconnect();
      this.#unloadObserver = null;
    }
    this.#pendingSkeletons = [];
    this.#sentinelCard = null;
    this.#itemMap = new Map();
    cancelAnimationFrame(this.#drainRafId);
    this.#drainRafId = 0;
    this.#fillQueue = [];
  }

  #getSkeletonTemplate() {
    return document.getElementById(
      this.#skeletonClass.replace(/-([a-z])/g, (_, c) => c.toUpperCase()) + "Template",
    );
  }

  // 双向虚拟化：完整卡滚出 UNLOAD_ROOT_MARGIN 外时降级回骨架（媒体子树/监听器随清空释放），
  // 重新滚近时经既有 fill 流程重填。卸载圈远大于填充圈形成滞回，避免边界抖动。
  #ensureUnloadObserver() {
    if (this.#unloadObserver) return;
    this.#unloadObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) this.#demote(entry.target);
        }
      },
      { rootMargin: config.UNLOAD_ROOT_MARGIN },
    );
  }

  // 原地降级：只清内容、切回骨架类，不换根节点。grid 容器任一直接子节点被替换
  // 都会触发 Blink 全量重排，成本随卡片总数线性增长（3000 卡单次 >10ms）。
  #demote(card) {
    if (!card.isConnected || card.classList.contains(this.#skeletonClass)) return;
    const key = card.dataset[this.#itemKey];
    if (!key || !this.#itemMap.has(key)) return;

    this.clearCard(card);
    card.classList.add(this.#skeletonClass);
    // unloadObserver 持续观察同一根节点无需重挂；fill observer 在填充时已 unobserve
    if (this.#observer) this.#observer.observe(card);
  }

  // 分圈观察：新骨架先进待观察队列，只把最靠前一圈（OBSERVE_CHUNK_SIZE 个）交给 IO，
  // 圈尾哨兵进圈（进入 OBSERVER_ROOT_MARGIN）时再放下一批。
  // computeIntersections 成本随已观察目标数线性，全量 observe 会让滚动期每帧
  // 重算 O(全部卡) 次几何——这是侧边栏打开后风扇高转的主因之一（实测 trace 占 1.2s/5s）
  #observeNewSkeletons(nodes) {
    if (!this.#observer) {
      this.#observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const card = entry.target;
            this.#observer.unobserve(card);
            if (card === this.#sentinelCard) {
              this.#sentinelCard = null;
              this.#extendObservation();
            }
            this.#enqueueFill(card);
          }
        },
        { rootMargin: config.OBSERVER_ROOT_MARGIN },
      );
    }
    this.#pendingSkeletons.push(...nodes);
    if (!this.#sentinelCard) this.#extendObservation();
  }

  #extendObservation() {
    while (this.#pendingSkeletons.length) {
      const chunk = [];
      while (this.#pendingSkeletons.length && chunk.length < config.OBSERVE_CHUNK_SIZE) {
        const card = this.#pendingSkeletons.shift();
        if (card.isConnected) chunk.push(card);
      }
      if (!chunk.length) continue; // 本批全是被重渲染丢弃的死节点，继续丢
      for (const c of chunk) {
        c.dataset.observed = "1";
        this.#observer.observe(c);
      }
      this.#sentinelCard = chunk[chunk.length - 1];
      return;
    }
    this.#sentinelCard = null;
  }

  // 远跳兜底：快速滚动/拖动滚动条落点可能越过观察圈前沿，哨兵留在视口上方
  // 永不再相交、分圈推进断链，落点骨架因从未 observe 过而永远不填充。
  // 滚动时把填充带内未观察的骨架直连交给 fill observer（不走队列与哨兵，
  // 两条机制独立并存：慢速滚动仍由零成本的哨兵链推进）。
  #scheduleCatchUp() {
    if (this.#scrollRafId) return;
    this.#scrollRafId = requestAnimationFrame(() => {
      this.#scrollRafId = 0;
      this.#catchUpToViewport();
    });
  }

  #catchUpToViewport() {
    // 非活跃实例的 observer 已被 abortRender()/render() 重置置空
    if (!this.#observer) return;
    // 未标记的骨架必然仍在待观察队列里；队列与哨兵双空 = 无需追赶
    if (!this.#sentinelCard && !this.#pendingSkeletons.length) return;
    const children = this.#container.children;
    const count = children.length;
    if (!count) return;
    const margin = parseFloat(config.OBSERVER_ROOT_MARGIN) || 0;
    const gridRect = dom.mainGrid.getBoundingClientRect();
    const bandTop = gridRect.top - margin;
    const bandBottom = gridRect.bottom + margin;
    // 卡片等高成行、纵向位置单调，二分定位带区起点后线性扫描到带区底；
    // 全程只读探测（gBCR），收集完再统一标记 observe，避免读写交错引发布局抖动
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const rect = children[mid].getBoundingClientRect();
      if (rect.bottom < bandTop) lo = mid + 1;
      else hi = mid;
    }
    const caught = [];
    for (let i = lo; i < count; i++) {
      const card = children[i];
      if (card.getBoundingClientRect().top > bandBottom) break;
      if (!card.classList.contains(this.#skeletonClass)) continue;
      if (card.dataset.observed === "1") continue; // 圈内/降级重观察路径已覆盖
      caught.push(card);
    }
    for (const card of caught) {
      card.dataset.observed = "1";
      this.#observer.observe(card);
    }
  }

  #finishRender() {
    if (state.batchMode) {
      this.#container
        .querySelectorAll(
          "." + this.#skeletonClass + " .work-checkbox, ." + this.#skeletonClass + " .following-checkbox",
        )
        .forEach((cb) => {
          cb.style.display = "";
        });
    }
  }

  #enqueueFill(card) {
    this.#fillQueue.push(card);
    this.#scheduleDrain();
  }

  #scheduleDrain() {
    if (this.#drainRafId) return;
    this.#drainRafId = requestAnimationFrame(() => {
      this.#drainRafId = 0;
      // 时间预算制：每帧最多花 FILL_FRAME_BUDGET_MS 填卡即让出主线程，
      // 避免首屏集中填充时单帧超预算（固定张数在低端机上仍会卡）
      const deadline = performance.now() + config.FILL_FRAME_BUDGET_MS;
      while (this.#fillQueue.length && performance.now() < deadline) {
        this.#doFill(this.#fillQueue.shift());
      }
      if (this.#fillQueue.length) this.#scheduleDrain();
    });
  }

  #doFill(card) {
    const key = card.dataset[this.#itemKey];
    const item = this.#itemMap.get(key);
    if (item && card.classList.contains(this.#skeletonClass)) {
      this.populateItem(card, item);
    }
  }

  // 原地填充：在骨架根节点上直接构建内容（同 #demote，禁止换根节点）
  populateItem(skeleton, item) {
    if (!skeleton.parentNode) return;
    if (!skeleton.classList.contains(this.#skeletonClass)) return;
    this.fillCard(skeleton, item);
    this.#ensureUnloadObserver();
    this.#unloadObserver.observe(skeleton);
  }

  #onClick(event) {
    this.#activate(event);
  }

  // 键盘激活：勾选圆上的 Enter/Space 切换选中；卡片根节点直接持有焦点时 Enter
  // 等价整卡点击（打开详情/侧边栏）。焦点在卡内按钮/输入框上时不拦截，走原生行为
  #onKeydown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const isCheckbox = !!target.closest(".work-checkbox, .following-checkbox");
    const itemEl = target.closest("." + this.#itemClass);
    if (!itemEl) return;
    if (isCheckbox) {
      event.preventDefault();
      event.stopPropagation();
      this.#activate(event);
      return;
    }
    if (event.key === "Enter" && target === itemEl && !target.closest("button, input")) {
      event.preventDefault();
      this.#activate(event);
    }
  }

  #activate(event) {
    const itemEl = event.target.closest("." + this.#itemClass);
    if (!itemEl) return;
    const key = itemEl.dataset[this.#itemKey];
    const item = this.#itemMap.get(key);
    if (item) this.handleClick(event, item, itemEl);
  }

  // 子类必须实现：原地填充 / 清空还原骨架（均不得替换根节点）
  fillCard(card, item) {
    throw new Error("子类必须实现 fillCard");
  }
  clearCard(card) {
    throw new Error("子类必须实现 clearCard");
  }
  // render()/abortRender() wipe 容器前调用；含可播放媒体的子类覆写（默认无媒体）
  stopAllMedia() {}
  handleClick(event, item, itemEl) {
    throw new Error("子类必须实现 handleClick");
  }
}

// ---------- Dialog ----------
class Dialog {
  constructor() {
    this.__toastTimer = null;
    this.__lastFocused = null;
  }

  showDialog(title, body, footerBtns, onClose) {
    dom.dialogOverlay.classList.remove("hidden");
    dom.dialogTitle.textContent = title;
    dom.dialogBody.innerHTML = "";
    state.activeDialog = onClose || null;

    if (typeof body === "string") {
      dom.dialogBody.innerHTML = body;
    } else if (body instanceof DocumentFragment || body instanceof HTMLElement) {
      dom.dialogBody.appendChild(body);
    }

    dom.dialogFooter.innerHTML = "";
    if (footerBtns) {
      for (const btn of footerBtns) {
        const el = document.createElement("button");
        el.className = `dy-btn flex-inline-center ${btn.primary ? "dy-btn-primary" : ""} ${btn.danger ? "dy-btn-danger" : ""} ${btn.ghost ? "dy-btn-ghost" : ""}`;
        el.textContent = btn.text;
        el.addEventListener("click", btn.callback);
        dom.dialogFooter.appendChild(el);
      }
    }

    // 焦点管理：打开时移入弹窗、关闭后还原到触发元素（docs/UI_IMPROVEMENTS.md 建议3）
    this.__lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.focusFirstControl();
  }

  focusFirstControl() {
    const focusable = dom.dialogBody.querySelector(
      "button, input:not([type='hidden']), select, textarea, [tabindex]:not([tabindex='-1'])",
    );
    (focusable || dom.dialogClose).focus();
  }

  closeDialog() {
    // 关键防御:防止重复关闭触发栈溢出或重复回调
    if (dom.dialogOverlay.classList.contains("hidden")) {
      state.activeDialog = null;
      return;
    }
    state.activeDialog = null;
    dom.dialogOverlay.classList.add("hidden");
    if (this.__lastFocused?.isConnected) this.__lastFocused.focus();
    this.__lastFocused = null;
  }

  updateDialog(title, bodyHtml) {
    dom.dialogTitle.textContent = title;
    dom.dialogBody.innerHTML = bodyHtml || "";
    dom.dialogFooter.innerHTML = "";
  }

  addDialogBtn(text, type, cb) {
    const btn = document.createElement("button");
    btn.className = `dy-btn flex-inline-center dy-btn-${type}`;
    btn.textContent = text;
    btn.addEventListener("click", cb);
    dom.dialogFooter.appendChild(btn);
  }

  showOkDialog() {
    this.addDialogBtn("好的", "primary", () => this.closeDialog());
  }

  // 分型 toast（建议1）：info 默认；success/error 带左色条，error 加长驻留
  showToast(message, type = "info") {
    const toast = document.getElementById("dy-options-toast");
    toast.textContent = message;
    toast.classList.remove("hide", "toast-info", "toast-success", "toast-error");
    toast.classList.add("show", `toast-${type}`);
    if (this.__toastTimer) clearTimeout(this.__toastTimer);
    this.__toastTimer = setTimeout(() => {
      toast.classList.remove("show");
      toast.classList.add("hide");
    }, type === "error" ? config.TOAST_ERROR_DURATION : config.TOAST_DURATION);
  }

  showGroupSelectDialog(title, groups, onSelect) {
    const list = document.createElement("div");
    list.className = "group-select-list";
    const tmpl = document.getElementById("groupSelectItemTemplate");
    for (const g of groups.filter((g) => !g.fixed)) {
      const el = tmpl.content.cloneNode(true).firstElementChild;
      el.dataset.groupId = g.id;
      el.appendChild(document.createTextNode(" " + g.name));
      el.addEventListener("click", () => onSelect(g.id));
      list.appendChild(el);
    }
    this.showDialog(title, list);
  }

  showNoSignatureDialog(tabUrl, stepLabel, scanLabel) {
    dom.dialogTitle.textContent = "未捕获到签名";
    dom.dialogBody.innerHTML = `
      <p>扩展需要先从抖音页面捕获请求签名才能${scanLabel}。</p>
      <p style="margin-top:8px">请按以下步骤操作：</p>
      <ol style="margin-top:4px;padding-left:20px;line-height:1.8">
        <li>在浏览器中打开 <code style="font-size:12px">${tabUrl}</code></li>
        <li>在打开的页面上点击「${stepLabel}」标签（页面会自动加载列表）</li>
        <li>回到本扩展，再次点击「${scanLabel}」</li>
      </ol>
    `;
    this.showOkDialog();
  }

  showFetchErrorDialog(msg) {
    dom.dialogTitle.textContent = "获取失败";
    let hint = msg;
    if (msg.includes("NO_DOUYIN_TAB")) hint = "未找到抖音页面，请确保已打开抖音";
    else if (msg.includes("TIMEOUT")) hint = "获取超时，可能是网络问题或内容过多";
    else if (msg.includes("HTTP_403")) {
      // 注意：任何 403 都会走到这里，服务端未必真的返回「sign invalid」——同源 fetch
      // 元数据（Sec-Fetch-Site/Origin）被 DNR 剥离、会话过期等同样会触发 403。不要再把
      // 所有 403 一律归因为签名被拒，以免误导用户反复刷新无关缓存。
      hint = "抖音返回 403 拒绝了该请求。若已刷新 Cookie/webid/msToken/浏览器特征仍失败，多为请求头被服务端拦截（独立模式 POST 端点尤甚），可改用标签页模式扫描，或重新刷新缓存后重试";
    }
    dom.dialogBody.innerHTML = `<p>${hint}</p>`;
    this.showOkDialog();
  }
}

const dialog = new Dialog();

// ---------- FollowingsGrid ----------
class FollowingsGrid extends VirtualGrid {
  // 头像分帧队列，避免同步赋 src 触发批量网络/解码调度
  #avatarQueue = [];
  #avatarDrainRafId = 0;
  constructor() {
    super({
      container: dom.mainContainer,
      itemClass: "following-card",
      skeletonClass: "following-skeleton",
      itemKey: "uid",
      emptyMsg: "还没有保存的关注者",
      emptyHint: "点击菜单「同步关注」获取你的关注列表",
    });
  }

  renderFollowingCards() {
    const view = search.getFollowingsView();
    if (search.isFilterActive()) {
      this.render(view, "没有符合筛选条件的关注者", "调整搜索关键词后重试");
    } else {
      this.render(view, "还没有保存的关注者", "点击菜单「同步关注」获取你的关注列表");
    }
  }

  fillCard(card, following) {
    card.classList.remove(this.skeletonClass);
    card.dataset.uid = following.uid;

    const checkbox = card.querySelector(".following-checkbox");
    batch.updateCheckboxDOM(checkbox, state.selectedIds.has(following.uid));
    checkbox.style.display = state.batchMode ? "" : "none";

    const avatar = card.querySelector(".following-avatar");
    const fallback = card.querySelector(".following-avatar-fallback");
    this.#bumpFillGen(card);
    avatar.classList.add("media-loading");
    avatar.style.display = "";
    fallback?.classList.add("hidden");

    const avatarUrl = following.avatarLarger || following.avatar || "";
    if (avatarUrl) this.#enqueueAvatar(avatar, avatarUrl, following.nickname, card.dataset.fillGen);
    else this.#showAvatarFallback(avatar, fallback, following.nickname);

    card.querySelector(".following-nickname").textContent = following.nickname || "未知";
    card.querySelector(".stat-followers").textContent = utils.formatCount(following.followerCount) + " 粉丝";
    card.querySelector(".stat-works").textContent = utils.formatCount(following.awemeCount) + " 作品";
  }

  // 头像不可用时的占位：灰底圆圈换为昵称首字，不再让头像凭空消失
  #showAvatarFallback(avatar, fallback, nickname) {
    avatar.classList.remove("media-loading");
    avatar.style.display = "none";
    avatar.style.backgroundImage = "";
    if (!fallback) return;
    const initial = (nickname || "").trim().charAt(0).toUpperCase();
    fallback.textContent = initial || "?";
    fallback.classList.remove("hidden");
  }

  // 填充代际：卡片每次重填/降级自增，使在途探针结果过期作废，防止跨代提交旧 URL
  #bumpFillGen(card) {
    card.dataset.fillGen = String((Number(card.dataset.fillGen) || 0) + 1);
  }
  #avatarTargetAlive(img, gen) {
    if (!img.isConnected || img.closest(".following-skeleton")) return false;
    const card = img.closest(".following-card");
    return !!card && card.dataset.fillGen === gen;
  }

  // 原地还原骨架：清内容与占位样式由 .following-skeleton 类接管，根节点保留
  clearCard(card) {
    this.#bumpFillGen(card); // 在途探针立即作废
    const avatar = card.querySelector(".following-avatar");
    if (avatar) {
      avatar.style.backgroundImage = "";
      avatar.style.display = "";
      avatar.classList.remove("media-loading");
    }
    card.querySelector(".following-avatar-fallback")?.classList.add("hidden");
    card.querySelector(".following-nickname").textContent = "";
    card.querySelector(".stat-followers").textContent = "";
    card.querySelector(".stat-works").textContent = "";
    const checkbox = card.querySelector(".following-checkbox");
    if (checkbox) {
      batch.updateCheckboxDOM(checkbox, false);
      checkbox.style.display = state.batchMode ? "" : "none";
    }
  }

  // 头像分帧预载：离屏探针先行请求，只有成功的 URL 才提交给头像节点。
  // 头像是 div+background-image：背景图失败时浏览器不绘制任何占位图标，断裂图在元素层面失去载体
  #enqueueAvatar(img, url, nickname, gen) {
    this.#avatarQueue.push({ img, url, nickname, gen });
    this.#scheduleAvatarDrain();
  }
  #scheduleAvatarDrain() {
    if (this.#avatarDrainRafId) return;
    this.#avatarDrainRafId = requestAnimationFrame(() => {
      this.#avatarDrainRafId = 0;
      let n = 0;
      while (this.#avatarQueue.length && n < config.SIDEBAR_IMG_PER_FRAME) {
        const { img, url, nickname, gen } = this.#avatarQueue.shift();
        if (!this.#avatarTargetAlive(img, gen)) continue;
        const probe = new Image();
        probe.onload = () => {
          if (!this.#avatarTargetAlive(img, gen)) return; // 已重填/降级，结果作废
          img.style.backgroundImage = `url("${url.replace(/["\\]/g, "\\$&")}")`;
          img.classList.remove("media-loading");
          detail.markMediaOk();
        };
        probe.onerror = () => {
          if (!this.#avatarTargetAlive(img, gen)) return;
          detail.markMediaFail();
          const card = img.closest(".following-card");
          this.#showAvatarFallback(img, card?.querySelector(".following-avatar-fallback"), nickname);
        };
        probe.src = url;
        n++;
      }
      if (this.#avatarQueue.length) this.#scheduleAvatarDrain();
    });
  }

  handleClick(event, following, el) {
    if (event.target.closest(".following-avatar, .following-avatar-fallback")) {
      if (state.batchMode) return;
      event.stopPropagation();
      window.open(following.profileUrl || `${config.URL_BASE}/user/${following.uid}`, "_blank");
      return;
    }

    const checkbox = el.querySelector(".following-checkbox");

    if (event.target.closest(".following-checkbox")) {
      event.stopPropagation();
      batch.toggleBatchSelect(following.uid, checkbox);
      return;
    }

    if (state.batchMode) {
      batch.toggleBatchSelect(following.uid, checkbox);
      return;
    }
    sidebar.openSidebar(following);
  }
}

const followingsGrid = new FollowingsGrid();

// ---------- Groups ----------
class Groups {
  async renderGroupTabs() {
    const [stats, groupList] = await Promise.all([services.loadStats(), services.loadGroups()]);
    this.#updateStorageIndicator(stats);
    const domainStats = state.domain === "works" ? stats.works : stats.followings;
    dom.groupTabs.innerHTML = "";
    for (const g of groupList) {
      const count = domainStats.groupCounts?.[g.id] ?? 0;
      const tab = document.getElementById("groupTabTemplate").content.cloneNode(true).firstElementChild;
      tab.classList.toggle("active", g.id === state.currentGroupId);
      tab.dataset.groupId = g.id;
      tab.textContent = `${g.name} (${count})`;
      tab.addEventListener("click", () => this.#switchGroup(g.id));
      dom.groupTabs.appendChild(tab);
    }
    this.updateTabMask();
  }

  updateTabMask() {
    const el = dom.groupTabs;
    const overflow = el.scrollWidth > el.clientWidth;
    if (!overflow) {
      el.classList.remove("tab-overflow", "tab-at-start", "tab-at-end");
      return;
    }
    el.classList.add("tab-overflow");
    el.classList.toggle("tab-at-start", el.scrollLeft <= config.TAB_SCROLL_THRESHOLD);
    el.classList.toggle("tab-at-end", el.scrollLeft + el.clientWidth >= el.scrollWidth - config.TAB_SCROLL_THRESHOLD);
  }

  async showGroupManage() {
    const tmpl = document.getElementById("groupManageTemplate");
    const body = tmpl.content.cloneNode(true);
    dialog.showDialog("分组管理", body);
    state.preventDialogClose = true;
    try {
      await this.#refreshGroupList();
    } finally {
      state.preventDialogClose = false;
    }

    const input = dom.dialogBody.querySelector("#newGroupInput");
    const addBtn = dom.dialogBody.querySelector("#addGroupBtn");
    if (input && addBtn) {
      addBtn.addEventListener("click", async () => {
        const name = input.value.trim();
        if (!name) return;
        const res = await services.bgMsg({ type: "ADD_GROUP", domain: state.domain, name });
        if (res.ok) {
          input.value = "";
          await this.#refreshGroupList();
        }
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") addBtn.click();
      });
    }
  }

  async #refreshGroupList() {
    await this.renderGroupTabs();
    const groupList = await services.loadGroups(state.domain);
    const list = dom.dialogBody.querySelector("#groupList");
    if (!list) return;
    list.innerHTML = "";
    for (const g of groupList.filter((g) => !g.fixed)) {
      const item = document.getElementById("groupListItemTemplate").content.cloneNode(true).firstElementChild;
      item.dataset.groupId = g.id;
      item.querySelector(".group-name").textContent = g.name;
      item.querySelector(".rename-btn").addEventListener("click", () => {
        const nameSpan = item.querySelector(".group-name");
        const oldName = nameSpan.textContent;
        const input = document.createElement("input");
        input.type = "text";
        input.value = oldName;
        input.maxLength = config.GROUP_NAME_MAX_LEN;
        input.className = "group-rename-input";
        nameSpan.replaceWith(input);
        input.focus();
        input.select();
        const done = async () => {
          const newName = input.value.trim();
          if (newName && newName !== oldName) {
            await services.bgMsg({ type: "RENAME_GROUP", domain: state.domain, groupId: g.id, newName });
            store.refreshGroups();
            nameSpan.textContent = newName;
          } else nameSpan.textContent = oldName;
          input.replaceWith(nameSpan);
        };
        input.addEventListener("blur", done);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            input.blur();
          }
          if (e.key === "Escape") {
            input.value = oldName;
            input.blur();
          }
        });
      });
      item.querySelector(".delete-btn").addEventListener("click", () => {
        const delTmpl = document.getElementById("confirmDeleteGroupTemplate");
        const delBody = delTmpl.content.cloneNode(true);
        delBody.querySelector(".confirm-delete-group-name").textContent = g.name;
        dialog.showDialog("确认删除", delBody, [
          { text: "取消", ghost: true, callback: () => dialog.closeDialog() },
          {
            text: "删除",
            danger: true,
            callback: async () => {
              dialog.updateDialog("正在删除…", utils.SPINNER_HTML);
              state.preventDialogClose = true;
              try {
                await services.bgMsg({ type: "DELETE_GROUP", domain: state.domain, groupId: g.id });
                item.remove();
                store.refreshGroups();
                dom.dialogTitle.textContent = "删除完成";
                dom.dialogBody.innerHTML = `<p>已删除"${g.name}"</p>`;
                dialog.showOkDialog();
              } finally {
                state.preventDialogClose = false;
              }
            },
          },
        ]);
      });
      list.appendChild(item);
    }
    this.#setupDragSort(list);
  }

  #setupDragSort(container) {
    let dragItem = null;
    container.addEventListener("dragover", (e) => e.preventDefault());
    container.addEventListener("drop", (e) => e.preventDefault());
    container.querySelectorAll('.group-list-item[draggable="true"]').forEach((el) => {
      el.addEventListener("dragstart", (e) => {
        dragItem = el;
        el.style.opacity = "0.5";
        e.dataTransfer.effectAllowed = "move";
      });
      el.addEventListener("dragend", () => {
        el.style.opacity = "1";
        dragItem = null;
        this.#saveOrder();
      });
      el.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (dragItem && dragItem !== el) {
          const mid = el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2;
          if (e.clientY < mid) container.insertBefore(dragItem, el);
          else container.insertBefore(dragItem, el.nextSibling);
        }
      });
    });
  }

  async #saveOrder() {
    const items = dom.dialogBody.querySelectorAll(".group-list-item");
    const customIds = Array.from(items).map((el) => el.dataset.groupId);
    const defaultIds = ["all", "uncategorized"];
    await services.bgMsg({ type: "REORDER_GROUPS", domain: state.domain, groupIds: [...defaultIds, ...customIds] });
    store.refreshGroups();
  }

  #updateStorageIndicator(stats) {
    const el = dom.menuStorage;
    if (!el) return;
    const bytes = stats.bytes || 0;
    const pct = bytes / config.STORAGE_MAX_BYTES;
    const used = (bytes / 1024 / 1024).toFixed(pct > 0.1 ? 1 : 2);
    el.textContent = `${used} MB`;
  }

  #switchGroup(groupId) {
    state.selectedIds.clear();
    detail.closeDetail();
    window.scrollTo(0, 0);
    store.set("batchMode", false);
    store.set("currentGroupId", groupId);
  }
}

const groups = new Groups();

// ---------- Batch ----------
class Batch {
  toggleSelect(id) {
    if (state.selectedIds.has(id)) {
      state.selectedIds.delete(id);
      return false;
    }
    state.selectedIds.add(id);
    return true;
  }

  toggleBatchMode() {
    const newMode = !state.batchMode;
    if (!newMode) state.selectedIds.clear();
    return newMode;
  }

  selectAll() {
    // 全选作用于当前可见视图（有筛选时只选筛出的条目，所见即所选）
    const items = state.domain === "works" ? search.getWorksView() : state.followings;
    const idKey = state.domain === "works" ? "awemeId" : "uid";
    const allSelected = items.every((w) => state.selectedIds.has(w[idKey]));
    if (allSelected) {
      state.selectedIds.clear();
      return "none";
    }
    for (const w of items) state.selectedIds.add(w[idKey]);
    return "all";
  }

  // 已选计数与按钮可用性统一在此刷新（docs/UI_IMPROVEMENTS.md 建议4）
  syncSelectionUI() {
    const count = state.selectedIds.size;
    if (dom.batchCount) dom.batchCount.textContent = `已选 ${count}`;
    const noneSelected = count === 0;
    dom.batchMove.disabled = noneSelected;
    dom.batchDelete.disabled = noneSelected;
  }

  #clearAllCheckboxes() {
    const selector = state.domain === "works" ? ".work-checkbox" : ".following-checkbox";
    document.querySelectorAll(selector).forEach((el) => this.updateCheckboxDOM(el, false));
  }

  async #executeBatchOp(serviceFn, { conditionallyRemove = false } = {}) {
    if (state.selectedIds.size === 0) return null;
    const ids = Array.from(state.selectedIds);
    const isFollowings = state.domain === "followings";

    await serviceFn(ids, isFollowings);
    state.selectedIds.clear();

    const grid = isFollowings ? followingsGrid : worksGrid;
    const removeSilent = isFollowings ? store.removeFollowingsSilent : store.removeWorksSilent;
    if (!conditionallyRemove || state.currentGroupId !== "all") {
      removeSilent.call(store, new Set(ids));
      grid.removeItems(new Set(ids));
    }

    this.#clearAllCheckboxes();
    dom.batchSelectAll.innerHTML = "全选";
    store.refreshGroups();
    this.syncSelectionUI();
    return { count: ids.length, isFollowings };
  }

  deleteSelected() {
    return this.#executeBatchOp((ids, isFollowings) =>
      isFollowings ? services.deleteFollowings(ids) : services.bgMsg({ type: "DELETE_WORKS", awemeIds: ids }),
    );
  }

  moveSelected(targetGroupId) {
    return this.#executeBatchOp(
      (ids, isFollowings) =>
        isFollowings
          ? services.moveFollowings(ids, targetGroupId)
          : services.bgMsg({ type: "MOVE_WORKS", awemeIds: ids, targetGroupId }),
      { conditionallyRemove: true },
    );
  }

  isSelected(id) {
    return state.selectedIds.has(id);
  }

  selectedCount() {
    return state.selectedIds.size;
  }

  updateCheckboxDOM(checkboxEl, isSelected) {
    if (isSelected) {
      checkboxEl.classList.add("checked");
      checkboxEl.innerHTML = (config.icons && config.icons.check) || "";
    } else {
      checkboxEl.classList.remove("checked");
      checkboxEl.textContent = "";
    }
    checkboxEl.setAttribute("aria-checked", isSelected ? "true" : "false");
  }

  toggleBatchSelect(id, checkboxEl) {
    const selected = this.toggleSelect(id);
    this.updateCheckboxDOM(checkboxEl, selected);
    this.syncSelectionUI();
  }

  handleBatchToggle() {
    const newMode = this.toggleBatchMode();
    store.set("batchMode", newMode);
    if (!newMode) {
      document.querySelectorAll(".work-checkbox").forEach((el) => {
        el.style.display = "none";
        el.innerHTML = "";
        el.classList.remove("checked");
      });
      document.querySelectorAll(".following-checkbox").forEach((el) => {
        el.style.display = "none";
        el.innerHTML = "";
        el.classList.remove("checked");
      });
      dom.batchSelectAll.innerHTML = `全选`;
    } else {
      document.querySelectorAll(".work-checkbox").forEach((el) => (el.style.display = ""));
      document.querySelectorAll(".following-checkbox").forEach((el) => (el.style.display = ""));
    }
    this.syncSelectionUI();
  }

  handleBatchSelectAll() {
    const result = this.selectAll();
    dom.batchSelectAll.innerHTML = result === "all" ? `取消全选` : `全选`;
    const selector = state.domain === "followings" ? ".following-checkbox" : ".work-checkbox";
    document.querySelectorAll(selector).forEach((el) => {
      const id = el.closest("[data-aweme-id]")?.dataset?.awemeId || el.closest("[data-uid]")?.dataset?.uid;
      this.updateCheckboxDOM(el, this.isSelected(id));
    });
    this.syncSelectionUI();
  }

  async handleBatchDelete() {
    if (this.selectedCount() === 0) return;
    const count = this.selectedCount();
    const isFollowings = state.domain === "followings";
    const name = isFollowings ? "关注者" : "作品";
    const delBody = document.createElement("p");
    delBody.className = "confirm-delete-msg";
    delBody.textContent = `确定移除选中的 ${count} 个${name}？此操作不可撤销。`;
    dialog.showDialog("确认移除", delBody, [
      { text: "取消", ghost: true, callback: () => dialog.closeDialog() },
      {
        text: "移除",
        danger: true,
        callback: async () => {
          dialog.updateDialog("正在移除…", `<p>正在移除 ${count} 个${name}…</p>${utils.SPINNER_HTML}`);
          state.preventDialogClose = true;
          try {
            const result = await this.deleteSelected();
            if (result) {
              // 执行期弹窗已挡住 UI 变更，成功后不再要求"好的"确认（建议2）
              dialog.closeDialog();
              dialog.showToast(`已移除 ${count} 个${name}`, "success");
            }
          } finally {
            state.preventDialogClose = false;
          }
        },
      },
    ]);
  }

  async handleBatchMove() {
    if (this.selectedCount() === 0) return;
    const count = this.selectedCount();
    const name = state.domain === "followings" ? "关注者" : "作品";
    dialog.showGroupSelectDialog(`移动到分组...`, await services.loadGroups(), async (groupId) => {
      dialog.updateDialog("正在移动…", `<p>正在移动 ${count} 个${name}…</p>${utils.SPINNER_HTML}`);
      state.preventDialogClose = true;
      try {
        const result = await this.moveSelected(groupId);
        if (result) {
          dialog.closeDialog();
          dialog.showToast(`已移动 ${count} 个${name}`, "success");
        }
      } finally {
        state.preventDialogClose = false;
      }
    });
  }
}

const batch = new Batch();

// ---------- ImportExport ----------
class ImportExport {
  async handleImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    dom.fileInput.value = "";
    dialog.showDialog("正在导入…", `<p>正在读取文件…</p>${utils.SPINNER_HTML}`);
    state.preventDialogClose = true;
    try {
      const raw = await file.text();
      const data = JSON.parse(raw);
      const domain = state.domain;

      if (domain === "followings" ? !services.isFollowingsData(data) : !services.isWorksData(data)) {
        const expected = domain === "followings" ? "关注数据" : "作品数据";
        dom.dialogTitle.textContent = "导入失败";
        dom.dialogBody.innerHTML = `<p class="dy-text-danger">文件内容不是${expected}</p>`;
        dialog.showOkDialog();
        return;
      }

      dom.dialogTitle.textContent = "正在保存…";
      dom.dialogBody.innerHTML = "<p>正在保存数据…</p>";
      const res = await services.bgMsg({ type: "IMPORT_DATA", data, domain });

      if (domain === "works") {
        const works = await services.loadWorks(state.currentGroupId);
        if (state.domain !== "works") return;
        store.set("works", works);
      } else {
        const followings = await services.loadFollowings(state.currentGroupId);
        if (state.domain !== "followings") return;
        store.set("followings", followings);
      }

      await groups.renderGroupTabs();
      dom.dialogBody.innerHTML = "";
      if (res.ok) {
        const importTmpl = document.getElementById("importResultTemplate");
        const importBody = importTmpl.content.cloneNode(true);
        importBody.querySelector(".import-file-name").textContent = file.name;
        importBody.querySelector(".import-added").textContent = res.added;
        importBody.querySelector(".import-updated").textContent = res.updated;
        importBody.querySelector(".import-invalid").textContent = res.invalid || 0;
        importBody.querySelector(".import-total").textContent = res.total;
        dom.dialogTitle.textContent = "导入完成";
        dom.dialogBody.appendChild(importBody);
        dialog.showOkDialog();
      } else {
        dom.dialogTitle.textContent = "导入失败";
        dom.dialogBody.innerHTML = `<p class="dy-text-danger">${res.error || "解析失败，请检查文件格式"}</p>`;
        dialog.showOkDialog();
      }
    } catch (err) {
      dom.dialogTitle.textContent = "导入失败";
      dom.dialogBody.innerHTML = `<p class="dy-text-danger">文件解析错误：${err.message}</p>`;
      dialog.showOkDialog();
    } finally {
      state.preventDialogClose = false;
    }
  }

  async handleExport() {
    const domain = state.domain || "works";
    dialog.showDialog("正在导出…", `<p>正在打包数据…</p>${utils.SPINNER_HTML}`);
    state.preventDialogClose = true;
    try {
      const res = await services.bgMsg({ type: "EXPORT_DATA", domain });
      if (!res.ok || !res.data) {
        dom.dialogTitle.textContent = "导出失败";
        dom.dialogBody.innerHTML = `<p class="dy-text-danger">${res?.error || "未知错误"}</p>`;
        dialog.showOkDialog();
        return;
      }
      const dateStr = new Date().toLocaleDateString("zh-CN").replace(/\//g, "-");
      const filename = `${domain}-${dateStr}.json`;
      const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      dom.dialogTitle.textContent = "导出完成";
      dom.dialogBody.innerHTML = `<p>文件已下载：${filename}</p>`;
      dialog.showOkDialog();
    } catch (err) {
      dom.dialogTitle.textContent = "导出失败";
      dom.dialogBody.innerHTML = `<p class="dy-text-danger">${err.message}</p>`;
      dialog.showOkDialog();
    } finally {
      state.preventDialogClose = false;
    }
  }
}

const importExport = new ImportExport();

// ---------- Sidebar ----------
class Sidebar {
  static SNAP_POINTS = config.SIDEBAR_SNAP_POINTS;
  static STORAGE_KEY = "douyin_sidebar_width";
  #dragStartX = 0;
  #dragStartW = 0;
  #dragMoved = false;
  #pendingSidebarWidth = 0;
  #pendingSidebarWidthDirty = false;
  #pendingSidebarWidthRafId = 0;
  #scrollRafPending = false;
  #imgQueue = [];
  #imgDrainRafId = 0;
  #sideFillObs = null;
  #sideUnloadObs = null;
  #workMeta = new WeakMap();
  #onResizeDown = (e) => {
    this.#dragStartX = e.clientX;
    this.#dragStartW = dom.sidebar.classList.contains("sidebar-zero") ? 0 : dom.sidebar.getBoundingClientRect().width;
    this.#dragMoved = false;
    dom.sidebarResizeHandle.classList.add("active");
    document.addEventListener("mousemove", this.#onResizeMove);
    document.addEventListener("mouseup", this.#onResizeUp);
    e.preventDefault();
  };
  #onResizeMove = (e) => {
    if (!this.#dragMoved && Math.abs(e.clientX - this.#dragStartX) >= config.SIDEBAR_DRAG_THRESHOLD) {
      this.#dragMoved = true;
    }
    const snapped = this.#snapTo(this.#dragStartW - (e.clientX - this.#dragStartX));
    this.#pendingSidebarWidth = snapped;
    this.#pendingSidebarWidthDirty = true;
    if (this.#pendingSidebarWidthRafId) return;
    this.#pendingSidebarWidthRafId = requestAnimationFrame(() => {
      this.#pendingSidebarWidthRafId = 0;
      if (this.#pendingSidebarWidthDirty) {
        this.#pendingSidebarWidthDirty = false;
        this.setSidebarWidth(this.#pendingSidebarWidth);
      }
    });
  };
  #onResizeUp = () => {
    dom.sidebarResizeHandle.classList.remove("active");
    document.removeEventListener("mousemove", this.#onResizeMove);
    document.removeEventListener("mouseup", this.#onResizeUp);
    // 未越过拖拽位移阈值按点击处理：切换侧边栏显隐而非吸附宽度
    if (!this.#dragMoved) {
      this.toggleSidebar();
      return;
    }
    const finalWidth = this.#snapTo(
      dom.sidebar.classList.contains("sidebar-zero") ? 0 : dom.sidebar.getBoundingClientRect().width,
    );
    this.setSidebarWidth(finalWidth);
    this.saveSidebarWidth(finalWidth);
  };

  // 点击分割条：收起（落盘 0，与拖拽收起语义一致）；展开恢复上次保存的宽度
  toggleSidebar() {
    if (dom.sidebar.classList.contains("sidebar-zero")) {
      const target = this.#loadWidth() || Sidebar.SNAP_POINTS[0];
      this.setSidebarWidth(target);
      this.saveSidebarWidth(target);
    } else {
      this.setSidebarWidth(0);
      this.saveSidebarWidth(0);
    }
  }

  initSidebar() {
    const savedWidth = this.#loadWidth();
    const snapped = this.#snapTo(savedWidth);
    this.setSidebarWidth(snapped);
    this.#initResize();
    dom.sidebarBody.addEventListener("scroll", () => {
      if (this.#scrollRafPending) return;
      this.#scrollRafPending = true;
      requestAnimationFrame(() => {
        this.#scrollRafPending = false;
        if (
          dom.sidebarBody.scrollTop + dom.sidebarBody.clientHeight >=
          dom.sidebarBody.scrollHeight - config.SIDEBAR_SCROLL_THRESHOLD
        ) {
          this.#loadMoreWorks();
        }
      });
    }, { passive: true });
  }

  setSidebarWidth(w) {
    if (w === 0) {
      dom.sidebar.classList.add("sidebar-zero");
      dom.sidebar.style.width = "";
      document.body.classList.remove("sidebar-open");
    } else {
      dom.sidebar.classList.remove("sidebar-zero");
      dom.sidebar.style.width = w + "px";
      document.body.classList.add("sidebar-open");
    }
  }

  saveSidebarWidth(width) {
    localStorage.setItem(Sidebar.STORAGE_KEY, String(width));
  }

  clearSidebarActive() {
    const active = dom.mainContainer.querySelector(".following-card.sidebar-active");
    if (active) active.classList.remove("sidebar-active");
  }

  openSidebar(following) {
    this.clearSidebarActive();
    const card = dom.mainContainer.querySelector(`[data-uid="${following.uid}"]`);
    if (card) card.classList.add("sidebar-active");

    state.currentFollowingSecUid = utils.secUidFromUrl(following.profileUrl);
    state.sidebarCursor = null;
    state.sidebarLoading = false;

    const needsExpand = dom.sidebar.classList.contains("sidebar-zero");
    if (needsExpand) {
      const target = this.#loadWidth() || 650;
      this.setSidebarWidth(target);
      this.saveSidebarWidth(target);
    }

    this.#resetSidebarGrid();
    this.loadSidebarWorks(state.currentFollowingSecUid, null, true);
    this.#calibrateFollowing(following);
  }

  // 打开侧边栏即顺带校准该用户的权威计数（profile/other，单请求）：成功后同步
  // 更新 state 与可见卡片；失败静默忽略，不影响作品加载
  async #calibrateFollowing(following) {
    const secUid = state.currentFollowingSecUid;
    if (!secUid || !following?.uid) return;
    const res = await services.bgMsg({ type: "CALIBRATE_FOLLOWING", uid: following.uid, secUid });
    if (!res?.ok) return;
    const entry = state.followings.find((f) => String(f.uid) === String(following.uid));
    if (entry) {
      entry.awemeCount = res.awemeCount;
      entry.followerCount = res.followerCount;
    }
    const card = dom.mainContainer.querySelector(`[data-uid="${following.uid}"]`);
    if (card && !card.classList.contains(followingsGrid.skeletonClass)) {
      const followersEl = card.querySelector(".stat-followers");
      const worksEl = card.querySelector(".stat-works");
      if (followersEl) followersEl.textContent = utils.formatCount(res.followerCount) + " 粉丝";
      if (worksEl) worksEl.textContent = utils.formatCount(res.awemeCount) + " 作品";
    }
  }

  // 重开作者前整体复位：在途探针作废、观察器断开重建，防止上一作者的条目观察残留
  #resetSidebarGrid() {
    this.#clearImgQueue();
    if (this.#sideFillObs) {
      this.#sideFillObs.disconnect();
      this.#sideFillObs = null;
    }
    if (this.#sideUnloadObs) {
      this.#sideUnloadObs.disconnect();
      this.#sideUnloadObs = null;
    }
    dom.sidebarWorksGrid.innerHTML = "";
  }

  async loadSidebarWorks(secUid, cursor, reset) {
    if (state.sidebarLoading) return;
    state.sidebarLoading = true;
    dom.sidebarLoader.classList.remove("hidden");

    try {
      const res = await services.bgMsg({
        type: "FETCH_WORKS_PAGE",
        secUid,
        cursor: cursor || "",
      });

      if (reset) dom.sidebarWorksGrid.innerHTML = "";

      if (res.ok && res.works) {
        const fragment = document.createDocumentFragment();
        const items = [];
        for (const w of res.works) {
          const item = this.#createWorkItem(w);
          fragment.appendChild(item);
          items.push(item);
        }
        dom.sidebarWorksGrid.appendChild(fragment);
        state.sidebarCursor = res.hasMore ? res.maxCursor || "" : null;
        // 新条目只进"观察圈"：进入视口才升级（发探针+绘制），滚出远圈后降级回占位态
        this.#ensureSideObservers();
        for (const el of items) {
          if (this.#workMeta.has(el)) this.#sideFillObs.observe(el);
        }
      }
      dom.sidebarLoader.classList.add("hidden");
    } catch (_e) {
      console.error("[DY] sidebar load failed:", _e);
      dom.sidebarLoader.querySelector(".spinner")?.remove();
      dom.sidebarLoader.textContent = "加载失败" + (_e.message ? ": " + _e.message : "");
    }

    state.sidebarLoading = false;

    if (
      state.sidebarCursor &&
      dom.sidebarBody.scrollHeight <= dom.sidebarBody.clientHeight + config.SIDEBAR_FILL_THRESHOLD
    ) {
      this.#loadMoreWorks();
    }
  }

  #loadWidth() {
    return parseInt(localStorage.getItem(Sidebar.STORAGE_KEY)) || 0;
  }

  #snapTo(v) {
    let n = Sidebar.SNAP_POINTS[0];
    for (let i = 0; i < Sidebar.SNAP_POINTS.length; i++) {
      if (Math.abs(Sidebar.SNAP_POINTS[i] - v) < Math.abs(n - v)) n = Sidebar.SNAP_POINTS[i];
    }
    return n;
  }

  #initResize() {
    dom.sidebarResizeHandle.addEventListener("mousedown", this.#onResizeDown);
  }

  #loadMoreWorks() {
    if (state.sidebarLoading || !state.sidebarCursor || !state.currentFollowingSecUid) return;
    this.loadSidebarWorks(state.currentFollowingSecUid, state.sidebarCursor, false);
  }

  // 侧边栏双向虚拟化：与 VirtualGrid 同一不变量——根节点不换，只在占位态/完整态间原地切换。
  // 观察圈以 sidebarBody 为 root（rootMargin 相对滚动容器自身矩形展开，不受祖先裁剪抵消）
  #ensureSideObservers() {
    if (this.#sideFillObs) return;
    this.#sideFillObs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          this.#sideFillObs.unobserve(entry.target);
          this.#promoteItem(entry.target);
        }
      },
      { root: dom.sidebarBody, rootMargin: config.OBSERVER_ROOT_MARGIN },
    );
    this.#sideUnloadObs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) this.#demoteItem(entry.target);
        }
      },
      { root: dom.sidebarBody, rootMargin: config.UNLOAD_ROOT_MARGIN },
    );
  }

  #promoteItem(item) {
    const meta = this.#workMeta.get(item);
    if (!meta || !meta.url) return;
    this.#enqueueCover(meta.cover, meta.url, meta.placeholder);
    this.#sideUnloadObs.observe(item);
  }

  // 原地降级：清背景图、恢复占位层，尺寸由 aspect-ratio 保持；
  // 代际自增作废在途探针（重升级会再次入队，旧回调不得回填）
  #demoteItem(item) {
    const meta = this.#workMeta.get(item);
    if (!meta || !meta.url) return;
    meta.cover.dataset.gen = String((Number(meta.cover.dataset.gen) || 0) + 1);
    meta.cover.style.backgroundImage = "";
    meta.placeholder.style.display = "";
    this.#sideUnloadObs.unobserve(item);
    this.#sideFillObs.observe(item);
  }

  // 封面分帧探针化：每帧最多 SIDEBAR_IMG_PER_FRAME 张；gen 代际防降级/重升级后的乱序回填
  #enqueueCover(cover, url, placeholder) {
    const gen = String((Number(cover.dataset.gen) || 0) + 1);
    cover.dataset.gen = gen;
    this.#imgQueue.push({ cover, url, placeholder, gen });
    this.#scheduleImgDrain();
  }

  // 探针预载：失败 URL 不落可见节点（与关注头像同一不变量），封面 div 保持透明由条目底色兜底；
  // 成功提交背景图并直接隐藏占位层
  #scheduleImgDrain() {
    if (this.#imgDrainRafId) return;
    this.#imgDrainRafId = requestAnimationFrame(() => {
      this.#imgDrainRafId = 0;
      let n = 0;
      while (this.#imgQueue.length && n < config.SIDEBAR_IMG_PER_FRAME) {
        const { cover, url, placeholder, gen } = this.#imgQueue.shift();
        // 已降级/已重建的条目直接丢弃，不再发探针请求
        if (!cover.isConnected || cover.dataset.gen !== gen) continue;
        const alive = () => cover.isConnected && cover.dataset.gen === gen;
        const probe = new Image();
        probe.onload = () => {
          if (!alive()) return;
          detail.markMediaOk();
          cover.style.backgroundImage = `url("${url.replace(/["\\]/g, "\\$&")}")`;
          if (placeholder && placeholder.isConnected) placeholder.style.display = "none";
        };
        probe.onerror = () => {
          if (!alive()) return;
          detail.markMediaFail();
        };
        probe.src = url;
        n++;
      }
      if (this.#imgQueue.length) this.#scheduleImgDrain();
    });
  }

  #clearImgQueue() {
    if (this.#imgDrainRafId) {
      cancelAnimationFrame(this.#imgDrainRafId);
      this.#imgDrainRafId = 0;
    }
    this.#imgQueue = [];
  }

  #createWorkItem(work) {
    const item = dom.sidebarWorkTemplate.content.cloneNode(true).firstElementChild;
    const link = item.children[0];
    const isNote = work.type === "note";
    const type = isNote ? "note" : "video";
    link.href = `${config.URL_BASE}/${type}/${work.awemeId}`;

    const badge = link.querySelector(".work-type-badge");
    if (badge) badge.classList.toggle("hidden", !isNote);

    const img = link.children[0];
    const placeholder = link.children[1];
    const cover = isNote ? work.images?.[0] || work.cover : work.cover;
    const url = cover ? utils.pickHttpsUrl(cover) : "";
    if (url) {
      // 元数据挂 WeakMap；探针推迟到条目进入视口（#promoteItem）才发，不再创建即全量急切加载
      this.#workMeta.set(item, { url, cover: img, placeholder });
    } else {
      img.style.display = "none";
      if (isNote) placeholder.textContent = "📰";
    }

    const plays = work.statistics && work.statistics.play_count ? utils.formatCount(work.statistics.play_count) : "";
    const playsEl = link.children[2];
    if (plays) {
      playsEl.textContent = "\u25B6 " + plays;
    } else {
      playsEl.style.display = "none";
    }

    return item;
  }
}

const sidebar = new Sidebar();

// ---------- Sync ----------
class Sync {
  #running = false;
  #requestId = null;
  #currentDomain = null;
  #doneCount = 0;
  #total = 0;
  #errorCount = 0;
  #countEl = null;
  #summaryEl = null;
  #statusEl = null;

  isRunning() {
    return this.#running;
  }

  #initProgress(total) {
    this.#total = total;
    this.#doneCount = 0;
    this.#errorCount = 0;
  }

  #updateCount() {
    if (!this.#countEl) return;
    const label = this.#currentDomain === "followings" ? "作者" : "作品";
    this.#countEl.textContent = `已同步${label} ${this.#doneCount} / ${this.#total}`;
  }

  #setSummary(text) {
    if (this.#summaryEl) this.#summaryEl.textContent = text || "";
  }

  #addTrashButton(onClick) {
    const btn = document.createElement("button");
    btn.className = "dy-btn flex-inline-center dy-btn-ghost";
    btn.textContent = "稍后删除";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await onClick();
      this.closeSyncDialog();
    });
    dom.dialogFooter.appendChild(btn);
  }

  async #refreshWorks() {
    const works = await services.loadWorks(state.currentGroupId);
    store.set("works", works);
    await groups.renderGroupTabs();
  }

  openSyncDialog(total, domain) {
    this.#initProgress(total);
    this.#currentDomain = domain;

    const tmpl = document.getElementById("syncDialogBodyTemplate");
    const body = tmpl.content.cloneNode(true);
    this.#countEl = body.querySelector(".sync-count");
    this.#summaryEl = body.querySelector(".sync-summary");
    this.#statusEl = body.querySelector(".sync-status");

    const label = domain === "followings" ? "作者" : "作品";
    this.#countEl.textContent = `已同步${label} 0 / ${total}`;
    this.#summaryEl.textContent = domain === "followings" ? "正在获取关注…" : "同步失败作品 0 个";
    this.#statusEl.textContent = "SYNCING";

    dialog.showDialog("同步作品", body, [], () => this.closeSyncDialog());
  }

  closeSyncDialog() {
    dialog.closeDialog();
    this.finish();
  }

  finish() {
    this.#running = false;
    this.#requestId = null;
    this.#currentDomain = null;
  }

  onSyncProgress(msg) {
    if (!this.#running || this.#currentDomain !== "works") return;
    if (msg.requestId !== this.#requestId) return;

    this.#doneCount++;
    if (msg.status !== "ok") this.#errorCount++;
    this.#updateCount();
    this.#setSummary(`同步失败作品 ${this.#errorCount} 个`);
  }

  async onSyncDone(msg) {
    if (!this.#running || this.#currentDomain !== "works") return;
    if (msg && msg.requestId !== this.#requestId) return;

    this.#running = false;

    if (!msg || !msg.ok) {
      if (this.#statusEl) this.#statusEl.textContent = msg?.error || "ERROR";
      return;
    }

    await this.#refreshWorks();

    this.#setSummary(`同步失败作品 ${msg.failed || 0} 个`);
    if (this.#statusEl) this.#statusEl.textContent = "DONE";

    const failedIds = msg.failedAwemeIds || [];
    if (failedIds.length > 0) {
      this.#addTrashButton(() => this.moveFailed(failedIds));
    }
  }

  onFollowingProgress(msg) {
    if (!this.#running || this.#currentDomain !== "followings") return;
    if (this.#requestId !== null && msg.requestId !== this.#requestId) return;

    this.#doneCount = msg.collected || 0;
    this.#total = msg.total || 0;
    this.#updateCount();
    this.#setSummary(msg.phase === "calibrate" ? "正在校准作品数…" : "正在获取关注…");
  }

  async startSync(awemeIds) {
    if (this.#running) return null;
    if (!Array.isArray(awemeIds) || awemeIds.length === 0) return "EMPTY";
    this.#running = true;

    chrome.runtime.sendMessage({ type: "CANCEL_ACTIVE_TASK" }).catch(() => {});

    try {
      const res = await services.bgMsg({ type: "SYNC_WORKS", awemeIds });
      if (!this.#running) return "CANCELLED";
      if (!res || res.error === "NO_DOUYIN_TAB") {
        this.#running = false;
        return "NO_DOUYIN_TAB";
      }
      if (!res || res.requestId === null || res.requestId === undefined) {
        this.#running = false;
        return { error: (res && res.error) || "未知错误" };
      }
      this.#requestId = res.requestId;
      return { requestId: res.requestId };
    } catch (err) {
      this.#running = false;
      return { error: err.message || String(err) };
    }
  }

  async syncAwemeIds(awemeIds) {
    if (this.isRunning()) return;
    if (!Array.isArray(awemeIds) || awemeIds.length === 0) return;

    this.openSyncDialog(awemeIds.length, "works");
    const result = await this.startSync(awemeIds);

    if (result === "NO_DOUYIN_TAB") {
      if (this.#statusEl) this.#statusEl.textContent = "NO_DOUYIN_TAB";
      return;
    }
    if (result && result.error) {
      if (this.#statusEl) this.#statusEl.textContent = result.error;
    }
  }

  async syncCurrentGroup() {
    if (this.isRunning()) return;
    if (state.domain !== "works") return;
    const awemeIds = [...new Set(state.works.map((w) => String(w.awemeId)).filter(Boolean))];
    if (awemeIds.length === 0) return;
    await this.syncAwemeIds(awemeIds);
  }

  async vmSyncFollowings() {
    if (this.#running) return null;
    if (state.domain !== "followings") return null;
    this.#running = true;

    const secUid = await services.findSecUid();
    if (!secUid) {
      this.#running = false;
      return "NO_SEC_UID";
    }

    chrome.runtime.sendMessage({ type: "CANCEL_ACTIVE_TASK" }).catch(() => {});

    try {
      const res = await services.bgMsg({ type: "FETCH_FOLLOWING", secUid });
      if (!this.#running) return "CANCELLED";
      if (res.error === "NO_DOUYIN_TAB") {
        this.#running = false;
        return "NO_DOUYIN_TAB";
      }
      if (!res.ok) {
        this.#running = false;
        if (res.error && res.error.includes("NO_SIGNATURE")) return "NO_SIGNATURE";
        throw new Error(res.error || "FETCH_FAILED");
      }
      this.#requestId = res.requestId || null;

      if (!this.#running) return "CANCELLED";

      const saveRes = await services.bgMsg({ type: "SAVE_FOLLOWINGS", followings: res.followings || [] });
      if (!this.#running) return "CANCELLED";

      await services.loadDomainData();
      this.#running = false;
      this.#requestId = null;
      return saveRes;
    } catch (err) {
      this.#running = false;
      this.#requestId = null;
      const msg = err.message || String(err);
      if (msg.includes("NO_SIGNATURE")) return "NO_SIGNATURE";
      return { error: msg };
    }
  }

  async syncFollowings() {
    if (this.isRunning()) return;
    if (state.domain !== "followings") return;

    this.openSyncDialog(0, "followings");

    const result = await this.vmSyncFollowings();

    if (result === null) return;

    if (result === "NO_SEC_UID") {
      if (this.#statusEl) this.#statusEl.textContent = "NO_SEC_UID";
      return;
    }

    if (result === "NO_DOUYIN_TAB") {
      if (this.#statusEl) this.#statusEl.textContent = "NO_DOUYIN_TAB";
      return;
    }

    if (result === "NO_SIGNATURE") {
      this.closeSyncDialog();
      dialog.showNoSignatureDialog(config.URL_USER_SELF + config.URL_FOLLOWING_TAB, "关注", "同步关注列表");
      return;
    }

    if (result === "CANCELLED") return;

    if (result && result.error) {
      if (this.#statusEl) this.#statusEl.textContent = result.error;
      return;
    }

    if (result && result.added !== undefined) {
      const fresh = await services.loadFollowings(state.currentGroupId);
      store.set("followings", fresh);
      store.refreshGroups();
      this.#setSummary(`新增关注 ${result.added}，取消关注 ${result.lost}`);
      if (this.#statusEl) this.#statusEl.textContent = "DONE";
      const lostUids = result.lostUids || [];
      if (lostUids.length > 0) {
        this.#addTrashButton(() => this.moveLostFollowings(lostUids));
      }
    }
  }

  async moveFailed(failedIds) {
    const groupsRes = await services.bgMsg({ type: "GET_GROUPS", domain: "works" });
    const groups = groupsRes.groups || [];
    let trashGroup = groups.find((g) => g.name === config.TRASH_GROUP_NAME);
    if (!trashGroup) {
      const addRes = await services.bgMsg({ type: "ADD_GROUP", domain: "works", name: config.TRASH_GROUP_NAME });
      if (addRes.ok) trashGroup = addRes.group;
    }
    if (trashGroup) {
      await services.bgMsg({ type: "MOVE_WORKS", awemeIds: failedIds, targetGroupId: trashGroup.id });
      await services.loadDomainData();
      store.refreshGroups();
    }
    return trashGroup;
  }

  async moveLostFollowings(lostUids) {
    const groupsRes = await services.bgMsg({ type: "GET_GROUPS", domain: "followings" });
    const groups = groupsRes.groups || [];
    let trashGroup = groups.find((g) => g.name === config.TRASH_GROUP_NAME);
    if (!trashGroup) {
      const addRes = await services.bgMsg({ type: "ADD_GROUP", domain: "followings", name: config.TRASH_GROUP_NAME });
      if (addRes.ok) trashGroup = addRes.group;
    }
    if (trashGroup) {
      await services.moveFollowings(lostUids, trashGroup.id);
      await services.loadDomainData();
      store.refreshGroups();
    }
    return trashGroup;
  }

  updateSyncBtnLabel() {
    const btn = dom.btnSync;
    if (!btn) return;
    btn.textContent = state.domain === "followings" ? "同步关注" : "同步作品";
  }
}

const sync = new Sync();

// ---------- Settings ----------
class Settings {
  async openPanel() {
    const tmpl = document.getElementById("settingsDialogTemplate");
    const body = tmpl.content.cloneNode(true);
    dialog.showDialog("设置", body);
    this._dialogBody = dom.dialogBody;
    // 两个开关的未保存选择：_refresh 渲染时 pending 优先于存储值，落库统一走 saveBeforeClose
    this._pendingIndependent = null;
    this._pendingCalibrate = null;
    this._bind();
    this._bindStatus();
    state.preventDialogClose = true;
    try {
      await this._refresh();
    } finally {
      state.preventDialogClose = false;
    }
  }

  _statusTimeStr(updatedAt) {
    return updatedAt ? new Date(updatedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "";
  }

  _toggleTruncated(el, hint) {
    if (!el) return;
    const expanded = el.classList.toggle("sec-expanded");
    el.classList.toggle("sec-truncate", !expanded);
    if (hint) hint.textContent = expanded ? "[收起]" : "[展开]";
  }

  toggleKeyExpand(root) {
    const text = root.querySelector("#secKeyValueText");
    const hint = root.querySelector("#secKeyValue .sec-expand-hint");
    this._toggleTruncated(text, hint);
  }

  toggleSigExpand(root, rowId) {
    const row = root.querySelector("#" + rowId);
    if (!row) return;
    const text = row.querySelector(".sec-truncate, .sec-expanded");
    const hint = row.querySelector(".sec-expand-hint");
    if (!text || !hint || hint.classList.contains("hidden")) return;
    this._toggleTruncated(text, hint);
  }

  _renderStatusKey(root, key, updatedAt) {
    const statusEl = root.querySelector("#secKeyStatus");
    const valueEl = root.querySelector("#secKeyValueText");
    const expandHint = root.querySelector("#secKeyValue .sec-expand-hint");
    const hintEl = root.querySelector("#secKeyHint");
    const copyBtn = root.querySelector("#secKeyValue .sec-copy-btn");
    if (key) {
      const t = this._statusTimeStr(updatedAt);
      statusEl.textContent = t ? `✅ 可用 · ${t}` : "✅ 可用";
      statusEl.className = "sec-value sec-ok";
      valueEl.textContent = key;
      valueEl.classList.add("sec-truncate");
      valueEl.classList.remove("sec-expanded");
      if (expandHint) {
        expandHint.classList.remove("hidden");
        expandHint.textContent = "[展开]";
      }
      if (copyBtn) copyBtn.classList.remove("hidden");
      hintEl.classList.add("hidden");
    } else {
      statusEl.textContent = "❌ 不可用";
      statusEl.className = "sec-value sec-err";
      valueEl.textContent = "—";
      valueEl.classList.add("sec-truncate");
      valueEl.classList.remove("sec-expanded");
      if (expandHint) expandHint.classList.add("hidden");
      if (copyBtn) copyBtn.classList.add("hidden");
      hintEl.classList.remove("hidden");
      hintEl.textContent = "请确保抖音页面已打开且您已登录 → 刷新抖音页面（按 F5） → 等待页面加载完成（约 3-5 秒） → 返回此处点击刷新按钮";
    }
  }

  _renderStatusSig(root, sig, rowId, valueId, guidance) {
    const valueEl = root.querySelector("#" + valueId);
    const statusEl = root.querySelector("#" + valueId.replace(/Value$/, "Status"));
    const expandHint = root.querySelector("#" + rowId + " .sec-expand-hint");
    const hintEl = root.querySelector("#" + valueId.replace(/Value$/, "Hint"));
    const copyBtn = root.querySelector("#" + rowId + " .sec-copy-btn");
    const v = sig?.value || "";
    const t = sig?.updatedAt || 0;
    if (v) {
      const ts = this._statusTimeStr(t);
      statusEl.textContent = ts ? `✅ 已捕获 · ${ts}` : "✅ 已捕获";
      statusEl.className = "sec-value sec-ok";
      valueEl.textContent = v;
      valueEl.className = "sec-value sec-truncate";
      valueEl.classList.remove("sec-expanded");
      if (expandHint) {
        expandHint.classList.remove("hidden");
        expandHint.textContent = "[展开]";
      }
      if (copyBtn) copyBtn.classList.remove("hidden");
      hintEl.classList.add("hidden");
    } else {
      statusEl.textContent = "❌ 未捕获";
      statusEl.className = "sec-value sec-err";
      valueEl.textContent = "—";
      valueEl.className = "sec-value sec-err";
      valueEl.classList.remove("sec-expanded");
      if (expandHint) expandHint.classList.add("hidden");
      if (copyBtn) copyBtn.classList.add("hidden");
      hintEl.classList.remove("hidden");
      hintEl.textContent = guidance;
    }
  }

  _renderStatusHooks(root, hooks) {
    const fetchEl = root.querySelector("#secHookFetch");
    const xhrEl = root.querySelector("#secHookXhr");
    fetchEl.textContent = hooks.fetch ? "✅ 运行中" : "❌ 未运行";
    fetchEl.className = "sec-value " + (hooks.fetch ? "sec-ok" : "sec-err");
    xhrEl.textContent = hooks.xhr ? "✅ 运行中" : "❌ 未运行";
    xhrEl.className = "sec-value " + (hooks.xhr ? "sec-ok" : "sec-err");
  }

  async _refresh() {
    const [ci, bf, { independentMode }, ct] = await Promise.all([
      services.bgMsg({ type: "GET_COOKIE_INFO" }),
      services.bgMsg({ type: "GET_BROWSER_FEATURES" }),
      chrome.storage.local.get("independentMode"),
      services.bgMsg({ type: "GET_CACHE_TIMES" }).catch(() => ({ ok: false, times: {} })),
    ]);
    const secRes = await services.bgMsg({ type: "GET_SECURITY_STATUS" }).catch((err) => ({ ok: false, error: String(err && err.message || err) }));
    const $ = (id) => this._dialogBody.querySelector("#" + id);
    const cookieList = $("settingsCookieList");
    cookieList.innerHTML = "";
    const pairs = ci?.pairs || [];
    if (pairs.length > 0) {
      const table = document.createElement("table");
      table.className = "cookie-table";
      const colgroup = document.createElement("colgroup");
      const colKey = document.createElement("col");
      colKey.className = "cookie-key-col";
      const colVal = document.createElement("col");
      colgroup.appendChild(colKey);
      colgroup.appendChild(colVal);
      table.appendChild(colgroup);
      const tbody = document.createElement("tbody");
      for (const p of pairs) {
        const tr = document.createElement("tr");
        const tdKey = document.createElement("td");
        tdKey.className = "cookie-key";
        tdKey.textContent = p.key;
        const tdVal = document.createElement("td");
        const code = document.createElement("code");
        code.className = "cookie-val";
        code.textContent = p.value || "";
        tdVal.appendChild(code);
        tr.appendChild(tdKey);
        tr.appendChild(tdVal);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      cookieList.appendChild(table);
    } else {
      const hint = document.createElement("p");
      hint.className = "settings-hint";
      hint.textContent = "未捕获到 Cookie，请打开抖音页面";
      cookieList.appendChild(hint);
    }
    const modeSwitch = $("settingsModeSwitch");
    if (modeSwitch) {
      this.#applySwitchUI(modeSwitch, this._pendingIndependent ?? independentMode);
    }
    $("settingsModeHint").textContent = "";
    const features = bf?.features;
    const list = $("settingsBFList");
    list.innerHTML = "";
    if (features) {
      const entries = Object.entries(features).filter(([k]) => k !== "securityKey");
      if (entries.length > 0) {
        const table = document.createElement("table");
        table.className = "cookie-table";
        const colgroup = document.createElement("colgroup");
        const colKey = document.createElement("col");
        colKey.className = "cookie-key-col";
        const colVal = document.createElement("col");
        colgroup.appendChild(colKey);
        colgroup.appendChild(colVal);
        table.appendChild(colgroup);
        const tbody = document.createElement("tbody");
        for (const [k, v] of entries) {
          const tr = document.createElement("tr");
          const tdKey = document.createElement("td");
          tdKey.className = "cookie-key";
          tdKey.textContent = k;
          const tdVal = document.createElement("td");
          const code = document.createElement("code");
          code.className = "cookie-val";
          code.textContent = String(v);
          tdVal.appendChild(code);
          tr.appendChild(tdKey);
          tr.appendChild(tdVal);
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        list.appendChild(table);
      } else {
        list.innerHTML = '<span class="settings-hint">未捕获，将使用默认值。打开抖音页面后可自动捕获。</span>';
      }
    } else {
      list.innerHTML = '<span class="settings-hint">未捕获，将使用默认值。打开抖音页面后可自动捕获。</span>';
    }
    // secUid
    const { secUid } = await chrome.storage.local.get("secUid");
    if ($("settingsSecUid")) $("settingsSecUid").value = secUid || "";
    // 缓存状态
    this._renderCacheList(ci, ct);
    // ponytail: status readout — independent sub-fetch failure should not block the rest
    this._renderStatus(secRes);
    // 运行参数
    this._renderConfigSection();
  }

  _renderConfigSection() {
    const cfg = runtimeConfig._cache || runtimeConfig.DEFAULTS;
    const map = {
      timeoutRequest: "timeoutRequest",
      timeoutSecurityStatus: "timeoutSecurityStatus",
      syncWorksDelayMin: "syncWorksDelayMin",
      syncWorksDelayMax: "syncWorksDelayMax",
      syncFollowingsDelayMin: "syncFollowingsDelayMin",
      syncFollowingsDelayMax: "syncFollowingsDelayMax",
      syncFavoritesDelayMin: "syncFavoritesDelayMin",
      syncFavoritesDelayMax: "syncFavoritesDelayMax",
      syncCollectionDelayMin: "syncCollectionDelayMin",
      syncCollectionDelayMax: "syncCollectionDelayMax",
      cancelLikeDelayMin: "cancelLikeDelayMin",
      cancelLikeDelayMax: "cancelLikeDelayMax",
      cancelCollectionDelayMin: "cancelCollectionDelayMin",
      cancelCollectionDelayMax: "cancelCollectionDelayMax",
      syncBatchSize: "syncBatchSize",
      syncBatchPauseMin: "syncBatchPauseMin",
      syncBatchPauseMax: "syncBatchPauseMax",
      syncKeepaliveInterval: "syncKeepaliveInterval",
      syncRetryMax: "syncRetryMax",
    };
    const section = this._dialogBody.querySelector("#settingsConfigSection");
    if (!section) return;
    for (const [key, inputKey] of Object.entries(map)) {
      const input = section.querySelector(`.config-input[data-key="${inputKey}"]`);
      if (input) input.value = cfg[key] ?? "";
    }
    const calSwitch = section.querySelector("#settingsCalibrateSwitch");
    if (calSwitch) {
      this.#applySwitchUI(calSwitch, this._pendingCalibrate ?? (cfg.calibrateFollowings !== false));
    }
  }

  _renderCacheList(ci, ct) {
    const list = this._dialogBody.querySelector("#settingsCacheList");
    if (!list) return;
    const times = ct?.times || {};
    const hasRawCookie = !!(ci?.rawCookie);
    const items = [
      {
        key: "cookie",
        label: "Cookie",
        time: ci?.time || times.cookie,
        hasCopyAll: hasRawCookie,
      },
      {
        key: "mstoken",
        label: "msToken",
        time: times.msToken,
        hasCopyAll: true,
      },
      {
        key: "webid",
        label: "webId",
        time: times.webId,
        hasCopyAll: true,
      },
      {
        key: "browser_features",
        label: "浏览器特征",
        time: times.browserFeatures,
        hasCopyAll: true,
      },
    ];
    list.innerHTML = items
      .map(
        (item) => {
          const copyBtn = item.hasCopyAll
            ? `<button class="cookie-copy-all-btn" data-copy-type="${item.key}">复制</button>`
            : "";
          return `<div class="cache-item">
        <span class="cache-label">${item.label}</span>
        <span class="cache-time">${utils.formatCacheTime(item.time) || "未捕获"}</span>
        ${copyBtn}
        <button class="cache-refresh-btn" data-refresh="${item.key}">刷新</button>
      </div>`;
        },
      )
      .join("");
  }

  _bindStatus() {
    const root = this._dialogBody;
    root.querySelectorAll(".sec-expand-hint").forEach((hint) => {
      hint.addEventListener("click", (e) => {
        e.stopPropagation();
        const row = hint.closest(".sec-clickable");
        if (!row) return;
        if (row.id === "secKeyValue") this.toggleKeyExpand(root);
        else this.toggleSigExpand(root, row.id);
      });
    });
    root.querySelectorAll(".sec-copy-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const targetId = btn.dataset.copy;
        if (!targetId) return;
        const el = root.querySelector("#" + targetId);
        const text = el?.textContent || "";
        if (!text || text === "\u2014") return;
        navigator.clipboard.writeText(text).then(
          () => dialog.showToast("\u5df2\u590d\u5236", "success")
        );
      });
    });
  }

  _renderStatus(secRes) {
    const root = this._dialogBody;
    if (!root) return;
    // ponytail: a failed sub-fetch only paints the status sections, never blocks others
    if (!secRes || !secRes.ok || !secRes.status) {
      const errMsg = secRes?.error || "QUERY_FAILED";
      const targets = ["secKeyStatus", "secSigFollowingStatus", "secSigPostStatus", "secSigFavoriteStatus", "secSigCollectionStatus", "secHookFetch", "secHookXhr"];
      for (const id of targets) {
        const el = root.querySelector("#" + id);
        if (!el) continue;
        if (id === "secHookFetch" || id === "secHookXhr") {
          el.textContent = "❌ 查询失败";
        } else {
          el.textContent = `❌ 查询失败：${errMsg}`;
        }
        el.className = "sec-value sec-err";
      }
      return;
    }
    const s = secRes.status;
    this._renderStatusKey(root, s.key, s.keyUpdatedAt);
    this._renderStatusSig(root, s.signatures?.following, "secSigFollowing", "secSigFollowingValue", "请在抖音页面访问关注列表，等待列表加载后返回刷新状态");
    this._renderStatusSig(root, s.signatures?.post, "secSigPost", "secSigPostValue", "请在抖音页面访问任意作者主页，等待作品加载后返回刷新状态");
    this._renderStatusSig(root, s.signatures?.favorite, "secSigFavorite", "secSigFavoriteValue", "请在抖音页面访问喜欢列表，等待加载后返回刷新状态");
    this._renderStatusSig(root, s.signatures?.collection, "secSigCollection", "secSigCollectionValue", "请在抖音页面访问收藏列表，等待加载后返回刷新状态");
    this._renderStatusHooks(root, s.hooks);
  }

  // 开关仅切换视觉态；持久化与副作用统一走「关闭时校验并持久化」（saveBeforeClose）
  #applySwitchUI(switchEl, on) {
    const btn = switchEl.querySelector(`.mode-btn[data-mode="${on ? "on" : "off"}"]`);
    if (!btn) return;
    switchEl.querySelectorAll(".mode-btn").forEach((b) => b.classList.toggle("active", b === btn));
    const slider = switchEl.querySelector(".mode-slider");
    if (slider) {
      slider.style.width = btn.offsetWidth + "px";
      slider.style.transform = "translateX(" + btn.offsetLeft + "px)";
    }
  }

  // min/max 成对即时校验：两端同亮同灭，避免只标一端造成误读
  #validateDelayPair(section, key) {
    if (!section || !key || !(key.endsWith("Min") || key.endsWith("Max"))) return;
    const base = key.slice(0, -3);
    const minInput = section.querySelector(`.config-input[data-key="${base}Min"]`);
    const maxInput = section.querySelector(`.config-input[data-key="${base}Max"]`);
    if (!minInput || !maxInput) return;
    const min = Number(minInput.value);
    const max = Number(maxInput.value);
    const filled = minInput.value.trim() !== "" && maxInput.value.trim() !== "";
    const invalid = filled && Number.isFinite(min) && Number.isFinite(max) && min > max;
    minInput.classList.toggle("input-invalid", invalid);
    maxInput.classList.toggle("input-invalid", invalid);
  }

  _bind() {
    const $ = (id) => this._dialogBody.querySelector("#" + id);
    // ponytail: section titles toggle a .collapsed class; CSS grid-template-rows handles the animation
    this._dialogBody.querySelectorAll(".settings-section-title").forEach((h3) => {
      h3.addEventListener("click", () => {
        h3.closest(".settings-section").classList.toggle("collapsed");
      });
    });
    // 恢复默认（建议9）：仅回填输入框，持久化仍统一走关闭面板时的 saveBeforeClose
    const cfgSection = $("settingsConfigSection");
    $("btnResetConfig")?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!cfgSection) return;
      cfgSection.querySelectorAll(".config-input").forEach((inp) => {
        const key = inp.dataset.key;
        if (key && runtimeConfig.DEFAULTS[key] != null) inp.value = runtimeConfig.DEFAULTS[key];
        inp.classList.remove("input-invalid");
      });
      dialog.showToast("已填入默认参数，关闭面板时保存", "info");
    });
    // min/max 即时校验（建议9）：输入期红框提示，保存拦截仍由 saveBeforeClose 兜底
    cfgSection?.addEventListener("input", (e) => {
      const input = e.target.closest?.(".config-input");
      if (!input) return;
      this.#validateDelayPair(cfgSection, input.dataset.key);
    });
    const modeSwitch = $("settingsModeSwitch");
    if (modeSwitch) {
      modeSwitch.addEventListener("click", (e) => {
        const btn = e.target.closest(".mode-btn");
        if (!btn || btn.classList.contains("active")) return;
        this._pendingIndependent = btn.dataset.mode === "on";
        this.#applySwitchUI(modeSwitch, this._pendingIndependent);
      });
    }
    const calibrateSwitch = this._dialogBody.querySelector("#settingsCalibrateSwitch");
    if (calibrateSwitch) {
      calibrateSwitch.addEventListener("click", (e) => {
        const btn = e.target.closest(".mode-btn");
        if (!btn || btn.classList.contains("active")) return;
        this._pendingCalibrate = btn.dataset.mode === "on";
        this.#applySwitchUI(calibrateSwitch, this._pendingCalibrate);
      });
    }
    // 缓存刷新按钮
    const cacheList = $("settingsCacheList");
    if (cacheList) {
      const TYPE_MAP = { cookie: "COOKIE", mstoken: "MSTOKEN", webid: "WEBID", browser_features: "BROWSER_FEATURES" };
      const COPY_MAP = {
        cookie: async () => {
          const ci = await services.bgMsg({ type: "GET_COOKIE_INFO" });
          return ci?.rawCookie || "";
        },
        mstoken: async () => {
          const { savedMsToken } = await chrome.storage.local.get("savedMsToken");
          return savedMsToken || "";
        },
        webid: async () => {
          const { savedWebId } = await chrome.storage.local.get("savedWebId");
          return savedWebId || "";
        },
        browser_features: async () => {
          const res = await services.bgMsg({ type: "GET_BROWSER_FEATURES" });
          return res?.features ? JSON.stringify(res.features, null, 2) : "";
        },
      };
      cacheList.addEventListener("click", async (e) => {
        const copyBtn = e.target.closest("[data-copy-type]");
        if (copyBtn) {
          e.stopPropagation();
          const type = copyBtn.dataset.copyType;
          const fn = COPY_MAP[type];
          if (fn) {
            const text = await fn();
            if (text) {
              navigator.clipboard.writeText(text).then(
                () => dialog.showToast("已复制", "success")
              );
            }
          }
          return;
        }
        const btn = e.target.closest(".cache-refresh-btn");
        if (!btn || btn.classList.contains("loading")) return;
        const type = TYPE_MAP[btn.dataset.refresh];
        if (!type) return;
        btn.classList.add("loading");
        btn.textContent = "刷新中…";
        try {
          const res = await services.bgMsg({ type: "REFRESH_" + type });
          if (res?.ok) {
            await this._refresh();
          } else {
            dialog.showToast(res?.hint || res?.error || "刷新失败", "error");
          }
        } catch {
          dialog.showToast("刷新失败", "error");
        } finally {
          btn.classList.remove("loading");
          btn.textContent = "刷新";
        }
      });
    }
  }

  // X 关闭时校验并持久化运行参数与 secUid；返回 false 表示校验未通过、保持弹窗打开
  async saveBeforeClose() {
    if (!this._dialogBody) return true;
    const section = this._dialogBody.querySelector("#settingsConfigSection");
    // 设置面板未打开（当前弹窗是其它面板）时无需处理
    if (!section) return true;
    const FIELDS = [
      "timeoutRequest", "timeoutSecurityStatus",
      "syncWorksDelayMin", "syncWorksDelayMax",
      "syncFollowingsDelayMin", "syncFollowingsDelayMax",
      "syncFavoritesDelayMin", "syncFavoritesDelayMax",
      "syncCollectionDelayMin", "syncCollectionDelayMax",
      "cancelLikeDelayMin", "cancelLikeDelayMax",
      "cancelCollectionDelayMin", "cancelCollectionDelayMax",
      "syncBatchSize", "syncBatchPauseMin", "syncBatchPauseMax",
      "syncKeepaliveInterval", "syncRetryMax",
    ];
    const DELAY_PAIRS = [
      ["syncWorksDelayMin", "syncWorksDelayMax", "同步作品"],
      ["syncFollowingsDelayMin", "syncFollowingsDelayMax", "同步关注"],
      ["syncFavoritesDelayMin", "syncFavoritesDelayMax", "扫描点赞"],
      ["syncCollectionDelayMin", "syncCollectionDelayMax", "扫描收藏"],
      ["cancelLikeDelayMin", "cancelLikeDelayMax", "取消点赞"],
      ["cancelCollectionDelayMin", "cancelCollectionDelayMax", "取消收藏"],
    ];
    const values = {};
    for (const key of FIELDS) {
      const input = section.querySelector(`.config-input[data-key="${key}"]`);
      const raw = input?.value.trim();
      const num = Number(raw);
      if (!raw || !Number.isFinite(num) || num <= 0) {
        dialog.showToast(`"${key}" 请输入有效的正数`, "error");
        return false;
      }
      values[key] = num;
    }
    for (const [minKey, maxKey, label] of DELAY_PAIRS) {
      if (values[minKey] > values[maxKey]) {
        dialog.showToast(`${label}延迟最小值不能大于最大值`, "error");
        return false;
      }
    }
    values.calibrateFollowings = this._pendingCalibrate ?? (section.querySelector("#settingsCalibrateSwitch .mode-btn.active")?.dataset.mode === "on");
    if (values.syncBatchPauseMin > values.syncBatchPauseMax) {
      dialog.showToast("批次暂停最小值不能大于最大值", "error");
      return false;
    }
    try {
      await runtimeConfig.save(values);
      const secUidInput = this._dialogBody.querySelector("#settingsSecUid");
      await chrome.storage.local.set({ secUid: secUidInput?.value.trim() || "" });
    } catch {
      dialog.showToast("保存失败", "error");
    }
    // 独立模式：与运行参数同走关闭通道；与存储值有变化才下发 SET_MODE（写存储+background 运行态+a-bogus 初始化）
    const modeOn = this._pendingIndependent ?? (section.querySelector("#settingsModeSwitch .mode-btn.active")?.dataset.mode === "on");
    const { independentMode: savedOn } = await chrome.storage.local.get("independentMode");
    if (modeOn !== (savedOn === true)) {
      try {
        await services.bgMsg({ type: "SET_MODE", enabled: modeOn });
        this._pendingIndependent = null;
      } catch {
        dialog.showToast("独立模式切换失败", "error");
        return false;
      }
    }
    return true;
  }
}

const settings = new Settings();

// ---------- Favorites ----------
class Favorites {
  #activeCancel = null;

  onFavProgress(msg) {
    if (!state.favoriteFetching) return;
    const { collected, unfollowedCount } = msg;
    const statsEl = dom.dialogBody?.querySelector(".fav-stats");
    if (statsEl) {
      statsEl.textContent = `已扫描 ${collected} 个点赞作品，发现 ${unfollowedCount} 个未关注作者作品`;
    }
  }

  onCollectionProgress(msg) {
    if (!state.collectionFetching) return;
    const { collected, unfollowedCount } = msg;
    const statsEl = dom.dialogBody?.querySelector(".fav-stats");
    if (statsEl) {
      statsEl.textContent = `已扫描 ${collected} 个收藏作品，发现 ${unfollowedCount} 个未关注作者作品`;
    }
  }

  onCancelProgress(msg) {
    const ctx = this.#activeCancel;
    if (!ctx) return;
    if (msg.requestId !== ctx.requestId) return;
    if (!state[ctx.cfg.cancelingKey]) return;
    const { index, total } = msg;
    ctx.btn.textContent = `取消中... (${index + 1}/${total})`;
  }

  onCancelDone(msg) {
    const ctx = this.#activeCancel;
    if (!ctx || msg.requestId !== ctx.requestId) return;
    this.#activeCancel = null;

    const cfg = ctx.cfg;
    const cancelBtn = ctx.btn;
    if (!state[cfg.cancelingKey]) return;
    state[cfg.cancelingKey] = false;
    cancelBtn.classList.remove("dy-btn-loading");

    if (msg.cancelled) {
      cancelBtn.disabled = false;
      ctx.syncAddBtn?.();
      return;
    }

    const failedIds = new Set(msg.failedAwemeIds || []);

    if (msg.failed > 0 && msg.failed === msg.refreshed + msg.failed) {
      // all failed - likely auth issue
      dialog.showToast("取消失败: 可能是密钥已过期,请刷新抖音页面后重试", "error");
      cancelBtn.disabled = false;
      ctx.syncAddBtn?.();
      return;
    }

    const removedIds = new Set();
    state[cfg.stateKey].forEach((w) => {
      if (!failedIds.has(w.awemeId)) removedIds.add(w.awemeId);
    });
    state[cfg.stateKey] = state[cfg.stateKey].filter((w) => removedIds.has(w.awemeId));
    const remaining = state[cfg.stateKey].filter((w) => w.authorFollowed === false);
    this.#renderGrid("favGrid", state[cfg.stateKey], cfg.formatStats);
    dom.dialogTitle.textContent = `${cfg.title} (${remaining.length}/${state[cfg.stateKey].length})`;
    cancelBtn.textContent = cfg.cancelLabel;
    cancelBtn.disabled = remaining.length === 0;
    ctx.syncAddBtn?.();
    const successCount = msg.refreshed;
    dialog.showToast(
      msg.failed > 0
        ? `已取消 ${successCount} 个${cfg.cancelLabel},${msg.failed} 个失败`
        : `已取消 ${successCount} 个${cfg.cancelLabel}`,
      msg.failed > 0 ? "error" : "success",
    );
  }

  async openScanDialog(cfg) {
    if (state[cfg.fetchingKey]) return;
    state[cfg.fetchingKey] = true;

    let fetchArgs = cfg.buildFetchArgs();
    if (cfg.needSecUid) {
      const secUid = await services.findSecUid();
      if (!secUid) {
        dialog.showDialog("需要打开抖音用户页面", `<p>请先在浏览器中打开一个抖音用户页面，然后重试。</p>`, [
          { text: "好的", primary: true, callback: () => dialog.closeDialog() },
        ]);
        state[cfg.fetchingKey] = false;
        return;
      }
      fetchArgs.secUid = secUid;
    }

    const tmpl = document.getElementById("favDialogTemplate");
    const body = tmpl.content.cloneNode(true);
    dialog.showDialog(cfg.title, body, [], () => {
      // 重置状态标志(远端抓取由通用 dialog close handler 发 CANCEL_ACTIVE_TASK 信号杀灭)
      state[cfg.fetchingKey] = false;
      state[cfg.cancelingKey] = false;
      this.#activeCancel = null;
    });

    try {
      const res = await services.bgMsg(fetchArgs);
      if (!state[cfg.fetchingKey]) return;
      if (!res.ok) throw new Error(res.error || "FETCH_FAILED");

      state[cfg.stateKey] = res.works || [];

      const unfollowed = state[cfg.stateKey].filter((w) => w.authorFollowed === false);
      this.#renderGrid("favGrid", state[cfg.stateKey], cfg.formatStats);
      dom.dialogTitle.textContent = `${cfg.title} (${unfollowed.length}/${state[cfg.stateKey].length})`;

      if (res.timedOut) {
        const timeoutHint = document.createElement("p");
        timeoutHint.className = "dy-text-danger fav-timeout-hint";
        timeoutHint.textContent = "已超时退出，仅获取部分数据";
        dom.dialogBody.appendChild(timeoutHint);
      }

      // “添加”按钮：与取消按钮同批 targets（未关注作者的作品），经 SAVE_WORKS 批量入
      // 扩展作品库（mergeWork 去重合并，新记录落默认“未分类”分组）。已入账的 awemeId
      // 记入 addedIds，避免重复点击时重复计数。
      const addedIds = new Set();
      const pendingAdds = () =>
        state[cfg.stateKey].filter((w) => w.authorFollowed === false && !addedIds.has(w.awemeId));
      const addBtn = document.createElement("button");
      addBtn.className = "dy-btn flex-inline-center dy-btn-primary";
      const syncAddBtn = () => {
        const pending = pendingAdds();
        addBtn.textContent =
          pending.length > 0 ? `添加 (${pending.length})` : addedIds.size > 0 ? `已添加 (${addedIds.size})` : "添加";
        addBtn.disabled = pending.length === 0;
      };
      syncAddBtn();
      addBtn.addEventListener("click", async () => {
        const targets = pendingAdds();
        if (targets.length === 0) return;
        addBtn.disabled = true;
        addBtn.classList.add("dy-btn-loading");
        const res = await services.bgMsg({ type: "SAVE_WORKS", works: targets });
        addBtn.classList.remove("dy-btn-loading");
        if (!res || res.ok !== true) {
          syncAddBtn();
          const errHint =
            typeof res?.error === "string" && res.error.includes("AUTH_FAILED")
              ? "密钥已过期，请刷新抖音页面后重试"
              : "添加失败: " + (res?.error || "未知错误");
          dialog.showToast(errHint, "error");
          return;
        }
        for (const w of targets) addedIds.add(w.awemeId);
        syncAddBtn();
        dialog.showToast(`已添加 ${targets.length} 个作品（新增 ${res.added ?? 0} · 更新 ${res.updated ?? 0}）`, "success");
      });
      dom.dialogFooter.appendChild(addBtn);

      const cancelBtn = document.createElement("button");
      cancelBtn.className = "dy-btn flex-inline-center dy-btn-danger";
      cancelBtn.textContent = unfollowed.length > 0 ? `${cfg.cancelLabel} (${unfollowed.length})` : cfg.cancelLabel;
      cancelBtn.disabled = unfollowed.length === 0;
      cancelBtn.addEventListener("click", async () => {
        const targets = state[cfg.stateKey].filter((w) => w.authorFollowed === false);
        if (targets.length === 0) return;
        state[cfg.cancelingKey] = true;
        cancelBtn.disabled = true;
        addBtn.disabled = true;
        cancelBtn.classList.add("dy-btn-loading");
        const ids = targets.map((w) => w.awemeId);
        // 启动 cancel — bgMsg 立即返回 { ok: true, requestId, total }
        // 进度和完成由 CANCEL_PROGRESS / CANCEL_DONE 消息驱动
        const cancelRes = await services.bgMsg({ type: cfg.cancelType, awemeIds: ids });
        if (cancelRes && cancelRes.ok === false) {
          state[cfg.cancelingKey] = false;
          cancelBtn.classList.remove("dy-btn-loading");
          cancelBtn.disabled = false;
          syncAddBtn();
          const errHint = cancelRes.error?.includes("AUTH_FAILED")
            ? "密钥已过期，请刷新抖音页面后重试"
            : "取消失败: " + (cancelRes.error || "未知错误");
          dialog.showToast(errHint, "error");
          return;
        }
        // 记录活动 cancel 上下文,供 onCancelProgress / onCancelDone 使用
        this.#activeCancel = { btn: cancelBtn, cfg, requestId: cancelRes.requestId, syncAddBtn };
        cancelBtn.textContent = `取消中... (0/${ids.length})`;
      });
      dom.dialogFooter.appendChild(cancelBtn);
    } catch (err) {
      const msg = err.message || String(err);
      if (msg.includes("NO_SIGNATURE")) {
        dialog.showNoSignatureDialog(cfg.noSignatureUrl, cfg.noSignatureStep, cfg.noSignatureScan);
        state[cfg.fetchingKey] = false;
        return;
      }
      if (msg.includes("NEED_TAB")) {
        dialog.showDialog("需要打开抖音页面", `<p>请在浏览器中先打开一个抖音页面，然后重试。</p>`, [
          { text: "好的", primary: true, callback: () => dialog.closeDialog() },
        ]);
        state[cfg.fetchingKey] = false;
        return;
      }
      dialog.showFetchErrorDialog(msg);
    }

    state[cfg.fetchingKey] = false;
  }

  #renderGrid(gridId, works, formatStats) {
    const grid = dom.dialogBody.querySelector("#" + gridId);
    if (!grid) return;
    grid.innerHTML = "";

    const unfollowed = works.filter((w) => w.authorFollowed === false);
    const statsEl = dom.dialogBody.querySelector(".fav-stats");
    if (statsEl) {
      statsEl.textContent = formatStats
        ? formatStats(works.length, unfollowed.length)
        : `${works.length} 件 · 未关注 ${unfollowed.length} 件`;
    }

    if (unfollowed.length === 0) {
      grid.innerHTML = "";
      return;
    }

    for (const w of unfollowed) {
      const item = document.getElementById("favWorkTemplate").content.cloneNode(true).firstElementChild;
      const thumb = item.querySelector(".fav-work-thumb");
      // div+background-image：失败浏览器不绘制裂图图标，直接露出条目底色
      const coverUrl = w.cover || "";
      if (coverUrl) thumb.style.backgroundImage = `url("${coverUrl.replace(/["\\]/g, "\\$&")}")`;

      item.addEventListener("click", () => {
        if (w.awemeId) window.open(`${config.URL_BASE}/video/${w.awemeId}`, "_blank");
      });

      grid.appendChild(item);
    }
  }
}

const favorites = new Favorites();



// ---------- WorksGrid ----------
class WorksGrid extends VirtualGrid {
  #sliderRaf = 0;
  #container = dom.mainContainer;
  #workCardTmpl = document.getElementById("workCardTemplate");
  #coverQueue = [];
  #coverDrainRafId = 0;
  #videoStates = new WeakMap();
  #currentMediaCard = null;
  constructor() {
    super({
      container: dom.mainContainer,
      itemClass: "work-card",
      skeletonClass: "work-skeleton",
      itemKey: "awemeId",
      emptyMsg: "还没有保存的作品",
      emptyHint: "浏览抖音时，作品会自动被捕获",
    });
    this.#bindMediaEvents();
  }

  renderCards() {
    // 渲染取过滤后的视图列表（建议5）；筛选生效时空态文案区分"无数据"与"无匹配"
    const view = search.getWorksView();
    if (search.isFilterActive()) {
      this.render(view, "没有符合筛选条件的作品", "调整关键词或筛选条件后重试");
    } else {
      this.render(view, "还没有保存的作品", "浏览抖音时，作品会自动被捕获");
    }
  }

  // 原地填充：骨架根节点保留，媒体区/操作按钮从完整模板取新节点移入
  fillCard(card, work) {
    const fresh = this.#workCardTmpl.content.cloneNode(true).firstElementChild;
    card.classList.remove(this.skeletonClass);
    card.dataset.awemeId = work.awemeId;

    const media = card.querySelector(".work-media");
    media.replaceChildren(...fresh.querySelector(".work-media").childNodes);

    const title = card.querySelector(".work-title");
    title.querySelectorAll(".work-action-btn").forEach((btn) => btn.remove());
    title.append(...fresh.querySelectorAll(".work-action-btn"));

    const badge = card.querySelector(".work-type-badge");
    const thumb = card.querySelector(".work-thumb");
    const video = card.querySelector(".work-video-player");
    const controls = card.querySelector(".work-video-controls");
    const checkbox = card.querySelector(".work-checkbox");
    const titleText = card.querySelector(".work-title-text");

    badge.classList.toggle("hidden", work.type === "video");
    if (work.type === "note") {
      video.style.display = "none";
      controls.style.display = "none";
    }

    batch.updateCheckboxDOM(checkbox, state.selectedIds.has(work.awemeId));
    checkbox.style.display = state.batchMode ? "" : "none";

    if (work.type === "video" && utils.getVideoUrl(work)) {
      const videoSrc = utils.getVideoUrl(work);
      card.dataset.videoUrl = videoSrc;
      const coverUrl = utils.pickHttpsUrl(work.cover || "");
      this.#stageThumb(thumb);
      if (coverUrl) this.#enqueueCover(thumb, coverUrl);

      this.#videoStates.set(video, {
        progress: controls.querySelector(".video-progress"),
        timeSpan: controls.querySelector(".video-time"),
        muteBtn: controls.querySelector(".video-mute-btn"),
        playBtn: controls.querySelector(".video-play-btn"),
        controls: controls,
      });
    } else if (work.type === "note") {
      const imgUrl = utils.pickHttpsUrl(work.images?.[0] || work.cover || "");
      this.#stageThumb(thumb);
      if (imgUrl) this.#enqueueCover(thumb, imgUrl);
    }

    titleText.textContent = work.desc || "无文案";
  }

  // 停止某张卡的悬停预览并复位 UI。卡片任何摘除/降级路径必须先走这里：
  // 元素脱 DOM 后 pointerout 等边界事件永不触发、浏览器也不会自动暂停，
  // 游离的播放中 video 会"画面消失但音频继续"
  #stopPreview(video) {
    const st = this.#videoStates.get(video);
    if (!st) return;
    const card = video.closest(".work-card");
    clearTimeout(st.hoverTimer);
    clearTimeout(video._retryTimer);
    clearTimeout(video._hoverTimeout);
    delete video.dataset.hovered;
    video.pause();
    video.classList.remove("video-ready");
    st.controls.classList.remove("video-ready");
    const thumb = card?.querySelector(".work-thumb");
    if (thumb) thumb.classList.remove("video-hidden");
    if (card && this.#currentMediaCard === card) this.#currentMediaCard = null;
  }

  stopAllMedia() {
    for (const video of this.#container.querySelectorAll(".work-video-player")) {
      this.#stopPreview(video);
    }
    this.#currentMediaCard = null;
  }

  // 原地还原骨架：清空媒体区与标题，根节点与 .work-media/.work-title 容器保留
  clearCard(card) {
    // #demote 等摘除媒体子树的路径经此统一停掉预览，防止游离视频残留音频
    const previewVideo = card.querySelector(".work-video-player");
    if (previewVideo) this.#stopPreview(previewVideo);
    card.querySelector(".work-media")?.replaceChildren();
    card.querySelectorAll(".work-action-btn").forEach((btn) => btn.remove());
    const titleText = card.querySelector(".work-title-text");
    if (titleText) titleText.textContent = "";
    delete card.dataset.videoUrl;
    const checkbox = card.querySelector(".work-checkbox");
    if (checkbox) {
      batch.updateCheckboxDOM(checkbox, false);
      checkbox.style.display = state.batchMode ? "" : "none";
    }
  }

  updateCardDOM(awemeId) {
    const card = dom.mainContainer.querySelector(`[data-aweme-id="${awemeId}"]`);
    if (!card) return;
    const work = state.works.find((w) => w.awemeId === awemeId);
    if (!work) return;
    if (card.classList.contains("work-skeleton")) {
      this.populateItem(card, work);
      return;
    }
    const videoUrl = utils.getVideoUrl(work);
    if (videoUrl) card.dataset.videoUrl = videoUrl;
    const thumb = card.querySelector(".work-thumb");
    const coverUrl = work.cover ? utils.pickHttpsUrl(work.cover) : "";
    if (thumb && coverUrl) this.#enqueueCover(thumb, coverUrl);
    const title = card.querySelector(".work-title-text");
    if (title) title.textContent = work.desc || "无文案";
  }

  handleClick(event, work, el) {
    if (event.target.closest(".work-checkbox")) {
      event.stopPropagation();
      batch.toggleBatchSelect(work.awemeId, event.target.closest(".work-checkbox"));
      return;
    }
    if (event.target.closest(".video-mute-btn")) {
      event.stopPropagation();
      const video = el.querySelector(".work-video-player");
      if (video) detail.toggleVideoMute(video, el.querySelector(".video-mute-btn"));
      return;
    }
    if (event.target.closest(".video-play-btn")) {
      event.stopPropagation();
      const video = el.querySelector(".work-video-player");
      if (video) detail.toggleVideoPlay(video, el.querySelector(".video-play-btn"));
      return;
    }
    if (event.target.closest('.work-action-btn[title="同步"]')) {
      event.stopPropagation();
      const btn = event.target.closest(".work-action-btn");
      this.#handleWorkSync(btn, work.awemeId);
      return;
    }
    if (event.target.closest('.work-action-btn[title="下载"]')) {
      detail.downloadWork(work);
      return;
    }
    if (state.batchMode) {
      batch.toggleBatchSelect(work.awemeId, el.querySelector(".work-checkbox"));
      return;
    }
    detail.openDetail(work.awemeId);
  }

  async #handleWorkSync(btn, awemeId) {
    btn.disabled = true;
    btn.classList.add("work-syncing");
    try {
      const newWork = await services.refreshSingleWork(awemeId);
      if (newWork) {
        store.updateWork(awemeId, newWork);
      }
    } catch {}
    btn.classList.remove("work-syncing");
    btn.disabled = false;
  }

  restoreGridScroll() {
    const idx = detail.getDetailIndex();
    const view = search.getWorksView();
    if (idx < 0 || idx >= view.length) return;
    requestAnimationFrame(() => {
      const grid = dom.mainGrid;
      if (!grid) return;
      const root = getComputedStyle(document.documentElement);
      const cardW = parseInt(root.getPropertyValue("--dy-card-size")) || config.CARD_SIZE_FALLBACK;
      const gap = config.CARD_GAP;
      const cols = Math.max(1, Math.floor((grid.clientWidth + gap) / (cardW + gap)));
      const row = Math.floor(idx / cols);
      const cardH = (cardW * 4) / 3 + config.CARD_HEIGHT_OFFSET;
      const target = row * (cardH + gap) - Math.min(window.innerHeight / 3, row * (cardH + gap));
      window.scrollTo({ top: Math.max(0, target) });
    });
  }

  #bindMediaEvents() {
    // pointerenter/leave 不冒泡、无法做容器级委托；用冒泡的 pointerover/out，
    // relatedTarget 仍在同一 .work-media 内部时忽略，实现"跨界只触发一次"
    this.#container.addEventListener("pointerover", (e) => {
      const media = e.target.closest?.(".work-media");
      if (!media) return;
      if (e.relatedTarget && media.contains(e.relatedTarget)) return;
      const card = media.closest(".work-card");
      if (!card) return;
      if (this.#currentMediaCard === card) return;
      // 先停上一张卡的预览再判模式/弹窗守卫：批量模式、弹窗打开、熔断期间换卡
      // 也必须静音旧视频，否则旧预览只能依赖本委托链清理，漏掉即音频残留
      if (this.#currentMediaCard) {
        const prevVideo = this.#currentMediaCard.querySelector(".work-video-player");
        if (prevVideo) this.#stopPreview(prevVideo);
      }
      if (state.batchMode) return;
      if (!dom.dialogOverlay.classList.contains("hidden")) return;
      if (detail.mediaRetryBlocked()) return;
      const video = card.querySelector(".work-video-player");
      if (!video || !this.#videoStates.has(video)) return;
      const st = this.#videoStates.get(video);
      this.#currentMediaCard = card;
      if (st.hoverTimer) clearTimeout(st.hoverTimer);
      st.hoverTimer = setTimeout(() => {
        // 兜底：悬停延迟窗口内卡片被重建/摘除时，不得在游离节点上起播
        if (!card.isConnected || !video.isConnected) return;
        delete video.dataset.retries;
        video.dataset.hovered = "1";
        video.src = card.dataset.videoUrl || "";
        video.currentTime = 0;
        video.muted = false;
        st.muteBtn.innerHTML = config.icons.unmute;
        video.load();
        const onCanPlay = () => {
          if (!video.dataset.hovered) return;
          detail.markMediaOk();
          video.classList.add("video-ready");
          st.controls.classList.add("video-ready");
          const thumb = card.querySelector(".work-thumb");
          if (thumb) thumb.classList.add("video-hidden");
          video.play().catch(() => {
            st.timeSpan.textContent = "⚠ 无法播放";
          });
        };
        video.addEventListener("canplay", onCanPlay, { once: true });
        video._hoverTimeout = setTimeout(() => {
          video.removeEventListener("canplay", onCanPlay);
        }, config.VIDEO_FALLBACK_TIMEOUT);
      }, config.HOVER_PREVIEW_DELAY);
    });

    this.#container.addEventListener("pointerout", (e) => {
      const media = e.target.closest?.(".work-media");
      if (!media) return;
      if (e.relatedTarget && media.contains(e.relatedTarget)) return;
      const card = media.closest(".work-card");
      if (!card) return;
      if (this.#currentMediaCard !== card) return;
      const video = card.querySelector(".work-video-player");
      if (video) this.#stopPreview(video);
    });
    this.#container.addEventListener("timeupdate", (e) => {
      const video = e.target;
      if (!video.matches || !video.matches(".work-video-player")) return;
      if (video._lastProgressUpdate && Date.now() - video._lastProgressUpdate < 250) return;
      video._lastProgressUpdate = Date.now();
      if (!this.#videoStates.has(video)) return;
      const st = this.#videoStates.get(video);
      detail.updateVideoProgress(video, st.progress, st.timeSpan, "0.3");
    });
    this.#container.addEventListener("loadedmetadata", (e) => {
      const video = e.target;
      if (!video.matches || !video.matches(".work-video-player")) return;
      if (!this.#videoStates.has(video)) return;
      const st = this.#videoStates.get(video);
      st.timeSpan.textContent = `0:00 / ${detail.formatTime(video.duration)}`;
    });
    this.#container.addEventListener("error", (e) => {
      const video = e.target;
      if (!video.matches || !video.matches(".work-video-player")) return;
      if (!this.#videoStates.has(video)) return;
      const st = this.#videoStates.get(video);
      detail.handleVideoError(video, {
        onMax: () => { st.timeSpan.textContent = "⚠ 链接失效"; },
        onRetry: (retries, delay) => {
          st.timeSpan.textContent = delay > 0 ? `⏳ 重试(${retries + 1})…` : "⏳ 重试…";
        },
      });
    });
    this.#container.addEventListener("input", (e) => {
      const slider = e.target;
      if (!slider.matches || !slider.matches(".video-progress")) return;
      const card = slider.closest(".work-card");
      if (!card) return;
      const video = card.querySelector(".work-video-player");
      if (this.#sliderRaf) cancelAnimationFrame(this.#sliderRaf);
      this.#sliderRaf = requestAnimationFrame(() => {
        if (video && video.duration) video.currentTime = (slider.value / 100) * video.duration;
      });
    });
    this.#container.addEventListener("play", (e) => {
      const video = e.target;
      if (!video.matches || !video.matches(".work-video-player")) return;
      if (!this.#videoStates.has(video)) return;
      clearTimeout(video._retryTimer);
      this.#videoStates.get(video).playBtn.innerHTML = config.icons.pause;
    });
    this.#container.addEventListener("pause", (e) => {
      const video = e.target;
      if (!video.matches || !video.matches(".work-video-player")) return;
      if (!this.#videoStates.has(video)) return;
      this.#videoStates.get(video).playBtn.innerHTML = config.icons.play;
    });
  }

  // 封面代际自增：updateCardDOM 会复用同一节点再次入队，作废在途探针的乱序回填
  #enqueueCover(img, url) {
    const gen = String((Number(img.dataset.coverGen) || 0) + 1);
    img.dataset.coverGen = gen;
    this.#coverQueue.push({ img, url, gen });
    this.#scheduleCoverDrain();
  }

  // 探针预载：成功才提交背景图（div 无裂图载体）；失败原样重试一次，仍失败停留透明占位态
  #scheduleCoverDrain() {
    if (this.#coverDrainRafId) return;
    this.#coverDrainRafId = requestAnimationFrame(() => {
      this.#coverDrainRafId = 0;
      let n = 0;
      while (this.#coverQueue.length && n < config.SIDEBAR_IMG_PER_FRAME) {
        const { img, url, gen } = this.#coverQueue.shift();
        const alive = () => img.isConnected && img.dataset.coverGen === gen;
        const commit = () => {
          if (!alive()) return;
          detail.markMediaOk();
          img.style.backgroundImage = `url("${url.replace(/["\\]/g, "\\$&")}")`;
          img.classList.remove("media-loading");
        };
        const fail = () => {
          if (!alive()) return;
          detail.markMediaFail();
          // dataset.retry 挂在可见节点上，随重填换新节点自然复位；熔断冷却中不重试
          if (img.dataset.retry || detail.mediaRetryBlocked()) return;
          img.dataset.retry = "1";
          const retryProbe = new Image();
          retryProbe.onload = commit;
          retryProbe.onerror = fail;
          retryProbe.src = url;
        };
        const probe = new Image();
        probe.onload = commit;
        probe.onerror = fail;
        probe.src = url;
        n++;
      }
      if (this.#coverQueue.length) this.#scheduleCoverDrain();
    });
  }

  // 赋 src 前置三态：thumb 先透明，露出 .work-media 渐变占位底
  #stageThumb(thumb) {
    thumb.classList.add("media-loading");
  }
}

const worksGrid = new WorksGrid();
// ---------- Detail ----------
class Detail {
  #index = -1;
  #cleanups = [];
  #loopMode = "single";
  #detailListenersAttached = false;
  #noteWork = null;
  #noteImgIndex = 0;
  #noteAutoPlayTimer = null;
  #detailSliderRaf = 0;
  #noteIsPlaying = false;
  #mediaFailCount = 0;
  #mediaLastFailAt = 0;
  #mediaBreakUntil = 0;
  #imgProbeToken = 0;
  #bgProbeToken = 0;
  #lastGoodBg = null;
  #noteShowImage(idx) {
    this.#noteImgIndex = idx;
    const img = dom.detailImage;
    // 淡出当前图片
    img.style.opacity = '0';
    requestAnimationFrame(() => {
      const url = utils.pickHttpsUrl(this.#noteWork.images[this.#noteImgIndex])
        || utils.pickHttpsUrl(this.#noteWork.cover)
        || "";
      // 探针先行：失败 URL 不落可见节点（裂图无载体），失败时恢复显示上一张
      const token = ++this.#imgProbeToken;
      if (!url) {
        img.style.opacity = '1';
        return;
      }
      const probe = new Image();
      probe.onload = () => {
        if (token !== this.#imgProbeToken) return;
        this.markMediaOk();
        img.addEventListener('load', () => { img.style.opacity = '1'; }, { once: true });
        img.src = url;
      };
      probe.onerror = () => {
        if (token !== this.#imgProbeToken) return;
        this.markMediaFail();
        img.style.opacity = '1';
      };
      probe.src = url;
    });
    this.#updateCounters(this.#noteWork);
  }
  #noteStartAutoPlay() {
    const AUTO_PLAY_INTERVAL = config.NOTE_AUTO_PLAY_INTERVAL;
    this.#noteStopAutoPlay();
    const tick = () => {
      this.#noteAutoPlayTimer = setTimeout(() => {
        if (this.#noteImgIndex < this.#noteWork.images.length - 1) {
          this.#noteShowImage(this.#noteImgIndex + 1);
          tick();
        } else {
          const mode = this.nextOnEnd();
          if (mode === "single") {
            this.#noteShowImage(0);
            tick();
          } else if (mode === "group") {
            this.renderDetail();
          } else {
            this.#noteIsPlaying = false;
            this.#noteUpdatePlayBtn();
          }
        }
      }, AUTO_PLAY_INTERVAL);
    };
    tick();
  }
  #noteStopAutoPlay() {
    if (this.#noteAutoPlayTimer) {
      clearTimeout(this.#noteAutoPlayTimer);
      this.#noteAutoPlayTimer = null;
    }
  }
  #noteUpdatePlayBtn() {
    if (this.#noteIsPlaying) {
      dom.detailPlayBtn.innerHTML = config.icons.pause;
      const label = "暂停轮播";
      dom.detailPlayBtn.title = label;
      dom.detailPlayBtn.setAttribute("aria-label", label);
    } else {
      dom.detailPlayBtn.innerHTML = config.icons.play;
      const label = "自动播放";
      dom.detailPlayBtn.title = label;
      dom.detailPlayBtn.setAttribute("aria-label", label);
    }
  }
  #toggleNoteAutoPlay() {
    const audio = dom.detailAudio;
    if (this.#noteIsPlaying) {
      this.#noteStopAutoPlay();
      audio?.pause();
      this.#noteIsPlaying = false;
    } else {
      this.#noteStartAutoPlay();
      audio?.play().catch(() => {});
      this.#noteIsPlaying = true;
    }
    this.#noteUpdatePlayBtn();
  }

  #toggleNoteMute() {
    const audio = dom.detailAudio;
    if (!audio) return;
    audio.muted = !audio.muted;
    dom.detailMuteBtn.innerHTML = audio.muted ? config.icons.mute : config.icons.unmute;
    const label = audio.muted ? "取消静音" : "静音";
    dom.detailMuteBtn.title = label;
    dom.detailMuteBtn.setAttribute("aria-label", label);
  }

  static MIME_EXT = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
  };

  // Detail 导航与网格共用同一过滤视图（建议5）：详情内翻页只在可见条目间进行
  openDetailIndex(awemeId) {
    const list = search.getWorksView();
    const idx = list.findIndex((w) => w.awemeId === awemeId);
    if (idx === -1) return null;
    this.#index = idx;
    return list[idx];
  }

  getCurrentWork() {
    return search.getWorksView()[this.#index] || null;
  }

  closeDetailIndex() {
    this.runCleanups();
    this.#index = -1;
  }

  nextDetailIndex() {
    if (this.#index < search.getWorksView().length - 1) {
      this.#index++;
      return this.getCurrentWork();
    }
    return null;
  }

  prevDetailIndex() {
    if (this.#index > 0) {
      this.#index--;
      return this.getCurrentWork();
    }
    return null;
  }

  getDetailIndex() {
    return this.#index;
  }

  addCleanup(fn) {
    this.#cleanups.push(fn);
  }

  runCleanups() {
    for (const fn of this.#cleanups.splice(0)) {
      try {
        fn();
      } catch (e) {}
    }
  }

  cycleLoopMode() {
    if (this.#loopMode === "single") {
      this.#loopMode = "group";
    } else if (this.#loopMode === "group") {
      this.#loopMode = "off";
    } else {
      this.#loopMode = "single";
    }
    return this.#loopMode;
  }

  nextOnEnd() {
    if (this.#loopMode === "single") return "single";
    const total = search.getWorksView().length;
    if (this.#loopMode === "group" && total > 1) {
      if (this.#index < total - 1) {
        this.#index++;
      } else {
        this.#index = 0;
      }
      return "group";
    }
    return "off";
  }

  async removeWork(awemeId) {
    await services.bgMsg({ type: "DELETE_WORKS", awemeIds: [awemeId] });
    state.selectedIds.delete(awemeId);
    const idx = state.works.findIndex((w) => w.awemeId === awemeId);
    store.spliceWork(idx);
  }

  async syncWork(awemeId) {
    return services.refreshSingleWork(awemeId);
  }

  updateLoopBtn(isVideo) {
    if (this.#loopMode === "single") {
      dom.detailLoopBtn.innerHTML = config.icons.loopSingle;
      dom.detailLoopBtn.title = isVideo ? "单作品循环" : "幻灯片循环";
    } else if (this.#loopMode === "group") {
      dom.detailLoopBtn.innerHTML = config.icons.loopGroup;
      dom.detailLoopBtn.title = "分组循环";
    } else {
      dom.detailLoopBtn.innerHTML = config.icons.noLoop;
      dom.detailLoopBtn.title = "不循环";
    }
    dom.detailLoopBtn.setAttribute("aria-label", dom.detailLoopBtn.title);
  }

  // ===== 详情层 UI 增强（docs/UI_IMPROVEMENTS.md 建议10-21）=====

  // 计数展示（建议12 修订版）：图集页数保留右上徽章，作品序号回归底栏最右端
  #updateCounters(work) {
    const total = search.getWorksView().length;
    // 右上：仅多图图集显示页数
    const isMultiNote = work.type === "note" && work.images?.length > 1;
    dom.detailImgCounter.textContent = isMultiNote ? `${this.#noteImgIndex + 1}/${work.images.length}` : "";
    dom.detailImgCounter.classList.toggle("hidden", !isMultiNote);
    // 底栏右侧：作品序号
    if (total > 1) {
      dom.detailCounter.textContent = `${this.getDetailIndex() + 1} / ${total}`;
      dom.detailCounter.classList.remove("hidden");
    } else {
      dom.detailCounter.classList.add("hidden");
    }
  }

  // 加载指示复位（建议17）
  #resetMediaStatus(isVideo) {
    dom.detailLoader.classList.toggle("hidden", !isVideo);
  }

  // 背景虚化的健壮提交：候选 URL 逐个探针，成功才写入 --bg-url（带引号转义）；
  // 全部失效时回退到上一张成功背景（#lastGoodBg），首次打开无历史则落到深色底。
  // 直接给 CSS 背景塞失效链接会静默变成纯黑——note 类型"虚化丢失"的根源即此。
  #applyDetailBg(candidates) {
    const urls = [...new Set(candidates.map((u) => utils.pickHttpsUrl(u || "")).filter(Boolean))];
    if (!urls.length) return;
    const token = ++this.#bgProbeToken;
    const commit = (u) => {
      const escaped = u.replace(/["\\]/g, "\\$&");
      const newUrl = `url("${escaped}")`;
      if (dom.detailOverlay.style.getPropertyValue("--bg-url") !== newUrl) {
        dom.detailOverlay.style.setProperty("--bg-url", newUrl);
      }
    };
    const tryNext = (i) => {
      if (token !== this.#bgProbeToken) return;
      if (i >= urls.length) {
        if (this.#lastGoodBg) commit(this.#lastGoodBg);
        return;
      }
      const probe = new Image();
      probe.onload = () => {
        if (token !== this.#bgProbeToken) return;
        this.markMediaOk();
        this.#lastGoodBg = urls[i];
        commit(urls[i]);
      };
      probe.onerror = () => {
        if (token !== this.#bgProbeToken) return;
        tryNext(i + 1);
      };
      probe.src = urls[i];
    };
    tryNext(0);
  }

  // Tab 焦点圈定（建议21）：焦点在 overlay 内循环。
  // 可见性用 rects 判断而非 offsetParent——fixed 定位元素（如右上关闭钮）的 offsetParent 恒为 null
  #trapFocus(e) {
    const focusables = [...dom.detailOverlay.querySelectorAll("button, input, a[href]")]
      .filter((el) => el.getClientRects().length > 0);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    const inside = dom.detailOverlay.contains(active);
    if (e.shiftKey && (!inside || active === first)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (!inside || active === last)) {
      e.preventDefault();
      first.focus();
    }
  }

  async openDetail(awemeId) {
    const work = this.openDetailIndex(awemeId);
    if (!work) return;
    dom.detailOverlay.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    this.renderDetail();
  }

  // dir: 1 下一作品 / -1 上一作品 / 0 无方向（首次打开或循环回跳），驱动建议15的方向感过渡
  renderDetail(dir = 0) {
    const isSwitch = !dom.detailOverlay.classList.contains("hidden");
    const body = dom.detailBody || document.querySelector(".detail-body");
    if (isSwitch) {
      body.classList.add("detail-transitioning");
    }
    // 方向感入场（建议15）：先清旧类再强制 reflow，保证同向连续切换也能重放动画
    body.classList.remove("enter-down", "enter-up");
    if (dir > 0) {
      void body.offsetWidth;
      body.classList.add("enter-down");
    } else if (dir < 0) {
      void body.offsetWidth;
      body.classList.add("enter-up");
    }
    this.#transitionToNext(body, isSwitch);
  }

  #transitionToNext(body, isSwitch) {
    // 等待淡出完成
    const doRender = () => {
      this.runCleanups();
      const work = this.getCurrentWork();
      if (!work) return this.closeDetail();

      const isVideo = work.type === "video" && utils.getVideoUrl(work);
      if (isVideo) {
        this.resetAudio();
      } else {
        this.resetMediaElements();
      }

      const bgUrl = work.cover || work.images?.[0] || "";
      if (bgUrl) {
        // 候选链探测：封面优先、图集各帧兜底；全部失效时保留上一张成功背景（见 #applyDetailBg）
        this.#applyDetailBg([work.cover, ...(work.images || [])]);
      }

      const isNote = work.type === "note" && work.images?.length > 0;

      dom.detailPlayBtn.style.display = "";
      dom.detailMuteBtn.style.display = "";

      dom.detailVideoContainer.classList.toggle("hidden", !isVideo);
      dom.detailImageContainer.classList.toggle("hidden", !isNote && (isVideo || !work.cover));
      dom.detailProgressSlider.classList.toggle("hidden", !isVideo);

      // 导航箭头已上移至 .detail-body 直下（不随媒体容器切换动效），可见性须在此显式管理：
      // 仅多图图集出现，视频/单图路径不再依赖容器 hidden 连带隐藏
      const hasNoteNav = isNote && work.images.length > 1;
      dom.detailNavLeft.classList.toggle("hidden", !hasNoteNav);
      dom.detailNavRight.classList.toggle("hidden", !hasNoteNav);

      if (isVideo) {
        dom.detailTime.textContent = "0:00 / 0:00";
      } else {
        // 图集/纯图计数统一走右上徽章（建议12），时间位不再复用
        dom.detailTime.textContent = "";
      }

      if (work.authorHomeUrl) {
        dom.detailAuthor.textContent = `@${work.nickname || "未知作者"}`;
        dom.detailAuthor.href = work.authorHomeUrl;
        dom.detailAuthor.title = "打开作者主页";
        dom.detailAuthor.classList.remove("hidden");
      } else {
        dom.detailAuthor.classList.add("hidden");
      }

      const typePath = work.type === "note" ? "note" : "video";
      dom.detailTitle.href = `${config.URL_BASE}/${typePath}/${work.awemeId}`;
      dom.detailTitle.textContent = (work.desc || "无作品描述").slice(0, config.DETAIL_TITLE_MAX_LEN);
      dom.detailTitle.title = "在抖音打开作品页";

      this.updateLoopBtn(isVideo);

      this.#updateCounters(work);
      this.#resetMediaStatus(isVideo);

      const onReady = () => {
        body.classList.remove("detail-transitioning");
      };

      if (isVideo) {
        this.renderDetailVideo(work, onReady);
      } else if (isNote) {
        this.renderDetailNote(work, onReady);
      } else if (work.cover) {
        dom.detailPlayBtn.style.display = "none";
        dom.detailMuteBtn.style.display = "none";
        // 探针先行：失败不落可见节点；onReady 在探针落定后触发，不再先于加载结束过渡
        const token = ++this.#imgProbeToken;
        const probe = new Image();
        probe.onload = () => {
          if (token !== this.#imgProbeToken) return;
          this.markMediaOk();
          dom.detailImage.src = work.cover;
          onReady();
        };
        probe.onerror = () => {
          if (token !== this.#imgProbeToken) return;
          this.markMediaFail();
          onReady();
        };
        probe.src = work.cover;
      } else {
        onReady();
      }

      // 安全兜底：10 秒后强制结束过渡（防止网络异常卡死）
      if (isSwitch) {
        setTimeout(() => {
          body.classList.remove("detail-transitioning");
        }, 10000);
      }
    };

    if (isSwitch) {
      requestAnimationFrame(() => {
        requestAnimationFrame(doRender);
      });
    } else {
      doRender();
    }
  }

  renderDetailVideo(work, onReady) {
    const video = dom.detailVideo;
    const readyFn = () => { if (onReady) onReady(); };
    video.src = utils.getVideoUrl(work);

    // 加载指示（建议17）：canplay 前亮 spinner
    dom.detailLoader.classList.remove("hidden");

    dom.detailMuteBtn.innerHTML = video.muted ? config.icons.mute : config.icons.unmute;

    // 视频可播放时结束过渡
    let readyFired = false;
    const fireReady = () => {
      if (readyFired) return;
      readyFired = true;
      readyFn();
    };
    // 仅在真实加载成功时复位熔断；error 路径也会调 fireReady，不能顺带 markMediaOk
    const fireLoaded = () => {
      this.markMediaOk();
      dom.detailLoader.classList.add("hidden");
      fireReady();
    };
    video.addEventListener("canplay", fireLoaded, { once: true });
    video.addEventListener("loadedmetadata", fireLoaded, { once: true });

    video.play().catch((err) => {
      if (err.name === "NotAllowedError") {
        video.muted = true;
        dom.detailMuteBtn.innerHTML = config.icons.mute;
        video.play().catch(() => {});
      }
      // 播放失败也算准备完成，避免卡死
      fireReady();
    });

    video.onerror = () => {
      fireReady();
      this.handleVideoError(video, {
        onMax: () => {
          dom.detailLoader.classList.add("hidden");
          dom.detailPlayBtn.innerHTML = config.icons.play;
          dom.detailPlayBtn.title = "链接失效";
          dom.detailPlayBtn.setAttribute("aria-label", "链接失效");
        },
        onRetry: (retries, delay) => {
          dom.detailPlayBtn.innerHTML = config.icons.play;
          dom.detailPlayBtn.title = delay > 0 ? `重试(${retries + 1})` : "重试";
        },
      });
    };
    this.addCleanup(() => clearTimeout(video._retryTimer));

    dom.detailPlayBtn.innerHTML = config.icons.pause;

    const slider = dom.detailProgressSlider;
    slider.value = 0;
    slider.style.background = "linear-gradient(to right, #fff 0%, rgba(255,255,255,0.2) 0%)";
  }

  renderDetailNote(work, onReady) {
    this.#noteWork = work;
    this.#noteImgIndex = 0;
    this.#noteAutoPlayTimer = null;
    this.#noteIsPlaying = false;
    const img = dom.detailImage;
    const audio = dom.detailAudio;

    const readyFn = () => { if (onReady) onReady(); };
    // 图片加载完成时结束过渡
    let readyFired = false;
    const fireReady = () => {
      if (readyFired) return;
      readyFired = true;
      readyFn();
    };
    img.alt = work.desc || "";
    // 探针先行：失败 URL 不落可见节点（裂图无载体）；成功后经缓存落 src，load 时结束过渡
    const firstUrl = work.images[0] || work.cover || "";
    const token = ++this.#imgProbeToken;
    if (!firstUrl) {
      fireReady();
    } else {
      const probe = new Image();
      probe.onload = () => {
        if (token !== this.#imgProbeToken) return;
        this.markMediaOk();
        img.addEventListener("load", fireReady, { once: true });
        img.addEventListener("error", fireReady, { once: true });
        img.src = firstUrl;
      };
      probe.onerror = () => {
        if (token !== this.#imgProbeToken) return;
        this.markMediaFail();
        fireReady();
      };
      probe.src = firstUrl;
    }

    // 图集/作品计数统一走计数展示逻辑（右上页数徽章 + 底栏作品序号）
    this.#updateCounters(work);

    if (work.music) {
      audio.src = utils.pickHttpsUrl(work.music);

      dom.detailMuteBtn.innerHTML = audio.muted ? config.icons.mute : config.icons.unmute;

      audio.play().catch((err) => {
        if (err.name === "NotAllowedError") {
          audio.muted = true;
          dom.detailMuteBtn.innerHTML = config.icons.mute;
          audio.play().catch(() => {});
        }
      });
    } else {
      dom.detailMuteBtn.style.display = "none";
    }

    this.#noteIsPlaying = true;
    this.#noteStartAutoPlay();
    this.#noteUpdatePlayBtn();

    this.addCleanup(() => this.#noteStopAutoPlay());
  }

  initDetailEvents() {
    if (this.#detailListenersAttached) return;
    this.#detailListenersAttached = true;

    dom.detailOverlay.addEventListener(
      "wheel",
      (e) => {
        if (e.deltaY > 0) this.nextDetail();
        else this.prevDetail();
      },
      { passive: true },
    );

    document.addEventListener("keydown", (e) => {
      if (dom.detailOverlay.classList.contains("hidden")) return;
      // Tab 焦点圈定（建议21）
      if (e.key === "Tab") {
        this.#trapFocus(e);
        return;
      }
      if (e.key === "Escape") {
        this.closeDetail();
        return;
      }
      const work = this.getCurrentWork();
      if (e.key === "ArrowUp") {
        e.preventDefault();
        this.prevDetail(-1);
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.nextDetail(1);
      }
      if (work?.type === "note" && work.images?.length > 1) {
        if (e.key === "ArrowLeft" && this.#noteImgIndex > 0) {
          e.preventDefault();
          this.#noteShowImage(this.#noteImgIndex - 1);
        }
        if (e.key === "ArrowRight" && this.#noteImgIndex < work.images.length - 1) {
          e.preventDefault();
          this.#noteShowImage(this.#noteImgIndex + 1);
        }
      }
    });

    dom.detailClose.addEventListener("click", () => this.closeDetail());

    // 底栏作者/标题为真实链接（新标签页打开），无需额外点击逻辑

    dom.detailRemoveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const work = this.getCurrentWork();
      if (!work) return;
      const removeBody = document.createElement("p");
      removeBody.className = "confirm-delete-msg";
      removeBody.textContent = `确定要移除"${(work.desc || "无作品描述").slice(0, config.DETAIL_TITLE_MAX_LEN)}"？`;
      dialog.showDialog("移除作品", removeBody, [
        { text: "取消", ghost: true, callback: () => dialog.closeDialog() },
        {
          text: "移除",
          danger: true,
          callback: async () => {
            dialog.updateDialog("正在移除…", utils.SPINNER_HTML);
            state.preventDialogClose = true;
            try {
              await this.removeWork(work.awemeId);
              if (search.getWorksView().length === 0) {
                this.closeDetail();
              } else {
                if (this.getDetailIndex() >= search.getWorksView().length) this.#index = search.getWorksView().length - 1;
                this.renderDetail();
              }
              store.refreshGroups();
              // 成功终态不再要求"好的"确认（建议2）
              dialog.closeDialog();
              dialog.showToast("已移除该作品", "success");
            } finally {
              state.preventDialogClose = false;
            }
          },
        },
      ]);
    });

    dom.detailLoopBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const work = this.getCurrentWork();
      this.cycleLoopMode();
      this.updateLoopBtn(work?.type === "video" && utils.getVideoUrl(work));
    });

    dom.detailSyncBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const work = this.getCurrentWork();
      if (!work) return;
      dom.detailSyncBtn.disabled = true;
      dom.detailSyncBtn.classList.add("work-syncing");
      try {
        const newWork = await this.syncWork(work.awemeId);
        if (newWork) {
          store.updateWork(work.awemeId, newWork);
        }
      } catch {}
      // 旋转态（建议20）：复用网格卡 .work-syncing 的图标自转样式
      dom.detailSyncBtn.classList.remove("work-syncing");
      dom.detailSyncBtn.disabled = false;
    });

    dom.detailDownloadBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const work = this.getCurrentWork();
      if (work) this.downloadWork(work);
    });

    dom.detailPlayBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const work = this.getCurrentWork();
      if (!work) return;
      if (work.type === "note" && work.images?.length > 0) {
        this.#toggleNoteAutoPlay();
      } else {
        this.toggleDetailVideoPlay();
      }
    });

    dom.detailMuteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const work = this.getCurrentWork();
      if (!work) return;
      if (work.type === "note" && work.music) {
        this.#toggleNoteMute();
      } else if (work.type === "video") {
        this.toggleDetailVideoMute();
      }
    });

    dom.detailVideoWrap.addEventListener("click", () => this.toggleDetailVideoPlay());

    const video = dom.detailVideo;
    video.addEventListener("play", () => clearTimeout(video._retryTimer));
    video.addEventListener("timeupdate", () => {
      if (video._lastProgressUpdate && Date.now() - video._lastProgressUpdate < 250) return;
      video._lastProgressUpdate = Date.now();
      this.updateVideoProgress(video, dom.detailProgressSlider, dom.detailTime, "0.2");
    });
    video.addEventListener("ended", () => {
      const mode = this.nextOnEnd();
      if (mode === "single") video.play();
      else if (mode === "group") this.renderDetail();
    });

    dom.detailProgressSlider.addEventListener("input", () => {
      cancelAnimationFrame(this.#detailSliderRaf);
      this.#detailSliderRaf = requestAnimationFrame(() => {
        if (video.duration) video.currentTime = (dom.detailProgressSlider.value / 100) * video.duration;
      });
    });

    dom.detailNavLeft.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.#noteImgIndex > 0) this.#noteShowImage(this.#noteImgIndex - 1);
    });

    dom.detailNavRight.addEventListener("click", (e) => {
      e.stopPropagation();
      const maxIndex = (this.#noteWork?.images.length || 1) - 1;
      if (this.#noteImgIndex < maxIndex) this.#noteShowImage(this.#noteImgIndex + 1);
    });

    const noteContainer = dom.detailImageContainer.querySelector(".detail-image-container");
    noteContainer.addEventListener("click", () => {
      this.#toggleNoteAutoPlay();
    });
  }

  // dir 透传给 renderDetail 驱动方向感过渡（建议15）
  nextDetail(dir = 1) {
    if (this.nextDetailIndex()) this.renderDetail(dir);
  }

  prevDetail(dir = -1) {
    if (this.prevDetailIndex()) this.renderDetail(dir);
  }

  closeDetail() {
    this.closeDetailIndex();
    this.resetMediaElements();
    // 复位增强态 UI：加载指示隐藏，下次打开从干净状态开始
    dom.detailLoader.classList.add("hidden");
    dom.detailProgressSlider.classList.add("hidden");
    // 导航箭头/计数徽章已不在媒体容器内，须随关闭显式隐藏
    dom.detailNavLeft.classList.add("hidden");
    dom.detailNavRight.classList.add("hidden");
    dom.detailImgCounter.classList.add("hidden");
    dom.detailVideoContainer.classList.add("hidden");
    dom.detailImageContainer.classList.add("hidden");
    dom.detailOverlay.style.removeProperty("--bg-url");
    dom.detailOverlay.classList.add("hidden");
    document.body.style.overflow = "";
    worksGrid.restoreGridScroll();
  }

  resetVideo() {
    dom.detailVideo.removeAttribute("src");
    dom.detailVideo.load();
  }

  resetAudio() {
    dom.detailAudio.pause();
    dom.detailAudio.removeAttribute("src");
    dom.detailAudio.load();
  }

  resetMediaElements() {
    this.resetVideo();
    this.resetAudio();
  }

  toggleVideoPlay(video, playBtn) {
    if (video.paused) {
      video.play().catch(() => {});
      playBtn.innerHTML = config.icons.pause;
    } else {
      video.pause();
      playBtn.innerHTML = config.icons.play;
    }
  }

  toggleVideoMute(video, muteBtn) {
    video.muted = !video.muted;
    muteBtn.innerHTML = video.muted ? config.icons.mute : config.icons.unmute;
  }

  updateVideoProgress(video, slider, timeSpan, opacity) {
    if (video.duration) {
      const pct = (video.currentTime / video.duration) * 100;
      // 缓冲段可视化（建议16）：已播放实白、缓冲半透明白、未缓冲底色
      let bufferedPct = pct;
      try {
        if (video.buffered.length) bufferedPct = (video.buffered.end(video.buffered.length - 1) / video.duration) * 100;
      } catch (_) {}
      slider.value = pct;
      slider.style.background = `linear-gradient(to right, #fff ${pct}%, rgba(255,255,255,0.45) ${pct}%, rgba(255,255,255,0.45) ${bufferedPct}%, rgba(255,255,255,${opacity}) ${bufferedPct}%)`;
      timeSpan.textContent = `${this.formatTime(video.currentTime)} / ${this.formatTime(video.duration)}`;
    }
  }

  // 媒体熔断：滑动窗口内失败计数，密集失败（网络异常）时进入冷却期，
  // 期间视频/封面跳过重试直接降级；任何媒体成功加载即复位。
  markMediaFail() {
    const now = Date.now();
    this.#mediaFailCount =
      now - this.#mediaLastFailAt > config.MEDIA_FAIL_WINDOW ? 1 : this.#mediaFailCount + 1;
    this.#mediaLastFailAt = now;
    if (this.#mediaFailCount >= config.MEDIA_FAIL_MAX) {
      this.#mediaBreakUntil = now + config.MEDIA_BREAK_COOLDOWN;
      this.#mediaFailCount = 0;
    }
  }

  markMediaOk() {
    this.#mediaFailCount = 0;
    this.#mediaBreakUntil = 0;
  }

  mediaRetryBlocked() {
    return Date.now() < this.#mediaBreakUntil;
  }

  handleVideoError(video, ui) {
    if (!video.src) return;
    this.markMediaFail();
    const retries = parseInt(video.dataset.retries || "0");
    if (retries >= config.VIDEO_RETRY_MAX || this.mediaRetryBlocked()) {
      ui.onMax(retries);
      return;
    }
    video.dataset.retries = String(retries + 1);
    const delay = config.VIDEO_RETRY_DELAYS[retries] ?? config.VIDEO_RETRY_FALLBACK_DELAY;
    ui.onRetry(retries, delay);
    clearTimeout(video._retryTimer);
    video._retryTimer = setTimeout(() => {
      if (!video.isConnected) return;
      video.load();
      video.play().catch(() => {});
    }, delay);
  }

  toggleDetailVideoPlay() {
    this.toggleVideoPlay(dom.detailVideo, dom.detailPlayBtn);
    const label = dom.detailVideo.paused ? "播放" : "暂停";
    dom.detailPlayBtn.title = label;
    dom.detailPlayBtn.setAttribute("aria-label", label);
  }

  toggleDetailVideoMute() {
    this.toggleVideoMute(dom.detailVideo, dom.detailMuteBtn);
    const label = dom.detailVideo.muted ? "取消静音" : "静音";
    dom.detailMuteBtn.title = label;
    dom.detailMuteBtn.setAttribute("aria-label", label);
  }

  formatTime(seconds) {
    if (!seconds || !isFinite(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  getFilename(work, ext) {
    const nick = (work.nickname || "unknown").replace(/[\\/:*?"<>|]/g, "_");
    return `${nick}_${work.awemeId}.${ext}`;
  }

  async fetchBlob(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const ext = Detail.MIME_EXT[blob.type] || "mp4";
    return { blob, ext };
  }

  triggerDownload(blob, filename) {
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), config.BLOB_REVOKE_DELAY);
  }

  async downloadWork(work) {
    await this.#downloadWithRetry(work, 0);
  }

  async #downloadWithRetry(w, attempt) {
    try {
      if (w.type === "video" && utils.getVideoUrl(w)) {
        const { blob, ext } = await this.fetchBlob(utils.getVideoUrl(w));
        this.triggerDownload(blob, this.getFilename(w, ext));
      } else if (w.type === "note" && w.images?.length) {
        for (const [i, img] of w.images.entries()) {
          const absUrl = utils.pickHttpsUrl(img || "");
          const { blob, ext } = await this.fetchBlob(absUrl);
          this.triggerDownload(blob, this.getFilename(w, `${i + 1}.${ext}`));
        }
      }
    } catch (err) {
      console.error("[DY] download failed:", err);
      if (attempt >= config.DOWNLOAD_MAX_RETRY) {
        dialog.showToast("下载失败: " + (err.message || "未知错误"), "error");
        return;
      }
      await new Promise((r) => setTimeout(r, config.FETCH_RETRY_DELAY));
      await this.#downloadWithRetry(w, attempt + 1);
    }
  }
}

const detail = new Detail();

// ---------- 消息监听 ----------
chrome.runtime.onMessage.addListener((message) => {
  if (!message || !message.type) return;
  switch (message.type) {
    case "SYNC_PROGRESS":
      sync.onSyncProgress(message);
      break;
    case "SYNC_DONE":
      sync.onSyncDone(message);
      break;
    case "FOLLOWING_PROGRESS":
      sync.onFollowingProgress(message);
      break;
    case "FAVORITES_PROGRESS":
      favorites.onFavProgress(message);
      break;
    case "COLLECTION_PROGRESS":
      favorites.onCollectionProgress(message);
      break;
    case "CANCEL_PROGRESS":
      favorites.onCancelProgress(message);
      break;
    case "CANCEL_DONE":
      favorites.onCancelDone(message);
      break;
  }
});

// ---------- 应用壳：域切换 / 全局错误态 / 弹窗关闭入口 ----------
class AppShell {
  constructor() {
    this.#bindEvents();
  }

  updateDomainSlider(domain) {
    const btn = document.querySelector(`.ds-btn[data-domain="${domain}"]`);
    if (!btn || !dom.dsSlider || !dom.domainSwitch) return;
    const parentRect = dom.domainSwitch.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const left = btnRect.left - parentRect.left;
    const width = btnRect.width;
    dom.dsSlider.style.transform = `translateX(${left}px)`;
    dom.dsSlider.style.width = `${width}px`;
  }

  switchDomain(domain) {
    if (domain === state.domain) return;

    // 先中止两个网格未完成的分块渲染，防止旧域骨架卡在下一帧追加进共享容器
    worksGrid.abortRender();
    followingsGrid.abortRender();
    dom.mainContainer.innerHTML = "";

    state.selectedIds.clear();
    store.set("batchMode", false);

    detail.closeDetail();
    if (dom.sidebar) {
      const isExpanded = !dom.sidebar.classList.contains("sidebar-zero");
      if (isExpanded) {
        sidebar.setSidebarWidth(0);
        sidebar.saveSidebarWidth(0);
      }
    }
    sidebar.clearSidebarActive();
    state.currentFollowingSecUid = null;

    document.body.classList.remove("domain-works", "domain-followings");
    document.body.classList.add("domain-" + domain);

    document.querySelectorAll(".ds-btn").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.domain === domain);
    });
    this.updateDomainSlider(domain);

    store.set("domain", domain);
    state.currentGroupId = "all";
  }

  renderErrorState(msg, detail) {
    dom.emptyState.classList.add("hidden");
    dom.mainContainer.classList.add("hidden");
    dom.errorState.querySelector("p").textContent = msg;
    const hint = dom.errorState.querySelector(".error-hint");
    if (hint) hint.textContent = detail || "请检查网络后重试";
    dom.errorState.classList.remove("hidden");
  }

  // 弹窗关闭请求统一入口：X 按钮与 Esc 共用（docs/UI_IMPROVEMENTS.md 建议3）。
  // 短操作锁 preventDialogClose 期间不响应；长操作经 activeDialog 发取消信号
  async requestDialogClose() {
    if (state.preventDialogClose) return;
    if (state.activeDialog) {
      state.activeDialog();
      chrome.runtime.sendMessage({ type: "CANCEL_ACTIVE_TASK" }).catch(() => {});
    }
    // 设置面板在关闭前保存运行参数；校验失败则保持打开
    if (!(await settings.saveBeforeClose())) return;
    dialog.closeDialog();
  }

  #bindEvents() {
    document.querySelectorAll(".ds-btn").forEach((tab) => {
      tab.addEventListener("click", () => this.switchDomain(tab.dataset.domain));
    });
    window.addEventListener(
      "resize",
      () => {
        this.updateDomainSlider(state.domain);
      },
      { passive: true },
    );
    dom.btnRetry.addEventListener("click", async () => {
      dom.errorState.classList.add("hidden");
      try {
        const groupId = state.currentGroupId;
        const works = await services.loadWorks(groupId);
        if (state.currentGroupId !== groupId) return;
        store.set("works", works);
      } catch (err) {
        console.error("[DY] load works failed:", err);
        this.renderErrorState("数据加载失败", err.message);
      }
    });
  }
}

const appShell = new AppShell();

// ---------- DOM 事件绑定 ----------
dom.dialogClose.addEventListener("click", () => appShell.requestDialogClose());

// Esc：弹窗优先走统一关闭入口；详情层的 Esc 由 Detail 自己的监听处理；其余收起搜索栏
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!dom.dialogOverlay.classList.contains("hidden")) {
    appShell.requestDialogClose();
    return;
  }
  if (!dom.detailOverlay.classList.contains("hidden")) return;
  search.closeSearchBar();
});

dom.btnBatch.addEventListener("click", () => batch.handleBatchToggle());
dom.batchSelectAll.addEventListener("click", () => batch.handleBatchSelectAll());
dom.batchDelete.addEventListener("click", () => batch.handleBatchDelete());
dom.batchMove.addEventListener("click", () => batch.handleBatchMove());

dom.btnMenu.addEventListener("click", (e) => {
  e.stopPropagation();
  dom.menuDropdown.classList.toggle("hidden");
});
document.addEventListener("click", () => {
  dom.menuDropdown.classList.add("hidden");
});
dom.menuDropdown.addEventListener("click", () => {
  dom.menuDropdown.classList.add("hidden");
});

dom.btnGroupManage.addEventListener("click", () => groups.showGroupManage());

dom.btnImport.addEventListener("click", () => {
  dom.fileInput.click();
});
dom.fileInput.addEventListener("change", (e) => importExport.handleImport(e));

dom.btnExport.addEventListener("click", () => importExport.handleExport());

dom.btnFavorites.addEventListener("click", () =>
  favorites.openScanDialog({
    title: "扫描点赞",
    stateKey: "favoriteWorks",
    fetchingKey: "favoriteFetching",
    cancelingKey: "cancelingFavorites",
    cancelType: "CANCEL_LIKE",
    formatStats: (total, unfollowed) => `已扫描 ${total} 个点赞作品，发现 ${unfollowed} 个未关注作者作品`,
    cancelLabel: "取消点赞",
    noSignatureUrl: config.URL_USER_SELF + config.URL_LIKE_TAB,
    noSignatureStep: "点赞",
    noSignatureScan: "扫描点赞列表",
    buildFetchArgs: () => ({ type: "FETCH_FAVORITES", secUid: null }),
    needSecUid: true,
  }),
);
dom.btnCollections.addEventListener("click", () =>
  favorites.openScanDialog({
    title: "扫描收藏",
    stateKey: "collectionWorks",
    fetchingKey: "collectionFetching",
    cancelingKey: "cancelingCollections",
    cancelType: "CANCEL_COLLECTION",
    formatStats: (total, unfollowed) => `${total} 件 · 未关注 ${unfollowed} 件`,
    cancelLabel: "取消收藏",
    noSignatureUrl: config.URL_USER_SELF + config.URL_COLLECTION_TAB,
    noSignatureStep: "收藏",
    noSignatureScan: "扫描收藏列表",
    buildFetchArgs: () => ({ type: "FETCH_COLLECTION" }),
    needSecUid: false,
  }),
);

dom.btnSettings?.addEventListener("click", () => settings.openPanel());

dom.btnReset.addEventListener("click", async () => {
  const domain = state.domain;
  const domainName = domain === "works" ? "作品" : "关注";

  const resetBody = document.createElement("p");
  resetBody.className = "confirm-delete-msg";
  resetBody.textContent = `确定要清空当前${domainName}域的所有数据？此操作不可撤销！`;
  dialog.showDialog(`确认重置${domainName}`, resetBody, [
    { text: "取消", ghost: true, callback: () => dialog.closeDialog() },
    {
      text: `清空${domainName}数据`,
      danger: true,
      callback: async () => {
        dialog.updateDialog("正在重置…", `<p>正在清空数据…</p>${utils.SPINNER_HTML}`);
        state.preventDialogClose = true;
        try {
          await services.bgMsg({ type: "RESET_DOMAIN", domain });
          state.selectedIds.clear();
          store.set("batchMode", false);
          if (domain === "works") {
            store.set("works", []);
          } else {
            store.set("followings", []);
          }
          await groups.renderGroupTabs();
          dom.dialogTitle.textContent = "重置完成";
          dom.dialogBody.innerHTML = `<p>${domainName}数据已清空</p>`;
          dialog.showOkDialog();
        } finally {
          state.preventDialogClose = false;
        }
      },
    },
  ]);
});

dom.btnSync.addEventListener("click", async () => {
  if (sync.isRunning()) return;
  if (state.domain === "followings") {
    await sync.syncFollowings();
  } else {
    await sync.syncCurrentGroup();
  }
});

// ---------- init IIFE ----------
(async function init() {
  // 构建标记：用于确认页面运行的是最新构建（头像探针预载版）
  console.info("[DDM] options build 2026-08-25 searchbar-appshell-refactor");
  document.body.classList.remove("batch-mode");
  dom.mainContainer.classList.add("hidden");
  dom.emptyState.classList.add("hidden");
  // 预加载运行时配置
  await runtimeConfig.load();
  for (const name of ["pause", "play", "mute", "unmute", "loopSingle", "loopGroup", "noLoop", "check"]) {
    config.icons[name] = document.getElementById("icon-" + name).innerHTML;
  }

  sidebar.initSidebar();
  detail.initDetailEvents();
  dom.groupTabs.addEventListener(
    "scroll",
    () => {
      groups.updateTabMask();
    },
    { passive: true },
  );
  window.addEventListener("resize", groups.updateTabMask, { passive: true });

  store.on("domain", async () => {
    sync.updateSyncBtnLabel();
    await groups.renderGroupTabs();
    search.onDomainChanged();
    try {
      await services.loadDomainData();
    } catch (err) {
      console.error("[DY] load domain data failed:", err);
      appShell.renderErrorState("数据加载失败", err.message);
    }
  });

  store.on("works", () => {
    if (state.domain === "works") search.refreshGridView();
  });
  store.on("followings", () => {
    if (state.domain === "followings") search.refreshGridView();
  });
  store.on("groups", () => groups.renderGroupTabs());
  store.on("currentGroupId", async () => {
    await groups.renderGroupTabs();
    try {
      await services.loadDomainData();
    } catch (err) {
      console.error("[DY] load domain data failed:", err);
      appShell.renderErrorState("数据加载失败", err.message);
    }
  });
  store.on("batchMode", (v) => {
    document.body.classList.toggle("batch-mode", v);
    batch.syncSelectionUI();
  });
  store.on("work-updated", (awemeId) => {
    worksGrid.updateCardDOM(awemeId);
    if (detail.getDetailIndex() !== -1 && detail.getCurrentWork()?.awemeId === awemeId) {
      detail.renderDetail();
    }
  });

  document.body.classList.add("domain-works");
  appShell.updateDomainSlider("works");
  sync.updateSyncBtnLabel();
  await groups.renderGroupTabs();
  try {
    await services.loadDomainData();
  } catch (err) {
    console.error("[DY] load domain data failed:", err);
    appShell.renderErrorState("数据加载失败", err.message);
  }
})();
