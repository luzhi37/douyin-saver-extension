// ---------- AppShell（应用壳：域切换 / 全局错误态 / 弹窗关闭入口） ----------
import { dom, state, services, store } from '../core.js';
import { worksGrid, likesGrid, favoritesGrid } from '../grids/works-grid.js';
import { followingsGrid } from '../grids/followings-grid.js';
import { detail } from './detail.js';
import { sidebar } from './sidebar.js';
import { settings } from './settings.js';
import { dialog } from './dialog.js';

// ---------- 应用壳：域切换 / 全局错误态 / 弹窗关闭入口 / 左侧边栏折叠 ----------
class AppShell {
  static LEFT_SIDEBAR_KEY = "douyin_left_sidebar_collapsed";

  constructor() {
    this.#bindEvents();
  }

  updateDomainSlider(domain) {
    const btn = document.querySelector(`.ds-btn[data-domain="${domain}"]`);
    if (!btn || !dom.dsSlider || !dom.domainSwitch) return;
    const parentRect = dom.domainSwitch.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    // 纵向排列：滑块按 Y 位移 + 高度指示当前域
    const top = btnRect.top - parentRect.top;
    const height = btnRect.height;
    dom.dsSlider.style.transform = `translateY(${top}px)`;
    dom.dsSlider.style.height = `${height}px`;
  }

  toggleLeftSidebar() {
    const collapsed = !dom.leftSidebar.classList.contains("collapsed");
    // 左侧边栏折叠同样改变主网格宽度，auto-fill 跨列阈值时卡片跳位：
    // 锚定视口内最上方卡片，折叠前后保持其视口 Y
    const anchor = this.#topVisibleGridCard();
    sidebar.preserveGridAnchor(anchor, () => {
      dom.leftSidebar.classList.toggle("collapsed", collapsed);
      localStorage.setItem(AppShell.LEFT_SIDEBAR_KEY, collapsed ? "1" : "");
    });
  }

  // 四域统一的网格锚点：视口内最上方可见卡片（骨架/完整卡均参与网格流、位置真实）
  #topVisibleGridCard() {
    const gridTop = dom.mainGrid.getBoundingClientRect().top;
    for (const card of dom.mainContainer.querySelectorAll(".work-card, .following-card")) {
      if (card.getBoundingClientRect().bottom > gridTop + 4) return card;
    }
    return null;
  }

  initLeftSidebar() {
    const collapsed = localStorage.getItem(AppShell.LEFT_SIDEBAR_KEY) === "1";
    dom.leftSidebar.classList.toggle("collapsed", collapsed);
  }

  // 分组/域切换共用的同步清场：中止所有网格未完成的渲染/拼装（防旧骨架卡在下一帧
  // 追加进共享容器）+ 清空共享容器。只清不铺，数据到达后由 render() 重建
  // （首屏同步铺骨架 + 余量拼装一次挂载 + 渐进按槽回填）。
  // 「旧网格冻结-定格」变体已于 2026-09-27 用户定案否决：定格被感知为卡顿，必须先清空
  clearActiveGrid() {
    worksGrid.abortRender();
    followingsGrid.abortRender();
    likesGrid.abortRender();
    favoritesGrid.abortRender();
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
    likesGrid.attachContainer(fresh);
    favoritesGrid.attachContainer(fresh);
    this.#destroyDetached(stale);
  }

  // 空闲分批销毁脱离渲染树的旧网格子树：每轮 8ms 预算、逐个移除直接子节点，
  // 拆卸与 GC 压力摊到空闲帧，不与点击→首屏的渲染路径竞争
  #destroyDetached(node) {
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 0));
    const step = () => {
      const deadline = performance.now() + 8;
      while (node.firstChild && performance.now() < deadline) {
        node.firstChild.remove();
      }
      if (node.firstChild) idle(step);
    };
    step();
  }

  switchDomain(domain) {
    if (domain === state.domain) return;

    this.clearActiveGrid();

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

    // 域样式经 data-domain 属性挂载（CSS 按属性选择器适配四域）
    document.body.dataset.domain = domain;

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

  // 加载域数据的统一错误包装：捕获异常进入全局错误态（main.js 三处加载点共用）
  async loadDomainDataSafe() {
    try {
      await services.loadDomainData();
    } catch (err) {
      console.error("[DY] load domain data failed:", err);
      this.renderErrorState("数据加载失败", err.message);
    }
  }

  // 弹窗关闭请求统一入口：X 按钮与 Esc 共用（docs/UI_IMPROVEMENTS.md 建议3），作用于顶层弹窗。
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
    dom.btnSidebarToggle?.addEventListener("click", () => this.toggleLeftSidebar());
    document.querySelectorAll(".ds-btn").forEach((tab) => {
      tab.addEventListener("click", () => this.switchDomain(tab.dataset.domain));
    });
    // resize 的全局布线在 main.js 组合根（rAF 节流单入口，同时重算域滑块与分组 tab）：
    // 本类只提供 updateDomainSlider，不再自挂第二个 window 监听
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

export const appShell = new AppShell();
