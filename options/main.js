// ---------- 组合根：消息监听 / DOM 事件绑定 / store 订阅 / init ----------
// 所有类模块经 import 求值完成后（单例全部就绪）才执行本文件底部逻辑。

import { config, dom, state, store, services, runtimeConfig } from './core.js';
import { search } from './components/search-bar.js';
import { dialog } from './components/dialog.js';
import { worksGrid } from './grids/works-grid.js';
import { groups } from './data/groups.js';
import { batch } from './data/batch.js';
import { importExport } from './data/import-export.js';
import { sidebar } from './components/sidebar.js';
import { sync } from './sync/sync.js';
import { domainScanSync } from './sync/domain-scan-sync.js';
import { authorImport } from './sync/author-import.js';
import { settings } from './components/settings.js';
import { status } from './components/status.js';
import { detail } from './components/detail.js';
import { appShell } from './components/app-shell.js';
import { randomReview } from './components/random-review.js';
import { tooltip } from './components/tooltip.js';

// ---------- 快捷键速查：'?' 打开静态内容弹窗 ----------
const SHORTCUT_ROWS = [
  ["?", "打开快捷键速查"],
  ["Esc", "关闭弹窗 / 退出详情；无覆盖层时退出输入聚焦"],
  ["B", "进入 / 退出批量模式"],
  ["弹窗 · Enter", "执行主动作（移除 / 删除 / 下载等）"],
  ["弹窗 · Ctrl+Enter", "执行次要动作（如批量取消的「直接移除」）"],
  ["详情 · ↑/↓ 或 滚轮", "切换上/下一个作品"],
  ["详情 · Space", "播放 / 暂停"],
  ["详情 · M", "静音 / 取消静音"],
  ["详情 · L", "循环模式（单作品 / 分组 / 关闭）"],
  ["详情 · ←/→", "图集翻页（多图作品）"],
  ["详情 · Delete / Backspace", "移除当前作品（弹确认）"],
  ["批量 · Ctrl+A", "全选当前结果"],
  ["批量 · Delete", "删除已勾选项（弹确认）"],
  ["批量 · I", "入库：关注域存入候选 / 点赞·收藏域存入作品"],
  ["批量 · M", "移动到分组"],
  ["批量 · D", "下载已勾选作品"],
  ["批量 · Shift+点击", "范围选择"],
  ["点击作品作者名", "打开该作者作品栏（作品/点赞/收藏域）"],
  ["Ctrl/Cmd+点击作品作者名", "在抖音打开作者主页"],
  ["批量 · Ctrl/Cmd+点击作者卡", "在新标签打开作者主页（关注/候选域）"],
];

function showShortcutHelp() {
  const rows = SHORTCUT_ROWS.map(
    ([keys, desc]) => `<kbd>${keys}</kbd><span class="sh-desc">${desc}</span>`,
  ).join("");
  const body = document.createElement("div");
  body.className = "shortcut-help";
  body.innerHTML = rows;
  dialog.showDialog("快捷键", body);
}

// ---------- STORE_CHANGED 合并处理 ----------
// inject 侧逐件保存会连发广播，而 store.notify 的渲染回调走 rAF：后台标签页 rAF 冻结，
// 不合并的话 N 次保存会排队 N 次「分组重算 + 全网格重载」，回扩展页首帧集中爆发——
// 表现为「回来后任意交互都卡、过一会才流畅」。隐藏期只标脏（拉数据/排队渲染都是白做），
// 回前台由 visibilitychange 统一 flush 一次；可见期 300ms 去抖合并快速连发。
// 广播分两种载荷：point（带 upserts，单发保存的真实变化）与 bulk（无 upserts，循环
// 收尾等批量变化，可带轻量 id 集 changedIds/addedIds）。flush 时统一走局部应用管线：
// 已存在记录原地替换 + 单卡 DOM 更新（mergeWork 保护 savedAt/groupId，排序位置不变，
// 无位移）；新增记录按落点分流——当前视图内经网格头插原语 insertItems 原地挂载（零
// 整刷、视口锚定补偿），当前视图外只重算分组数字。bulk 无 id 载荷（关注域等）或增量
// 守卫/补拉不过时才整域重载兜底，正确性优先
let storeChangedTimer = null;
const storeChangedBulkDomains = new Set();
// bulk 载荷的轻量 id 集（domain -> { changedIds:Set, addedIds:Set }）：flush 时按 id
// 经 GET_WORKS_BY_IDS 补拉合并后记录，走与点载荷相同的局部应用管线
const storeChangedBulkIds = new Map();
const storeChangedUpserts = new Map(); // domain -> Map<awemeId, { work, added }>，同 id 后到覆盖先到

function scheduleStoreChangedFlush() {
  if (document.hidden) return;
  clearTimeout(storeChangedTimer);
  storeChangedTimer = setTimeout(flushStoreChanged, 300);
}

function flushStoreChanged() {
  clearTimeout(storeChangedTimer);
  const bulkDomains = new Set(storeChangedBulkDomains);
  const bulkIdsByDomain = new Map(storeChangedBulkIds);
  const upsertsByDomain = new Map(storeChangedUpserts);
  storeChangedBulkDomains.clear();
  storeChangedBulkIds.clear();
  storeChangedUpserts.clear();
  // 同域 bulk 与点载荷并存：bulk 赢（增量/整刷收口自愈，点载荷作废）
  for (const domain of upsertsByDomain.keys()) {
    if (bulkDomains.has(domain)) upsertsByDomain.delete(domain);
  }
  if (bulkDomains.size > 0) store.refreshGroups();
  // 作者域变更（无点载荷）：作品型三域可见时刷新作者主键集并原地 patch 卡片作者 chip
  //（不整刷；若同批还有当前域整刷，重载后仍用更新后的集合渲染）
  if (
    config.WORK_RECORD_DOMAINS.includes(state.domain) &&
    (bulkDomains.has("followings") || bulkDomains.has("candidates"))
  ) {
    services.loadAuthorUidSets().then((ok) => {
      if (ok && config.WORK_RECORD_DOMAINS.includes(state.domain)) {
        search.activeWorkRecordGrid().syncAuthorFlags();
      }
    });
  }
  for (const domain of bulkDomains) {
    if (domain !== state.domain) continue;
    // 当前域 bulk 收口：作品型三域带 id 载荷 → 补拉记录后增量应用（零整刷）；无载荷
    // （关注域等）或补拉失败 → 整域重载兜底
    if (config.WORK_RECORD_DOMAINS.includes(domain) && bulkIdsByDomain.has(domain)) {
      applyBulkChanged(domain, bulkIdsByDomain.get(domain));
      continue;
    }
    appShell.loadDomainDataSafe();
  }
  for (const [domain, entries] of upsertsByDomain) {
    applyStoreUpserts(domain, [...entries.values()]);
  }
}

// bulk 收口：按广播 id 集合补拉合并后记录（GET_WORKS_BY_IDS，IDB 主键直取），复用
// 点载荷的局部应用管线；补拉失败/记录全缺（落库后又被删除等）→ 整域重载兜底。
// 拉取间隙用户切域由 applyStoreUpserts 的域校验兜底（过期载荷作废，切回自然整刷）
async function applyBulkChanged(domain, ids) {
  // authorCount 视图序/计数依赖全组数据：bulk 补拉的记录也只会被随后的整域重载覆盖，
  // 直接重载，省掉一次可能达到 MB 级的 GET_WORKS_BY_IDS 往返
  if (search.isAuthorOrderActive()) {
    store.refreshGroups();
    appShell.loadDomainDataSafe();
    return;
  }
  // 补拉规模守卫：响应是全记录过消息通道（千条 ≈ MB 级 structured clone），且超大新增
  // 本就会撞 tryHeadInsert 的预铺容量守卫打回整刷——超限直接整刷兜底，省一次巨型往返
  if (ids.changedIds.size > config.GRID_PREMOUNT_CAP) {
    appShell.loadDomainDataSafe();
    return;
  }
  const res = await services.bgMsg({ type: "GET_WORKS_BY_IDS", domain, ids: [...ids.changedIds] }).catch(() => null);
  if (!res || res.error || !Array.isArray(res.items) || res.items.length === 0) {
    appShell.loadDomainDataSafe();
    return;
  }
  applyStoreUpserts(domain, res.items.map((w) => ({ work: w, added: ids.addedIds.has(String(w.awemeId)) })));
}

// 点/bulk 变化局部应用：逐条按「state 内已存在 / 新增落点」分流。已存在 → 原地替换 +
// updateCardsDOM（无计数变化，零 background 往返）；新增且落在当前视图 → tryHeadInsert
// （state 同步 splice + 网格头插，零整刷）；新增且落在当前视图外 → 只重算分组数字
//（网格不受当前视图影响）。整刷守卫只对「触及当前视图」的变化生效——全部落在视图外时，
// 筛选/批量/详情/作者数排序都不构成整刷理由（当前网格、选区、详情快照均未变）；
// 任一条视图内变化需整刷则整域整刷——部分应用会让 state/网格口径不一
function applyStoreUpserts(domain, entries) {
  if (domain !== state.domain || !config.WORK_RECORD_DOMAINS.includes(domain)) return;
  let needCounts = false; // 当前视图外的新增：分组数字变了
  let needReload = false; // 头插守卫不过：整刷兜底
  const domUpdates = []; // { awemeId, work, idx }：批量卡更新的现成记录（免逐条 state.find）
  const viewAdds = []; // 落当前视图的新增（头插候选）
  // id→下标索引一次构建（O(N) 一遍）：替代逐条 findIndex 的 O(N×M)——万级 bulk 收口的
  // 主线程成本集中于此。原地替换不改其他元素下标，索引全程有效；新增走 viewAdds
  //（循环后由 tryHeadInsert 处理），不触碰本表
  const list = state[domain];
  const indexById = new Map();
  for (let i = 0; i < list.length; i++) indexById.set(list[i].awemeId, i);
  for (const { work, added } of entries) {
    const idx = indexById.get(work.awemeId);
    if (idx !== undefined) {
      domUpdates.push({ awemeId: work.awemeId, work, idx });
    } else if (added) {
      if (state.currentGroupId === "all" || work.groupId === state.currentGroupId) viewAdds.push(work);
      else needCounts = true;
    }
    // 未新增且不在 state（视图外已有记录的内容更新）：计数与网格均不受影响，跳过
  }
  // 全部落在当前视图外（或只是视图外记录的更新）：只重算分组数字。分组快照渲染已按
  // tab 结构 diff，计数变化只改文本，不重建顶栏节点
  if (viewAdds.length === 0 && domUpdates.length === 0) {
    if (needCounts) store.refreshGroups();
    return;
  }
  // authorCount 的视图序与计数依赖全组数据：视图内任何新增/更新都必须整域重载，不能走
  // 头插/原地替换（isFilterActive 已能兜住，此处显式写出防止未来筛选语义调整后失效）
  if (search.isAuthorOrderActive()) {
    store.refreshGroups();
    appShell.loadDomainDataSafe();
    return;
  }
  if (search.isFilterActive() || state.batchMode || !dom.detailOverlay.classList.contains("hidden")) {
    store.refreshGroups();
    appShell.loadDomainDataSafe();
    return;
  }
  // 守卫通过后才改写 state：整刷路径由 loadDomainData 全量替换接管，避免旧记录已被
  // 改写、重载却在途的中间态
  for (const update of domUpdates) list[update.idx] = update.work;
  if (domUpdates.length > 0) {
    state.dataVersion++; // 原地替换绕过 store 封装，整批计入一次数据版本（视图缓存失效判据）
  }
  if (viewAdds.length > 0) {
    if (tryHeadInsert(domain, viewAdds) === "fallback") {
      needReload = true;
    } else {
      // 头插/借道待渲渲染成功：分组计数与结果数随之收口（Shift 锚点只存 id，
      // 头插不改变已有条目的相对序，区间在新顺序下仍按点击时现算的下标正确圈选）
      store.refreshGroups();
      search.syncCount();
    }
  }
  if (needReload) {
    store.refreshGroups();
    appShell.loadDomainDataSafe();
    return;
  }
  if (needCounts) store.refreshGroups();
  // state 先行、DOM 后跟（updateCardsDOM 用注入的现成记录）
  search.activeWorkRecordGrid().updateCardsDOM(domUpdates);
}

// ---------- 头插收口：守卫 + 落点计算 ----------
// 视图序比较：savedAt 降序、平级按 awemeId 降序——与 savedAt_id / groupId_savedAt_id
// 索引的 prev 遍历同序（IDB 字符串键为码元序，与 JS 关系比较一致）
function viewOrderBefore(a, b) {
  const sa = a.savedAt || 0;
  const sb = b.savedAt || 0;
  if (sa !== sb) return sa > sb;
  return String(a.awemeId) > String(b.awemeId);
}

// 新条目落点 = 首个「严格排在新条目之后」的下标（等价元素不存在：id 全库唯一）
function headInsertPosition(list, work) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (viewOrderBefore(work, list[mid])) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// 头插尝试：state 侧逐条二分落点并同步 splice（先按视图序排序，逐条定位；连续落点
// 合批一次挂载）。返回 "applied"（state + 网格均已就位）/ "deferred"（首页渲染排队
// 中，state 已就位、待渲 renderCards 从 state 全量取视图随之出现）/ "fallback"
// （守卫不过或口径意外，整刷兜底——loadDomainData 全量替换 state，口径必然归一）
function tryHeadInsert(domain, works) {
  const grid = search.activeWorkRecordGrid();
  // 在途分页循环：头插与其 fillSlots 落点锚定会在 rAF 窗口内交错（start 基准过期会
  // 整页写偏）；整刷重载本就会作废在途循环，口径最稳
  if (services.isGridLoading()) return "fallback";
  // 快滚冻结期禁止一切 DOM 变更（与填充/降级同一纪律）
  if (grid.isScrollFrozen()) return "fallback";
  // 输入规模由调用方有界（applyStoreUpserts 的两条来源：点载荷 ≤ UPSERTS_MAX=8；
  // bulk 补拉在 applyBulkChanged 入口经 GRID_PREMOUNT_CAP 上限拦截后 ≤ 1500）——本函数
  // 不重复设防，超大新增的整刷兜底在补拉入口发生（省一次无谓的补拉往返）
  const list = state[domain];
  const sorted = [...works].sort((a, b) => (viewOrderBefore(a, b) ? -1 : 1));
  // 落点计算与落库分离：全部在原始 list 上二分。sorted 与 list 同为视图序，落点单调
  // 不减；runs 按「同原始落点」分组，与旧实现「当前列表中紧接上一条才并 run」等价
  //（前序已插 k 条时当前列表落点 = p + k，连续条件两边同加 k）。逐条边插边 splice 的
  // O(条数×N) 搬移收敛为按 run 逆序 splice 的 O(runs×N)
  const runs = [];
  for (const work of sorted) {
    const p = headInsertPosition(list, work);
    const last = runs[runs.length - 1];
    if (last && last.start === p) last.items.push(work);
    else runs.push({ start: p, items: [work] });
  }
  // 按 run 逆序落库：先插靠后的 run 不影响靠前 run 的原始落点（最终相对序不变）；
  // run 内逐条前插，大数组禁 spread（同 #mountInsert 约定）
  for (let ri = runs.length - 1; ri >= 0; ri--) {
    const run = runs[ri];
    for (let i = run.items.length - 1; i >= 0; i--) list.splice(run.start, 0, run.items[i]);
  }
  state.dataVersion++; // 原地 splice 绕过 store 封装，须手动计入数据版本（视图缓存失效判据）
  // 预铺额度待消费 = 首页渲染排队中（rAF）：state 已就位即够——借道待渲渲染，
  // 无需头插也无需整刷
  if (state.gridSlots) return "deferred";
  // 网格按 run 逆序位插：#slots 尚无前序 run 的插入，原始落点即对位下标（靠后 run 先插、
  // 靠前 run 后插不改变已插区段的相对位置）；待观察队列经 #mountInsert 的 unshift 逆序
  // 累积后恰为文档序，与旧实现的升序插入结果一致
  for (let ri = runs.length - 1; ri >= 0; ri--) {
    if (!grid.insertItems(runs[ri].start, runs[ri].items)) return "fallback";
  }
  return "applied";
}

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
    case "IMPORT_WORKS_PROGRESS":
    case "CALIBRATE_PROGRESS":
      authorImport.onProgress(message);
      break;
    case "IMPORT_PROGRESS":
      importExport.onProgress(message);
      break;
    case "STORE_CHANGED":
      // 抖音标签页等外部上下文落库后的广播（options 不在其请求链路上）。
      // 点载荷（upserts）仅当前域接收：域不匹配直接丢弃——切域时自然整刷，且跨域回声
      // （批量入库的 works 广播绕回点赞/收藏域）就此零成本，连分组重算都省
      if (Array.isArray(message.upserts) && message.upserts.length > 0) {
        if (message.domain !== state.domain) break;
        const entries = storeChangedUpserts.get(message.domain) || new Map();
        for (const up of message.upserts) {
          entries.set(String(up.awemeId), { work: up, added: (message.addedIds || []).includes(up.awemeId) });
        }
        storeChangedUpserts.set(message.domain, entries);
      } else {
        storeChangedBulkDomains.add(message.domain);
        // bulk 轻量 id 载荷（changedIds = 实际写入记录 id，addedIds 为新增子集）：
        // flush 时按 id 补拉记录走增量管线；无载荷维持整刷收口
        if (Array.isArray(message.changedIds) && message.changedIds.length > 0) {
          const cur = storeChangedBulkIds.get(message.domain) || { changedIds: new Set(), addedIds: new Set() };
          for (const id of message.changedIds) cur.changedIds.add(String(id));
          for (const id of message.addedIds || []) cur.addedIds.add(String(id));
          storeChangedBulkIds.set(message.domain, cur);
        }
      }
      scheduleStoreChangedFlush();
      break;
    // 批量「取消并移除」由 Batch 内挂 requestId 专属 listener 消化，全局不处理
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && (storeChangedBulkDomains.size || storeChangedBulkIds.size || storeChangedUpserts.size)) {
    flushStoreChanged();
  }
});

// ---------- DOM 事件绑定 ----------
// X 关闭按钮：多层弹窗每层各有 ✕，document 级委托统一走关闭入口（作用于顶层）
document.addEventListener("click", (e) => {
  if (e.target.closest?.(".dy-dialog-close")) appShell.requestDialogClose();
});

// Esc 单点收口（本监听是全页唯一 Esc 裁决者）：按层级「弹窗 → 详情 → 失焦」依次收口。
// 弹窗打开 → 关弹窗（顶层 ✕ 同入口）；否则详情打开 → 退出详情；
// 都无 → 让当前聚焦元素失焦（搜索框常驻、无 S 开关；Esc 只退出输入聚焦）。批量模式不归
// Esc（由 B 键 / 「批量」按钮退出）。计数输入框内 Esc 走其自身监听（stopPropagation 还原
// 编辑、不关详情）；详情监听不得自管 Esc（同事件多监听串行，否则会连弹窗一并关掉）
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!dom.dialogOverlay.classList.contains("hidden")) {
    appShell.requestDialogClose();
    return;
  }
  if (!dom.detailOverlay.classList.contains("hidden")) {
    detail.closeDetail();
    return;
  }
  // 无覆盖层：仅让当前聚焦元素失焦，不改变任何层的开合状态
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) active.blur();
});

// 全局快捷键：? 速查、B 进入/退出批量模式、批量模式 Ctrl+A 全选 /
// Delete 删除 / I 入库 / M 移动到分组 / D 下载。输入框内一律不拦截；弹窗打开时跳过
// ?/B/Ctrl+A/Delete/I/M/D，避免与弹窗交互重叠
const isTypingTarget = (el) =>
  el instanceof HTMLElement && !!el.closest("input, textarea, select, [contenteditable]");
document.addEventListener("keydown", (e) => {
  const typing = isTypingTarget(e.target);
  if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing) {
    if (!dom.dialogOverlay.classList.contains("hidden")) return;
    e.preventDefault();
    showShortcutHelp();
    return;
  }
  if (state.batchMode && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
    if (typing || !dom.dialogOverlay.classList.contains("hidden")) return;
    e.preventDefault();
    batch.handleBatchSelectAll();
  }
  // 批量态 Delete：已勾选条目时直开删除确认弹窗（与批量按钮组的删除按钮同入口，
  // Enter 随后命中 danger 主按钮）。详情层的 Delete/Backspace（移除当前作品）让位——
  // 详情打开时本分支跳过，不叠加两套确认
  if (state.batchMode && e.key === "Delete") {
    if (
      typing ||
      !dom.dialogOverlay.classList.contains("hidden") ||
      !dom.detailOverlay.classList.contains("hidden")
    ) {
      return;
    }
    if (state.selectedIds.size === 0) return;
    e.preventDefault();
    batch.handleBatchDelete();
  }
  // 批量态操作快捷键：I 入库（关注域→候选域 / 点赞·收藏域→作品域）、M 移动到分组、
  // D 下载已勾选。与 Delete 同款守卫（输入框/弹窗/详情打开时让位）；未勾选或不适用
  // 的域由各方法自身早退兜底（与对应按钮的可用态一致）
  if (state.batchMode && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const actionKey = e.key.toLowerCase();
    if (actionKey === "i" || actionKey === "m" || actionKey === "d") {
      if (
        typing ||
        !dom.dialogOverlay.classList.contains("hidden") ||
        !dom.detailOverlay.classList.contains("hidden")
      ) {
        return;
      }
      e.preventDefault();
      if (actionKey === "i") batch.handleBatchSave();
      else if (actionKey === "m") batch.handleBatchMove();
      else batch.handleBatchDownload();
      return;
    }
  }
  // B 进入/退出批量模式（与「批量」按钮同入口，退出时同按钮语义清空选区）；弹窗/详情
  // 打开时不切换——避免在覆盖层背后改变底层网格的交互模式
  if ((e.key === "b" || e.key === "B") && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (
      typing ||
      !dom.dialogOverlay.classList.contains("hidden") ||
      !dom.detailOverlay.classList.contains("hidden")
    ) {
      return;
    }
    e.preventDefault();
    batch.handleBatchToggle();
  }
});

dom.btnBatch.addEventListener("click", () => batch.handleBatchToggle());
// 批量模式禁选文本（Shift 快速多选不被浏览器选中高亮打断）：不走 CSS user-select——
// 该类规则随 body.batch-mode 翻转触发全网格级联重算，万级 DOM 实测数百 ms，是进入
// 批量模式卡顿主因；改为 mousedown preventDefault（O(1)）。排除 input：进度条拖拽
// 需要默认行为；限定主键，避免破坏中键滚轮
dom.mainGrid.addEventListener("mousedown", (e) => {
  if (!state.batchMode || e.button !== 0) return;
  if (e.target.closest("input, textarea")) return;
  e.preventDefault();
});
dom.batchSelectAll.addEventListener("click", () => batch.handleBatchSelectAll());
dom.batchDelete.addEventListener("click", () => batch.handleBatchDelete());
dom.batchMove.addEventListener("click", () => batch.handleBatchMove());
dom.batchSaveToWorks.addEventListener("click", () => batch.saveSelectedToWorks());
dom.batchSaveToCandidates.addEventListener("click", () => batch.saveSelectedToCandidates());
dom.batchDownload.addEventListener("click", () => batch.handleBatchDownload());
dom.btnBatchDone.addEventListener("click", () => {
  if (state.batchMode) batch.handleBatchToggle();
});

dom.btnGroupManage.addEventListener("click", () => groups.showGroupManage());

dom.btnDataTools.addEventListener("click", () => importExport.openDialog());
dom.btnStatus.addEventListener("click", () => status.openDialog());
dom.fileInput.addEventListener("change", (e) => importExport.handleImport(e));

dom.btnSettings.addEventListener("click", () => settings.openPanel());

dom.btnSync.addEventListener("click", async () => {
  if (state.domain === config.REVIEW_DOMAIN) {
    dialog.showToast("回顾域不支持同步", "info");
    return;
  }
  // 候选域无账号同步数据源：相关操作已迁至「工具」弹窗，同步按钮只做指引
  if (state.domain === "candidates") {
    dialog.showToast("候选域不支持同步", "info");
    return;
  }
  // 各链路互斥由入口自守卫（syncFollowings/syncCurrentGroup/syncDomain 均检查 isRunning）
  if (state.domain === "followings") {
    await sync.syncFollowings();
  } else if (state.domain === "works") {
    await sync.syncCurrentGroup();
  } else {
    await domainScanSync.syncDomain(state.domain);
  }
});

dom.btnAuthorImport.addEventListener("click", () => authorImport.openDialog());

// 回顾分组行内联配置：单一「随机」入口 + 追加（落未分组，仅同来源域）
dom.btnReviewRandom?.addEventListener("click", () => randomReview.randomize());
dom.btnReviewAppend?.addEventListener("click", () => randomReview.append());
dom.reviewCountInput?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  randomReview.randomize();
});

// 整域重载入口（排序切换 / 批量兜底 / 详情兜底）：SearchBar 不反向 import app-shell，
// 避免模块图新增环。默认先关闭详情防止 #currentId 悬空；详情删除的兜底重载传
// keepDetail，让覆盖层保留并在重载完成后重新锚定
search.setReloadHandler((opts = {}) => {
  // 详情内删除走 keepDetail：重载在详情层背后完成，随后由 Detail 按新视图重新锚定
  // 下一件，避免「删当前作品 = 直接退出详情」的断崖体验
  if (!opts.keepDetail) detail.closeDetail();
  return appShell.reloadCurrentDomain();
});

// ---------- init IIFE ----------
(async function init() {
  // 构建标记：读取 manifest 版本，便于确认页面加载的是当前构建
  console.info(`[DDM] options build v${chrome.runtime.getManifest().version}`);
  dom.mainContainer.classList.add("hidden");
  dom.emptyState.classList.add("hidden");
  // 预加载运行时配置
  await runtimeConfig.load();
  for (const name of ["pause", "play", "mute", "unmute", "loopSingle", "loopGroup", "noLoop", "check"]) {
    config.icons[name] = document.getElementById("icon-" + name).innerHTML;
  }

  sidebar.initSidebar();
  detail.initDetailEvents();
  tooltip.initTooltip();

  // 离开扩展页面（切标签/最小化，页面转为隐藏）即暂停全部播放：
  // 卡片悬浮预览（含播放按钮直启）走 WorksGrid.stopAllMedia、侧栏悬停预览走
  // Sidebar.stopAllMedia、详情视频/图集音频走 Detail.pauseOnHidden
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) return;
    worksGrid.stopAllMedia();
    sidebar.stopAllMedia();
    detail.pauseOnHidden();
  });

  dom.groupTabs.addEventListener(
    "scroll",
    () => {
      groups.updateTabMask();
    },
    { passive: true },
  );
  // resize 滑块必须 no-anim 瞬移回 active tab（直接传函数引用会把 Event 对象当 animated 实参）。
  // 全局 resize 只保留这一个 rAF 节流入口（组合根统一布线，app-shell 不再自挂监听）：
  // 窗口拖拽期每帧最多一次域滑块 + 分组 tab 掩码重算 + 侧栏展开宽度钳制
  let resizeRaf = 0;
  window.addEventListener(
    "resize",
    () => {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        appShell.updateDomainSlider(state.domain);
        groups.updateTabMask();
        groups.updateGroupSlider(false);
        sidebar.clampOpenWidth();
      });
    },
    { passive: true },
  );

  store.on("domain", async () => {
    // 旧域的分组名/顺序/计数立即作废；新域快照到达后由 renderGroupTabs 一次落正确值
    groups.clearForDomainSwitch();
    batch.syncSaveToWorksBtn();
    batch.syncSaveToCandidatesBtn();
    // 分组快照先发：GET_DOMAIN_GROUPS 用原生 count，通常在 page-0 的 600 条记录读取前
    // 返回，分组栏先于搜索栏 K 成型；两者仍并行，grid 不被分组查询阻塞
    const groupsLoad = groups.renderGroupTabs();
    const dataLoad = appShell.loadDomainDataSafe();
    // 搜索栏域联动是纯 UI 同步，无数据依赖
    search.onDomainChanged();
    // 作品型三域的作品卡按作者域成员资格显示 chip：主键集延后到首屏渲染之后再取
    //（getAllKeys 与 page-0 游标并发会抢 IDB，实测首页往返被拖到 ~1s），到达后经
    // syncAuthorFlags 原地 patch 已挂载卡；失败降级为不显示 chip（作者域删除/移动
    // 不广播，切域刷新即兜底）
    const uidDomain = state.domain;
    const uidGroupId = state.currentGroupId;
    const uidSets = config.WORK_RECORD_DOMAINS.includes(uidDomain)
      ? services
          .whenFirstScreen(uidDomain, uidGroupId)
          .then(() => services.loadAuthorUidSets())
          .then((ok) => {
            if (ok && config.WORK_RECORD_DOMAINS.includes(state.domain)) {
              search.activeWorkRecordGrid().syncAuthorFlags();
            }
          })
      : Promise.resolve();
    await Promise.all([groupsLoad, uidSets, dataLoad]);
    // 滚动已在 switchDomain 显式归零（尾部占位使 wipe clamp 不再触发）
  });

  for (const domain of config.WORK_RECORD_DOMAINS) {
    store.on(domain, () => {
      if (state.domain === domain) search.refreshGridView();
    });
  }
  store.on("followings", () => {
    if (state.domain === "followings") search.refreshGridView();
  });
  store.on("candidates", () => {
    if (state.domain === "candidates") search.refreshGridView();
  });
  store.on("review", () => {
    if (state.domain !== config.REVIEW_DOMAIN) return;
    // 回顾批次来源可能是作品或作者：数据到达后同步搜索栏的域相关控件，再重渲视图
    search.syncForDomain();
    search.refreshGridView();
  });
  store.on("groups", () => {
    groups.renderGroupTabs();
  });
  // 切换分组与域切换同序列：点击即清场（abortRender+wipe，只清不铺），数据到达后由
  // render() 首屏同步铺骨架、余量拼装一次挂载并按槽回填（点击→首屏空白由首页快取数
  // ~50ms + 全量预铺压到不可感知）
  store.on("currentGroupId", async () => {
    appShell.clearActiveGrid();
    // 计数占位：K 恒 0（有同源分组缓存显示 0，无缓存显示「…」，见 SearchBar.syncCount）
    const groupId = state.currentGroupId;
    const cachedTotal = state.gridTotals[`${state.domain}|${groupId}`];
    state.gridPending = true;
    state.gridTotal = cachedTotal != null ? { domain: state.domain, groupId, total: cachedTotal } : null;
    dom.sbCount.textContent = cachedTotal != null ? "0" : "…";
    // tab 集合未变，仅同步激活态 + 滑块动画（renderGroupTabs 会重建 tab、毁掉滑动起点）
    groups.syncActiveTabs();
    await appShell.loadDomainDataSafe();
  });
  // 分页渐进回填（作品型三域，loadDomainData 逐页发出）：页序与视图序单调一致时按视图
  // 下标续填（键前缀自锚定）+ 刷新计数，完成时摘除尾部未回填占位卡；不一致时（作品数
  // 排序依赖全库 rank，或加载中途切了排序/逆序导致取数方向失配）静默累积，加载完成一次性
  // 整渲。domain/groupId 双校验，防止切换瞬间在途旧页混入新网格
  store.on("work-record-appended", (event) => {
    const { domain, groupId, items, done } = event;
    if (state.domain !== domain || state.currentGroupId !== groupId) return;
    if (!search.isPageAligned(event)) {
      // 页序与视图序不对齐：DOM 静默累积到加载完成再整渲；K 计数逐页刷新（避免 done
      // 时刻一次性跳变——用户按旧版直觉核对加载进度）。完成态整渲经节点复用重排，
      // 已渲染卡保留封面/文案，只有首次进榜的条目走新骨架填充
      search.syncCount();
      if (done) search.refreshGridView();
      return;
    }
    // 页序对齐：过滤后剩余条目保持页内顺序，即视图尾部的一段连续区间；起点 = 全量视图
    // 长度 − 本页可见条数（按数据侧下标推算，与网格待处理队列状态无关）
    const grid = search.activeWorkRecordGrid();
    const view = search.getWorksView();
    const pageView = search.filterPageForView(items);
    let refreshed = false;
    if (pageView.length) {
      // 首页视图为零命中时网格停在空态壳（容器 hidden、无槽位），按槽续填无可落点：
      // 直接整渲当前已加载视图，后续页再走续填（整渲自带尾部占位，收尾无需再 prune）
      if (grid.renderedItems()?.length) {
        grid.fillSlots(view.length - pageView.length, pageView);
      } else {
        search.refreshGridView();
        refreshed = true;
      }
    }
    if (done && !refreshed) grid.pruneEmptyTail();
    search.syncCount(view.length);
  });
  store.on("batchMode", (v) => {
    document.body.classList.toggle("batch-mode", v);
    batch.syncSelectionUI();
  });

  document.body.dataset.domain = "works";
  appShell.updateDomainSlider("works");
  // 首屏同样并行：首页数据请求先发，分组 tab 与作者主键集不挡首帧；chip 主键集等首屏
  // 渲染后再取（避免与 page-0 抢 IDB），到达后原地 patch 已挂载卡
  const dataLoad = appShell.loadDomainDataSafe();
  const uidSets = services
    .whenFirstScreen("works", state.currentGroupId)
    .then(() => services.loadAuthorUidSets())
    .then((ok) => {
      if (ok && config.WORK_RECORD_DOMAINS.includes(state.domain)) {
        search.activeWorkRecordGrid().syncAuthorFlags();
      }
    });
  await Promise.all([groups.renderGroupTabs(), uidSets, dataLoad]);
  // 清理历史版本搜索态 hash 残留：旧版 URL 持久化已移除（读取方已删，URL 不再承载
  // 任何状态），旧标签页 URL 上残留的 #search?... 会随刷新永久保留，一次性剥掉即可。
  // 放在 init 尾部不影响首屏；此后全仓无任何 hash 读写方
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
})();
