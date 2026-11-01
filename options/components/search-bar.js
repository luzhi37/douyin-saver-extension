// ---------- SearchBar ----------
import { config, dom, state, services } from '../core.js';
import { followingsGrid, candidatesGrid } from '../grids/author-grid.js';
import { worksGrid, favoritesGrid, collectionsGrid } from '../grids/works-grid.js';
import { batch } from '../data/batch.js';

// ---------- 检索：搜索/排序 ----------
// 数据层过滤（见 docs/11）：state.works/followings 保持全量，
// 网格与 Detail 统一从视图函数取列表；VirtualGrid 按 id 解析点击，不受过滤影响。
// 视图函数返回共享缓存数组（三段流水线见 #viewCache），调用方一律只读——不得原地
// sort/reverse/push 返回数组，需要变更序自行拷贝

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
      desc: (w.desc || "").toLowerCase(),
      nick: (w.nickname || "").toLowerCase(),
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
    scope: "author", // author 作者昵称(默认) | title 标题(仅作品型三域) | id 作者UID精确（关注域=uid子串）
    sort: "saved", // saved 保存时间 | authorCount 作者作品数（仅作品型三域）
    followingsSort: "works", // works 作品数 | update 最近更新（仅关注域）
    workType: "all", // 作品类型（仅作品型三域）：all 全部 | video 视频 | note 图集
    reverse: false, // 方向标志（false=(降) / true=(升)）：点激活排序键翻转、切键回默认。
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

  constructor() {
    this.#bindEvents();
  }

  // 作品型三域（works/favorites/collections）共用作品视图；followings 独立
  #isWorkRecordDomain() {
    return config.WORK_RECORD_DOMAINS.includes(state.domain);
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

  // 取数方向：升序「保存时间(升)」需从最旧一端分页（loadDomainData 的方向参数）。
  // 仅作品型三域的 saved 排序键可对齐；作者数排序页序由全库 rank 决定，方向无意义
  fetchAscending() {
    return this.#isWorkRecordDomain() && this.#searchState.sort === "saved" && this.#searchState.reverse;
  }

  // 页序是否与当前视图序单调一致（可逐页按视图下标续填，无需完成态整渲）：
  // saved 排序键天然可按取数方向对齐；作者数排序的 rank 依赖全量数据，一律不可对齐。
  // 取数方向须与当前视图方向一致——加载中途切排序/逆序会失配，交回静默累积 + 完成整渲
  isPageAligned(ascending) {
    if (!this.#isWorkRecordDomain() || this.#searchState.sort !== "saved") return false;
    return Boolean(ascending) === this.#searchState.reverse;
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
    const baseKey = `${state.domain}|${state.dataVersion}|${kw}|${s.scope}|${s.workType}`;
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

  // base 段：关键词 + 类型两层过滤（匹配字段走 lcFields 惰性缓存；各范围匹配
  // 字段与口径见 #searchState.scope 注释，行为与搜索栏提示文案严格对齐）
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
      // 关键词按「范围」取匹配字段（见 docs/11）
      const m = lcFields(w);
      switch (s.scope) {
        case "author":
          // 昵称子串匹配；UID 查找归「ID」范围（2026-10-14 起行为严格对齐提示文案）
          if (!m.nick.includes(kw)) return false;
          break;
        case "title":
          if (!m.desc.includes(kw)) return false;
          break;
        case "id":
          // 作者 UID 精确（uid 约 19 位纯数字，子串匹配会让任意数字关键词大面积误命中）；
          // 作品 awemeId 不参与任何关键词匹配
          if (m.uidLc !== kw) return false;
          break;
        default:
          return false; // 未知范围：按旧实现（switch 无命中返回 undefined）不匹配
      }
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
      return { w, r: rank.get(m.ak) ?? 0, t: w.createTime || 0 };
    });
    dec.sort((a, b) => (reverse ? b.r - a.r : a.r - b.r) || b.t - a.t);
    return dec.map((d) => d.w);
  }

  #authorRank(source) {
    // 失效判据 = dataVersion 且 source 引用（原地追加变更引用不变，dataVersion 是唯一可靠信号）
    if (this.#rankCache.version === state.dataVersion && this.#rankCache.source === source) {
      return this.#rankCache.rank;
    }
    const counts = new Map();
    for (const w of source) {
      const key = lcFields(w).ak;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const rank = new Map(
      [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || (a < b ? -1 : 1)).map((k, i) => [k, i]),
    );
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
    const baseKey = `author|${domain}|${state.dataVersion}|${kw}|${s.scope}`;
    if (c.baseKey !== baseKey || c.baseSource !== source) {
      // 作者域无标题维度：title 范围（域切换残留）按昵称处理。
      // 无关键词也须拷贝后再排序，不得原地改动 state[domain]
      c.base = kw
        ? source.filter((f) => {
            const m = lcFields(f);
            switch (s.scope) {
              case "author":
              case "title":
                return m.nick.includes(kw);
              case "id":
                return m.uidLc.includes(kw);
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
  // 域切换后搜索栏的域相关联动：筛选组显隐（作品型 vs 关注域各有排序维度）/范围文案/占位符/下拉选中
  syncForDomain() {
    const isWorkRecord = this.#isWorkRecordDomain();
    dom.sbWorkFilters.classList.toggle("hidden", !isWorkRecord);
    dom.sbFollowFilters.classList.toggle("hidden", isWorkRecord);
    this.syncScopeUIForDomain();
    this.#updateSearchPlaceholder();
    this.syncFilterUI();
    this.syncCount();
  }

  // store.on("domain") 的搜索栏联动入口：搜索栏展开期间才同步域差异
  onDomainChanged() {
    if (this.#isSearchBarOpen()) this.syncForDomain();
  }

  // 筛选变化后的统一入口：重渲当前域网格 + 刷新结果数。
  // 视图全程只计算一次，同一结果贯穿渲染与计数（历史实现经 renderCards/syncCount 各算
  // 一遍，大库下重复付出整段过滤+排序成本）；结果数组与上次实际渲染恒等时跳过重渲
  // （切了不改变结果集的筛选、重复点击同段），只刷新计数。
  // resetScroll：用户重定义结果集（排序/关键词/范围/类型/逆序/清除）时传 true——
  // 重渲后显式回顶。尾部占位（#syncTailReserve）使「wipe clamp 天然回顶」失效（重渲任务内
  // 总高即恢复终值、旧偏移合法存留），不显式归零会表现为「跟随锚点」停在深处
  refreshGridView(resetScroll = false) {
    // 锚点属旧视图：用户重定义结果集（排序/关键词/范围/类型/逆序/清除）且视图确已变化时，
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
      if (resetScroll) dom.mainGrid.scrollTop = 0;
    }
    this.syncCount(view.length);
  }

  // 结果数 K/N：K 为当前过滤视图条数，N 为当前域全量条数。
  // count 可由调用方注入（refreshGridView 已持有视图）；缺省经视图函数取（内部有阶段缓存）。
  // 加载期 N 取后台权威总量 state.gridTotal（作品型三域 = page:0 total，作者域 = 全量长度），
  // K 随页增长而 N 恒定——避免「首页到达前显示旧缓存数字、到达后又被打成已加载 600」的
  // 4969/4969 → 600/600 突变。切域/切组后首屏未到的空窗（gridPending）K 恒 0、N 取
  // state.gridTotals 缓存（与分组 tab 同源）→ 显示 0/Total；无缓存才显示占位「…」。
  // 加载完成后 N 回落为已加载条数（此时等于 total，新增/删除即时反映）
  syncCount(count) {
    const gt = state.gridTotal;
    const match = gt && gt.domain === state.domain && gt.groupId === state.currentGroupId;
    if (state.gridPending) {
      // 网格已清场、首屏数据未到：K 恒 0（不读旧缓存视图）；N 用已知权威总量
      dom.sbCount.textContent = match ? `0/${gt.total}` : "…";
      return;
    }
    if (count === undefined) {
      count = this.#isWorkRecordDomain() ? this.getWorksView().length : this.getAuthorRecordsView().length;
    }
    const total = services.isGridLoading() && match ? gt.total : state[state.domain].length;
    dom.sbCount.textContent = `${count}/${total}`;
  }

  // 五域 → 网格实例统一映射（AppShell 右栏折叠与 Batch 等按域取网格共用）
  gridForDomain(domain = state.domain) {
    if (domain === "followings") return followingsGrid;
    if (domain === "candidates") return candidatesGrid;
    if (domain === "favorites") return favoritesGrid;
    if (domain === "collections") return collectionsGrid;
    return worksGrid;
  }

  // 作品型三域 → 对应网格实例（Batch 等外部类也需要按域取网格，公开）
  activeWorkRecordGrid() {
    return this.gridForDomain();
  }

  syncFilterUI() {
    // 下拉（范围/类型/作品排序/作者域排序同构）：值文案随激活项，菜单项高亮主题红
    this.#syncSelectUI(dom.sbScope, "data-scope", this.#searchState.scope, "作者");
    this.#syncSelectUI(dom.sbType, "data-type", this.#searchState.workType, "全部");
    // 排序下拉：排序键与方向合并为单值（key-desc / key-asc），两域各自一套 token
    const dir = this.#searchState.reverse ? "asc" : "desc";
    this.#syncSelectUI(dom.sbSort, "data-sort", `${this.#searchState.sort}-${dir}`, "保存时间(降)");
    this.#syncSelectUI(dom.sbFollowSort, "data-fsort", `${this.#searchState.followingsSort}-${dir}`, "作品数(降)");
  }

  #syncSelectUI(el, attr, value, fallback) {
    const opt = el.querySelector(`.sb-scope-option[${attr}="${value}"]`);
    el.querySelector(".sb-scope-value").textContent = opt ? opt.textContent : fallback;
    el.querySelectorAll(".sb-scope-option").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute(attr) === value);
    });
  }

  // 范围段的域差异：「标题」仅作品型三域；关注域下「作者」按钮文案为「昵称」，残留 title 范围回退「作者」
  syncScopeUIForDomain() {
    const isWorkRecord = this.#isWorkRecordDomain();
    dom.sbScopeTitle.classList.toggle("hidden", !isWorkRecord);
    dom.sbScopeAuthor.textContent = isWorkRecord ? "作者" : "昵称";
    if (!isWorkRecord && this.#searchState.scope === "title") this.#searchState.scope = "author";
  }

  #updateSearchPlaceholder() {
    const placeholders = this.#isWorkRecordDomain()
      ? { author: "输入作者昵称", title: "输入作品标题文案", id: "输入作者 UID" }
      : { author: "输入昵称", title: "输入昵称", id: "输入 UID" };
    dom.searchInput.placeholder = placeholders[this.#searchState.scope];
  }

  #isSearchBarOpen() {
    return !dom.searchBar.classList.contains("hidden");
  }

  #closeSelectMenu(el) {
    el.querySelector(".sb-scope-menu").classList.add("hidden");
  }

  #closeAllSelectMenus() {
    for (const el of [dom.sbScope, dom.sbType, dom.sbSort, dom.sbFollowSort]) this.#closeSelectMenu(el);
  }

  // ---------- 展开 / 收起 ----------
  // 展开入口唯一（toggleSearchBar 的收起态分支）：展开即回填已应用关键词，任何展开路径
  // 均不自动聚焦输入框（2026-10-28 定案；仅用户点击输入框才获得焦点）
  openSearchBar() {
    dom.searchBar.classList.remove("hidden");
    this.syncForDomain();
    dom.searchInput.value = this.#searchState.keyword;
  }

  // 搜索态全量重置但栏位保持展开（域切换用：重置筛选 + 收起下拉菜单，不隐藏搜索栏）。
  // refresh=false 时重置不做重渲——网格随域切换即清场重载
  resetSearchState(refresh = true) {
    this.clearSearchFilters(refresh);
    this.#closeAllSelectMenus();
  }

  closeSearchBar({ refresh = true } = {}) {
    if (!this.#isSearchBarOpen()) return;
    // 收起即重置：搜索栏内的关键词/排序/下拉筛选等改动一律不保留，
    // 网格恢复全量，下次展开从默认初始状态开始
    this.resetSearchState(refresh);
    dom.searchBar.classList.add("hidden");
  }

  toggleSearchBar() {
    if (this.#isSearchBarOpen()) this.closeSearchBar();
    else this.openSearchBar();
  }

  // 显式搜索：输入不即时响应，回车（IME 组合中让位）或点击 🔍 才实施
  applySearchInput() {
    this.#searchState.keyword = dom.searchInput.value;
    // 实施搜索后输入框失焦：光标不再滞留文本区，键盘焦点交还给页面（避免后续按键被输入框吞掉）
    dom.searchInput.blur();
    this.refreshGridView(true);
  }

  // ✕ 按钮：仅清除搜索输入文本（去掉关键词过滤），其余筛选（范围/排序/类型）就地保留
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
    this.#searchState.keyword = "";
    this.#searchState.scope = "author";
    this.#searchState.sort = "saved";
    this.#searchState.followingsSort = "works";
    this.#searchState.workType = "all";
    this.#searchState.reverse = false;
    dom.searchInput.value = "";
    this.syncScopeUIForDomain();
    this.#updateSearchPlaceholder();
    this.syncFilterUI();
    if (wasActive && refresh) this.refreshGridView(true);
  }

  // ---------- 事件绑定 ----------
  #bindEvents() {
    // 显式搜索：回车（IME 组合中让位）或点击 🔍 按钮
    dom.searchInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      this.applySearchInput();
    });
    dom.btnSearchGo.addEventListener("click", () => this.applySearchInput());
    // 自绘下拉（范围/类型/排序同构）：控件点击开合、选项点击应用；点击栏外收起。
    // Esc 仅在菜单已开时拦截并 stopPropagation——将 Esc 留给菜单自身收起、不再冒泡
    // 到 main.js 的弹窗关闭单点收口（搜索栏现由 S 键开关，Esc 不再关搜索栏）
    this.#bindSelectMenu(dom.sbScope, (opt) => {
      this.#searchState.scope = opt.dataset.scope;
      this.syncFilterUI();
      this.#updateSearchPlaceholder();
      this.refreshGridView(true);
    });
    this.#bindSelectMenu(dom.sbType, (opt) => {
      this.#searchState.workType = opt.dataset.type;
      this.syncFilterUI();
      this.refreshGridView(true);
    });
    document.addEventListener("click", (e) => {
      for (const el of [dom.sbScope, dom.sbType, dom.sbSort, dom.sbFollowSort]) {
        if (!el.contains(e.target)) this.#closeSelectMenu(el);
      }
    });
    this.#bindSelectMenu(dom.sbSort, (opt) => {
      const raw = opt.dataset.sort;
      const sep = raw.lastIndexOf("-");
      this.#searchState.sort = raw.slice(0, sep);
      this.#searchState.reverse = raw.slice(sep + 1) === "asc";
      this.syncFilterUI();
      this.refreshGridView(true);
    });
    this.#bindSelectMenu(dom.sbFollowSort, (opt) => {
      const raw = opt.dataset.fsort;
      const sep = raw.lastIndexOf("-");
      this.#searchState.followingsSort = raw.slice(0, sep);
      this.#searchState.reverse = raw.slice(sep + 1) === "asc";
      this.syncFilterUI();
      this.refreshGridView(true);
    });
    dom.btnClearInBar.addEventListener("click", () => this.clearSearchInput());
    dom.btnSearchMenu.addEventListener("click", () => this.toggleSearchBar());
  }

  #bindSelectMenu(el, onSelect) {
    el.addEventListener("click", (e) => {
      const opt = e.target.closest(".sb-scope-option");
      if (opt) {
        onSelect(opt);
        this.#closeSelectMenu(el);
        return;
      }
      el.querySelector(".sb-scope-menu").classList.toggle("hidden");
    });
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!el.querySelector(".sb-scope-menu").classList.contains("hidden")) {
        e.stopPropagation();
        this.#closeSelectMenu(el);
      }
    });
  }
}

export const search = new SearchBar();
