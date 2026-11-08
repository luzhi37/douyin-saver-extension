// ---------- 共享基础设施（core） ----------
// 由原 options/options.js 顶层 7 个全局对象拆出：config / dom / state / store / utils / runtimeConfig / services。
// 仅依赖 shared/ 下的纯函数/常量模块，是模块图中第一个被完全求值的模块；所有类模块经 ES import 引用本模块导出物。

import { sortSavedAtDesc, mergeSavedAtDesc, authorKeyOf } from "../shared/author-sort.js";
import { RUNTIME_DEFAULTS } from "../shared/runtime-defaults.js";

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
  VIDEO_FALLBACK_TIMEOUT: 5000,

  // UI 延迟
  HOVER_PREVIEW_DELAY: 200,
  BLOB_REVOKE_DELAY: 10000,
  NOTE_AUTO_PLAY_INTERVAL: 3000,
  // 侧边栏档位：N 列 × 固定卡宽（wN = N×CARD_SIZE + (N-1)*GAP + 2*PADDING）与收起(0)，
  // 无连续宽度、无容差带；N 从 1 起由可用宽度上限决定（展开默认 3 列，见 Sidebar.DEFAULT_COLS）。
  // CARD_SIZE 为固定卡宽，经 Sidebar.initSidebar 注入 CSS 变量
  // --sb-card-size/--sb-grid-gap/--sb-grid-padding（options.css 的 var() 兜底值须与这里一致），
  // 网格列数由 Sidebar.#applyColumns 以 inline gridTemplateColumns 落笔
  SIDEBAR_CARD_SIZE: 210,
  SIDEBAR_GRID_GAP: 6,
  SIDEBAR_GRID_PADDING: 8,
  // 可用上限：availableMax = appBody - 右栏 - 分割条 - MAIN_GRID_MIN；超上限的档位从
  // 候选剔除，全部档位放不下（非拖拽路径）被动收起归 0
  // 主网格保底宽度：关注域单列卡宽带内下限（212×CARD_SIZE_BAND_MIN≈199）附近取 195
  // 作最小可读宽——侧栏在场时主网格至少呈现一列关注卡，appBody 再窄
  //（< 195+62+226 = 483px）才允许被动收起侧栏
  //（侧栏最小宽 226 = 其作品卡宽 210 + 2*padding）
  SIDEBAR_MAIN_GRID_MIN: 195,
  SIDEBAR_SCROLL_THRESHOLD: 100,
  SIDEBAR_FILL_THRESHOLD: 50,
  SIDEBAR_IMG_PER_FRAME: 6,
  SIDEBAR_DRAG_THRESHOLD: 4,

  // 卡片（CARD_HEIGHT_OFFSET = 封面矩形外的信息块高度：8 顶 + 16 作者行 + 6 底 = 30；
  // 必须与 options.css 的 --dy-card-info-height 一致）
  CARD_SIZE_FALLBACK: 261,
  CARD_GAP: 11,
  CARD_HEIGHT_OFFSET: 30,
  // 自适应卡宽容差带（占理想卡宽比例，上下限对称 ±6%）：VirtualGrid #applyLayout
  // 带内卡宽钳在 [MIN, MAX]×ideal——上限防「为填满而把卡片拉得过胖」，下限防
  // 「卡片过小不可读」；无可行解（相邻列宽差跨过整个带宽）时向下破下限 ≤ 一个
  // 带宽换零空白，卡片明显过小才钳到上限、收少量空白
  CARD_SIZE_BAND_MIN: 0.94,
  CARD_SIZE_BAND_MAX: 1.06,
  // 作品卡（works/favorites/collections 三域，WorksGrid）专用宽容差带（±10%）：比作者域
  // 沿用的全局默认（±6%）更宽，卡片在填满列宽时的可伸缩档位更大（经 VirtualGrid 构造参数
  // sizeBandMin/sizeBandMax 按实例覆盖；作者域仍用上面的全局默认）
  WORK_CARD_SIZE_BAND_MIN: 0.9,
  WORK_CARD_SIZE_BAND_MAX: 1.1,

  // 详情页
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
  // 活动 DOM 硬上限（预铺与自动翻页追加共用）：改一次卡宽要对每张已挂载卡重排其内部
  // 子树，实测约 60µs/张——2000 张时折叠侧栏 = 120ms+，600 张约 20ms。自动翻页把
  // 整域条目全挂进 DOM 是卡顿根因（数据仍在 #viewItems/#itemMap，滚近键控扩容铺卡）
  GRID_MOUNT_MAX: 600,
  GRID_EXTEND_THRESHOLD: 1.5,
  // 扩容单步新增槽位上限：深域（十万级 totalSlots）倍增到后段时单步会是数千上万张
  // 占位卡克隆 + 整容器布局的长任务——超出部分留待后续滚动 rAF 继续扩，小槽位段
  // 倍增语义不变（2S < S+步长时仍按倍增）
  GRID_EXTEND_STEP: 1000,
  // 远跳追赶单步上限：拖拽把视口丢进尾部占位区（封闭视图）后，按视口带区直铺追赶的
  // 单步新增槽位上限——大 M 下每次容器追加都是全网格重排（实测 2 万卡单次追加约
  // 130ms、4 万卡可达 1s），单步封顶防长冻结，未覆盖视口时下一帧续铺
  GRID_EXTEND_JUMP_STEP: 4000,
  // 停稳降级分帧预算：快滚期冻结的降级在停稳后成批积压（沿途数千张），一次性执行
  // 是数百毫秒单任务——按帧预算分帧执行且让位于填充队列
  DEMOTE_FRAME_BUDGET_MS: 8,
  // 网格媒体探针每帧派发配额（works 封面 + 作者域头像；sidebar 窄列沿用
  // SIDEBAR_IMG_PER_FRAME）。滚入新带时数十张探针按 6/帧要摊十几帧——提到 10
  // 缩短起跑排队；派发只是 new Image()，实际网络并发由浏览器按 host 连接数自限
  GRID_IMG_PER_FRAME: 10,

  // 分组/存储
  TAB_SCROLL_THRESHOLD: 2,
  GROUP_NAME_MAX_LEN: 20,
  STORAGE_MAX_BYTES: 10 * 1024 * 1024,
  TRASH_GROUP_NAME: "稍后删除",

  // 随机回顾（真实回顾域）：本轮数量可自定义（1–500），批次引用最多 500 条
  RANDOM_REVIEW_DEFAULT_COUNT: 20,
  RANDOM_REVIEW_MAX_COUNT: 500,
  RANDOM_REVIEW_MAX_EXCLUDE: 2000,

  // 作品数排序后台权威分页（方案 B）：关闭后 options 不再发送 sort=authorCount，
  // 立即回到 saved 分页 + 完成态本地整渲（回滚开关，无需降级数据库）
  AUTHOR_COUNT_PAGING: true,

  // URL
  URL_BASE: "https://www.douyin.com",
  URL_USER_SELF: "https://www.douyin.com/user/self",
  URL_FAVORITE_TAB: "?showTab=like",
  URL_COLLECTION_TAB: "?showTab=favorite_collection",
  URL_FOLLOWING_TAB: "?showTab=following",

  // 域元数据：作品型三域（works/favorites/collections）同构 Work 记录；作者档案型两域
  //（followings 原生关注镜像 / candidates 扩展自建候选池）同构 7 字段记录
  WORK_RECORD_DOMAINS: ["works", "favorites", "collections"],
  AUTHOR_RECORD_DOMAINS: ["followings", "candidates"],
  REVIEW_DOMAIN: "review",
  SOURCE_DOMAINS: ["works", "favorites", "collections", "followings", "candidates"],
  DOMAINS_META: {
    works: { label: "作品", itemKey: "works", idKey: "awemeId", isAuthorRecord: false },
    followings: { label: "关注", itemKey: "followings", idKey: "uid", isAuthorRecord: true },
    favorites: { label: "点赞", itemKey: "favorites", idKey: "awemeId", isAuthorRecord: false },
    collections: { label: "收藏", itemKey: "collections", idKey: "awemeId", isAuthorRecord: false },
    candidates: { label: "候选", itemKey: "candidates", idKey: "uid", isAuthorRecord: true },
    review: { label: "回顾", itemKey: "reviewItems", idKey: "sourceId", isAuthorRecord: false, canImportExport: false },
  },

  // 正则
  SEC_UID_REGEX: /^\/user\/([^/?]+)/,

  // 图标（运行时填充）
  icons: {},
};

// ---------- dom ----------
export const dom = {
  appBody: document.querySelector("#appBody"),
  domainSwitch: document.querySelector(".domain-switch"),
  dsSlider: document.querySelector(".ds-slider"),
  groupTabs: document.querySelector("#groupTabs"),
  mainContainer: document.querySelector("#mainContainer"),
  emptyState: document.querySelector("#emptyState"),
  batchMove: document.querySelector("#btnBatchMove"),
  batchDelete: document.querySelector("#btnBatchDelete"),
  batchSelectAll: document.querySelector("#btnBatchSelectAll"),
  btnBatchDone: document.querySelector("#btnBatchDone"),
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
  detailVisit: document.querySelector("#detailVisit"),
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
  dyTooltip: document.querySelector("#dyTooltip"),
  btnDataTools: document.querySelector("#btnDataTools"),
  btnStatus: document.querySelector("#btnStatus"),
  btnSync: document.querySelector("#btnSync"),
  btnBatch: document.querySelector("#btnBatch"),
  btnGroupManage: document.querySelector("#btnGroupManage"),
  mainGrid: document.querySelector("#mainGrid"),
  errorState: document.querySelector("#errorState"),
  btnRetry: document.querySelector("#btnRetry"),
  btnAuthorImport: document.querySelector("#btnAuthorImport"),
  btnSettings: document.querySelector("#btnSettings"),
  menuStorage: document.querySelector("#menuStorage"),
  rightSidebar: document.querySelector("#rightSidebar"),
  sidebar: document.querySelector("#sidebar"),
  sidebarBody: document.querySelector("#sidebarBody"),
  sidebarWorksGrid: document.querySelector("#sidebarWorksGrid"),
  sidebarAuthorHead: document.querySelector("#sidebarAuthorHead"),
  sidebarAuthorAvatar: document.querySelector("#sidebarAuthorAvatar"),
  sidebarAuthorName: document.querySelector("#sidebarAuthorName"),
  sidebarAuthorStatus: document.querySelector("#sidebarAuthorStatus"),
  sidebarAuthorSub: document.querySelector("#sidebarAuthorSub"),
  sidebarAuthorClose: document.querySelector("#sidebarAuthorClose"),
  sidebarLoader: document.querySelector("#sidebarLoader"),
  sidebarEndNotice: document.querySelector("#sidebarEndNotice"),
  sidebarResizeHandle: document.querySelector("#sidebarResizeHandle"),
  sidebarWorkTemplate: document.querySelector("#sidebarWorkTemplate"),
  batchSaveToWorks: document.querySelector("#btnBatchSaveToWorks"),
  batchSaveToCandidates: document.querySelector("#btnBatchSaveToCandidates"),
  batchDownload: document.querySelector("#btnBatchDownload"),
  batchCount: document.querySelector("#batchCount"),
  batchTotal: document.querySelector("#batchTotal"),
  searchInput: document.querySelector("#searchInput"),
  sbCount: document.querySelector("#sbCount"),
  sbWorkFilters: document.querySelector("#sbWorkFilters"),
  sbSort: document.querySelector("#sbSort"),
  sbType: document.querySelector("#sbType"),
  sbFollowFilters: document.querySelector("#sbFollowFilters"),
  sbFollowSort: document.querySelector("#sbFollowSort"),
  btnClearInBar: document.querySelector("#btnClearInBar"),
  btnSearchGo: document.querySelector("#btnSearchGo"),
  // 回顾页签 / 回顾顶栏配置
  btnReviewTab: document.querySelector('.ds-btn[data-domain="review"]'),
  reviewBar: document.querySelector("#reviewBar"),
  reviewSourceScope: document.querySelector("#reviewSourceScope"),
  reviewCountInput: document.querySelector("#reviewCountInput"),
  btnReviewRandom: document.querySelector("#btnReviewRandom"),
  btnReviewAppend: document.querySelector("#btnReviewAppend"),
  // 全局 Toast 容器（右下角堆叠；Dialog.showToast 按条创建）
  toastStack: document.querySelector("#toastStack"),
};

// ---------- state ----------
export const state = {
  domain: "works",
  works: [],
  followings: [],
  favorites: [],
  collections: [],
  candidates: [],
  currentGroupId: "all",
  batchMode: false,
  selectedIds: new Set(),
  // 全页媒体静音偏好（网格卡片预览 + 详情播放器共用单一事实源）：两处静音按钮都读写
  // 此标志，所有媒体渲染/起播路径统一施加；仅页面生命周期内保持，不落存储
  mediaMuted: false,
  activeDialog: null,
  currentAuthorSecUid: null,
  sidebarCursor: null,
  sidebarLoading: false,
  // 关注全集 uid 集合（候选域重叠比对 + 作品卡作者状态 chip 共用）：全量不受分组影响，
  // 加载失败时保留旧集合
  followedUids: new Set(),
  // 候选域 uid 全集（作品卡作者状态 chip）：与 followedUids 同款主键集
  candidateUids: new Set(),
  // 短操作弹窗锁：为 true 时禁止点击 X 关闭，待操作完成才解锁
  preventDialogClose: false,
  // 渐进加载的一次性预铺额度 { domain, groupId, total }：首页渲染时消费（renderCards
  // 读取后即清），按 total 一次铺满全量骨架，余页经 fillSlots 以键前缀自锚定回填
  gridSlots: null,
  // 当前域+分组的后台权威总量（作品型三域 = GET_* page:0 的 total；作者域 = 单发全量
  // 长度）：用于加载期占位与分组 tab 数字校正；搜索栏只显示 K，不再展示该总量。
  // 切域/切组瞬间由 gridTotals 缓存先给出占位，首页到达后校正；无缓存显示「…」
  gridTotal: null,
  // 「domain|groupId」→ page-0 权威 total 缓存：切域/切组的占位与当前分组 tab 校正共用。
  // 分组栏数字不走这里——由 GET_DOMAIN_GROUPS 的原子快照一次渲染
  gridTotals: {},
  // 首屏数据未到达（切域/切组后网格已清场）：K 恒 0；首页落库即清
  gridPending: false,
  // 域数据写入版本号：SearchBar 视图阶段缓存（#viewCache）的失效判据。store 的数据
  // 变更方法自动自增；绕过 store 封装的原地写入（main.js tryHeadInsert/applyStoreUpserts）
  // 必须手动自增，否则缓存读到脏视图
  //（红线见 docs/11「视图阶段缓存」）
  dataVersion: 0,
  // 回顾域是真实域：state.review 为回源 hydration 后的当前批次，reviewSourceDomain/kind
  // 记录批次来源与卡片类型（works/authors），用于动态选择搜索视图与网格实例
  review: [],
  reviewSourceDomain: null,
  reviewKind: "works",
  // 作品型三域的分页模式（由 SearchBar.syncPagingState 写入）：saved 走现有 keyset
  // 分页；authorCount 走 background 作者视图游标。ascending 仅 saved 升序使用
  pagingMode: { sort: "saved", direction: "desc", ascending: false },
  // authorCount 的 trusted 视图：items 为按作者视图序到达的已加载前缀；counts 为全组
  // 作者计数（page0 authorMeta），用于本地 fallback rank；complete 标记所有作者视图页
  // 已加载完（只有此时才允许本地摘卡而不整域重载）。写入/切域/切组即失效
  authorViewOrder: null,
};

// ---------- store ----------
export const store = {
  _listeners: new Map(),

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
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
      if (
        config.AUTHOR_RECORD_DOMAINS.includes(key) ||
        config.WORK_RECORD_DOMAINS.includes(key) ||
        key === config.REVIEW_DOMAIN
      ) {
        state.dataVersion++;
      }
      // 作者视图按 (domain, groupId, direction) 绑定当前数据：域数据整体替换即失效；
      // authorCount page0 会在 store.set 之后同步重建（rAF 渲染前）
      if (config.WORK_RECORD_DOMAINS.includes(key) || key === config.REVIEW_DOMAIN) {
        state.authorViewOrder = null;
      }
      this.notify(key, val, old);
    }
  },

  // 触发 groups 数据重新加载（总是从 background 获取最新分组数据）
  refreshGroups() {
    this.notify("groups");
  },

  // 作品型三域通用的静默移除（按当前域数据源过滤）。
  // preserveAuthorOrder=true：authorCount 完整视图下的本地摘卡——保留已渲染顺序，只从
  // 视图前缀里剔除记录并递减作者计数，不触发整域重载；顺序在下次显式切排序/分组/域时
  // 由后台作者视图重新校准。视图不完整/加载中仍走 preserve=false（随后整域重载兜底）。
  removeWorkRecordSilent(domain, idSet, { preserveAuthorOrder = false, adjustAllTotal = true } = {}) {
    if (!idSet || idSet.size === 0) return 0;
    const removed = [];
    for (const w of state[domain]) {
      if (idSet.has(w.awemeId)) removed.push(w);
    }
    if (removed.length === 0) return 0;
    state[domain] = state[domain].filter((w) => !idSet.has(w.awemeId));
    const order = state.authorViewOrder;
    const orderMatches =
      order && order.domain === domain && order.groupId === state.currentGroupId;
    if (preserveAuthorOrder && orderMatches) {
      order.items = order.items.filter((w) => !idSet.has(w.awemeId));
      for (const w of removed) {
        const key = authorKeyOf(w);
        const count = order.counts?.get(key);
        if (count == null) continue;
        if (count <= 1) order.counts.delete(key);
        else order.counts.set(key, count - 1);
      }
    } else {
      state.authorViewOrder = null;
    }
    state.dataVersion++;
    // 当前分组总数缓存局部递减（切组占位数字用；page0 到达后仍以后台 total 校正）。
    // 删除会影响「全部」总数；移出当前分组不影响「全部」，由调用方关闭 adjustAllTotal
    const keys = [`${domain}|${state.currentGroupId}`];
    if (adjustAllTotal && state.currentGroupId !== "all") keys.push(`${domain}|all`);
    for (const key of keys) {
      if (typeof state.gridTotals[key] === "number") {
        state.gridTotals[key] = Math.max(0, state.gridTotals[key] - removed.length);
      }
    }
    const cur = state.gridTotal;
    if (cur && cur.domain === domain && cur.groupId === state.currentGroupId) {
      cur.total = Math.max(0, cur.total - removed.length);
    }
    return removed.length;
  },

  // 「全部」分组内移动：只改分组归属，不改变当前视图集合与作者计数，因此不摘卡、
  // 不整域重载。记录对象同时被 state[domain] 与 authorViewOrder.items 持有（同引用），
  // 一次原地写入即可两处一致
  updateWorkGroupSilent(domain, idSet, targetGroupId) {
    let changed = false;
    let moved = 0;
    const sourceGroups = new Map();
    for (const w of state[domain]) {
      if (!idSet.has(w.awemeId) || w.groupId === targetGroupId) continue;
      if (w.groupId) sourceGroups.set(w.groupId, (sourceGroups.get(w.groupId) || 0) + 1);
      w.groupId = targetGroupId;
      changed = true;
      moved++;
    }
    if (!changed) return;
    state.dataVersion++;
    // 分组缓存是「切组首帧占位」用的近似值；源/目标组的数字先按本地变更挪动，
    // 后台 count 快照（refreshGroups）随后校正
    const targetKey = `${domain}|${targetGroupId}`;
    if (typeof state.gridTotals[targetKey] === "number") state.gridTotals[targetKey] += moved;
    for (const [groupId, count] of sourceGroups) {
      const key = `${domain}|${groupId}`;
      if (typeof state.gridTotals[key] === "number") {
        state.gridTotals[key] = Math.max(0, state.gridTotals[key] - count);
      }
    }
  },

  // 分页渐进加载追加（作品型三域）：push 进域数组后发专属事件，与 set 的全量替换
  // 事件分流——避免逐页触发 refreshGridView 全量重渲（骨架闪烁 + 封面重探）。
  // start = 变更前的域数组长度（升序前插为前插前长度）；对齐模式的回填落点由视图下标
  // 推算（筛选子集下页域下标不可用），start 仅作兼容/核对字段。
  // 消费方（main.js）按页序是否与视图序对齐决定按槽回填或静默累积。
  // ascending 标记取数方向：页内为升序块时消费方须按「视图下标」续填（见 prependWorkRecord）
  appendWorkRecord(domain, groupId, items, done) {
    const start = state[domain].length;
    state[domain].push(...items);
    state.dataVersion++;
    this.notify("work-record-appended", { domain, groupId, items, start, done, mode: "saved", ascending: false });
  },

  // 升序取数（从最旧一端分页）的对称操作：items 为到达序（savedAt 升序块，即视图序）。
  // 域数组须保持 savedAt 降序不变量（头插比较器/键集游标/导出等消费方均按该序假设），
  // 故前插前先反转回降序；事件仍按到达序派发，让消费方按视图下标续填（尾部单调追加）
  prependWorkRecord(domain, groupId, items, done) {
    const start = state[domain].length;
    state[domain].unshift(...items.slice().reverse());
    state.dataVersion++;
    this.notify("work-record-appended", { domain, groupId, items, start, done, mode: "saved", ascending: true });
  },

  // 作者数分页续页：页条目按 authorCount 视图序到达，但 state[domain] 必须始终保持
  // savedAt 降序不变量——先对页做 savedAt 排序，再与域数组双指针归并（不直接 push 到达序）
  appendAuthorViewRecord(domain, groupId, items, done, direction) {
    const start = state[domain].length;
    state[domain] = mergeSavedAtDesc(state[domain], items);
    const order = state.authorViewOrder;
    if (order && order.domain === domain && order.groupId === groupId && order.direction === direction) {
      order.items.push(...items);
      if (done) order.complete = true;
    }
    state.dataVersion++;
    this.notify("work-record-appended", {
      domain,
      groupId,
      items,
      start,
      done,
      mode: "authorCount",
      direction,
    });
  },

  // 作者档案型域通用的静默移除（按当前域数据源过滤）
  removeAuthorRecordsSilent(domain, idSet) {
    state[domain] = state[domain].filter((f) => !idSet.has(f.uid));
    state.dataVersion++;
  },

  // 回顾域引用移除（idKey 由 reviewKind 决定：作品 awemeId / 作者 uid）
  removeReviewItemsSilent(idSet, idKey) {
    state.review = state.review.filter((item) => !idSet.has(String(item[idKey])));
    state.dataVersion++;
    this.notify("review-meta");
  },

};

// ---------- utils ----------
export const utils = {
  // 域类型判定：回顾域按 state.reviewKind 动态归入作品型或作者型
  isWorkRecordDomain(domain = state.domain) {
    return (
      config.WORK_RECORD_DOMAINS.includes(domain) ||
      (domain === config.REVIEW_DOMAIN && state.reviewKind === "works")
    );
  },
  isAuthorRecordDomain(domain = state.domain) {
    return (
      config.AUTHOR_RECORD_DOMAINS.includes(domain) ||
      (domain === config.REVIEW_DOMAIN && state.reviewKind === "authors")
    );
  },
  pickHttpsUrl(url) {
    if (!url) return "";
    return url.startsWith("//") ? "https:" + url : url;
  },
  // 卡片展示封面（四网格/侧边栏共用）：图集优先平台 cover（video.cover 小图），但首图
  // URL 带压缩档标记（tplv 模板短边 < 2000，如 :1440:）时首图更轻，保留首图；视频与
  // 模板不可解析一律 cover 优先、缺失回退。背景：平台给图集首图签发的 3000 档 ≈ 原图
  //（实测 6-8.7MP），cover 是封面档（实测轻 1.4-4.6×）；tplv 改写小变体被签名拒绝（403）
  pickCardCover(work) {
    const cover = this.pickHttpsUrl(work?.cover || "");
    if (!work || work.type !== "note") return cover;
    const still = this.pickHttpsUrl(work.images?.[0] || "");
    if (!cover || !still) return cover || still;
    const m = still.match(/~tplv-[^/:]+:(\d+):/);
    return m && Number(m[1]) < 2000 ? still : cover;
  },
  // 进度弹窗装配（syncDialogBodyTemplate 单一来源，三个 sync 类共用）：克隆 + 取三元素，
  // 状态位预置 SYNCING，计数/摘要文案由调用方按域填写
  buildSyncProgressBody() {
    const body = document.getElementById("syncDialogBodyTemplate").content.cloneNode(true);
    const countEl = body.querySelector(".sync-count");
    const summaryEl = body.querySelector(".sync-summary");
    const statusEl = body.querySelector(".sync-status");
    statusEl.textContent = "SYNCING";
    return { body, countEl, summaryEl, statusEl };
  },
  formatCount(num) {
    if (num == null || Number.isNaN(Number(num))) return "0";
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
    // SEC_UID_REGEX 锚定 pathname 起始；完整 URL 先取 pathname 再匹配
    const m = new URL(url, config.URL_BASE).pathname.match(config.SEC_UID_REGEX);
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
  DEFAULTS: { ...RUNTIME_DEFAULTS },
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
  // 首屏就绪条目（本域本次加载）：{ domain, groupId, promise, resolve, done, timer }。
  // 由 _armFirstScreen 注册、首页渲染落笔后兑现；分组计数/作者主键集等装饰性请求据此
  // 错峰，避免与 GET_* page-0 的 IDB 游标并发抢资源（3 万级实测把首页往返拖到 ~1s）
  _gridFirstScreen: null,

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

  // 仅取存储占用字节（bytesOnly 不做任何 count）：存储指示器独立刷新用，与分组 tab 重建解耦
  async loadStorageBytes() {
    const res = await this.bgMsg({ type: "GET_STATS", bytesOnly: true });
    return (res.stats && res.stats.bytes) || 0;
  },

  // 回顾域真实数据：background 按引用回源 hydration 后返回完整记录
  async loadReviewItems(groupId) {
    const res = await this.bgMsg({ type: "GET_REVIEW", groupId });
    if (res.error) throw new Error(res.error);
    state.reviewSourceDomain = res.sourceDomain || null;
    state.reviewKind = res.kind || "works";
    return { items: res.reviewItems || [], total: res.total || 0 };
  },

  async saveReviewBatch({ sourceDomain, sourceIds, groupId, append = false }) {
    return this.bgMsg({ type: "SAVE_REVIEW_BATCH", sourceDomain, sourceIds, groupId, append });
  },

  async deleteReviewItems(sourceDomain, sourceIds) {
    return this.bgMsg({ type: "DELETE_REVIEW", sourceDomain, sourceIds });
  },

  async moveReviewItems(sourceDomain, sourceIds, targetGroupId) {
    return this.bgMsg({ type: "MOVE_REVIEW", sourceDomain, sourceIds, targetGroupId });
  },

  async loadAuthorRecords(domain, groupId) {
    const meta = config.DOMAINS_META[domain];
    const res = await this.bgMsg({ type: "GET_" + domain.toUpperCase(), groupId: groupId || state.currentGroupId });
    return (res[meta.itemKey] || []).filter((f) => f && f.uid);
  },

  // 候选域重叠比对用关注全集：全量加载不受分组影响，直接建 uid 集合；加载失败时保留旧集合
  async loadFollowedUids() {
    const res = await this.bgMsg({ type: "GET_FOLLOWINGS", groupId: "all" }).catch(() => null);
    if (!res || !Array.isArray(res.followings)) return false;
    state.followedUids = new Set(res.followings.filter((f) => f && f.uid).map((f) => String(f.uid)));
    return true;
  },

  // 按 uid 直取作者档案（关注/候选各一条，主键读取）：侧栏作者头在作品型三域
  // 只有作者摘要时补头像/统计，不物化作者域全量。失败返回 null 保持摘要降级
  async loadAuthorByUid(uid) {
    const res = await this.bgMsg({ type: "GET_AUTHOR_BY_UID", uid: String(uid) }).catch(() => null);
    if (!res || res.error) return null;
    return { followings: res.followings || null, candidates: res.candidates || null };
  },

  // 作者域成员资格主键集（作品卡作者状态 chip）：作者域主键即 uid，background 用
  // getAllKeys 直取、不物化记录；两域并行一次取回。失败保持旧集合并返回 false
  //（调用方按「不显示 chip」降级，不阻塞网格加载）
  async loadAuthorUidSets() {
    const res = await this.bgMsg({ type: "GET_AUTHOR_UID_SETS" }).catch(() => null);
    if (!res || res.error || !Array.isArray(res.followings) || !Array.isArray(res.candidates)) return false;
    state.followedUids = new Set(res.followings.map(String));
    state.candidateUids = new Set(res.candidates.map(String));
    return true;
  },

  async loadGroups(domain) {
    const res = await this.bgMsg({ type: "GET_GROUPS", domain: domain || state.domain });
    return res.groups || [];
  },

  // 域切换/分组刷新用：一个 readonly 事务内同时返回分组表与各分组计数（原子快照）。
  // 不落缓存——每次调用都取最新值；分组栏由返回值一次渲染
  async loadDomainGroups(domain = state.domain) {
    const res = await this.bgMsg({ type: "GET_DOMAIN_GROUPS", domain });
    if (res.error) throw new Error(res.error);
    return { groups: res.groups || [], counts: res.counts || {}, total: res.total || 0 };
  },

  // 随机回顾抽样（background 主键抽样 + 批量取记录）：不等待网格分页加载，不物化整域。
  // P1 固定整个域（groupId=all）；返回 items/poolSize/eligible/remaining
  async pickRandomRecords({
    domain,
    groupId = "all",
    count = config.RANDOM_REVIEW_DEFAULT_COUNT,
    excludeIds = [],
  } = {}) {
    const res = await this.bgMsg({
      type: "GET_RANDOM_RECORDS",
      domain,
      groupId,
      count,
      excludeIds: excludeIds.slice(-config.RANDOM_REVIEW_MAX_EXCLUDE),
    });
    if (res.error) throw new Error(res.error);
    return res;
  },

  isGridLoading() {
    return this._gridLoadCount > 0;
  },

  // 首屏就绪等待（装饰性请求错峰用）：返回本域本次加载的首屏 Promise——首页渲染落笔
  // （state.gridSlots 被 renderCards 消费）+ 让出一次空闲期后兑现；无在途加载立即兑现。
  // 分组计数（GET_STATS 的分组 count）与作者主键集（getAllKeys）在 3 万级库上与
  // page-0 的游标读并发，会把首页往返从 ~150ms 拖到 ~1s（切域实测），故一律延后到首屏之后
  whenFirstScreen(domain = state.domain, groupId = state.currentGroupId) {
    const entry = this._gridFirstScreen;
    if (!entry || entry.domain !== domain || entry.groupId !== groupId || entry.done) return Promise.resolve();
    // 外部等待者让出一个宏任务：loadDomainData 的续页请求同步于同一微任务先发出，
    // 装饰性请求（分组计数/主键集）后跟，不抢占首段续页
    return entry.promise.then(() => new Promise((resolve) => setTimeout(resolve, 0)));
  },

  // 注册本次加载的首屏就绪 Promise（loadDomainData 入口同步调用，供 whenFirstScreen 取用）。
  // 首页请求失败/迟迟不到时最多等 800ms 兑现，等待方不会永久挂住
  _armFirstScreen(domain, groupId) {
    const prev = this._gridFirstScreen;
    if (prev) prev.resolve(); // 上一笔加载的等待直接放行，避免悬挂
    const entry = { domain, groupId, done: false, timer: 0, promise: null, resolve: null };
    entry.promise = new Promise((resolve) => {
      entry.resolve = () => {
        if (entry.done) return;
        entry.done = true;
        clearTimeout(entry.timer);
        resolve();
      };
    });
    entry.timer = setTimeout(entry.resolve, 800);
    this._gridFirstScreen = entry;
    return entry;
  },

  // 首页数据落库（store.set）后调用：等 renderCards 消费掉 gridSlots（渲染已落笔）再
  // 让出一次空闲期（首屏填充先跑本轮）后兑现；等待期间域/分组已变则立即放行
  _fireFirstScreenOnRender(entry) {
    const step = () => {
      if (!entry || entry.done || this._gridFirstScreen !== entry) return;
      if (state.domain !== entry.domain || state.currentGroupId !== entry.groupId) {
        entry.resolve();
        return;
      }
      const rendered = !state.gridSlots || state.gridSlots.domain !== entry.domain;
      if (!rendered) {
        requestAnimationFrame(step);
        return;
      }
      window.requestIdleCallback(() => entry.resolve(), { timeout: 300 });
    };
    requestAnimationFrame(step);
  },

  // 独立模式开关（chrome.storage.local 的 independentMode 布尔；此前 batch/domain-scan-sync 各自内联读取）
  async isIndependentMode() {
    const { independentMode } = await chrome.storage.local.get("independentMode");
    return independentMode === true;
  },

  // 网格数据加载：作品型三域分页渐进（首页 store.set 即渲染，余量逐页 appendWorkRecord，
  // 消费方决定追加渲染或静默累积）；作者档案型两域记录小，维持单发全量。
  // 翻页协议：page=0 取首页，后续以 bg 回传的 nextCursor 续传——saved 排序是 keyset
  // 索引键，authorCount 是 background 作者视图 token；options 只按当前 pagingMode 透传。
  // _gridLoadSeq 为全局加载代际：任何新加载（切组/切域/STORE_CHANGED）作废在途旧循环；
  // 循环体内再校验当前域/分组，双保险防止旧页混入新视图。
  // ascending=true（「保存时间(升)」排序）：bg 从最旧一端按 next 方向分页，页内为升序块
  // （即视图序），首页落库前反转回域数组的 savedAt 降序；余页前插（prependWorkRecord）。
  // authorCount：页序即作者视图序，首页落库前按 savedAt 排序守 state[domain] 不变量，
  // 续页走 appendAuthorViewRecord（归并 + 维护 trusted 视图）
  async loadDomainData(paging = state.pagingMode) {
    const mode = paging || state.pagingMode;
    const { sort = "saved", direction = "desc", ascending = false } = mode;
    const groupId = state.currentGroupId;
    const domain = state.domain;
    this._gridLoadCount++;
    try {
      if (config.AUTHOR_RECORD_DOMAINS.includes(domain)) {
        const data = await this.loadAuthorRecords(domain, groupId);
        if (state.currentGroupId !== groupId || state.domain !== domain) return;
        // 作者域单发全量：权威总量即记录数（同时写入缓存供下次切域占位）
        const total = data.length;
        state.gridTotals[`${domain}|${groupId}`] = total;
        state.gridTotal = { domain, groupId, total };
        state.gridPending = false;
        store.notify("grid-total", { domain, groupId, total });
        store.set(domain, data);
        return;
      }
      // 回顾域：引用已由 background 回源 hydration，单发全量（批次上限 500）
      if (domain === config.REVIEW_DOMAIN) {
        const data = await this.loadReviewItems(groupId);
        if (state.currentGroupId !== groupId || state.domain !== domain) return;
        const total = data.total;
        state.gridTotals[`${domain}|${groupId}`] = total;
        state.gridTotal = { domain, groupId, total };
        state.gridPending = false;
        store.notify("grid-total", { domain, groupId, total });
        store.set(domain, data.items);
        return;
      }
      const meta = config.DOMAINS_META[domain];
      const seq = ++this._gridLoadSeq;
      const stale = () => seq !== this._gridLoadSeq || state.currentGroupId !== groupId || state.domain !== domain;
      const t0 = performance.now();
      // 首屏就绪 Promise：入口即注册，供分组计数/作者主键集等装饰性请求先等首屏（错峰）
      const firstScreen = this._armFirstScreen(domain, groupId);
      let res = await this.bgMsg({
        type: "GET_" + domain.toUpperCase(),
        groupId,
        page: 0,
        sort,
        direction,
        ascending,
      });
      if (res.error) {
        const err = new Error(res.error);
        err.code = res.code;
        throw err;
      }
      if (stale()) return;
      // 预铺额度：首页响应携带 total，render 按它一次铺满全量骨架（未到达页为占位卡）
      const total = res.total || 0;
      state.gridTotals[`${domain}|${groupId}`] = total;
      state.gridTotal = { domain, groupId, total };
      state.gridPending = false; // 首页已到：K 开始按已加载条数计数
      state.gridSlots = { domain, groupId, total };
      // 立即校正当前分组 tab 数字（与搜索栏 0/Total 同源），不必等延后的 GET_STATS
      store.notify("grid-total", { domain, groupId, total });
      const first = (res[meta.itemKey] || []).filter((w) => w && w.awemeId);
      // 域数组不变量 = savedAt 降序：saved 升序块反转；authorCount 页序是作者视图序，
      // 必须按 savedAt 重排后再落库（trusted 视图的展示序另存 authorViewOrder.items）
      const domainItems =
        sort === "authorCount"
          ? sortSavedAtDesc(first)
          : ascending
            ? [...first].reverse()
            : first;
      store.set(domain, domainItems);
      if (sort === "authorCount") {
        state.authorViewOrder = {
          domain,
          groupId,
          direction,
          items: first.slice(),
          counts: new Map(res.authorMeta || []),
          complete: !res.hasMore,
        };
      }
      // 首屏错峰：等首页渲染落笔 + 首屏填充跑一轮后再启动余页串行拉取（见 _fireFirstScreenOnRender）
      this._fireFirstScreenOnRender(firstScreen);
      if (res.hasMore) await firstScreen.promise;
      if (stale()) return;
      let pages = 1;
      while (res.hasMore) {
        res = await this.bgMsg({
          type: "GET_" + domain.toUpperCase(),
          groupId,
          cursor: res.nextCursor,
          sort,
          direction,
          ascending,
        });
        if (res.error) {
          const err = new Error(res.error);
          err.code = res.code;
          if (sort === "authorCount") {
            // authorCount 的错误必须上抛：VIEW_EXPIRED / AUTHOR_VIEW_INCOMPLETE 由
            // appShell 重试/降级；吞掉会让网格停在部分页且顺序口径失配
            throw err;
          }
          // saved 游标续页失败（SW 被强制重启等）：网格停在已加载部分，下次加载自愈；
          // 筛选态下逐页为静默累积、done 不会再来，必须补一次重渲
          console.warn("[DDM] grid load stopped:", res.error);
          store.notify(domain);
          break;
        }
        if (stale()) return;
        pages++;
        const pageItems = (res[meta.itemKey] || []).filter((w) => w && w.awemeId);
        if (sort === "authorCount") store.appendAuthorViewRecord(domain, groupId, pageItems, !res.hasMore, direction);
        else if (ascending) store.prependWorkRecord(domain, groupId, pageItems, !res.hasMore);
        else store.appendWorkRecord(domain, groupId, pageItems, !res.hasMore);
      }
      console.debug(
        `[DDM] grid load ${domain}/${groupId} (${sort}): ${pages} page(s) in ${Math.round(
          performance.now() - t0,
        )}ms`,
      );
    } finally {
      this._gridLoadCount--;
    }
  },

  async deleteAuthorRecords(domain, uids) {
    return this.bgMsg({ type: "DELETE_" + domain.toUpperCase(), uids });
  },

  async moveAuthorRecords(domain, uids, targetGroupId) {
    return this.bgMsg({ type: "MOVE_" + domain.toUpperCase(), uids, targetGroupId });
  },

  // 找/建「稍后删除」分组并把条目移入（五域通用；
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
  deleteWorkRecord(domain, awemeIds) {
    return this.bgMsg({ type: "DELETE_" + domain.toUpperCase(), awemeIds });
  },

  moveWorkRecord(domain, awemeIds, targetGroupId) {
    return this.bgMsg({ type: "MOVE_" + domain.toUpperCase(), awemeIds, targetGroupId });
  },
};
