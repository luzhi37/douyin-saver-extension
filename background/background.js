import { storage } from "./storage.js";
import {
  ABogus,
  getVerifyFp,
  parseCookieToPairs,
  generateRandomMsToken,
} from "./crypto.js";

// ===== 抖音数据管理 - Background Service Worker =====

const CONFIG = {
  STORAGE_KEYS: {
    WORKS: "works",
    WORKS_GROUPS: "works_groups",
    FOLLOWINGS: "followings",
    FOLLOWINGS_GROUPS: "followings_groups",
  },
  DEFAULT_WORKS_GROUPS: [
    { id: "all", name: "全部作品", fixed: true },
    { id: "uncategorized", name: "未分组", fixed: true },
  ],
  DEFAULT_FOLLOWINGS_GROUPS: [
    { id: "all", name: "全部关注", fixed: true },
    { id: "uncategorized", name: "未分组", fixed: true },
  ],
  DNR: {
    RULES: [
      {
        id: 1,
        priority: 1,
        condition: {
          urlFilter: "douyinvod.com",
          resourceTypes: ["media", "image", "xmlhttprequest"],
        },
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            {
              header: "Referer",
              operation: "set",
              value: "https://www.douyin.com/",
            },
            {
              header: "Origin",
              operation: "set",
              value: "https://www.douyin.com",
            },
          ],
        },
      },
      {
        id: 2,
        priority: 1,
        condition: {
          urlFilter: "douyinpic.com",
          resourceTypes: ["image", "xmlhttprequest"],
        },
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            {
              header: "Referer",
              operation: "set",
              value: "https://www.douyin.com/",
            },
          ],
        },
      },
      {
        id: 3,
        priority: 1,
        condition: {
          urlFilter: "||douyin.com/aweme/v1/web/",
          resourceTypes: ["xmlhttprequest"],
          excludedInitiatorDomains: ["www.douyin.com", "douyin.com"],
        },
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Sec-Fetch-Site", operation: "remove" },
            { header: "Sec-Fetch-Mode", operation: "remove" },
            { header: "Sec-Fetch-Dest", operation: "remove" },
            { header: "Sec-Fetch-User", operation: "remove" },
            { header: "Sec-Fetch-Storage-Access", operation: "remove" },
            { header: "Origin", operation: "remove" },
            { header: "Accept-Language", operation: "remove" },
            { header: "Accept-Encoding", operation: "set", value: "gzip, deflate" },
            { header: "Referer", operation: "set", value: "https://www.douyin.com/" },
          ],
        },
      },
      {
        id: 5,
        priority: 1,
        condition: {
          urlFilter: "||douyin.com/aweme/v1/web/aweme/collect/",
          resourceTypes: ["xmlhttprequest"],
          excludedInitiatorDomains: ["www.douyin.com", "douyin.com"],
        },
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Referer", operation: "set", value: "https://www.douyin.com/user/self?showTab=favorite_collection" },
          ],
        },
      },
      {
        id: 6,
        priority: 1,
        condition: {
          urlFilter: "||douyin.com/aweme/v1/web/commit/item/digg/",
          resourceTypes: ["xmlhttprequest"],
          excludedInitiatorDomains: ["www.douyin.com", "douyin.com"],
        },
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Referer", operation: "set", value: "https://www.douyin.com/user/self?showTab=like" },
          ],
        },
      },
    ],
  },
  TIMEOUT: {
    REQUEST: 30000,
    SECURITY_STATUS: 5000,
  },
  DELAY: {
    MIN: 500,
    MAX: 1000,
  },
  SYNC: {
    BATCH_SIZE: 40,
    BATCH_PAUSE_MIN: 10000,
    BATCH_PAUSE_MAX: 20000,
    KEEPALIVE_INTERVAL: 2000,
  },
  GROUPS: {
    ID_PREFIX: "custom_",
    DEFAULT_ID: "uncategorized",
  },
  PAGE: {
    FAVORITE: 20,
    COLLECTION: 20,
    AUTHOR: 20,
    FOLLOWING: 20,
  },
};

// ---------- 独立模式状态 ----------
let abOgus = null;

async function ensureABogus() {
  if (abOgus) return;
  const { browserFeatures } = await chrome.storage.local.get("browserFeatures");
  const f = browserFeatures || {};
  abOgus = new ABogus(f.userAgent || navigator.userAgent, f.platform || navigator.platform);
}

const MSTOKEN_TTL = 3600000;

function extractMsTokenFromCookie(cookieStr) {
  if (!cookieStr) return "";
  for (const pair of cookieStr.split(";")) {
    const trimmed = pair.trim();
    const idx = trimmed.indexOf("=");
    if (idx > 0 && trimmed.slice(0, idx) === "msToken") {
      return trimmed.slice(idx + 1);
    }
  }
  return "";
}

async function fetchMsToken() {
  try {
    const browserCookies = await chrome.cookies.getAll({ domain: "douyin.com", name: "msToken" });
    if (browserCookies.length > 0 && browserCookies[0].value) {
      return browserCookies[0].value;
    }
  } catch {}

  try {
    const { savedCookie } = await chrome.storage.local.get("savedCookie");
    const msToken = extractMsTokenFromCookie(savedCookie);
    if (msToken) return msToken;
  } catch {}

  return "";
}

async function getMsToken() {
  const { savedMsToken, savedMsTokenTime } = await chrome.storage.local.get(["savedMsToken", "savedMsTokenTime"]);
  if (savedMsToken && savedMsTokenTime && Date.now() - savedMsTokenTime < MSTOKEN_TTL) {
    return savedMsToken;
  }
  const msToken = (await fetchMsToken()) || generateRandomMsToken();
  await chrome.storage.local.set({ savedMsToken: msToken, savedMsTokenTime: Date.now() });
  return msToken;
}

const WEBID_API = "https://mcs.zijieapi.com/webid";

async function getWebId() {
  const { savedWebId, savedWebIdTime } = await chrome.storage.local.get(["savedWebId", "savedWebIdTime"]);
  if (savedWebId && savedWebIdTime && Date.now() - savedWebIdTime < MSTOKEN_TTL) {
    return savedWebId;
  }
  try {
    const ua = abOgus ? abOgus.userAgent : navigator.userAgent;
    const resp = await fetch(WEBID_API + "?aid=6383&sdk_version=5.1.18_zip&device_platform=web", {
      method: "POST",
      headers: {
        Accept: "*/*",
        "Content-Type": "text/plain;charset=UTF-8",
        Referer: "https://www.douyin.com/?recommend=1",
        "User-Agent": ua,
      },
      body: JSON.stringify({
        app_id: 6383,
        url: "https://www.douyin.com/",
        user_agent: ua,
        referer: "https://www.douyin.com/",
        user_unique_id: "",
      }),
    });
    if (!resp.ok) return "";
    const data = await resp.json();
    const webid = String(data.web_id || "");
    if (webid) await chrome.storage.local.set({ savedWebId: webid, savedWebIdTime: Date.now() });
    return webid;
  } catch {
    return "";
  }
}

async function buildBaseParams(extra = {}) {
  const bf = (await chrome.storage.local.get("browserFeatures")).browserFeatures || {};
  const verifyFp = getVerifyFp();
  const [webid, { savedCookie }] = await Promise.all([getWebId(), chrome.storage.local.get("savedCookie")]);
  let uifid = "";
  if (savedCookie) {
    const m = savedCookie.match(/\bUIFID=([^;]+)/);
    if (m) uifid = m[1];
  }
  return {
    device_platform: "webapp",
    aid: "6383",
    channel: "channel_pc_web",
    pc_client_type: "1",
    version_code: "290100",
    version_name: "29.1.0",
    cookie_enabled: "true",
    platform: "PC",
    publish_video_strategy_type: "2",
    cpu_core_num: String(bf.cpuCoreNum || 8),
    screen_width: String(bf.screenWidth || 1536),
    screen_height: String(bf.screenHeight || 864),
    browser_language: bf.browserLanguage || "zh-CN",
    browser_platform: bf.platform || "Win32",
    browser_name: bf.browserName || "Edge",
    browser_version: bf.browserVersion || "149",
    browser_online: "true",
    engine_name: bf.engineName || "Blink",
    engine_version: bf.engineVersion || "149",
    os_name: bf.osName || "Windows",
    os_version: bf.osVersion || "10",
    device_memory: String(bf.deviceMemory || 16),
    downlink: "10",
    effective_type: "4g",
    round_trip_time: "50",
    whale_cut_token: "",
    cut_version: "1",
    update_version_code: "290100",
    pc_libra_divert: "Windows",
    support_h265: "0",
    support_dash: "1",
    webid,
    uifid,
    verifyFp,
    fp: verifyFp,
    ...extra,
  };
}

async function independentRequest(apiPath, params, options = {}) {
  const { savedCookie } = await chrome.storage.local.get("savedCookie");
  if (!savedCookie) throw new Error("NO_COOKIE");
  params.msToken = await getMsToken();
  const method = options.method || "GET";
  const qs = new URLSearchParams(params).toString();
  const a_bogus = abOgus.getValue(qs, method);
  const url = "https://www.douyin.com" + apiPath + "?" + qs + "&a_bogus=" + a_bogus;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), options.timeout || CONFIG.TIMEOUT.REQUEST);
  try {
    const resp = await fetch(url, {
      credentials: "include",
      referrer: "https://www.douyin.com/",
      referrerPolicy: "unsafe-url",
      headers: {
        Accept: "application/json, text/plain, */*",
        "User-Agent": abOgus ? abOgus.userAgent : navigator.userAgent,
        ...options.headers,
      },
      method,
      signal: controller.signal,
    });
    clearTimeout(tid);
    if (!resp.ok) throw new Error("HTTP_" + resp.status);
    const data = await resp.json();
    if (data.status_code !== undefined && data.status_code !== 0) throw new Error("API_ERROR");
    return data;
  } catch (e) {
    clearTimeout(tid);
    throw e;
  }
}

function formatWork(aw) {
  if (!aw || !aw.aweme_id) return null;
  const author = aw.author || aw.author_info || {};
  const video = aw.video || {};
  const bitRate = Array.isArray(video.bit_rate) ? video.bit_rate : [];
  let videoUrl = "";
  let bestH = 0;
  for (const br of bitRate) {
    if (br.is_h265) continue;
    const addr = br.play_addr || {};
    const url = Array.isArray(addr.url_list) ? addr.url_list[0] : "";
    const h = addr.height || 0;
    if (url && h > bestH) {
      videoUrl = url;
      bestH = h;
    }
  }
  if (!videoUrl) videoUrl = ((video.play_addr && video.play_addr.url_list) || [])[0] || "";
  videoUrl = videoUrl.replace(/^http:/, "");
  const authorFollowed =
    "follow_status" in author
      ? author.follow_status === 1 || author.follow_status === 2
      : "followStatus" in author
        ? author.followStatus === 1 || author.followStatus === 2
        : null;
  return {
    awemeId: String(aw.aweme_id),
    type: (aw.aweme_type || aw.awemeType) === 68 ? "note" : "video",
    desc: aw.desc || "",
    nickname: String(author.nickname || author.nickName || ""),
    uid: String(author.uid || ""),
    authorHomeUrl: author.sec_uid ? "https://www.douyin.com/user/" + author.sec_uid : "",
    cover: ((video.cover && video.cover.url_list) || [])[0] ? video.cover.url_list[0].replace(/^http:/, "") : "",
    video: videoUrl,
    images: (aw.images || [])
      .map((i) => ((i.url_list || i.urlList || [])[0] || "").replace(/^http:/, ""))
      .filter(Boolean),
    music: (aw.music && (aw.music.play_url || aw.music.playUrl || {}).uri) || "",
    createTime: aw.create_time || 0,
    statistics: aw.statistics || {},
    authorFollowed,
  };
}

function formatFollowing(item) {
  return {
    uid: String(item.uid || ""),
    nickname: item.nickname || "未知",
    avatarLarger: ((item.avatar_larger && item.avatar_larger.url_list) || [])[0] || "",
    followerCount: item.follower_count || 0,
    profileUrl: "https://www.douyin.com/user/" + (item.sec_uid || ""),
  };
}

// ---------- 独立模式 handler ----------

async function handleIndependentFetchFollowing(secUid, sendResponse) {
  try {
    await ensureABogus();
    const requestId = crypto.randomUUID();
    let cancelled = false,
      hasMore = true,
      offset = 0,
      maxTime = 0;
    const all = [];
    const cancelHandler = (msg) => {
      if (msg.type === "CANCEL_ACTIVE_TASK") cancelled = true;
    };
    chrome.runtime.onMessage.addListener(cancelHandler);
    while (hasMore && !cancelled) {
      const params = { sec_user_id: secUid, count: String(CONFIG.PAGE.FOLLOWING), offset: String(offset) };
      if (maxTime > 0) params.max_time = String(maxTime);
      const data = await independentRequest(
        "/aweme/v1/web/user/following/list",
        await buildBaseParams(params),
      );
      if (data.status_code === 0 && Array.isArray(data.followings)) {
        if (data.followings.length === 0) break;
        all.push(...data.followings.map(formatFollowing));
        hasMore = data.has_more === true || data.has_more === 1;
        offset += data.followings.length;
        maxTime = data.min_time || 0;
      } else break;
      chrome.runtime
        .sendMessage({ type: "FOLLOWING_PROGRESS", collected: all.length, hasMore, total: data.total || 0, requestId })
        .catch(() => {});
      if (hasMore && !cancelled)
        await new Promise((r) =>
          setTimeout(r, CONFIG.DELAY.MIN + Math.random() * (CONFIG.DELAY.MAX - CONFIG.DELAY.MIN)),
        );
    }
    chrome.runtime.onMessage.removeListener(cancelHandler);
    sendResponse({ ok: true, requestId, followings: all, total: all.length });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
}

async function handleIndependentFetchCollection(sendResponse) {
  try {
    await ensureABogus();
    const requestId = crypto.randomUUID();
    let cancelled = false,
      hasMore = true,
      cursor = 0;
    const all = [];
    const cancelHandler = (msg) => {
      if (msg.type === "CANCEL_ACTIVE_TASK") cancelled = true;
    };
    chrome.runtime.onMessage.addListener(cancelHandler);
    while (hasMore && !cancelled) {
      const data = await independentRequest(
        "/aweme/v1/web/aweme/listcollection/",
        await buildBaseParams({ sec_user_id: "self", count: String(CONFIG.PAGE.COLLECTION), cursor: String(cursor) }),
        { method: "POST" },
      );
      if (data.status_code === 0 && Array.isArray(data.aweme_list)) {
        if (data.aweme_list.length === 0) break;
        all.push(...data.aweme_list.map(formatWork).filter(Boolean));
        hasMore = data.has_more === true || data.has_more === 1;
        cursor = data.cursor || data.max_cursor || cursor + 20;
      } else break;
      const un = all.filter((w) => w.authorFollowed === false).length;
      chrome.runtime
        .sendMessage({
          type: "COLLECTION_PROGRESS",
          collected: all.length,
          unfollowedCount: un,
          hasMore,
          total: data.total || 0,
          requestId,
        })
        .catch(() => {});
      if (hasMore && !cancelled)
        await new Promise((r) =>
          setTimeout(r, CONFIG.DELAY.MIN + Math.random() * (CONFIG.DELAY.MAX - CONFIG.DELAY.MIN)),
        );
    }
    chrome.runtime.onMessage.removeListener(cancelHandler);
    sendResponse({ ok: true, requestId, works: all, timedOut: cancelled });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
}

async function handleIndependentSyncWorks(awemeIds, sendResponse) {
  if (!Array.isArray(awemeIds) || awemeIds.length === 0) return sendResponse({ ok: false, error: "EMPTY" });
  try {
    await ensureABogus();
    const requestId = crypto.randomUUID();
    let cancelled = false;
    const allWorks = [],
      errors = [];
    const cancelHandler = (msg) => {
      if (msg.type === "CANCEL_ACTIVE_TASK") cancelled = true;
    };
    chrome.runtime.onMessage.addListener(cancelHandler);
    sendResponse({ ok: true, requestId, total: awemeIds.length });
    for (let i = 0; i < awemeIds.length && !cancelled; i++) {
      try {
        const data = await independentRequest("/aweme/v1/web/aweme/detail/", { aweme_id: awemeIds[i] });
        const w = data.aweme_detail ? formatWork(data.aweme_detail) : null;
        if (w) allWorks.push(w);
      } catch (e) {
        errors.push({ awemeId: awemeIds[i], error: e.message });
      }
      chrome.runtime
        .sendMessage({
          type: "SYNC_PROGRESS",
          requestId,
          index: i,
          total: awemeIds.length,
          status: errors.length ? "error" : "ok",
          awemeId: awemeIds[i],
        })
        .catch(() => {});
      if (!cancelled) {
        const { BATCH_SIZE, BATCH_PAUSE_MIN, BATCH_PAUSE_MAX, KEEPALIVE_INTERVAL } = CONFIG.SYNC;
        if (BATCH_SIZE > 0 && (i + 1) % BATCH_SIZE === 0) {
          const deadline = Date.now() + BATCH_PAUSE_MIN + Math.random() * (BATCH_PAUSE_MAX - BATCH_PAUSE_MIN);
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, KEEPALIVE_INTERVAL));
            await chrome.storage.local.get("keepalive");
          }
        } else {
          await new Promise((r) =>
            setTimeout(r, CONFIG.DELAY.MIN + Math.random() * (CONFIG.DELAY.MAX - CONFIG.DELAY.MIN)),
          );
        }
      }
    }
    chrome.runtime.onMessage.removeListener(cancelHandler);
    if (allWorks.length > 0) {
      const result = await mergeAndSaveWorks(allWorks);
      chrome.runtime
        .sendMessage({
          type: "SYNC_DONE",
          requestId,
          ok: true,
          refreshed: result.added + result.updated,
          failed: errors.length,
          failedAwemeIds: errors.map((e) => e.awemeId).filter(Boolean),
        })
        .catch(() => {});
    } else {
      chrome.runtime
        .sendMessage({ type: "SYNC_DONE", requestId, ok: false, error: errors[0]?.error || "NO_WORKS_COLLECTED" })
        .catch(() => {});
    }
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
}

async function handleIndependentFetchWorksPage(secUid, cursor, sendResponse) {
  try {
    await ensureABogus();
    const data = await independentRequest(
      "/aweme/v1/web/aweme/post/",
      await buildBaseParams({
        sec_user_id: secUid,
        max_cursor: String(cursor || 0),
        count: String(CONFIG.PAGE.AUTHOR),
      }),
    );
    const works = (data.aweme_list || []).map(formatWork).filter(Boolean);
    sendResponse({
      ok: true,
      works,
      hasMore: data.has_more === true || data.has_more === 1,
      maxCursor: data.max_cursor || "",
    });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
}

// ---------- 存储 handler ----------

async function handleCaptureBrowserFeatures(message, sendResponse) {
  if (message.features) {
    await chrome.storage.local.set({ browserFeatures: message.features });
    abOgus = new ABogus(message.features.userAgent || navigator.userAgent, message.features.platform || navigator.platform);
  }
  sendResponse({ ok: true });
}

async function handleSetMode(message, sendResponse) {
  await chrome.storage.local.set({ independentMode: message.enabled === true });
  if (message.enabled) await ensureABogus();
  sendResponse({ ok: true });
}

// STORAGE_KEYS 作为 store/group 名的唯一常量来源

// ---------- 初始化 ----------
async function setupDeclarativeNetRequest() {
  const rules = CONFIG.DNR.RULES;

  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const existingIds = existing.map((r) => r.id);
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existingIds,
      addRules: rules,
    });
  } catch (e) {
    console.warn("[DY-Manager] DNR setup failed:", e.message);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await setupDeclarativeNetRequest();

  const worksGroups = await storage.getGroups(CONFIG.STORAGE_KEYS.WORKS_GROUPS);
  if (!worksGroups.length) {
    await storage.putGroups(CONFIG.STORAGE_KEYS.WORKS_GROUPS, CONFIG.DEFAULT_WORKS_GROUPS);
  }

  const followingsGroups = await storage.getGroups(CONFIG.STORAGE_KEYS.FOLLOWINGS_GROUPS);
  if (!followingsGroups.length) {
    await storage.putGroups(CONFIG.STORAGE_KEYS.FOLLOWINGS_GROUPS, CONFIG.DEFAULT_FOLLOWINGS_GROUPS);
  }
});

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(setupDeclarativeNetRequest);
}

chrome.action.onClicked.addListener(() => {
  const url = chrome.runtime.getURL("options/options.html");
  chrome.tabs.query({ url }, (tabs) => {
    if (tabs && tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true });
    } else {
      chrome.tabs.create({ url });
    }
  });
});

// ---------- 辅助函数 ----------

function asyncHandler(fn, sendResponse) {
  const result = fn();
  if (result && typeof result.catch === "function") {
    result.catch((err) => sendResponse({ error: err.message }));
  }
  return true;
}

const DOMAIN_CONFIG = {
  [CONFIG.STORAGE_KEYS.WORKS]: {
    storeName: CONFIG.STORAGE_KEYS.WORKS,
    groupsName: CONFIG.STORAGE_KEYS.WORKS_GROUPS,
    defaultGroups: CONFIG.DEFAULT_WORKS_GROUPS,
    itemKey: CONFIG.STORAGE_KEYS.WORKS,
    idField: "awemeId",
  },
  [CONFIG.STORAGE_KEYS.FOLLOWINGS]: {
    storeName: CONFIG.STORAGE_KEYS.FOLLOWINGS,
    groupsName: CONFIG.STORAGE_KEYS.FOLLOWINGS_GROUPS,
    defaultGroups: CONFIG.DEFAULT_FOLLOWINGS_GROUPS,
    itemKey: CONFIG.STORAGE_KEYS.FOLLOWINGS,
    idField: "uid",
    idToString: true,
  },
};

function getStoreName(domain) {
  return DOMAIN_CONFIG[domain || CONFIG.STORAGE_KEYS.WORKS].storeName;
}

function getGroupsName(domain) {
  return DOMAIN_CONFIG[domain || CONFIG.STORAGE_KEYS.WORKS].groupsName;
}

function getDefaultGroups(domain) {
  return DOMAIN_CONFIG[domain || CONFIG.STORAGE_KEYS.WORKS].defaultGroups;
}

function toStorageId(domain, id) {
  const cfg = DOMAIN_CONFIG[domain];
  return cfg.idToString ? String(id) : id;
}

function createDomainHandlers(domain) {
  const cfg = DOMAIN_CONFIG[domain];

  return {
    async get(groupId, sendResponse) {
      try {
        let list;
        if (groupId && groupId !== "all") {
          const store = await storage.getByIndex(cfg.storeName, "groupId", groupId);
          list = Object.values(store);
        } else {
          const store = await storage.getAll(cfg.storeName);
          list = Object.values(store);
        }
        list.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
        sendResponse({ [cfg.itemKey]: list });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    },

    async delete(ids, sendResponse) {
      try {
        const keys = ids.map((id) => toStorageId(domain, id));
        await storage.deleteBatch(cfg.storeName, keys);
        const remaining = await storage.count(cfg.storeName);
        sendResponse({ ok: true, remaining });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    },

    async move(ids, targetGroupId, sendResponse) {
      try {
        const keys = ids.map((id) => toStorageId(domain, id));
        const items = await Promise.all(keys.map((k) => storage.get(cfg.storeName, k)));
        const toWrite = items.filter(Boolean).map((item) => ({ ...item, groupId: targetGroupId }));
        if (toWrite.length > 0) await storage.putBatch(cfg.storeName, toWrite);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    },

    async save(items, sendResponse, isImport = false) {
      if (domain === CONFIG.STORAGE_KEYS.WORKS) {
        return handleSaveWorks(items, sendResponse);
      } else if (domain === CONFIG.STORAGE_KEYS.FOLLOWINGS) {
        return handleSaveFollowings(items, sendResponse, isImport);
      }
      sendResponse({ ok: false, error: "Unknown domain: " + domain });
    },
  };
}

const worksHandlers = createDomainHandlers(CONFIG.STORAGE_KEYS.WORKS);
const followingsHandlers = createDomainHandlers(CONFIG.STORAGE_KEYS.FOLLOWINGS);

function extractImportItems(data, domain) {
  const cfg = DOMAIN_CONFIG[domain];
  if (data[cfg.itemKey] && Array.isArray(data[cfg.itemKey])) return data[cfg.itemKey];
  return [];
}

function mergeWork(w, old) {
  return {
    ...w,
    groupId: old?.groupId || w.groupId || CONFIG.GROUPS.DEFAULT_ID,
    savedAt: old?.savedAt || w.savedAt || Date.now(),
  };
}

async function mergeAndSaveWorks(works) {
  const valid = works.filter((w) => w && w.awemeId);
  if (valid.length === 0) return { added: 0, updated: 0, total: 0 };

  const oldItems = await Promise.all(
    valid.map((w) => storage.get(CONFIG.STORAGE_KEYS.WORKS, w.awemeId).then((old) => ({ w, old }))),
  );

  let added = 0,
    updated = 0;
  const toWrite = [];
  for (const { w, old } of oldItems) {
    const isNew = !old;
    toWrite.push(mergeWork(w, old));
    if (isNew) added++;
    else updated++;
  }
  await storage.putBatch(CONFIG.STORAGE_KEYS.WORKS, toWrite);

  const totalCount = await storage.count(CONFIG.STORAGE_KEYS.WORKS);
  return { added, updated, total: totalCount };
}

function sendSyncDone(requestId, result) {
  chrome.runtime
    .sendMessage({ type: "SYNC_DONE", requestId, ...result })
    .catch((e) => console.warn("[DY] sync done send failed:", e));
}

async function withDouyinTab() {
  const tabs = await chrome.tabs.query({ url: "*://*.douyin.com/*" });
  const tab = tabs.find((t) => t.url && !t.url.includes("creator.douyin.com") && t.status === "complete");
  return tab || null;
}

function sendToTab(type, data, sendResponse) {
  const requestId = crypto.randomUUID();
  const timeoutMs = data.timeout || CONFIG.TIMEOUT.REQUEST;
  let called = false;

  withDouyinTab()
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

function sendToTabAsync(type, data) {
  return new Promise((resolve) => {
    sendToTab(type, data, (resp) => resolve(resp || { ok: false, error: "EMPTY_RESPONSE" }));
  });
}

// ---------- 消息路由 ----------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    // 作品域
    case "SAVE_WORKS":
      return asyncHandler(() => worksHandlers.save(message.works, sendResponse), sendResponse);
    case "GET_WORKS":
      return asyncHandler(() => worksHandlers.get(message.groupId, sendResponse), sendResponse);
    case "DELETE_WORKS":
      return asyncHandler(() => worksHandlers.delete(message.awemeIds, sendResponse), sendResponse);
    case "MOVE_WORKS":
      return asyncHandler(
        () => worksHandlers.move(message.awemeIds, message.targetGroupId, sendResponse),
        sendResponse,
      );
    case "GET_WORK":
      return asyncHandler(() => handleGetWork(message.awemeId, sendResponse), sendResponse);

    // 关注域
    case "SAVE_FOLLOWINGS":
      return asyncHandler(() => followingsHandlers.save(message.followings, sendResponse), sendResponse);
    case "GET_FOLLOWINGS":
      return asyncHandler(() => followingsHandlers.get(message.groupId, sendResponse), sendResponse);
    case "DELETE_FOLLOWINGS":
      return asyncHandler(() => followingsHandlers.delete(message.uids, sendResponse), sendResponse);
    case "MOVE_FOLLOWINGS":
      return asyncHandler(
        () => followingsHandlers.move(message.uids, message.targetGroupId, sendResponse),
        sendResponse,
      );
    // 分组管理 (域感知)
    case "GET_GROUPS":
      return asyncHandler(() => handleGetGroups(message.domain, sendResponse), sendResponse);
    case "ADD_GROUP":
      return asyncHandler(() => handleAddGroup(message.domain, message.name, sendResponse), sendResponse);
    case "RENAME_GROUP":
      return asyncHandler(
        () => handleRenameGroup(message.domain, message.groupId, message.newName, sendResponse),
        sendResponse,
      );
    case "DELETE_GROUP":
      return asyncHandler(() => handleDeleteGroup(message.domain, message.groupId, sendResponse), sendResponse);
    case "REORDER_GROUPS":
      return asyncHandler(() => handleReorderGroups(message.domain, message.groupIds, sendResponse), sendResponse);

    // 数据工具 (域感知)
    case "IMPORT_DATA":
      return asyncHandler(
        () => handleImportData(message.data, message.domain || CONFIG.STORAGE_KEYS.WORKS, sendResponse),
        sendResponse,
      );
    case "EXPORT_DATA":
      return asyncHandler(() => handleExportData(message.domain, sendResponse), sendResponse);
    case "RESET_DOMAIN":
      return asyncHandler(() => handleResetDomain(message.domain, sendResponse), sendResponse);
    case "GET_STATS":
      return asyncHandler(() => handleGetStats(sendResponse), sendResponse);

    // 独立模式 / Tab 转发
    case "FETCH_FOLLOWING":
      return asyncHandler(async () => {
        const { independentMode } = await chrome.storage.local.get("independentMode");
        if (independentMode) return handleIndependentFetchFollowing(message.secUid, sendResponse);
        return handleFetchFollowing(message.secUid, sendResponse);
      }, sendResponse);
    case "FETCH_FAVORITES":
      return asyncHandler(async () => {
        return handleFetchFavorites(message.secUid, sendResponse);
      }, sendResponse);
    case "FETCH_COLLECTION":
      return asyncHandler(async () => {
        const { independentMode } = await chrome.storage.local.get("independentMode");
        if (independentMode) return handleIndependentFetchCollection(sendResponse);
        return handleFetchCollection(sendResponse);
      }, sendResponse);
    case "SYNC_WORKS":
      return asyncHandler(async () => {
        const { independentMode } = await chrome.storage.local.get("independentMode");
        if (independentMode) return handleIndependentSyncWorks(message.awemeIds, sendResponse);
        return handleSyncWorks(message.awemeIds, sendResponse);
      }, sendResponse);
    case "FETCH_WORKS_PAGE":
      return asyncHandler(async () => {
        const { independentMode } = await chrome.storage.local.get("independentMode");
        if (independentMode) return handleIndependentFetchWorksPage(message.secUid, message.cursor || "", sendResponse);
        sendToTab(
          "FETCH_WORKS_PAGE",
          { secUid: message.secUid, cursor: message.cursor || "", count: CONFIG.PAGE.AUTHOR, timeout: CONFIG.TIMEOUT.REQUEST },
          sendResponse,
        );
      }, sendResponse);
    case "CANCEL_LIKE":
      return asyncHandler(async () => {
        return runCancelBatch(message.awemeIds, "CANCEL_ONE_LIKE", "CANCEL_PROGRESS", sendResponse);
      }, sendResponse);
    case "CANCEL_COLLECTION":
      return asyncHandler(async () => {
        const { independentMode } = await chrome.storage.local.get("independentMode");
        if (independentMode) return handleIndependentCancel(message.awemeIds, "collection", sendResponse);
        return runCancelBatch(message.awemeIds, "CANCEL_ONE_COLLECTION", "CANCEL_PROGRESS", sendResponse);
      }, sendResponse);
    case "GET_SECURITY_STATUS":
      sendToTab("GET_SECURITY_STATUS", { timeout: CONFIG.TIMEOUT.SECURITY_STATUS }, sendResponse);
      return true;

    // 存储 / 配置
    case "SET_MODE":
      return asyncHandler(() => handleSetMode(message, sendResponse), sendResponse);
    case "CAPTURE_BROWSER_FEATURES":
      return asyncHandler(() => handleCaptureBrowserFeatures(message, sendResponse), sendResponse);
    case "GET_COOKIE_INFO":
      return asyncHandler(async () => {
        const { savedCookie } = await chrome.storage.local.get("savedCookie");
        if (!savedCookie) return sendResponse({ ok: true, pairs: [], hasSessionid: false });
        const pairs = parseCookieToPairs(savedCookie);
        sendResponse({ ok: true, pairs, rawCookie: savedCookie, hasSessionid: pairs.some((p) => p.key === "sessionid"), count: pairs.length });
      }, sendResponse);
    case "GET_MSTOKEN":
      return asyncHandler(async () => {
        sendResponse({ ok: true, msToken: await getMsToken() });
      }, sendResponse);
    case "GET_BROWSER_FEATURES":
      return asyncHandler(async () => {
        const bf = (await chrome.storage.local.get("browserFeatures")).browserFeatures;
        sendResponse({ ok: true, features: bf || null });
      }, sendResponse);

    case "CANCEL_ACTIVE_TASK":
      withDouyinTab()
        .then((tab) => {
          if (!tab) {
            sendResponse({ ok: true });
            return;
          }
          chrome.tabs.sendMessage(tab.id, { type: "CANCEL_ACTIVE_TASK" }).catch(() => {});
          sendResponse({ ok: true });
        })
        .catch(() => sendResponse({ ok: false }));
      return true;

    default:
      sendResponse({ error: `Unknown message type: ${message.type}` });
  }
});

// ---------- 分页抓取 Handler ----------

async function handleFetchFollowing(secUid, sendResponse) {
  try {
    const requestId = crypto.randomUUID();
    let cancelled = false;
    const cancelHandler = (msg) => {
      if (msg.type === "CANCEL_ACTIVE_TASK") {
        cancelled = true;
      }
    };
    chrome.runtime.onMessage.addListener(cancelHandler);

    const all = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore && !cancelled) {
      const resp = await sendToTabAsync("FETCH_FOLLOWING_PAGE", {
        secUid,
        offset,
        count: CONFIG.PAGE.FOLLOWING,
        timeout: CONFIG.TIMEOUT.REQUEST,
      });
      if (resp?.ok && Array.isArray(resp.items)) {
        all.push(...resp.items);
        hasMore = resp.hasMore === true;
        offset = resp.cursor;
      } else {
        break;
      }
      chrome.runtime
        .sendMessage({
          type: "FOLLOWING_PROGRESS",
          collected: all.length,
          hasMore,
          total: resp.total || 0,
          requestId,
        })
        .catch(() => {});
      if (hasMore && !cancelled) {
        const delay = CONFIG.DELAY.MIN + Math.random() * (CONFIG.DELAY.MAX - CONFIG.DELAY.MIN);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    chrome.runtime.onMessage.removeListener(cancelHandler);
    sendResponse({ ok: true, requestId, followings: all, total: all.length });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

async function handleFetchFavorites(secUid, sendResponse) {
  try {
    const requestId = crypto.randomUUID();
    let cancelled = false;
    const cancelHandler = (msg) => {
      if (msg.type === "CANCEL_ACTIVE_TASK") {
        cancelled = true;
      }
    };
    chrome.runtime.onMessage.addListener(cancelHandler);

    const all = [];
    let cursor = 0;
    let hasMore = true;

    while (hasMore && !cancelled) {
      const resp = await sendToTabAsync("FETCH_FAVORITES_PAGE", {
        secUid,
        cursor,
        count: CONFIG.PAGE.FAVORITE,
        timeout: CONFIG.TIMEOUT.REQUEST,
      });
      if (resp?.ok && Array.isArray(resp.items)) {
        all.push(...resp.items);
        hasMore = resp.hasMore === true;
        cursor = resp.cursor || cursor;
      } else {
        break;
      }
      const unfollowedCount = all.filter((w) => w.authorFollowed === false).length;
      chrome.runtime
        .sendMessage({
          type: "FAVORITES_PROGRESS",
          collected: all.length,
          unfollowedCount,
          hasMore,
          total: resp.total || 0,
          requestId,
        })
        .catch(() => {});
      if (hasMore && !cancelled) {
        const delay = CONFIG.DELAY.MIN + Math.random() * (CONFIG.DELAY.MAX - CONFIG.DELAY.MIN);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    chrome.runtime.onMessage.removeListener(cancelHandler);
    sendResponse({ ok: true, requestId, works: all, timedOut: cancelled });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

async function handleFetchCollection(sendResponse) {
  try {
    const requestId = crypto.randomUUID();
    let cancelled = false;
    const cancelHandler = (msg) => {
      if (msg.type === "CANCEL_ACTIVE_TASK") {
        cancelled = true;
      }
    };
    chrome.runtime.onMessage.addListener(cancelHandler);

    const all = [];
    let cursor = 0;
    let hasMore = true;

    while (hasMore && !cancelled) {
      const resp = await sendToTabAsync("FETCH_COLLECTION_PAGE", {
        cursor,
        count: CONFIG.PAGE.COLLECTION,
        timeout: CONFIG.TIMEOUT.REQUEST,
      });
      if (resp?.ok && Array.isArray(resp.items)) {
        all.push(...resp.items);
        hasMore = resp.hasMore === true;
        cursor = resp.cursor || cursor;
      } else {
        break;
      }
      const unfollowedCount = all.filter((w) => w.authorFollowed === false).length;
      chrome.runtime
        .sendMessage({
          type: "COLLECTION_PROGRESS",
          collected: all.length,
          unfollowedCount,
          hasMore,
          total: resp.total || 0,
          requestId,
        })
        .catch(() => {});
      if (hasMore && !cancelled) {
        const delay = CONFIG.DELAY.MIN + Math.random() * (CONFIG.DELAY.MAX - CONFIG.DELAY.MIN);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    chrome.runtime.onMessage.removeListener(cancelHandler);
    sendResponse({ ok: true, requestId, works: all, timedOut: cancelled });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

async function runCancelBatch(awemeIds, tabType, progressType, sendResponse) {
  if (!Array.isArray(awemeIds) || awemeIds.length === 0) {
    sendResponse({ ok: false, error: "EMPTY" });
    return;
  }
  const requestId = crypto.randomUUID();
  const errors = [];
  let cancelled = false;
  const cancelHandler = (msg) => {
    if (msg.type === "CANCEL_ACTIVE_TASK") cancelled = true;
  };
  chrome.runtime.onMessage.addListener(cancelHandler);

  sendResponse({ ok: true, requestId, total: awemeIds.length });

  for (let i = 0; i < awemeIds.length && !cancelled; i++) {
    const resp = await sendToTabAsync(tabType, {
      awemeId: awemeIds[i],
      timeout: CONFIG.TIMEOUT.REQUEST,
    });
    if (resp?.ok) {
      // success
    } else {
      errors.push({ awemeId: awemeIds[i], error: resp?.error || "FAILED" });
    }
    chrome.runtime
      .sendMessage({
        type: progressType,
        requestId,
        index: i,
        total: awemeIds.length,
        status: resp?.ok ? "ok" : "error",
        awemeId: awemeIds[i],
      })
      .catch(() => {});

    if (!cancelled && i < awemeIds.length - 1) {
      const delay = CONFIG.DELAY.MIN + Math.random() * (CONFIG.DELAY.MAX - CONFIG.DELAY.MIN);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  chrome.runtime.onMessage.removeListener(cancelHandler);
  chrome.runtime
    .sendMessage({
      type: "CANCEL_DONE",
      requestId,
      ok: true,
      cancelled,
      refreshed: awemeIds.length - errors.length,
      failed: errors.length,
      failedAwemeIds: errors.map((e) => e.awemeId).filter(Boolean),
    })
    .catch(() => {});
}

const CANCEL_ENDPOINTS = {
  like: {
    url: "https://www.douyin.com/aweme/v1/web/commit/item/digg/?aid=6383",
    body: (id) => "aweme_id=" + id + "&item_type=0&type=0",
    type: "application/x-www-form-urlencoded; charset=UTF-8",
    referrer: "https://www.douyin.com/user/self?showTab=like",
  },
  collection: {
    url: "https://www.douyin.com/aweme/v1/web/aweme/collect/?aid=6383",
    body: (id) => "action=0&aweme_id=" + id + "&aweme_type=0",
    type: "application/x-www-form-urlencoded",
    referrer: "https://www.douyin.com/user/self?showTab=favorite_collection",
  },
};

async function handleIndependentCancel(awemeIds, kind, sendResponse) {
  try {
    if (!Array.isArray(awemeIds) || awemeIds.length === 0) return sendResponse({ ok: false, error: "EMPTY" });
    const { savedCookie, browserFeatures } = await chrome.storage.local.get(["savedCookie", "browserFeatures"]);
    if (!savedCookie) return sendResponse({ ok: false, error: "NO_COOKIE" });
    const key = (browserFeatures && browserFeatures.securityKey) || "";
    const ep = CANCEL_ENDPOINTS[kind];
    if (!ep) return sendResponse({ ok: false, error: "UNKNOWN_KIND" });

    const requestId = crypto.randomUUID();
    let cancelled = false;
    const errors = [];
    const cancelHandler = (msg) => {
      if (msg.type === "CANCEL_ACTIVE_TASK") cancelled = true;
    };
    chrome.runtime.onMessage.addListener(cancelHandler);
    sendResponse({ ok: true, requestId, total: awemeIds.length });

    for (let i = 0; i < awemeIds.length && !cancelled; i++) {
      let ok = false;
      try {
        const resp = await fetch(ep.url, {
          method: "POST",
          credentials: "include",
          referrer: ep.referrer,
          referrerPolicy: "unsafe-url",
          headers: {
            "content-type": ep.type,
            ...(key ? { "bd-ticket-guard-ree-public-key": key } : {}),
          },
          body: ep.body(awemeIds[i]),
        });
        ok = resp.ok;
      } catch (_) {}
      chrome.runtime
        .sendMessage({
          type: "CANCEL_PROGRESS",
          requestId,
          index: i,
          total: awemeIds.length,
          status: ok ? "ok" : "error",
          awemeId: awemeIds[i],
        })
        .catch(() => {});
      if (!cancelled && i < awemeIds.length - 1)
        await new Promise((r) =>
          setTimeout(r, CONFIG.DELAY.MIN + Math.random() * (CONFIG.DELAY.MAX - CONFIG.DELAY.MIN)),
        );
    }
    chrome.runtime.onMessage.removeListener(cancelHandler);
    chrome.runtime
      .sendMessage({
        type: "CANCEL_DONE",
        requestId,
        ok: true,
        cancelled,
        refreshed: awemeIds.length - errors.length,
        failed: errors.length,
        failedAwemeIds: errors.map((e) => e.awemeId).filter(Boolean),
      })
      .catch(() => {});
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
}

// ---------- 作品域 Handler ----------

async function handleSaveWorks(works, sendResponse) {
  try {
    const result = await mergeAndSaveWorks(works);
    const invalid = works.filter((w) => !w || !w.awemeId).length;
    sendResponse({ ok: true, ...result, invalid });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

async function handleGetWork(awemeId, sendResponse) {
  try {
    const work = await storage.get(CONFIG.STORAGE_KEYS.WORKS, awemeId);
    sendResponse({ work: work || null });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

// ---------- 关注域 Handler ----------

async function handleSaveFollowings(followings, sendResponse, isImport = false) {
  try {
    if (!Array.isArray(followings) || followings.length === 0) {
      return sendResponse({ ok: false, error: "EMPTY" });
    }

    const store = await storage.getAll(CONFIG.STORAGE_KEYS.FOLLOWINGS);
    const incomingUids = new Set();
    let added = 0,
      updated = 0;

    const baseTime = Date.now();
    for (let i = 0; i < followings.length; i++) {
      const f = followings[i];
      if (!f || !f.uid) continue;
      const uid = String(f.uid);
      incomingUids.add(uid);
      const old = store[uid];
      store[uid] = {
        ...f,
        uid,
        groupId: isImport
          ? f.groupId || CONFIG.GROUPS.DEFAULT_ID
          : old?.groupId || f.groupId || CONFIG.GROUPS.DEFAULT_ID,
        savedAt: old?.savedAt ?? baseTime - i,
      };
      if (!old) added++;
      else updated++;
    }

    // Mark users not in new list as 'lost'
    const lostUids = [];
    for (const uid of Object.keys(store)) {
      if (!incomingUids.has(uid)) {
        lostUids.push(uid);
      }
    }

    await storage.putBatch(CONFIG.STORAGE_KEYS.FOLLOWINGS, Object.values(store));
    sendResponse({
      ok: true,
      added,
      updated,
      lost: lostUids.length,
      lostUids,
      total: Object.keys(store).length,
    });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

// ---------- 分组 Handler (域感知) ----------

async function handleGetGroups(domain, sendResponse) {
  try {
    const groupsName = getGroupsName(domain || CONFIG.STORAGE_KEYS.WORKS);
    const def = getDefaultGroups(domain || CONFIG.STORAGE_KEYS.WORKS);
    const list = await storage.getGroups(groupsName);
    const result = list.length ? list : def;
    result.forEach((g, i) => {
      if (!("order" in g)) g.order = i;
    });
    result.sort((a, b) => a.order - b.order);
    sendResponse({ groups: result });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

async function handleAddGroup(domain, name, sendResponse) {
  try {
    const groupsName = getGroupsName(domain || CONFIG.STORAGE_KEYS.WORKS);
    const def = getDefaultGroups(domain || CONFIG.STORAGE_KEYS.WORKS);
    const list = await storage.getGroups(groupsName);
    const current = list.length ? list : def;
    const id = CONFIG.GROUPS.ID_PREFIX + crypto.randomUUID();
    current.push({
      id,
      name: name.trim(),
      fixed: false,
      order: current.length,
    });
    await storage.putGroups(groupsName, current);
    sendResponse({ ok: true, group: current[current.length - 1] });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

async function handleRenameGroup(domain, groupId, newName, sendResponse) {
  try {
    const groupsName = getGroupsName(domain || CONFIG.STORAGE_KEYS.WORKS);
    const def = getDefaultGroups(domain || CONFIG.STORAGE_KEYS.WORKS);
    const list = await storage.getGroups(groupsName);
    const current = list.length ? list : def;
    const g = current.find((x) => x.id === groupId);
    if (!g) return sendResponse({ error: "分组不存在" });
    if (g.fixed) return sendResponse({ error: "固定分组不可重命名" });
    g.name = newName.trim();
    await storage.putGroups(groupsName, current);
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

async function handleReorderGroups(domain, groupIds, sendResponse) {
  try {
    const groupsName = getGroupsName(domain || CONFIG.STORAGE_KEYS.WORKS);
    const def = getDefaultGroups(domain || CONFIG.STORAGE_KEYS.WORKS);
    const list = await storage.getGroups(groupsName);
    const current = list.length ? list : def;
    const fixed = current.filter((g) => g.fixed);
    const ordered = groupIds.map((id) => current.find((x) => x.id === id)).filter(Boolean);
    for (const g of fixed) {
      if (!ordered.some((x) => x.id === g.id)) ordered.unshift(g);
    }
    ordered.forEach((g, i) => (g.order = i));
    await storage.putGroups(groupsName, ordered);
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

async function handleDeleteGroup(domain, groupId, sendResponse) {
  try {
    const groupsName = getGroupsName(domain || CONFIG.STORAGE_KEYS.WORKS);
    const storeName = getStoreName(domain || CONFIG.STORAGE_KEYS.WORKS);
    const def = getDefaultGroups(domain || CONFIG.STORAGE_KEYS.WORKS);
    const defaultGroupId = CONFIG.GROUPS.DEFAULT_ID;

    const list = await storage.getGroups(groupsName);
    const current = list.length ? list : def;
    const g = current.find((x) => x.id === groupId);
    if (!g) return sendResponse({ error: "分组不存在" });
    if (g.fixed) return sendResponse({ error: "固定分组不可删除" });

    const affected = await storage.getByIndex(storeName, "groupId", groupId);
    const affectedList = Object.values(affected);
    for (const item of affectedList) {
      item.groupId = defaultGroupId;
    }
    if (affectedList.length > 0) await storage.putBatch(storeName, affectedList);

    const filtered = current.filter((x) => x.id !== groupId);
    await storage.putGroups(groupsName, filtered);
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

// ---------- 同步 Handler ----------

const FATAL_ERRORS = new Set([
  "NO_DOUYIN_TAB",
  "TAB_QUERY_FAILED",
  "NO_LISTENER",
  "EMPTY_RESPONSE",
  "RATE_LIMITED",
  "CANCELLED",
]);

async function handleSyncWorks(awemeIds, sendResponse) {
  if (!Array.isArray(awemeIds) || awemeIds.length === 0) {
    return sendResponse({ ok: false, error: "EMPTY" });
  }

  const requestId = crypto.randomUUID();
  let cancelled = false;

  const cancelHandler = (msg) => {
    if (msg.type === "CANCEL_ACTIVE_TASK") {
      cancelled = true;
      withDouyinTab().then((tab) => {
        if (!tab) return;
        chrome.tabs.sendMessage(tab.id, { type: "CANCEL_ACTIVE_TASK" }).catch(() => {});
      });
    }
  };
  chrome.runtime.onMessage.addListener(cancelHandler);

  sendResponse({ ok: true, requestId, total: awemeIds.length });

  const allWorks = [];
  const errors = [];

  for (let i = 0; i < awemeIds.length && !cancelled; i++) {
    const resp = await sendToTabAsync("FETCH_SINGLE_WORK", {
      awemeId: awemeIds[i],
      timeout: CONFIG.TIMEOUT.REQUEST,
    });

    if (!resp?.ok) {
      const err = resp?.error || "UNKNOWN";
      if (FATAL_ERRORS.has(err) || err.startsWith("HTTP 429") || err.startsWith("HTTP 401")) {
        for (let j = i; j < awemeIds.length; j++) {
          errors.push({ awemeId: awemeIds[j], error: j === i ? err : "BATCH_TERMINATED" });
        }
        break;
      }
      errors.push({ awemeId: awemeIds[i], error: err });
    } else if (resp.work) {
      allWorks.push(resp.work);
    }

    chrome.runtime
      .sendMessage({
        type: "SYNC_PROGRESS",
        requestId,
        index: i,
        total: awemeIds.length,
        status: resp?.ok ? "ok" : "error",
        awemeId: awemeIds[i],
      })
      .catch(() => {});

    if (!cancelled) {
      const { BATCH_SIZE, BATCH_PAUSE_MIN, BATCH_PAUSE_MAX, KEEPALIVE_INTERVAL } = CONFIG.SYNC;
      if (BATCH_SIZE > 0 && (i + 1) % BATCH_SIZE === 0) {
        const batchPause = BATCH_PAUSE_MIN + Math.random() * (BATCH_PAUSE_MAX - BATCH_PAUSE_MIN);
        const deadline = Date.now() + batchPause;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, KEEPALIVE_INTERVAL));
          await chrome.storage.local.get("keepalive");
        }
      } else {
        const delay = CONFIG.DELAY.MIN + Math.random() * (CONFIG.DELAY.MAX - CONFIG.DELAY.MIN);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  chrome.runtime.onMessage.removeListener(cancelHandler);

  try {
    if (allWorks.length > 0) {
      const result = await mergeAndSaveWorks(allWorks);
      sendSyncDone(requestId, {
        ok: true,
        refreshed: result.added + result.updated,
        failed: errors.length,
        failedAwemeIds: errors.map((e) => e.awemeId).filter(Boolean),
      });
    } else {
      sendSyncDone(requestId, { ok: false, error: errors[0]?.error || "NO_WORKS_COLLECTED" });
    }
  } catch (err) {
    sendSyncDone(requestId, { ok: false, error: err.message });
  }
}

// ---------- 数据工具 ----------

async function reconcileImportGroups(domain, data, items) {
  const importedGroups = data.groups || [];
  if (importedGroups.length === 0) return;
  const groupsName = getGroupsName(domain);
  const def = getDefaultGroups(domain);
  const existingList = await storage.getGroups(groupsName);
  const existing = existingList.length ? existingList : def;
  const fixed = existing.filter((g) => g.fixed);
  const imported = importedGroups.filter((g) => !g.fixed);
  const existingIds = new Set(existing.map((g) => g.id));
  const existingNames = new Map(existing.map((g) => [g.name, g.id]));
  const groupIdMap = new Map();
  const newGroups = [];
  for (const g of imported) {
    if (existingIds.has(g.id)) {
      groupIdMap.set(g.id, g.id);
    } else if (existingNames.has(g.name)) {
      groupIdMap.set(g.id, existingNames.get(g.name));
    } else {
      newGroups.push(g);
      groupIdMap.set(g.id, g.id);
    }
  }
  const merged = [...fixed, ...existing.filter((g) => !g.fixed), ...newGroups];
  merged.forEach((g, i) => (g.order = i));
  await storage.putGroups(groupsName, merged);
  for (const item of items) {
    if (item.groupId && groupIdMap.has(item.groupId)) {
      item.groupId = groupIdMap.get(item.groupId);
    }
  }
}

async function handleImportData(data, domain, sendResponse) {
  try {
    const cfg = DOMAIN_CONFIG[domain];
    const items = extractImportItems(data, domain);
    if (Array.isArray(data.groups)) {
      await reconcileImportGroups(domain, data, items);
    }

    const groupsName = getGroupsName(domain);
    const def = getDefaultGroups(domain);
    const groupsList = await storage.getGroups(groupsName);
    const currentGroups = groupsList.length ? groupsList : def;
    const validGroupIds = new Set(currentGroups.map((g) => g.id));
    for (const item of items) {
      if (!validGroupIds.has(item.groupId)) item.groupId = CONFIG.GROUPS.DEFAULT_ID;
    }

    if (domain === CONFIG.STORAGE_KEYS.FOLLOWINGS) await handleSaveFollowings(items, sendResponse, true);
    else await handleSaveWorks(items, sendResponse);
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

async function handleExportData(domain, sendResponse) {
  try {
    const cfg = DOMAIN_CONFIG[domain];
    const items = await storage.getAll(cfg.storeName);
    const groups = await storage.getGroups(cfg.groupsName);
    const def = getDefaultGroups(domain);
    sendResponse({
      ok: true,
      data: {
        domain,
        exportedAt: new Date().toISOString(),
        [cfg.itemKey]: Object.values(items),
        groups: groups.length ? groups : def,
      },
    });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

async function handleResetDomain(domain, sendResponse) {
  try {
    const cfg = DOMAIN_CONFIG[domain];
    await storage.clear(cfg.storeName);
    await storage.putGroups(cfg.groupsName, cfg.defaultGroups);
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

async function handleGetStats(sendResponse) {
  try {
    const [works, followings, works_groups, followings_groups, est] = await Promise.all([
      storage.getAll(CONFIG.STORAGE_KEYS.WORKS),
      storage.getAll(CONFIG.STORAGE_KEYS.FOLLOWINGS),
      storage.getGroups(CONFIG.STORAGE_KEYS.WORKS_GROUPS),
      storage.getGroups(CONFIG.STORAGE_KEYS.FOLLOWINGS_GROUPS),
      storage.estimate(),
    ]);

    const bytes = est ? est.usage : 0;

    function buildDomainStats(items, groups) {
      const list = Object.values(items || {});
      const total = list.length;
      const groupCounts = { all: total };
      for (const g of groups || []) {
        if (g.id !== "all") groupCounts[g.id] = 0;
      }
      for (const item of list) {
        const gid = item.groupId;
        if (gid && gid in groupCounts) groupCounts[gid]++;
      }
      return { total, groupCounts };
    }

    sendResponse({
      ok: true,
      stats: {
        works: buildDomainStats(works, works_groups),
        followings: buildDomainStats(followings, followings_groups),
        bytes,
      },
    });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}
