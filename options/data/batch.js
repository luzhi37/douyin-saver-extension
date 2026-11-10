// ---------- Batch ----------
import { config, dom, state, utils, services, store } from '../core.js';
import { search } from '../components/search-bar.js';
import { dialog } from '../components/dialog.js';
import { detail } from '../components/detail.js';
import { createZip } from './zip.js';

// ---------- 批量文案 ----------
// 单元名唯一口径：回顾域按 reviewKind；作者域按域；作品型三域默认「作品」，
// labelForWork=true 时取域名 label（移动/下载等以域为单位的文案）。
function unitName({ labelForWork = false } = {}) {
  const domain = state.domain;
  if (domain === config.REVIEW_DOMAIN) {
    return state.reviewKind === "authors" ? "回顾作者" : "回顾作品";
  }
  if (utils.isAuthorRecordDomain(domain)) {
    return domain === "candidates" ? "候选作者" : "关注者";
  }
  return labelForWork ? config.DOMAINS_META[domain].label : "作品";
}

// ---------- Batch ----------
class Batch {
  // Shift 范围选择的锚点：上一次（非 Shift）点击的 id
  #lastSelectedId = null;
  // 批量下载任务令牌：本地长任务取消（X/Esc → #cancelDownload）共用
  #downloadTask = null;

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
    const isWorkRecord = utils.isWorkRecordDomain();
    const items = isWorkRecord ? search.getWorksView() : search.getAuthorRecordsView();
    const idKey = isWorkRecord ? "awemeId" : "uid";
    const allSelected = items.every((w) => state.selectedIds.has(w[idKey]));
    if (allSelected) {
      state.selectedIds.clear();
      return "none";
    }
    for (const w of items) state.selectedIds.add(w[idKey]);
    return "all";
  }

  // 全选按钮图标与可见文案同步：未全选=双对勾「全选」，已全选=实心勾选框「取消全选」
  #setSelectAllBtn(allSelected) {
    const use = dom.batchSelectAll.querySelector("use");
    if (use) use.setAttribute("href", allSelected ? "#icon-select-clear" : "#icon-select-all");
    const label = dom.batchSelectAll.querySelector(".batch-bar-label");
    if (label) label.textContent = allSelected ? "取消全选" : "全选";
  }

  // 已选计数与按钮可用性统一在此刷新（见 docs/11）
  syncSelectionUI() {
    const count = state.selectedIds.size;
    // 分母取当前视图长度（与全选判据同源）；筛选/分组/域切换后随重渲一起刷新
    const view = utils.isAuthorRecordDomain() ? search.getAuthorRecordsView() : search.getWorksView();
    dom.batchCount.textContent = String(count);
    if (dom.batchTotal) dom.batchTotal.textContent = String(view.length);
    dom.batchCount.closest(".batch-bar-count")?.setAttribute("aria-label", `已选 ${count} / ${view.length} 项`);
    const noneSelected = count === 0;
    dom.batchMove.disabled = noneSelected;
    dom.batchDelete.disabled = noneSelected;
    this.syncSaveToWorksBtn();
    this.syncSaveToCandidatesBtn();
    this.syncDownloadBtn();
    // 全选按钮的图标与可见文案随“当前视图是否全选”同步（单选/取消也能立即回正）
    this.#setSelectAllBtn(view.length > 0 && count === view.length);
  }

  // 从勾选圆反查所属条目 id（作品卡 data-aweme-id / 关注卡 data-uid）
  #checkboxId(el) {
    return el.closest("[data-aweme-id]")?.dataset?.awemeId || el.closest("[data-uid]")?.dataset?.uid;
  }

  #clearAllCheckboxes() {
    const selector = utils.isWorkRecordDomain() ? ".work-checkbox" : ".following-checkbox";
    document.querySelectorAll(selector).forEach((el) => this.updateCheckboxDOM(el, false));
  }

  async #executeBatchOp(
    serviceFn,
    { conditionallyRemove = false, kind = "delete", targetGroupId = null } = {},
  ) {
    if (state.selectedIds.size === 0) return null;
    const ids = Array.from(state.selectedIds);
    const domain = state.domain;
    const isAuthorRecord = utils.isAuthorRecordDomain(domain);
    const isReview = domain === config.REVIEW_DOMAIN;

    const res = await serviceFn(ids, isAuthorRecord);
    // 失败即抛、不动选区：确认弹窗的 catch 统一反馈，选中项保留可重试
    if (!res || res.ok !== true) throw new Error(res?.error || "OPERATION_FAILED");

    // authorCount 完整作者视图：本地增量收口，不再整域重载——
    // 删除=摘卡并递减作者计数；移动离开当前分组=摘卡（不影响「全部」总数）；
    // 移动落「全部」或同组=只改分组归属，网格零变化。顺序稳定到下次显式重排
    if (!isReview && !isAuthorRecord && search.isAuthorViewPatchable()) {
      const idSet = new Set(ids);
      const grid = search.gridForDomain(domain);
      if (kind === "move") {
        const staysInView =
          state.currentGroupId === "all" || state.currentGroupId === targetGroupId;
        if (staysInView) {
          store.updateWorkGroupSilent(domain, idSet, targetGroupId);
        } else {
          const removedCount = store.removeWorkRecordSilent(domain, idSet, {
            preserveAuthorOrder: true,
            adjustAllTotal: false,
          });
          // 目标分组缓存预加（后台 count 快照随后校正）
          if (targetGroupId && removedCount) {
            const targetKey = `${domain}|${targetGroupId}`;
            if (typeof state.gridTotals[targetKey] === "number") {
              state.gridTotals[targetKey] += removedCount;
            }
          }
          grid.removeItems(idSet);
        }
      } else {
        store.removeWorkRecordSilent(domain, idSet, { preserveAuthorOrder: true });
        grid.removeItems(idSet);
      }
      state.selectedIds.clear();
      this.#clearAllCheckboxes();
      this.#setSelectAllBtn(false);
      store.refreshGroups();
      search.syncCount();
      this.syncSelectionUI();
      return { count: ids.length, isAuthorRecord };
    }

    // authorCount 视图不完整/加载中：游标与本地顺序不可混用，整域重载兜底
    //（重载只清选区与 Shift 锚点，批量模式保留）
    if (!isReview && !isAuthorRecord && search.isAuthorOrderActive()) {
      state.selectedIds.clear();
      this.#clearAllCheckboxes();
      this.#setSelectAllBtn(false);
      store.refreshGroups();
      this.syncSelectionUI();
      search.reloadForPageOrder();
      return { count: ids.length, isAuthorRecord };
    }

    state.selectedIds.clear();

    const grid = search.gridForDomain(domain);
    const idKey = state.reviewKind === "authors" ? "uid" : "awemeId";
    // 作品域移动（conditionallyRemove=true）只移出当前分组，「全部」总数不变
    const removeSilent = isReview
      ? (idSet) => store.removeReviewItemsSilent(idSet, idKey)
      : isAuthorRecord
        ? (idSet) => store.removeAuthorRecordsSilent(domain, idSet)
        : (idSet) =>
            store.removeWorkRecordSilent(domain, idSet, {
              adjustAllTotal: !conditionallyRemove,
            });
    if (!conditionallyRemove || state.currentGroupId !== "all") {
      removeSilent(new Set(ids));
      grid.removeItems(new Set(ids));
    }

    this.#clearAllCheckboxes();
    this.#setSelectAllBtn(false);
    store.refreshGroups();
    // 静默移除不触发域事件，搜索栏结果数需手动同步（删除/移出当前分组都会改变可见数量）
    search.syncCount();
    this.syncSelectionUI();
    return { count: ids.length, isAuthorRecord };
  }

  deleteSelected() {
    if (state.domain === config.REVIEW_DOMAIN) {
      return this.#executeBatchOp((ids) =>
        services.deleteReviewItems(state.reviewSourceDomain, ids),
      );
    }
    return this.#executeBatchOp((ids, isAuthorRecord) =>
      isAuthorRecord
        ? services.deleteAuthorRecords(state.domain, ids)
        : services.deleteWorkRecord(state.domain, ids),
    );
  }

  moveSelected(targetGroupId) {
    if (state.domain === config.REVIEW_DOMAIN) {
      return this.#executeBatchOp(
        (ids) => services.moveReviewItems(state.reviewSourceDomain, ids, targetGroupId),
        { conditionallyRemove: true, kind: "move", targetGroupId },
      );
    }
    return this.#executeBatchOp(
      (ids, isAuthorRecord) =>
        isAuthorRecord
          ? services.moveAuthorRecords(state.domain, ids, targetGroupId)
          : services.moveWorkRecord(state.domain, ids, targetGroupId),
      { conditionallyRemove: true, kind: "move", targetGroupId },
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
      checkboxEl.innerHTML = config.icons.check || "";
    } else {
      checkboxEl.classList.remove("checked");
      checkboxEl.textContent = "";
    }
    checkboxEl.setAttribute("aria-checked", isSelected ? "true" : "false");
  }

  // shift=true 按当前筛选视图顺序从锚点到目标连选
  toggleBatchSelect(id, checkboxEl, shift = false) {
    if (shift && this.#lastSelectedId !== null && this.#lastSelectedId !== id) {
      this.#applyRange(this.#lastSelectedId, id);
    } else {
      const selected = this.toggleSelect(id);
      this.updateCheckboxDOM(checkboxEl, selected);
    }
    this.#lastSelectedId = id;
    this.syncSelectionUI();
  }

  // 选区与 Shift 锚点一并复位的统一入口（视图上下文切换/结果集重定义共用；批量模式
  // 本身保留）：清空选区、复位全选按钮与已勾选卡的勾选态（分组切换随清场、筛选重渲随
  // 重建，仍顺带清一次防「重渲被跳过」时的残留）。锚点必须一并清空——锚点的位置只在新
  // 视图里重新现算才有意义，而它通常是视口外的旧卡：保留会让重排后的首次 Shift 点击从
  // 不可见的旧卡跨到任意位置、圈出视口外的大段区间（「勾选两点间、移动的却是别的卡」
  // 的根因之一，见 docs/11「Shift 连选」）
  resetSelection() {
    state.selectedIds.clear();
    this.#lastSelectedId = null;
    document
      .querySelectorAll(".work-checkbox.checked, .following-checkbox.checked")
      .forEach((el) => this.updateCheckboxDOM(el, false));
    this.#setSelectAllBtn(false);
    this.syncSelectionUI();
  }

  // 区间应用：把网格**已渲染顺序**中 [from, to] 区间的条目统一置为选中。
  // 取序必须用网格快照（VirtualGrid.renderedItems）而非 getWorksView()/getAuthorRecordsView()
  // 现算：视图缓存随 dataVersion 重建（排序重排、渐进加载、局部替换）后可能与尚未重渲的
  // DOM 顺序不一致，按视图下标圈选会把区间落到视口/挂载窗口之外——表现为「视觉上选中
  // 两点间、实际移动的却是区间外的卡」。快照与挂载卡 DOM 同序，所见即所选；快照缺失
  // （render 前/abort 后）才回退视图函数
  #applyRange(fromId, toId) {
    const isWorkRecord = utils.isWorkRecordDomain();
    const rendered = search.gridForDomain(state.domain).renderedItems();
    const view = rendered || (isWorkRecord ? search.getWorksView() : search.getAuthorRecordsView());
    const idKey = isWorkRecord ? "awemeId" : "uid";
    const ids = view.map((x) => x[idKey]);
    const a = ids.indexOf(fromId);
    const b = ids.indexOf(toId);
    // 锚点已不在当前视图（被删除/筛掉等）：退化为仅应用目标，避免整段区间落空
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
      this.updateCheckboxDOM(el, state.selectedIds.has(id));
    });
  }

  handleBatchToggle() {
    const newMode = this.toggleBatchMode();
    store.set("batchMode", newMode);
    // 进入/退出都重置范围锚点：域切换等非按钮路径直接置 batchMode=false 时不走本方法，
    // 下次进入仍从干净锚点开始；分组切换保留批量模式，选区与锚点由 resetSelection 清理
    this.#lastSelectedId = null;
    // 勾选框显隐由 body.batch-mode 纯 CSS 驱动（options.css 基类 display:none + 批量模式
    // flex），禁止逐元素写 inline display：万级域滚动后勾选框可达数千，逐个 style 写入
    // 会让进/出批量模式秒级卡顿
    if (!newMode) {
      // 退出批量模式：清空选区；DOM 勾选态只清 checked 的（未勾选框本就无内容）
      document
        .querySelectorAll(".work-checkbox.checked, .following-checkbox.checked")
        .forEach((el) => this.updateCheckboxDOM(el, false));
      this.#setSelectAllBtn(false);
    }
    this.syncSelectionUI();
  }

  handleBatchSelectAll() {
    const result = this.selectAll();
    this.#setSelectAllBtn(result === "all");
    const selector = utils.isAuthorRecordDomain()
      ? ".following-checkbox"
      : ".work-checkbox";
    document.querySelectorAll(selector).forEach((el) => {
      this.updateCheckboxDOM(el, this.isSelected(this.#checkboxId(el)));
    });
    this.syncSelectionUI();
  }

  async handleBatchDelete() {
    if (this.selectedCount() === 0) return;
    const count = this.selectedCount();
    // 回顾域：只从回顾批次移除引用，来源域数据保留
    if (state.domain === config.REVIEW_DOMAIN) {
      const name = unitName();
      const delBody = document.createElement("p");
      delBody.className = "confirm-delete-msg";
      delBody.textContent = `确定从回顾批次移除选中的 ${count} 个${name}？来源域数据不会被删除。`;
      dialog.showDialog("确认移除", delBody, [
        {
          text: "移除",
          danger: true,
          callback: async () => {
            await dialog.runTask({
              progressTitle: "正在移除…",
              progressHtml: `<p>正在移除 ${count} 个${name}…</p>`,
              task: () => this.deleteSelected(),
              successText: `已移除 ${count} 个${name}`,
              failPrefix: "移除失败: ",
            });
          },
        },
      ]);
      return;
    }
    // 点赞/收藏域：移除 = 取消远端点赞/收藏 + 删本地（长任务链路）
    if (config.WORK_RECORD_DOMAINS.includes(state.domain) && state.domain !== "works") {
      await this.cancelAndRemoveSelected();
      return;
    }
    const name = unitName();
    const delBody = document.createElement("p");
    delBody.className = "confirm-delete-msg";
    delBody.textContent = `确定移除选中的 ${count} 个${name}？此操作不可撤销。`;
    dialog.showDialog("确认移除", delBody, [
      {
        text: "移除",
        danger: true,
        callback: async () => {
          await dialog.runTask({
            progressTitle: "正在移除…",
            progressHtml: `<p>正在移除 ${count} 个${name}…</p>`,
            task: () => this.deleteSelected(),
            successText: `已移除 ${count} 个${name}`,
            failPrefix: "移除失败: ",
          });
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

    if (isFavorites && (await services.isIndependentMode())) {
      dialog.showToast("独立模式不支持点赞操作，请在设置中切换 Tab 模式", "error");
      return;
    }

    const confirmBody = document.createElement("p");
    confirmBody.className = "confirm-delete-msg";
    confirmBody.textContent = `确定对选中的 ${count} 个作品执行${actionLabel}并从本域移除？远端${actionLabel}后不可恢复。若已在抖音取消过，选「直接移除」仅删本地记录。`;
    dialog.showDialog(`确认${actionLabel}`, confirmBody, [
      {
        // 直接移除：仅删本地记录——作品可能已在抖音侧被取消点赞/收藏，无需重复远端操作。
        // ghost 不占推断的 Enter，显式标注 Ctrl+Enter 作为次要动作直达键
        text: "直接移除",
        ghost: true,
        hotkey: "ctrl+enter",
        callback: async () => {
          await dialog.runTask({
            progressTitle: "正在移除…",
            progressHtml: `<p>正在移除 ${count} 个作品…</p>`,
            task: () => this.deleteSelected(),
            successText: `已移除 ${count} 个作品`,
            failPrefix: "移除失败: ",
          });
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
            if (search.isAuthorOrderActive()) {
              // authorCount：完整视图下本地摘卡并递减作者计数，不再整域重载；
              // 视图不完整/加载中才回退重载兜底
              // 超时未收到 CANCEL_DONE（done=null）无法得知实际删除集，必须重载校准
              const patchable = Boolean(done) && search.isAuthorViewPatchable();
              state.selectedIds.clear();
              this.#clearAllCheckboxes();
              this.#setSelectAllBtn(false);
              if (patchable) {
                store.removeWorkRecordSilent(domain, deletedIds, { preserveAuthorOrder: true });
                search.activeWorkRecordGrid().removeItems(deletedIds);
                search.syncCount();
              }
              store.refreshGroups();
              this.syncSelectionUI();
              dialog.closeDialog();
              if (!patchable) search.reloadForPageOrder();
              this.#showCancelResult(actionLabel, deletedIds, done, count);
              return;
            }
            state.selectedIds.clear();
            store.removeWorkRecordSilent(domain, deletedIds);
            search.activeWorkRecordGrid().removeItems(deletedIds);
            store.refreshGroups();
            search.syncCount();
            dialog.closeDialog();
            this.#showCancelResult(actionLabel, deletedIds, done, count);
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

  // 取消并移除的终态 toast：done=null（超时未收到 CANCEL_DONE）时按差额估算失败数
  #showCancelResult(actionLabel, deletedIds, done, count) {
    const failedCount = done ? done.failed : count - deletedIds.size;
    dialog.showToast(
      failedCount > 0
        ? `已${actionLabel} ${deletedIds.size} 个，${failedCount} 个失败保留`
        : `已${actionLabel}并移除 ${deletedIds.size} 个作品`,
      failedCount > 0 ? "error" : "success",
    );
  }

  async handleBatchMove() {
    if (this.selectedCount() === 0) return;
    const count = this.selectedCount();
    const name = unitName({ labelForWork: true });
    dialog.showGroupSelectDialog(`移动到分组...`, await services.loadGroups(), async (groupId) => {
      await dialog.runTask({
        progressTitle: "正在移动…",
        progressHtml: `<p>正在移动 ${count} 个${name}…</p>`,
        task: () => this.moveSelected(groupId),
        successText: `已移动 ${count} 个${name}`,
        failPrefix: "移动失败: ",
      });
    });
  }

  // 批量「入库」快捷键/统一入口：按当前域分发到对应按钮动作——关注域 → 入库候选域，
  // 点赞/收藏域 → 存入作品域；作品域无入库目标，不响应
  handleBatchSave() {
    if (state.domain === "followings") return this.saveSelectedToCandidates();
    if (config.WORK_RECORD_DOMAINS.includes(state.domain) && state.domain !== "works") {
      return this.saveSelectedToWorks();
    }
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
    const show =
      config.WORK_RECORD_DOMAINS.includes(state.domain) && state.domain !== "works" && state.batchMode;
    dom.batchSaveToWorks.classList.toggle("hidden", !show);
    if (show) dom.batchSaveToWorks.disabled = state.selectedIds.size === 0;
  }

  // 关注域批量入库：勾选作者经 SAVE_CANDIDATES 复制入候选域（源关注域保留，剥离来源分组 id）
  async saveSelectedToCandidates() {
    if (this.selectedCount() === 0 || state.domain !== "followings") return;
    const targets = state.followings
      .filter((f) => state.selectedIds.has(f.uid))
      .map(({ groupId, ...rest }) => rest);
    if (targets.length === 0) return;
    dom.batchSaveToCandidates.disabled = true;
    try {
      const res = await services.bgMsg({ type: "SAVE_CANDIDATES", candidates: targets });
      if (!res || res.ok !== true) {
        dialog.showToast("入库候选域失败: " + (res?.error || "未知错误"), "error");
        return;
      }
      state.selectedIds.clear();
      search.gridForDomain("followings").clearSelectionUI();
      this.syncSelectionUI();
      dialog.showToast(`已入库候选（新增 ${res.added ?? 0} · 更新 ${res.updated ?? 0}）`, "success");
    } finally {
      this.syncSaveToCandidatesBtn();
    }
  }

  // 「入库候选」按钮显隐与可用态：仅关注域且批量模式下显示
  syncSaveToCandidatesBtn() {
    const show = state.domain === "followings" && state.batchMode;
    dom.batchSaveToCandidates.classList.toggle("hidden", !show);
    if (show) dom.batchSaveToCandidates.disabled = state.selectedIds.size === 0;
  }

  // 「批量下载」按钮显隐与可用态：仅作品型三域（作品/点赞/收藏）且批量模式下显示，关注域无媒体可下
  syncDownloadBtn() {
    const show = utils.isWorkRecordDomain() && state.batchMode;
    dom.batchDownload.classList.toggle("hidden", !show);
    if (show) dom.batchDownload.disabled = state.selectedIds.size === 0;
  }

  // 批量下载：作品/点赞/收藏域勾选条目取流后整体打包为单个 zip（复用 detail 取流+重试，失败/跳过聚合汇报）。
  // 无可用视频/图片链接的条目跳过不计入失败，仅在确认文案与结果 toast 中说明。
  // 长任务不走 preventDialogClose（短操作锁会把关闭入口整体短路）：进度层登记 onClose=取消，
  // X/Esc 经 requestDialogClose 调用 #cancelDownload，abort 在途 fetch 与 zip worker
  async handleBatchDownload() {
    if (this.selectedCount() === 0) return;
    if (!utils.isWorkRecordDomain()) return;
    const count = this.selectedCount();
    const label = unitName({ labelForWork: true });
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
      {
        text: "下载",
        primary: true,
        callback: async () => {
          // 整个回调体纳入 try：async 点击回调一旦 reject 会以 Uncaught (in promise) 进扩展错误面板
          const task = { cancelled: false, controller: new AbortController() };
          this.#downloadTask = task;
          const entries = [];
          try {
            // 进度层重挂基层并登记 onClose：X/Esc 经 requestDialogClose 触发取消（onClose 自行关层）
            dialog.showDialog("正在下载…", `<p>正在下载 0 / ${targets.length}…</p>`, [], () =>
              this.#cancelDownload(),
            );
            let ok = 0;
            const failures = [];
            const unavailable = [];
            for (const [i, work] of targets.entries()) {
              if (task.cancelled) return;
              dialog.updateDialog("正在下载…", `<p>正在下载 ${i + 1} / ${targets.length}…</p>`);
              try {
                entries.push(...(await detail.fetchWorkMedia(work, task.controller.signal)));
                ok++;
              } catch (err) {
                // 取消触发的 AbortError 与在途错误一律静默（#cancelDownload 已提示并关层）
                if (task.cancelled) return;
                // 诊断增强：日志带上作品身份与取流 URL，便于定位是哪条、哪个链接失败
                const url = work.type === "video" ? utils.getVideoUrl(work) : (work.images?.[0] || "");
                const message = err?.message || String(err);
                // 404/410 = 作品已删除/私密/审核中/仅好友可见：用户已知，跳过且不计入失败。
                // 日志用 info/debug：console.warn/error 会被 chrome://extensions 错误面板收录
                if (err?.code === "MEDIA_UNAVAILABLE") {
                  unavailable.push({ awemeId: work.awemeId, nickname: work.nickname || "", type: work.type, url });
                  console.debug("[DY] media unavailable, skipped:", work.awemeId, url);
                  continue;
                }
                failures.push({ awemeId: work.awemeId, nickname: work.nickname || "", type: work.type, url, error: message });
                console.info("[DY] batch download work failed:", work.awemeId, message, url, err);
              }
            }
            if (failures.length) console.info("[DY] batch download failures:", failures);
            if (task.cancelled) return;
            if (ok === 0) {
              dialog.closeDialog();
              if (failures.length) {
                const failParts = ["下载失败", this.#failureIds(failures)];
                if (unavailable.length) failParts.push(`${unavailable.length} 个不可用跳过`);
                if (skipped > 0) failParts.push(`${skipped} 个无链接跳过`);
                dialog.showToast(failParts.join("，"), "error");
              } else {
                const skipParts = ["所选作品均不可访问，已跳过"];
                if (skipped > 0) skipParts.push(`${skipped} 个无链接跳过`);
                dialog.showToast(skipParts.join("，"), "info");
              }
              return;
            }
            dialog.updateDialog("正在打包…", `<p>正在打包 0 / ${ok} 条…</p>`);
            const zip = await createZip(
              entries,
              (done, total) => dialog.updateDialog("正在打包…", `<p>正在打包 ${done} / ${total} 条…</p>`),
              task.controller.signal,
            );
            if (task.cancelled) return;
            detail.triggerDownload(zip, `${label}批量下载_${this.#today()}.zip`);
            dialog.closeDialog();
            const failed = failures.length;
            const parts = [`已下载 ${ok} 个${label}`];
            if (failed > 0) parts.push(`${failed} 个失败：${this.#failureIds(failures)}`);
            if (unavailable.length > 0) parts.push(`${unavailable.length} 个不可用跳过`);
            if (skipped > 0) parts.push(`${skipped} 个无链接跳过`);
            dialog.showToast(parts.join("，"), failed > 0 ? "error" : "success");
          } catch (err) {
            if (task.cancelled) return;
            console.error("[DY] batch download failed:", err);
            dialog.closeDialog();
            dialog.showToast("批量下载失败: " + (err.message || String(err)), "error");
          } finally {
            // 取消后立即丢弃已下载条目引用（Blob 交给 GC），避免残留内存
            if (task.cancelled) entries.length = 0;
            if (this.#downloadTask === task) this.#downloadTask = null;
          }
        },
      },
    ]);
  }

  // 取消批量下载（X/Esc 经 requestDialogClose → 顶层 onClose）：置令牌 + abort 在途
  // fetch / zip worker，并自行关层（requestDialogClose 检测到 depth 变化后不再二次关闭）
  #cancelDownload() {
    const task = this.#downloadTask;
    if (!task || task.cancelled) return;
    task.cancelled = true;
    task.controller.abort();
    dialog.closeDialog();
    dialog.showToast("已取消下载", "info");
  }

  // 批量下载失败条目标识串：最多列前 3 个 awemeId，超出以「等 N 个」收尾，避免 toast 过长
  #failureIds(failures) {
    const ids = failures.map((f) => f.awemeId);
    return ids.length > 3 ? `${ids.slice(0, 3).join("、")} 等 ${ids.length} 个` : ids.join("、");
  }

  // 打包文件名日期后缀：yyyy-MM-dd
  #today() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
}

export const batch = new Batch();
