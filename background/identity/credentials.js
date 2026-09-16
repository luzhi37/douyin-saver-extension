// background/identity/credentials.js — 客户端凭据/签名/特性/Cookie/缓存时间戳

import { CONFIG, utils } from "../core.js";
import { tabBridge } from "./tab-bridge.js";
import { ABogus, Crypto } from "./crypto.js";

// ---------- Credentials ----------
// 客户端凭据、特性、Cookie 与缓存时间戳的读写与刷新；持有 ABogus 实例与时钟偏移。
class Credentials {
  #abOgus = null;
  #cachedClockSkew = 0;
  #clockSkewTime = 0;

  async ensureABogus() {
    const { browserFeatures } = await chrome.storage.local.get("browserFeatures");
    const f = browserFeatures || {};
    this.#abOgus = new ABogus(f.userAgent || navigator.userAgent, f.platform || navigator.platform, f);
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
      const { savedCookie } = await chrome.storage.local.get("savedCookie");
      const msToken = utils.extractMsTokenFromCookie(savedCookie);
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
    const { savedMsToken } = await chrome.storage.local.get("savedMsToken");
    if (savedMsToken) return savedMsToken;
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
    return msToken;
  }

  async fetchWebIdFromApi() {
    try {
      const ua = this.userAgent;
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

  async getWebId() {
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
    const webid = await this.fetchWebIdFromApi();
    if (webid) {
      await chrome.storage.local.set({ savedWebId: webid, savedWebIdTime: Date.now() });
      await this.syncWebIdCookie(webid);
    }
    return webid;
  }

  async refreshWebIdChain() {
    await chrome.storage.local.remove(["savedWebId", "savedWebIdTime"]);
    const webid = await this.fetchWebIdFromApi();
    if (webid) {
      await chrome.storage.local.set({ savedWebId: webid, savedWebIdTime: Date.now() });
      await this.syncWebIdCookie(webid);
    }
    return webid;
  }

  async buildBaseParams(extra = {}) {
    const bf = (await chrome.storage.local.get("browserFeatures")).browserFeatures || {};
    const [webid, { savedCookie }] = await Promise.all([this.getWebId(), chrome.storage.local.get("savedCookie")]);
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

  // 由 inject 捕获浏览器特性后重建 ABogus 实例（页面注入路径）
  async captureBrowserFeatures(message, sendResponse) {
    if (message.features) {
      await chrome.storage.local.set({ browserFeatures: message.features, browserFeaturesTime: Date.now() });
      this.#abOgus = new ABogus(
        message.features.userAgent || navigator.userAgent,
        message.features.platform || navigator.platform,
        message.features,
      );
    }
    sendResponse({ ok: true });
  }

  // —— 客户端凭据/特性/Cookie/缓存时间戳的读取与刷新（吸收原 route 内 8 个内联处理器）——

  async refreshMsToken(sendResponse) {
    await chrome.storage.local.remove(["savedMsToken", "savedMsTokenTime"]);
    const msToken = await this.getMsToken();
    const { savedMsTokenTime } = await chrome.storage.local.get("savedMsTokenTime");
    sendResponse({ ok: true, msToken, time: savedMsTokenTime || null });
  }

  async refreshWebId(sendResponse) {
    await chrome.storage.local.remove(["savedWebId", "savedWebIdTime"]);
    const webId = await this.getWebId();
    const { savedWebIdTime } = await chrome.storage.local.get("savedWebIdTime");
    sendResponse({ ok: true, webId, time: savedWebIdTime || null });
  }

  // 重建 ABogus 需跨类经 TabBridge 向页面索取最新特性
  async refreshBrowserFeatures(sendResponse) {
    await chrome.storage.local.remove(["browserFeatures", "browserFeaturesTime"]);
    const resp = await tabBridge.sendAsync("REQUEST_CAPTURE_BROWSER_FEATURES", { timeout: 10000 });
    if (resp?.ok && resp.features) {
      await chrome.storage.local.set({ browserFeatures: resp.features, browserFeaturesTime: Date.now() });
      this.#abOgus = new ABogus(
        resp.features.userAgent || navigator.userAgent,
        resp.features.platform || navigator.platform,
        resp.features,
      );
      sendResponse({ ok: true, features: resp.features, time: Date.now() });
    } else {
      sendResponse({ ok: false, error: resp?.error || "CAPTURE_FAILED", hint: "请打开抖音页面后重试" });
    }
  }

  async getBrowserFeatures(sendResponse) {
    const bf = (await chrome.storage.local.get("browserFeatures")).browserFeatures;
    sendResponse({ ok: true, features: bf || null });
  }

  async getCookieInfo(sendResponse) {
    const { savedCookie, savedCookieTime } = await chrome.storage.local.get(["savedCookie", "savedCookieTime"]);
    if (!savedCookie) return sendResponse({ ok: true, pairs: [], hasSessionid: false, time: null });
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
  }
}
const credentials = new Credentials();

export { credentials };
