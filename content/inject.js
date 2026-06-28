(function () {
  "use strict";

  const CONFIG = {
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
      "/aweme/v1/web/aweme/listcollection/",
    ],
    API: {
      FOLLOWING: "/aweme/v1/web/user/following/list",
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
      version_code: "190500",
      version_name: "19.5.0",
      cookie_enabled: "true",
      platform: "PC",
      publish_video_strategy_type: "2",
    },
    TIMEOUT: {
      FETCH_PAGE: 15000,
      FETCH_DETAIL: 8000,
    },

    PAGE: {
      FAVORITE: 20,
      COLLECTION: 20,
      AUTHOR: 20,
      FOLLOWING: 20,
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
    },
  };

  let __lastCapturedDetailQuery = null;
  let __capturedFollowingQuery = null;
  let __capturedPostQuery = null;
  let __capturedCollectionQuery = null;
  let __capturedFavoriteQuery = null;

  // ===== 签名缓存 =====

  function captureFromUrl(url, parsedUrl) {
    try {
      if (typeof url !== "string" || !url.startsWith("http")) return;
      const u = parsedUrl || new URL(url);
      const params = new Map();
      for (const entry of u.searchParams.entries()) params.set(entry[0], entry[1]);
      params.__dyCaptureTime = Date.now();
      if (u.pathname.includes(CONFIG.API.FOLLOWING)) {
        __capturedFollowingQuery = params;
      }
      if (u.pathname.includes(CONFIG.API.POST)) {
        __capturedPostQuery = params;
      }
      if (u.pathname.includes(CONFIG.API.COLLECTION)) {
        __capturedCollectionQuery = params;
      }
      if (u.pathname.includes(CONFIG.API.FAVORITE)) {
        __capturedFavoriteQuery = params;
      }
      if (u.pathname.includes(CONFIG.API.DETAIL)) {
        __lastCapturedDetailQuery = params;
      }
    } catch (_e) {}
  }

  function buildUrl(pathname, params) {
    const url = new URL(pathname, window.location.origin);
    for (const key in params) {
      url.searchParams.set(key, String(params[key]));
    }
    return url;
  }

  function mergeParams(url, captured) {
    if (!captured) return url;
    for (const entry of captured.entries()) {
      const k = entry[0],
        v = entry[1];
      if (!url.searchParams.has(k)) url.searchParams.set(k, v);
    }
    return url;
  }

  const PAGE_KEYS = new Set(["cursor", "max_cursor", "min_cursor", "offset", "count"]);
  function stripPageKeys(captured) {
    if (!captured) return null;
    const out = new Map();
    for (const [k, v] of captured) {
      if (!PAGE_KEYS.has(k) && !k.startsWith("cursor") && !k.startsWith("max_") && !k.startsWith("min_")) out.set(k, v);
    }
    return out;
  }

  // ===== 共享工具函数 =====

  function transformAwemeItem(aw, { includeAuthorFollowed = false } = {}) {
    const work = normalizeWork(aw, "api");
    if (!work) return null;
    if (includeAuthorFollowed) {
      work.authorFollowed = extractAuthorFollowed(aw);
    }
    return work;
  }

  async function fetchOneFavoritesPage(secUid, cursor, signal) {
    const url = buildUrl(
      CONFIG.API.FAVORITE,
      Object.assign({}, CONFIG.DEVICE_PARAMS, {
        sec_user_id: secUid,
        count: String(CONFIG.PAGE.FAVORITE),
        max_cursor: String(cursor),
      }),
    );
    const merged = mergeParams(
      url,
      stripPageKeys(__capturedFavoriteQuery),
    );
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort();
      else
        signal.addEventListener("abort", () => controller.abort(), {
          once: true,
        });
    }
    const tid = setTimeout(() => controller.abort(), CONFIG.TIMEOUT.FETCH_PAGE);
    try {
      const resp = await window.fetch(merged.toString(), {
        credentials: "include",
        headers: { Referer: window.location.origin + "/" },
        method: "GET",
        signal: controller.signal,
        _dyInternal: true,
      });
      clearTimeout(tid);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      if (data.status_code !== undefined && data.status_code !== 0) throw new Error("API_ERROR");
      const items = (data.aweme_list || []).map((aw) => transformAwemeItem(aw, { includeAuthorFollowed: true }));
      const hasMore = data.has_more === true || data.has_more === 1 || data.has_more === "1";
      const nextCursor = data.cursor || data.max_cursor || cursor + CONFIG.PAGE.FAVORITE;
      return {
        items,
        hasMore,
        cursor: nextCursor,
        total: data.total,
        ok: true,
      };
    } catch (e) {
      clearTimeout(tid);
      throw e;
    }
  }

  async function fetchOneCollectionPage(cursor, signal) {
    const url = buildUrl(
      CONFIG.API.COLLECTION,
      Object.assign({}, CONFIG.DEVICE_PARAMS, {
        count: String(CONFIG.PAGE.COLLECTION),
        cursor: String(cursor),
      }),
    );
    const merged = mergeParams(
      url,
      stripPageKeys(__capturedCollectionQuery),
    );
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort();
      else
        signal.addEventListener("abort", () => controller.abort(), {
          once: true,
        });
    }
    const tid = setTimeout(() => controller.abort(), CONFIG.TIMEOUT.FETCH_PAGE);
    try {
      const resp = await window.fetch(merged.toString(), {
        credentials: "include",
        headers: {
          Referer: window.location.origin + "/",
          "content-type": CONFIG.COLLECTION_CONTENT_TYPE,
        },
        method: "POST",
        signal: controller.signal,
        _dyInternal: true,
      });
      clearTimeout(tid);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      if (data.status_code !== undefined && data.status_code !== 0) throw new Error("API_ERROR");
      const items = (data.aweme_list || []).map((aw) => transformAwemeItem(aw, { includeAuthorFollowed: true }));
      const hasMore = data.has_more === true || data.has_more === 1;
      const nextCursor = data.cursor || data.max_cursor || cursor + CONFIG.PAGE.COLLECTION;
      return {
        items,
        hasMore,
        cursor: nextCursor,
        total: data.total,
        ok: true,
      };
    } catch (e) {
      clearTimeout(tid);
      throw e;
    }
  }

  // ===== 作品提取 (saver 现有) =====

  function buildAuthorHomeUrl(author) {
    const secUid = author?.secUid || author?.sec_uid || "";
    return secUid ? `https://www.douyin.com/user/${secUid}` : "";
  }

  function normalizeProtocol(url) {
    return url && url.startsWith("http:") ? url.replace("http:", "") : url || "";
  }

  function extractVideo(raw, source) {
    const video = raw.video || {};
    const bitRateList = source === "fiber" ? video.bitRateList || video.bit_rate : video.bit_rate;

    if (!Array.isArray(bitRateList) || bitRateList.length === 0) {
      return normalizeProtocol(video.play_addr?.url_list?.[0] || "");
    }

    const videoBitRates = [];
    for (const item of bitRateList) {
      const gear = (item.gearName || item.gear_name || "").toLowerCase();
      if (source === "fiber") {
        if (gear.includes("智能") || gear.includes("smart") || gear.includes("adapt")) continue;
      }
      if (item.isH265 || item.is_h265) continue;

      const playAddr = item.play_addr || {};
      const urlList = Array.isArray(playAddr.url_list) ? playAddr.url_list : [];
      const mainUrl = item.playApi || (source === "fiber" ? "" : urlList.filter(Boolean)[0]) || "";
      if (!mainUrl) continue;

      videoBitRates.push({
        url: mainUrl,
        width: playAddr.width || item.width || 0,
        height: playAddr.height || item.height || 0,
        fps: item.FPS || 0,
        dataSize: playAddr.data_size || 0,
      });
    }

    if (source === "fiber") {
      videoBitRates.sort((a, b) => (b.height || 0) - (a.height || 0));
      videoBitRates.splice(1);
    } else {
      const unique = new Map();
      for (const item of videoBitRates) {
        const key = `${item.width}:${item.height}:${item.fps}`;
        const existing = unique.get(key);
        if (!existing || (item.dataSize || 0) > (existing.dataSize || 0)) {
          unique.set(key, item);
        }
      }
      videoBitRates.length = 0;
      videoBitRates.push(...unique.values());
      if (videoBitRates.length === 0) {
        const first = bitRateList[0];
        if (first && !first.is_h265) {
          const pa = first.play_addr || {};
          const ul = Array.isArray(pa.url_list) ? pa.url_list : [];
          const mu = ul.filter(Boolean)[0] || "";
          if (mu) {
            videoBitRates.push({
              url: mu,
              width: pa.width || 0,
              height: pa.height || 0,
              fps: first.FPS || 0,
              dataSize: pa.data_size || 0,
            });
          }
        }
      }
    }

    if (videoBitRates.length > 0) {
      const best = videoBitRates.reduce((a, b) => ((a.height || 0) >= (b.height || 0) ? a : b));
      return normalizeProtocol(best.url);
    }

    return "";
  }

  function extractCover(raw) {
    const video = raw.video || {};
    const images = extractImages(raw);
    const isNote = (raw.awemeType || raw.aweme_type) === CONFIG.AWEME_TYPE_NOTE;
    if (isNote && images.length > 0) return images[0];
    return normalizeProtocol(video.cover?.url_list?.[0] || video.coverUrlList?.[0] || "");
  }

  function extractImages(raw) {
    const imgList = raw.images;
    if (!Array.isArray(imgList)) return [];
    const images = [];
    for (const img of imgList) {
      const urlList = img.urlList || img.url_list || [];
      const imgUrl = urlList[0] || "";
      if (imgUrl) images.push(normalizeProtocol(imgUrl));
    }
    return images;
  }

  function extractMusic(raw) {
    const music = raw.music || {};
    return music.playUrl?.uri || music.play_url?.uri || "";
  }

  function extractAuthor(raw) {
    return raw.authorInfo || raw.author || {};
  }

  function extractAuthorFollowed(raw) {
    const author = extractAuthor(raw);
    if (!("follow_status" in author) && !("followStatus" in author)) return null;
    const followRaw = author.follow_status ?? author.followStatus;
    return followRaw === 1 || followRaw === 2;
  }

  function normalizeWork(raw, source) {
    if (!raw) return null;
    const awemeId = String(raw.aweme_id || raw.awemeId || "");
    if (!awemeId) return null;

    const author = extractAuthor(raw);
    const isNote = (raw.awemeType || raw.aweme_type) === CONFIG.AWEME_TYPE_NOTE;

    return {
      awemeId,
      type: isNote ? "note" : "video",
      desc: raw.desc || "",
      nickname: String(author.nickname || author.nickName || ""),
      uid: String(author.uid || ""),
      authorHomeUrl: buildAuthorHomeUrl(author),
      cover: extractCover(raw),
      video: extractVideo(raw, source),
      images: extractImages(raw),
      music: extractMusic(raw),
      createTime: raw.create_time || 0,
      statistics: raw.statistics || {},
    };
  }

  function extractWorkFromRaw(awemeData, { fromFiber } = {}) {
    return normalizeWork(awemeData, fromFiber ? "fiber" : "api");
  }

  async function extractWorksFromResponse(url, data, parsedUrl) {
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

    return list.map((item) => extractWorkFromRaw(item, { fromFiber: false })).filter(Boolean);
  }

  function shouldCapture(url) {
    try {
      const u = new URL(url);
      if (CONFIG.API_PATTERNS.some((p) => u.pathname.startsWith(p))) return u;
      return null;
    } catch {
      return null;
    }
  }

  function dispatchWorks(works) {
    if (works.length === 0) return;
    document.dispatchEvent(new CustomEvent(CONFIG.EVENTS.CAPTURE_WORKS, { detail: works }));
  }

  // ===== Fetch Hook (合并 saver 提取 + tools 签名缓存) =====

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const request = args[0];
    const url = typeof request === "string" ? request : request?.url;
    const options = args[1] || {};
    const isInternal = options._dyInternal === true;
    const parsedUrl = !isInternal && url && typeof url === "string" && url.startsWith("http") ? shouldCapture(url) : null;
    return origFetch.apply(this, args).then(async (response) => {
      if (response.ok && parsedUrl) {
        try {
          captureFromUrl(url, parsedUrl);
          const data = await response.clone().json();
          const works = await extractWorksFromResponse(url, data, parsedUrl);
          dispatchWorks(works);
        } catch (e) {
          console.warn("[DY] capture works failed:", e);
        }
      } else if (response.ok && !isInternal && url && typeof url === "string" && url.startsWith("http")) {
        try {
          captureFromUrl(url);
        } catch (_e) {}
      }
      return response;
    });
  };
  window.__dyManagerFetchHooked = true;

  // ===== XHR Hook (tools 移植) =====

  (function hookXHR() {
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
        if (u && u.includes("/aweme/")) captureFromUrl(u);
      });
      return origSend.apply(this, arguments);
    };
  })();

  // ===== 详情拉取 (saver 现有) =====

  function getDetailBrowserParams() {
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

  async function fetchOneDetail(awemeId, externalController) {
    const url = new URL(CONFIG.API.DETAIL, window.location.origin);
    url.searchParams.set("aweme_id", String(awemeId));
    for (const [k, v] of Object.entries(CONFIG.DEVICE_PARAMS)) url.searchParams.set(k, v);
    for (const [k, v] of Object.entries(getDetailBrowserParams())) url.searchParams.set(k, String(v));

    if (__lastCapturedDetailQuery) {
      for (const [k, v] of __lastCapturedDetailQuery.entries()) {
        if (k === "aweme_id") continue;
        if (!url.searchParams.has(k)) url.searchParams.set(k, v);
      }
    }

    const controller = externalController || new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.TIMEOUT.FETCH_DETAIL);
    try {
      const resp = await window.fetch(url.toString(), {
        credentials: "include",
        headers: { Referer: window.location.origin + "/" },
        method: "GET",
        signal: controller.signal,
        _dyInternal: true,
      });
      clearTimeout(timeoutId);
      const text = await resp.text();
      if (!text || !text.trim()) {
        throw new Error("RATE_LIMITED");
      }
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = JSON.parse(text);
      if (data && data.status_code !== undefined && data.status_code !== 0) {
        throw new Error("status_code=" + data.status_code);
      }
      const list = await extractWorksFromResponse(url.toString(), data);
      return list[0] || null;
    } catch (e) {
      clearTimeout(timeoutId);
      if (e && e.name === "AbortError") throw new Error("CANCELLED");
      throw e;
    }
  }

  // ===== 后台任务取消支持 =====

  let activeTask = null;

  function setActiveTask(abort) {
    activeTask?.abort();
    activeTask = abort ? { abort } : null;
  }

  document.addEventListener("DY_CANCEL_ACTIVE_TASK", () => {
    if (activeTask) {
      activeTask.abort();
      activeTask = null;
    }
  });

  // ===== 关注列表拉取 (tools 移植) =====

  function getSecurityKey() {
    try {
      const raw = localStorage.getItem(CONFIG.SECURITY_KEY) || "{}";
      return (JSON.parse(raw).data || "").replace(/^pub\./, "");
    } catch (e) {
      return "";
    }
  }

  async function fetchFollowingPage(secUid, offset, count, externalSignal) {
    const url = buildUrl(
      CONFIG.API.FOLLOWING,
      Object.assign({}, CONFIG.DEVICE_PARAMS, {
        sec_user_id: secUid,
        offset: String(offset),
        count: String(count),
      }),
    );
    const merged = mergeParams(
      url,
      __capturedFollowingQuery,
    );
    const controller = new AbortController();
    // 关键修复:支持外部 abort 信号,关闭弹窗时可立即取消正在进行的 fetch
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else
        externalSignal.addEventListener("abort", () => controller.abort(), {
          once: true,
        });
    }
    const tid = setTimeout(() => controller.abort(), CONFIG.TIMEOUT.FETCH_PAGE);
    try {
      const resp = await window.fetch(merged.toString(), {
        credentials: "include",
        headers: { Referer: window.location.origin + "/" },
        method: "GET",
        signal: controller.signal,
        _dyInternal: true,
      });
      clearTimeout(tid);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      return await resp.json();
    } catch (e) {
      clearTimeout(tid);
      throw e;
    }
  }

  // ===== 作者作品拉取 (tools 移植, 侧边栏用) =====

  async function fetchAuthorWorks(secUid, startCursor) {
    const count = CONFIG.PAGE.AUTHOR;
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), CONFIG.TIMEOUT.FETCH_PAGE);
    try {
      const url = buildUrl(
        CONFIG.API.POST,
        Object.assign({}, CONFIG.DEVICE_PARAMS, {
          sec_user_id: secUid,
          max_cursor: String(startCursor || 0),
          count: String(count),
        }),
      );
      const merged = mergeParams(url, __capturedPostQuery);
      const resp = await window.fetch(merged.toString(), {
        credentials: "include",
        headers: { Referer: window.location.origin + "/" },
        method: "GET",
        signal: controller.signal,
        _dyInternal: true,
      });
      clearTimeout(tid);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      if (data.status_code !== undefined && data.status_code !== 0) throw new Error("API_ERROR");

      const works = (data.aweme_list || []).map((aw) => transformAwemeItem(aw));
      const hasMore = data.has_more === true || data.has_more === 1;
      return {
        works,
        hasMore,
        maxCursor: data.max_cursor || (startCursor || 0) + count,
      };
    } catch (e) {
      clearTimeout(tid);
      throw e;
    }
  }

  // ===== 取消点赞/收藏 (tools 移植) =====

  function cancelOne(awemeId, url, bodyFn, referrer, signal) {
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
      const key = getSecurityKey();
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

  function cancelOneLike(awemeId, signal) {
    return cancelOne(awemeId, CONFIG.CANCEL.LIKE_URL, CONFIG.CANCEL.LIKE_BODY, CONFIG.CANCEL.LIKE_REFERRER, signal);
  }

  function cancelOneCollection(awemeId, signal) {
    return cancelOne(
      awemeId,
      CONFIG.CANCEL.COLLECTION_URL,
      CONFIG.CANCEL.COLLECTION_BODY,
      CONFIG.CANCEL.COLLECTION_REFERRER,
      signal,
    );
  }

  // ===== 事件监听 =====

  document.addEventListener(CONFIG.EVENTS.FETCH_SINGLE_WORK_REQUEST, async (event) => {
    const { requestId, awemeId } = event.detail || {};
    if (!requestId || !awemeId) return;
    const controller = new AbortController();
    setActiveTask(() => controller.abort());
    try {
      const work = await fetchOneDetail(awemeId, controller);
      document.dispatchEvent(
        new CustomEvent(CONFIG.EVENTS.FETCH_SINGLE_WORK_RESULT, {
          detail: { requestId, work: work || null, ok: !!work },
        }),
      );
    } catch (e) {
      document.dispatchEvent(
        new CustomEvent(CONFIG.EVENTS.FETCH_SINGLE_WORK_RESULT, {
          detail: { requestId, ok: false, error: e.message },
        }),
      );
    } finally {
      setActiveTask(null);
    }
  });

  document.addEventListener(CONFIG.EVENTS.FETCH_DETAIL_REQUEST, async (event) => {
    const { awemeId, requestId } = event.detail || {};
    if (!awemeId || !requestId) return;
    try {
      const work = await fetchOneDetail(awemeId);
      document.dispatchEvent(
        new CustomEvent(CONFIG.EVENTS.FETCH_DETAIL_RESULT, {
          detail: { requestId, work: work || null },
        }),
      );
    } catch (e) {
      document.dispatchEvent(
        new CustomEvent(CONFIG.EVENTS.FETCH_DETAIL_RESULT, {
          detail: { requestId, work: null, error: e.message },
        }),
      );
    }
  });

  document.addEventListener(CONFIG.EVENTS.FETCH_WORKS_REQUEST, async function (event) {
    const detail = event.detail || {};
    if (!detail.requestId) return;
    try {
      const result = await fetchAuthorWorks(detail.secUid, detail.maxCursor || 0);
      document.dispatchEvent(
        new CustomEvent(CONFIG.EVENTS.FETCH_WORKS_RESULT, {
          detail: {
            requestId: detail.requestId,
            works: result.works,
            hasMore: result.hasMore,
            maxCursor: result.maxCursor,
          },
        }),
      );
    } catch (e) {
      document.dispatchEvent(
        new CustomEvent(CONFIG.EVENTS.FETCH_WORKS_RESULT, {
          detail: {
            requestId: detail.requestId,
            works: [],
            hasMore: false,
            error: e.message,
          },
        }),
      );
    }
  });

  document.addEventListener(CONFIG.EVENTS.FETCH_FOLLOWING_PAGE_REQUEST, async (event) => {
    const { requestId, secUid, offset } = event.detail || {};
    if (!requestId || !secUid) return;
    const sigSource =
      __capturedFollowingQuery || __capturedPostQuery || __capturedFavoriteQuery || __capturedCollectionQuery;
    if (!sigSource) {
      document.dispatchEvent(
        new CustomEvent(CONFIG.EVENTS.FETCH_FOLLOWING_PAGE_RESULT, {
          detail: { requestId, ok: false, error: "NO_SIGNATURE" },
        }),
      );
      return;
    }
    const controller = new AbortController();
    setActiveTask(() => controller.abort());
    try {
      const data = await fetchFollowingPage(secUid, offset || 0, CONFIG.PAGE.FOLLOWING, controller.signal);
      if (data.status_code !== undefined && data.status_code !== 0)
        throw new Error("API_ERROR: status_code=" + data.status_code);
      const items = (data.followings || []).map((item) => ({
        uid: String(item.uid || ""),
        nickname: item.nickname || "未知",
        avatarLarger: (item.avatar_larger && item.avatar_larger.url_list && item.avatar_larger.url_list[0]) || "",
        followerCount: item.follower_count || 0,
        profileUrl: "https://www.douyin.com/user/" + (item.sec_uid || ""),
      }));
      const hasMore = data.has_more === true || data.has_more === 1;
      document.dispatchEvent(
        new CustomEvent(CONFIG.EVENTS.FETCH_FOLLOWING_PAGE_RESULT, {
          detail: {
            requestId,
            ok: true,
            items,
            hasMore,
            cursor: (offset || 0) + CONFIG.PAGE.FOLLOWING,
            total: data.total,
          },
        }),
      );
    } catch (e) {
      document.dispatchEvent(
        new CustomEvent(CONFIG.EVENTS.FETCH_FOLLOWING_PAGE_RESULT, {
          detail: { requestId, ok: false, error: e.message },
        }),
      );
    } finally {
      setActiveTask(null);
    }
  });

  document.addEventListener(CONFIG.EVENTS.FETCH_FAVORITES_PAGE_REQUEST, async (event) => {
    const { requestId, secUid, cursor } = event.detail || {};
    if (!requestId || !secUid) return;
    const controller = new AbortController();
    setActiveTask(() => controller.abort());
    try {
      const result = await fetchOneFavoritesPage(secUid, cursor || 0, controller.signal);
      document.dispatchEvent(
        new CustomEvent(CONFIG.EVENTS.FETCH_FAVORITES_PAGE_RESULT, {
          detail: { requestId, ...result },
        }),
      );
    } catch (e) {
      document.dispatchEvent(
        new CustomEvent(CONFIG.EVENTS.FETCH_FAVORITES_PAGE_RESULT, {
          detail: { requestId, ok: false, error: e.message },
        }),
      );
    } finally {
      setActiveTask(null);
    }
  });

  document.addEventListener(CONFIG.EVENTS.FETCH_COLLECTION_PAGE_REQUEST, async (event) => {
    const { requestId, cursor } = event.detail || {};
    if (!requestId) return;
    const controller = new AbortController();
    setActiveTask(() => controller.abort());
    try {
      const result = await fetchOneCollectionPage(cursor || 0, controller.signal);
      document.dispatchEvent(
        new CustomEvent(CONFIG.EVENTS.FETCH_COLLECTION_PAGE_RESULT, {
          detail: { requestId, ...result },
        }),
      );
    } catch (e) {
      document.dispatchEvent(
        new CustomEvent(CONFIG.EVENTS.FETCH_COLLECTION_PAGE_RESULT, {
          detail: { requestId, ok: false, error: e.message },
        }),
      );
    } finally {
      setActiveTask(null);
    }
  });

  document.addEventListener(CONFIG.EVENTS.CANCEL_ONE_LIKE_REQUEST, async (event) => {
    const { requestId, awemeId } = event.detail || {};
    if (!requestId || !awemeId) return;
    const controller = new AbortController();
    setActiveTask(() => controller.abort());
    try {
      await cancelOneLike(awemeId, controller.signal);
      document.dispatchEvent(
        new CustomEvent(CONFIG.EVENTS.CANCEL_ONE_LIKE_RESULT, {
          detail: { requestId, ok: true },
        }),
      );
    } catch (e) {
      document.dispatchEvent(
        new CustomEvent(CONFIG.EVENTS.CANCEL_ONE_LIKE_RESULT, {
          detail: { requestId, ok: false, error: e.message },
        }),
      );
    } finally {
      setActiveTask(null);
    }
  });

  document.addEventListener(CONFIG.EVENTS.CANCEL_ONE_COLLECTION_REQUEST, async (event) => {
    const { requestId, awemeId } = event.detail || {};
    if (!requestId || !awemeId) return;
    const controller = new AbortController();
    setActiveTask(() => controller.abort());
    try {
      await cancelOneCollection(awemeId, controller.signal);
      document.dispatchEvent(
        new CustomEvent(CONFIG.EVENTS.CANCEL_ONE_COLLECTION_RESULT, {
          detail: { requestId, ok: true },
        }),
      );
    } catch (e) {
      document.dispatchEvent(
        new CustomEvent(CONFIG.EVENTS.CANCEL_ONE_COLLECTION_RESULT, {
          detail: { requestId, ok: false, error: e.message },
        }),
      );
    } finally {
      setActiveTask(null);
    }
  });

  // ===== 安全状态查询 =====

  function collectSecurityStatus() {
    function buildSigValue(captured) {
      if (!captured || captured.size === 0) return "";
      return Array.from(captured.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join("&");
    }
    function sigData(captured) {
      const v = buildSigValue(captured);
      return {
        value: v,
        updatedAt: v && captured.__dyCaptureTime ? captured.__dyCaptureTime : 0,
      };
    }

    const key = getSecurityKey();
    return {
      key,
      keyUpdatedAt: key ? Date.now() : 0,
      signatures: {
        detail: sigData(__lastCapturedDetailQuery),
        following: sigData(__capturedFollowingQuery),
        post: sigData(__capturedPostQuery),
        favorite: sigData(__capturedFavoriteQuery),
        collection: sigData(__capturedCollectionQuery),
      },
      hooks: {
        fetch: !!window.__dyManagerFetchHooked,
        xhr: !!window.__dyManagerXhrHooked,
      },
    };
  }

  document.addEventListener("DY_GET_SECURITY_STATUS_REQUEST", function (event) {
    const detail = event.detail || {};
    const status = collectSecurityStatus();
    document.dispatchEvent(
      new CustomEvent("DY_GET_SECURITY_STATUS_RESULT", {
        detail: { requestId: detail.requestId, status },
      }),
    );
  });

  // ===== 按钮注入 (saver 现有) =====

  function getReactFiber(el) {
    for (const key in el) {
      if (key.startsWith("__reactFiber$")) return el[key];
    }
    return null;
  }

  function searchAwemeInfoFromFiber(fiber) {
    function search(f) {
      if (!f) return null;
      if (f.memoizedProps?.awemeInfo) return f.memoizedProps.awemeInfo;
      if (f.memoizedState?.awemeInfo) return f.memoizedState.awemeInfo;
      if (f.return) return search(f.return);
      return null;
    }
    return search(fiber);
  }

  function getAwemeInfoFromButton(btn) {
    const parentFiber = getReactFiber(btn.parentElement);
    if (parentFiber) {
      const info = searchAwemeInfoFromFiber(parentFiber);
      if (info) return info;
    }

    const container = btn.closest(CONFIG.BUTTON.CONTAINER);
    if (container) {
      const containerFiber = getReactFiber(container);
      if (containerFiber) {
        const info = searchAwemeInfoFromFiber(containerFiber);
        if (info) return info;
      }
    }

    return null;
  }

  const SAVE_BTN_CLASS = CONFIG.BUTTON.CLASS_SAVE;

  function createButton(className, svgContent, tooltipText) {
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

  function injectStyles() {
    if (document.getElementById("dy-saver-styles")) return;
    const style = document.createElement("style");
    style.id = "dy-saver-styles";
    style.textContent = `
      .basePlayerContainer .${SAVE_BTN_CLASS} {
        cursor: pointer;
        position: relative;
      }
      .basePlayerContainer .${SAVE_BTN_CLASS} .semi-icon {
        display: flex;
        justify-content: center;
        align-items: center;
      }
      .basePlayerContainer .${SAVE_BTN_CLASS} .xg-tips {
        left: auto;
        right: 0;
        transform: none;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function createSaveButton() {
    const btn = createButton(
      SAVE_BTN_CLASS,
      `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 40 40" width="1em" height="1em" style="font-size:32px;">
        <path fill="currentColor" d="M26 4H6a2 2 0 0 0-2 2v20a2 2 0 0 0 2 2h20a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 22H6V6h20v20zm-4-11h-5v-5h-2v5h-5v2h5v5h2v-5h5v-2z"/>
      </svg>`,
      CONFIG.BUTTON.TEXT_SAVE,
    );
    btn.addEventListener("mouseenter", () => {
      const tips = btn.querySelector(".xg-tips");
      if (!tips) return;
      const awemeInfo = getAwemeInfoFromButton(btn);
      if (!awemeInfo) {
        tips.textContent = CONFIG.BUTTON.TEXT_SAVE;
        return;
      }
      const fullWork = extractWorkFromRaw(awemeInfo, { fromFiber: true });
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

  function onSaveButtonClick(btn, event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const awemeInfo = getAwemeInfoFromButton(btn);
    if (!awemeInfo) return;
    const fullWork = extractWorkFromRaw(awemeInfo, { fromFiber: true });
    document.dispatchEvent(new CustomEvent(CONFIG.EVENTS.BUTTON_CLICK, { detail: { fullWork } }));
  }

  let observerTimer = null;

  function injectButtons() {
    const grids = document.querySelectorAll(`${CONFIG.BUTTON.GRID}:not(:has(.${SAVE_BTN_CLASS}))`);
    for (const grid of grids) {
      const saveBtn = createSaveButton();
      saveBtn.addEventListener("click", (e) => onSaveButtonClick(saveBtn, e));
      grid.prepend(saveBtn);
    }
  }

  function startObserver() {
    injectStyles();
    injectButtons();

    const observer = new MutationObserver((mutations) => {
      if (observerTimer) return;
      const hasRelevant = mutations.some((m) =>
        [...m.addedNodes].some(
          (n) => n.nodeType === 1 && (n.matches?.(CONFIG.BUTTON.GRID) || n.querySelector?.(CONFIG.BUTTON.GRID)),
        ),
      );
      if (!hasRelevant) return;
      observerTimer = setTimeout(() => {
        observerTimer = null;
        injectButtons();
      }, CONFIG.BUTTON.OBSERVER_DEBOUNCE);
    });

    observer.observe(document, { subtree: true, childList: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserver);
  } else {
    startObserver();
  }
})();
