// background/identity/credentials.js — 客户端凭据/签名/特性/Cookie/缓存时间戳

import { CONFIG, utils } from "../core.js";
import { tabBridge } from "./tab-bridge.js";
import { ABogus, Crypto } from "./crypto.js";

// jar 内存镜像跟踪的三个身份 cookie 名：任一在 douyin.com 域变更即失效镜像
//（cookies.onChanged 精确失效，保持这三键原「逐请求实时 jar 读」的换号/轮换时效——
// uifid/odin_tt 是签名输入，必须与服务端校验用的会话参数一致）
const JAR_IDENTITY_COOKIE_NAMES = new Set(["webid", "UIFID", "odin_tt"]);

// ---------- Credentials ----------
// 客户端凭据、特性、Cookie 与缓存时间戳的读写与刷新；持有 ABogus 实例与时钟偏移。
// 独立请求链的凭据读取走 SW 内存镜像（每请求 7-9 次串行 chrome.* IPC 是独立模式慢于
// Tab 模式的根因）：storage 四快照键（browserFeatures/savedCookie/savedMsToken/
// savedWebId）与 jar 三身份 cookie 各持一份缓存。新鲜度契约与「逐请求重读」完全一致
// ——storage 值本来就是快照，新鲜度由写入时机决定、与读取时机无关：
// 1. 写穿：本类内所有写入点在 storage set/remove 的同时更新/失效镜像（覆盖
//    refreshCookie→refreshMsToken 这类「写后立即读」的同 tick 序列）；
// 2. 兜底：storage.onChanged 失效四键镜像（防未来绕开本类的直写）；
// 3. jar 精确失效：cookies.onChanged 只盯 JAR_IDENTITY_COOKIE_NAMES 三名。
// 镜像随 SW 回收清零，重启后首请求重建（等同原有单请求成本），无跨重启陈旧。
class Credentials {
  #abOgus = null;
  #abOgusFor = null; // #abOgus 构建所用的 features 对象引用（代数判据：镜像换了对象即重建）
  #cachedClockSkew = 0;
  #clockSkewTime = 0;
  // webid 刷新单飞：并发任务同时命中 403 时只发一次刷新，全部复用同一结果
  #webIdRefresh = null;
  // —— SW 内存镜像（undefined=未加载，加载后为 string/object，"" 表示「已加载且无值」）——
  #bfCache; // browserFeatures（对象或 null=storage 无值）
  #cookieCache; // savedCookie 字符串（请求本体 Cookie 由 credentials:"include" 实时附带，不经此值）
  #msTokenCache; // savedMsToken 字符串
  #savedWebIdCache; // savedWebId 字符串
  #jarCache; // jar 三键 { webid, uifid, odin_tt }（""=jar 无此 cookie）

  constructor() {
    // 失效监听与实例同生命周期（SW 全局单例，无需解绑）。写穿之外多一层事件兜底，
    // 两者对同一写各失效一次是幂等的（下次读回 storage 同值）
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if ("browserFeatures" in changes) this.#bfCache = undefined;
      if ("savedCookie" in changes) this.#cookieCache = undefined;
      if ("savedMsToken" in changes) this.#msTokenCache = undefined;
      if ("savedWebId" in changes) this.#savedWebIdCache = undefined;
    });
    chrome.cookies.onChanged.addListener((changeInfo) => {
      const c = changeInfo && changeInfo.cookie;
      if (!c || !JAR_IDENTITY_COOKIE_NAMES.has(c.name)) return;
      if (!String(c.domain || "").includes("douyin.com")) return;
      this.#jarCache = undefined;
    });
  }

  async ensureABogus() {
    // 幂等：镜像对象引用未换不重建（原逐调用重建是 profile 链路每请求的纯浪费）。
    // browserFeatures 变更的两个入口（captureBrowserFeatures/refreshBrowserFeatures）
    // 各自写穿镜像并重建，onChanged 兜底失效后下次调用经引用比对自动重建
    if (this.#abOgus && this.#abOgusFor === this.#bfCache) return;
    const f = (await this.getFeatures()) || {};
    this.#abOgus = new ABogus(f.userAgent || navigator.userAgent, f.platform || navigator.platform, f);
    this.#abOgusFor = this.#bfCache;
  }

  // browserFeatures 内存镜像读取（ensureABogus/buildBaseParams 与独立模式收藏鉴权共用；
  // GET_BROWSER_FEATURES 消息处理器复用）
  async getFeatures() {
    if (this.#bfCache === undefined) {
      const { browserFeatures } = await chrome.storage.local.get("browserFeatures");
      this.#bfCache = browserFeatures || null;
    }
    return this.#bfCache;
  }

  // savedCookie 快照内存镜像读取（独立请求 NO_COOKIE 门禁 / msToken 兜底提取 /
  // uifid、odin_tt 回退共用）
  async getSavedCookie() {
    if (this.#cookieCache === undefined) {
      const { savedCookie } = await chrome.storage.local.get("savedCookie");
      this.#cookieCache = savedCookie || "";
    }
    return this.#cookieCache;
  }

  async getClockSkew() {
    if (Date.now() - this.#clockSkewTime < 300000) return this.#cachedClockSkew;
    try {
      const t0 = Date.now();
      const resp = await fetch("https://www.douyin.com/", { method: "HEAD", cache: "no-store" });
      const date = resp.headers.get("Date");
      if (date) {
        const serverTime = new Date(date).getTime();
        const t1 = Date.now();
        this.#cachedClockSkew = serverTime - Math.round((t0 + t1) / 2);
      }
    } catch {}
    this.#clockSkewTime = Date.now();
    return this.#cachedClockSkew;
  }

  // 仅供 IndependentClient.request 调用：对完整查询串（含 msToken/uifid/odin_tt，不含 a_bogus）签名。
  sign(qs, method, skew) {
    return this.#abOgus.getValue(qs, method, skew);
  }

  get userAgent() {
    return this.#abOgus ? this.#abOgus.userAgent : navigator.userAgent;
  }

  async fetchMsToken() {
    try {
      const browserCookies = await chrome.cookies.getAll({ domain: "douyin.com", name: "msToken" });
      if (browserCookies.length > 0 && browserCookies[0].value) {
        return browserCookies[0].value;
      }
    } catch {}

    try {
      const msToken = utils.extractMsTokenFromCookie(await this.getSavedCookie());
      if (msToken) return msToken;
    } catch {}

    return "";
  }

  // 通过 mssdk 静态载荷兑换真 msToken（参考 TikTokDownloader src/encrypt/msToken.py）。
  // 抖音页面 SDK 现走同一机制：签发的 cookie 落在 bytedance.com 域，douyin.com jar 里
  // 本来就没有 msToken；而随机兜底 token 服务端不认，严格端点（listcollection POST）会 403。
  // SW 的 fetch 读不到 Set-Cookie：先删 jar 旧值，POST 后从 bytedance.com jar 读回新签发的值。
  async mintMsToken() {
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

  async getMsToken() {
    if (this.#msTokenCache === undefined) {
      const { savedMsToken } = await chrome.storage.local.get("savedMsToken");
      if (savedMsToken) {
        this.#msTokenCache = savedMsToken;
      } else {
        let msToken = await this.fetchMsToken();
        if (!msToken) {
          msToken = await this.mintMsToken();
          console.info("[DY] msToken: mssdk 兑换" + (msToken ? "成功" : "失败"));
        }
        if (!msToken) {
          console.warn("[DY] msToken: 使用随机兜底（严格端点可能 403）");
          msToken = Crypto.generateRandomMsToken();
        }
        await chrome.storage.local.set({ savedMsToken: msToken, savedMsTokenTime: Date.now() });
        this.#msTokenCache = msToken;
      }
    }
    return this.#msTokenCache;
  }

  async fetchWebIdFromApi() {
    try {
      const ua = this.userAgent;
      const resp = await fetch(CONFIG.WEBID_API + "?" + CONFIG.WEBID_QUERY, {
        method: "POST",
        // Referer / User-Agent 属 forbidden header，fetch 设置会被浏览器静默丢弃；
        // 需要的值随 body 上报（见下），不要在这里重复设置
        headers: {
          Accept: "*/*",
          "Content-Type": "text/plain;charset=UTF-8",
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

  async syncWebIdCookie(webid) {
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

  // jar 三身份 cookie 的内存镜像：一次全域枚举同时取 webid/UIFID/odin_tt（替代原
  // 每请求两次 cookies.getAll）。webid 取首个（原 getWebId 的 getAll[0] 口径），
  // UIFID/odin_tt 末次覆盖（原 cmap 逐个赋值口径）；cookies.onChanged 三键精确失效
  // 保持换号/轮换时效，读取失败不缓存、下次请求重试实时读（与原 try/catch 降级一致）
  async #loadJarIdentity() {
    if (this.#jarCache !== undefined) return this.#jarCache;
    try {
      const cookies = await chrome.cookies.getAll({ domain: "douyin.com" });
      const jar = { webid: "", uifid: "", odin_tt: "" };
      for (const c of cookies) {
        if (c.name === "webid") {
          if (!jar.webid) jar.webid = c.value;
        } else if (c.name === "UIFID") {
          jar.uifid = c.value;
        } else if (c.name === "odin_tt") {
          jar.odin_tt = c.value;
        }
      }
      this.#jarCache = jar;
    } catch (e) {
      console.warn("[DY] jar identity cookies read failed:", e?.message);
      return { webid: "", uifid: "", odin_tt: "" };
    }
    return this.#jarCache;
  }

  async #loadSavedWebId() {
    if (this.#savedWebIdCache === undefined) {
      const { savedWebId } = await chrome.storage.local.get("savedWebId");
      this.#savedWebIdCache = savedWebId || "";
    }
    return this.#savedWebIdCache;
  }

  async getWebId() {
    const jar = await this.#loadJarIdentity();
    const cookieWebId = jar.webid;
    if (cookieWebId) {
      const saved = await this.#loadSavedWebId();
      if (saved !== cookieWebId) {
        await chrome.storage.local.set({ savedWebId: cookieWebId, savedWebIdTime: Date.now() });
        this.#savedWebIdCache = cookieWebId;
      }
      return cookieWebId;
    }
    const saved = await this.#loadSavedWebId();
    if (saved) return saved;
    const webid = await this.fetchWebIdFromApi();
    await this.#persistWebId(webid);
    return webid;
  }

  // webid 缓存清理（refreshWebIdChain / refreshWebId 共用）
  async #resetWebIdCache() {
    await chrome.storage.local.remove(["savedWebId", "savedWebIdTime"]);
    this.#savedWebIdCache = "";
  }

  async #persistWebId(webid) {
    if (!webid) return;
    await chrome.storage.local.set({ savedWebId: webid, savedWebIdTime: Date.now() });
    this.#savedWebIdCache = webid;
    await this.syncWebIdCookie(webid);
  }

  async refreshWebIdChain() {
    // 单飞：两个任务在途请求同时被拒时，后发起的刷新会把前一个刚拿到的新 webid 再换掉，
    // 导致双方重试都撞旧值。in-flight Promise 复用 + finally 清位，保证同代只刷一次
    if (!this.#webIdRefresh) {
      this.#webIdRefresh = (async () => {
        await this.#resetWebIdCache();
        const webid = await this.fetchWebIdFromApi();
        await this.#persistWebId(webid);
        return webid;
      })().finally(() => {
        this.#webIdRefresh = null;
      });
    }
    return this.#webIdRefresh;
  }

  async buildBaseParams(extra = {}) {
    const bf = (await this.getFeatures()) || {};
    const webid = await this.getWebId();
    const jar = await this.#loadJarIdentity(); // getWebId 已加载镜像，稳态零 IPC
    const savedCookie = await this.getSavedCookie();
    let uifid = jar.uifid,
      odin_tt = jar.odin_tt;
    // odin_tt / uifid 必须来自「当前登录会话」的 Cookie，否则签名虽正确但与服务端
    // 校验用的会话参数不一致 → 403 sign invalid。jar 镜像按 cookies.onChanged 三键
    // 精确失效，保持原实时读语义；savedCookie 仅作 jar 缺值时的快照回退
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

  // 由 inject 捕获浏览器特性后重建 ABogus 实例（页面注入路径）
  async captureBrowserFeatures(message, sendResponse) {
    if (message.features) {
      await this.#installFeatures(message.features);
      this.#autoRefreshCredentials();
    }
    sendResponse({ ok: true });
  }

  // —— 客户端凭据/特性/Cookie/缓存时间戳的读取与刷新（吸收原 route 内 8 个内联处理器）——

  async refreshMsToken(sendResponse) {
    await chrome.storage.local.remove(["savedMsToken", "savedMsTokenTime"]);
    this.#msTokenCache = undefined; // 写穿失效，getMsToken 走原三分支重取
    const msToken = await this.getMsToken();
    const { savedMsTokenTime } = await chrome.storage.local.get("savedMsTokenTime");
    sendResponse?.({ ok: true, msToken, time: savedMsTokenTime || null });
  }

  async refreshWebId(sendResponse) {
    await this.#resetWebIdCache();
    const webId = await this.getWebId();
    const { savedWebIdTime } = await chrome.storage.local.get("savedWebIdTime");
    sendResponse?.({ ok: true, webId, time: savedWebIdTime || null });
  }

  // 重建 ABogus 需跨类经 TabBridge 向页面索取最新特性
  async refreshBrowserFeatures(sendResponse) {
    await chrome.storage.local.remove(["browserFeatures", "browserFeaturesTime"]);
    const resp = await tabBridge.sendAsync("REQUEST_CAPTURE_BROWSER_FEATURES", { timeout: 10000 });
    if (resp?.ok && resp.features) {
      await this.#installFeatures(resp.features);
      sendResponse({ ok: true, features: resp.features, time: Date.now() });
    } else {
      sendResponse({ ok: false, error: resp?.error || "CAPTURE_FAILED", hint: "请打开抖音页面后重试" });
    }
  }

  // 特性安装收尾：写库 + 写穿镜像 + 重建 ABogus（捕获/刷新两条路径共用）
  async #installFeatures(features) {
    await chrome.storage.local.set({ browserFeatures: features, browserFeaturesTime: Date.now() });
    this.#bfCache = features; // 写穿镜像
    this.#abOgus = new ABogus(
      features.userAgent || navigator.userAgent,
      features.platform || navigator.platform,
      features,
    );
    this.#abOgusFor = this.#bfCache;
  }

  async getBrowserFeatures(sendResponse) {
    sendResponse({ ok: true, features: (await this.getFeatures()) || null });
  }

  async getCookieInfo(sendResponse) {
    const savedCookie = await this.getSavedCookie();
    if (!savedCookie) return sendResponse({ ok: true, pairs: [], hasSessionid: false, time: null });
    const { savedCookieTime } = await chrome.storage.local.get("savedCookieTime");
    const pairs = Crypto.parseCookieToPairs(savedCookie);
    sendResponse({
      ok: true,
      pairs,
      rawCookie: savedCookie,
      hasSessionid: pairs.some((p) => p.key === "sessionid"),
      count: pairs.length,
      time: savedCookieTime || null,
    });
  }

  async getCacheTimes(sendResponse) {
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
  }

  async refreshCookie(sendResponse) {
    try {
      const cookies = await chrome.cookies.getAll({ domain: "douyin.com" });
      const pairs = cookies.map((c) => c.name + "=" + c.value);
      const rawCookie = pairs.join("; ");
      const time = Date.now();
      await chrome.storage.local.set({ savedCookie: rawCookie, savedCookieTime: time });
      this.#cookieCache = rawCookie; // 写穿镜像
      sendResponse?.({
        ok: true,
        pairs: cookies.map((c) => ({ key: c.name, value: c.value })),
        rawCookie,
        count: cookies.length,
        time,
      });
    } catch (e) {
      sendResponse?.({ ok: false, error: e.message });
    }
  }

  // 抖音页面加载时机顺带自动刷新三项独立模式凭据（fire-and-forget，不阻塞 capture 响应）：
  // cookie 快照先行（msToken 第二来源与 UIFID/odin_tt 兜底都读它），msToken/webid 并行兑换。
  // 与设置面板手动刷新同链路，sendResponse 缺省即静默执行。
  async #autoRefreshCredentials() {
    await this.refreshCookie();
    await Promise.allSettled([this.refreshMsToken(), this.refreshWebId()]);
  }
}
const credentials = new Credentials();

export { credentials };
