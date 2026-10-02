// ===== 抖音数据管理 - Content Script (isolated world) =====

(function () {
  "use strict";

  // ---------- config ----------
  const INJECT_URL = chrome.runtime.getURL("content/inject.js");

  const BRIDGE = {
    FETCH_WORK_DETAIL: {
      req: "DY_FETCH_WORK_DETAIL_REQUEST",
      res: "DY_FETCH_WORK_DETAIL_RESULT",
      timeout: (msg) => msg.timeout,
      detail: (msg) => ({ awemeId: msg.awemeId }),
    },
    FETCH_FOLLOWING_PAGE: {
      req: "DY_FETCH_FOLLOWING_PAGE_REQUEST",
      res: "DY_FETCH_FOLLOWING_PAGE_RESULT",
      timeout: (msg) => msg.timeout,
      detail: (msg) => ({ secUid: msg.secUid, offset: msg.offset || 0, count: msg.count }),
    },
    FETCH_PROFILE_OTHER: {
      req: "DY_FETCH_PROFILE_OTHER_REQUEST",
      res: "DY_FETCH_PROFILE_OTHER_RESULT",
      timeout: (msg) => msg.timeout,
      detail: (msg) => ({ secUid: msg.secUid }),
    },
    FETCH_WORKS_PAGE: {
      req: "DY_FETCH_WORKS_PAGE_REQUEST",
      res: "DY_FETCH_WORKS_PAGE_RESULT",
      timeout: () => 60000,
      detail: (msg) => ({ secUid: msg.secUid, maxCursor: msg.cursor || 0, count: msg.count }),
    },
    FETCH_FAVORITES_PAGE: {
      req: "DY_FETCH_FAVORITES_PAGE_REQUEST",
      res: "DY_FETCH_FAVORITES_PAGE_RESULT",
      timeout: (msg) => msg.timeout,
      detail: (msg) => ({ secUid: msg.secUid, cursor: msg.cursor || 0, count: msg.count }),
    },
    CANCEL_ONE_FAVORITES: {
      req: "DY_CANCEL_ONE_FAVORITES_REQUEST",
      res: "DY_CANCEL_ONE_FAVORITES_RESULT",
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

  // ---------- Toast ----------
  // 轻量提示：复用单元素，info/success 2s、error 4.5s 后淡出。
  // 尺寸规格与 options.css .toast 保持一致，改动需两侧同步。
  const TOAST_TYPES = {
    info: "#60a5fa",
    success: "#4ade80",
    error: "#f5222d",
  };

  class Toast {
    #timer = null;
    #el = null;

    show(message, type = "info") {
      const el = this.#ensureEl();
      el.textContent = message;
      el.style.borderLeftColor = TOAST_TYPES[type] || TOAST_TYPES.info;
      el.style.opacity = "1";
      el.style.transform = "translateX(-50%) translateY(0)";

      if (this.#timer) clearTimeout(this.#timer);
      this.#timer = setTimeout(() => {
        el.style.opacity = "0";
        el.style.transform = "translateX(-50%) translateY(-20px)";
      }, type === "error" ? 4500 : 2000);
    }

    #ensureEl() {
      let el = this.#el && document.body.contains(this.#el) ? this.#el : document.getElementById("dy-saver-toast");
      if (!el) {
        el = document.createElement("div");
        el.id = "dy-saver-toast";
        Object.assign(el.style, {
          position: "fixed",
          top: "20px",
          left: "50%",
          transform: "translateX(-50%) translateY(-20px)",
          background: "rgba(0,0,0,0.85)",
          color: "#fff",
          padding: "7px 16px",
          borderRadius: "6px",
          fontSize: "13px",
          fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
          borderLeft: "3px solid transparent",
          maxWidth: "80vw",
          zIndex: "999999",
          pointerEvents: "none",
          opacity: "0",
          transition: "opacity 0.3s, transform 0.3s",
          whiteSpace: "normal",
          textAlign: "center",
        });
        document.body.appendChild(el);
      }
      this.#el = el;
      return el;
    }
  }
  const toast = new Toast();

  // ---------- CaptureCache ----------
  // 作品捕获缓存：inject 捕获的作品暂存于此，保存时按 LRU 命中补全信息。
  class CaptureCache {
    #map = new Map();
    #MAX = 200;
    #TRIM_TO = 150;

    constructor() {
      document.addEventListener("DY_CAPTURE_WORKS", (e) => this.#onCaptureWorks(e));
      document.addEventListener("DY_CAPTURE_BROWSER_FEATURES", (e) => this.#onCaptureFeatures(e));
    }

    get(key) {
      if (!this.#map.has(key)) return undefined;
      const val = this.#map.get(key);
      this.#map.delete(key);
      this.#map.set(key, val);
      return val;
    }

    delete(key) {
      this.#map.delete(key);
    }

    #onCaptureWorks(e) {
      const works = e.detail;
      if (!Array.isArray(works) || works.length === 0) return;
      for (const w of works) {
        if (w && w.awemeId) this.#map.set(w.awemeId, w);
      }
      if (this.#map.size > this.#MAX) {
        let toDelete = this.#map.size - this.#TRIM_TO;
        const iter = this.#map.keys();
        while (toDelete-- > 0) this.#map.delete(iter.next().value);
      }
    }

    #onCaptureFeatures(e) {
      const features = e.detail;
      if (!features) return;
      chrome.runtime.sendMessage({ type: "CAPTURE_BROWSER_FEATURES", features }).catch(() => {});
    }
  }
  const captureCache = new CaptureCache();

  // ---------- ContentBridge ----------
  // 请求-响应桥（tools 移植）：background 消息 → inject 事件，结果回传。
  class ContentBridge {
    #requestResponse(requestEvent, resultEvent, timeoutMs, buildDetail) {
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

    constructor() {
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        return this.#onMessage(message, sender, sendResponse);
      });
    }

    #onMessage(message, sender, sendResponse) {
      const entry = BRIDGE[message.type];
      if (entry) {
        return this.#requestResponse(
          entry.req,
          entry.res,
          entry.timeout(message),
          entry.detail,
        )(message, sender, sendResponse);
      }

      if (message.type === "CANCEL_ACTIVE_TASK") {
        document.dispatchEvent(new CustomEvent("DY_CANCEL_ACTIVE_TASK"));
        sendResponse({ ok: true });
        return false;
      }

      return false;
    }
  }
  const contentBridge = new ContentBridge();

  // ---------- WorkSaver ----------
  // 作品详情 + 保存 (saver 现有)：保存按钮点击后补全视频链接并落库。
  class WorkSaver {
    #fetchDetailByAwemeId(awemeId, timeoutMs = 5000) {
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

    async saveWork(fullWork) {
      const apiData = captureCache.get(fullWork.awemeId);
      let video = (fullWork?.video || apiData?.video || "").trim();

      if (!video && fullWork.type === "video") {
        toast.show("正在获取视频链接…");
        video = await this.#fetchDetailByAwemeId(fullWork.awemeId);
      }

      const work = { ...fullWork, video };

      chrome.runtime.sendMessage({ type: "SAVE_WORKS", works: [work] }, (response) => {
        if (chrome.runtime.lastError) return;
        if (response?.ok) {
          captureCache.delete(fullWork.awemeId);
          toast.show("已保存: " + (fullWork.desc || fullWork.awemeId).slice(0, 20), "success");
        } else {
          toast.show("保存失败", "error");
        }
      });
    }

    constructor() {
      document.addEventListener("DY_BUTTON_CLICK", (e) => this.#onButtonClick(e));
    }

    #onButtonClick(e) {
      const { fullWork } = e.detail || {};
      if (!fullWork || !fullWork.awemeId) {
        toast.show("无法获取作品信息", "error");
        return;
      }
      this.saveWork(fullWork).catch((err) => console.warn("[DY] save failed:", err));
    }
  }
  const workSaver = new WorkSaver();

  // ---------- 启动 ----------
  function injectMainWorldScript() {
    const script = document.createElement("script");
    script.src = INJECT_URL;
    script.onload = () => script.remove();
    (document.documentElement || document).appendChild(script);
  }

  injectMainWorldScript();
})();
