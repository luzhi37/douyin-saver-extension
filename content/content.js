// ===== 抖音数据管理 - Content Script (isolated world) =====

(function () {
  "use strict";

  const INJECT_URL = chrome.runtime.getURL("content/inject.js");

  function injectMainWorldScript() {
    const script = document.createElement("script");
    script.src = INJECT_URL;
    script.onload = () => script.remove();
    (document.documentElement || document).appendChild(script);
  }

  injectMainWorldScript();

  // ===== 作品捕获缓存 =====

  const capturedWorksMap = new Map();

  function capturedWorksLRUGet(key) {
    if (!capturedWorksMap.has(key)) return undefined;
    const val = capturedWorksMap.get(key);
    capturedWorksMap.delete(key);
    capturedWorksMap.set(key, val);
    return val;
  }

  document.addEventListener("DY_CAPTURE_WORKS", (event) => {
    const works = event.detail;
    if (!Array.isArray(works) || works.length === 0) return;
    for (const w of works) {
      if (w && w.awemeId) capturedWorksMap.set(w.awemeId, w);
    }
    if (capturedWorksMap.size > 200) {
      let toDelete = capturedWorksMap.size - 150;
      const iter = capturedWorksMap.keys();
      while (toDelete-- > 0) capturedWorksMap.delete(iter.next().value);
    }
  });

  document.addEventListener("DY_CAPTURE_BROWSER_FEATURES", (event) => {
    const features = event.detail;
    if (!features) return;
    chrome.runtime.sendMessage({ type: "CAPTURE_BROWSER_FEATURES", features }).catch(() => {});
  });

  // ===== 请求-响应 (tools 移植) =====

  function requestResponse(requestEvent, resultEvent, timeoutMs, buildDetail) {
    return function (message, _sender, sendResponse) {
      if (!message.requestId) {
        sendResponse({ ok: false, error: "INVALID_REQUEST" });
        return false;
      }
      const detail = { requestId: message.requestId };
      if (buildDetail) Object.assign(detail, buildDetail(message));
      const timer = setTimeout(function () {
        document.removeEventListener(resultEvent, onResult);
        sendResponse({ ok: false, error: "TIMEOUT" });
      }, timeoutMs);
      function onResult(event) {
        const d = event.detail || {};
        if (d.requestId !== message.requestId) return;
        clearTimeout(timer);
        document.removeEventListener(resultEvent, onResult);
        sendResponse(Object.assign({ ok: !d.error }, d));
      }
      document.addEventListener(resultEvent, onResult);
      document.dispatchEvent(new CustomEvent(requestEvent, { detail }));
      return true;
    };
  }

  // ===== 消息路由 =====

  const BRIDGE = {
    FETCH_SINGLE_WORK: {
      req: "DY_FETCH_SINGLE_WORK_REQUEST",
      res: "DY_FETCH_SINGLE_WORK_RESULT",
      timeout: (msg) => msg.timeout,
      detail: (msg) => ({ awemeId: msg.awemeId }),
    },
    FETCH_FOLLOWING_PAGE: {
      req: "DY_FETCH_FOLLOWING_PAGE_REQUEST",
      res: "DY_FETCH_FOLLOWING_PAGE_RESULT",
      timeout: (msg) => msg.timeout,
      detail: (msg) => ({ secUid: msg.secUid, offset: msg.offset || 0, count: msg.count }),
    },
    FETCH_USER_PROFILE: {
      req: "DY_FETCH_PROFILE_OTHER_REQUEST",
      res: "DY_FETCH_PROFILE_OTHER_RESULT",
      timeout: (msg) => msg.timeout,
      detail: (msg) => ({ secUid: msg.secUid }),
    },
    FETCH_WORKS_PAGE: {
      req: "DY_FETCH_WORKS_REQUEST",
      res: "DY_FETCH_WORKS_RESULT",
      timeout: () => 60000,
      detail: (msg) => ({ secUid: msg.secUid, maxCursor: msg.cursor || 0, count: msg.count }),
    },
    FETCH_FAVORITES_PAGE: {
      req: "DY_FETCH_FAVORITES_PAGE_REQUEST",
      res: "DY_FETCH_FAVORITES_PAGE_RESULT",
      timeout: (msg) => msg.timeout,
      detail: (msg) => ({ secUid: msg.secUid, cursor: msg.cursor || 0, count: msg.count }),
    },
    CANCEL_ONE_LIKE: {
      req: "DY_CANCEL_ONE_LIKE_REQUEST",
      res: "DY_CANCEL_ONE_LIKE_RESULT",
      timeout: () => 30000,
      detail: (msg) => ({ awemeId: msg.awemeId }),
    },
    FETCH_COLLECTION_PAGE: {
      req: "DY_FETCH_COLLECTION_PAGE_REQUEST",
      res: "DY_FETCH_COLLECTION_PAGE_RESULT",
      timeout: (msg) => msg.timeout,
      detail: (msg) => ({ cursor: msg.cursor || 0, count: msg.count }),
    },
    CANCEL_ONE_COLLECTION: {
      req: "DY_CANCEL_ONE_COLLECTION_REQUEST",
      res: "DY_CANCEL_ONE_COLLECTION_RESULT",
      timeout: () => 30000,
      detail: (msg) => ({ awemeId: msg.awemeId }),
    },
    GET_SECURITY_STATUS: {
      req: "DY_GET_SECURITY_STATUS_REQUEST",
      res: "DY_GET_SECURITY_STATUS_RESULT",
      timeout: () => 5000,
      detail: () => ({}),
    },
    REQUEST_CAPTURE_BROWSER_FEATURES: {
      req: "DY_REQUEST_BROWSER_FEATURES",
      res: "DY_CAPTURE_BROWSER_FEATURES_REFRESH",
      timeout: (msg) => msg.timeout || 10000,
      detail: () => ({}),
    },
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const entry = BRIDGE[message.type];
    if (entry) {
      return requestResponse(
        entry.req,
        entry.res,
        entry.timeout(message),
        entry.detail,
      )(message, _sender, sendResponse);
    }

    if (message.type === "CANCEL_ACTIVE_TASK") {
      document.dispatchEvent(new CustomEvent("DY_CANCEL_ACTIVE_TASK"));
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  // ===== 作品详情 + 保存 (saver 现有) =====

  function fetchDetailByAwemeId(awemeId, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const requestId = "save_fb_" + Date.now() + "_" + Math.random().toString(36).slice(2);
      function onResult(event) {
        if (event.detail?.requestId !== requestId) return;
        document.removeEventListener("DY_FETCH_DETAIL_RESULT", onResult);
        clearTimeout(timer);
        resolve(event.detail.work?.video || "");
      }
      document.addEventListener("DY_FETCH_DETAIL_RESULT", onResult);
      const timer = setTimeout(() => {
        document.removeEventListener("DY_FETCH_DETAIL_RESULT", onResult);
        resolve("");
      }, timeoutMs);
      document.dispatchEvent(
        new CustomEvent("DY_FETCH_DETAIL_REQUEST", {
          detail: { awemeId, requestId },
        }),
      );
    });
  }

  async function saveWork(fullWork) {
    const apiData = capturedWorksLRUGet(fullWork.awemeId);
    let video = (fullWork?.video || apiData?.video || "").trim();

    if (!video && fullWork.type === "video") {
      showToast("⏳ 正在获取视频链接…");
      video = await fetchDetailByAwemeId(fullWork.awemeId);
    }

    const baseWork = fullWork || apiData;
    const work = { ...baseWork, video };

    chrome.runtime.sendMessage({ type: "SAVE_WORKS", works: [work] }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response?.ok) {
        capturedWorksMap.delete(fullWork.awemeId);
        showToast("✅ 已保存: " + (fullWork.desc || fullWork.awemeId).slice(0, 20));
      } else {
        showToast("❌ 保存失败");
      }
    });
  }

  document.addEventListener("DY_BUTTON_CLICK", (event) => {
    const { fullWork } = event.detail || {};
    if (!fullWork || !fullWork.awemeId) {
      showToast("❌ 无法获取作品信息");
      return;
    }
    saveWork(fullWork).catch((err) => console.warn("[DY] save failed:", err));
  });

  let toastTimer = null;

  function showToast(message) {
    let toast = document.getElementById("dy-saver-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "dy-saver-toast";
      Object.assign(toast.style, {
        position: "fixed",
        top: "60px",
        left: "50%",
        transform: "translateX(-50%) translateY(-20px)",
        background: "rgba(0,0,0,0.85)",
        color: "#fff",
        padding: "10px 24px",
        borderRadius: "8px",
        fontSize: "14px",
        fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
        zIndex: "999999",
        pointerEvents: "none",
        opacity: "0",
        transition: "opacity 0.3s, transform 0.3s",
        whiteSpace: "nowrap",
      });
      document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.style.opacity = "1";
    toast.style.transform = "translateX(-50%) translateY(0)";

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateX(-50%) translateY(-20px)";
    }, 2000);
  }
})();
