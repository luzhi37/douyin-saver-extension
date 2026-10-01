// ---------- SearchBar ----------
import { config, dom, state } from '../core.js';
import { followingsGrid } from '../grids/followings-grid.js';
import { worksGrid, likesGrid, favoritesGrid } from '../grids/works-grid.js';
import { batch } from '../data/batch.js';

// ---------- 检索：搜索/排序 ----------
// 数据层过滤（docs/UI_IMPROVEMENTS.md 建议5）：state.works/followings 保持全量，
// 网格与 Detail 统一从视图函数取列表；VirtualGrid 按 id 解析点击，不受过滤影响。
// 视图函数返回共享缓存数组（三段流水线见 #viewCache），调用方一律只读——不得原地
// sort/reverse/push 返回数组，需要变更序自行拷贝

// ---------- 归一化字段侧表 ----------
// 记录对象 → 小写匹配字段惰性缓存：关键词过滤每遍对每条记录做 toLowerCase 的成本
// （10 万条 × 3 字段 ≈ 30 万次字符串分配/遍）收敛为每条一次。用 WeakMap 而非往记录
// 上挂字段：记录会经 EXPORT_DATA 原样序列化，挂字段会污染导出 JSON；options 侧内容
// 更新一律整对象替换（applyStoreUpserts），旧对象连同缓存一并失效，无脏读
const lcMemo = new WeakMap();
function lcFields(w) {
  let m = lcMemo.get(w);
  if (!m) {
    m = {
      desc: (w.desc || "").toLowerCase(),
      nick: (w.nickname || "").toLowerCase(),
      id: String(w.awemeId ?? "").toLowerCase(),
      uidStr: w.uid == null ? "" : String(w.uid),
      uidLc: w.uid == null ? "" : String(w.uid).toLowerCase(),
      ak: w.uid || w.nickname || "", // 作者簇键（authorCount 排序口径，与 rank Map 同源）
    };
    lcMemo.set(w, m);
  }
  return m;
}

class SearchBar {
  #searchState = {
    keyword: "",
    scope: "all", // all 综合 | author 作者(昵称) | title 标题 | id 作品ID/UID
    sort: "saved", // saved 保存时间 | authorCount 作者作品数（仅作品域）
    followingsSort: "followers", // followers 粉丝数 | works 作品数 | update 最近更新（仅关注域）
    followed: true, // 作者归属：已关注（默认勾选，双勾=全部）
    unfollowed: true, // 作者归属：未关注
    workType: "all", // all 全部 | video 视频 | note 图集（仅作品型三域）
    reverse: false, // 逆序（翻转最终顺序，两域共用）
  };

  #debounceTimer = 0;
  // 视图阶段缓存（三段流水线）：base(关键词/类型/归属过滤) → sorted(排序) → view(逆序)。
  // 各段以自身输入签名增量失效：切类型/归属只重算 base 及其后，切排序从缓存 base 重排，
  // 切逆序只翻转一次拷贝。dataVersion（state.dataVersion，写入点自增见 core.js）是数据
  // 侧失效判据，baseSource 引用相等作冗余校验
  #viewCache = { baseKey: "", baseSource: null, base: null, sortKey: "", sorted: null, viewKey: "", view: null };
  // authorCount 全库排名缓存：counts/rank 只依赖数据源本身（关键词只决定谁参与展示），
  // 与筛选正交，按 source 引用缓存
  #rankCache = { source: null, rank: null };
  // 最近一次实际渲染的视图数组（恒等快速路径判据）：refreshGridView 是 renderCards/
  // renderFollowingCards 的唯一调用方，字段仅在其渲染分支写入，「DOM 与该数组一致」
  // 判据不会漂移；域/分组切换必经数据重载（dataVersion 自增 → 数组重建），不存在
  // 「DOM 已被清场但数组恒等」的假跳过
  #lastRenderedView = null;

  constructor() {
    this.#bindEvents();
  }

  // 作品型三域（works/likes/favorites）共用作品视图；followings 独立
  #isWorkLikeDomain() {
    return config.WORK_LIKE_DOMAINS.includes(state.domain);
  }

  // ---------- 数据层：过滤与排序视图 ----------
  isFilterActive() {
    if (this.#ownerFilterActive()) return true;
    // 关键词/逆序本身就是筛选；修复历史缺陷：仅关键词（默认排序）时也须返回 true，
    // 否则搜索无结果的空态会误显示通用文案（P1-8）
    if (this.#searchState.keyword.trim()) return true;
    if (this.#searchState.reverse) return true;
    if (this.#isWorkLikeDomain() && this.#searchState.workType !== "all") return true;
    return this.#isWorkLikeDomain()
      ? this.#searchState.sort !== "saved"
      : this.#searchState.followingsSort !== "followers";
  }

  // 作者归属判定（方案A）：实时关联关注全集 uid。
  // 记录无 uid（作者信息缺失）或关注全集未加载成功时不归判，避免误删已关注作者的作品
  #isFollowedWork(w) {
    return Boolean(w.uid) && state.followedUidsLoaded && state.followedUids.has(String(w.uid));
  }

  #isUnfollowedWork(w) {
    return Boolean(w.uid) && state.followedUidsLoaded && !state.followedUids.has(String(w.uid));
  }

  // 双勾=全部（不筛）；只要任一勾选被取消即进入归属筛选
  #ownerFilterActive() {
    return !(this.#searchState.followed && this.#searchState.unfollowed);
  }

  // 归属筛选是否对当前可见网格生效（服务层刷新关注全集后按需重渲网格）
  isOwnerFilterActive() {
    return this.#isWorkLikeDomain() && this.#ownerFilterActive();
  }

  // 三段流水线（作品型三域）：base(关键词/类型/归属) → sorted(排序) → view(逆序)。
  // 返回共享缓存数组，调用方只读
  getWorksView() {
    const s = this.#searchState;
    const source = state[state.domain]; // 作品型三域：数据源即当前域数组
    const kw = s.keyword.trim().toLowerCase();
    const c = this.#viewCache;
    const baseKey = `${state.domain}|${state.dataVersion}|${kw}|${s.scope}|${s.workType}|${s.followed}|${s.unfollowed}`;
    if (c.baseKey !== baseKey || c.baseSource !== source) {
      c.base = this.#filterWorkLike(source, kw);
      c.baseKey = baseKey;
      c.baseSource = source;
      c.sortKey = "";
    }
    const sortKey = `${baseKey}|${s.sort}`;
    if (c.sortKey !== sortKey) {
      c.sorted = this.#sortWorkLike(c.base, source);
      c.sortKey = sortKey;
      c.viewKey = "";
    }
    const viewKey = `${sortKey}|${s.reverse}`;
    if (c.viewKey !== viewKey) {
      // 逆序必须拷贝后翻转：各段数组被多方共享（网格/Detail/Batch），原地 reverse 会串段
      c.view = s.reverse ? [...c.sorted].reverse() : c.sorted;
      c.viewKey = viewKey;
    }
    return c.view;
  }

  // base 段：关键词 + 类型 + 归属三层过滤（匹配字段走 lcFields 惰性缓存，语义与
  // 历史实现逐字段一致）
  #filterWorkLike(source, kw) {
    const s = this.#searchState;
    let list = source;
    if (kw) {
      // 关键词按「范围」取匹配字段（docs/UI_IMPROVEMENTS.md 建议5）
      list = list.filter((w) => {
        const m = lcFields(w);
        switch (s.scope) {
          case "author":
            // 昵称子串匹配；UID 仅精确匹配——uid 是约 19 位纯数字，子串匹配会让任意数字关键词命中大量无关作者
            return m.nick.includes(kw) || (w.uid && m.uidStr === kw);
          case "title":
            return m.desc.includes(kw);
          case "id":
            return m.id.includes(kw);
          default:
            return m.desc.includes(kw) || m.nick.includes(kw) || m.id.includes(kw);
        }
      });
    }
    if (this.#isWorkLikeDomain() && s.workType !== "all") {
      // 类型筛选（全部/视频/图集）：formatWork 保证 type 只有两值，等值比较即可
      const wantNote = s.workType === "note";
      list = list.filter((w) => (wantNote ? w.type === "note" : w.type === "video"));
    }
    if (this.#isWorkLikeDomain() && this.#ownerFilterActive()) {
      // 已关注/未关注勾选（默认双勾=不筛）：单边勾选仅保留对应归属，两边都未勾则无结果
      // （#ownerFilterActive 保证不会同时为 true，故 followed 优先分支可安全省略双勾判断）
      list = list.filter((w) =>
        s.followed ? this.#isFollowedWork(w) : s.unfollowed ? this.#isUnfollowedWork(w) : false,
      );
    }
    if (list === source) list = [...source]; // 无任何过滤命中：仍拷贝，视图数组与数据源物理解耦
    return list;
  }

  // sorted 段：saved 序保持 bg 端返回的 savedAt 降序（本地变更原地保序，不重复排序）；
  // authorCount 序按全库 rank 升序 + 簇内保存时间降序
  #sortWorkLike(base, source) {
    if (this.#searchState.sort !== "authorCount") return base;
    // 作者作品数按全库口径统计（关键词只决定哪些条目参与展示）：
    // 作者先按作品数降序排名、同数按 key 定序，保证同一作者的作品相邻；簇内按保存时间降序
    const rank = this.#authorRank(source);
    // decorate-sort-undecorate：比较键预计算成并行数组，消掉 comparator 内逐对比较的
    // 重复字符串拼接与 Map 查找（万级列表排序的主要开销）
    const dec = base.map((w) => {
      const m = lcFields(w);
      return { w, r: rank.get(m.ak) ?? 0, s: w.savedAt || 0 };
    });
    dec.sort((a, b) => a.r - b.r || b.s - a.s);
    return dec.map((d) => d.w);
  }

  #authorRank(source) {
    if (this.#rankCache.source === source) return this.#rankCache.rank;
    const counts = new Map();
    for (const w of source) {
      const key = lcFields(w).ak;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const rank = new Map(
      [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || (a < b ? -1 : 1)).map((k, i) => [k, i]),
    );
    this.#rankCache = { source, rank };
    return rank;
  }

  // 三段流水线（关注域）：同 getWorksView，返回共享缓存数组，调用方只读
  getFollowingsView() {
    const s = this.#searchState;
    const source = state.followings;
    const kw = s.keyword.trim().toLowerCase();
    const c = this.#viewCache;
    const baseKey = `followings|${state.dataVersion}|${kw}|${s.scope}`;
    if (c.baseKey !== baseKey || c.baseSource !== source) {
      // 关注域无标题维度：title 范围（域切换残留）按昵称处理。
      // 无关键词也须拷贝后再排序，不得原地改动 state.followings
      c.base = kw
        ? source.filter((f) => {
            const m = lcFields(f);
            switch (s.scope) {
              case "author":
              case "title":
                return m.nick.includes(kw);
              case "id":
                return m.uidLc.includes(kw);
              default:
                return m.nick.includes(kw) || m.uidLc.includes(kw);
            }
          })
        : [...source];
      c.baseKey = baseKey;
      c.baseSource = source;
      c.sortKey = "";
    }
    const sortKey = `${baseKey}|${s.followingsSort}`;
    if (c.sortKey !== sortKey) {
      // 计数字段仅由校准写入、未校准占位为 0，排序时自然沉底；同数按 uid 定序保证稳定。
      // base 为缓存私有数组，原地排序安全
      const field = { works: "awemeCount", update: "lastUpdateAt" }[s.followingsSort] || "followerCount";
      c.sorted = c.base.sort((a, b) => (b[field] || 0) - (a[field] || 0) || String(a.uid).localeCompare(String(b.uid)));
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
  // 域切换后搜索栏的域相关联动：排序段显隐（作品型 vs 关注域各有排序维度）/范围段文案/占位符/分段选中
  syncForDomain() {
    const isWorkLike = this.#isWorkLikeDomain();
    dom.sbWorkFilters.classList.toggle("hidden", !isWorkLike);
    dom.sbFollowFilters.classList.toggle("hidden", isWorkLike);
    this.syncScopeUIForDomain();
    this.#updateSearchPlaceholder();
    this.syncSegUI();
    this.syncCount();
  }

  // store.on("domain") 的搜索栏联动入口：搜索栏展开期间才同步域差异
  onDomainChanged() {
    if (this.#isSearchBarOpen()) this.syncForDomain();
  }

  // 筛选变化后的统一入口：重渲当前域网格 + 刷新结果数。
  // 视图全程只计算一次，同一结果贯穿渲染与计数（历史实现经 renderCards/syncCount 各算
  // 一遍，大库下重复付出整段过滤+排序成本）；结果数组与上次实际渲染恒等时跳过重渲
  // （切了不改变结果集的筛选、重复点击同段），只刷新计数
  refreshGridView() {
    // 视图顺序可能已变（排序/关键词/归属/域/分组/同步）：旧 shift 锚点在新顺序中的
    // 索引与点击时不一致，先清空锚点，防止区间按错误索引圈选
    batch.resetRangeAnchor();
    const isWorkLike = this.#isWorkLikeDomain();
    const view = isWorkLike ? this.getWorksView() : this.getFollowingsView();
    if (view !== this.#lastRenderedView) {
      const grid = isWorkLike ? this.activeWorkLikeGrid() : followingsGrid;
      if (isWorkLike) grid.renderCards(view);
      else grid.renderFollowingCards(view);
      this.#lastRenderedView = view;
    }
    this.syncCount(view.length);
  }

  // 结果数 K/N：K 为当前过滤视图条数，N 为当前域全量条数。
  // count 可由调用方注入（refreshGridView 已持有视图）；缺省经视图函数取（内部有阶段缓存）
  syncCount(count) {
    if (count === undefined) {
      count = this.#isWorkLikeDomain() ? this.getWorksView().length : this.getFollowingsView().length;
    }
    const total = this.#isWorkLikeDomain() ? state[state.domain].length : state.followings.length;
    dom.sbCount.textContent = `${count}/${total}`;
  }

  // 作品型三域 → 对应网格实例（Batch 等外部类也需要按域取网格，公开）
  activeWorkLikeGrid() {
    if (state.domain === "works") return worksGrid;
    if (state.domain === "likes") return likesGrid;
    return favoritesGrid;
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
    dom.sbWorkType.querySelectorAll(".sb-seg-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.wtype === this.#searchState.workType);
    });
    dom.sbFollowed.checked = this.#searchState.followed;
    dom.sbUnfollowed.checked = this.#searchState.unfollowed;
    dom.sbReverse.checked = this.#searchState.reverse;
  }

  // 范围段的域差异：「标题」仅作品型三域；关注域下「作者」按钮文案为「昵称」，残留 title 范围回退综合
  syncScopeUIForDomain() {
    const isWorkLike = this.#isWorkLikeDomain();
    dom.sbScopeTitle.classList.toggle("hidden", !isWorkLike);
    dom.sbScopeAuthor.textContent = isWorkLike ? "作者" : "昵称";
    if (!isWorkLike && this.#searchState.scope === "title") this.#searchState.scope = "all";
  }

  #updateSearchPlaceholder() {
    const placeholders = this.#isWorkLikeDomain()
      ? { all: "搜索标题 / 作者 / ID", author: "输入作者昵称或 UID", title: "输入作品标题文案", id: "输入作品 ID" }
      : { all: "搜索昵称 / UID", author: "输入昵称", title: "输入昵称", id: "输入 UID" };
    dom.searchInput.placeholder = placeholders[this.#searchState.scope] || placeholders.all;
  }

  #isSearchBarOpen() {
    return !dom.searchBar.classList.contains("hidden");
  }

  // ---------- 展开 / 收起 ----------
  openSearchBar() {
    // 已展开时仅重新聚焦（Ctrl+K 二次按下）：不重置输入框，避免打断未应用的输入
    if (this.#isSearchBarOpen()) {
      dom.searchInput.focus();
      dom.searchInput.select();
      return;
    }
    dom.searchBar.classList.remove("hidden");
    // 排序段随域显隐；逆序复选框两域共用
    this.syncForDomain();
    dom.searchInput.value = this.#searchState.keyword;
    dom.searchInput.focus();
    dom.searchInput.select();
  }

  closeSearchBar() {
    if (!this.#isSearchBarOpen()) return;
    // 收起即重置：搜索栏内的关键词/排序/归属勾选等改动一律不保留，
    // 网格恢复全量，下次展开从默认初始状态开始
    this.clearSearchFilters();
    dom.searchBar.classList.add("hidden");
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
    this.#searchState.followed = true;
    this.#searchState.unfollowed = true;
    this.#searchState.workType = "all";
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
    dom.sbWorkType.addEventListener("click", (e) => {
      const btn = e.target.closest(".sb-seg-btn");
      if (!btn) return;
      this.#searchState.workType = btn.dataset.wtype;
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
    dom.sbFollowed.addEventListener("change", () => {
      this.#searchState.followed = dom.sbFollowed.checked;
      this.refreshGridView();
    });
    dom.sbUnfollowed.addEventListener("change", () => {
      this.#searchState.unfollowed = dom.sbUnfollowed.checked;
      this.refreshGridView();
    });
    dom.btnClearInBar.addEventListener("click", () => this.clearSearchFilters());
    dom.btnCloseSearch.addEventListener("click", () => this.closeSearchBar());
    dom.btnSearchMenu.addEventListener("click", () => this.toggleSearchBar());
  }
}

export const search = new SearchBar();
