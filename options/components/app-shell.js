// ---------- AppShell（应用壳：域切换 / 全局错误态 / 弹窗关闭入口） ----------
import { dom, state, services, store } from '../core.js';
import { worksGrid, likesGrid, favoritesGrid } from '../grids/works-grid.js';
import { followingsGrid } from '../grids/followings-grid.js';
import { detail } from './detail.js';
import { sidebar } from './sidebar.js';
import { settings } from './settings.js';
import { dialog } from './dialog.js';

// ---------- 应用壳：域切换 / 全局错误态 / 弹窗关闭入口 ----------
export class AppShell {
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

    // 先中止所有网格未完成的分块渲染，防止旧域骨架卡在下一帧追加进共享容器
    worksGrid.abortRender();
    followingsGrid.abortRender();
    likesGrid.abortRender();
    favoritesGrid.abortRender();
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

export const appShell = new AppShell();
