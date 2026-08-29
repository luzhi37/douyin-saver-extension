// ---------- 组合根：消息监听 / DOM 事件绑定 / store 订阅 / init ----------
// 所有类模块经 import 求值完成后（单例全部就绪）才执行本文件底部逻辑。

import { config, dom, state, store, utils, services, runtimeConfig } from './core.js';
import { search } from './components/search-bar.js';
import { dialog } from './components/dialog.js';
import { followingsGrid } from './grids/followings-grid.js';
import { worksGrid, likesGrid, favoritesGrid } from './grids/works-grid.js';
import { groups } from './data/groups.js';
import { batch } from './data/batch.js';
import { importExport } from './data/import-export.js';
import { sidebar } from './components/sidebar.js';
import { sync } from './sync/sync.js';
import { domainScanSync } from './sync/domain-scan-sync.js';
import { settings } from './components/settings.js';
import { detail } from './components/detail.js';
import { appShell } from './components/app-shell.js';

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
    case "COLLECTION_PROGRESS":
      domainScanSync.onScanProgress(message);
      break;
    // 批量「取消并移除」由 Batch 内挂 requestId 专属 listener 消化，全局不处理
  }
});

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
dom.batchSaveToWorks.addEventListener("click", () => batch.saveSelectedToWorks());

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

dom.btnSettings?.addEventListener("click", () => settings.openPanel());

dom.btnReset.addEventListener("click", async () => {
  const domain = state.domain;
  const domainName = config.DOMAINS_META[domain].label;

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
          store.set(domain, []);
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
  if (sync.isRunning() || domainScanSync.isRunning()) return;
  if (state.domain === "followings") {
    await sync.syncFollowings();
  } else if (state.domain === "works") {
    await sync.syncCurrentGroup();
  } else {
    await domainScanSync.syncDomain(state.domain);
  }
});

// ---------- init IIFE ----------
(async function init() {
  // 构建标记：用于确认页面运行的是最新构建（头像探针预载版）
  console.info("[DDM] options build 2026-08-26 four-domain");
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
    batch.syncSaveToWorksBtn();
    await groups.renderGroupTabs();
    search.onDomainChanged();
    // 方案A：作者归属判定依赖关注全集，域切换时异步刷新；完成后归属筛选仍生效则重渲网格
    services.loadFollowedUids().then((ok) => {
      if (ok && search.isOwnerFilterActive()) search.refreshGridView();
    });
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
  store.on("followings", async () => {
    // 方案A：关注数据变化时同步刷新关注全集，保证作者归属判定不过期
    await services.loadFollowedUids();
    if (state.domain === "followings" || search.isOwnerFilterActive()) search.refreshGridView();
  });
  store.on("likes", () => {
    if (state.domain === "likes") search.refreshGridView();
  });
  store.on("favorites", () => {
    if (state.domain === "favorites") search.refreshGridView();
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

  document.body.dataset.domain = "works";
  appShell.updateDomainSlider("works");
  await groups.renderGroupTabs();
  try {
    await services.loadDomainData();
  } catch (err) {
    console.error("[DY] load domain data failed:", err);
    appShell.renderErrorState("数据加载失败", err.message);
  }
  // 方案A：启动即预载关注全集，供作品/点赞/收藏域的「已关注/未关注」归属判定
  try {
    await services.loadFollowedUids();
  } catch (err) {
    console.error("[DY] load followed uids failed:", err);
  }
})();
