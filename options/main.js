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
import { detail } from './components/detail.js';
import { appShell } from './components/app-shell.js';

// ---------- 快捷键速查（P0-3）：'?' 打开静态内容弹窗 ----------
const SHORTCUT_ROWS = [
  ["Ctrl+K", "展开并聚焦搜索栏"],
  ["?", "打开快捷键速查"],
  ["Esc", "关闭弹窗 / 详情 / 退出批量 / 收起搜索"],
  ["详情 · ↑/↓ 或 滚轮", "切换上/下一个作品"],
  ["详情 · Space", "播放 / 暂停"],
  ["详情 · M", "静音 / 取消静音"],
  ["详情 · L", "循环模式（单作品 / 分组 / 关闭）"],
  ["详情 · F", "全屏播放"],
  ["详情 · ←/→", "图集翻页（多图作品）"],
  ["详情 · Delete / Backspace", "移除当前作品（弹确认）"],
  ["批量 · Ctrl+A", "全选当前结果"],
  ["批量 · Shift+点击", "范围选择"],
];

function showShortcutHelp() {
  const rows = SHORTCUT_ROWS.map(
    ([keys, desc]) => `<kbd>${keys}</kbd><span class="sh-desc">${desc}</span>`,
  ).join("");
  const body = document.createElement("div");
  body.className = "shortcut-help";
  body.innerHTML = rows;
  dialog.showDialog("快捷键", body, [{ text: "好的", primary: true, callback: () => dialog.closeDialog() }]);
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
  for (const domain of bulkDomains) {
    if (domain !== state.domain) continue;
    // 当前域 bulk 收口：作品型三域带 id 载荷 → 补拉记录后增量应用（零整刷）；无载荷
    // （关注域等）或补拉失败 → 整域重载兜底
    if (config.WORK_RECORD_DOMAINS.includes(domain) && bulkIdsByDomain.has(domain)) {
      applyBulkChanged(domain, bulkIdsByDomain.get(domain));
      continue;
    }
    services.loadDomainData().catch(() => {});
  }
  for (const [domain, entries] of upsertsByDomain) {
    applyStoreUpserts(domain, [...entries.values()]);
  }
}

// bulk 收口：按广播 id 集合补拉合并后记录（GET_WORKS_BY_IDS，IDB 主键直取），复用
// 点载荷的局部应用管线；补拉失败/记录全缺（落库后又被删除等）→ 整域重载兜底。
// 拉取间隙用户切域由 applyStoreUpserts 的域校验兜底（过期载荷作废，切回自然整刷）
async function applyBulkChanged(domain, ids) {
  // 补拉规模守卫：响应是全记录过消息通道（千条 ≈ MB 级 structured clone），且超大新增
  // 本就会撞 tryHeadInsert 的预铺容量守卫打回整刷——超限直接整刷兜底，省一次巨型往返
  if (ids.changedIds.size > config.GRID_PREMOUNT_CAP) {
    services.loadDomainData().catch(() => {});
    return;
  }
  const res = await services.bgMsg({ type: "GET_WORKS_BY_IDS", domain, ids: [...ids.changedIds] }).catch(() => null);
  if (!res || res.error || !Array.isArray(res.items) || res.items.length === 0) {
    services.loadDomainData().catch(() => {});
    return;
  }
  applyStoreUpserts(domain, res.items.map((w) => ({ work: w, added: ids.addedIds.has(String(w.awemeId)) })));
}

// 点/bulk 变化局部应用：逐条按「state 内已存在 / 新增落点」分流。已存在 → 原地替换 +
// updateCardsDOM（无计数变化，零 background 往返）；新增且落在当前视图 → tryHeadInsert
// （state 同步 splice + 网格头插，零整刷）；新增且落在当前视图外 → 只重算分组数字
//（网格不受当前视图影响）。任一条需整刷则整域整刷——部分应用会让 state/网格口径不一
function applyStoreUpserts(domain, entries) {
  if (domain !== state.domain || !config.WORK_RECORD_DOMAINS.includes(domain)) return;
  if (search.isFilterActive() || state.batchMode || !dom.detailOverlay.classList.contains("hidden")) {
    store.refreshGroups();
    services.loadDomainData().catch(() => {});
    return;
  }
  let needCounts = false; // 当前视图外的新增：分组数字变了
  let needReload = false; // 头插守卫不过：整刷兜底
  const domUpdates = []; // { awemeId, work }：批量卡更新的现成记录（免逐条 state.find）
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
      list[idx] = work;
      domUpdates.push({ awemeId: work.awemeId, work });
    } else if (added) {
      if (state.currentGroupId === "all" || work.groupId === state.currentGroupId) viewAdds.push(work);
      else needCounts = true;
    }
    // 未新增且不在 state（视图外已有记录的内容更新）：计数与网格均不受影响，跳过
  }
  if (domUpdates.length > 0) {
    state.dataVersion++; // 原地替换绕过 store 封装，整批计入一次数据版本（视图缓存失效判据）
  }
  if (viewAdds.length > 0) {
    if (tryHeadInsert(domain, viewAdds) === "fallback") {
      needReload = true;
    } else {
      // 头插/借道待渲渲染成功：分组计数、结果数与 Shift 范围锚点随之收口
      store.refreshGroups();
      search.syncCount();
      batch.resetRangeAnchor(); // 顺序已变，旧锚点在新顺序中的索引失效（与 refreshGridView 同理）
    }
  }
  if (needReload) {
    store.refreshGroups();
    services.loadDomainData().catch(() => {});
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

// Esc 关闭优先级单点收口（本监听是全页唯一 Esc 裁决者）：弹窗 → 详情 → 退出批量 → 收起
// 搜索栏，一次按键只关一层。详情不能自管 Esc——弹窗叠在详情层之上时，本监听先关掉弹窗，
// detail 的 document 监听在同一事件内随后执行，此时它查 dialogOverlay 已是关闭态，若由
// detail 自管 Esc 会把详情一并关掉（同事件多监听串行，后者看到的是前者处理后的状态）
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
  if (state.batchMode) {
    batch.handleBatchToggle();
    return;
  }
  search.closeSearchBar();
});

// 全局快捷键（P0-3/P1-7）：Ctrl+K 聚焦搜索、? 速查、批量模式 Ctrl+A 全选。
// 输入框内一律不拦截；弹窗打开时跳过 ?/Ctrl+A，避免与弹窗交互重叠
const isTypingTarget = (el) =>
  el instanceof HTMLElement && !!el.closest("input, textarea, select, [contenteditable]");
document.addEventListener("keydown", (e) => {
  const typing = isTypingTarget(e.target);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    if (typing) return;
    // 弹窗/详情打开时不展开搜索栏，避免在覆盖层背后展开
    if (!dom.dialogOverlay.classList.contains("hidden")) return;
    if (!dom.detailOverlay.classList.contains("hidden")) return;
    e.preventDefault();
    search.openSearchBar();
    return;
  }
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
dom.batchDownload.addEventListener("click", () => batch.handleBatchDownload());

dom.btnGroupManage.addEventListener("click", () => groups.showGroupManage());

dom.btnDataTools.addEventListener("click", () => importExport.openDialog());
dom.fileInput.addEventListener("change", (e) => importExport.handleImport(e));

dom.btnSettings?.addEventListener("click", () => settings.openPanel());

dom.btnSync.addEventListener("click", async () => {
  if (sync.isRunning() || domainScanSync.isRunning() || authorImport.isRunning()) return;
  if (state.domain === "followings") {
    await sync.syncFollowings();
  } else if (state.domain === "works") {
    await sync.syncCurrentGroup();
  } else {
    await domainScanSync.syncDomain(state.domain);
  }
});

dom.btnAuthorImport.addEventListener("click", () => authorImport.openDialog());

// ---------- init IIFE ----------
(async function init() {
  // 构建标记：用于确认页面运行的是最新构建（头像探针预载版）
  console.info("[DDM] options build 2026-08-26 four-domain");
  dom.mainContainer.classList.add("hidden");
  dom.emptyState.classList.add("hidden");
  // 预加载运行时配置
  await runtimeConfig.load();
  for (const name of ["pause", "play", "mute", "unmute", "loopSingle", "loopGroup", "noLoop", "check"]) {
    config.icons[name] = document.getElementById("icon-" + name).innerHTML;
  }

  sidebar.initSidebar();
  appShell.initLeftSidebar();
  detail.initDetailEvents();

  // 离开扩展页面（切标签/最小化，页面转为隐藏）即暂停全部播放：
  // 卡片悬浮预览（含播放按钮直启）走 WorksGrid.stopAllMedia；详情视频/图集音频走 Detail.pauseOnHidden
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) return;
    worksGrid.stopAllMedia();
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
  // 窗口拖拽期每帧最多一次域滑块 + 分组 tab 掩码重算
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
      });
    },
    { passive: true },
  );

  store.on("domain", async () => {
    batch.syncSaveToWorksBtn();
    await groups.renderGroupTabs();
    search.onDomainChanged();
    // 方案A：作者归属判定依赖关注全集，域切换时异步刷新；完成后归属筛选仍生效则重渲网格
    services.loadFollowedUids().then((ok) => {
      if (ok && search.isOwnerFilterActive()) search.refreshGridView();
    });
    await appShell.loadDomainDataSafe();
    // 滚动已随 switchDomain 点击时刻的 wipe clamp 归零
  });

  store.on("works", () => {
    if (state.domain === "works") search.refreshGridView();
  });
  store.on("followings", async () => {
    // 方案A：关注数据变化时同步刷新关注全集，保证作者归属判定不过期
    await services.loadFollowedUids();
    if (state.domain === "followings" || search.isOwnerFilterActive()) search.refreshGridView();
  });
  store.on("favorites", () => {
    if (state.domain === "favorites") search.refreshGridView();
  });
  store.on("collections", () => {
    if (state.domain === "collections") search.refreshGridView();
  });
  store.on("groups", () => groups.renderGroupTabs());
  // 切换分组与域切换同序列：点击即清场（abortRender+wipe，只清不铺），数据到达后由
  // render() 首屏同步铺骨架、余量拼装一次挂载并按槽回填（点击→首屏空白由首页快取数
  // ~50ms + 全量预铺压到不可感知）
  store.on("currentGroupId", async () => {
    appShell.clearActiveGrid();
    // tab 集合未变，仅同步激活态 + 滑块动画（renderGroupTabs 会重建 tab、毁掉滑动起点）
    groups.syncActiveTabs();
    await appShell.loadDomainDataSafe();
  });
  // 分页渐进回填（作品型三域，loadDomainData 逐页发出）：默认视图按槽回填（网格侧以
  // 键前缀自锚定落点）+ 刷新计数，完成时摘除尾部未回填占位卡；筛选激活时静默累积
  // （逆序/作者聚类破坏页序对齐），加载完成一次性整渲。domain/groupId 双校验，
  // 防止切换瞬间在途旧页混入新网格
  store.on("work-record-appended", ({ domain, groupId, items, start, done }) => {
    if (state.domain !== domain || state.currentGroupId !== groupId) return;
    if (search.isFilterActive()) {
      if (done) search.refreshGridView();
      return;
    }
    const grid = search.activeWorkRecordGrid();
    grid.fillSlots(start, items);
    if (done) grid.pruneEmptyTail();
    search.syncCount();
  });
  store.on("batchMode", (v) => {
    document.body.classList.toggle("batch-mode", v);
    batch.syncSelectionUI();
  });

  document.body.dataset.domain = "works";
  appShell.updateDomainSlider("works");
  await groups.renderGroupTabs();
  // 方案A预载关注全集与首屏数据并行：归属判定懒消费（未加载成功时不归判本就是设计
  // 行为），串行等待让启动首屏多付一次全量关注域往返；它自增 dataVersion 但无
  // refreshGridView 触发方，不会引发首渲后重渲
  const followedUidsLoading = services
    .loadFollowedUids()
    .catch((err) => console.error("[DY] load followed uids failed:", err));
  await appShell.loadDomainDataSafe();
  await followedUidsLoading;
  // 清理历史版本搜索态 hash 残留：P1-8 的 URL 持久化已移除（读取方已删，URL 不再承载
  // 任何状态），旧标签页 URL 上残留的 #search?... 会随刷新永久保留，一次性剥掉即可。
  // 放在 init 尾部不影响首屏；此后全仓无任何 hash 读写方
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
})();
