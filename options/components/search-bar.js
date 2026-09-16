// ---------- SearchBar ----------
import { config, dom, state } from '../core.js';
import { followingsGrid } from '../grids/followings-grid.js';
import { worksGrid, likesGrid, favoritesGrid } from '../grids/works-grid.js';
import { batch } from '../data/batch.js';

// ---------- 检索：搜索/排序 ----------
// 数据层过滤（docs/UI_IMPROVEMENTS.md 建议5）：state.works/followings 保持全量，
// 网格与 Detail 统一从视图函数取列表；VirtualGrid 按 id 解析点击，不受过滤影响
class SearchBar {
  #searchState = {
    keyword: "",
    scope: "all", // all 综合 | author 作者(昵称) | title 标题 | id 作品ID/UID
    sort: "saved", // saved 保存时间 | authorCount 作者作品数（仅作品域）
    followingsSort: "followers", // followers 粉丝数 | works 作品数（仅关注域）
    followed: true, // 作者归属：已关注（默认勾选，双勾=全部）
    unfollowed: true, // 作者归属：未关注
    reverse: false, // 逆序（翻转最终顺序，两域共用）
  };

  #debounceTimer = 0;

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

  // 关键词按「范围」取匹配字段（docs/UI_IMPROVEMENTS.md 建议5）
  #matchWork(work, kw) {
    switch (this.#searchState.scope) {
      case "author":
        // 昵称子串匹配；UID 仅精确匹配——uid 是约 19 位纯数字，子串匹配会让任意数字关键词命中大量无关作者
        return (work.nickname || "").toLowerCase().includes(kw) || (work.uid && String(work.uid) === kw);
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
    const source = state[state.domain]; // 作品型三域：数据源即当前域数组
    let list = source;
    if (kw) list = list.filter((w) => this.#matchWork(w, kw));
    if (this.#isWorkLikeDomain() && this.#ownerFilterActive()) {
      // 已关注/未关注勾选（默认双勾=不筛）：单边勾选仅保留对应归属，两边都未勾则无结果
      // （#ownerFilterActive 保证不会同时为 true，故 followed 优先分支可安全省略双勾判断）
      list = list.filter((w) =>
        this.#searchState.followed
          ? this.#isFollowedWork(w)
          : this.#searchState.unfollowed
            ? this.#isUnfollowedWork(w)
            : false,
      );
    }
    if (this.#searchState.sort === "authorCount") {
      // 作者作品数按全库口径统计（关键词只决定哪些条目参与展示）。
      // 作者先按作品数降序排名、同数按 key 定序，保证同一作者的作品相邻；簇内按保存时间降序
      const counts = new Map();
      for (const w of source) {
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

  // 筛选变化后的统一入口：重渲当前域网格 + 刷新结果数 + 筛选状态写入 URL hash（P1-8）
  refreshGridView() {
    // 视图顺序可能已变（排序/关键词/归属/域/分组/同步）：旧 shift 锚点在新顺序中的
    // 索引与点击时不一致，先清空锚点，防止区间按错误索引圈选
    batch.resetRangeAnchor();
    if (this.#isWorkLikeDomain()) this.activeWorkLikeGrid().renderCards();
    else followingsGrid.renderFollowingCards();
    this.syncCount();
    this.#writeHash();
  }

  // 搜索应用后的结果数：取当前域的过滤视图长度（关键词/排序/归属勾选实时联动）
  syncCount() {
    const count = this.#isWorkLikeDomain() ? this.getWorksView().length : this.getFollowingsView().length;
    dom.sbCount.textContent = `共 ${count} 条`;
  }

  // ---------- 筛选状态 URL hash 持久化（P1-8） ----------
  // 「收起即重置」定案保留：hash 只在搜索栏展开期间写入，收起时随 clearSearchFilters 清空；
  // 页面刷新后由 initFromHash 恢复展开与筛选。仅写非默认值，保持 hash 简洁
  #writeHash() {
    const s = this.#searchState;
    const params = new URLSearchParams();
    if (s.keyword) params.set("q", s.keyword);
    if (s.scope !== "all") params.set("scope", s.scope);
    if (s.sort !== "saved") params.set("sort", s.sort);
    if (s.followingsSort !== "followers") params.set("fsort", s.followingsSort);
    if (!s.followed) params.set("followed", "0");
    if (!s.unfollowed) params.set("unfollowed", "0");
    if (s.reverse) params.set("reverse", "1");
    const hash = params.toString() ? "#search?" + params.toString() : "";
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }

  #readHash() {
    const m = location.hash.match(/^#search\?(.*)$/);
    if (!m) return false;
    const params = new URLSearchParams(m[1]);
    const s = this.#searchState;
    if (params.has("q")) s.keyword = params.get("q") || "";
    if (params.has("scope")) s.scope = params.get("scope");
    if (params.has("sort")) s.sort = params.get("sort");
    if (params.has("fsort")) s.followingsSort = params.get("fsort");
    if (params.has("followed")) s.followed = params.get("followed") !== "0";
    if (params.has("unfollowed")) s.unfollowed = params.get("unfollowed") !== "0";
    if (params.has("reverse")) s.reverse = params.get("reverse") === "1";
    return true;
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
  // 页面刷新后恢复：URL 带 #search?... 时展开搜索栏并套用 hash 中的筛选状态（P1-8）
  initFromHash() {
    if (!location.hash.startsWith("#search?")) return;
    this.openSearchBar();
  }

  openSearchBar() {
    if (this.#isSearchBarOpen()) return;
    dom.searchBar.classList.remove("hidden");
    // 从 hash 恢复上次展开期间的筛选状态（无 hash 则维持默认初始态）
    const restored = this.#readHash();
    // 排序段随域显隐；逆序复选框两域共用
    this.syncForDomain();
    dom.searchInput.value = this.#searchState.keyword;
    if (restored) this.refreshGridView();
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
