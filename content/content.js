// ===== 抖音数据管理 - Content Script (isolated world) =====

(function () {
  "use strict";

  // ---------- config ----------
  const INJECT_URL = chrome.runtime.getURL("content/inject.js");

  // 记录状态查询桥：inject 播放/悬停发起，content 转发 background 的主键直读；
  // 结果按 awemeId 短 TTL 缓存（播放/悬停会反复触发同一条）
  const RECORD_STATUS = {
    TTL: 30000,
    MAX: 200,
    TRIM_TO: 150,
    REQUEST_EVENT: "DY_RECORD_STATUS_REQUEST",
    RESULT_EVENT: "DY_RECORD_STATUS_RESULT",
    SAVED_EVENT: "DY_WORK_SAVED",
  };

  // Ctrl/Cmd+点击保存按钮的作者入库桥：inject → content → IMPORT_CANDIDATE
  const CANDIDATE_IMPORT = {
    TIMEOUT: 30000,
    REQUEST_EVENT: "DY_IMPORT_CANDIDATE_REQUEST",
    RESULT_EVENT: "DY_IMPORT_CANDIDATE_RESULT",
  };

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
      detail: (msg) => ({ secUid: msg.secUid, uid: msg.uid }),
    },
    FETCH_WORKS_PAGE: {
      req: "DY_FETCH_WORKS_PAGE_REQUEST",
      res: "DY_FETCH_WORKS_PAGE_RESULT",
      // 60s 仅用于摘除内容侧结果监听器：背景侧 30s 已决定响应无效，此值不是请求超时
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
    SET_ONE_FAVORITES: {
      req: "DY_SET_ONE_FAVORITES_REQUEST",
      res: "DY_SET_ONE_FAVORITES_RESULT",
      timeout: () => 30000,
      detail: (msg) => ({ awemeId: msg.awemeId, active: msg.active === true }),
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
    SET_ONE_COLLECTION: {
      req: "DY_SET_ONE_COLLECTION_REQUEST",
      res: "DY_SET_ONE_COLLECTION_RESULT",
      timeout: () => 30000,
      detail: (msg) => ({ awemeId: msg.awemeId, active: msg.active === true }),
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

  // LRU 裁剪（CaptureCache/RecordStatus 共用）：超上限时从最旧端删至 trimTo
  function trimLru(map, max, trimTo) {
    if (map.size <= max) return;
    let toDelete = map.size - trimTo;
    const iter = map.keys();
    while (toDelete-- > 0) map.delete(iter.next().value);
  }

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

    // 只读命中（不更新 LRU）：状态查询在 fiber 缺 uid 时用捕获作品补作者标识
    peek(key) {
      return this.#map.get(key);
    }

    #onCaptureWorks(e) {
      const works = e.detail;
      if (!Array.isArray(works) || works.length === 0) return;
      for (const w of works) {
        if (w && w.awemeId) this.#map.set(w.awemeId, w);
      }
      trimLru(this.#map, this.#MAX, this.#TRIM_TO);
    }

    #onCaptureFeatures(e) {
      const features = e.detail;
      if (!features) return;
      // 特征采集失败 = 独立模式指纹未落库，不能无痕；扩展重载时 sendMessage 会同步 throw，
      // 仅 .catch 接不住（对齐 RecordStatus/CandidateSaver 的 try/catch 处理）
      try {
        chrome.runtime
          .sendMessage({ type: "CAPTURE_BROWSER_FEATURES", features })
          .catch((err) => console.warn("[DY] capture features failed:", err));
      } catch (err) {
        console.warn("[DY] capture features failed:", err);
      }
    }
  }
  const captureCache = new CaptureCache();

  // ---------- RecordStatus ----------
  // 当前作品/作者状态：作品域按 awemeId、候选/关注域按 uid 主键直读。inject 的播放与悬停
  // 都会重复触发同一 awemeId，故按 key 缓存短 TTL + in-flight 去重；回到可见时清空，
  // 让用户从 options 改完数据切回抖音标签页后立即反映最新状态。
  class RecordStatus {
    #cache = new Map();
    #inflight = new Map();

    constructor() {
      document.addEventListener(RECORD_STATUS.REQUEST_EVENT, (e) => this.#onRequest(e));
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) this.#cache.clear();
      });
    }

    #onRequest(e) {
      const { requestId, awemeId, uid } = e.detail || {};
      if (!requestId || !awemeId) return;
      // fiber 的 author 偶尔缺 uid：用抓包 LRU 中同一作品的 uid 兜底
      const resolvedUid = uid || captureCache.peek(String(awemeId))?.uid || "";
      this.get(awemeId, resolvedUid)
        .then((status) => {
          document.dispatchEvent(
            new CustomEvent(RECORD_STATUS.RESULT_EVENT, { detail: { requestId, status } }),
          );
        })
        .catch(() => {
          document.dispatchEvent(
            new CustomEvent(RECORD_STATUS.RESULT_EVENT, { detail: { requestId, status: null } }),
          );
        });
    }

    get(awemeId, uid) {
      const key = String(awemeId);
      const cached = this.#cache.get(key);
      // 首次查询若 fiber 尚未带 uid，缓存里没有作者结果；后续拿到 uid 时绕过缓存补查
      const cachedLacksAuthor = cached && uid && !cached.status?.author?.uid;
      if (cached && !cachedLacksAuthor && Date.now() - cached.at < RECORD_STATUS.TTL) {
        this.#cache.delete(key);
        this.#cache.set(key, cached);
        return Promise.resolve(cached.status);
      }
      const pending = this.#inflight.get(key);
      if (pending) return pending.promise;

      const token = {};
      const request = new Promise((resolve) => {
        let timer = null;
        const deliver = (status) => {
          clearTimeout(timer);
          if (this.#inflight.get(key)?.token === token) this.#inflight.delete(key);
          resolve(status);
        };
        // SW 冷启动/扩展上下文失效时 callback 可能永不触发：兜底释放 in-flight，
        // 否则同一 awemeId 会永久命中一个永不 resolve 的 Promise
        timer = setTimeout(() => deliver(null), 10000);
        try {
          chrome.runtime.sendMessage(
            { type: "GET_RECORD_STATUS", awemeId: key, uid: String(uid || "") },
            (response) => {
              if (chrome.runtime.lastError || !response || response.error || response.ok === false) {
                deliver(null);
                return;
              }
              this.#remember(key, response);
              deliver(response);
            },
          );
        } catch (_e) {
          deliver(null);
        }
      });
      this.#inflight.set(key, { token, promise: request });
      return request;
    }

    // 保存成功即时回写：无需等下一次状态查询，按钮立即显示「已存」；
    // 作者状态若尚未查询过保持缺失，由后续悬停/播放补全
    markSaved(awemeId) {
      const key = String(awemeId);
      const prev = this.#cache.get(key)?.status || { work: { exists: false }, author: {} };
      this.#remember(key, { ...prev, work: { exists: true } });
      document.dispatchEvent(
        new CustomEvent(RECORD_STATUS.SAVED_EVENT, { detail: { awemeId: key } }),
      );
    }

    // Ctrl/Cmd+点击保存按钮入库作者成功：缓存即时置 candidate=true，
    // 避免随后的状态查询在 TTL 内把角标回退成「未收录」
    markCandidate(awemeId) {
      const key = String(awemeId);
      const prev = this.#cache.get(key)?.status || { work: { exists: false }, author: {} };
      this.#remember(key, { ...prev, author: { ...(prev.author || {}), candidate: true } });
    }

    #remember(key, status) {
      this.#cache.delete(key);
      this.#cache.set(key, { at: Date.now(), status });
      trimLru(this.#cache, RECORD_STATUS.MAX, RECORD_STATUS.TRIM_TO);
    }
  }
  const recordStatus = new RecordStatus();

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
          recordStatus.markSaved(fullWork.awemeId);
          const label = (fullWork.nickname ? `@${fullWork.nickname}` : fullWork.awemeId).slice(0, 20);
          const groupName = response.groupName || "未分组";
          // added>0 为新增；否则作品已在作品域，按落库 groupId 解析的分组名提示所在组
          toast.show(
            response.added > 0 ? `已保存作品：${label}（入「${groupName}」）` : `作品已在作品域：${label}（分组「${groupName}」）`,
            "success",
          );
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

  // ---------- CandidateSaver ----------
  // Ctrl/Cmd+点击保存按钮：把当前作品作者收录进候选域。复用 background IMPORT_CANDIDATE
  //（Tab/独立双模），按 secUid 去重，成功后同步 RecordStatus 缓存。
  class CandidateSaver {
    #inflight = new Set();

    constructor() {
      document.addEventListener(CANDIDATE_IMPORT.REQUEST_EVENT, (e) => this.#onRequest(e));
    }

    #onRequest(e) {
      const { requestId, awemeId, secUid, nickname } = e.detail || {};
      if (!requestId) return;
      if (!secUid) {
        toast.show("无法获取作者信息", "error");
        this.#dispatch({ requestId, awemeId, ok: false, error: "NO_SEC_UID" });
        return;
      }
      if (this.#inflight.has(secUid)) {
        toast.show("正在添加该作者，请稍候…", "info");
        this.#dispatch({ requestId, awemeId, ok: false, error: "BUSY" });
        return;
      }

      this.#inflight.add(secUid);
      toast.show(`正在添加作者到候选域${nickname ? "：" + nickname : "…"}`, "info");

      let settled = false;
      let timer = null;
      const finish = (detail) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#inflight.delete(secUid);
        this.#dispatch(detail);
      };
      timer = setTimeout(() => {
        toast.show(this.#errorText("TIMEOUT"), "error");
        finish({ requestId, awemeId, ok: false, error: "TIMEOUT" });
      }, CANDIDATE_IMPORT.TIMEOUT);

      try {
        chrome.runtime.sendMessage({ type: "IMPORT_CANDIDATE", secUid }, (response) => {
          if (settled) return;
          const lastError = chrome.runtime.lastError;
          if (lastError || !response || response.ok !== true) {
            const error = response?.error || lastError?.message || "IMPORT_FAILED";
            toast.show(this.#errorText(error), "error");
            finish({ requestId, awemeId, ok: false, error });
            return;
          }
          const candidate = response.candidate || {};
          const nick = candidate.nickname || nickname || "未知";
          const groupName = response.groupName || "未分组";
          toast.show(
            response.added > 0
              ? `已新增候选作者：${nick}（入「${groupName}」）`
              : `作者已在候选域：${nick}（分组「${groupName}」）`,
            "success",
          );
          if (awemeId) recordStatus.markCandidate(awemeId);
          finish({ requestId, awemeId, ok: true, added: response.added, groupName });
        });
      } catch (_e) {
        toast.show("扩展上下文已失效，请刷新页面", "error");
        finish({ requestId, awemeId, ok: false, error: "CONTEXT_INVALIDATED" });
      }
    }

    #errorText(msg) {
      if (msg === "NO_SIGNATURE") {
        return "未捕获到请求签名，请在抖音页面刷新或浏览作者主页后重试";
      }
      if (msg === "NO_DOUYIN_TAB") return "未找到抖音标签页";
      if (msg === "PROFILE_FETCH_FAILED") return "作者信息获取失败，请稍后重试";
      if (msg === "TIMEOUT") return "添加作者超时，请稍后重试";
      if (String(msg).includes("2096")) return "该账号因隐私设置不可见";
      return "候选域入库失败：" + msg;
    }

    #dispatch(detail) {
      document.dispatchEvent(new CustomEvent(CANDIDATE_IMPORT.RESULT_EVENT, { detail }));
    }
  }
  const candidateSaver = new CandidateSaver();

  // ---------- 启动 ----------
  function injectMainWorldScript() {
    const script = document.createElement("script");
    script.src = INJECT_URL;
    script.onload = () => script.remove();
    document.documentElement.appendChild(script);
  }

  injectMainWorldScript();
})();
