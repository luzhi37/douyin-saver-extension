(function () {
  "use strict";

  // ---------- config ----------
  const CONFIG = {
    URL_BASE: "https://www.douyin.com",
    API_PATTERNS: [
      "/aweme/v1/web/tab/feed",
      "/aweme/v1/web/aweme/post/",
      "/aweme/v1/web/aweme/detail/",
      "/aweme/v1/web/aweme/favorite/",
      "/aweme/v1/web/follow/feed",
      "/aweme/v1/web/familiar/feed",
      "/aweme/v1/web/search/item/",
      "/aweme/v1/web/general/search/single/",
      "/aweme/v1/web/aweme/related/",
      "/aweme/v1/web/mix/aweme/",
      "/aweme/v1/web/user/following/list",
      "/aweme/v1/web/user/profile/other/",
      "/aweme/v1/web/aweme/listcollection/",
    ],
    API: {
      FOLLOWING: "/aweme/v1/web/user/following/list",
      PROFILE_OTHER: "/aweme/v1/web/user/profile/other/",
      POST: "/aweme/v1/web/aweme/post/",
      FAVORITE: "/aweme/v1/web/aweme/favorite/",
      COLLECTION: "/aweme/v1/web/aweme/listcollection/",
      DETAIL: "/aweme/v1/web/aweme/detail/",
    },
    DEVICE_PARAMS: {
      device_platform: "webapp",
      aid: "6383",
      channel: "channel_pc_web",
      pc_client_type: "1",
      version_code: "170400",
      version_name: "17.4.0",
      cookie_enabled: "true",
      platform: "PC",
      publish_video_strategy_type: "2",
    },
    TIMEOUT: {
      FETCH_PAGE: 15000,
      FETCH_DETAIL: 8000,
    },
    CANCEL: {
      COLLECTION_URL: "https://www.douyin.com/aweme/v1/web/aweme/collect/?aid=6383",
      LIKE_URL: "https://www.douyin.com/aweme/v1/web/commit/item/digg/?aid=6383",
      COLLECTION_REFERRER: "https://www.douyin.com/user/self?showTab=favorite_collection",
      LIKE_REFERRER: "https://www.douyin.com/user/self?showTab=like",
      COLLECTION_BODY: (id) => "action=0&aweme_id=" + id + "&aweme_type=0",
      LIKE_BODY: (id) => "aweme_id=" + id + "&item_type=0&type=0",
    },
    SECURITY_KEY: "security-sdk/s_sdk_cert_key",
    CANCEL_CONTENT_TYPE: "application/x-www-form-urlencoded; charset=UTF-8",
    COLLECTION_CONTENT_TYPE: "application/x-www-form-urlencoded",
    AWEME_TYPE_NOTE: 68,
    TOOLTIP_DESC_MAX_LEN: 30,
    BUTTON: {
      CONTAINER: ".basePlayerContainer",
      GRID: ".basePlayerContainer xg-right-grid",
      CLASS_SAVE: "dy-saver-btn",
      OBSERVER_DEBOUNCE: 100,
      TEXT_SAVE: "保存",
    },
    EVENTS: {
      CAPTURE_WORKS: "DY_CAPTURE_WORKS",
      FETCH_DETAIL_REQUEST: "DY_FETCH_DETAIL_REQUEST",
      FETCH_DETAIL_RESULT: "DY_FETCH_DETAIL_RESULT",
      FETCH_SINGLE_WORK_REQUEST: "DY_FETCH_SINGLE_WORK_REQUEST",
      FETCH_SINGLE_WORK_RESULT: "DY_FETCH_SINGLE_WORK_RESULT",
      FETCH_FOLLOWING_PAGE_REQUEST: "DY_FETCH_FOLLOWING_PAGE_REQUEST",
      FETCH_FOLLOWING_PAGE_RESULT: "DY_FETCH_FOLLOWING_PAGE_RESULT",
      FETCH_PROFILE_OTHER_REQUEST: "DY_FETCH_PROFILE_OTHER_REQUEST",
      FETCH_PROFILE_OTHER_RESULT: "DY_FETCH_PROFILE_OTHER_RESULT",
      FETCH_FAVORITES_PAGE_REQUEST: "DY_FETCH_FAVORITES_PAGE_REQUEST",
      FETCH_FAVORITES_PAGE_RESULT: "DY_FETCH_FAVORITES_PAGE_RESULT",
      FETCH_COLLECTION_PAGE_REQUEST: "DY_FETCH_COLLECTION_PAGE_REQUEST",
      FETCH_COLLECTION_PAGE_RESULT: "DY_FETCH_COLLECTION_PAGE_RESULT",
      FETCH_WORKS_REQUEST: "DY_FETCH_WORKS_REQUEST",
      FETCH_WORKS_RESULT: "DY_FETCH_WORKS_RESULT",
      CANCEL_ONE_COLLECTION_REQUEST: "DY_CANCEL_ONE_COLLECTION_REQUEST",
      CANCEL_ONE_COLLECTION_RESULT: "DY_CANCEL_ONE_COLLECTION_RESULT",
      CANCEL_ONE_LIKE_REQUEST: "DY_CANCEL_ONE_LIKE_REQUEST",
      CANCEL_ONE_LIKE_RESULT: "DY_CANCEL_ONE_LIKE_RESULT",
      BUTTON_CLICK: "DY_BUTTON_CLICK",
      CAPTURE_BROWSER_FEATURES: "DY_CAPTURE_BROWSER_FEATURES",
    },
  };

  const PAGE_KEYS = new Set(["offset", "count"]);
  const SDK_INJECT_KEYS = new Set([
    "a_bogus",
    "timestamp",
    "x-secsdk-web-signature",
    "msToken",
    "verifyFp",
    "fp",
    "uifid",
  ]);

  // ---------- SignatureCapture ----------
  // 签名缓存：从页面 fetch 请求捕获各端点签名参数，供 ApiClient 复用。
  class SignatureCapture {
    #detailQuery = null;
    #profileQuery = null;
    #followingQuery = null;
    #postQuery = null;
    #collectionQuery = null;
    #favoriteQuery = null;

    captureFromUrl(url, parsedUrl) {
      try {
        if (typeof url !== "string" || !url.startsWith("http")) return;
        const u = parsedUrl || new URL(url);
        const params = new Map();
        for (const entry of u.searchParams.entries()) params.set(entry[0], entry[1]);
        params.__dyCaptureTime = Date.now();
        if (u.pathname.includes(CONFIG.API.FOLLOWING)) {
          this.#followingQuery = params;
        }
        if (u.pathname.includes(CONFIG.API.PROFILE_OTHER)) {
          this.#profileQuery = params;
        }
        if (u.pathname.includes(CONFIG.API.POST)) {
          this.#postQuery = params;
        }
        if (u.pathname.includes(CONFIG.API.COLLECTION)) {
          this.#collectionQuery = params;
        }
        if (u.pathname.includes(CONFIG.API.FAVORITE)) {
          this.#favoriteQuery = params;
        }
        if (u.pathname.includes(CONFIG.API.DETAIL)) {
          this.#detailQuery = params;
        }
      } catch (_e) {}
    }

    buildUrl(pathname, params) {
      const url = new URL(pathname, window.location.origin);
      for (const key in params) {
        url.searchParams.set(key, String(params[key]));
      }
      return url;
    }

    // 供 ApiClient 各 fetch 函数组合签名参数（stripSdkKeys 仅收藏/合集用）
    mergeParams(url, captured) {
      if (!captured) return url;
      for (const entry of captured.entries()) {
        const k = entry[0],
          v = entry[1];
        if (!url.searchParams.has(k)) url.searchParams.set(k, v);
      }
      return url;
    }

    stripPageKeys(captured) {
      if (!captured) return null;
      const out = new Map();
      for (const [k, v] of captured) {
        if (PAGE_KEYS.has(k)) continue;
        if (k.startsWith("cursor") || k.startsWith("max_") || k.startsWith("min_")) continue;
        out.set(k, v);
      }
      return out;
    }

    stripSdkKeys(captured) {
      if (!captured) return null;
      const out = new Map();
      for (const [k, v] of captured) {
        if (SDK_INJECT_KEYS.has(k)) continue;
        out.set(k, v);
      }
      return out;
    }

    // ===== 共享工具函数 =====

    resolveSelfSecUid() {
      const candidates = [this.#favoriteQuery, this.#postQuery, this.#followingQuery, this.#collectionQuery];
      for (const q of candidates) {
        if (!q) continue;
        const secUid = q.get("sec_user_id");
        if (secUid && secUid !== "self") return secUid;
      }
      return "";
    }

    get detailQuery() {
      return this.#detailQuery;
    }
    get profileQuery() {
      return this.#profileQuery;
    }
    get followingQuery() {
      return this.#followingQuery;
    }
    get postQuery() {
      return this.#postQuery;
    }
    get collectionQuery() {
      return this.#collectionQuery;
    }
    get favoriteQuery() {
      return this.#favoriteQuery;
    }
  }
  const signatureCapture = new SignatureCapture();

  // ---------- WorkExtractor ----------
  // 作品提取：从响应/React fiber 还原 Work 结构。
  class WorkExtractor {
    #buildAuthorHomeUrl(author) {
      const secUid = author?.secUid || author?.sec_uid || "";
      return secUid ? `https://www.douyin.com/user/${secUid}` : "";
    }

    #normalizeProtocol(url) {
      return url && url.startsWith("http:") ? url.replace("http:", "") : url || "";
    }

    // 与 background 侧同款：从 CDN 直链 query 解析过期时间戳
    #parseExpire(value) {
      const n = Number(value);
      if (!isFinite(n) || n <= 0) return null;
      if (n > 1e11) return n > 1e13 ? null : n; // 毫秒时间戳
      if (n > 1e9) return n * 1000; // 秒时间戳
      if (n <= 86400 * 30) return Date.now() + n * 1000; // 剩余秒数
      return null;
    }

    #urlExpireAt(url) {
      try {
        const abs = url.startsWith("//") ? "https:" + url : url;
        const sp = new URL(abs).searchParams;
        // 键名含 expire（大小写不敏感）的参数优先，兼容 expire/x-expires/expires 等变体
        for (const key of sp.keys()) {
          if (/expire/i.test(key)) {
            const at = this.#parseExpire(sp.get(key));
            if (at != null) return at;
          }
        }
        return null;
      } catch {
        return null;
      }
    }

    // 返回 { url, expireAt }。api 源与 background formatWork 同款三级取链：
    // 长效（各档 playApi）→ 无 playApi 时用最高清档 play_addr.uri 合成 /aweme/v1/play/ 长效链
    // → CDN url_list 短效直链兜底。长效作为整体类目优先于 CDN，只在同类内部比分辨率；
    // 不要改回"混池按最高分辨率挑选"——最高清档恰好缺 playApi 时会把短效直链存进库。
    #extractVideo(raw, source) {
      const video = raw.video || {};
      const bitRateList = source === "fiber" ? video.bitRateList || video.bit_rate : video.bit_rate;

      if (!Array.isArray(bitRateList) || bitRateList.length === 0) {
        const url = this.#normalizeProtocol(video.play_addr?.url_list?.[0] || "");
        return { url, expireAt: this.#urlExpireAt(url) || 0 };
      }

      const rates = [];
      for (const item of bitRateList) {
        const gear = (item.gearName || item.gear_name || "").toLowerCase();
        if (source === "fiber") {
          if (gear.includes("智能") || gear.includes("smart") || gear.includes("adapt")) continue;
        }
        if (item.isH265 || item.is_h265) continue;
        rates.push(item);
      }

      // fiber 分支维持原行为：只认 playApi、无 url_list 回退，按高度排序后仅留一档
      if (source === "fiber") {
        const picked = [];
        for (const item of rates) {
          if (!item.playApi) continue;
          const playAddr = item.play_addr || {};
          picked.push({
            url: item.playApi,
            width: playAddr.width || item.width || 0,
            height: playAddr.height || item.height || 0,
            fps: item.FPS || 0,
            dataSize: playAddr.data_size || 0,
          });
        }
        picked.sort((a, b) => (b.height || 0) - (a.height || 0));
        picked.splice(1);
        const url = picked.length > 0 ? this.#normalizeProtocol(picked[0].url) : "";
        return { url, expireAt: this.#urlExpireAt(url) || 0 };
      }

      const longs = [];
      for (const item of rates) {
        const api = String(item.playApi || "");
        if (!api) continue;
        const addr = item.play_addr || {};
        longs.push({
          url: /^https?:\/\//i.test(api) ? api : CONFIG.URL_BASE + (api.startsWith("/") ? "" : "/") + api,
          height: addr.height || item.height || 0,
        });
      }

      let url = "";
      let expireAt = 0;
      if (longs.length > 0) {
        // ID 型链接无时效参数，expireAt 保持 0（长效/未知）
        const maxH = Math.max(...longs.map((c) => c.height));
        url = (longs.find((c) => c.height === maxH) || longs[0]).url;
      } else {
        const bestBr = rates.reduce(
          (a, b) => (((b.play_addr || {}).height || 0) > (((a || {}).play_addr || {}).height || 0) ? b : a),
          null,
        );
        const uri =
          ((bestBr || {}).play_addr || {}).uri ||
          (video.play_addr && video.play_addr.uri) ||
          "";
        if (uri) {
          url =
            CONFIG.URL_BASE +
            "/aweme/v1/play/?video_id=" +
            encodeURIComponent(uri) +
            "&aid=6383&is_play_url=1&line=0";
        } else {
          // CDN 短效直链兜底：先取最高清档，档内比较 expireAt 取最长者
          const cands = [];
          for (const item of rates) {
            const addr = item.play_addr || {};
            const h = addr.height || item.height || 0;
            for (const u of Array.isArray(addr.url_list) ? addr.url_list : []) {
              if (u) cands.push({ url: u, height: h, expireAt: this.#urlExpireAt(u) });
            }
          }
          if (cands.length === 0) {
            for (const u of (video.play_addr && video.play_addr.url_list) || []) {
              if (u) cands.push({ url: u, height: 0, expireAt: this.#urlExpireAt(u) });
            }
          }
          if (cands.length > 0) {
            const maxH = Math.max(...cands.map((c) => c.height));
            const top = cands.filter((c) => c.height === maxH);
            let best = top[0];
            for (const c of top) {
              if (c.expireAt != null && (best.expireAt == null || c.expireAt > best.expireAt)) best = c;
            }
            url = best.url;
            expireAt = best.expireAt || 0;
          }
        }
      }
      return { url: this.#normalizeProtocol(url), expireAt };
    }

    #extractCover(raw) {
      const video = raw.video || {};
      const images = this.#extractImages(raw);
      const isNote = (raw.awemeType || raw.aweme_type) === CONFIG.AWEME_TYPE_NOTE;
      if (isNote && images.length > 0) return images[0];
      return this.#normalizeProtocol(video.cover?.url_list?.[0] || video.coverUrlList?.[0] || "");
    }

    #extractImages(raw) {
      const imgList = raw.images;
      if (!Array.isArray(imgList)) return [];
      const images = [];
      for (const img of imgList) {
        const urlList = img.urlList || img.url_list || [];
        const imgUrl = urlList[0] || "";
        if (imgUrl) images.push(this.#normalizeProtocol(imgUrl));
      }
      return images;
    }

    #extractMusic(raw) {
      const music = raw.music || {};
      return music.playUrl?.uri || music.play_url?.uri || "";
    }

    #extractAuthor(raw) {
      return raw.authorInfo || raw.author || {};
    }

    #extractAuthorFollowed(raw) {
      const author = this.#extractAuthor(raw);
      if (!("follow_status" in author) && !("followStatus" in author)) return null;
      const followRaw = author.follow_status ?? author.followStatus;
      return followRaw === 1 || followRaw === 2;
    }

    normalizeWork(raw, source) {
      if (!raw) return null;
      const awemeId = String(raw.aweme_id || raw.awemeId || "");
      if (!awemeId) return null;

      const author = this.#extractAuthor(raw);
      const isNote = (raw.awemeType || raw.aweme_type) === CONFIG.AWEME_TYPE_NOTE;
      const vid = this.#extractVideo(raw, source);

      return {
        awemeId,
        type: isNote ? "note" : "video",
        desc: raw.desc || "",
        nickname: String(author.nickname || author.nickName || ""),
        uid: String(author.uid || ""),
        authorHomeUrl: this.#buildAuthorHomeUrl(author),
        cover: this.#extractCover(raw),
        video: vid.url,
        videoExpireAt: vid.expireAt || 0,
        images: this.#extractImages(raw),
        music: this.#extractMusic(raw),
        createTime: raw.create_time || 0,
        statistics: raw.statistics || {},
      };
    }

    extractWorkFromRaw(awemeData, { fromFiber } = {}) {
      return this.normalizeWork(awemeData, fromFiber ? "fiber" : "api");
    }

    async extractWorksFromResponse(url, data, parsedUrl) {
      let list = [];
      const pathname = parsedUrl ? parsedUrl.pathname : new URL(url).pathname;

      if (pathname.includes(CONFIG.API.DETAIL)) {
        if (data.aweme_detail) list = [data.aweme_detail];
      } else if (pathname.includes("/aweme/v1/web/follow/feed") || pathname.includes("/aweme/v1/web/familiar/feed")) {
        if (Array.isArray(data.data)) {
          for (const item of data.data) {
            if (item.aweme) list.push(item.aweme);
          }
        }
      } else if (
        pathname.includes("/aweme/v1/web/search/item/") ||
        pathname.includes("/aweme/v1/web/general/search/single/")
      ) {
        if (Array.isArray(data.data)) {
          for (const item of data.data) {
            if (item.aweme_info) list.push(item.aweme_info);
          }
        }
      } else {
        if (Array.isArray(data.aweme_list)) {
          list = data.aweme_list;
        } else if (Array.isArray(data.data)) {
          for (const item of data.data) {
            if (item.aweme) list.push(item.aweme);
            else if (item.aweme_info) list.push(item.aweme_info);
          }
        }
      }

      return list.map((item) => this.extractWorkFromRaw(item, { fromFiber: false })).filter(Boolean);
    }

    transformAwemeItem(aw, { includeAuthorFollowed = false } = {}) {
      const work = this.normalizeWork(aw, "api");
      if (!work) return null;
      if (includeAuthorFollowed) {
        work.authorFollowed = this.#extractAuthorFollowed(aw);
      }
      return work;
    }

    shouldCapture(url) {
      try {
        const u = new URL(url);
        if (CONFIG.API_PATTERNS.some((p) => u.pathname.startsWith(p))) return u;
        return null;
      } catch {
        return null;
      }
    }

    dispatchWorks(works) {
      if (works.length === 0) return;
      document.dispatchEvent(new CustomEvent(CONFIG.EVENTS.CAPTURE_WORKS, { detail: works }));
    }
  }
  const workExtractor = new WorkExtractor();

  // ---------- TaskController ----------
  // 后台任务取消支持：跟踪当前活跃任务，DY_CANCEL_ACTIVE_TASK 时中止。
  class TaskController {
    #activeTask = null;

    constructor() {
      document.addEventListener("DY_CANCEL_ACTIVE_TASK", () => this.#onCancel());
    }

    setActiveTask(abort) {
      this.#activeTask?.abort();
      this.#activeTask = abort ? { abort } : null;
    }

    #onCancel() {
      if (this.#activeTask) {
        this.#activeTask.abort();
        this.#activeTask = null;
      }
    }
  }
  const taskController = new TaskController();

  // ---------- ApiClient ----------
  // 请求签名（交由抖音页面 fetch 包装器注入）+ 各 API 请求函数。
  class ApiClient {
    #getDetailBrowserParams() {
      const conn = navigator.connection;
      return {
        request_source: "600",
        origin_type: "video_page",
        update_version_code: "170400",
        pc_libra_divert: "Windows",
        support_h265: "0",
        support_dash: "1",
        cpu_core_num: navigator.hardwareConcurrency || 4,
        device_memory: navigator.deviceMemory || 4,
        screen_width: screen.width,
        screen_height: screen.height,
        browser_language: navigator.language,
        browser_platform: navigator.platform,
        browser_name: "Edge",
        browser_version: "149.0.0.0",
        engine_name: "Blink",
        engine_version: "149.0.0.0",
        os_name: "Windows",
        os_version: "10",
        browser_online: navigator.onLine,
        downlink: (conn?.downlink || 10) + "",
        effective_type: conn?.effectiveType || "4g",
        round_trip_time: conn?.rtt || 50,
      };
    }

    getSecurityKey() {
      try {
        const raw = localStorage.getItem(CONFIG.SECURITY_KEY) || "{}";
        return (JSON.parse(raw).data || "").replace(/^pub\./, "");
      } catch (e) {
        return "";
      }
    }

    collectBrowserFeatures() {
      const chromeVer = (navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1] || "139";
      return {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        browserLanguage: navigator.language,
        browserName: navigator.userAgent.includes("Edg")
          ? "Edge"
          : navigator.userAgent.includes("Chrome")
            ? "Chrome"
            : "Unknown",
        browserVersion: chromeVer,
        engineName: "Blink",
        engineVersion: chromeVer,
        osName: navigator.platform.includes("Win")
          ? "Windows"
          : navigator.platform.includes("Mac")
            ? "Mac OS"
            : "Unknown",
        osVersion: "10",
        screenWidth: screen.width,
        screenHeight: screen.height,
        cpuCoreNum: navigator.hardwareConcurrency || 4,
        deviceMemory: navigator.deviceMemory || 4,
        securityKey: this.getSecurityKey(),
      };
    }

    // 六个 API fetch 共用的请求接线：外部 signal/超时 abort 合并到内部 controller，
    // fetch 结束（成功或失败）即清理超时定时器；返回 Response 交由调用方解析
    #guardedFetch(url, { method = "GET", headers, timeout, signal }) {
      const controller = new AbortController();
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
      const tid = setTimeout(() => controller.abort(), timeout);
      return window
        .fetch(url, {
          credentials: "include",
          headers: headers || { Referer: window.location.origin + "/" },
          method,
          signal: controller.signal,
          _dyInternal: true,
        })
        .finally(() => clearTimeout(tid));
    }

    // ===== 详情拉取 (saver 现有) =====

    async fetchOneDetail(awemeId, externalController) {
      const url = new URL(CONFIG.API.DETAIL, window.location.origin);
      url.searchParams.set("aweme_id", String(awemeId));
      for (const [k, v] of Object.entries(CONFIG.DEVICE_PARAMS)) url.searchParams.set(k, v);
      for (const [k, v] of Object.entries(this.#getDetailBrowserParams())) url.searchParams.set(k, String(v));

      const capturedDetail = signatureCapture.stripSdkKeys(signatureCapture.detailQuery);
      if (capturedDetail) {
        for (const [k, v] of capturedDetail.entries()) {
          if (k === "aweme_id") continue;
          if (!url.searchParams.has(k)) url.searchParams.set(k, v);
        }
      }

      try {
        const resp = await this.#guardedFetch(url.toString(), {
          timeout: CONFIG.TIMEOUT.FETCH_DETAIL,
          signal: externalController ? externalController.signal : undefined,
        });
        const text = await resp.text();
        if (!text || !text.trim()) {
          throw new Error("RATE_LIMITED");
        }
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const data = JSON.parse(text);
        if (data && data.status_code !== undefined && data.status_code !== 0) {
          throw new Error("status_code=" + data.status_code);
        }
        const list = await workExtractor.extractWorksFromResponse(url.toString(), data);
        return list[0] || null;
      } catch (e) {
        if (e && e.name === "AbortError") throw new Error("CANCELLED");
        throw e;
      }
    }

    // ===== 关注列表拉取 (tools 移植) =====

    async fetchFollowingPage(secUid, offset, count, externalSignal) {
      const url = signatureCapture.buildUrl(
        CONFIG.API.FOLLOWING,
        Object.assign({}, CONFIG.DEVICE_PARAMS, {
          sec_user_id: secUid,
          offset: String(offset),
          count: String(count),
        }),
      );
      const merged = signatureCapture.mergeParams(
        url,
        signatureCapture.stripPageKeys(signatureCapture.stripSdkKeys(signatureCapture.followingQuery)),
      );
      const resp = await this.#guardedFetch(merged.toString(), {
        timeout: CONFIG.TIMEOUT.FETCH_PAGE,
        signal: externalSignal,
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      return await resp.json();
    }

    async fetchProfileOther(secUid, externalSignal) {
      const sigSource =
        signatureCapture.profileQuery ||
        signatureCapture.followingQuery ||
        signatureCapture.postQuery ||
        signatureCapture.favoriteQuery ||
        signatureCapture.collectionQuery;
      const url = signatureCapture.buildUrl(
        CONFIG.API.PROFILE_OTHER,
        Object.assign({}, CONFIG.DEVICE_PARAMS, {
          sec_user_id: secUid,
        }),
      );
      // sigSource 跨端点兜底（profileQuery || followingQuery || ...），每环都必须经
      // stripSdkKeys 剥签名键——否则旧 x-secsdk-web-signature 预塞回 URL，页面包装器
      // 不再重签，Argus 按过期签名拒绝（post/profile 已被强制 webSign 校验）
      const merged = signatureCapture.mergeParams(url, signatureCapture.stripPageKeys(signatureCapture.stripSdkKeys(sigSource)));
      const resp = await this.#guardedFetch(merged.toString(), {
        timeout: CONFIG.TIMEOUT.FETCH_PAGE,
        signal: externalSignal,
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      return await resp.json();
    }

    // ===== 作者作品拉取 (tools 移植, 侧边栏用) =====

    async fetchAuthorWorks(secUid, startCursor, count) {
      const url = signatureCapture.buildUrl(
        CONFIG.API.POST,
        Object.assign({}, CONFIG.DEVICE_PARAMS, {
          sec_user_id: secUid,
          max_cursor: String(startCursor || 0),
          count: String(count),
        }),
      );
      const merged = signatureCapture.mergeParams(
        url,
        signatureCapture.stripPageKeys(signatureCapture.stripSdkKeys(signatureCapture.postQuery)),
      );
      const resp = await this.#guardedFetch(merged.toString(), { timeout: CONFIG.TIMEOUT.FETCH_PAGE });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      if (data.status_code !== undefined && data.status_code !== 0) throw new Error("API_ERROR");

      const works = (data.aweme_list || []).map((aw) => workExtractor.transformAwemeItem(aw));
      const hasMore = data.has_more === true || data.has_more === 1 || data.has_more === "1";
      return {
        works,
        hasMore,
        maxCursor: data.max_cursor || (startCursor || 0) + count,
      };
    }

    // ===== 点赞/收藏分页拉取 =====

    async fetchOneFavoritesPage(secUid, cursor, count, signal) {
      const url = signatureCapture.buildUrl(
        CONFIG.API.FAVORITE,
        Object.assign({}, CONFIG.DEVICE_PARAMS, {
          sec_user_id: secUid,
          count: String(count),
          max_cursor: String(cursor),
        }),
      );
      const merged = signatureCapture.mergeParams(
        url,
        signatureCapture.stripPageKeys(signatureCapture.stripSdkKeys(signatureCapture.favoriteQuery)),
      );
      const resp = await this.#guardedFetch(merged.toString(), {
        timeout: CONFIG.TIMEOUT.FETCH_PAGE,
        signal,
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      if (data.status_code !== undefined && data.status_code !== 0) throw new Error("API_ERROR");
      const items = (data.aweme_list || []).map((aw) =>
        workExtractor.transformAwemeItem(aw, { includeAuthorFollowed: true }),
      );
      const hasMore = data.has_more === true || data.has_more === 1 || data.has_more === "1";
      const nextCursor = data.cursor || data.max_cursor || cursor + count;
      return {
        items,
        hasMore,
        cursor: nextCursor,
        total: data.total,
        ok: true,
      };
    }

    async fetchOneCollectionPage(cursor, count, signal) {
      const url = signatureCapture.buildUrl(
        CONFIG.API.COLLECTION,
        Object.assign({}, CONFIG.DEVICE_PARAMS, {
          count: String(count),
          cursor: String(cursor),
        }),
      );
      const merged = signatureCapture.mergeParams(
        url,
        signatureCapture.stripPageKeys(signatureCapture.stripSdkKeys(signatureCapture.collectionQuery)),
      );
      const resp = await this.#guardedFetch(merged.toString(), {
        method: "POST",
        timeout: CONFIG.TIMEOUT.FETCH_PAGE,
        signal,
        headers: {
          Referer: window.location.origin + "/",
          "content-type": CONFIG.COLLECTION_CONTENT_TYPE,
        },
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      if (data.status_code !== undefined && data.status_code !== 0) throw new Error("API_ERROR");
      const items = (data.aweme_list || []).map((aw) =>
        workExtractor.transformAwemeItem(aw, { includeAuthorFollowed: true }),
      );
      const hasMore = data.has_more === true || data.has_more === 1 || data.has_more === "1";
      const nextCursor = data.cursor || data.max_cursor || cursor + count;
      return {
        items,
        hasMore,
        cursor: nextCursor,
        total: data.total,
        ok: true,
      };
    }
  }
  const apiClient = new ApiClient();

  // ---------- CancelHandler ----------
  // 取消点赞/收藏 (tools 移植)。Tab 模式用 XHR 而非 fetch——a_bogus 签名与 XHR 原型链深度绑定。
  class CancelHandler {
    #cancelOne(awemeId, url, bodyFn, referrer, signal) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        if (signal) {
          if (signal.aborted) {
            reject(new Error("CANCELLED"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              xhr.abort();
              reject(new Error("CANCELLED"));
            },
            { once: true },
          );
        }
        const key = apiClient.getSecurityKey();
        xhr.open("POST", url);
        xhr.withCredentials = true;
        xhr.setRequestHeader("content-type", CONFIG.CANCEL_CONTENT_TYPE);
        xhr.setRequestHeader("Referer", referrer);
        if (key) xhr.setRequestHeader("bd-ticket-guard-ree-public-key", key);
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else if (xhr.status === 401 || xhr.status === 403) {
            reject(new Error("AUTH_FAILED"));
          } else {
            reject(new Error("HTTP_" + xhr.status));
          }
        };
        xhr.onerror = () => reject(new Error("NETWORK_ERROR"));
        xhr.onabort = () => reject(new Error("CANCELLED"));
        xhr.send(bodyFn(awemeId));
      });
    }

    cancelOneLike(awemeId, signal) {
      return this.#cancelOne(awemeId, CONFIG.CANCEL.LIKE_URL, CONFIG.CANCEL.LIKE_BODY, CONFIG.CANCEL.LIKE_REFERRER, signal);
    }

    cancelOneCollection(awemeId, signal) {
      return this.#cancelOne(
        awemeId,
        CONFIG.CANCEL.COLLECTION_URL,
        CONFIG.CANCEL.COLLECTION_BODY,
        CONFIG.CANCEL.COLLECTION_REFERRER,
        signal,
      );
    }
  }
  const cancelHandler = new CancelHandler();

  // ---------- SecurityStatus ----------
  // 安全状态查询：汇总签名捕获快照 + hook 状态，供 options 安全面板展示。
  // 展示值剥离 SDK 注入键（修复后签名由页面包装器代签，捕获物只有业务/环境参数有价值）；
  // webSign 标记该端点捕获是否含 x-secsdk-web-signature，用于观察抖音风控策略变化。
  class SecurityStatus {
    #buildSigValue(captured) {
      if (!captured || captured.size === 0) return "";
      return Array.from(captured.entries())
        .filter(([k]) => !SDK_INJECT_KEYS.has(k))
        .map(([k, v]) => `${k}=${v}`)
        .join("&");
    }

    #sigData(captured) {
      const v = this.#buildSigValue(captured);
      return {
        value: v,
        updatedAt: captured && captured.__dyCaptureTime ? captured.__dyCaptureTime : 0,
        captured: !!(captured && captured.size > 0),
        webSign: !!(captured && captured.has("x-secsdk-web-signature")),
      };
    }

    collect() {
      const key = apiClient.getSecurityKey();
      return {
        key,
        keyUpdatedAt: key ? Date.now() : 0,
        signatures: {
          detail: this.#sigData(signatureCapture.detailQuery),
          following: this.#sigData(signatureCapture.followingQuery),
          profile: this.#sigData(signatureCapture.profileQuery),
          post: this.#sigData(signatureCapture.postQuery),
          favorite: this.#sigData(signatureCapture.favoriteQuery),
          collection: this.#sigData(signatureCapture.collectionQuery),
        },
        hooks: {
          fetch: !!window.__dyManagerFetchHooked,
          xhr: !!window.__dyManagerXhrHooked,
        },
      };
    }
  }
  const securityStatus = new SecurityStatus();

  // ---------- FetchHook ----------
  // 合并 saver 提取 + tools 签名缓存：hook window.fetch 与 XHR，捕获作品与签名。
  class FetchHook {
    #origFetch = window.fetch;

    install() {
      this.#installFetch();
      this.#installXHR();
    }

    #installFetch() {
      const self = this;
      window.fetch = function (...args) {
        const request = args[0];
        const url = typeof request === "string" ? request : request?.url;
        const options = args[1] || {};
        const isInternal = options._dyInternal === true;
        const parsedUrl =
          !isInternal && url && typeof url === "string" && url.startsWith("http") ? workExtractor.shouldCapture(url) : null;
        return self.#origFetch.apply(this, args).then((response) => {
          if (response.ok && parsedUrl) {
            try {
              signatureCapture.captureFromUrl(url, parsedUrl);
              response.clone().json().then((data) => {
                workExtractor.extractWorksFromResponse(url, data, parsedUrl).then((works) => {
                  workExtractor.dispatchWorks(works);
                }).catch(() => {});
              }).catch(() => {});
            } catch (e) {
              console.warn("[DY] capture works failed:", e);
            }
          } else if (response.ok && !isInternal && url && typeof url === "string" && url.startsWith("http")) {
            try {
              signatureCapture.captureFromUrl(url);
            } catch (_e) {}
          }
          return response;
        });
      };
      window.__dyManagerFetchHooked = true;
    }

    #installXHR() {
      if (window.__dyManagerXhrHooked) return;
      window.__dyManagerXhrHooked = true;
      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url) {
        this._dyUrl = typeof url === "string" ? url : (url && url.href) || "";
        return origOpen.apply(this, arguments);
      };
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function () {
        const self = this;
        this.addEventListener("load", function () {
          const u = self._dyUrl;
          if (u && u.includes("/aweme/")) signatureCapture.captureFromUrl(u);
        });
        return origSend.apply(this, arguments);
      };
    }
  }
  const fetchHook = new FetchHook();

  // ---------- ButtonInjector ----------
  // 按钮注入 (saver 现有)：播放器右侧保存按钮 + MutationObserver 兜底。
  class ButtonInjector {
    #observerTimer = null;

    #getReactFiber(el) {
      for (const key in el) {
        if (key.startsWith("__reactFiber$")) return el[key];
      }
      return null;
    }

    #searchAwemeInfoFromFiber(fiber) {
      function search(f) {
        if (!f) return null;
        if (f.memoizedProps?.awemeInfo) return f.memoizedProps.awemeInfo;
        if (f.memoizedState?.awemeInfo) return f.memoizedState.awemeInfo;
        if (f.return) return search(f.return);
        return null;
      }
      return search(fiber);
    }

    #getAwemeInfoFromButton(btn) {
      const parentFiber = this.#getReactFiber(btn.parentElement);
      if (parentFiber) {
        const info = this.#searchAwemeInfoFromFiber(parentFiber);
        if (info) return info;
      }

      const container = btn.closest(CONFIG.BUTTON.CONTAINER);
      if (container) {
        const containerFiber = this.#getReactFiber(container);
        if (containerFiber) {
          const info = this.#searchAwemeInfoFromFiber(containerFiber);
          if (info) return info;
        }
      }

      return null;
    }

    #createButton(className, svgContent, tooltipText) {
      const btn = document.createElement("xg-icon");
      btn.className = className;
      btn.innerHTML = `
        <div class="xgplayer-icon">
          <span role="img" class="semi-icon semi-icon-default">${svgContent}</span>
        </div>
        <div class="xg-tips">${tooltipText}</div>
      `;
      return btn;
    }

    #injectStyles() {
      if (document.getElementById("dy-saver-styles")) return;
      const style = document.createElement("style");
      style.id = "dy-saver-styles";
      style.textContent = `
        .basePlayerContainer .${CONFIG.BUTTON.CLASS_SAVE} {
          cursor: pointer;
          position: relative;
        }
        .basePlayerContainer .${CONFIG.BUTTON.CLASS_SAVE} .semi-icon {
          display: flex;
          justify-content: center;
          align-items: center;
        }
        .basePlayerContainer .${CONFIG.BUTTON.CLASS_SAVE} .xg-tips {
          left: auto;
          right: 0;
          transform: none;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    }

    #createSaveButton() {
      const btn = this.#createButton(
        CONFIG.BUTTON.CLASS_SAVE,
        `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 40 40" width="1em" height="1em" style="font-size:32px;">
          <path fill="currentColor" d="M26 4H6a2 2 0 0 0-2 2v20a2 2 0 0 0 2 2h20a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 22H6V6h20v20zm-4-11h-5v-5h-2v5h-5v2h5v5h2v-5h5v-2z"/>
        </svg>`,
        CONFIG.BUTTON.TEXT_SAVE,
      );
      btn.addEventListener("mouseenter", () => {
        const tips = btn.querySelector(".xg-tips");
        if (!tips) return;
        const awemeInfo = this.#getAwemeInfoFromButton(btn);
        if (!awemeInfo) {
          tips.textContent = CONFIG.BUTTON.TEXT_SAVE;
          return;
        }
        const fullWork = workExtractor.extractWorkFromRaw(awemeInfo, { fromFiber: true });
        if (!fullWork || !fullWork.awemeId) {
          tips.textContent = CONFIG.BUTTON.TEXT_SAVE;
          return;
        }
        const nickname = fullWork.nickname || "未知";
        const desc = (fullWork.desc || "").slice(0, CONFIG.TOOLTIP_DESC_MAX_LEN);
        tips.textContent = `@${nickname}${desc ? " · " + desc : ""}`;
      });
      btn.addEventListener("mouseleave", () => {
        const tips = btn.querySelector(".xg-tips");
        if (tips) tips.textContent = CONFIG.BUTTON.TEXT_SAVE;
      });
      return btn;
    }

    #onSaveButtonClick(btn, event) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const awemeInfo = this.#getAwemeInfoFromButton(btn);
      if (!awemeInfo) return;
      const fullWork = workExtractor.extractWorkFromRaw(awemeInfo, { fromFiber: true });
      document.dispatchEvent(new CustomEvent(CONFIG.EVENTS.BUTTON_CLICK, { detail: { fullWork } }));
    }

    #injectButtons() {
      const grids = document.querySelectorAll(`${CONFIG.BUTTON.GRID}:not(:has(.${CONFIG.BUTTON.CLASS_SAVE}))`);
      for (const grid of grids) {
        const saveBtn = this.#createSaveButton();
        saveBtn.addEventListener("click", (e) => this.#onSaveButtonClick(saveBtn, e));
        grid.prepend(saveBtn);
      }
    }

    start() {
      this.#injectStyles();
      this.#injectButtons();

      const observer = new MutationObserver((mutations) => {
        if (this.#observerTimer) return;
        const hasRelevant = mutations.some((m) =>
          [...m.addedNodes].some(
            (n) => n.nodeType === 1 && (n.matches?.(CONFIG.BUTTON.GRID) || n.querySelector?.(CONFIG.BUTTON.GRID)),
          ),
        );
        if (!hasRelevant) return;
        this.#observerTimer = setTimeout(() => {
          this.#observerTimer = null;
          this.#injectButtons();
        }, CONFIG.BUTTON.OBSERVER_DEBOUNCE);
      });

      observer.observe(document, { subtree: true, childList: true });
    }
  }
  const buttonInjector = new ButtonInjector();

  // ---------- EventRouter ----------
  // 请求事件路由：监听 content.js 转发的请求事件，派发结果事件。
  class EventRouter {
    constructor() {
      document.addEventListener(CONFIG.EVENTS.FETCH_SINGLE_WORK_REQUEST, (e) => this.#onFetchSingleWork(e));
      document.addEventListener(CONFIG.EVENTS.FETCH_DETAIL_REQUEST, (e) => this.#onFetchDetail(e));
      document.addEventListener(CONFIG.EVENTS.FETCH_WORKS_REQUEST, (e) => this.#onFetchWorks(e));
      document.addEventListener(CONFIG.EVENTS.FETCH_FOLLOWING_PAGE_REQUEST, (e) => this.#onFetchFollowing(e));
      document.addEventListener(CONFIG.EVENTS.FETCH_PROFILE_OTHER_REQUEST, (e) => this.#onFetchProfileOther(e));
      document.addEventListener(CONFIG.EVENTS.FETCH_FAVORITES_PAGE_REQUEST, (e) => this.#onFetchFavorites(e));
      document.addEventListener(CONFIG.EVENTS.FETCH_COLLECTION_PAGE_REQUEST, (e) => this.#onFetchCollection(e));
      document.addEventListener(CONFIG.EVENTS.CANCEL_ONE_LIKE_REQUEST, (e) => this.#onCancelOneLike(e));
      document.addEventListener(CONFIG.EVENTS.CANCEL_ONE_COLLECTION_REQUEST, (e) => this.#onCancelOneCollection(e));
      document.addEventListener("DY_GET_SECURITY_STATUS_REQUEST", (e) => this.#onGetSecurityStatus(e));
      document.addEventListener("DY_REQUEST_BROWSER_FEATURES", (e) => this.#onRequestBrowserFeatures(e));
    }

    #dispatchResult(eventName, detail) {
      document.dispatchEvent(new CustomEvent(eventName, { detail }));
    }

    // 带任务控制的请求包装（setActiveTask + try/catch/finally）。
    // asyncFn 接收 AbortController，成功后把 result 透传给结果事件。
    #wrapTask(requestId, eventName, asyncFn) {
      const controller = new AbortController();
      taskController.setActiveTask(() => controller.abort());
      return asyncFn(controller)
        .then((result) => this.#dispatchResult(eventName, { requestId, ...result }))
        .catch((e) => this.#dispatchResult(eventName, { requestId, ok: false, error: e.message }))
        .finally(() => taskController.setActiveTask(null));
    }

    // 不带任务控制的请求包装（FETCH_DETAIL / FETCH_WORKS 不走 setActiveTask）
    #wrapRequest(requestId, eventName, asyncFn) {
      return asyncFn()
        .then((result) => this.#dispatchResult(eventName, { requestId, ...result }))
        .catch((e) => this.#dispatchResult(eventName, { requestId, error: e.message }));
    }

    #onFetchSingleWork(e) {
      const { requestId, awemeId } = e.detail || {};
      if (!requestId || !awemeId) return;
      this.#wrapTask(requestId, CONFIG.EVENTS.FETCH_SINGLE_WORK_RESULT, (controller) =>
        apiClient.fetchOneDetail(awemeId, controller).then((work) => ({ work: work || null, ok: !!work })),
      );
    }

    #onFetchDetail(e) {
      const { awemeId, requestId } = e.detail || {};
      if (!awemeId || !requestId) return;
      this.#wrapRequest(requestId, CONFIG.EVENTS.FETCH_DETAIL_RESULT, () =>
        apiClient.fetchOneDetail(awemeId).then((work) => ({ work: work || null })),
      );
    }

    #onFetchWorks(e) {
      const detail = e.detail || {};
      if (!detail.requestId) return;
      this.#wrapRequest(detail.requestId, CONFIG.EVENTS.FETCH_WORKS_RESULT, async () => {
        const result = await apiClient.fetchAuthorWorks(detail.secUid, detail.maxCursor || 0, detail.count);
        return { works: result.works, hasMore: result.hasMore, maxCursor: result.maxCursor };
      });
    }

    #onFetchFollowing(e) {
      const { requestId, secUid, offset, count } = e.detail || {};
      if (!requestId || !secUid) return;
      const sigSource =
        signatureCapture.followingQuery ||
        signatureCapture.postQuery ||
        signatureCapture.favoriteQuery ||
        signatureCapture.collectionQuery;
      if (!sigSource) {
        this.#dispatchResult(CONFIG.EVENTS.FETCH_FOLLOWING_PAGE_RESULT, { requestId, ok: false, error: "NO_SIGNATURE" });
        return;
      }
      const realSecUid = secUid === "self" ? signatureCapture.resolveSelfSecUid() : secUid;
      if (!realSecUid) {
        this.#dispatchResult(CONFIG.EVENTS.FETCH_FOLLOWING_PAGE_RESULT, { requestId, ok: false, error: "NO_SIGNATURE" });
        return;
      }
      this.#wrapTask(requestId, CONFIG.EVENTS.FETCH_FOLLOWING_PAGE_RESULT, async (controller) => {
        const data = await apiClient.fetchFollowingPage(realSecUid, offset || 0, count, controller.signal);
        if (data.status_code !== undefined && data.status_code !== 0)
          throw new Error("API_ERROR: status_code=" + data.status_code);
        const items = (data.followings || []).map((item) => ({
          uid: String(item.uid || ""),
          nickname: item.nickname || "未知",
          avatarLarger: (item.avatar_larger && item.avatar_larger.url_list && item.avatar_larger.url_list[0]) || "",
          // 粉丝/作品数不再取自关注列表（滞后快照），字段占位为 0，仅由 profile/other 校准写入
          followerCount: 0,
          awemeCount: 0,
          profileUrl: "https://www.douyin.com/user/" + (item.sec_uid || ""),
        }));
        const hasMore = data.has_more === true || data.has_more === 1 || data.has_more === "1";
        return {
          ok: true,
          items,
          hasMore,
          cursor: (offset || 0) + count,
          total: data.total,
        };
      });
    }

    #onFetchProfileOther(e) {
      const { requestId, secUid } = e.detail || {};
      if (!requestId || !secUid) return;
      const sigSource =
        signatureCapture.profileQuery ||
        signatureCapture.followingQuery ||
        signatureCapture.postQuery ||
        signatureCapture.favoriteQuery ||
        signatureCapture.collectionQuery;
      if (!sigSource) {
        this.#dispatchResult(CONFIG.EVENTS.FETCH_PROFILE_OTHER_RESULT, { requestId, ok: false, error: "NO_SIGNATURE" });
        return;
      }
      this.#wrapTask(requestId, CONFIG.EVENTS.FETCH_PROFILE_OTHER_RESULT, async (controller) => {
        const data = await apiClient.fetchProfileOther(secUid, controller.signal);
        if (data.status_code !== undefined && data.status_code !== 0)
          throw new Error("API_ERROR: status_code=" + data.status_code);
        const user = data.user || {};
        return { ok: true, awemeCount: user.aweme_count || 0, followerCount: user.follower_count || 0 };
      });
    }

    #onFetchFavorites(e) {
      const { requestId, secUid, cursor, count } = e.detail || {};
      if (!requestId || !secUid) return;
      if (!signatureCapture.favoriteQuery) {
        this.#dispatchResult(CONFIG.EVENTS.FETCH_FAVORITES_PAGE_RESULT, { requestId, ok: false, error: "NO_SIGNATURE" });
        return;
      }
      const realSecUid = secUid === "self" ? signatureCapture.resolveSelfSecUid() : secUid;
      if (!realSecUid) {
        this.#dispatchResult(CONFIG.EVENTS.FETCH_FAVORITES_PAGE_RESULT, { requestId, ok: false, error: "NO_SIGNATURE" });
        return;
      }
      this.#wrapTask(requestId, CONFIG.EVENTS.FETCH_FAVORITES_PAGE_RESULT, (controller) =>
        apiClient.fetchOneFavoritesPage(realSecUid, cursor || 0, count, controller.signal),
      );
    }

    #onFetchCollection(e) {
      const { requestId, cursor, count } = e.detail || {};
      if (!requestId) return;
      if (!signatureCapture.collectionQuery) {
        this.#dispatchResult(CONFIG.EVENTS.FETCH_COLLECTION_PAGE_RESULT, { requestId, ok: false, error: "NO_SIGNATURE" });
        return;
      }
      this.#wrapTask(requestId, CONFIG.EVENTS.FETCH_COLLECTION_PAGE_RESULT, (controller) =>
        apiClient.fetchOneCollectionPage(cursor || 0, count, controller.signal),
      );
    }

    #onCancelOneLike(e) {
      const { requestId, awemeId } = e.detail || {};
      if (!requestId || !awemeId) return;
      this.#wrapTask(requestId, CONFIG.EVENTS.CANCEL_ONE_LIKE_RESULT, (controller) =>
        cancelHandler.cancelOneLike(awemeId, controller.signal).then(() => ({ ok: true })),
      );
    }

    #onCancelOneCollection(e) {
      const { requestId, awemeId } = e.detail || {};
      if (!requestId || !awemeId) return;
      this.#wrapTask(requestId, CONFIG.EVENTS.CANCEL_ONE_COLLECTION_RESULT, (controller) =>
        cancelHandler.cancelOneCollection(awemeId, controller.signal).then(() => ({ ok: true })),
      );
    }

    #onGetSecurityStatus(e) {
      const { requestId } = e.detail || {};
      this.#dispatchResult("DY_GET_SECURITY_STATUS_RESULT", { requestId, status: securityStatus.collect() });
    }

    #onRequestBrowserFeatures(e) {
      const features = apiClient.collectBrowserFeatures();
      this.#dispatchResult("DY_CAPTURE_BROWSER_FEATURES_REFRESH", { features, requestId: e.detail?.requestId });
    }
  }
  const eventRouter = new EventRouter();

  // ---------- 启动 ----------
  fetchHook.install();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      document.dispatchEvent(
        new CustomEvent(CONFIG.EVENTS.CAPTURE_BROWSER_FEATURES, { detail: apiClient.collectBrowserFeatures() }),
      );
      buttonInjector.start();
    });
  } else {
    document.dispatchEvent(
      new CustomEvent(CONFIG.EVENTS.CAPTURE_BROWSER_FEATURES, { detail: apiClient.collectBrowserFeatures() }),
    );
    buttonInjector.start();
  }
})();
