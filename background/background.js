import { storage } from "./storage.js";
import { ABogus, parseCookieToPairs, generateRandomMsToken, md5Hex, MSSDK_STR_DATA } from "./crypto.js";

// ===== 抖音数据管理 - Background Service Worker =====

const CONFIG = {
  STORAGE_KEYS: {
    WORKS: "works",
    WORKS_GROUPS: "works_groups",
    FOLLOWINGS: "followings",
    FOLLOWINGS_GROUPS: "followings_groups",
    LIKES: "likes",
    LIKES_GROUPS: "likes_groups",
    FAVORITES: "favorites",
    FAVORITES_GROUPS: "favorites_groups",
  },
  DEFAULT_WORKS_GROUPS: [
    { id: "all", name: "全部", fixed: true },
    { id: "uncategorized", name: "未分组", fixed: true },
  ],
  DEFAULT_FOLLOWINGS_GROUPS: [
    { id: "all", name: "全部", fixed: true },
    { id: "uncategorized", name: "未分组", fixed: true },
  ],
  DEFAULT_LIKES_GROUPS: [
    { id: "all", name: "全部", fixed: true },
    { id: "uncategorized", name: "未分组", fixed: true },
  ],
  DEFAULT_FAVORITES_GROUPS: [
    { id: "all", name: "全部", fixed: true },
    { id: "uncategorized", name: "未分组", fixed: true },
  ],
  DNR_RULES: [
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
        resourceTypes: ["xmlhttprequest", "other"],
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
      // 收藏扫描（listcollection）是独立模式唯一的 POST 端点。POST 端点比 GET 更严格地
      // 校验「同源 fetch 元数据」：服务端要求 Sec-Fetch-Site: same-origin 等头，否则 403。
      // 关键点：真实同源请求【不会】携带 Origin 头（Origin 仅跨域请求才有），因此这里只补
      // Sec-Fetch-*，绝不可 set Origin —— same-origin + Origin 的非法组合会被抖音 WAF 拦截。
      // 标签页模式在 douyin.com 页面内发起请求天然携带这些头；SW 跨界请求被 rule 3 剥离，
      // 此规则（优先级更高）仅对 listcollection 补回 Sec-Fetch-*，与页面内/GET 行为一致。
      // Referer 同步对齐真实页面（收藏 tab）：请求由收藏页发起（参考项目同款 referer）。
      id: 4,
      priority: 2,
      condition: {
        urlFilter: "||douyin.com/aweme/v1/web/aweme/listcollection/",
        resourceTypes: ["xmlhttprequest", "other"],
        excludedInitiatorDomains: ["www.douyin.com", "douyin.com"],
      },
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Sec-Fetch-Site", operation: "set", value: "same-origin" },
          { header: "Sec-Fetch-Mode", operation: "set", value: "cors" },
          { header: "Sec-Fetch-Dest", operation: "set", value: "empty" },
          { header: "Accept-Language", operation: "set", value: "zh-CN,zh;q=0.9" },
          {
            header: "Referer",
            operation: "set",
            value: "https://www.douyin.com/user/self?showTab=favorite_collection",
          },
        ],
      },
    },
    {
      // 取消收藏 POST：与 rule 4 同理，独立模式 SW 跨界请求被 rule 3 剥离同源 fetch 元数据，
      // POST 端点会 403。提升到 priority 2 以覆盖 rule 3 的 remove，补回 Sec-Fetch-* + Accept-Language；
      // 同源请求不带 Origin，故不设 Origin。同时让精确 Referer（showTab=favorite_collection）真正生效
      // （原先与 rule 3 同优先级、低 id 被覆盖，实际一直用的是 rule 3 的 https://www.douyin.com/）。
      id: 5,
      priority: 2,
      condition: {
        urlFilter: "||douyin.com/aweme/v1/web/aweme/collect/",
        resourceTypes: ["xmlhttprequest"],
        excludedInitiatorDomains: ["www.douyin.com", "douyin.com"],
      },
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Sec-Fetch-Site", operation: "set", value: "same-origin" },
          { header: "Sec-Fetch-Mode", operation: "set", value: "cors" },
          { header: "Sec-Fetch-Dest", operation: "set", value: "empty" },
          { header: "Accept-Language", operation: "set", value: "zh-CN,zh;q=0.9" },
          {
            header: "Referer",
            operation: "set",
            value: "https://www.douyin.com/user/self?showTab=favorite_collection",
          },
        ],
      },
    },
    {
      // 取消点赞 POST：与 rule 5 同理，提升到 priority 2 覆盖 rule 3，补回 Sec-Fetch-* + Accept-Language（同源请求不带 Origin）；
      // 并使精确 Referer（showTab=like）真正生效。
      id: 6,
      priority: 2,
      condition: {
        urlFilter: "||douyin.com/aweme/v1/web/commit/item/digg/",
        resourceTypes: ["xmlhttprequest"],
        excludedInitiatorDomains: ["www.douyin.com", "douyin.com"],
      },
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Sec-Fetch-Site", operation: "set", value: "same-origin" },
          { header: "Sec-Fetch-Mode", operation: "set", value: "cors" },
          { header: "Sec-Fetch-Dest", operation: "set", value: "empty" },
          { header: "Accept-Language", operation: "set", value: "zh-CN,zh;q=0.9" },
          { header: "Referer", operation: "set", value: "https://www.douyin.com/user/self?showTab=like" },
        ],
      },
    },
    {
      // mssdk 兑换 msToken：SW 发起时 Origin 是 chrome-extension://...；且 fetch 的 headers
      // 里设 Referer 属 forbidden header，会被浏览器静默忽略。服务端校验这两头 → 拒签
      // （表现为 mintMsToken 拿不到 Set-Cookie，静默走随机兜底）。DNR 层直接改写为抖音
      // 页面同款值；排除 douyin 页面自身发起的兑换请求（页面 SDK 原生行为不动）。
      id: 7,
      priority: 1,
      condition: {
        urlFilter: "||mssdk.bytedance.com/",
        resourceTypes: ["xmlhttprequest", "other"],
        excludedInitiatorDomains: ["www.douyin.com", "douyin.com"],
      },
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Origin", operation: "set", value: "https://www.douyin.com" },
          { header: "Referer", operation: "set", value: "https://www.douyin.com/" },
        ],
      },
    },
  ],
  URL_BASE: "https://www.douyin.com",
  TIMEOUT: {
    REQUEST: 30000,
    SECURITY_STATUS: 5000,
  },
  DELAY: {
    syncWorks: { MIN: 500, MAX: 1000 },
    syncFollowings: { MIN: 500, MAX: 1000 },
    syncFavorites: { MIN: 500, MAX: 1000 },
    syncCollection: { MIN: 500, MAX: 1000 },
    cancelLike: { MIN: 500, MAX: 1000 },
    cancelCollection: { MIN: 500, MAX: 1000 },
  },
  SYNC: {
    BATCH_SIZE: 40,
    BATCH_PAUSE_MIN: 10000,
    BATCH_PAUSE_MAX: 20000,
    KEEPALIVE_INTERVAL: 2000,
    RETRY_MAX: 2,
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
  WEBID_API: "https://mcs.zijieapi.com/webid",
  WEBID_QUERY: "aid=6383&sdk_version=5.1.18_zip&device_platform=web",
  MSSDK: {
    API: "https://mssdk.bytedance.com/web/common",
    STR_DATA: MSSDK_STR_DATA,
  },
  AWEME_TYPE_NOTE: 68,
  API: {
    FOLLOWING: "/aweme/v1/web/user/following/list",
    PROFILE_OTHER: "/aweme/v1/web/user/profile/other/",
    FAVORITE: "/aweme/v1/web/aweme/favorite/",
    COLLECTION: "/aweme/v1/web/aweme/listcollection/",
    DETAIL: "/aweme/v1/web/aweme/detail/",
    POST: "/aweme/v1/web/aweme/post/",
  },
  // Argus webSign 策略盐（页面 secsdk 动态策略常量，实测跨会话稳定；若服务端
  // 更新策略版本导致换盐，独立模式收藏扫描将重新出现 Signature Not Found）
  WEB_SIGN_SALT: "A96D855A08C0A9707F8BEF0D9A527E4E",
  CANCEL: {
    // Tab 模式取消点赞走 inject XHR（CONFIG.CANCEL.LIKE_URL），此处 like 四要素仅供
    // handleIndependentCancel 的 kind 配置位；独立模式点赞取消在路由层显式拒绝（Turing/XHR 签名限制）
    like: {
      url: "https://www.douyin.com/aweme/v1/web/commit/item/digg/?aid=6383",
      body: (id) => "aweme_id=" + id + "&item_type=0&type=0",
      type: "application/x-www-form-urlencoded",
      referrer: "https://www.douyin.com/user/self?showTab=like",
    },
    collection: {
      url: "https://www.douyin.com/aweme/v1/web/aweme/collect/?aid=6383",
      body: (id) => "action=0&aweme_id=" + id + "&aweme_type=0",
      type: "application/x-www-form-urlencoded",
      referrer: "https://www.douyin.com/user/self?showTab=favorite_collection",
    },
  },
  DOUYIN_URL_PATTERN: "*://*.douyin.com/*",
  DOUYIN_EXCLUDE_DOMAIN: "creator.douyin.com",
  FATAL_ERRORS: new Set([
    "NO_DOUYIN_TAB",
    "TAB_QUERY_FAILED",
    "NO_LISTENER",
    "EMPTY_RESPONSE",
    "RATE_LIMITED",
    "CANCELLED",
  ]),
};

// ---------- 运行时配置（存储在 chrome.storage.local） ----------
const RUNTIME_CONFIG_KEY = "runtimeConfig";
const RUNTIME_CONFIG_DEFAULTS = {
  timeoutRequest: 30000,
  timeoutSecurityStatus: 5000,
  syncWorksDelayMin: 500,
  syncWorksDelayMax: 1000,
  syncFollowingsDelayMin: 500,
  syncFollowingsDelayMax: 1000,
  syncFavoritesDelayMin: 500,
  syncFavoritesDelayMax: 1000,
  syncCollectionDelayMin: 500,
  syncCollectionDelayMax: 1000,
  cancelLikeDelayMin: 500,
  cancelLikeDelayMax: 1000,
  cancelCollectionDelayMin: 500,
  cancelCollectionDelayMax: 1000,
  syncBatchSize: 40,
  syncBatchPauseMin: 10000,
  syncBatchPauseMax: 20000,
  syncKeepaliveInterval: 2000,
  syncRetryMax: 2,
  calibrateFollowings: true,
};

function getDelayRange(type) {
  const d = CONFIG.DELAY[type];
  if (d) return d;
  // fallback to syncWorks if type not found
  return CONFIG.DELAY.syncWorks || { MIN: 500, MAX: 1000 };
}

async function reloadRuntimeConfig() {
  const stored = await chrome.storage.local.get(RUNTIME_CONFIG_KEY);
  const cfg = stored[RUNTIME_CONFIG_KEY];
  if (!cfg) {
    await chrome.storage.local.set({ [RUNTIME_CONFIG_KEY]: { ...RUNTIME_CONFIG_DEFAULTS } });
    CONFIG.TIMEOUT.REQUEST = RUNTIME_CONFIG_DEFAULTS.timeoutRequest;
    CONFIG.TIMEOUT.SECURITY_STATUS = RUNTIME_CONFIG_DEFAULTS.timeoutSecurityStatus;
    CONFIG.DELAY.syncWorks = { MIN: RUNTIME_CONFIG_DEFAULTS.syncWorksDelayMin, MAX: RUNTIME_CONFIG_DEFAULTS.syncWorksDelayMax };
    CONFIG.DELAY.syncFollowings = { MIN: RUNTIME_CONFIG_DEFAULTS.syncFollowingsDelayMin, MAX: RUNTIME_CONFIG_DEFAULTS.syncFollowingsDelayMax };
    CONFIG.DELAY.syncFavorites = { MIN: RUNTIME_CONFIG_DEFAULTS.syncFavoritesDelayMin, MAX: RUNTIME_CONFIG_DEFAULTS.syncFavoritesDelayMax };
    CONFIG.DELAY.syncCollection = { MIN: RUNTIME_CONFIG_DEFAULTS.syncCollectionDelayMin, MAX: RUNTIME_CONFIG_DEFAULTS.syncCollectionDelayMax };
    CONFIG.DELAY.cancelLike = { MIN: RUNTIME_CONFIG_DEFAULTS.cancelLikeDelayMin, MAX: RUNTIME_CONFIG_DEFAULTS.cancelLikeDelayMax };
    CONFIG.DELAY.cancelCollection = { MIN: RUNTIME_CONFIG_DEFAULTS.cancelCollectionDelayMin, MAX: RUNTIME_CONFIG_DEFAULTS.cancelCollectionDelayMax };
    CONFIG.SYNC.BATCH_SIZE = RUNTIME_CONFIG_DEFAULTS.syncBatchSize;
    CONFIG.SYNC.BATCH_PAUSE_MIN = RUNTIME_CONFIG_DEFAULTS.syncBatchPauseMin;
    CONFIG.SYNC.BATCH_PAUSE_MAX = RUNTIME_CONFIG_DEFAULTS.syncBatchPauseMax;
    CONFIG.SYNC.KEEPALIVE_INTERVAL = RUNTIME_CONFIG_DEFAULTS.syncKeepaliveInterval;
    CONFIG.SYNC.RETRY_MAX = RUNTIME_CONFIG_DEFAULTS.syncRetryMax;
    _calibrateFollowings = RUNTIME_CONFIG_DEFAULTS.calibrateFollowings;
    return;
  }
  CONFIG.TIMEOUT.REQUEST = cfg.timeoutRequest ?? CONFIG.TIMEOUT.REQUEST;
  CONFIG.TIMEOUT.SECURITY_STATUS = cfg.timeoutSecurityStatus ?? CONFIG.TIMEOUT.SECURITY_STATUS;
  CONFIG.DELAY.syncWorks = { MIN: cfg.syncWorksDelayMin ?? CONFIG.DELAY.syncWorks.MIN, MAX: cfg.syncWorksDelayMax ?? CONFIG.DELAY.syncWorks.MAX };
  CONFIG.DELAY.syncFollowings = { MIN: cfg.syncFollowingsDelayMin ?? CONFIG.DELAY.syncFollowings.MIN, MAX: cfg.syncFollowingsDelayMax ?? CONFIG.DELAY.syncFollowings.MAX };
  CONFIG.DELAY.syncFavorites = { MIN: cfg.syncFavoritesDelayMin ?? CONFIG.DELAY.syncFavorites.MIN, MAX: cfg.syncFavoritesDelayMax ?? CONFIG.DELAY.syncFavorites.MAX };
  CONFIG.DELAY.syncCollection = { MIN: cfg.syncCollectionDelayMin ?? CONFIG.DELAY.syncCollection.MIN, MAX: cfg.syncCollectionDelayMax ?? CONFIG.DELAY.syncCollection.MAX };
  CONFIG.DELAY.cancelLike = { MIN: cfg.cancelLikeDelayMin ?? CONFIG.DELAY.cancelLike.MIN, MAX: cfg.cancelLikeDelayMax ?? CONFIG.DELAY.cancelLike.MAX };
  CONFIG.DELAY.cancelCollection = { MIN: cfg.cancelCollectionDelayMin ?? CONFIG.DELAY.cancelCollection.MIN, MAX: cfg.cancelCollectionDelayMax ?? CONFIG.DELAY.cancelCollection.MAX };
  CONFIG.SYNC.BATCH_SIZE = cfg.syncBatchSize ?? CONFIG.SYNC.BATCH_SIZE;
  CONFIG.SYNC.BATCH_PAUSE_MIN = cfg.syncBatchPauseMin ?? CONFIG.SYNC.BATCH_PAUSE_MIN;
  CONFIG.SYNC.BATCH_PAUSE_MAX = cfg.syncBatchPauseMax ?? CONFIG.SYNC.BATCH_PAUSE_MAX;
  CONFIG.SYNC.KEEPALIVE_INTERVAL = cfg.syncKeepaliveInterval ?? CONFIG.SYNC.KEEPALIVE_INTERVAL;
  CONFIG.SYNC.RETRY_MAX = cfg.syncRetryMax ?? CONFIG.SYNC.RETRY_MAX;
  _calibrateFollowings = cfg.calibrateFollowings ?? true;
}

// ---------- 模块级常量 ----------
let abOgus = null;
let cachedClockSkew = 0;
let clockSkewTime = 0;
let _independentMode = false;
let _independentModeLoaded = false;
let _calibrateFollowings = true;

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
  [CONFIG.STORAGE_KEYS.LIKES]: {
    storeName: CONFIG.STORAGE_KEYS.LIKES,
    groupsName: CONFIG.STORAGE_KEYS.LIKES_GROUPS,
    defaultGroups: CONFIG.DEFAULT_LIKES_GROUPS,
    itemKey: CONFIG.STORAGE_KEYS.LIKES,
    idField: "awemeId",
  },
  [CONFIG.STORAGE_KEYS.FAVORITES]: {
    storeName: CONFIG.STORAGE_KEYS.FAVORITES,
    groupsName: CONFIG.STORAGE_KEYS.FAVORITES_GROUPS,
    defaultGroups: CONFIG.DEFAULT_FAVORITES_GROUPS,
    itemKey: CONFIG.STORAGE_KEYS.FAVORITES,
    idField: "awemeId",
  },
};

async function ensureABogus() {
  const { browserFeatures } = await chrome.storage.local.get("browserFeatures");
  const f = browserFeatures || {};
  abOgus = new ABogus(f.userAgent || navigator.userAgent, f.platform || navigator.platform, f);
}

async function loadIndependentMode() {
  if (!_independentModeLoaded) {
    const { independentMode } = await chrome.storage.local.get("independentMode");
    _independentMode = independentMode === true;
    _independentModeLoaded = true;
  }
  return _independentMode;
}

function setIndependentMode(enabled) {
  _independentMode = enabled === true;
  _independentModeLoaded = true;
}

async function getClockSkew() {
  if (Date.now() - clockSkewTime < 300000) return cachedClockSkew;
  try {
    const t0 = Date.now();
    const resp = await fetch("https://www.douyin.com/", { method: "HEAD", cache: "no-store" });
    const date = resp.headers.get("Date");
    if (date) {
      const serverTime = new Date(date).getTime();
      const t1 = Date.now();
      cachedClockSkew = serverTime - Math.round((t0 + t1) / 2);
    }
  } catch {}
  clockSkewTime = Date.now();
  return cachedClockSkew;
}

async function resolveSelfSecUid() {
  let uid = "";
  try {
    const cookies = await chrome.cookies.getAll({ domain: "douyin.com", name: "uid" });
    uid = cookies[0]?.value || "";
  } catch {}

  if (!uid) {
    const { savedCookie } = await chrome.storage.local.get("savedCookie");
    if (savedCookie) {
      for (const pair of savedCookie.split(";")) {
        const trimmed = pair.trim();
        const idx = trimmed.indexOf("=");
        if (idx > 0 && trimmed.slice(0, idx).toLowerCase() === "uid") {
          uid = trimmed.slice(idx + 1);
          break;
        }
      }
    }
  }

  if (!uid) return "";

  try {
    const data = await independentRequest("/aweme/v1/web/im/user/info/", await buildBaseParams(), {
      method: "POST",
      body: JSON.stringify({ sec_user_ids: [uid] }),
    });
    const users = data.data?.users || data.users || (Array.isArray(data.data) ? data.data : []);
    for (const u of users) {
      if (u.sec_uid) return u.sec_uid;
    }
  } catch (e) {
    console.warn("[DY] resolveSelfSecUid failed:", e.message);
  }
  return "";
}

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

// 通过 mssdk 静态载荷兑换真 msToken（参考 TikTokDownloader src/encrypt/msToken.py）。
// 抖音页面 SDK 现走同一机制：签发的 cookie 落在 bytedance.com 域，douyin.com jar 里
// 本来就没有 msToken；而随机兜底 token 服务端不认，严格端点（listcollection POST）会 403。
// SW 的 fetch 读不到 Set-Cookie：先删 jar 旧值，POST 后从 bytedance.com jar 读回新签发的值。
async function mintMsToken() {
  try {
    const stale = await chrome.cookies.getAll({ domain: "bytedance.com", name: "msToken" });
    if (stale.length > 0) {
      await chrome.cookies.remove({ url: "https://mssdk.bytedance.com/", name: "msToken" });
    }
    const resp = await fetch(CONFIG.MSSDK.API, {
      method: "POST",
      credentials: "include",
      // Referer 不能放 headers（forbidden header，静默忽略）：用 referrer 选项 + rule 7
      // DNR set 双保险。Origin 由 rule 7 改写为 douyin 同款。
      referrer: "https://www.douyin.com/",
      referrerPolicy: "unsafe-url",
      headers: {
        Accept: "*/*",
        "Content-Type": "text/plain;charset=UTF-8",
      },
      body: JSON.stringify({
        magic: 538969122,
        version: 1,
        dataType: 8,
        strData: CONFIG.MSSDK.STR_DATA,
        tspFromClient: Date.now(),
        ulr: 0,
      }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.warn("[DY] mint msToken: HTTP", resp.status, text.trim().slice(0, 120));
      return "";
    }
    const fresh = await chrome.cookies.getAll({ domain: "bytedance.com", name: "msToken" });
    return fresh[0]?.value || "";
  } catch (e) {
    console.warn("[DY] mint msToken failed:", e?.message);
    return "";
  }
}

async function getMsToken() {
  const { savedMsToken } = await chrome.storage.local.get("savedMsToken");
  if (savedMsToken) return savedMsToken;
  let msToken = await fetchMsToken();
  if (!msToken) {
    msToken = await mintMsToken();
    console.info("[DY] msToken: mssdk 兑换" + (msToken ? "成功" : "失败"));
  }
  if (!msToken) {
    console.warn("[DY] msToken: 使用随机兜底（严格端点可能 403）");
    msToken = generateRandomMsToken();
  }
  await chrome.storage.local.set({ savedMsToken: msToken, savedMsTokenTime: Date.now() });
  return msToken;
}

async function fetchWebIdFromApi() {
  try {
    const ua = abOgus ? abOgus.userAgent : navigator.userAgent;
    const resp = await fetch(CONFIG.WEBID_API + "?" + CONFIG.WEBID_QUERY, {
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
    return String(data.web_id || "");
  } catch {
    return "";
  }
}

async function syncWebIdCookie(webid) {
  if (!webid) return;
  try {
    await chrome.cookies.set({
      url: "https://www.douyin.com/",
      name: "webid",
      value: webid,
      domain: "douyin.com",
      path: "/",
      secure: true,
      sameSite: "no_restriction",
      expirationDate: Math.floor(Date.now() / 1000) + 365 * 86400,
    });
  } catch (e) {
    console.warn("[DY] sync webid cookie failed:", e.message);
  }
}

async function getWebId() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: "douyin.com", name: "webid" });
    const cookieWebId = cookies[0]?.value || "";
    if (cookieWebId) {
      const { savedWebId } = await chrome.storage.local.get("savedWebId");
      if (savedWebId !== cookieWebId) {
        await chrome.storage.local.set({ savedWebId: cookieWebId, savedWebIdTime: Date.now() });
      }
      return cookieWebId;
    }
  } catch {}
  const { savedWebId } = await chrome.storage.local.get("savedWebId");
  if (savedWebId) return savedWebId;
  const webid = await fetchWebIdFromApi();
  if (webid) {
    await chrome.storage.local.set({ savedWebId: webid, savedWebIdTime: Date.now() });
    await syncWebIdCookie(webid);
  }
  return webid;
}

async function refreshWebIdChain() {
  await chrome.storage.local.remove(["savedWebId", "savedWebIdTime"]);
  const webid = await fetchWebIdFromApi();
  if (webid) {
    await chrome.storage.local.set({ savedWebId: webid, savedWebIdTime: Date.now() });
    await syncWebIdCookie(webid);
  }
  return webid;
}

async function buildBaseParams(extra = {}) {
  const bf = (await chrome.storage.local.get("browserFeatures")).browserFeatures || {};
  const [webid, { savedCookie }] = await Promise.all([getWebId(), chrome.storage.local.get("savedCookie")]);
  let uifid = "",
    odin_tt = "";
  // odin_tt / uifid 必须来自「当前登录会话」的 Cookie，否则签名虽正确但与服务端
  // 校验用的会话参数不一致 → 403 sign invalid。优先读实时浏览器 Cookie，避免
  // savedCookie 缓存滞后（用户刷新过浏览器登录但扩展缓存仍是旧 odin_tt）。
  try {
    const liveCookies = await chrome.cookies.getAll({ domain: "douyin.com" });
    const cmap = {};
    for (const c of liveCookies) cmap[c.name] = c.value;
    if (cmap["UIFID"]) uifid = cmap["UIFID"];
    if (cmap["odin_tt"]) odin_tt = cmap["odin_tt"];
  } catch {}
  if (!uifid && savedCookie) {
    const mu = savedCookie.match(/\bUIFID=([^;]+)/);
    if (mu) uifid = mu[1];
  }
  if (!odin_tt && savedCookie) {
    const mo = savedCookie.match(/\bodin_tt=([^;]+)/);
    if (mo) odin_tt = mo[1];
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
    round_trip_time: "200",
    whale_cut_token: "",
    cut_version: "1",
    update_version_code: "290100",
    pc_libra_divert: "Windows",
    support_h265: "0",
    support_dash: "1",
    webid,
    uifid,
    ...(odin_tt ? { odin_tt } : {}),
    ...extra,
  };
}

// 抖音服务端验证 a_bogus 时仅剥离 a_bogus 自身、对“完整查询串”做哈希，
// 因此签名必须基于与最终 URL 完全一致（仅缺 a_bogus）的查询串，键顺序也需一致。
// 注意：msToken / uifid / odin_tt 等 SDK 注入键也参与签名（实测真实 a_bogus
// 的 pa 段与“含这些键的完整查询串”逐字节吻合），绝不能剔除。
async function independentRequest(apiPath, params, options = {}) {
  const { savedCookie } = await chrome.storage.local.get("savedCookie");
  if (!savedCookie) throw new Error("NO_COOKIE");
  params.msToken = await getMsToken();
  const method = options.method || "GET";
  // qs 即实际发送的查询串（含 msToken/uifid/odin_tt，不含 a_bogus），顺序与 URL 一致
  const qs = new URLSearchParams(params).toString();
  const a_bogus = abOgus.getValue(qs, method, await getClockSkew());
  // Argus webSign（与页面 window.use("webSignUrl") 同款算法）：
  // sig = md5(uifid + "_" + ts + "_" + SALT + "_" + 待签查询串)，其中待签查询串 =
  // 最终发送的完整 query 去掉 x-secsdk-web-signature 自身（含 a_bogus 与 timestamp）；
  // 同时随请求携带 uifid / x-secsdk-web-signature / x-secsdk-web-expire 头。
  let urlQuery = qs + "&a_bogus=" + a_bogus;
  const webSignHeaders = {};
  if (options.webSign) {
    const uifid = String(params.uifid || "");
    if (uifid) {
      const tsSec = Math.floor((Date.now() + (await getClockSkew())) / 1000);
      urlQuery += "&timestamp=" + tsSec;
      const sig = md5Hex(uifid + "_" + tsSec + "_" + CONFIG.WEB_SIGN_SALT + "_" + urlQuery);
      urlQuery += "&x-secsdk-web-signature=" + sig;
      webSignHeaders.uifid = uifid;
      webSignHeaders["x-secsdk-web-signature"] = sig;
      webSignHeaders["x-secsdk-web-expire"] = String(tsSec);
    }
  }
  const url = CONFIG.URL_BASE + apiPath + "?" + urlQuery;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), options.timeout || CONFIG.TIMEOUT.REQUEST);
  try {
    const resp = await fetch(url, {
      credentials: "include",
      referrer: options.referrer || "https://www.douyin.com/",
      referrerPolicy: "unsafe-url",
      headers: {
        Accept: "application/json, text/plain, */*",
        "User-Agent": abOgus ? abOgus.userAgent : navigator.userAgent,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...webSignHeaders,
        ...options.headers,
      },
      method,
      body: options.body,
      signal: controller.signal,
    });
    clearTimeout(tid);
    const argusCode = resp.headers.get("argus_security_code") || "";
    if (!resp.ok) {
      let bodyText = "";
      try { bodyText = (await resp.text()).trim().slice(0, 160); } catch {}
      const signInvalid = argusCode === "web_id_sign_invalid" || (resp.status === 403 && /sign invalid/i.test(bodyText));
      if (signInvalid && !options._webIdRetried) {
        console.warn("[DY] a_bogus rejected (web_id_sign_invalid), refreshing webid and retrying", apiPath);
        const freshWebId = await refreshWebIdChain();
        if (freshWebId) params.webid = freshWebId;
        return independentRequest(apiPath, params, { ...options, _webIdRetried: true });
      }
      throw new Error(bodyText ? `HTTP_${resp.status}: ${bodyText}` : `HTTP_${resp.status}`);
    }
    const data = await resp.json();
    if (data.status_code !== undefined && data.status_code !== 0) {
      console.warn("[DY] API_ERROR status_code=%s url=%s", data.status_code, apiPath);
      throw new Error("API_ERROR");
    }
    return data;
  } catch (e) {
    clearTimeout(tid);
    throw e;
  }
}

function parseExpire(value) {
  const n = Number(value);
  if (!isFinite(n) || n <= 0) return null;
  if (n > 1e11) return n > 1e13 ? null : n; // 毫秒时间戳
  if (n > 1e9) return n * 1000; // 秒时间戳
  if (n <= 86400 * 30) return Date.now() + n * 1000; // 剩余秒数
  return null;
}

function urlExpireAt(url) {
  try {
    const abs = url.startsWith("//") ? "https:" + url : url;
    const sp = new URL(abs).searchParams;
    // 键名含 expire（大小写不敏感）的参数优先，兼容 expire/x-expires/expires 等变体
    for (const key of sp.keys()) {
      if (/expire/i.test(key)) {
        const at = parseExpire(sp.get(key));
        if (at != null) return at;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// 长效 ID 型播放链接（与推荐页手动"添加"按钮存的同款）：无 expire 参数，
// 访问时由服务端 302 到即时签名的 douyinvod 地址。注意部分 douyinvod 短效直链
// 的过期时间藏在路径段里（/<sig>/<8位hex过期秒>），query 里查不到。
function isLongLivedVideoUrl(u) {
  return typeof u === "string" && /\/\/www\.douyin\.com\/aweme\/v1\/play\/\?/.test(u);
}

function formatWork(aw) {
  if (!aw || !aw.aweme_id) return null;
  const author = aw.author || aw.author_info || {};
  const video = aw.video || {};
  const bitRate = Array.isArray(video.bit_rate) ? video.bit_rate : [];
  // 候选集：各码率 play_addr.url_list 全部项；无码率候选时兜底 video.play_addr.url_list
  const cands = [];
  for (const br of bitRate) {
    if (br.is_h265) continue;
    const addr = br.play_addr || {};
    const h = addr.height || 0;
    for (const u of Array.isArray(addr.url_list) ? addr.url_list : []) {
      if (u) cands.push({ url: u, height: h, expireAt: urlExpireAt(u) });
    }
  }
  if (cands.length === 0) {
    for (const u of (video.play_addr && video.play_addr.url_list) || []) {
      if (u) cands.push({ url: u, height: 0, expireAt: urlExpireAt(u) });
    }
  }
  // 长效候选优先：bit_rate[].playApi（手动"添加"按钮同款），缺失时用最高清档
  // play_addr.uri 合成裸 video_id 形态（实测服务端认、访问即 302 到新签直链）。
  // CDN url_list 直链仅作兜底——预签名短效，几小时即过期。
  const rates = bitRate.filter((br) => !br.is_h265);
  const longs = [];
  for (const br of rates) {
    const api = String(br.playApi || "");
    if (!api) continue;
    longs.push({
      url: /^https?:\/\//i.test(api) ? api : CONFIG.URL_BASE + (api.startsWith("/") ? "" : "/") + api,
      height: (br.play_addr && br.play_addr.height) || 0,
    });
  }
  if (longs.length === 0) {
    const bestBr = rates.reduce(
      (a, b) => (((b.play_addr || {}).height || 0) > (((a || {}).play_addr || {}).height || 0) ? b : a),
      null,
    );
    const uri =
      ((bestBr || {}).play_addr || {}).uri ||
      (video.play_addr && video.play_addr.uri) ||
      "";
    if (uri) {
      longs.push({
        url:
          CONFIG.URL_BASE +
          "/aweme/v1/play/?video_id=" +
          encodeURIComponent(uri) +
          "&aid=6383&is_play_url=1&line=0",
        height: ((bestBr || {}).play_addr || {}).height || 0,
      });
    }
  }
  let videoUrl = "";
  let videoExpireAt = 0;
  if (longs.length > 0) {
    // ID 型链接无时效参数，videoExpireAt 保持 0（长效/未知）
    const maxH = Math.max(...longs.map((c) => c.height));
    videoUrl = (longs.find((c) => c.height === maxH) || longs[0]).url;
  } else if (cands.length > 0) {
    // 先取最高清档，档内比较 expireAt 取最长者；全解析失败则取档内第一项（与原逻辑一致）
    const maxH = Math.max(...cands.map((c) => c.height));
    const top = cands.filter((c) => c.height === maxH);
    let best = top[0];
    for (const c of top) {
      if (c.expireAt != null && (best.expireAt == null || c.expireAt > best.expireAt)) best = c;
    }
    videoUrl = best.url;
    videoExpireAt = best.expireAt || 0;
  }
  videoUrl = videoUrl.replace(/^http:/, "");
  const authorFollowed =
    "follow_status" in author
      ? author.follow_status === 1 || author.follow_status === 2
      : "followStatus" in author
        ? author.followStatus === 1 || author.followStatus === 2
        : null;
  return {
    awemeId: String(aw.aweme_id),
    type: (aw.aweme_type || aw.awemeType) === CONFIG.AWEME_TYPE_NOTE ? "note" : "video",
    desc: aw.desc || "",
    nickname: String(author.nickname || author.nickName || ""),
    uid: String(author.uid || ""),
    authorHomeUrl: author.sec_uid ? CONFIG.URL_BASE + "/user/" + author.sec_uid : "",
    cover: ((video.cover && video.cover.url_list) || [])[0] ? video.cover.url_list[0].replace(/^http:/, "") : "",
    video: videoUrl,
    videoExpireAt,
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
    // 粉丝/作品数不再取自关注列表（滞后快照），字段占位为 0，仅由 profile/other 校准写入
    followerCount: 0,
    awemeCount: 0,
    profileUrl: CONFIG.URL_BASE + "/user/" + (item.sec_uid || ""),
  };
}

// ---------- 独立模式 handler ----------

async function handleIndependentFetchFollowing(secUid, sendResponse) {
  try {
    await ensureABogus();
    if (secUid === "self" || !secUid) {
      const { secUid: stored } = await chrome.storage.local.get("secUid");
      if (stored && stored !== "self") secUid = stored;
      else secUid = await resolveSelfSecUid();
      if (!secUid) return sendResponse({ ok: false, error: "NO_SEC_UID" });
    }
    let userId = "";
    try {
      const cookies = await chrome.cookies.getAll({ domain: "douyin.com", name: "uid" });
      userId = cookies[0]?.value || "";
    } catch {}
    if (!userId) {
      const { savedCookie } = await chrome.storage.local.get("savedCookie");
      if (savedCookie) {
        for (const pair of savedCookie.split(";")) {
          const trimmed = pair.trim();
          const idx = trimmed.indexOf("=");
          if (idx > 0 && trimmed.slice(0, idx).toLowerCase() === "uid") {
            userId = trimmed.slice(idx + 1);
            break;
          }
        }
      }
    }
    const requestId = crypto.randomUUID();
    let cancelled = false,
      hasMore = true,
      offset = 0;
    const all = [];
    const seen = new Set();
    const cancelHandler = (msg) => {
      if (msg.type === "CANCEL_ACTIVE_TASK") cancelled = true;
    };
    chrome.runtime.onMessage.addListener(cancelHandler);
    while (hasMore && !cancelled) {
      const params = { sec_user_id: secUid, count: String(CONFIG.PAGE.FOLLOWING), offset: String(offset), min_time: "0", max_time: "0", source_type: "4", gps_access: "0", address_book_access: "0", is_top: "1" };
      if (userId) params.user_id = userId;
      const data = await independentRequest(CONFIG.API.FOLLOWING, await buildBaseParams(params));
      if (data.status_code === 0 && Array.isArray(data.followings)) {
        if (data.followings.length === 0) break;
        const newItems = data.followings.filter((item) => !seen.has(String(item.uid)));
        if (newItems.length === 0) break;
        newItems.forEach((item) => seen.add(String(item.uid)));
        all.push(...newItems.map(formatFollowing));
        hasMore = data.has_more === true || data.has_more === 1;
        if (data.total > 0 && all.length >= data.total) hasMore = false;
        offset += CONFIG.PAGE.FOLLOWING;
      } else break;
      chrome.runtime
        .sendMessage({ type: "FOLLOWING_PROGRESS", collected: all.length, hasMore, total: data.total || 0, requestId })
        .catch(() => {});
      if (hasMore && !cancelled)
        await new Promise((r) =>
          setTimeout(r, getDelayRange("syncFollowings").MIN + Math.random() * (getDelayRange("syncFollowings").MAX - getDelayRange("syncFollowings").MIN)),
        );
    }
    if (!cancelled && all.length > 0 && _calibrateFollowings) {
      await calibrateFollowingStats(
        all,
        async (secUid) => {
          const data = await independentRequest(
            CONFIG.API.PROFILE_OTHER,
            await buildBaseParams({ sec_user_id: secUid }),
          );
          if (!data.user) throw new Error("PROFILE_FETCH_FAILED");
          return {
            awemeCount: data.user.aweme_count || 0,
            followerCount: data.user.follower_count || 0,
          };
        },
        () => cancelled,
        requestId,
      );
    }
    chrome.runtime.onMessage.removeListener(cancelHandler);
    sendResponse({ ok: true, requestId, followings: all, total: all.length });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
}

async function handleIndependentFetchCollection(persist, sendResponse) {
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
      // 参考项目 TikTokDownloader 同端点形态：环境参数走 query，count/cursor 走 urlencoded
      // body —— 空 body 的 POST 会被服务端 Argus 以 Signature Not Found 拒绝；身份由
      // Cookie 决定，query/body 均不带 sec_user_id（参考项目同样不传）。
      const data = await independentRequest(
        CONFIG.API.COLLECTION,
        await buildBaseParams({}),
        {
          method: "POST",
          webSign: true,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ count: String(CONFIG.PAGE.COLLECTION), cursor: String(cursor) }).toString(),
          referrer: "https://www.douyin.com/user/self?showTab=favorite_collection",
        },
      );
      if (data.status_code === 0 && Array.isArray(data.aweme_list)) {
        if (data.aweme_list.length === 0) break;
        all.push(...data.aweme_list.map(formatWork).filter(Boolean));
        hasMore = data.has_more === true || data.has_more === 1;
        cursor = data.cursor || data.max_cursor || cursor + CONFIG.PAGE.COLLECTION;
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
          setTimeout(r, getDelayRange("syncFollowings").MIN + Math.random() * (getDelayRange("syncFollowings").MAX - getDelayRange("syncFollowings").MIN)),
        );
    }
    chrome.runtime.onMessage.removeListener(cancelHandler);
    const { saved, lostUids } = await persistScanResults(persist, all, cancelled);
    sendResponse({ ok: true, requestId, works: all, timedOut: cancelled, saved, lostUids });
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
      let currentOk = true;
      try {
        const params = await buildBaseParams({ aweme_id: awemeIds[i], request_source: "600", origin_type: "video_page" });
        let data, w;
        for (let attempt = 0; attempt < CONFIG.SYNC.RETRY_MAX; attempt++) {
          data = await independentRequest(CONFIG.API.DETAIL, params);
          w = data.aweme_detail ? formatWork(data.aweme_detail) : null;
          if (w) break;
          if (attempt === 0) {
            const d = getDelayRange("syncWorks");
            await new Promise((r) => setTimeout(r, d.MIN + Math.random() * (d.MAX - d.MIN)));
          }
        }
        if (w) allWorks.push(w);
        else { errors.push({ awemeId: awemeIds[i], error: "DELETED" }); currentOk = false; }
      } catch (e) {
        errors.push({ awemeId: awemeIds[i], error: e.message });
        currentOk = false;
      }
      chrome.runtime
        .sendMessage({
          type: "SYNC_PROGRESS",
          requestId,
          index: i,
          total: awemeIds.length,
          status: currentOk ? "ok" : "error",
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
          const d = getDelayRange("syncWorks");
          await new Promise((r) =>
            setTimeout(r, d.MIN + Math.random() * (d.MAX - d.MIN)),
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
      CONFIG.API.POST,
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
    await chrome.storage.local.set({ browserFeatures: message.features, browserFeaturesTime: Date.now() });
    abOgus = new ABogus(
      message.features.userAgent || navigator.userAgent,
      message.features.platform || navigator.platform,
      message.features,
    );
  }
  sendResponse({ ok: true });
}

async function handleSetMode(message, sendResponse) {
  await chrome.storage.local.set({ independentMode: message.enabled === true });
  setIndependentMode(message.enabled);
  if (message.enabled) await ensureABogus();
  sendResponse({ ok: true });
}

// STORAGE_KEYS 作为 store/group 名的唯一常量来源

// ---------- 初始化 ----------
async function setupDeclarativeNetRequest() {
  const rules = CONFIG.DNR_RULES;

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
  try {
    await setupDeclarativeNetRequest();
    await loadIndependentMode();
    await reloadRuntimeConfig();

    const worksGroups = await storage.getGroups(CONFIG.STORAGE_KEYS.WORKS_GROUPS);
    if (!worksGroups.length) {
      await storage.putGroups(CONFIG.STORAGE_KEYS.WORKS_GROUPS, CONFIG.DEFAULT_WORKS_GROUPS);
    }

    const followingsGroups = await storage.getGroups(CONFIG.STORAGE_KEYS.FOLLOWINGS_GROUPS);
    if (!followingsGroups.length) {
      await storage.putGroups(CONFIG.STORAGE_KEYS.FOLLOWINGS_GROUPS, CONFIG.DEFAULT_FOLLOWINGS_GROUPS);
    }

    const likesGroups = await storage.getGroups(CONFIG.STORAGE_KEYS.LIKES_GROUPS);
    if (!likesGroups.length) {
      await storage.putGroups(CONFIG.STORAGE_KEYS.LIKES_GROUPS, CONFIG.DEFAULT_LIKES_GROUPS);
    }

    const favoritesGroups = await storage.getGroups(CONFIG.STORAGE_KEYS.FAVORITES_GROUPS);
    if (!favoritesGroups.length) {
      await storage.putGroups(CONFIG.STORAGE_KEYS.FAVORITES_GROUPS, CONFIG.DEFAULT_FAVORITES_GROUPS);
    }
  } catch (e) {
    console.warn("[DY] onInstalled partial failure:", e.message);
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

// domainStorage: 封装 DOMAIN_CONFIG，让调用者只需传 domain 名称，避免硬编码 store 名
function domainStorage(domain) {
  const cfg = DOMAIN_CONFIG[domain];
  if (!cfg) throw new Error("Unknown domain: " + domain);
  return {
    getAll: () => storage.getAll(cfg.storeName),
    get: (key) => storage.get(cfg.storeName, key),
    putBatch: (items) => storage.putBatch(cfg.storeName, items),
    deleteBatch: (keys) => storage.deleteBatch(cfg.storeName, keys),
    count: () => storage.count(cfg.storeName),
    countByGroup: (groupId) => storage.countByIndex(cfg.storeName, "groupId", groupId),
    getByGroup: (groupId) => storage.getByIndex(cfg.storeName, "groupId", groupId),
    clear: () => storage.clear(cfg.storeName),
    getGroups: () => storage.getGroups(cfg.groupsName),
    putGroups: (groups) => storage.putGroups(cfg.groupsName, groups),
    getDefaultGroups: () => cfg.defaultGroups,
    idField: cfg.idField,
    itemKey: cfg.itemKey,
  };
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
const likesHandlers = createDomainHandlers(CONFIG.STORAGE_KEYS.LIKES);
const favoritesHandlers = createDomainHandlers(CONFIG.STORAGE_KEYS.FAVORITES);

function extractImportItems(data, domain) {
  const cfg = DOMAIN_CONFIG[domain];
  if (data[cfg.itemKey] && Array.isArray(data[cfg.itemKey])) return data[cfg.itemKey];
  return [];
}

function mergeWork(w, old) {
  const merged = {
    ...w,
    groupId: old?.groupId || w.groupId || CONFIG.GROUPS.DEFAULT_ID,
    savedAt: old?.savedAt || w.savedAt || Date.now(),
  };
  // 旧记录已存长效 v1/play 链接而新结果是短效 CDN 直链 → 保留旧链接，
  // 避免手动添加的作品被同步以短效直链覆盖降级
  if (old && isLongLivedVideoUrl(old.video) && !isLongLivedVideoUrl(w.video)) {
    merged.video = old.video;
    merged.videoExpireAt = old.videoExpireAt || 0;
  }
  return merged;
}

async function mergeAndSaveWorks(works) {
  return mergeAndSaveDomainWorks(CONFIG.STORAGE_KEYS.WORKS, works);
}

// 作品型三域（works/likes/favorites）共用的合并落库：mergeWork 三项保护 + 长效链降级防护
async function mergeAndSaveDomainWorks(domain, works) {
  const ds = domainStorage(domain);
  const valid = (works || []).filter((w) => w && w[ds.idField]);
  if (valid.length === 0) return { added: 0, updated: 0, total: await ds.count() };

  const oldItems = await Promise.all(
    valid.map((w) => ds.get(w[ds.idField]).then((old) => ({ w, old }))),
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
  await ds.putBatch(toWrite);

  const totalCount = await ds.count();
  return { added, updated, total: totalCount };
}

function sendSyncDone(requestId, result) {
  chrome.runtime
    .sendMessage({ type: "SYNC_DONE", requestId, ...result })
    .catch((e) => console.warn("[DY] sync done send failed:", e));
}

async function withDouyinTab() {
  const tabs = await chrome.tabs.query({ url: CONFIG.DOUYIN_URL_PATTERN });
  const tab = tabs.find((t) => t.url && !t.url.includes(CONFIG.DOUYIN_EXCLUDE_DOMAIN) && t.status === "complete");
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

    // 点赞域
    case "SAVE_LIKES":
      return asyncHandler(() => likesHandlers.save(message.likes, sendResponse), sendResponse);
    case "GET_LIKES":
      return asyncHandler(() => likesHandlers.get(message.groupId, sendResponse), sendResponse);
    case "DELETE_LIKES":
      return asyncHandler(() => likesHandlers.delete(message.awemeIds, sendResponse), sendResponse);
    case "MOVE_LIKES":
      return asyncHandler(
        () => likesHandlers.move(message.awemeIds, message.targetGroupId, sendResponse),
        sendResponse,
      );

    // 收藏域
    case "SAVE_FAVORITES":
      return asyncHandler(() => favoritesHandlers.save(message.favorites, sendResponse), sendResponse);
    case "GET_FAVORITES":
      return asyncHandler(() => favoritesHandlers.get(message.groupId, sendResponse), sendResponse);
    case "DELETE_FAVORITES":
      return asyncHandler(() => favoritesHandlers.delete(message.awemeIds, sendResponse), sendResponse);
    case "MOVE_FAVORITES":
      return asyncHandler(
        () => favoritesHandlers.move(message.awemeIds, message.targetGroupId, sendResponse),
        sendResponse,
      );

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
        const im = await loadIndependentMode();
        if (im) return handleIndependentFetchFollowing(message.secUid, sendResponse);
        return handleFetchFollowing(message.secUid, sendResponse);
      }, sendResponse);
    case "CALIBRATE_FOLLOWING":
      return asyncHandler(() => handleCalibrateFollowing(message.uid, message.secUid, sendResponse), sendResponse);
    case "FETCH_FAVORITES":
      return asyncHandler(async () => {
        // 点赞列表无独立模式分支（favorite 端点 Turing 风控，见 docs/05）
        return handleFetchFavorites(message.secUid, message.persist, sendResponse);
      }, sendResponse);
    case "FETCH_COLLECTION":
      return asyncHandler(async () => {
        const im = await loadIndependentMode();
        if (im) return handleIndependentFetchCollection(message.persist, sendResponse);
        return handleFetchCollection(message.persist, sendResponse);
      }, sendResponse);
    case "SYNC_WORKS":
      return asyncHandler(async () => {
        const im = await loadIndependentMode();
        if (im) return handleIndependentSyncWorks(message.awemeIds, sendResponse);
        return handleSyncWorks(message.awemeIds, sendResponse);
      }, sendResponse);
    case "FETCH_WORKS_PAGE":
      return asyncHandler(async () => {
        const im = await loadIndependentMode();
        if (im) return handleIndependentFetchWorksPage(message.secUid, message.cursor || "", sendResponse);
        sendToTab(
          "FETCH_WORKS_PAGE",
          {
            secUid: message.secUid,
            cursor: message.cursor || "",
            count: CONFIG.PAGE.AUTHOR,
            timeout: CONFIG.TIMEOUT.REQUEST,
          },
          sendResponse,
        );
      }, sendResponse);
    case "CANCEL_LIKE":
      return asyncHandler(async () => {
        // 点赞取消无独立模式分支（a_bogus 与 XHR 原型链深度绑定，SW 无法直连，见 docs/06）
        if (await loadIndependentMode()) {
          return sendResponse({ ok: false, error: "UNSUPPORTED_INDEPENDENT" });
        }
        return runCancelBatch(message.awemeIds, "CANCEL_ONE_LIKE", "CANCEL_PROGRESS", message.domain, sendResponse);
      }, sendResponse);
    case "CANCEL_COLLECTION":
      return asyncHandler(async () => {
        const im = await loadIndependentMode();
        if (im) return handleIndependentCancel(message.awemeIds, "collection", message.domain, sendResponse);
        return runCancelBatch(message.awemeIds, "CANCEL_ONE_COLLECTION", "CANCEL_PROGRESS", message.domain, sendResponse);
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
        const { savedCookie, savedCookieTime } = await chrome.storage.local.get(["savedCookie", "savedCookieTime"]);
        if (!savedCookie) return sendResponse({ ok: true, pairs: [], hasSessionid: false, time: null });
        const pairs = parseCookieToPairs(savedCookie);
        sendResponse({
          ok: true,
          pairs,
          rawCookie: savedCookie,
          hasSessionid: pairs.some((p) => p.key === "sessionid"),
          count: pairs.length,
          time: savedCookieTime || null,
        });
      }, sendResponse);
    case "GET_BROWSER_FEATURES":
      return asyncHandler(async () => {
        const bf = (await chrome.storage.local.get("browserFeatures")).browserFeatures;
        sendResponse({ ok: true, features: bf || null });
      }, sendResponse);

    case "GET_CACHE_TIMES":
      return asyncHandler(async () => {
        const { savedMsTokenTime, savedWebIdTime, browserFeaturesTime, savedCookieTime } =
          await chrome.storage.local.get(["savedMsTokenTime", "savedWebIdTime", "browserFeaturesTime", "savedCookieTime"]);
        sendResponse({
          ok: true,
          times: {
            msToken: savedMsTokenTime || null,
            webId: savedWebIdTime || null,
            browserFeatures: browserFeaturesTime || null,
            cookie: savedCookieTime || null,
          },
        });
      }, sendResponse);

    case "RESOLVE_SEC_UID":
      return asyncHandler(async () => {
        const secUid = await resolveSelfSecUid();
        sendResponse({ ok: !!secUid, secUid });
      }, sendResponse);

    case "REFRESH_MSTOKEN":
      return asyncHandler(async () => {
        await chrome.storage.local.remove(["savedMsToken", "savedMsTokenTime"]);
        const msToken = await getMsToken();
        const { savedMsTokenTime } = await chrome.storage.local.get("savedMsTokenTime");
        sendResponse({ ok: true, msToken, time: savedMsTokenTime || null });
      }, sendResponse);

    case "REFRESH_WEBID":
      return asyncHandler(async () => {
        await chrome.storage.local.remove(["savedWebId", "savedWebIdTime"]);
        const webId = await getWebId();
        const { savedWebIdTime } = await chrome.storage.local.get("savedWebIdTime");
        sendResponse({ ok: true, webId, time: savedWebIdTime || null });
      }, sendResponse);

    case "REFRESH_BROWSER_FEATURES":
      return asyncHandler(async () => {
        await chrome.storage.local.remove(["browserFeatures", "browserFeaturesTime"]);
        const resp = await sendToTabAsync("REQUEST_CAPTURE_BROWSER_FEATURES", { timeout: 10000 });
        if (resp?.ok && resp.features) {
          await chrome.storage.local.set({ browserFeatures: resp.features, browserFeaturesTime: Date.now() });
          abOgus = new ABogus(
            resp.features.userAgent || navigator.userAgent,
            resp.features.platform || navigator.platform,
            resp.features,
          );
          sendResponse({ ok: true, features: resp.features, time: Date.now() });
        } else {
          sendResponse({ ok: false, error: resp?.error || "CAPTURE_FAILED", hint: "请打开抖音页面后重试" });
        }
      }, sendResponse);

    case "REFRESH_COOKIE":
      return asyncHandler(async () => {
        try {
          const cookies = await chrome.cookies.getAll({ domain: "douyin.com" });
          const pairs = cookies.map((c) => c.name + "=" + c.value);
          const rawCookie = pairs.join("; ");
          const time = Date.now();
          await chrome.storage.local.set({ savedCookie: rawCookie, savedCookieTime: time });
          sendResponse({
            ok: true,
            pairs: cookies.map((c) => ({ key: c.name, value: c.value })),
            rawCookie,
            count: cookies.length,
            time,
          });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
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

    case "RELOAD_CONFIG":
      return asyncHandler(async () => {
        await reloadRuntimeConfig();
        sendResponse({ ok: true });
      }, sendResponse);

    default:
      sendResponse({ error: `Unknown message type: ${message.type}` });
  }
});

// ---------- 分页抓取 Handler ----------

// 关注列表接口返回的 aweme_count/follower_count 是滞后快照值（与主页展示差异大），
// 列表收集完成后逐用户请求 user/profile/other 用权威计数覆盖。
// fetchStats(secUid) 由调用方按模式提供（tab 转发 / 独立直连）；单条失败静默跳过保留旧值。
async function calibrateFollowingStats(list, fetchStats, isCancelled, requestId) {
  let processed = 0;
  for (const entry of list) {
    if (isCancelled()) break;
    processed += 1;
    const m = String(entry.profileUrl || "").match(/\/user\/([^/?#]+)/);
    if (m && m[1]) {
      try {
        const stats = await fetchStats(m[1]);
        entry.awemeCount = stats.awemeCount;
        entry.followerCount = stats.followerCount;
      } catch (_e) {}
    }
    chrome.runtime
      .sendMessage({
        type: "FOLLOWING_PROGRESS",
        phase: "calibrate",
        collected: processed,
        total: list.length,
        hasMore: false,
        requestId,
      })
      .catch(() => {});
    if (!isCancelled()) {
      const d = getDelayRange("syncFollowings");
      const delay = d.MIN + Math.random() * (d.MAX - d.MIN);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// 单用户校准：打开侧边栏时触发（不受 calibrateFollowings 开关门控），取 profile/other
// 权威计数后直接落库；options 端据返回值更新 state 与可见卡片
async function handleCalibrateFollowing(uid, secUid, sendResponse) {
  try {
    if (!uid || !secUid) return sendResponse({ ok: false, error: "BAD_PARAMS" });
    let stats;
    if (await loadIndependentMode()) {
      await ensureABogus();
      const data = await independentRequest(
        CONFIG.API.PROFILE_OTHER,
        await buildBaseParams({ sec_user_id: secUid }),
      );
      if (!data.user) throw new Error("PROFILE_FETCH_FAILED");
      stats = {
        awemeCount: data.user.aweme_count || 0,
        followerCount: data.user.follower_count || 0,
      };
    } else {
      const resp = await sendToTabAsync("FETCH_USER_PROFILE", {
        secUid,
        timeout: CONFIG.TIMEOUT.REQUEST,
      });
      if (!resp?.ok) throw new Error(resp?.error || "PROFILE_FETCH_FAILED");
      stats = { awemeCount: resp.awemeCount, followerCount: resp.followerCount };
    }
    const ds = domainStorage(CONFIG.STORAGE_KEYS.FOLLOWINGS);
    const record = await ds.get(String(uid));
    if (!record) return sendResponse({ ok: false, error: "NOT_FOUND" });
    record.awemeCount = stats.awemeCount;
    record.followerCount = stats.followerCount;
    await ds.putBatch([record]);
    sendResponse({ ok: true, ...stats });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

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
    let lastError = "";

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
        lastError = resp?.error || "FETCH_FAILED";
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
        const d = getDelayRange("syncFollowings");
        const delay = d.MIN + Math.random() * (d.MAX - d.MIN);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    if (!cancelled && all.length > 0 && _calibrateFollowings) {
      await calibrateFollowingStats(
        all,
        async (secUid) => {
          const resp = await sendToTabAsync("FETCH_USER_PROFILE", {
            secUid,
            timeout: CONFIG.TIMEOUT.REQUEST,
          });
          if (!resp?.ok) throw new Error(resp?.error || "PROFILE_FETCH_FAILED");
          return resp;
        },
        () => cancelled,
        requestId,
      );
    }
    chrome.runtime.onMessage.removeListener(cancelHandler);
    if (!cancelled && all.length === 0 && lastError) {
      sendResponse({ ok: false, error: lastError, requestId });
      return;
    }
    sendResponse({ ok: true, requestId, followings: all, total: all.length });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

// 扫描落库 + 丢失检测（persist = "likes" | "favorites" 时启用）。
// 用户中途取消时跳过丢失检测（部分拉取会产生假丢失），已收集部分仍合并落库（幂等）。
async function persistScanResults(persistDomain, all, cancelled) {
  if (!persistDomain || cancelled || all.length === 0) return { saved: null, lostUids: [] };
  const ds = domainStorage(persistDomain);
  const idField = ds.idField;
  const oldKeys = Object.keys(await ds.getAll());
  const saved = await mergeAndSaveDomainWorks(persistDomain, all);

  // 按远端列表顺序（即主页点赞/收藏顺序，最新在前）写 savedAt，使列表顺序与主页一致。
  // 必须在落库后读回完整记录再合并写回，避免 putBatch 整条替换导致视频/封面等字段丢失；
  // 也不能用「落库后再 ds.get 判定是否新条目」——mergeAndSaveDomainWorks 已先把新条目写入，
  // 会导致 newOnes 永远为空、savedAt 全退化为 Date.now()（即当前「保存时间都一样」的 bug）。
  const baseTime = Date.now();
  const stampIds = all.filter((w) => w && w[idField]).map((w) => String(w[idField]));
  const records = await Promise.all(stampIds.map((id) => ds.get(id)));
  const toWrite = records
    .map((rec, i) => (rec ? { ...rec, savedAt: baseTime - i } : null))
    .filter(Boolean);
  if (toWrite.length > 0) await ds.putBatch(toWrite);

  const incomingIds = new Set(stampIds);
  const lostUids = oldKeys.filter((k) => !incomingIds.has(String(k)));
  return { saved, lostUids };
}

async function handleFetchFavorites(secUid, persist, sendResponse) {
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
    let lastError = "";

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
        lastError = resp?.error || "FETCH_FAILED";
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
        const d = getDelayRange("syncFavorites");
        const delay = d.MIN + Math.random() * (d.MAX - d.MIN);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    chrome.runtime.onMessage.removeListener(cancelHandler);
    if (!cancelled && all.length === 0 && lastError) {
      sendResponse({ ok: false, error: lastError, requestId });
      return;
    }
    const { saved, lostUids } = await persistScanResults(persist, all, cancelled);
    sendResponse({ ok: true, requestId, works: all, timedOut: cancelled, saved, lostUids });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

async function handleFetchCollection(persist, sendResponse) {
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
    let lastError = "";

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
        lastError = resp?.error || "FETCH_FAILED";
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
        const d = getDelayRange("syncCollection");
        const delay = d.MIN + Math.random() * (d.MAX - d.MIN);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    chrome.runtime.onMessage.removeListener(cancelHandler);
    if (!cancelled && all.length === 0 && lastError) {
      sendResponse({ ok: false, error: lastError, requestId });
      return;
    }
    const { saved, lostUids } = await persistScanResults(persist, all, cancelled);
    sendResponse({ ok: true, requestId, works: all, timedOut: cancelled, saved, lostUids });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

async function runCancelBatch(awemeIds, tabType, progressType, persistDomain, sendResponse) {
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
      const delayKind = tabType === "CANCEL_ONE_COLLECTION" ? "cancelCollection" : "cancelLike";
      const d = getDelayRange(delayKind);
      const delay = d.MIN + Math.random() * (d.MAX - d.MIN);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  chrome.runtime.onMessage.removeListener(cancelHandler);
  const failedAwemeIds = errors.map((e) => e.awemeId).filter(Boolean);
  // 移除 = 取消并删本地：远端取消成功的条目同步删除该域本地记录
  const deletedIds = await deleteCancelledFromDomain(persistDomain, awemeIds, failedAwemeIds);
  chrome.runtime
    .sendMessage({
      type: "CANCEL_DONE",
      requestId,
      ok: true,
      cancelled,
      refreshed: awemeIds.length - errors.length,
      failed: errors.length,
      failedAwemeIds,
      deletedIds,
    })
    .catch(() => {});
}

// persistDomain 为空则跳过删本地（原扫描弹窗调用方无域概念）
async function deleteCancelledFromDomain(persistDomain, awemeIds, failedAwemeIds) {
  if (!persistDomain) return [];
  const failedSet = new Set((failedAwemeIds || []).map(String));
  const ids = (awemeIds || []).map(String).filter((id) => !failedSet.has(id));
  if (ids.length === 0) return [];
  try {
    await domainStorage(persistDomain).deleteBatch(ids);
    return ids;
  } catch (err) {
    console.warn("[DY] delete cancelled from domain failed:", err.message);
    return [];
  }
}

async function handleIndependentCancel(awemeIds, kind, persistDomain, sendResponse) {
  try {
    if (!Array.isArray(awemeIds) || awemeIds.length === 0) return sendResponse({ ok: false, error: "EMPTY" });
    const { savedCookie, browserFeatures } = await chrome.storage.local.get(["savedCookie", "browserFeatures"]);
    if (!savedCookie) return sendResponse({ ok: false, error: "NO_COOKIE" });
    const key = (browserFeatures && browserFeatures.securityKey) || "";
    const ep = CONFIG.CANCEL[kind];
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
      if (!cancelled && i < awemeIds.length - 1) {
        const delayKind = kind === "collection" ? "cancelCollection" : "cancelLike";
        const d = getDelayRange(delayKind);
        await new Promise((r) =>
          setTimeout(r, d.MIN + Math.random() * (d.MAX - d.MIN)),
        );
      }
    }
    chrome.runtime.onMessage.removeListener(cancelHandler);
    const failedAwemeIds = errors.map((e) => e.awemeId).filter(Boolean);
    // 移除 = 取消并删本地：远端取消成功的条目同步删除该域本地记录
    const deletedIds = await deleteCancelledFromDomain(persistDomain, awemeIds, failedAwemeIds);
    chrome.runtime
      .sendMessage({
        type: "CANCEL_DONE",
        requestId,
        ok: true,
        cancelled,
        refreshed: awemeIds.length - errors.length,
        failed: errors.length,
        failedAwemeIds,
        deletedIds,
      })
      .catch(() => {});
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
}

// ---------- 作品域 Handler ----------

async function handleSaveWorks(works, sendResponse) {
  try {
    const result = await mergeAndSaveDomainWorks(CONFIG.STORAGE_KEYS.WORKS, works);
    const invalid = works.filter((w) => !w || !w.awemeId).length;
    sendResponse({ ok: true, ...result, invalid });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

async function handleGetWork(awemeId, sendResponse) {
  try {
    const ds = domainStorage(CONFIG.STORAGE_KEYS.WORKS);
    const work = await ds.get(awemeId);
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

    const ds = domainStorage(CONFIG.STORAGE_KEYS.FOLLOWINGS);
    const stored = await ds.getAll();
    const incomingUids = new Set();
    let added = 0,
      updated = 0;

    const baseTime = Date.now();
    for (let i = 0; i < followings.length; i++) {
      const f = followings[i];
      if (!f || !f.uid) continue;
      const uid = String(f.uid);
      incomingUids.add(uid);
      const old = stored[uid];
      stored[uid] = {
        ...f,
        // 计数仅由校准更新：常规列表同步携带的 0 不覆盖已校准旧值；校准结果/导入快照 >0 时正常写入
        followerCount: f.followerCount > 0 ? f.followerCount : old?.followerCount || 0,
        awemeCount: f.awemeCount > 0 ? f.awemeCount : old?.awemeCount || 0,
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
    for (const uid of Object.keys(stored)) {
      if (!incomingUids.has(uid)) {
        lostUids.push(uid);
      }
    }

    await ds.putBatch(Object.values(stored));
    sendResponse({
      ok: true,
      added,
      updated,
      lost: lostUids.length,
      lostUids,
      total: Object.keys(stored).length,
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

    // 固定分组钉在队首（全部 → 未分组），其余按 order 升序；与写路径(handleReorderGroups/reconcileImportGroups)保持一致
    const FIXED_FRONT = ["all", "uncategorized"];
    const fixed = FIXED_FRONT.map((id) => result.find((g) => g.id === id)).filter(Boolean);
    const rest = result
      .filter((g) => !FIXED_FRONT.includes(g.id))
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    const normalized = [...fixed, ...rest];

    // 全部分组名统一为「全部」：存量数据若带旧名（全部作品/关注/点赞/收藏）在此收敛，并随下方回写路径落库
    let allNameChanged = false;
    for (const g of normalized) {
      if (g.id === "all" && g.name !== "全部") {
        g.name = "全部";
        allNameChanged = true;
      }
    }
    normalized.forEach((g, i) => (g.order = i));

    // 顺序与存储不一致时回写，修复历史错位的脏数据（自愈，只读路径最多写一次）
    if (list.length && (allNameChanged || normalized.some((g, i) => list[i] !== g))) {
      await storage.putGroups(groupsName, normalized);
    }
    sendResponse({ groups: normalized });
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
      if (CONFIG.FATAL_ERRORS.has(err) || err.startsWith("HTTP 429") || err.startsWith("HTTP 401")) {
        for (let j = i; j < awemeIds.length; j++) {
          errors.push({ awemeId: awemeIds[j], error: j === i ? err : "BATCH_TERMINATED" });
        }
        break;
      }
      errors.push({ awemeId: awemeIds[i], error: err });
    } else if (resp.work) {
      allWorks.push(resp.work);
    } else {
      errors.push({ awemeId: awemeIds[i], error: "DELETED" });
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
        const d = getDelayRange("syncWorks");
        const delay = d.MIN + Math.random() * (d.MAX - d.MIN);
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
    else await mergeAndSaveDomainWorks(domain, items).then((result) => {
      const invalid = items.filter((w) => !w || !w[DOMAIN_CONFIG[domain].idField]).length;
      sendResponse({ ok: true, ...result, invalid });
    });
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
    // 分组 tab 每次切换/刷新都会走到这里：只做索引计数，不 getAll 反序列化整表，
    // 避免大数据量下每次统计都产生整表读取 + 大对象分配
    const dsWorks = domainStorage(CONFIG.STORAGE_KEYS.WORKS);
    const dsFollowings = domainStorage(CONFIG.STORAGE_KEYS.FOLLOWINGS);
    const dsLikes = domainStorage(CONFIG.STORAGE_KEYS.LIKES);
    const dsFavorites = domainStorage(CONFIG.STORAGE_KEYS.FAVORITES);
    const [works_groups, followings_groups, likes_groups, favorites_groups, est] = await Promise.all([
      dsWorks.getGroups(),
      dsFollowings.getGroups(),
      dsLikes.getGroups(),
      dsFavorites.getGroups(),
      storage.estimate(),
    ]);

    const bytes = est ? est.usage : 0;

    async function buildDomainStats(ds, groups) {
      const total = await ds.count();
      const groupCounts = { all: total };
      await Promise.all(
        (groups || []).map(async (g) => {
          if (g.id === "all") return;
          groupCounts[g.id] = await ds.countByGroup(g.id);
        }),
      );
      return { total, groupCounts };
    }

    const [works, followings, likes, favorites] = await Promise.all([
      buildDomainStats(dsWorks, works_groups),
      buildDomainStats(dsFollowings, followings_groups),
      buildDomainStats(dsLikes, likes_groups),
      buildDomainStats(dsFavorites, favorites_groups),
    ]);

    sendResponse({
      ok: true,
      stats: { works, followings, likes, favorites, bytes },
    });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}
