// background/identity/tab-bridge.js — 抖音标签页查找/转发（find/send/sendAsync + 3 个吸收分支）

import { CONFIG } from "../core.js";
import { requestGate } from "../tasks/request-gate.js";

// ---------- TabBridge ----------
// 抖音标签页查找与转发；吸收 route 内 GET_SECURITY_STATUS / FETCH_WORKS_PAGE 非独立分支
//（CANCEL_TASK 的页面侧中断转发与 send 超时补发均经 cancelActiveTask / CANCEL_ACTIVE_TASK 消息直达 Tab）。
class TabBridge {
  async find() {
    const tabs = await chrome.tabs.query({ url: CONFIG.DOUYIN_URL_PATTERN });
    const tab = tabs.find((t) => t.url && !t.url.includes(CONFIG.DOUYIN_EXCLUDE_DOMAIN) && t.status === "complete");
    return tab || null;
  }

  send(type, data, sendResponse) {
    const requestId = crypto.randomUUID();
    const timeoutMs = data.timeout || CONFIG.TIMEOUT.REQUEST;
    let called = false;

    this.find()
      .then((tab) => {
        if (!tab) {
          sendResponse({ ok: false, error: "NO_DOUYIN_TAB" });
          return;
        }

        const timer = setTimeout(() => {
          if (called) return;
          called = true;
          sendResponse({ ok: false, error: "TIMEOUT" });
          // 超时后中止 inject.js 中的活跃任务，避免其继续运行产生后续回调
          chrome.tabs.sendMessage(tab.id, { type: "CANCEL_ACTIVE_TASK" }).catch(() => {});
        }, timeoutMs);

        chrome.tabs.sendMessage(tab.id, { type, requestId, ...data }, (resp) => {
          clearTimeout(timer);
          if (called) return;
          called = true;
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: "NO_LISTENER" });
            return;
          }
          sendResponse(resp || { ok: false, error: "EMPTY_RESPONSE" });
        });
      })
      .catch(() => {
        if (!called) sendResponse({ ok: false, error: "TAB_QUERY_FAILED" });
      });
  }

  // 所有 Tab 侧异步请求共用全局请求车道：长任务循环即便各自带延迟，也不会在
  // 「某个任务刚发完、另一个任务立刻发」的间隙叠出双倍速率。
  // 任务循环可传 interval 让闸门承担条间节奏；交互式单条用默认 0（插队等一个在途请求）
  async sendAsync(type, data, { priority = 1, interval = 0, isCancelled = null } = {}) {
    const release = await requestGate.acquire({ priority, interval, isCancelled });
    if (!release) return { ok: false, error: "CANCELLED" };
    try {
      return await new Promise((resolve) => {
        this.send(type, data, (resp) => resolve(resp || { ok: false, error: "EMPTY_RESPONSE" }));
      });
    } finally {
      release();
    }
  }

  getSecurityStatus(sendResponse) {
    this.send("GET_SECURITY_STATUS", { timeout: CONFIG.TIMEOUT.SECURITY_STATUS }, sendResponse);
  }

  cancelActiveTask(sendResponse) {
    this.find()
      .then((tab) => {
        if (!tab) {
          sendResponse({ ok: true });
          return;
        }
        chrome.tabs.sendMessage(tab.id, { type: "CANCEL_ACTIVE_TASK" }).catch(() => {});
        sendResponse({ ok: true });
      })
      .catch(() => sendResponse({ ok: false }));
  }

  fetchWorksPage(message, sendResponse) {
    this.send(
      "FETCH_WORKS_PAGE",
      {
        secUid: message.secUid,
        cursor: message.cursor || "",
        count: CONFIG.PAGE.POST,
        timeout: CONFIG.TIMEOUT.REQUEST,
      },
      sendResponse,
    );
  }
}
const tabBridge = new TabBridge();

export { tabBridge };
