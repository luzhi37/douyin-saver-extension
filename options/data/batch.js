// ---------- Batch ----------
import { config, dom, state, utils, services, store } from '../core.js';
import { search } from '../components/search-bar.js';
import { dialog } from '../components/dialog.js';
import { detail } from '../components/detail.js';
import { taskDock } from '../components/task-dock.js';
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
    // 回顾域禁用分组：批量「移动」入口整体隐藏（M 快捷键在 handleBatchMove 内再守卫）
    dom.batchMove.classList.toggle("hidden", state.domain === config.REVIEW_DOMAIN);
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
      dialog.confirmTask({
        title: "确认移除",
        message: `确定从回顾批次移除选中的 ${count} 个${name}？来源域数据不会被删除。`,
        progressTitle: "正在移除…",
        progressHtml: `<p>正在移除 ${count} 个${name}…</p>`,
        task: () => this.deleteSelected(),
        successText: `已移除 ${count} 个${name}`,
      });
      return;
    }
    // 点赞/收藏域：移除 = 取消远端点赞/收藏 + 删本地（长任务链路）
    if (config.WORK_RECORD_DOMAINS.includes(state.domain) && state.domain !== "works") {
      await this.cancelAndRemoveSelected();
      return;
    }
    const name = unitName();
    dialog.confirmTask({
      title: "确认移除",
      message: `确定移除选中的 ${count} 个${name}？此操作不可撤销。`,
      progressTitle: "正在移除…",
      progressHtml: `<p>正在移除 ${count} 个${name}…</p>`,
      task: () => this.deleteSelected(),
      successText: `已移除 ${count} 个${name}`,
    });
  }

  // 点赞/收藏域批量「取消并移除」：CANCEL_FAVORITES/CANCEL_COLLECTION { awemeIds, domain, taskId }
  // → 任务坞统一进度/终态 → TASK_DONE 的 onDone 做本地摘卡与结果 toast
  async cancelAndRemoveSelected() {
    const domain = state.domain;
    const isFavorites = domain === "favorites";
    const count = this.selectedCount();
    const ids = Array.from(state.selectedIds);
    const cancelType = isFavorites ? "CANCEL_FAVORITES" : "CANCEL_COLLECTION";
    const kind = isFavorites ? "cancelFavorites" : "cancelCollections";
    const actionLabel = isFavorites ? "取消点赞" : "取消收藏";

    if (isFavorites && (await services.isIndependentMode())) {
      dialog.showToast("独立模式不支持点赞操作，请在设置中切换 Tab 模式", "error");
      return;
    }
    // 不做任务坞闸：直接移除是纯本地 DELETE_* 写入，与任务队列无关；取消点赞/收藏
    // 经 TaskRegistry FIFO 排队（队满 8 由 start 返回 null → QUEUE_FULL，在坞行 fail 收口）

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
          // closeFirst：绑定端口后先关确认弹窗再发送（取消入口的时序约定）
          await taskDock.launchRemote({
            begin: {
              kind, domain, total: ids.length,
              hint: `已选 ${ids.length} 个作品`,
              onDone: (msg) => this.#onCancelDone(domain, actionLabel, msg),
            },
            closeFirst: true,
            payload: { type: cancelType, awemeIds: ids, domain },
          });
        },
      },
    ]);
  }

  // 终态：按 deletedIds（实删数）本地摘卡（authorCount 视图走 preserveAuthorOrder），刷新计数并 toast
  #onCancelDone(domain, actionLabel, msg) {
    const deletedIds = new Set(msg.deletedIds || []);
    if (search.isAuthorOrderActive()) {
      const patchable = search.isAuthorViewPatchable();
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
      if (!patchable) search.reloadForPageOrder();
      this.#showCancelResult(actionLabel, deletedIds, msg);
      return;
    }
    state.selectedIds.clear();
    store.removeWorkRecordSilent(domain, deletedIds);
    search.activeWorkRecordGrid().removeItems(deletedIds);
    store.refreshGroups();
    search.syncCount();
    this.#showCancelResult(actionLabel, deletedIds, msg);
  }

  // 结果 toast 三分支：cancelled=尾部未处理保留（processed<total 属正常，不计失败）；
  // failed=中断（已删部分已按 deletedIds 摘卡，其余保留）；正常=失败条目「失败保留」
  #showCancelResult(actionLabel, deletedIds, msg) {
    if (msg.cancelled) {
      dialog.showToast(`已${actionLabel}并移除 ${deletedIds.size} 个，其余未处理保留`, "info");
      return;
    }
    if (msg.ok === false) {
      dialog.showToast(
        `已${actionLabel}并移除 ${deletedIds.size} 个，其余保留（${msg.error || "未知错误"}）`,
        "error",
      );
      return;
    }
    const failed = msg.failed || 0;
    dialog.showToast(
      failed > 0
        ? `已${actionLabel} ${deletedIds.size} 个，${failed} 个失败保留`
        : `已${actionLabel}并移除 ${deletedIds.size} 个作品`,
      failed > 0 ? "error" : "success",
    );
  }

  async handleBatchMove() {
    if (this.selectedCount() === 0) return;
    if (state.domain === config.REVIEW_DOMAIN) {
      dialog.showToast("回顾域不支持分组", "info");
      return;
    }
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

  // 「批量下载」按钮显隐与可用态：作品记录域（作品/点赞/收藏，含回顾域作品批次）批量模式下显示
  syncDownloadBtn() {
    const show = utils.isWorkRecordDomain() && state.batchMode;
    dom.batchDownload.classList.toggle("hidden", !show);
    if (show) dom.batchDownload.disabled = state.selectedIds.size === 0;
  }

  // 批量下载：作品/点赞/收藏域勾选条目取流后整体打包为单个 zip（复用 detail 取流+重试，失败/跳过聚合汇报）。
  // 无可用视频/图片链接的条目跳过不计入失败，仅在确认文案与结果 toast 中说明。
  // 进度走任务坞（本地任务不经 background 队列，不占 API 请求车道）：行按钮经
  // onPause/onResume/onCancel 回调驱动循环；onProgress/onDone 复用坞行统一管线
  async handleBatchDownload() {
    if (this.selectedCount() === 0) return;
    if (!utils.isWorkRecordDomain()) return;
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
        callback: () => this.#runDownloadTask(targets, skipped, label),
      },
    ]);
  }

  // 下载主循环（任务坞行）。暂停=条目边界协作让出：在途条目取流完成后计入 processed
  // 再挂起（现场保留在 entries），继续后从下一条续跑；取消=abort 在途 fetch / zip worker，
  // 已取条目丢弃（Blob 交给 GC）。zip 打包不可分片中止，暂停在打包完成后、保存前生效
  #runDownloadTask(targets, skipped, label) {
    const taskId = crypto.randomUUID();
    const task = { cancelled: false, paused: false, controller: new AbortController(), wake: null };
    const entries = [];
    const failures = [];
    const unavailable = [];
    let ok = 0;
    // 条目边界挂起点：已请求暂停则翻行走状态，等待继续/取消唤醒
    const hold = async () => {
      if (!task.paused || task.cancelled) return;
      taskDock.setLocalStatus(taskId, "paused");
      await new Promise((resolve) => { task.wake = resolve; });
      task.wake = null;
    };
    const wake = () => {
      const w = task.wake;
      task.wake = null;
      w?.();
    };
    const finish = (msg) => {
      if (task.cancelled) entries.length = 0;
      taskDock.onDone({
        taskId,
        total: targets.length,
        processed: ok,
        failed: failures.length,
        unavailable: unavailable.length,
        skipped,
        ...msg,
      });
    };
    taskDock.begin({
      taskId,
      kind: "batchDownload",
      domain: state.domain,
      total: targets.length,
      hint: `已选 ${targets.length} 个${label}${skipped > 0 ? ` · ${skipped} 个无链接跳过` : ""}`,
      onPause: () => { task.paused = true; },
      onResume: () => { task.paused = false; wake(); },
      onCancel: () => {
        if (task.cancelled) return;
        task.cancelled = true;
        task.controller.abort();
        wake();
      },
    });
    dialog.closeDialog();
    (async () => {
      try {
        for (const work of targets) {
          await hold();
          if (task.cancelled) break;
          try {
            entries.push(...(await detail.fetchWorkMedia(work, task.controller.signal)));
            ok++;
          } catch (err) {
            if (task.cancelled) break;
            // 取消触发的 AbortError 已走取消收尾；诊断增强：日志带作品身份与取流 URL
            const url = work.type === "video" ? utils.getVideoUrl(work) : (work.images?.[0] || "");
            const message = err?.message || String(err);
            // 404/410 = 作品已删除/私密/审核中/仅好友可见：用户已知，跳过且不计入失败。
            // 日志用 info/debug：console.warn/error 会被 chrome://extensions 错误面板收录
            if (err?.code === "MEDIA_UNAVAILABLE") {
              unavailable.push(work.awemeId);
              console.debug("[DY] media unavailable, skipped:", work.awemeId, url);
            } else {
              failures.push(work.awemeId);
              console.info("[DY] batch download work failed:", work.awemeId, message, url, err);
            }
          }
          taskDock.onProgress({ taskId, processed: ok, total: targets.length, phase: "fetch" });
        }
        await hold();
        if (task.cancelled) {
          finish({ ok: true, cancelled: true });
          return;
        }
        if (ok === 0) {
          finish({
            ok: false,
            error: failures.length ? `全部失败：${this.#failureIds(failures)}` : "所选作品均不可访问，已跳过",
          });
          return;
        }
        taskDock.onProgress({ taskId, processed: ok, total: targets.length, phase: "zip", zipDone: 0, zipTotal: ok });
        const zip = await createZip(
          entries,
          (done, total) => taskDock.onProgress({ taskId, processed: ok, phase: "zip", zipDone: done, zipTotal: total }),
          task.controller.signal,
        );
        await hold();
        if (task.cancelled) {
          finish({ ok: true, cancelled: true });
          return;
        }
        detail.triggerDownload(zip, `${label}批量下载_${this.#today()}.zip`);
        finish({ ok: true, failedIds: failures.length ? this.#failureIds(failures) : "" });
      } catch (err) {
        if (task.cancelled) {
          finish({ ok: true, cancelled: true });
          return;
        }
        console.error("[DY] batch download failed:", err);
        finish({ ok: false, error: err?.message || String(err) });
      }
    })();
  }

  // 批量下载失败条目标识串（awemeId 数组）：最多列前 3 个，超出以「等 N 个」收尾，避免 toast 过长
  #failureIds(failures) {
    return failures.length > 3
      ? `${failures.slice(0, 3).join("、")} 等 ${failures.length} 个`
      : failures.join("、");
  }

  // 打包文件名日期后缀：yyyy-MM-dd
  #today() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
}

export const batch = new Batch();
