// background/identity/tab-bridge.js — 抖音标签页查找/转发（find/send/sendAsync + 3 个吸收分支）

import { CONFIG } from "../core.js";

// ---------- TabBridge ----------
// 抖音标签页查找与转发；吸收 route 内 CANCEL_ACTIVE_TASK / GET_SECURITY_STATUS / FETCH_WORKS_PAGE 非独立分支。
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

  sendAsync(type, data) {
    return new Promise((resolve) => {
      this.send(type, data, (resp) => resolve(resp || { ok: false, error: "EMPTY_RESPONSE" }));
    });
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
        count: CONFIG.PAGE.AUTHOR,
        timeout: CONFIG.TIMEOUT.REQUEST,
      },
      sendResponse,
    );
  }
}
const tabBridge = new TabBridge();

export { tabBridge };
