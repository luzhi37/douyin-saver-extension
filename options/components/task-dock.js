// ---------- TaskDock ----------
// 非模态任务面板：固定右下角，不遮罩、不抢焦点、不参与 Esc 层级。
// 数据只来自任务消息（TASK_PROGRESS / TASK_DONE）与 GET_TASK_STATE，不写 store、不触发网格重渲。
import { dom, services } from "../core.js";
import { dialog } from "./dialog.js";

const n = (v) => Number(v || 0).toLocaleString("zh-CN");

const STATE_TEXT = {
  queued: "QUEUED",
  running: "SYNCING",
  paused: "PAUSED",
  done: "DONE",
  partial: "PARTIAL",
  cancelled: "CANCELLED",
  failed: "ERROR",
};

// 终态集合：行保留到用户点「关闭」；非终态（queued/running/paused）受任务坞生命周期管理
const DONE_STATUSES = new Set(["done", "partial", "cancelled", "failed"]);

// 每类任务沿用其原进度弹窗的行内文案；count/summary 模板读 item.data（进度与终态字段的超集）。
const scanSummary = (d) => {
  const saved = d.saved || {};
  const parts = [`新增 ${n(saved.added)}`, `更新 ${n(saved.updated)}`];
  if (d.lostUids?.length) parts.push(`已取消 ${n(d.lostUids.length)} 个`);
  return parts.join(" · ");
};

const genericToast = (label, doneText) => (d) => {
  if (d.status === "failed") return `${label}失败：${d.error || "未知错误"}`;
  if (d.status === "cancelled") return `已取消${label}`;
  if (d.status === "partial") return `已中途取消，${doneText(d)}`;
  return doneText(d);
};

// 扫描/校准/取消三族的成对条目仅文案差：工厂生成，逐字保留原文案（docs/13 红线）
const makeScanKind = (label, fetchingText, toastLabel) => ({
  label,
  count: (d) => `已扫描作品 ${n(d.collected ?? d.processed)}`,
  summary: (d) => (d.status === "running" ? `正在获取${fetchingText}…` : scanSummary(d)),
  pickTrashIds: (m) => m.lostUids || [],
  partialOnCancel: true,
  toast: genericToast(toastLabel, scanSummary),
});

const makeCalibrateKind = (label, memberNoun, toastLabel) => ({
  label,
  count: (d) => `已校准${memberNoun}作者 ${n(d.collected ?? d.processed)} / ${n(d.total)}`,
  summary: (d) =>
    d.status === "running"
      ? "正在校准作品/粉丝数…"
      : d.status === "partial"
        ? `已校准${memberNoun}作者 ${n(d.processed)}，已校准部分已落库，未校准作者保留原计数`
        : d.status === "failed"
          ? "校准中断，未写入任何计数"
          : `校准完成：共 ${n(d.total)} 位${memberNoun}作者，更新 ${n(d.updated)} 条计数`,
  partialOnCancel: true,
  toast: genericToast(toastLabel, (d) => `更新 ${n(d.updated)} 条计数`),
});

const makeCancelKind = (label, doneNoun) => ({
  label,
  count: (d) =>
    d.status === "running"
      ? `正在${label}… ${n(d.processed)} / ${n(d.total)}`
      : `已${label} ${n(d.processed)} / ${n(d.total)}`,
  summary: (d) =>
    d.status === "running"
      ? `正在${label}…`
      : d.status === "cancelled"
        ? "已中途取消，其余未处理保留"
        : `失败 ${n(d.failed)} 个保留`,
  toast: (d) =>
    d.status === "failed"
      ? `${label}中断：已移除 ${n(d.refreshed)} 个，其余保留`
      : d.status === "cancelled"
        ? "已中途取消：已移除部分，其余未处理保留"
        : `已${doneNoun} ${n(d.refreshed)} 个，${n(d.failed)} 个失败保留`,
});

const KIND_CONFIG = {
  syncWorks: {
    label: "同步作品",
    count: (d) => `已同步作品 ${n(d.processed)} / ${n(d.total)}`,
    // 限流瞬态：TASK_PROGRESS 携带 rateLimited:true 时立即可见（退避重试期间无计数变化，
    // 靠该字段回报；下一条普通上报恒带 false 复位）
    // 终态：skipped = 未判定条数，如实报「未处理」，不得并入已同步口径（取消/熔断时 processed < total）
    summary: (d) =>
      d.status === "running" && d.rateLimited
        ? "已触发限流，退避重试中…"
        : d.status === "cancelled"
          ? `已更新 ${n(d.refreshed)} · 失败 ${n(d.failed)} · ${n(d.skipped)} 条未处理`
          : d.skipped > 0
            ? `同步失败作品 ${n(d.failed)} 个 · 跳过 ${n(d.skipped)} 条`
            : `同步失败作品 ${n(d.failed)} 个`,
    pickTrashIds: (m) => m.failedAwemeIds || [],
    toast: (d) =>
      d.status === "cancelled"
        ? `已取消，已更新 ${n(d.refreshed)} 条 · ${n(d.skipped)} 条未处理`
        : d.status === "failed"
          ? `同步中断：${d.error || "未知错误"}`
          : `同步完成：更新 ${n(d.refreshed)} · 失败 ${n(d.failed)}`,
  },
  scanFavorites: makeScanKind("同步点赞", "点赞", "点赞扫描"),
  scanCollections: makeScanKind("同步收藏", "收藏", "收藏扫描"),
  syncFollowings: {
    label: "同步关注",
    count: (d) => `已同步作者 ${n(d.collected ?? d.processed)} / ${n(d.total)}`,
    // 终态区分：丢失结论仅完整扫描产出——取消/失败时 lost=0 是「没跑完」而非结论，
    // 不得与完成态共用「取消关注 N」文案
    summary: (d) =>
      d.status === "running"
        ? "正在获取关注…"
        : d.status === "done"
          ? `新增关注 ${n(d.added)}，取消关注 ${n(d.lost)}`
          : `已写入新增关注 ${n(d.added)} 条 · 未跑完，取消关注结论未产出`,
    pickTrashIds: (m) => m.lostUids || [],
    toast: genericToast("关注同步", (d) => `新增关注 ${n(d.added)}，取消关注 ${n(d.lost)}`),
  },
  calibrateFollowings: makeCalibrateKind("校准关注数据", "关注", "关注校准"),
  calibrateCandidates: makeCalibrateKind("校准候选数据", "候选", "候选校准"),
  importWorks: {
    label: "导入作者作品",
    count: (d) => {
      const saved = d.status === "running" ? d.savedCount : (d.added || 0) + (d.updated || 0);
      const total = d.total > 0 ? ` / 约 ${n(d.total)}` : "";
      return `已扫描作品 ${n(d.collected ?? d.processed)}${total} · 已入库 ${n(saved)}`;
    },
    summary: (d) =>
      d.status === "running"
        ? "正在获取作者作品…"
        : d.status === "partial"
          ? `新增 ${n(d.added)}（入「未分组」）· 更新 ${n(d.updated)}（保留原分组）`
          : d.status === "failed"
            ? `作品域入库中断：已扫描 ${n(d.collected ?? d.processed)} 个作品，已写入新增 ${n(d.added)} · 更新 ${n(d.updated)}`
            : `作品域入库完成：已扫描 ${n(d.collected ?? d.processed)} 个作品，新增 ${n(d.added)} · 更新 ${n(d.updated)}`,
    partialOnCancel: true,
    toast: genericToast("作品域入库", (d) => `新增 ${n(d.added)} · 更新 ${n(d.updated)}`),
  },
  importData: {
    label: "整域导入",
    count: (d) => `已导入记录 ${n(d.processed)} / ${n(d.total)}`,
    summary: (d) =>
      d.status === "running"
        ? "正在分块落库…"
        : d.status === "partial"
          ? `已写入部分已落库（新增 ${n(d.added)} · 更新 ${n(d.updated)}），其余未写入`
          : `新增 ${n(d.added)} · 更新 ${n(d.updated)}${d.invalid ? ` · 无效 ${n(d.invalid)}` : ""}`,
    // 取消 = 保留已写入部分（对齐校准族）：timedOut + partialOnCancel → 行状态 PARTIAL
    partialOnCancel: true,
    toast: (d) =>
      d.status === "failed"
        ? `导入失败：${d.error || "未知错误"}`
        : d.status === "cancelled"
          ? "已取消导入，已写入部分已保留"
          : d.status === "partial"
            ? `导入已取消：新增 ${n(d.added)} · 更新 ${n(d.updated)}（已写入部分保留）`
            : `导入完成：新增 ${n(d.added)} · 更新 ${n(d.updated)}`,
  },
  // 本地任务（不经 background 队列，batchDownload 同款宿主回调自理）
  exportData: {
    label: "整域导出",
    count: (d) => `已导出记录 ${n(d.processed)} / ${n(d.total)}`,
    summary: (d) =>
      d.status === "running"
        ? "正在拉取记录…"
        : d.status === "failed"
          ? d.error || "导出失败"
          : d.status === "cancelled"
            ? "已取消，未保存文件"
            : `已保存 ${n(d.processed)} 条记录`,
    toast: (d) =>
      d.status === "failed"
        ? d.error || "导出失败"
        : d.status === "cancelled"
          ? "已取消导出，未保存文件"
          : `导出完成，已下载 ${d.filename || "文件"}`,
  },
  batchDownload: {
    label: "批量下载",
    count: (d) => `已下载作品 ${n(d.processed)} / ${n(d.total)}`,
    summary: (d) => {
      if (d.status === "running") {
        return d.phase === "zip"
          ? `正在打包 zip ${n(d.zipDone)} / ${n(d.zipTotal)} 条…`
          : "正在获取媒体流…";
      }
      if (d.status === "cancelled") return `已取消，已获取 ${n(d.processed)} 条媒体未打包`;
      const parts = [`zip 已保存 ${n(d.processed)} 条`];
      if (d.failed > 0) parts.push(`失败 ${n(d.failed)}`);
      if (d.unavailable > 0) parts.push(`不可用跳过 ${n(d.unavailable)}`);
      if (d.skipped > 0) parts.push(`无链接跳过 ${n(d.skipped)}`);
      return parts.join(" · ");
    },
    toast: (d) => {
      if (d.status === "failed") return `批量下载失败：${d.error || "未知错误"}`;
      if (d.status === "cancelled") return `已取消批量下载，已获取 ${n(d.processed)} 条媒体未打包`;
      const parts = [`已保存 ${n(d.processed)} 个作品 zip`];
      if (d.failed > 0) parts.push(`${d.failed} 个失败：${d.failedIds || ""}`);
      if (d.unavailable > 0) parts.push(`${d.unavailable} 个不可用跳过`);
      if (d.skipped > 0) parts.push(`${d.skipped} 个无链接跳过`);
      return parts.join("，");
    },
  },
  cancelFavorites: makeCancelKind("取消点赞", "取消"),
  cancelCollections: makeCancelKind("取消收藏", "取消"),
};

// 进度消息附加字段（各族超集，按存在与否合并，不覆盖核心状态字段）
const PROGRESS_FIELDS = [
  "ok", "failed", "skipped", "changed", "refreshed", "collected",
  "phase", "savedCount", "elapsed",
  "zipDone", "zipTotal", "rateLimited",
];
// 终态消息附加字段
const DONE_FIELDS = [
  "refreshed", "failed", "skipped", "changed", "saved", "lost", "lostUids",
  "added", "updated", "collected", "deletedIds", "elapsed",
  "unavailable", "failedIds", "invalid", "filename",
];

function makeButton(text, cls, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `dy-btn dy-btn-sm ${cls}`;
  btn.textContent = text;
  btn.addEventListener("click", onClick);
  return btn;
}

function configOf(kind) {
  return KIND_CONFIG[kind] || KIND_CONFIG.syncWorks;
}

class TaskDock {
  #items = new Map(); // taskId -> { data, els, onTrash, onDone, actionSig }
  #collapsed = false;
  #port = null;
  #portTaskIds = new Set();
  #running = false;
  #runningListeners = new Set();

  constructor() {
    dom.taskDockToggle?.addEventListener("click", () => this.toggle());
  }

  // 非终态任务（queued/running/paused）判定：全局单任务 + 队列语义下的「忙」
  hasPendingIn(domain = null) {
    for (const { data } of this.#items.values()) {
      if (!DONE_STATUSES.has(data.status) && (!domain || data.domain === domain)) return true;
    }
    return false;
  }

  isDomainBusy(domain) {
    return this.hasPendingIn(domain);
  }

  // 同 kind 去重：该类型存在非终态任务（queued/running/paused）即忙
  isKindBusy(kind) {
    for (const { data } of this.#items.values()) {
      if (!DONE_STATUSES.has(data.status) && data.kind === kind) return true;
    }
    return false;
  }

  isAnyRunning() {
    return this.hasPendingIn();
  }

  // 运行态变化订阅：外围入口（如设置按钮）按任务运行态禁用；订阅即回调当前值
  onRunningChange(fn) {
    this.#runningListeners.add(fn);
    fn(this.#running);
    return () => this.#runningListeners.delete(fn);
  }

  // 本页发起且未终态的任务（排除另一个 options 页的只读任务）：beforeunload 提示用
  hasOwnPending() {
    for (const { data } of this.#items.values()) {
      if (!DONE_STATUSES.has(data.status) && !data.external) return true;
    }
    return false;
  }

  // 发起页登记任务并渲染行；返回 item（外部页面用 applyQueue 走同一入口）。
  // status 允许直接以 queued 登记（同步发起时若已有任务在跑）。
  // 本地任务（不经 background 队列，如批量下载）传入 onPause/onResume/onCancel，
  // 行按钮改走宿主回调而非 PAUSE_TASK/RESUME_TASK/CANCEL_TASK 消息。
  begin({ taskId, kind = "syncWorks", domain = "works", total = 0, hint = "",
          status = "running",
          onTrash = null, onDone = null,
          onPause = null, onResume = null, onCancel = null }) {
    const template = document.getElementById("taskDockItemTemplate");
    const root = template.content.firstElementChild.cloneNode(true);
    const item = {
      data: {
        taskId: String(taskId),
        kind,
        domain,
        label: configOf(kind).label,
        hint: String(hint || ""),
        total: Number(total) || 0,
        processed: 0,
        ok: 0,
        failed: 0,
        skipped: 0,
        changed: 0,
        refreshed: 0,
        collected: 0,
        status,
        startedAt: Date.now(),
        finishedAt: 0,
        error: "",
        trashIds: [],
        cancelling: false,
        pausing: false,
        external: false,
        trashing: false,
        trashed: false,
      },
      els: {
        root,
        count: root.querySelector(".sync-count"),
        summary: root.querySelector(".sync-summary"),
        status: root.querySelector(".sync-status"),
        actions: root.querySelector(".task-dock-actions"),
      },
      onTrash,
      onDone,
      onPause,
      onResume,
      onCancel,
      actionSig: "",
    };
    this.#items.set(item.data.taskId, item);
    dom.taskDockBody.appendChild(root);
    this.#show();
    // 新任务启动默认展开，避免用户上次收起后看不到进度
    if (this.#collapsed) this.toggle();
    this.#render(item);
    return item;
  }

  // 控制端口：单 port 复用，可为多个排队任务各发一次 BIND_TASK；
  // port 断开 = 页面关闭/刷新/SW 回收，后台把该端口绑定的全部任务按 PAGE_CLOSED 取消
  bindPort(taskId) {
    const id = String(taskId);
    try {
      if (!this.#port) {
        this.#port = chrome.runtime.connect({ name: "task-control" });
        this.#port.onDisconnect.addListener(() => {
          // 关页/刷新/SW 回收：后台已按 PAGE_CLOSED 取消全部绑定任务，这里只收口 UI
          const ids = [...this.#portTaskIds];
          this.#port = null;
          this.#portTaskIds.clear();
          for (const tid of ids) {
            const item = this.#items.get(tid);
            if (item && !DONE_STATUSES.has(item.data.status)) {
              item.data.status = "failed";
              item.data.error = item.data.error || "连接已断开（后台可能被回收）";
              item.data.finishedAt = Date.now();
              this.#render(item);
            }
          }
        });
      }
      this.#port.postMessage({ type: "BIND_TASK", taskId: id });
      this.#portTaskIds.add(id);
      return true;
    } catch (err) {
      const item = this.#items.get(id);
      if (item) {
        item.data.status = "failed";
        item.data.error = err.message || "无法连接后台";
        this.#render(item);
      }
      return false;
    }
  }

  // 队列同步：GET_TASK_STATE（init）与 TASK_QUEUE_CHANGED（实时广播）共用。
  // 非终态任务逐个登记/更新行（本页发起的行保留回调与 local 语义），并按队列序重排 DOM；
  // 终态任务不建行（由 TASK_DONE 收口，行保留到用户点「关闭」）。
  applyQueue(tasks = []) {
    for (const t of tasks || []) {
      if (!t || DONE_STATUSES.has(t.status)) continue;
      const id = String(t.taskId);
      const existing = this.#items.get(id);
      if (existing) {
        Object.assign(existing.data, {
          status: t.status,
          hint: t.hint || existing.data.hint,
          pausing: t.pauseRequested === true && t.status === "running",
          processed: Number(t.processed) || 0,
          total: Number(t.total) || existing.data.total,
        });
        this.#render(existing);
      } else {
        const item = this.begin({
          taskId: id,
          kind: t.kind || "syncWorks",
          domain: t.domain || "works",
          total: t.total,
          status: t.status,
        });
        item.data.external = true;
        Object.assign(item.data, {
          processed: Number(t.processed) || 0,
          collected: Number(t.processed) || 0,
          ok: Number(t.ok) || 0,
          failed: Number(t.failed) || 0,
          skipped: Number(t.skipped) || 0,
          changed: Number(t.changed) || 0,
          startedAt: t.startedAt || Date.now(),
        });
        this.#render(item);
      }
    }
    // 按队列顺序重排 DOM（复用节点，不重建）
    for (const t of tasks || []) {
      if (!t || DONE_STATUSES.has(t.status)) continue;
      const item = this.#items.get(String(t.taskId));
      if (item) dom.taskDockBody.appendChild(item.els.root);
    }
  }

  onProgress(msg) {
    const item = this.#items.get(String(msg?.taskId || ""));
    if (!item || item.data.status !== "running") return;
    const d = item.data;
    d.processed = Math.max(d.processed, Number(msg.processed) || 0);
    d.total = Number(msg.total) || d.total;
    for (const key of PROGRESS_FIELDS) {
      if (msg[key] !== undefined) d[key] = msg[key];
    }
    if (d.collected < d.processed) d.collected = d.processed;
    this.#render(item);
  }

  onDone(msg) {
    const id = String(msg?.taskId || "");
    const item = this.#items.get(id);
    if (!item) return;
    const cfg = configOf(item.data.kind);
    const partial = Boolean(msg.timedOut) && cfg.partialOnCancel === true;
    const status = !msg.ok ? "failed" : partial ? "partial" : msg.cancelled ? "cancelled" : "done";
    const d = item.data;
    d.status = status;
    d.processed =
      Number(msg.processed) || Number(msg.collected) ||
      (Number(msg.refreshed) || 0) + (Number(msg.failed) || 0) || // skipped=未判定，不计入已同步
      d.processed;
    d.total = Number(msg.total) || d.total;
    d.collected = Number(msg.collected) || d.processed;
    for (const key of DONE_FIELDS) {
      if (msg[key] !== undefined) d[key] = msg[key];
    }
    d.trashIds = cfg.pickTrashIds ? cfg.pickTrashIds(msg) : [];
    d.error = msg.error || "";
    d.finishedAt = Date.now();
    d.cancelling = false;

    this.#render(item);
    const toast = cfg.toast(d);
    if (toast) {
      const type = status === "failed" ? "error" : status === "done" ? "success" : "info";
      dialog.showToast(toast, type);
    }
    // 本地发起行才执行该族的后置处理（刷新网格/分组、NO_SIGNATURE 引导、trash 注册等）
    if (!d.external && typeof item.onDone === "function") item.onDone(msg, item);
    this.#maybeClosePort();
  }

  // 启动失败（QUEUE_FULL / BUSY / NO_DOUYIN_TAB / 异常）：直接把行置为 failed，不再弹模态
  fail(taskId, error) {
    const item = this.#items.get(String(taskId));
    if (!item) return;
    item.data.status = "failed";
    item.data.error = error || "未知错误";
    item.data.finishedAt = Date.now();
    this.#render(item);
    this.#maybeClosePort();
  }

  // 远端任务登记统一入口：begin → bindPort → bgMsg → 失败收口（六处发起点共用骨架：
  // sync×2 / domain-scan / author-import×2 / batch 取消）。payload 可为对象或 async 函数
  //（domain-scan-sync 的条件 await secUid 在载荷构造内完成）；closeFirst=true 绑定端口后
  // 先关确认弹窗再发送（batch 取消入口的时序约定）。返回 { taskId, bindFailed, error?, response? }
  // 供需要返回值的调用点映射各自约定（syncAwemeIds 的 {error}/{taskId}、startWorksImportFor 的 null）
  async launchRemote({ taskId = crypto.randomUUID(), begin, payload, queueFullText = "已有任务在运行", closeFirst = false }) {
    this.begin({ taskId, ...begin });
    // 控制端口绑不上就不启动：无端口的任务无法在关页时取消，会变成静默幽灵任务
    if (!this.bindPort(taskId)) return { taskId, bindFailed: true };
    if (closeFirst) dialog.closeDialog();
    try {
      const body = typeof payload === "function" ? await payload() : payload;
      const res = await services.bgMsg({ taskId, ...body });
      if (!res || res.error) {
        const err = res && res.error === "QUEUE_FULL" ? queueFullText : (res && res.error) || "UNKNOWN";
        this.fail(taskId, err);
        return { taskId, error: err };
      }
      return { taskId, response: res };
    } catch (err) {
      const msg = err.message || String(err);
      this.fail(taskId, msg);
      return { taskId, error: msg };
    }
  }

  // 取消（无二次确认）：running/paused/queued 均可取消，后台确认后由 TASK_DONE 收尾
  async cancel(taskId) {
    const item = this.#items.get(String(taskId));
    if (!item || item.data.external || DONE_STATUSES.has(item.data.status)) return;
    item.data.cancelling = true;
    this.#render(item);
    const res = await services.bgMsg({ type: "CANCEL_TASK", taskId }).catch(() => null);
    if (!res || res.ok !== true) {
      item.data.cancelling = false;
      this.#render(item);
      dialog.showToast("取消请求未生效（任务可能已结束）", "error");
    }
  }

  // —— 队列动作：暂停 / 继续（仅本地行；反馈由 TASK_QUEUE_CHANGED 广播驱动） ——
  // running=协作暂停；queued=直接挂起（不再自动启动，恢复后保留原队位）。
  // 发送失败（SW 回收等）不会有任何广播，补一条提示避免按钮停在原态无解释（对齐 cancel）
  pause(taskId) {
    const item = this.#items.get(String(taskId));
    if (!item || item.data.external) return;
    if (item.data.status !== "running" && item.data.status !== "queued") return;
    services.bgMsg({ type: "PAUSE_TASK", taskId }).catch(() => {
      dialog.showToast("暂停请求未生效（后台暂不可达）", "error");
    });
  }

  resume(taskId) {
    const item = this.#items.get(String(taskId));
    if (!item || item.data.external || item.data.status !== "paused") return;
    services.bgMsg({ type: "RESUME_TASK", taskId }).catch(() => {
      dialog.showToast("继续请求未生效（后台暂不可达）", "error");
    });
  }

  // 行内动作分发：本地任务（begin 时注册了 onPause/onResume/onCancel）由宿主自理，
  // 后台队列任务仍走 PAUSE_TASK / RESUME_TASK / CANCEL_TASK
  #actionPause(item) {
    if (typeof item.onPause === "function") {
      item.data.pausing = true;
      this.#render(item);
      item.onPause(item.data.taskId);
      return;
    }
    this.pause(item.data.taskId);
  }

  #actionResume(item) {
    if (typeof item.onResume === "function") {
      item.data.status = "running";
      item.data.pausing = false;
      this.#render(item);
      item.onResume(item.data.taskId);
      return;
    }
    this.resume(item.data.taskId);
  }

  #actionCancel(item) {
    if (typeof item.onCancel === "function") {
      item.data.cancelling = true;
      this.#render(item);
      item.onCancel(item.data.taskId);
      return;
    }
    this.cancel(item.data.taskId);
  }

  // 本地任务状态同步：宿主循环在真正到达挂起点（在途工作收尾后）调用，
  // 行由 PAUSING 翻为 PAUSED；恢复由 #actionResume 直接翻回 RUNNING
  setLocalStatus(taskId, status) {
    const item = this.#items.get(String(taskId));
    if (!item || DONE_STATUSES.has(item.data.status)) return;
    if (item.data.status === status) return;
    item.data.status = status;
    item.data.pausing = false;
    this.#render(item);
  }

  close(taskId) {
    const item = this.#items.get(String(taskId));
    if (!item) return;
    item.els.root.remove();
    this.#items.delete(String(taskId));
    if (this.#items.size === 0) {
      this.#closePort();
      this.#setVisible(false);
      this.#syncRunningFlag(false);
    } else {
      this.#renderHead();
    }
  }

  toggle() {
    this.#collapsed = !this.#collapsed;
    dom.taskDock.classList.toggle("collapsed", this.#collapsed);
    dom.taskDockToggle.setAttribute("aria-expanded", String(!this.#collapsed));
    dom.taskDockToggle.setAttribute("aria-label", this.#collapsed ? "展开任务面板" : "收起任务面板");
  }

  // 导航轨「同步」在任务运行中改作「展开任务坞」入口
  expand() {
    if (dom.taskDock.classList.contains("hidden")) return;
    if (this.#collapsed) this.toggle();
  }

  // 坞显隐同步 body 标记：批量条据此让出右下角坞所占空间（坞本身位置不变）
  #setVisible(visible) {
    dom.taskDock.classList.toggle("hidden", !visible);
    document.body.classList.toggle("task-dock-open", visible);
  }

  #show() {
    this.#setVisible(true);
  }

  #syncRunningFlag(busy) {
    if (busy === this.#running) return;
    this.#running = busy;
    for (const fn of this.#runningListeners) fn(busy);
  }

  #closePort() {
    const port = this.#port;
    this.#port = null;
    this.#portTaskIds.clear();
    try {
      port?.disconnect();
    } catch {
      /* 已断开 */
    }
  }

  // 所有本页绑定端口的任务都已终态（或行已关闭）才断开控制端口
  #maybeClosePort() {
    if (!this.#port) return;
    for (const tid of this.#portTaskIds) {
      const item = this.#items.get(tid);
      if (item && !DONE_STATUSES.has(item.data.status)) return;
    }
    this.#closePort();
  }

  #render(item) {
    const data = item.data;
    const cfg = configOf(data.kind);
    item.els.count.textContent = cfg.count(data);
    // 队列态摘要：显示排队/暂停信息与任务目标（避免「忘记导入的是谁」）
    const queueNote = data.status === "queued"
      ? `排队等待${data.hint ? ` · ${data.hint}` : "…"}`
      : data.status === "paused"
        ? `已暂停${data.hint ? ` · ${data.hint}` : ""}`
        : data.pausing
          ? "正在暂停…"
          : null;
    item.els.summary.textContent = queueNote ?? cfg.summary(data);
    item.els.status.textContent = data.cancelling
      ? "CANCELLING"
      : data.pausing
        ? "PAUSING"
        : data.status === "failed"
          ? data.error || "ERROR"
          : data.status === "running" && data.rateLimited
            ? "RATE_LIMITED"
            : STATE_TEXT[data.status] || data.status;
    this.#renderActions(item);
    this.#renderHead();
  }

  #renderActions(item) {
    const data = item.data;
    const failed = data.trashIds.length;
    const sig = [data.status, data.pausing, data.cancelling, data.external, failed, data.trashing, data.trashed].join("|");
    if (sig === item.actionSig) return;
    item.actionSig = sig;
    item.els.actions.textContent = "";
    // 状态徽标（SYNCING/QUEUED/DONE…）固定驻留动作行首位（与关闭/暂停/取消同行）：
    // 模板内置节点，动作区清空后回挂，文本仍由 #render 独立写
    item.els.actions.appendChild(item.els.status);

    // 非终态：按状态给出队列动作；外部只读行仅显示来源提示
    if (data.status === "running") {
      if (!data.external) {
        const pauseBtn = makeButton(data.pausing || data.cancelling ? "正在暂停…" : "暂停", "dy-btn-ghost",
          () => this.#actionPause(item));
        pauseBtn.disabled = data.pausing || data.cancelling;
        item.els.actions.appendChild(pauseBtn);
        const cancelBtn = makeButton("取消", "dy-btn-ghost dy-btn-danger", () => this.#actionCancel(item));
        cancelBtn.disabled = data.cancelling;
        item.els.actions.appendChild(cancelBtn);
      } else {
        this.#renderExternalActions(item);
      }
      return;
    }
    if (data.status === "paused" || data.status === "queued") {
      if (!data.external) {
        const nextBtn = data.status === "paused"
          ? makeButton("继续", "dy-btn-ghost", () => this.#actionResume(item))
          : makeButton("暂停", "dy-btn-ghost", () => this.#actionPause(item));
        item.els.actions.appendChild(nextBtn);
        const cancelBtn = makeButton("取消", "dy-btn-ghost dy-btn-danger", () => this.#actionCancel(item));
        item.els.actions.appendChild(cancelBtn);
      } else {
        this.#renderExternalActions(item);
      }
      return;
    }

    // 与旧同步弹窗一致：失败/丢失条目直接给「移入稍后删除」，不提供额外的列表弹窗
    if (failed > 0 && !data.trashed && typeof item.onTrash === "function") {
      const moveBtn = makeButton("移入稍后删除", "dy-btn-ghost dy-btn-danger", () => this.#trashFailed(item));
      moveBtn.disabled = data.trashing;
      item.els.actions.appendChild(moveBtn);
    }
    item.els.actions.appendChild(makeButton("关闭", "dy-btn-ghost", () => this.close(data.taskId)));
  }

  // 外部只读行动作：来源提示 + 禁用取消（任务归发起页控制端口管，本页只能观察）
  #renderExternalActions(item) {
    const data = item.data;
    const note = document.createElement("span");
    note.className = "task-dock-external";
    note.textContent = "由另一个页面发起";
    item.els.actions.appendChild(note);
    const cancelBtn = makeButton("取消", "dy-btn-ghost dy-btn-danger", () => this.cancel(data.taskId));
    cancelBtn.disabled = true;
    item.els.actions.appendChild(cancelBtn);
  }

  async #trashFailed(item) {
    const ids = item.data.trashIds || [];
    if (ids.length === 0 || item.data.trashing || item.data.trashed) return;
    if (typeof item.onTrash !== "function") return;
    item.data.trashing = true;
    this.#renderActions(item);
    let group = null;
    try {
      group = await item.onTrash(ids);
    } catch {
      group = null;
    }
    item.data.trashing = false;
    item.data.trashed = Boolean(group);
    this.#renderActions(item);
    if (group) dialog.showToast(`已移入「稍后删除」${n(ids.length)} 条`, "success");
    else dialog.showToast("移入「稍后删除」失败", "error");
  }

  #renderHead() {
    const items = [...this.#items.values()];
    if (items.length === 0) {
      this.#setVisible(false);
      this.#syncRunningFlag(false);
      return;
    }
    // 非终态（queued/running/paused）即「有活跃任务」：驱动设置锁等外围守卫
    const pending = items.filter((item) => !DONE_STATUSES.has(item.data.status));
    this.#syncRunningFlag(pending.length > 0);
    const running = items.filter((item) => item.data.status === "running");
    // 行序即 background 快照数组序（applyQueue 按 tasks 顺序重挂 DOM），坞头只报数量
    const activeLabel = (items.find((item) => item.data.status === "running") || items[0]).data.label;
    dom.taskDockTitle.textContent = items.length === 1 ? items[0].data.label : `${items.length} 个任务 · ${activeLabel}`;
    const last = items[items.length - 1].data;
    dom.taskDock.dataset.status = running.length > 0 ? "running" : last.status;
  }
}

export const taskDock = new TaskDock();
