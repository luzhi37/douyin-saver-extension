// background/tasks/task-registry.js — 长任务注册表 + 队列调度（taskId / 状态机 / 单一 active / 控制端口）
// B6 任务队列：全局单任务升级为「单一 active + FIFO 队列」——queued/paused 任务保留在册，
// active 让出（暂停/终态）后自动启动队首；循环经 waitForTurn/checkpoint 两个挂起点接入，
// 挂起 Promise 保留循环闭包现场（i/cursor/all/...），恢复即从原处续跑。不做跨页恢复与续跑。

// ---------- config ----------
const TASK_STATUS = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  PAUSED: "paused",
  DONE: "done",
  CANCELLED: "cancelled",
  FAILED: "failed",
});
const FINISHED_KEEP = 5;
const PORT_NAME = "task-control";
const MAX_QUEUE = 8;               // 排队上限（含 active），超出 QUEUE_FULL
const QUEUE_KEEPALIVE_MS = 20000;  // 挂起期间 SW 保活心跳（须短于 SW 空闲回收阈值）

// ---------- TaskRegistry ----------
// 内存态：队列/挂起现场不做跨页恢复，任务寿命 = 发起页寿命。控制端口断开即取消
// 该端口绑定的全部任务，关页不会留下「看不见但还在跑」的静默任务。
class TaskRegistry {
  #tasks = new Map();      // taskId -> task（全部非终态：queued/running/paused）
  #queue = [];             // taskId 数组，按队列顺序（active 也在其中）
  #activeId = null;        // 当前唯一执行循环体的任务
  #wake = new Map();       // taskId -> resolve（挂起 Promise 的唤醒器）
  #keepalive = new Map();  // taskId -> timer（挂起期间 SW 保活心跳）
  #finished = [];          // 最近终态任务（供 GET_TASK_STATE 回看）
  #ports = new Map();      // taskId -> port
  #pendingPorts = new Map(); // taskId -> port（先 bind 后 start）
  #closed = new Set();     // 页面在任务启动前已关闭的 taskId

  // 控制端口：一个 port 可绑定多个 taskId（options 侧单 port 复用）。
  // 断开 = 页面关闭/刷新/SW 回收 → 该端口绑定的全部非终态任务取消。
  bindPort(port) {
    const bound = new Set();
    port.onMessage.addListener((msg) => {
      if (!msg || msg.type !== "BIND_TASK" || !msg.taskId) return;
      const id = String(msg.taskId);
      bound.add(id);
      const t = this.#tasks.get(id);
      if (t) {
        t.port = port;
        this.#ports.set(id, port);
        return;
      }
      this.#pendingPorts.set(id, port);
    });
    port.onDisconnect.addListener(() => {
      for (const id of bound) {
        this.#pendingPorts.delete(id);
        this.#ports.delete(id);
        if (this.#tasks.has(id)) {
          this.cancel(id, "PAGE_CLOSED");
        } else {
          this.#closed.add(id);
          // 失败启动/预绑定后关闭的 taskId 只用于拒绝迟到的 start；保留最近 50 个即可
          if (this.#closed.size > 50) this.#closed.delete(this.#closed.values().next().value);
        }
      }
    });
  }

  // 登记任务并入队：全局队列上限满 → null（调用方回 QUEUE_FULL）。
  // 同域不限制——同一时刻只有一个 active 执行循环体，同域任务自然串行。
  start({ taskId = null, kind, mode = "independent", domain, total = 0 } = {}) {
    const id = String(taskId || crypto.randomUUID());
    if (this.#closed.has(id)) return null;
    if (this.#tasks.size >= MAX_QUEUE) return null;
    const task = {
      taskId: id,
      kind,
      mode,
      domain,
      status: TASK_STATUS.QUEUED,
      total: Number(total) || 0,
      processed: 0,
      ok: 0,
      failed: 0,
      skipped: 0,
      changed: 0,
      startedAt: Date.now(),
      finishedAt: 0,
      error: "",
      cancelReason: "",
      cancelled: false,
      pauseRequested: false,
      port: null,
    };
    const pendingPort = this.#pendingPorts.get(id);
    if (pendingPort) {
      task.port = pendingPort;
      this.#ports.set(id, pendingPort);
      this.#pendingPorts.delete(id);
    }
    this.#tasks.set(id, task);
    this.#queue.push(id);
    this.#pump();
    this.#broadcast();
    return task;
  }

  get(taskId) {
    return this.#tasks.get(String(taskId)) || null;
  }

  // 取消信号（循环每次迭代查一次）：任务不存在也视为已取消，避免悬空任务继续写。
  // queued/paused 任务留在 #tasks 且 cancelled=false，不会误判（挂起现场保留的前提）。
  isCancelled(taskId) {
    const t = this.get(taskId);
    return !t || t.cancelled;
  }

  // 暂停请求是否已置位（供 pauseWithKeepalive 的组合谓词，让批间长暂停及时让出）
  isPauseRequested(taskId) {
    return this.get(taskId)?.pauseRequested === true;
  }

  isBusy(domain) {
    // 含 queued/paused：该域有未终态任务即拒绝整域导入/重置
    for (const t of this.#tasks.values()) {
      if (t.domain === domain) return true;
    }
    return false;
  }

  // 有任务在执行循环体（页面侧 taskId-less 中断仅在此时转发）
  isAnyRunning() {
    return this.#activeId !== null;
  }

  // 有任何非终态任务（供设置锁 / beforeunload / 门禁）
  hasPending() {
    return this.#tasks.size > 0;
  }

  // —— 外部动作：暂停 ——
  // running：置位后循环在下一个 checkpoint 让出；返回后 UI 可先显示 PAUSING。
  // queued：尚未执行循环体，直接置 PAUSED（pump 跳过，不会自动启动；resume 后保留原队位）。
  pause(taskId) {
    const t = this.get(taskId);
    if (!t) return false;
    if (t.status === TASK_STATUS.QUEUED) {
      t.status = TASK_STATUS.PAUSED;
      this.#broadcast();
      return true;
    }
    if (t.status !== TASK_STATUS.RUNNING) return false;
    t.pauseRequested = true;
    this.#broadcast();
    return true;
  }

  // —— 外部动作：继续 ——
  // paused → queued（保留原队列位置）；若此刻无 active，pump 立即续跑。
  resume(taskId) {
    const t = this.get(taskId);
    if (!t || t.status !== TASK_STATUS.PAUSED) return false;
    t.pauseRequested = false;
    t.status = TASK_STATUS.QUEUED;
    this.#pump();
    this.#broadcast();
    return true;
  }

  // 取消：扩展到 queued/paused/running。唤醒挂起循环使其走原有收尾发 TASK_DONE；
  // active 让出并 pump 下一个。Tab 模式在途请求的页面侧中断由路由层转发。
  cancel(taskId, reason = "CANCELLED") {
    const t = this.get(taskId);
    if (!t || this.#isTerminal(t)) return false;
    t.cancelled = true;
    t.cancelReason = reason;
    if (this.#activeId === taskId) {
      this.#activeId = null;
      this.#pump();
    }
    this.#notify(taskId);
    this.#broadcast();
    return true;
  }

  update(taskId, patch) {
    const t = this.get(taskId);
    if (!t || t.status !== TASK_STATUS.RUNNING) return;
    Object.assign(t, patch);
  }

  finish(taskId, { status = TASK_STATUS.DONE, error = "" } = {}) {
    const t = this.get(taskId);
    if (!t || this.#isTerminal(t)) return;
    t.status = status;
    t.error = error || t.error;
    t.finishedAt = Date.now();
    t.cancelled = false;
    t.port = null;
    this.#queue = this.#queue.filter((x) => x !== taskId);
    if (this.#activeId === taskId) {
      this.#activeId = null;
    }
    this.#tasks.delete(taskId);
    this.#ports.delete(taskId);
    this.#wake.delete(taskId);
    this.#clearKeepalive(taskId);
    this.#finished.unshift(t);
    if (this.#finished.length > FINISHED_KEEP) this.#finished.length = FINISHED_KEEP;
    this.#pump();          // ★ 终态后自动启动队列下一个
    this.#broadcast();
  }

  // 供 GET_TASK_STATE / TASK_QUEUE_CHANGED：非终态按队列序（active 标记），随后最近终态
  snapshot() {
    const pending = this.#queue
      .map((id) => this.#tasks.get(id))
      .filter(Boolean)
      .map((t) => ({ ...t, port: undefined, active: this.#activeId === t.taskId }));
    const finished = this.#finished.map((t) => ({ ...t, port: undefined, active: false }));
    return [...pending, ...finished];
  }

  #isTerminal(t) {
    return t.status === TASK_STATUS.DONE || t.status === TASK_STATUS.CANCELLED || t.status === TASK_STATUS.FAILED;
  }

  // —— 队列调度：无 active 时启动队首 QUEUED 任务 ——
  // PAUSED 不在此列：用户暂停的任务只能被 RESUME_TASK 显式唤醒，否则暂停会立刻失效
  #pump() {
    if (this.#activeId) return;
    const id = this.#queue.find((x) => this.#tasks.get(x)?.status === TASK_STATUS.QUEUED);
    if (!id) return;
    const t = this.#tasks.get(id);
    t.status = TASK_STATUS.RUNNING;
    this.#activeId = id;
    this.#notify(id);      // 唤醒 waitForTurn / paused 的挂起 Promise
  }

  // —— 循环接入点 1：循环开始前等轮次（queued 时挂起） ——
  async waitForTurn(taskId) {
    const pred = () => {
      const t = this.get(taskId);
      return !t || t.cancelled || (this.#activeId === taskId && t.status === TASK_STATUS.RUNNING);
    };
    await this.#waitUntil(taskId, pred);
  }

  // —— 循环接入点 2：每次迭代边界 ——
  // 暂停请求置位时：先执行 onSuspend（落库 flush），再置 paused、释放 active 与域槽、
  // pump 下一个（★ 插队），随后挂起等待 resume/cancel/重新轮到。
  // 被取消时直接返回（循环用 isCancelled 退出）。否则立即返回继续执行。
  async checkpoint(taskId, { onSuspend = null } = {}) {
    const t0 = this.get(taskId);
    if (!t0 || t0.cancelled) return;
    if (!(t0.pauseRequested && this.#activeId === taskId && t0.status === TASK_STATUS.RUNNING)) return;
    if (onSuspend) await onSuspend();
    const t = this.get(taskId);
    if (!t || t.cancelled || !t.pauseRequested) return; // 挂起期间被取消/恢复
    t.status = TASK_STATUS.PAUSED;
    this.#activeId = null;
    this.#pump();          // ★ 队列下一个自动插队
    this.#broadcast();
    await this.#waitUntil(taskId, () => {
      const c = this.get(taskId);
      return !c || c.cancelled || (this.#activeId === taskId && c.status === TASK_STATUS.RUNNING);
    });
  }

  // —— 挂起 + SW 保活 + 唤醒 ——
  #waitUntil(taskId, pred) {
    if (pred()) return Promise.resolve();
    return new Promise((resolve) => {
      this.#wake.set(taskId, resolve);
      const tick = () => {
        if (pred() || !this.#wake.has(taskId)) {
          this.#keepalive.delete(taskId);
          return;
        }
        chrome.storage.local.get("keepalive").then(() => {
          if (!this.#wake.has(taskId)) return;
          this.#keepalive.set(taskId, setTimeout(tick, QUEUE_KEEPALIVE_MS));
        });
      };
      this.#keepalive.set(taskId, setTimeout(tick, QUEUE_KEEPALIVE_MS));
    });
  }

  #notify(taskId) {
    const wake = this.#wake.get(taskId);
    if (!wake) return;
    this.#wake.delete(taskId);
    this.#clearKeepalive(taskId);
    wake();
  }

  #clearKeepalive(taskId) {
    const timer = this.#keepalive.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.#keepalive.delete(taskId);
    }
  }

  // 队列/状态变化广播（进度 update 不广播，避免风暴）
  #broadcast() {
    chrome.runtime
      .sendMessage({ type: "TASK_QUEUE_CHANGED", tasks: this.snapshot() })
      .catch(() => {});
  }
}
const taskRegistry = new TaskRegistry();

export { taskRegistry, PORT_NAME };
