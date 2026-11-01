// ---------- AppShell（应用壳：域切换 / 全局错误态 / 弹窗关闭入口） ----------
import { dom, state, services, store } from '../core.js';
import { worksGrid, favoritesGrid, collectionsGrid } from '../grids/works-grid.js';
import { followingsGrid, candidatesGrid } from '../grids/author-grid.js';
import { detail } from './detail.js';
import { search } from './search-bar.js';
import { sidebar } from './sidebar.js';
import { settings } from './settings.js';
import { dialog } from './dialog.js';

// ---------- 应用壳：域切换 / 全局错误态 / 弹窗关闭入口 / 右侧边栏折叠 ----------
class AppShell {
  static RIGHT_SIDEBAR_KEY = "douyin_right_sidebar_collapsed";

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

  toggleRightSidebar() {
    const collapsed = !dom.rightSidebar.classList.contains("collapsed");
    // 折叠改变主网格宽度（跨列阈值时卡片跳位）：改完 class 同步落轨宽 + 锚点补偿
    // （网格侧把视口内最上方卡拉回原 Y）。不走 RO 回调——RO 内写容器尺寸会触发
    // 浏览器的 ResizeObserver loop 告警
    dom.rightSidebar.classList.toggle("collapsed", collapsed);
    localStorage.setItem(AppShell.RIGHT_SIDEBAR_KEY, collapsed ? "1" : "");
    this.#activeGrid().syncContainerWidth();
  }

  // 当前域的活动网格（右栏折叠后同步落宽用；统一走 search.gridForDomain）
  #activeGrid() {
    return search.gridForDomain();
  }

  initRightSidebar() {
    const collapsed = localStorage.getItem(AppShell.RIGHT_SIDEBAR_KEY) === "1";
    dom.rightSidebar.classList.toggle("collapsed", collapsed);
  }

  // 分组/域切换共用的同步清场：中止所有网格未完成的渲染/拼装（防旧骨架卡在下一帧
  // 追加进共享容器）+ 清空共享容器。只清不铺，数据到达后由 render() 重建
  // （首屏同步铺骨架 + 余量拼装一次挂载 + 渐进按槽回填）。
  // 「旧网格冻结-定格」变体已于 2026-09-27 用户定案否决：定格被感知为卡顿，必须先清空
  clearActiveGrid() {
    worksGrid.abortRender();
    followingsGrid.abortRender();
    candidatesGrid.abortRender();
    favoritesGrid.abortRender();
    collectionsGrid.abortRender();
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

    // 域切换只重置搜索态（清筛选 + 收菜单），搜索栏保持展开（2026-10-28 定案）；
    // refresh=false：网格随后即清场重载，此处重渲纯属浪费
    search.resetSearchState(false);
    state.selectedIds.clear();
    // 计数占位（见 SearchBar.syncCount）：首屏未到前 K 恒 0，N 取与分组 tab 同源的
    // 缓存权威总量（有缓存即 0/Total，无缓存显示「…」）；首页到达后由 loadDomainData 校正
    const allTotal = state.gridTotals[`${domain}|all`];
    state.gridPending = true;
    state.gridTotal = allTotal != null ? { domain, groupId: "all", total: allTotal } : null;
    dom.sbCount.textContent = allTotal != null ? `0/${allTotal}` : "…";
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

    // 域样式经 data-domain 属性挂载（CSS 按属性选择器适配五域）
    document.body.dataset.domain = domain;

    document.querySelectorAll(".ds-btn").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.domain === domain);
    });
    this.updateDomainSlider(domain);

    store.set("domain", domain);
    state.currentGroupId = "all";
  }

  renderErrorState(msg, detailText) {
    dom.emptyState.classList.add("hidden");
    dom.mainContainer.classList.add("hidden");
    dom.errorState.querySelector("p").textContent = msg;
    const hint = dom.errorState.querySelector(".error-hint");
    hint.textContent = detailText || "请检查网络后重试";
    dom.errorState.classList.remove("hidden");
  }

  // 加载域数据的统一错误包装：捕获异常进入全局错误态（main.js 三处加载点共用）。
  // 取数方向随搜索栏排序：保存时间(升) 走从最旧一端分页，页序即视图序（逐页续填）
  async loadDomainDataSafe() {
    try {
      await services.loadDomainData(search.fetchAscending());
    } catch (err) {
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
    dom.btnSidebarToggle?.addEventListener("click", () => this.toggleRightSidebar());
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
