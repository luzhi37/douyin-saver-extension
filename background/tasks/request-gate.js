// background/tasks/request-gate.js — 全局请求闸门（任务生命周期并行，请求仍单车道）

// ---------- config ----------
// 同时只有一个请求占用车道；下一个请求的开始时刻 ≥ 上一个开始时刻 + 该请求携带的间隔。
// 间隔按「每条请求」取，任务各自的 syncWorks 延迟由此进入；交互式单条传 0，但同样排队。
const DEFAULT_PRIORITY = 2; // 1=后台任务，2=交互式单条

// ---------- RequestGate ----------
class RequestGate {
  #queue = [];
  #active = null;
  #timer = null;
  #lastStart = 0;
  #seq = 0;

  // 入队等待一个请求槽位。返回 release 函数，网络往返结束后必须调用（建议 finally）。
  // isCancelled 命中时直接跳过该票据（resolve 一个 no-op release），不占车道。
  acquire({ priority = DEFAULT_PRIORITY, interval = 0, isCancelled = null } = {}) {
    return new Promise((resolve) => {
      this.#queue.push({
        priority,
        interval: Math.max(0, Number(interval) || 0),
        isCancelled,
        resolve,
        seq: ++this.#seq,
      });
      // 高优先级插队；同优先级保持先来先服务
      this.#queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      this.#pump();
    });
  }

  #pump() {
    if (this.#active || this.#queue.length === 0 || this.#timer) return;
    const next = this.#queue[0];
    const wait = Math.max(0, this.#lastStart + next.interval - Date.now());
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const ticket = this.#queue[0];
      if (!ticket) return;
      // 取消的票据不占车道：resolve(null) 让调用方直接放弃本次请求并推进队列
      if (ticket.isCancelled && ticket.isCancelled()) {
        this.#queue.shift();
        ticket.resolve(null);
        this.#pump();
        return;
      }
      this.#queue.shift();
      this.#active = ticket;
      this.#lastStart = Date.now();
      ticket.resolve(() => this.#release(ticket));
    }, wait);
  }

  #release(ticket) {
    if (this.#active !== ticket) return;
    this.#active = null;
    this.#pump();
  }
}
const requestGate = new RequestGate();

export { requestGate };
