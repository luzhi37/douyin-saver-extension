// ---------- Batch ----------
import { config, dom, state, utils, services, store } from '../core.js';
import { search } from '../components/search-bar.js';
import { dialog } from '../components/dialog.js';
import { followingsGrid } from '../grids/followings-grid.js';

// ---------- Batch ----------
export class Batch {
  toggleSelect(id) {
    if (state.selectedIds.has(id)) {
      state.selectedIds.delete(id);
      return false;
    }
    state.selectedIds.add(id);
    return true;
  }

  toggleBatchMode() {
    const newMode = !state.batchMode;
    if (!newMode) state.selectedIds.clear();
    return newMode;
  }

  selectAll() {
    // 全选作用于当前可见视图（有筛选时只选筛出的条目，所见即所选）
    const isWorkLike = config.WORK_LIKE_DOMAINS.includes(state.domain);
    const items = isWorkLike ? search.getWorksView() : state.followings;
    const idKey = isWorkLike ? "awemeId" : "uid";
    const allSelected = items.every((w) => state.selectedIds.has(w[idKey]));
    if (allSelected) {
      state.selectedIds.clear();
      return "none";
    }
    for (const w of items) state.selectedIds.add(w[idKey]);
    return "all";
  }

  // 已选计数与按钮可用性统一在此刷新（docs/UI_IMPROVEMENTS.md 建议4）
  syncSelectionUI() {
    const count = state.selectedIds.size;
    if (dom.batchCount) dom.batchCount.textContent = count;
    const noneSelected = count === 0;
    dom.batchMove.disabled = noneSelected;
    dom.batchDelete.disabled = noneSelected;
    this.syncSaveToWorksBtn();
  }

  #workLikeCheckboxSelector() {
    return ".work-checkbox";
  }

  #clearAllCheckboxes() {
    const selector = config.WORK_LIKE_DOMAINS.includes(state.domain)
      ? this.#workLikeCheckboxSelector()
      : ".following-checkbox";
    document.querySelectorAll(selector).forEach((el) => this.updateCheckboxDOM(el, false));
  }

  async #executeBatchOp(serviceFn, { conditionallyRemove = false } = {}) {
    if (state.selectedIds.size === 0) return null;
    const ids = Array.from(state.selectedIds);
    const domain = state.domain;
    const isFollowings = domain === "followings";

    await serviceFn(ids, isFollowings);
    state.selectedIds.clear();

    const grid = isFollowings ? followingsGrid : search.activeWorkLikeGrid();
    const removeSilent = isFollowings
      ? store.removeFollowingsSilent
      : (idSet) => store.removeWorkLikeSilent(domain, idSet);
    if (!conditionallyRemove || state.currentGroupId !== "all") {
      removeSilent.call(store, new Set(ids));
      grid.removeItems(new Set(ids));
    }

    this.#clearAllCheckboxes();
    dom.batchSelectAll.innerHTML = "全选";
    store.refreshGroups();
    this.syncSelectionUI();
    return { count: ids.length, isFollowings };
  }

  deleteSelected() {
    return this.#executeBatchOp((ids, isFollowings) =>
      isFollowings ? services.deleteFollowings(ids) : services.deleteWorkLike(state.domain, ids),
    );
  }

  moveSelected(targetGroupId) {
    return this.#executeBatchOp(
      (ids, isFollowings) =>
        isFollowings
          ? services.moveFollowings(ids, targetGroupId)
          : services.moveWorkLike(state.domain, ids, targetGroupId),
      { conditionallyRemove: true },
    );
  }

  isSelected(id) {
    return state.selectedIds.has(id);
  }

  selectedCount() {
    return state.selectedIds.size;
  }

  updateCheckboxDOM(checkboxEl, isSelected) {
    if (isSelected) {
      checkboxEl.classList.add("checked");
      checkboxEl.innerHTML = (config.icons && config.icons.check) || "";
    } else {
      checkboxEl.classList.remove("checked");
      checkboxEl.textContent = "";
    }
    checkboxEl.setAttribute("aria-checked", isSelected ? "true" : "false");
  }

  toggleBatchSelect(id, checkboxEl) {
    const selected = this.toggleSelect(id);
    this.updateCheckboxDOM(checkboxEl, selected);
    this.syncSelectionUI();
  }

  handleBatchToggle() {
    const newMode = this.toggleBatchMode();
    store.set("batchMode", newMode);
    if (!newMode) {
      document.querySelectorAll(".work-checkbox").forEach((el) => {
        el.style.display = "none";
        el.innerHTML = "";
        el.classList.remove("checked");
      });
      document.querySelectorAll(".following-checkbox").forEach((el) => {
        el.style.display = "none";
        el.innerHTML = "";
        el.classList.remove("checked");
      });
      dom.batchSelectAll.innerHTML = `全选`;
      this.syncSaveToWorksBtn();
    } else {
      document.querySelectorAll(".work-checkbox").forEach((el) => (el.style.display = ""));
      document.querySelectorAll(".following-checkbox").forEach((el) => (el.style.display = ""));
      this.syncSaveToWorksBtn();
    }
    this.syncSelectionUI();
  }

  handleBatchSelectAll() {
    const result = this.selectAll();
    dom.batchSelectAll.innerHTML = result === "all" ? `取消全选` : `全选`;
    const selector = state.domain === "followings" ? ".following-checkbox" : ".work-checkbox";
    document.querySelectorAll(selector).forEach((el) => {
      const id = el.closest("[data-aweme-id]")?.dataset?.awemeId || el.closest("[data-uid]")?.dataset?.uid;
      this.updateCheckboxDOM(el, this.isSelected(id));
    });
    this.syncSelectionUI();
  }

  async handleBatchDelete() {
    if (this.selectedCount() === 0) return;
    const count = this.selectedCount();
    // 点赞/收藏域：移除 = 取消远端点赞/收藏 + 删本地（长任务链路）
    if (config.WORK_LIKE_DOMAINS.includes(state.domain) && state.domain !== "works") {
      await this.cancelAndRemoveSelected();
      return;
    }
    const isFollowings = state.domain === "followings";
    const name = isFollowings ? "关注者" : "作品";
    const delBody = document.createElement("p");
    delBody.className = "confirm-delete-msg";
    delBody.textContent = `确定移除选中的 ${count} 个${name}？此操作不可撤销。`;
    dialog.showDialog("确认移除", delBody, [
      { text: "取消", ghost: true, callback: () => dialog.closeDialog() },
      {
        text: "移除",
        danger: true,
        callback: async () => {
          dialog.updateDialog("正在移除…", `<p>正在移除 ${count} 个${name}…</p>${utils.SPINNER_HTML}`);
          state.preventDialogClose = true;
          try {
            const result = await this.deleteSelected();
            if (result) {
              // 执行期弹窗已挡住 UI 变更，成功后不再要求"好的"确认（建议2）
              dialog.closeDialog();
              dialog.showToast(`已移除 ${count} 个${name}`, "success");
            }
          } finally {
            state.preventDialogClose = false;
          }
        },
      },
    ]);
  }

  // 点赞/收藏域批量「取消并移除」：CANCEL_LIKE/CANCEL_COLLECTION { awemeIds, domain }
  // → background 逐条取消远端并对成功条目删本地 → CANCEL_DONE { deletedIds } 驱动 UI 刷新
  async cancelAndRemoveSelected() {
    const domain = state.domain;
    const isLikes = domain === "likes";
    const count = this.selectedCount();
    const ids = Array.from(state.selectedIds);
    const cancelType = isLikes ? "CANCEL_LIKE" : "CANCEL_COLLECTION";
    const actionLabel = isLikes ? "取消点赞" : "取消收藏";

    if (isLikes && (await this.#isIndependentMode())) {
      dialog.showToast("独立模式不支持点赞操作，请在设置中切换 Tab 模式", "error");
      return;
    }

    const confirmBody = document.createElement("p");
    confirmBody.className = "confirm-delete-msg";
    confirmBody.textContent = `确定对选中的 ${count} 个作品执行${actionLabel}并从本域移除？远端${actionLabel}后不可恢复。`;
    dialog.showDialog(`确认${actionLabel}`, confirmBody, [
      { text: "取消", ghost: true, callback: () => dialog.closeDialog() },
      {
        text: actionLabel,
        danger: true,
        callback: async () => {
          dialog.updateDialog(`正在${actionLabel}…`, `<p>正在${actionLabel} 0 / ${count}…</p>`);
          state.preventDialogClose = true;
          try {
            const res = await services.bgMsg({ type: cancelType, awemeIds: ids, domain });
            if (!res || res.ok !== true) {
              dialog.showToast(`${actionLabel}失败: ${res?.error || "未知错误"}`, "error");
              return;
            }
            const done = await new Promise((resolve) => {
              const handler = (msg) => {
                if (msg.requestId !== res.requestId) return;
                if (msg.type === "CANCEL_PROGRESS") {
                  // background 逐条回报，index 为 0-based，展示成 K / N
                  dialog.updateDialog(
                    `正在${actionLabel}…`,
                    `<p>正在${actionLabel} ${msg.index + 1} / ${msg.total}…</p>`,
                  );
                } else if (msg.type === "CANCEL_DONE") {
                  chrome.runtime.onMessage.removeListener(handler);
                  resolve(msg);
                }
              };
              chrome.runtime.onMessage.addListener(handler);
              setTimeout(() => {
                chrome.runtime.onMessage.removeListener(handler);
                resolve(null);
              }, Math.max(30000, ids.length * 3000));
            });
            const deletedIds = new Set(done?.deletedIds || []);
            state.selectedIds.clear();
            store.removeWorkLikeSilent(domain, deletedIds);
            search.activeWorkLikeGrid().removeItems(deletedIds);
            store.refreshGroups();
            dialog.closeDialog();
            const failedCount = done ? done.failed : count - deletedIds.size;
            dialog.showToast(
              failedCount > 0
                ? `已${actionLabel} ${deletedIds.size} 个，${failedCount} 个失败保留`
                : `已${actionLabel}并移除 ${deletedIds.size} 个作品`,
              failedCount > 0 ? "error" : "success",
            );
          } finally {
            state.preventDialogClose = false;
          }
        },
      },
    ]);
  }

  async #isIndependentMode() {
    const { independentMode } = await chrome.storage.local.get("independentMode");
    return independentMode === true;
  }

  async handleBatchMove() {
    if (this.selectedCount() === 0) return;
    const count = this.selectedCount();
    const name = state.domain === "followings" ? "关注者" : config.DOMAINS_META[state.domain].label;
    dialog.showGroupSelectDialog(`移动到分组...`, await services.loadGroups(), async (groupId) => {
      dialog.updateDialog("正在移动…", `<p>正在移动 ${count} 个${name}…</p>${utils.SPINNER_HTML}`);
      state.preventDialogClose = true;
      try {
        const result = await this.moveSelected(groupId);
        if (result) {
          dialog.closeDialog();
          dialog.showToast(`已移动 ${count} 个${name}`, "success");
        }
      } finally {
        state.preventDialogClose = false;
      }
    });
  }

  // 跨域保存：点赞/收藏域勾选条目经 SAVE_WORKS 入作品域（mergeWork 去重合并）
  async saveSelectedToWorks() {
    if (this.selectedCount() === 0) return;
    const domain = state.domain;
    const targets = state[domain].filter((w) => state.selectedIds.has(w.awemeId));
    if (targets.length === 0) return;
    dom.batchSaveToWorks.disabled = true;
    try {
      const res = await services.bgMsg({ type: "SAVE_WORKS", works: targets });
      if (!res || res.ok !== true) {
        dialog.showToast("存入作品域失败: " + (res?.error || "未知错误"), "error");
        return;
      }
      state.selectedIds.clear();
      search.activeWorkLikeGrid().clearSelectionUI();
      this.syncSelectionUI();
      dialog.showToast(`已存入作品域（新增 ${res.added ?? 0} · 更新 ${res.updated ?? 0}）`, "success");
    } finally {
      this.syncSaveToWorksBtn();
    }
  }

  // 「存入作品」按钮显隐与可用态：仅点赞/收藏域且批量模式下显示
  syncSaveToWorksBtn() {
    if (!dom.batchSaveToWorks) return;
    const show =
      config.WORK_LIKE_DOMAINS.includes(state.domain) && state.domain !== "works" && state.batchMode;
    dom.batchSaveToWorks.classList.toggle("hidden", !show);
    if (show) dom.batchSaveToWorks.disabled = state.selectedIds.size === 0;
  }
}

export const batch = new Batch();
