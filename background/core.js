// background/core.js — 共享基础：全局配置 + 四域映射 + 纯函数 + 格式化 + 运行时配置

import { MSSDK_STR_DATA } from "./identity/crypto.js";
// 与 identity/independent-client.js 循环 import（independent-client 反向 import 本文件的 CONFIG）：
// 两模块顶层互不触碰对方绑定，靠 ES live binding 在调用时安全消解（AGENTS.md 设计例外）
import { independentClient } from "./identity/independent-client.js";

// ---------- config ----------
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
  // 四个域的默认分组结构一致（全部 → 未分组），共用同一份定义；消费处通过 .map 拷贝，避免原地改写污染共享引用
  DEFAULT_GROUPS: [
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
    // 网格渐进加载页大小：keyset 游标串行依赖上一页末键，页间无法并行——吞吐提升
    // 靠加大页体摊薄每页固定开销（事务建立 + 消息往返）。2000 条 ≈ 2-4MB/页
    GRID: 2000,
  },
  // 导入分块落库块大小：单事务 10 万级 put 会长时间独占 SW 的 IndexedDB——按块
  // mergeAndSave + IMPORT_PROGRESS 逐块回报（followings 域不分块，记录小单遍即可）
  IMPORT_CHUNK: 2000,
  // STORE_CHANGED 广播的点变化阈值：changed ≤ UPSERTS_MAX 时携带合并后记录（upserts），
  // options 局部应用；超过则发无载荷广播走整刷收口（批量变化逐条局部更新反而 thrash）
  BROADCAST: {
    UPSERTS_MAX: 8,
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
    COLLECTION: "/aweme/v1/web/aweme/listcollection/",
    DETAIL: "/aweme/v1/web/aweme/detail/",
    POST: "/aweme/v1/web/aweme/post/",
  },
  // Argus webSign 策略盐（页面 secsdk 动态策略常量，实测跨会话稳定；若服务端
  // 更新策略版本导致换盐，独立模式收藏扫描将重新出现 Signature Not Found）
  WEB_SIGN_SALT: "A96D855A08C0A9707F8BEF0D9A527E4E",
  CANCEL: {
    // 独立模式仅取消收藏：点赞取消结构性不可行（Turing/XHR 签名限制——路由层显式拒绝
    // UNSUPPORTED_INDEPENDENT，Tab 模式走 inject 侧 XHR 的 LIKE_URL，见 docs/06），
    // 不设 like 配置位
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

const DOMAIN_CONFIG = {
  [CONFIG.STORAGE_KEYS.WORKS]: {
    storeName: CONFIG.STORAGE_KEYS.WORKS,
    groupsName: CONFIG.STORAGE_KEYS.WORKS_GROUPS,
    defaultGroups: CONFIG.DEFAULT_GROUPS,
    itemKey: CONFIG.STORAGE_KEYS.WORKS,
    idField: "awemeId",
  },
  [CONFIG.STORAGE_KEYS.FOLLOWINGS]: {
    storeName: CONFIG.STORAGE_KEYS.FOLLOWINGS,
    groupsName: CONFIG.STORAGE_KEYS.FOLLOWINGS_GROUPS,
    defaultGroups: CONFIG.DEFAULT_GROUPS,
    itemKey: CONFIG.STORAGE_KEYS.FOLLOWINGS,
    idField: "uid",
    idToString: true,
  },
  [CONFIG.STORAGE_KEYS.LIKES]: {
    storeName: CONFIG.STORAGE_KEYS.LIKES,
    groupsName: CONFIG.STORAGE_KEYS.LIKES_GROUPS,
    defaultGroups: CONFIG.DEFAULT_GROUPS,
    itemKey: CONFIG.STORAGE_KEYS.LIKES,
    idField: "awemeId",
  },
  [CONFIG.STORAGE_KEYS.FAVORITES]: {
    storeName: CONFIG.STORAGE_KEYS.FAVORITES,
    groupsName: CONFIG.STORAGE_KEYS.FAVORITES_GROUPS,
    defaultGroups: CONFIG.DEFAULT_GROUPS,
    itemKey: CONFIG.STORAGE_KEYS.FAVORITES,
    idField: "awemeId",
  },
};

// ---------- runtimeConfig ----------
// 对标 options/core.js 的同名对象：从 chrome.storage.local 读取运行时配置并叠加进 CONFIG。
const runtimeConfig = {
  KEY: "runtimeConfig",
  // 默认运行配置：直接由 CONFIG 的 TIMEOUT/DELAY/SYNC 派生（单一事实来源），仅 calibrateFollowings 为运行时独占开关。
  // 仅在首次安装时写入 chrome.storage.local 作为种子；后续 RELOAD_CONFIG 覆盖写入可变 CONFIG。
  DEFAULTS: {
    timeoutRequest: CONFIG.TIMEOUT.REQUEST,
    timeoutSecurityStatus: CONFIG.TIMEOUT.SECURITY_STATUS,
    syncWorksDelayMin: CONFIG.DELAY.syncWorks.MIN,
    syncWorksDelayMax: CONFIG.DELAY.syncWorks.MAX,
    syncFollowingsDelayMin: CONFIG.DELAY.syncFollowings.MIN,
    syncFollowingsDelayMax: CONFIG.DELAY.syncFollowings.MAX,
    syncFavoritesDelayMin: CONFIG.DELAY.syncFavorites.MIN,
    syncFavoritesDelayMax: CONFIG.DELAY.syncFavorites.MAX,
    syncCollectionDelayMin: CONFIG.DELAY.syncCollection.MIN,
    syncCollectionDelayMax: CONFIG.DELAY.syncCollection.MAX,
    cancelLikeDelayMin: CONFIG.DELAY.cancelLike.MIN,
    cancelLikeDelayMax: CONFIG.DELAY.cancelLike.MAX,
    cancelCollectionDelayMin: CONFIG.DELAY.cancelCollection.MIN,
    cancelCollectionDelayMax: CONFIG.DELAY.cancelCollection.MAX,
    syncBatchSize: CONFIG.SYNC.BATCH_SIZE,
    syncBatchPauseMin: CONFIG.SYNC.BATCH_PAUSE_MIN,
    syncBatchPauseMax: CONFIG.SYNC.BATCH_PAUSE_MAX,
    syncKeepaliveInterval: CONFIG.SYNC.KEEPALIVE_INTERVAL,
    syncRetryMax: CONFIG.SYNC.RETRY_MAX,
    calibrateFollowings: true,
  },
  async load() {
    const stored = await chrome.storage.local.get(this.KEY);
    const cfg = stored[this.KEY];
    if (!cfg) {
      await chrome.storage.local.set({ [this.KEY]: { ...this.DEFAULTS } });
      return { ...this.DEFAULTS };
    }
    return { ...this.DEFAULTS, ...cfg };
  },
  // 把一份配置对象叠加进可变 CONFIG（含校准开关写入 IndependentClient）
  apply(cfg) {
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
    independentClient.setCalibrateEnabled(cfg.calibrateFollowings ?? true);
  },
  async reload() {
    const cfg = await this.load();
    this.apply(cfg);
  },
  delayRange(type) {
    const d = CONFIG.DELAY[type];
    if (d) return d;
    // fallback to syncWorks if type not found
    return CONFIG.DELAY.syncWorks || { MIN: 500, MAX: 1000 };
  },
  randomDelay(type) {
    const d = this.delayRange(type);
    return d.MIN + Math.random() * (d.MAX - d.MIN);
  },
};

// ---------- utils ----------
// 纯函数集（无状态，对标 options/core.js 的 utils）
const utils = {
  // aweme_id 高 32 位 = 发布 Unix 秒（fiber 捕获等响应缺 create_time 时的兜底推导）；
  // 区间守卫：抖音上线(2016-09) ~ 明天，防畸形 ID 产出离谱时间
  awemeIdCreateTime(id) {
    try {
      if (!/^\d+$/.test(String(id))) return 0;
      const sec = Number(BigInt(id) >> 32n);
      return sec > 1475000000 && sec < Date.now() / 1000 + 86400 ? sec : 0;
    } catch {
      return 0;
    }
  },
  parseExpire(value) {
    const n = Number(value);
    if (!isFinite(n) || n <= 0) return null;
    if (n > 1e11) return n > 1e13 ? null : n; // 毫秒时间戳
    if (n > 1e9) return n * 1000; // 秒时间戳
    if (n <= 86400 * 30) return Date.now() + n * 1000; // 剩余秒数
    return null;
  },
  urlExpireAt(url) {
    try {
      const abs = url.startsWith("//") ? "https:" + url : url;
      const sp = new URL(abs).searchParams;
      // 键名含 expire（大小写不敏感）的参数优先，兼容 expire/x-expires/xpires 等变体
      for (const key of sp.keys()) {
        if (/expire/i.test(key)) {
          const at = utils.parseExpire(sp.get(key));
          if (at != null) return at;
        }
      }
      return null;
    } catch {
      return null;
    }
  },
  // 长效 ID 型播放链接（与推荐页手动"添加"按钮存的同款）：无 expire 参数，
  // 访问时由服务端 302 到即时签名的 douyinvod 地址。注意部分 douyinvod 短效直链
  // 的过期时间藏在路径段里（/<sig>/<8位hex过期秒>），query 里查不到。
  isLongLivedVideoUrl(u) {
    return typeof u === "string" && /\/\/www\.douyin\.com\/aweme\/v1\/play\/\?/.test(u);
  },
  // 剥离 http: 前缀（抖音 CDN 裸协议地址统一走页面同协议）
  stripHttp(u) {
    return u.replace(/^http:/, "");
  },
  extractMsTokenFromCookie(cookieStr) {
    if (!cookieStr) return "";
    for (const pair of cookieStr.split(";")) {
      const trimmed = pair.trim();
      const idx = trimmed.indexOf("=");
      if (idx > 0 && trimmed.slice(0, idx) === "msToken") {
        return trimmed.slice(idx + 1);
      }
    }
    return "";
  },
  asyncHandler(fn, sendResponse) {
    const result = fn();
    if (result && typeof result.catch === "function") {
      result.catch((err) => sendResponse({ error: err.message }));
    }
    return true;
  },
  sendSyncDone(requestId, result) {
    chrome.runtime
      .sendMessage({ type: "SYNC_DONE", requestId, ...result })
      .catch((e) => console.warn("[DY] sync done send failed:", e));
  },
  // 分页端点 has_more 字段归一（宽松判定：服务端可能返回 true/1/"1"，缺判只会多拉一页空数据）
  hasMoreFlag(data) {
    return data.has_more === true || data.has_more === 1 || data.has_more === "1";
  },
  // 长任务取消信号守卫：注册 CANCEL_ACTIVE_TASK 监听，返回 { isCancelled, dispose }。
  // 注意 scanTasks.syncWorks 的取消处理器有额外转发逻辑，不适用本 helper。
  withCancelGuard() {
    let cancelled = false;
    const cancelHandler = (msg) => {
      if (msg.type === "CANCEL_ACTIVE_TASK") cancelled = true;
    };
    chrome.runtime.onMessage.addListener(cancelHandler);
    return {
      isCancelled: () => cancelled,
      dispose: () => chrome.runtime.onMessage.removeListener(cancelHandler),
    };
  },
  sendMessageSafe(msg) {
    return chrome.runtime.sendMessage(msg).catch(() => {});
  },
  // 长任务批量暂停 + SW keepalive 保活（syncWorks 共用；调用方已先判取消标志）
  async pauseWithKeepalive(index, delayKind = "syncWorks") {
    const { BATCH_SIZE, BATCH_PAUSE_MIN, BATCH_PAUSE_MAX, KEEPALIVE_INTERVAL } = CONFIG.SYNC;
    if (BATCH_SIZE > 0 && (index + 1) % BATCH_SIZE === 0) {
      const deadline = Date.now() + BATCH_PAUSE_MIN + Math.random() * (BATCH_PAUSE_MAX - BATCH_PAUSE_MIN);
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, KEEPALIVE_INTERVAL));
        await chrome.storage.local.get("keepalive");
      }
    } else {
      await new Promise((r) => setTimeout(r, runtimeConfig.randomDelay(delayKind)));
    }
  },
  emitCancelDone(requestId, payload) {
    return utils.sendMessageSafe({ type: "CANCEL_DONE", requestId, ...payload });
  },
};

// ---------- formatters ----------
const formatters = {
  formatWork(aw) {
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
        if (u) cands.push({ url: u, height: h, expireAt: utils.urlExpireAt(u) });
      }
    }
    if (cands.length === 0) {
      for (const u of (video.play_addr && video.play_addr.url_list) || []) {
        if (u) cands.push({ url: u, height: 0, expireAt: utils.urlExpireAt(u) });
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
    videoUrl = utils.stripHttp(videoUrl);
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
      cover: ((video.cover && video.cover.url_list) || [])[0] ? utils.stripHttp(video.cover.url_list[0]) : "",
      video: videoUrl,
      videoExpireAt,
      images: (aw.images || [])
        .map((i) => utils.stripHttp((i.url_list || i.urlList || [])[0] || ""))
        .filter(Boolean),
      music: (aw.music && (aw.music.play_url || aw.music.playUrl || {}).uri) || "",
      createTime: aw.create_time || aw.createTime || utils.awemeIdCreateTime(aw.aweme_id) || 0,
      authorFollowed,
    };
  },
  formatFollowing(item) {
    return {
      uid: String(item.uid || ""),
      nickname: item.nickname || "未知",
      avatarLarger: ((item.avatar_larger && item.avatar_larger.url_list) || [])[0] || "",
      // 粉丝/作品数不再取自关注列表（滞后快照），字段占位为 0，仅由 profile/other 校准写入
      followerCount: 0,
      awemeCount: 0,
      // 最近更新日期（毫秒时间戳）：仅由校准阶段取作品第一页 max(create_time) 写入，未校准占位 0
      lastUpdateAt: 0,
      profileUrl: CONFIG.URL_BASE + "/user/" + (item.sec_uid || ""),
    };
  },
  // profile/other 权威档案 → 关注域记录：入参是归一化 user 摘要（scanTasks.#fetchProfileUser
  // 独立分支与 inject FETCH_PROFILE_OTHER 做同款原始字段抽取）。与 formatFollowing 的差异：
  // 计数直接取 profile 权威值（profile/other 正是校准源，>0）。不设 groupId，分组由
  // mergeAndSaveFollowings 分配（已在域的保留原分组、新作者落「未分组」）；lastUpdateAt 由调用方补采
  formatFollowingFromProfile(user) {
    return {
      uid: String(user.uid || ""),
      nickname: user.nickname || "未知",
      avatarLarger: user.avatarLarger || "",
      followerCount: user.followerCount || 0,
      awemeCount: user.awemeCount || 0,
      lastUpdateAt: 0,
      profileUrl: CONFIG.URL_BASE + "/user/" + (user.secUid || ""),
    };
  },
};

export { CONFIG, DOMAIN_CONFIG, utils, formatters, runtimeConfig };
