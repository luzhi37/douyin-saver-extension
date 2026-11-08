// ---------- AppShell（应用壳：域切换 / 全局错误态 / 弹窗关闭入口 / 回顾域重载） ----------
import { config, dom, state, services, store } from '../core.js';
import { worksGrid, favoritesGrid, collectionsGrid, reviewWorksGrid } from '../grids/works-grid.js';
import { followingsGrid, candidatesGrid, reviewAuthorsGrid } from '../grids/author-grid.js';
import { batch } from '../data/batch.js';
import { groups } from '../data/groups.js';
import { detail } from './detail.js';
import { search } from './search-bar.js';
import { sidebar } from './sidebar.js';
import { settings } from './settings.js';
import { dialog } from './dialog.js';

// ---------- 应用壳：域切换 / 全局错误态 / 弹窗关闭入口 ----------
class AppShell {
  constructor() {
    this.#bindEvents();
  }

  updateDomainSlider(domain) {
    const btn = document.querySelector(`.ds-btn[data-domain="${domain}"]`);
    // 仅保留对域名字符串的防御（未知域查不到按钮）；dom 引用为静态模板元素恒存在
    if (!btn) return;
    const parentRect = dom.domainSwitch.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    // 纵向排列：滑块按 Y 位移 + 高度指示当前域
    const top = btnRect.top - parentRect.top;
    const height = btnRect.height;
    dom.dsSlider.style.transform = `translateY(${top}px)`;
    dom.dsSlider.style.height = `${height}px`;
  }

  // 分组/域切换共用的同步清场：中止所有网格未完成的渲染/拼装（防旧骨架卡在下一帧
  // 追加进共享容器）+ 清空共享容器。只清不铺，数据到达后由 render() 重建
  // （首屏同步铺骨架 + 余量拼装一次挂载 + 渐进按槽回填）。
  // 「旧网格冻结-定格」变体已于 2026-09-27 用户定案否决：定格被感知为卡顿，必须先清空
  clearActiveGrid() {
    state.authorViewOrder = null;
    worksGrid.abortRender();
    followingsGrid.abortRender();
    candidatesGrid.abortRender();
    favoritesGrid.abortRender();
    collectionsGrid.abortRender();
    reviewWorksGrid.abortRender();
    reviewAuthorsGrid.abortRender();
    // 万级子树的同步 innerHTML="" 拆卸是大→小切组「慢一拍」的主源（整树脱离 +
    // LayoutObject 销毁 100-300ms，GC 再补一拍）：先 O(1) 换空壳让画面立即清空，
    // 旧子树脱离渲染树后由 #destroyDetached 分批销毁，拆卸与 GC 离开点击关键路径
    const stale = dom.mainContainer;
    const fresh = document.createElement("div");
    fresh.className = "main-container";
    stale.replaceWith(fresh);
    dom.mainContainer = fresh;
    worksGrid.attachContainer(fresh);
    followingsGrid.attachContainer(fresh);
    candidatesGrid.attachContainer(fresh);
    favoritesGrid.attachContainer(fresh);
    collectionsGrid.attachContainer(fresh);
    reviewWorksGrid.attachContainer(fresh);
    reviewAuthorsGrid.attachContainer(fresh);
    this.#destroyDetached(stale);
  }

  // 空闲分批销毁脱离渲染树的旧网格子树：每轮 8ms 预算、逐个移除直接子节点，
  // 拆卸与 GC 压力摊到空闲帧，不与点击→首屏的渲染路径竞争
  #destroyDetached(node) {
    const step = () => {
      const deadline = performance.now() + 8;
      while (node.firstChild && performance.now() < deadline) {
        node.firstChild.remove();
      }
      if (node.firstChild) window.requestIdleCallback(step);
    };
    step();
  }

  switchDomain(domain) {
    if (domain === state.domain) return;

    this.clearActiveGrid();
    // 旧域分组名/顺序/计数立即清空；domain 监听随后用 GET_DOMAIN_GROUPS 快照一次重建
    groups.clearForDomainSwitch();
    // refresh=false：网格随后即清场重载，此处重渲纯属浪费
    search.resetSearchState(false);
    state.selectedIds.clear();
    // 计数占位（见 SearchBar.syncCount）：首屏未到前 K 恒 0（有同源分组缓存显示 0，
    // 无缓存显示「…」），首页到达后由 loadDomainData 校正
    const allTotal = state.gridTotals[`${domain}|all`];
    state.gridPending = true;
    state.gridTotal = allTotal != null ? { domain, groupId: "all", total: allTotal } : null;
    dom.sbCount.textContent = allTotal != null ? "0" : "…";
    store.set("batchMode", false);

    detail.closeDetail();
    // 域切换显式归零：尾部占位（#syncTailReserve）使 wipe clamp 不再触发（重渲任务内总高
    // 即恢复终值、旧偏移合法存留）。置于 closeDetail 之后，防其滚动恢复覆盖归零
    dom.mainGrid.scrollTop = 0;
    if (!dom.sidebar.classList.contains("sidebar-zero")) {
      sidebar.setSidebarWidth(0);
      sidebar.saveSidebarWidth(0);
    }
    sidebar.clearSidebarActive();
    state.currentAuthorSecUid = null;

    // 域样式经 data-domain 属性挂载（CSS 按属性选择器适配各域）
    document.body.dataset.domain = domain;

    document.querySelectorAll(".ds-btn").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.domain === domain);
    });
    this.updateDomainSlider(domain);

    store.set("domain", domain);
    state.currentGroupId = "all";
    // 域切换后搜索态已重置为 saved；pagingMode 必须在加载前同步（否则会沿用上个域的
    // authorCount 分页口径）
    search.syncPagingState();
  }

  renderErrorState(msg, detailText) {
    dom.emptyState.classList.add("hidden");
    dom.mainContainer.classList.add("hidden");
    dom.errorState.querySelector("p").textContent = msg;
    const hint = dom.errorState.querySelector(".error-hint");
    hint.textContent = detailText || "请检查网络后重试";
    dom.errorState.classList.remove("hidden");
  }

  // 回顾域批次替换后的同域强制重载（switchDomain 同值会早退，不能复用）
  async reloadCurrentDomain() {
    const domain = state.domain;
    const groupId = state.currentGroupId;
    this.clearActiveGrid();
    // 整域重载 = 结果集重定义：选区与 Shift 锚点作废（批量模式保留）
    batch.resetSelection();
    const cachedTotal = state.gridTotals[`${domain}|${groupId}`];
    state.gridPending = true;
    state.gridTotal =
      cachedTotal != null ? { domain, groupId, total: cachedTotal } : null;
    dom.sbCount.textContent = cachedTotal != null ? "0" : "…";
    dom.mainGrid.scrollTop = 0;
    await this.loadDomainDataSafe();
    store.refreshGroups();
  }

  // 加载域数据的统一错误包装：捕获异常进入全局错误态（main.js 三处加载点共用）。
  // paging 缺省按当前搜索态计算；retry 防止 VIEW_EXPIRED / 降级路径无限重载。
  async loadDomainDataSafe({ paging = null, retry = false } = {}) {
    search.syncPagingState();
    const mode = paging || state.pagingMode;
    try {
      await services.loadDomainData(mode);
      // 回顾域作者批次需要作者卡布局；其他域清掉该属性，避免 CSS 残留
      document.body.dataset.reviewKind =
        state.domain === config.REVIEW_DOMAIN ? state.reviewKind || "" : "";
    } catch (err) {
      const code = err?.code || err?.message;
      if (!retry && code === "VIEW_EXPIRED") {
        // 视图被写入/淘汰/SW 重启作废：清场后按同一分页模式整轮重来一次
        this.clearActiveGrid();
        batch.resetSelection();
        state.gridSlots = null;
        state.gridPending = false;
        state.authorViewOrder = null;
        return this.loadDomainDataSafe({ paging: mode, retry: true });
      }
      if (!retry && code === "AUTHOR_VIEW_INCOMPLETE") {
        // 历史数据未进索引：降级 saved 分页 + 本地 rank（搜索栏仍显示“作品数”），
        // 完成态整渲一次，等价于旧行为
        this.clearActiveGrid();
        batch.resetSelection();
        state.gridSlots = null;
        state.gridPending = false;
        state.authorViewOrder = null;
        return this.loadDomainDataSafe({ paging: search.fetchSavedPaging(), retry: true });
      }
      console.error("[DY] load domain data failed:", err);
      this.renderErrorState("数据加载失败", err.message);
    }
  }

  // 弹窗关闭请求统一入口：X 按钮与 Esc 共用（见 docs/11），作用于顶层弹窗。
  // 短操作锁 preventDialogClose 期间不响应；长操作经 activeDialog 发取消信号
  async requestDialogClose() {
    if (state.preventDialogClose) return;
    const depthBefore = dialog.depth;
    if (state.activeDialog) {
      state.activeDialog();
      chrome.runtime.sendMessage({ type: "CANCEL_ACTIVE_TASK" }).catch(() => {});
    }
    // onClose 已自行关层（回退到父层）时不继续关闭，避免一次请求连关两层
    if (dialog.depth !== depthBefore) return;
    // 设置面板在关闭前保存运行参数；校验失败则保持打开 —— 仅基层弹窗关闭时触发
    if (dialog.isBase && !(await settings.saveBeforeClose())) return;
    dialog.closeDialog();
  }

  #bindEvents() {
    document.querySelectorAll(".ds-btn").forEach((tab) => {
      tab.addEventListener("click", () => this.switchDomain(tab.dataset.domain));
    });
    // resize 的全局布线在 main.js 组合根（rAF 节流单入口，同时重算域滑块与分组 tab）：
    // 本类只提供 updateDomainSlider，不再自挂第二个 window 监听
    // 重试当前域加载（统一走 loadDomainDataSafe，不再硬编码 works 域）
    dom.btnRetry.addEventListener("click", async () => {
      dom.errorState.classList.add("hidden");
      await this.loadDomainDataSafe();
    });
  }
}

export const appShell = new AppShell();
