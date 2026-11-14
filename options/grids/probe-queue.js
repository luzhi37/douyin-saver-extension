// ---------- ProbeQueue ----------
// 媒体探针分帧队列（works-grid 封面 / author-grid 头像 / sidebar 封面三处共用）：
// rAF 按预算逐帧出队、new Image() 离屏探针、alive 校验、成功/失败回调。
// 代际自增（dataset coverGen/fillGen/gen）与失败语义（works 重试一次 / author 首字回退 /
// sidebar 占位兜底）三处各异，由调用方经 task 载荷与回调注入，本模块只收口机械部分。
// div+background-image 无裂图载体：探针成功才提交背景图（docs/11 媒体体系定案）。
export function createProbeQueue({ budget, dequeueCheck = null, alive, commit, fail }) {
  const queue = [];
  let rafId = 0;
  const schedule = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      let n = 0;
      while (queue.length && n < budget) {
        const task = queue.shift();
        // 出队预检（author 的降级/重填跳过；works/sidebar 无此环节由 alive 兜底丢弃）
        if (dequeueCheck && !dequeueCheck(task)) continue;
        const probe = new Image();
        probe.onload = () => {
          if (alive(task)) commit(task);
        };
        probe.onerror = () => {
          if (alive(task)) fail(task);
        };
        probe.src = task.url;
        n++;
      }
      if (queue.length) schedule();
    });
  };
  return {
    enqueue(task) {
      queue.push(task);
      schedule();
    },
    clear() {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      queue.length = 0;
    },
  };
}
