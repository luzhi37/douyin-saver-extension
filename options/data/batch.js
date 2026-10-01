// ---------- Batch ----------
import { config, dom, state, utils, services, store } from '../core.js';
import { search } from '../components/search-bar.js';
import { dialog } from '../components/dialog.js';
import { detail } from '../components/detail.js';
import { followingsGrid } from '../grids/followings-grid.js';
import { createZip } from './zip.js';

// ---------- Batch ----------
class Batch {
  // Shift 范围选择的锚点：上一次（非 Shift）点击的 id
  #lastSelectedId = null;

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
    const isWorkRecord = config.WORK_RECORD_DOMAINS.includes(state.domain);
    const items = isWorkRecord ? search.getWorksView() : search.getFollowingsView();
    const idKey = isWorkRecord ? "awemeId" : "uid";
    const allSelected = items.every((w) => state.selectedIds.has(w[idKey]));
    if (allSelected) {
      state.selectedIds.clear();
      return "none";
    }
    for (const w of items) state.selectedIds.add(w[idKey]);
    return "all";
  }

  // 全选按钮图标切换：未全选=双对勾（点击全选），已全选=实心勾选框（点击取消全选）
  #setSelectAllBtn(allSelected) {
    const use = dom.batchSelectAll.querySelector("use");
    if (use) use.setAttribute("href", allSelected ? "#icon-select-clear" : "#icon-select-all");
    dom.batchSelectAll.title = allSelected ? "取消全选" : "全选";
  }

  // 已选计数与按钮可用性统一在此刷新（docs/UI_IMPROVEMENTS.md 建议4）
  syncSelectionUI() {
    const count = state.selectedIds.size;
    if (dom.batchCount) dom.batchCount.textContent = `已选 ${count}`;
    const noneSelected = count === 0;
    dom.batchMove.disabled = noneSelected;
    dom.batchDelete.disabled = noneSelected;
    this.syncSaveToWorksBtn();
    this.syncDownloadBtn();
  }

  // 从勾选圆反查所属条目 id（作品卡 data-aweme-id / 关注卡 data-uid）
  #checkboxId(el) {
    return el.closest("[data-aweme-id]")?.dataset?.awemeId || el.closest("[data-uid]")?.dataset?.uid;
  }

  #clearAllCheckboxes() {
    const selector = config.WORK_RECORD_DOMAINS.includes(state.domain) ? ".work-checkbox" : ".following-checkbox";
    document.querySelectorAll(selector).forEach((el) => this.updateCheckboxDOM(el, false));
  }

  async #executeBatchOp(serviceFn, { conditionallyRemove = false } = {}) {
    if (state.selectedIds.size === 0) return null;
    const ids = Array.from(state.selectedIds);
    const domain = state.domain;
    const isFollowings = domain === "followings";

    const res = await serviceFn(ids, isFollowings);
    // 失败即抛、不动选区：确认弹窗的 catch 统一反馈，选中项保留可重试
    if (!res || res.ok !== true) throw new Error(res?.error || "OPERATION_FAILED");
    state.selectedIds.clear();

    const grid = isFollowings ? followingsGrid : search.activeWorkRecordGrid();
    const removeSilent = isFollowings
      ? store.removeFollowingsSilent
      : (idSet) => store.removeWorkRecordSilent(domain, idSet);
    if (!conditionallyRemove || state.currentGroupId !== "all") {
      removeSilent.call(store, new Set(ids));
      grid.removeItems(new Set(ids));
    }

    this.#clearAllCheckboxes();
    this.#setSelectAllBtn(false);
    store.refreshGroups();
    // 静默移除不触发域事件，搜索栏结果数需手动同步（删除/移出当前分组都会改变可见数量）
    search.syncCount();
    this.syncSelectionUI();
    return { count: ids.length, isFollowings };
  }

  deleteSelected() {
    return this.#executeBatchOp((ids, isFollowings) =>
      isFollowings ? services.deleteFollowings(ids) : services.deleteWorkRecord(state.domain, ids),
    );
  }

  moveSelected(targetGroupId) {
    return this.#executeBatchOp(
      (ids, isFollowings) =>
        isFollowings
          ? services.moveFollowings(ids, targetGroupId)
          : services.moveWorkRecord(state.domain, ids, targetGroupId),
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
    if (!checkboxEl) return; // 骨架卡无勾选框（模板本不含、降级即移除）：批量点击直启路径容错
    if (isSelected) {
      checkboxEl.classList.add("checked");
      checkboxEl.innerHTML = (config.icons && config.icons.check) || "";
    } else {
      checkboxEl.classList.remove("checked");
      checkboxEl.textContent = "";
    }
    checkboxEl.setAttribute("aria-checked", isSelected ? "true" : "false");
  }

  // shift=true 时按当前筛选视图顺序，从上次锚点到目标 id 圈选区间（P1-7）
  toggleBatchSelect(id, checkboxEl, shift = false) {
    if (shift && this.#lastSelectedId !== null && this.#lastSelectedId !== id) {
      this.#rangeSelect(this.#lastSelectedId, id);
    } else {
      const selected = this.toggleSelect(id);
      this.updateCheckboxDOM(checkboxEl, selected);
    }
    this.#lastSelectedId = id;
    this.syncSelectionUI();
  }

  // 视图顺序变更后调用（SearchBar.refreshGridView）：旧锚点在新顺序中的索引与点击时
  // 不一致，继续沿用会让 shift 区间按错误索引圈选（跨排序/关键词/域/分组换序的根因）
  resetRangeAnchor() {
    this.#lastSelectedId = null;
  }

  // 范围选择：把视图顺序中 [from, to] 区间的条目全部置为选中并同步勾选圆。
  // 视图顺序与网格视觉一致（含关键词/排序/归属过滤），保证所见即所选
  #rangeSelect(fromId, toId) {
    const isWorkRecord = config.WORK_RECORD_DOMAINS.includes(state.domain);
    const view = isWorkRecord ? search.getWorksView() : search.getFollowingsView();
    const idKey = isWorkRecord ? "awemeId" : "uid";
    const ids = view.map((x) => x[idKey]);
    const a = ids.indexOf(fromId);
    const b = ids.indexOf(toId);
    // 锚点已不在当前视图（被删除/筛掉等）：退化为仅选中目标，避免整段区间落空
    if (a === -1) {
      state.selectedIds.add(toId);
    } else if (b === -1) {
      return;
    } else {
      const [start, end] = a < b ? [a, b] : [b, a];
      for (let i = start; i <= end; i++) state.selectedIds.add(ids[i]);
    }
    const selector = isWorkRecord ? ".work-checkbox" : ".following-checkbox";
    document.querySelectorAll(selector).forEach((el) => {
      const id = this.#checkboxId(el);
      if (state.selectedIds.has(id)) this.updateCheckboxDOM(el, true);
    });
  }

  handleBatchToggle() {
    const newMode = this.toggleBatchMode();
    store.set("batchMode", newMode);
    // 勾选框显隐由 body.batch-mode 纯 CSS 驱动（options.css 基类 display:none + 批量模式
    // flex），禁止逐元素写 inline display：万级域滚动后勾选框可达数千，逐个 style 写入
    // 会让进/出批量模式秒级卡顿
    if (!newMode) {
      // 退出批量模式：清空选区与范围选择锚点；DOM 勾选态只清 checked 的（未勾选框本就无内容）
      this.#lastSelectedId = null;
      document
        .querySelectorAll(".work-checkbox.checked, .following-checkbox.checked")
        .forEach((el) => this.updateCheckboxDOM(el, false));
      this.#setSelectAllBtn(false);
      this.syncSaveToWorksBtn();
    } else {
      this.syncSaveToWorksBtn();
    }
    this.syncSelectionUI();
  }

  handleBatchSelectAll() {
    const result = this.selectAll();
    this.#setSelectAllBtn(result === "all");
    const selector = state.domain === "followings" ? ".following-checkbox" : ".work-checkbox";
    document.querySelectorAll(selector).forEach((el) => {
      this.updateCheckboxDOM(el, this.isSelected(this.#checkboxId(el)));
    });
    this.syncSelectionUI();
  }

  async handleBatchDelete() {
    if (this.selectedCount() === 0) return;
    const count = this.selectedCount();
    // 点赞/收藏域：移除 = 取消远端点赞/收藏 + 删本地（长任务链路）
    if (config.WORK_RECORD_DOMAINS.includes(state.domain) && state.domain !== "works") {
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
          dialog.updateDialog("正在移除…", `<p>正在移除 ${count} 个${name}…</p>`);
          state.preventDialogClose = true;
          try {
            const result = await this.deleteSelected();
            if (result) {
              // 执行期弹窗已挡住 UI 变更，成功后不再要求"好的"确认（建议2）
              dialog.closeDialog();
              dialog.showToast(`已移除 ${count} 个${name}`, "success");
            }
          } catch (err) {
            dialog.closeDialog();
            dialog.showToast("移除失败: " + (err.message || String(err)), "error");
          } finally {
            state.preventDialogClose = false;
          }
        },
      },
    ]);
  }

  // 点赞/收藏域批量「取消并移除」：CANCEL_FAVORITES/CANCEL_COLLECTION { awemeIds, domain }
  // → background 逐条取消远端并对成功条目删本地 → CANCEL_DONE { deletedIds } 驱动 UI 刷新
  async cancelAndRemoveSelected() {
    const domain = state.domain;
    const isFavorites = domain === "favorites";
    const count = this.selectedCount();
    const ids = Array.from(state.selectedIds);
    const cancelType = isFavorites ? "CANCEL_FAVORITES" : "CANCEL_COLLECTION";
    const actionLabel = isFavorites ? "取消点赞" : "取消收藏";

    if (isFavorites && (await this.#isIndependentMode())) {
      dialog.showToast("独立模式不支持点赞操作，请在设置中切换 Tab 模式", "error");
      return;
    }

    const confirmBody = document.createElement("p");
    confirmBody.className = "confirm-delete-msg";
    confirmBody.textContent = `确定对选中的 ${count} 个作品执行${actionLabel}并从本域移除？远端${actionLabel}后不可恢复。若已在抖音取消过，选「直接移除」仅删本地记录。`;
    dialog.showDialog(`确认${actionLabel}`, confirmBody, [
      {
        // 直接移除：仅删本地记录——作品可能已在抖音侧被取消点赞/收藏，无需重复远端操作
        text: "直接移除",
        ghost: true,
        callback: async () => {
          dialog.updateDialog("正在移除…", `<p>正在移除 ${count} 个作品…</p>`);
          state.preventDialogClose = true;
          try {
            const result = await this.deleteSelected();
            if (result) {
              dialog.closeDialog();
              dialog.showToast(`已移除 ${count} 个作品`, "success");
            }
          } catch (err) {
            dialog.closeDialog();
            dialog.showToast("移除失败: " + (err.message || String(err)), "error");
          } finally {
            state.preventDialogClose = false;
          }
        },
      },
      {
        text: actionLabel,
        danger: true,
        callback: async () => {
          dialog.updateDialog(`正在${actionLabel}…`, `<p>正在${actionLabel} 0 / ${count}…</p>`);
          state.preventDialogClose = true;
          try {
            const res = await services.bgMsg({ type: cancelType, awemeIds: ids, domain });
            if (!res || res.ok !== true) {
              dialog.closeDialog();
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
            store.removeWorkRecordSilent(domain, deletedIds);
            search.activeWorkRecordGrid().removeItems(deletedIds);
            store.refreshGroups();
            search.syncCount();
            dialog.closeDialog();
            const failedCount = done ? done.failed : count - deletedIds.size;
            dialog.showToast(
              failedCount > 0
                ? `已${actionLabel} ${deletedIds.size} 个，${failedCount} 个失败保留`
                : `已${actionLabel}并移除 ${deletedIds.size} 个作品`,
              failedCount > 0 ? "error" : "success",
            );
          } catch (err) {
            dialog.closeDialog();
            dialog.showToast(`${actionLabel}失败: ` + (err.message || String(err)), "error");
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
      dialog.updateDialog("正在移动…", `<p>正在移动 ${count} 个${name}…</p>`);
      state.preventDialogClose = true;
      try {
        const result = await this.moveSelected(groupId);
        if (result) {
          dialog.closeDialog();
          dialog.showToast(`已移动 ${count} 个${name}`, "success");
        }
      } catch (err) {
        dialog.closeDialog();
        dialog.showToast("移动失败: " + (err.message || String(err)), "error");
      } finally {
        state.preventDialogClose = false;
      }
    });
  }

  // 跨域保存：点赞/收藏域勾选条目经 SAVE_WORKS 入作品域（mergeWork 去重合并）
  async saveSelectedToWorks() {
    if (this.selectedCount() === 0) return;
    const domain = state.domain;
    // 剥离源域（点赞/收藏）的 groupId：它属于 favorites/collections 域的分组 id，带入作品域会让
    // mergeWork 误用（作品只出现在「全部」、不落「未分组」，也不被任何作品分组命中）。
    // 剥离后新作品回落到作品域默认分组「未分组」，已在作品域分组过的旧作品保留原分组
    const targets = state[domain]
      .filter((w) => state.selectedIds.has(w.awemeId))
      .map(({ groupId, ...rest }) => rest);
    if (targets.length === 0) return;
    dom.batchSaveToWorks.disabled = true;
    try {
      const res = await services.bgMsg({ type: "SAVE_WORKS", works: targets });
      if (!res || res.ok !== true) {
        dialog.showToast("存入作品域失败: " + (res?.error || "未知错误"), "error");
        return;
      }
      state.selectedIds.clear();
      search.activeWorkRecordGrid().clearSelectionUI();
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
      config.WORK_RECORD_DOMAINS.includes(state.domain) && state.domain !== "works" && state.batchMode;
    dom.batchSaveToWorks.classList.toggle("hidden", !show);
    if (show) dom.batchSaveToWorks.disabled = state.selectedIds.size === 0;
  }

  // 「批量下载」按钮显隐与可用态：仅作品型三域（作品/点赞/收藏）且批量模式下显示，关注域无媒体可下
  syncDownloadBtn() {
    if (!dom.batchDownload) return;
    const show = config.WORK_RECORD_DOMAINS.includes(state.domain) && state.batchMode;
    dom.batchDownload.classList.toggle("hidden", !show);
    if (show) dom.batchDownload.disabled = state.selectedIds.size === 0;
  }

  // 批量下载：作品/点赞/收藏域勾选条目取流后整体打包为单个 zip（复用 detail 取流+重试，失败/跳过聚合汇报）。
  // 无可用视频/图片链接的条目跳过不计入失败，仅在确认文案与结果 toast 中说明
  async handleBatchDownload() {
    if (this.selectedCount() === 0) return;
    if (!config.WORK_RECORD_DOMAINS.includes(state.domain)) return;
    const count = this.selectedCount();
    const label = config.DOMAINS_META[state.domain].label;
    const all = state[state.domain].filter((w) => state.selectedIds.has(w.awemeId));
    const targets = all.filter(
      (w) => (w.type === "video" && utils.getVideoUrl(w)) || (w.type === "note" && w.images?.length),
    );
    const skipped = all.length - targets.length;
    if (targets.length === 0) {
      dialog.showToast("所选条目均无可用视频/图片链接", "error");
      return;
    }
    const confirmBody = document.createElement("p");
    confirmBody.className = "confirm-delete-msg";
    confirmBody.textContent = `确定下载选中的 ${targets.length} 个${label}？将打包为 zip 压缩包下载到浏览器默认下载目录。`;
    if (skipped > 0) {
      const hint = document.createElement("p");
      hint.className = "empty-hint";
      hint.textContent = `其中 ${skipped} 个${label}无可用媒体链接，将跳过。`;
      confirmBody.appendChild(hint);
    }
    dialog.showDialog("批量下载", confirmBody, [
      { text: "取消", ghost: true, callback: () => dialog.closeDialog() },
      {
        text: "下载",
        primary: true,
        callback: async () => {
          dialog.updateDialog("正在下载…", `<p>正在下载 0 / ${targets.length}…</p>`);
          state.preventDialogClose = true;
          try {
            const entries = [];
            let ok = 0;
            for (const [i, work] of targets.entries()) {
              dialog.updateDialog("正在下载…", `<p>正在下载 ${i + 1} / ${targets.length}…</p>`);
              try {
                entries.push(...(await detail.fetchWorkMedia(work)));
                ok++;
              } catch (err) {
                console.error("[DY] batch download work failed:", err);
              }
            }
            if (ok === 0) {
              dialog.closeDialog();
              const failParts = ["下载失败"];
              if (skipped > 0) failParts.push(`${skipped} 个无链接跳过`);
              dialog.showToast(failParts.join("，"), "error");
              return;
            }
            dialog.updateDialog("正在打包…", `<p>正在打包 0 / ${ok} 条…</p>`);
            const zip = await createZip(entries, (done, total) =>
              dialog.updateDialog("正在打包…", `<p>正在打包 ${done} / ${total} 条…</p>`),
            );
            detail.triggerDownload(zip, `${label}批量下载_${this.#today()}.zip`);
            dialog.closeDialog();
            const failed = targets.length - ok;
            const parts = [`已下载 ${ok} 个${label}`];
            if (failed > 0) parts.push(`${failed} 个失败`);
            if (skipped > 0) parts.push(`${skipped} 个无链接跳过`);
            dialog.showToast(parts.join("，"), failed > 0 ? "error" : "success");
          } catch (err) {
            console.error("[DY] batch download failed:", err);
            dialog.closeDialog();
            dialog.showToast("批量下载失败: " + (err.message || String(err)), "error");
          } finally {
            state.preventDialogClose = false;
          }
        },
      },
    ]);
  }

  // 打包文件名日期后缀：yyyy-MM-dd
  #today() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
}

export const batch = new Batch();
