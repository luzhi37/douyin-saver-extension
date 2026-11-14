// ---------- SearchBar ----------
import { config, dom, state, services, utils } from '../core.js';
import { authorKeyOf, buildAuthorRank } from "../../shared/author-sort.js";
import { followingsGrid, candidatesGrid, reviewAuthorsGrid } from '../grids/author-grid.js';
import { worksGrid, favoritesGrid, collectionsGrid, reviewWorksGrid } from '../grids/works-grid.js';
import { noteProgrammaticScroll } from '../grids/virtual-grid.js';
import { batch } from '../data/batch.js';
import { SelectMenu } from './select-menu.js';

// ---------- 检索：搜索/排序 ----------
// 数据层过滤（见 docs/11）：state.works/followings 保持全量，
// 网格与 Detail 统一从视图函数取列表；VirtualGrid 按 id 解析点击，不受过滤影响。
// 视图函数返回共享缓存数组（三段流水线见 #viewCache），调用方一律只读——不得原地
// sort/reverse/push 返回数组，需要变更序自行拷贝

// 纯数字关键词额外参与 UID 匹配；昵称匹配始终生效（纯数字昵称不得被漏掉）
const UID_QUERY_RE = /^\d+$/;

// ---------- 归一化字段侧表 ----------
// 记录对象 → 小写匹配字段惰性缓存：关键词过滤每遍对每条记录做 toLowerCase 的成本
// （10 万条 × 2 字段 ≈ 20 万次字符串分配/遍）收敛为每条一次。用 WeakMap 而非往记录
// 上挂字段：记录会经 EXPORT_DATA 原样序列化，挂字段会污染导出 JSON；options 侧内容
// 更新一律整对象替换（applyStoreUpserts），旧对象连同缓存一并失效，无脏读
const lcMemo = new WeakMap();
function lcFields(w) {
  let m = lcMemo.get(w);
  if (!m) {
    m = {
      nick: (w.nickname || "").toLowerCase(),
      uidLc: w.uid == null ? "" : String(w.uid).toLowerCase(),
      ak: authorKeyOf(w), // 作者簇键（authorCount 排序口径，与 rank Map / 后台视图同源）
    };
    lcMemo.set(w, m);
  }
  return m;
}

class SearchBar {
  #searchState = {
    keyword: "",
    sort: "saved", // saved 保存时间 | authorCount 作者作品数（仅作品型三域）
    followingsSort: "works", // works 作品数 | update 最近更新（仅关注域）
    workType: "all", // 作品类型（仅作品型三域）：all 全部 | video 视频 | note 图集
    reverse: false, // 方向标志（false=(降) / true=(升)）：随排序下拉 token（key-desc/key-asc）一次性设定。
    // 保存时间等键由 view 段整体翻转；authorCount 的方向改在 sorted 段比较器内生效（见 getWorksView）
  };

  // 视图阶段缓存（三段流水线）：base(关键词/类型过滤) → sorted(排序) → view(逆序)。
  // 各段以自身输入签名增量失效：切类型只重算 base 及其后，切排序从缓存 base 重排，
  // 切逆序只翻转一次拷贝。dataVersion（state.dataVersion，写入点自增见 core.js）是数据
  // 侧失效判据，baseSource 引用相等作冗余校验
  #viewCache = { baseKey: "", baseSource: null, base: null, sortKey: "", sorted: null, viewKey: "", view: null };
  // authorCount 全库排名缓存：counts/rank 只依赖数据源本身（关键词只决定谁参与展示），
  // 与筛选正交。失效判据必须用 dataVersion（而非 source 引用）——作品域数组经
  // appendWorkRecord/tryHeadInsert/applyStoreUpserts 原地变更、引用不变，仅 dataVersion 自增；
  // 只看引用会让早快照（首页/首屏）算出的 rank 永久滞留，后到作品漏统计（rank 缺失→按 0
  // 排到最前，大量作者挤在顶部；已有作者计数被低估→排到中后段），表现为「作品数排序乱」。
  // source 引用保留作冗余校验
  #rankCache = { version: -1, source: null, rank: null };
  // 最近一次实际渲染的视图数组（恒等快速路径判据）：refreshGridView 是 renderCards/
  // renderAuthorCards 的唯一调用方，字段仅在其渲染分支写入，「DOM 与该数组一致」
  // 判据不会漂移；域/分组切换必经数据重载（dataVersion 自增 → 数组重建），不存在
  // 「DOM 已被清场但数组恒等」的假跳过
  #lastRenderedView = null;
  // authorCount 写入/切离时由 main.js 注入的整域重载入口（避免 SearchBar 反向依赖 app-shell）
  #reloadHandler = null;
  // 四个自绘下拉的统一控制器（键盘/ARIA/开合/选中；DOM 结构由 options.html 提供）
  #selects = null;

  constructor() {
    this.#selects = this.#buildSelects();
    this.#bindEvents();
    this.syncPagingState();
  }

  // 作品型三域（works/favorites/collections）与回顾域作品批次共用作品视图；
  // 回顾域作者批次走作者视图
  #isWorkRecordDomain() {
    return utils.isWorkRecordDomain();
  }

  // ---------- 数据层：过滤与排序视图 ----------
  isFilterActive() {
    // 关键词/逆序本身就是筛选；修复历史缺陷：仅关键词（默认排序）时也须返回 true，
    // 否则搜索无结果的空态会误显示通用文案
    if (this.#searchState.keyword.trim()) return true;
    if (this.#searchState.reverse) return true;
    if (this.#isWorkRecordDomain() && this.#searchState.workType !== "all") return true;
    return this.#isWorkRecordDomain()
      ? this.#searchState.sort !== "saved"
      : this.#searchState.followingsSort !== "works";
  }

  // 当前分页模式：saved 走 keyset（ascending 仅保存时间升序）；authorCount 走后台
  // 作者视图游标（方向翻转作者簇，不翻转簇内）。review 域不参与 authorCount 分页
  fetchPagingMode() {
    if (!config.AUTHOR_COUNT_PAGING || !config.WORK_RECORD_DOMAINS.includes(state.domain)) {
      return { sort: "saved", direction: "desc", ascending: false };
    }
    if (this.#searchState.sort === "authorCount") {
      return { sort: "authorCount", direction: this.#searchState.reverse ? "asc" : "desc", ascending: false };
    }
    return { sort: "saved", direction: "desc", ascending: this.#searchState.reverse };
  }

  // 降级专用：搜索栏仍显示“作品数”，但分页按 saved 拉取（AUTHOR_VIEW_INCOMPLETE）
  fetchSavedPaging() {
    return { sort: "saved", direction: "desc", ascending: this.#searchState.reverse };
  }

  syncPagingState() {
    state.pagingMode = this.fetchPagingMode();
  }

  // 页序是否与当前视图序单调一致（可逐页按视图下标续填，无需完成态整渲）：
  // saved 按 ascending 与 reverse 对齐；authorCount 要求 trusted 视图 + 方向一致。
  // 任一失配 → 静默累积 + 完成态整渲兜底
  isPageAligned(event) {
    if (!this.#isWorkRecordDomain()) return false;
    if (this.#searchState.sort === "authorCount") {
      return (
        event?.mode === "authorCount" &&
        event.direction === state.pagingMode.direction &&
        this.#isAuthorOrderTrusted()
      );
    }
    return event?.mode === "saved" && Boolean(event.ascending) === this.#searchState.reverse;
  }

  // authorCount 是否处于可信视图态（batch / detail 据此判断走本地收口还是整域重载）
  isAuthorOrderActive() {
    return state.pagingMode.sort === "authorCount" && Boolean(state.authorViewOrder);
  }

  #isAuthorOrderTrusted() {
    const order = state.authorViewOrder;
    return Boolean(
      state.pagingMode.sort === "authorCount" &&
        this.#searchState.sort === "authorCount" &&
        order &&
        order.domain === state.domain &&
        order.groupId === state.currentGroupId &&
        order.direction === state.pagingMode.direction,
    );
  }

  // authorCount 完整视图下是否允许本地增量摘卡：当前 trusted 视图的所有作者页均已到达、
  // 且不在分页加载中。任一不满足都必须整域重载校准（在途游标与本地顺序不可混用）。
  // 顺序刻意保持稳定（不立即重排），显式切排序/分组/域时由后台作者视图恢复严格序
  isAuthorViewPatchable() {
    const order = state.authorViewOrder;
    return Boolean(
      this.#isAuthorOrderTrusted() &&
        order.complete === true &&
        !services.isGridLoading(),
    );
  }

  setReloadHandler(fn) {
    this.#reloadHandler = typeof fn === "function" ? fn : null;
  }

  reloadForPageOrder(options) {
    if (this.#reloadHandler) return this.#reloadHandler(options);
    this.refreshGridView(true);
    return undefined;
  }

  // 页级过滤（对齐模式逐页续填用）：只做关键词/类型过滤、保持页内顺序；无筛选返回原数组。
  // 页到达序已与视图序一致，过滤后仍是视图的子序列，可按下标续填
  filterPageForView(items) {
    const kw = this.#searchState.keyword.trim().toLowerCase();
    const typeAll = !this.#isWorkRecordDomain() || this.#searchState.workType === "all";
    if (!kw && typeAll) return items;
    return items.filter((w) => this.#matchWorkRecord(w, kw));
  }

  // 三段流水线（作品型三域）：base(关键词/类型) → sorted(排序) → view(逆序)。
  // 返回共享缓存数组，调用方只读
  getWorksView() {
    const s = this.#searchState;
    const source = state[state.domain]; // 作品型三域：数据源即当前域数组
    const kw = s.keyword.trim().toLowerCase();
    const c = this.#viewCache;
    // authorCount trusted：items 已是后台权威视图序，只做关键词/类型过滤，
    // 跳过 rank、排序与 reverse 翻转（方向已由后台作者簇顺序表达）
    if (this.#isAuthorOrderTrusted()) {
      const items = state.authorViewOrder.items;
      const baseKey = `authorCount|${state.domain}|${state.currentGroupId}|${state.authorViewOrder.direction}|${state.dataVersion}|${kw}|${s.workType}`;
      if (c.baseKey !== baseKey) {
        const needsFilter = Boolean(kw) || s.workType !== "all";
        c.base = needsFilter ? this.#filterWorkRecord(items, kw) : items;
        c.baseKey = baseKey;
        c.baseSource = items;
        c.sortKey = baseKey;
        c.viewKey = baseKey;
      }
      return c.base;
    }
    const baseKey = `${state.domain}|${state.dataVersion}|${kw}|${s.workType}`;
    if (c.baseKey !== baseKey || c.baseSource !== source) {
      c.base = this.#filterWorkRecord(source, kw);
      c.baseKey = baseKey;
      c.baseSource = source;
      c.sortKey = "";
    }
    // authorCount 的内部次序含方向（作品数升/降）与固定的二级序（发布时间恒从新到旧），
    // 方向必须并入 sortKey 触发重排；其余排序键的方向仍由 view 段整体翻转
    const sortKey = `${baseKey}|${s.sort}${s.sort === "authorCount" ? `|${s.reverse}` : ""}`;
    if (c.sortKey !== sortKey) {
      c.sorted = this.#sortWorkRecord(c.base, source);
      c.sortKey = sortKey;
      c.viewKey = "";
    }
    const viewKey = `${sortKey}|${s.reverse}`;
    if (c.viewKey !== viewKey) {
      // 逆序必须拷贝后翻转：各段数组被多方共享（网格/Detail/Batch），原地 reverse 会串段。
      // authorCount 的 sorted 已是含方向的终序，再整体翻转让簇内发布时间变成从旧到新，故跳过
      const flip = s.reverse && s.sort !== "authorCount";
      c.view = flip ? [...c.sorted].reverse() : c.sorted;
      c.viewKey = viewKey;
    }
    return c.view;
  }

  // base 段：关键词 + 类型两层过滤（匹配字段走 lcFields 惰性缓存；昵称子串始终
  // 参与，纯数字关键词额外按作者 uid 匹配，行为与搜索栏提示文案严格对齐）
  #filterWorkRecord(source, kw) {
    const s = this.#searchState;
    let list = source;
    if (kw || (this.#isWorkRecordDomain() && s.workType !== "all")) {
      list = list.filter((w) => this.#matchWorkRecord(w, kw));
    }
    if (list === source) list = [...source]; // 无任何过滤命中：仍拷贝，视图数组与数据源物理解耦
    return list;
  }

  // 单条匹配（base 段与页级续填 filterPageForView 共用同一口径）
  #matchWorkRecord(w, kw) {
    const s = this.#searchState;
    if (kw) {
      // 昵称子串匹配始终生效（纯数字昵称同样可搜）；纯数字关键词额外按作者 UID
      // 精确匹配（uid 约 19 位纯数字；作品 awemeId 不参与任何关键词匹配）
      const m = lcFields(w);
      const nickHit = m.nick.includes(kw);
      if (!nickHit && !(UID_QUERY_RE.test(kw) && m.uidLc === kw)) return false;
    }
    if (this.#isWorkRecordDomain() && s.workType !== "all") {
      // 类型下拉（全部/视频/图集，默认全部）：formatWork 保证 type 只有两值
      return w.type === "note" ? s.workType === "note" : s.workType === "video";
    }
    return true;
  }

  // sorted 段：saved 序保持 bg 端返回的 savedAt 降序（本地变更原地保序，不重复排序）；
  // authorCount 序仅两层：作品数量随方向升/降，簇内发布时间（Unix 秒）恒从新到旧
  #sortWorkRecord(base, source) {
    const sort = this.#searchState.sort;
    if (sort !== "authorCount") return base;
    // 作者作品数按全库口径统计（关键词只决定哪些条目参与展示）：
    // rank 0 = 作品数最多；默认 (降) 按 rank 升序（多→少），(升) 按 rank 降序（少→多）
    const rank = this.#authorRank(source);
    const reverse = this.#searchState.reverse;
    // decorate-sort-undecorate：比较键预计算成并行数组，消掉 comparator 内逐对比较的
    // 重复字符串拼接与 Map 查找（万级列表排序的主要开销）
    const dec = base.map((w) => {
      const m = lcFields(w);
      return {
        w,
        r: rank.get(m.ak) ?? 0,
        t: Number(w.createTime) || 0,
        sa: Number(w.savedAt) || 0,
        id: String(w.awemeId ?? ""),
      };
    });
    dec.sort(
      (a, b) =>
        (reverse ? b.r - a.r : a.r - b.r) ||
        b.t - a.t ||
        b.sa - a.sa ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
    return dec.map((d) => d.w);
  }

  #authorRank(source) {
    // authorCount page0 的全组 counts 是权威口径；本地 fallback 时优先用它，避免
    // 只加载到部分页时 rank 缺失/低估导致作者簇位置漂移
    const order = state.authorViewOrder;
    if (
      order &&
      order.domain === state.domain &&
      order.groupId === state.currentGroupId &&
      order.counts &&
      order.counts.size > 0
    ) {
      return buildAuthorRank(order.counts);
    }
    // 失效判据 = dataVersion 且 source 引用（原地追加变更引用不变，dataVersion 是唯一可靠信号）
    if (this.#rankCache.version === state.dataVersion && this.#rankCache.source === source) {
      return this.#rankCache.rank;
    }
    const counts = new Map();
    for (const w of source) {
      const key = lcFields(w).ak;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const rank = buildAuthorRank(counts);
    this.#rankCache = { version: state.dataVersion, source, rank };
    return rank;
  }

  // 三段流水线（作者域：followings/candidates）：同 getWorksView，返回共享缓存数组，调用方只读
  getAuthorRecordsView() {
    const s = this.#searchState;
    const domain = state.domain;
    const source = state[domain];
    const kw = s.keyword.trim().toLowerCase();
    const c = this.#viewCache;
    const baseKey = `author|${domain}|${state.dataVersion}|${kw}`;
    if (c.baseKey !== baseKey || c.baseSource !== source) {
      // 无关键词也须拷贝后再排序，不得原地改动 state[domain]
      c.base = kw
        ? source.filter((f) => {
            const m = lcFields(f);
            // 昵称子串始终参与；纯数字关键词额外按 uid 子串（作者域无作品 ID 维度）
            return m.nick.includes(kw) || (UID_QUERY_RE.test(kw) && m.uidLc.includes(kw));
          })
        : [...source];
      c.baseKey = baseKey;
      c.baseSource = source;
      c.sortKey = "";
    }
    const sortKey = `${baseKey}|${s.followingsSort}`;
    if (c.sortKey !== sortKey) {
      // 计数字段仅由校准写入、未校准占位为 0，排序时自然沉底；同数按 uid 定序保证稳定。
      // 必须拷贝后排序、不得原地 sort base：refreshGridView 以「引用恒等 ⇒ 内容恒等」
      // 跳过重渲，原地排序会让 sorted/view 与上次渲染数组同引用（内容却已变），切作品数/
      // 最近更新被误判无变化而跳过重渲（2026-10-03 修复）；拷贝成本 O(n) 远低于排序
      const field = s.followingsSort === "update" ? "lastUpdateAt" : "awemeCount";
      c.sorted = [...c.base].sort((a, b) => (b[field] || 0) - (a[field] || 0) || String(a.uid).localeCompare(String(b.uid)));
      c.sortKey = sortKey;
      c.viewKey = "";
    }
    const viewKey = `${sortKey}|${s.reverse}`;
    if (c.viewKey !== viewKey) {
      c.view = s.reverse ? [...c.sorted].reverse() : c.sorted;
      c.viewKey = viewKey;
    }
    return c.view;
  }

  // ---------- UI 同步 ----------
  // 域切换后搜索栏的域相关联动：筛选组显隐（作品型 vs 关注域各有排序维度）/占位符/下拉选中
  syncForDomain() {
    const isWorkRecord = this.#isWorkRecordDomain();
    dom.sbWorkFilters.classList.toggle("hidden", !isWorkRecord);
    dom.sbFollowFilters.classList.toggle("hidden", isWorkRecord);
    this.syncFilterUI();
    this.syncCount();
  }

  // 筛选变化后的统一入口：重渲当前域网格 + 刷新结果数。
  // 视图全程只计算一次，同一结果贯穿渲染与计数（历史实现经 renderCards/syncCount 各算
  // 一遍，大库下重复付出整段过滤+排序成本）；结果数组与上次实际渲染恒等时跳过重渲
  // （切了不改变结果集的筛选、重复点击同段），只刷新计数。
  // resetScroll：用户重定义结果集（排序/关键词/类型/逆序/清除）时传 true——
  // 重渲后显式回顶。尾部占位（#syncTailReserve）使「wipe clamp 天然回顶」失效（重渲任务内
  // 总高即恢复终值、旧偏移合法存留），不显式归零会表现为「跟随锚点」停在深处
  refreshGridView(resetScroll = false) {
    // 锚点属旧视图：用户重定义结果集（排序/关键词/类型/逆序/清除）且视图确已变化时，
    // 选区与 Shift 锚点一并作废（批量模式保留）——重排后旧选区会散落到视口/挂载窗口外
    // 不可见却仍参与批量移动/删除；锚点同理且位置不可见，保留会让重排后的首次 Shift
    // 点击跨到任意位置、圈出大段区间（2026-10-29 定案，见 docs/11「Shift 连选」）。
    // 跨域安全由 switchDomain 清选区+退出批量兜底
    const isWorkRecord = this.#isWorkRecordDomain();
    const view = isWorkRecord ? this.getWorksView() : this.getAuthorRecordsView();
    if (resetScroll && view !== this.#lastRenderedView) batch.resetSelection();
    if (view !== this.#lastRenderedView) {
      const grid = this.gridForDomain();
      if (isWorkRecord) grid.renderCards(view);
      else grid.renderAuthorCards(view);
      this.#lastRenderedView = view;
      if (resetScroll) {
        dom.mainGrid.scrollTop = 0;
        noteProgrammaticScroll();
      }
    }
    this.syncCount(view.length);
  }

  // 结果数 K：当前过滤视图条数。N 不再展示——分组按钮（全部/当前组）已给出总量。
  // count 可由调用方注入（refreshGridView 已持有视图）；缺省经视图函数取（内部有阶段缓存）。
  // 切域/切组后首屏未到的空窗（gridPending）K 恒 0：有同源分组缓存时显示 0，
  // 无缓存才显示占位「…」；首页到达后随各刷新路径更新
  syncCount(count) {
    const gt = state.gridTotal;
    const match = gt && gt.domain === state.domain && gt.groupId === state.currentGroupId;
    if (state.gridPending) {
      dom.sbCount.textContent = match ? "0" : "…";
      return;
    }
    if (count === undefined) {
      count = this.#isWorkRecordDomain() ? this.getWorksView().length : this.getAuthorRecordsView().length;
    }
    dom.sbCount.textContent = String(count);
  }

  // 各域 → 网格实例统一映射（AppShell / Batch 等按域取网格共用）
  gridForDomain(domain = state.domain) {
    if (domain === "followings") return followingsGrid;
    if (domain === "candidates") return candidatesGrid;
    if (domain === "favorites") return favoritesGrid;
    if (domain === "collections") return collectionsGrid;
    if (domain === "review") return state.reviewKind === "authors" ? reviewAuthorsGrid : reviewWorksGrid;
    return worksGrid;
  }

  // 作品型三域 → 对应网格实例（Batch 等外部类也需要按域取网格，公开）
  activeWorkRecordGrid() {
    return this.gridForDomain();
  }

  syncFilterUI() {
    // 下拉（类型/作品排序/作者域排序同构）：值文案随激活项，激活项白字 600 字重，
    // 选中语义由 aria-selected 承担（不显示 ✓，红字对比度不达 AA，2026-11-09 定案）
    this.#selects.type.sync(this.#searchState.workType, "全部");
    // 排序下拉：排序键与方向合并为单值（key-desc / key-asc），两域各自一套 token
    const dir = this.#searchState.reverse ? "asc" : "desc";
    this.#selects.sort.sync(`${this.#searchState.sort}-${dir}`, "保存时间(降)");
    this.#selects.followSort.sync(`${this.#searchState.followingsSort}-${dir}`, "作品数(降)");
  }

  #closeAllSelectMenus() {
    for (const select of Object.values(this.#selects)) select.close();
  }

  // ---------- 重置 ----------
  // 搜索态全量重置（域切换用：重置筛选 + 收起下拉菜单）；搜索框常驻，不存在收起态。
  // refresh=false 时重置不做重渲——网格随域切换即清场重载
  resetSearchState(refresh = true) {
    this.clearSearchFilters(refresh);
    this.#closeAllSelectMenus();
  }

  // 显式搜索：输入不即时响应，回车（IME 组合中让位）或点击 🔍 才实施
  applySearchInput() {
    this.#searchState.keyword = dom.searchInput.value;
    // 实施搜索后输入框失焦：光标不再滞留文本区，键盘焦点交还给页面（避免后续按键被输入框吞掉）
    dom.searchInput.blur();
    this.refreshGridView(true);
  }

  // ✕ 按钮：仅清除搜索输入文本（去掉关键词过滤），其余筛选（排序/类型）就地保留
  clearSearchInput() {
    dom.searchInput.value = "";
    if (!this.#searchState.keyword) return; // 无关键词：无过滤可去，无需重渲
    this.#searchState.keyword = "";
    this.refreshGridView(true);
  }

  clearSearchFilters(refresh = true) {
    // 无变化退出早退：状态已是默认（筛选从未激活、或改过又已回到默认）时网格无需任何
    // 处理——数据侧每次变化（分页/自动捕获/头插）都已有各自的增量同步通道，DOM 即默认
    // 视图的最新内容；此时若仍刷新，只会因视图缓存随 dataVersion 重建、数组身份失配而
    // 白闪一次（wipe + cap 1500 重挂，视口封面清空再回填）。判据须在重置状态前捕获
    const wasActive = this.isFilterActive();
    const wasAuthorCount = this.#searchState.sort === "authorCount";
    this.#searchState.keyword = "";
    this.#searchState.sort = "saved";
    this.#searchState.followingsSort = "works";
    this.#searchState.workType = "all";
    this.#searchState.reverse = false;
    dom.searchInput.value = "";
    this.syncFilterUI();
    this.syncPagingState();
    if (wasAuthorCount) state.authorViewOrder = null;
    if (wasActive && refresh) {
      // 离开 authorCount 且加载未完成：旧载页序与新 pagingMode 混合，整域重载；
      // 其余场景 state[domain] 已是 savedAt 序，本地重排即可
      if (wasAuthorCount && services.isGridLoading()) this.reloadForPageOrder();
      else this.refreshGridView(true);
    }
  }

  // ---------- 下拉控制器 ----------
  // 三个下拉的差异只在「选中后写哪个状态」，开合/键盘/ARIA 统一由 SelectMenu 承担
  #buildSelects() {
    return {
      type: new SelectMenu(
        dom.sbType,
        (opt) => {
          this.#searchState.workType = opt.dataset.type;
          this.syncFilterUI();
          this.refreshGridView(true);
        },
        { optionAttr: "data-type" },
      ),
      sort: new SelectMenu(
        dom.sbSort,
        (opt) => {
          const raw = opt.dataset.sort;
          const sep = raw.lastIndexOf("-");
          const prevSort = this.#searchState.sort;
          this.#searchState.sort = raw.slice(0, sep);
          this.#searchState.reverse = raw.slice(sep + 1) === "asc";
          this.syncFilterUI();
          this.syncPagingState();
          // 进入/离开 authorCount 或加载中途切排序：旧页序与新视图口径不一致，整域重载；
          // 其余本地可重排（authorCount → saved 时 state[domain] 已是 savedAt 序）
          if (
            this.#searchState.sort === "authorCount" ||
            prevSort === "authorCount" ||
            services.isGridLoading()
          ) {
            this.reloadForPageOrder();
          } else {
            this.refreshGridView(true);
          }
        },
        { optionAttr: "data-sort" },
      ),
      followSort: new SelectMenu(
        dom.sbFollowSort,
        (opt) => {
          const raw = opt.dataset.fsort;
          const sep = raw.lastIndexOf("-");
          this.#searchState.followingsSort = raw.slice(0, sep);
          this.#searchState.reverse = raw.slice(sep + 1) === "asc";
          this.syncFilterUI();
          this.refreshGridView(true);
        },
        { optionAttr: "data-fsort" },
      ),
    };
  }

  // ---------- 事件绑定 ----------
  #bindEvents() {
    // 显式搜索：回车（IME 组合中让位）或点击 🔍 按钮
    dom.searchInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      this.applySearchInput();
    });
    dom.btnSearchGo.addEventListener("click", () => this.applySearchInput());
    dom.btnClearInBar.addEventListener("click", () => this.clearSearchInput());
  }
}

export const search = new SearchBar();
