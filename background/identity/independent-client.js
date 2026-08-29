// background/identity/independent-client.js — 独立模式开关/校准开关 + 签名直连 request + resolveSelfSecUid

import { CONFIG } from "../core.js";
import { credentials } from "./credentials.js";
import { Crypto } from "./crypto.js";

// ---------- IndependentClient ----------
// 独立模式开关、校准开关与签名直连客户端；持有 3 个模式开关字段。
class IndependentClient {
  #mode = false;
  #loaded = false;
  #calibrate = true;

  async loadMode() {
    if (!this.#loaded) {
      const { independentMode } = await chrome.storage.local.get("independentMode");
      this.#mode = independentMode === true;
      this.#loaded = true;
    }
    return this.#mode;
  }

  async setMode(message, sendResponse) {
    await chrome.storage.local.set({ independentMode: message.enabled === true });
    this.#mode = message.enabled === true;
    this.#loaded = true;
    if (message.enabled) await credentials.ensureABogus();
    sendResponse({ ok: true });
  }

  isIndependentMode() {
    return this.#mode;
  }

  isCalibrateEnabled() {
    return this.#calibrate;
  }

  setCalibrateEnabled(v) {
    this.#calibrate = v === true;
  }

  // 抖音服务端验证 a_bogus 时仅剥离 a_bogus 自身、对“完整查询串”做哈希，
  // 因此签名必须基于与最终 URL 完全一致（仅缺 a_bogus）的查询串，键顺序也需一致。
  // 注意：msToken / uifid / odin_tt 等 SDK 注入键也参与签名（实测真实 a_bogus
  // 的 pa 段与“含这些键的完整查询串”逐字节吻合），绝不能剔除。
  async request(apiPath, params, options = {}) {
    const { savedCookie } = await chrome.storage.local.get("savedCookie");
    if (!savedCookie) throw new Error("NO_COOKIE");
    params.msToken = await credentials.getMsToken();
    const method = options.method || "GET";
    // qs 即实际发送的查询串（含 msToken/uifid/odin_tt，不含 a_bogus），顺序与 URL 一致
    const qs = new URLSearchParams(params).toString();
    const a_bogus = credentials.sign(qs, method, await credentials.getClockSkew());
    // Argus webSign（与页面 window.use("webSignUrl") 同款算法）：
    // sig = md5(uifid + "_" + ts + "_" + SALT + "_" + 待签查询串)，其中待签查询串 =
    // 最终发送的完整 query 去掉 x-secsdk-web-signature 自身（含 a_bogus 与 timestamp）；
    // 同时随请求携带 uifid / x-secsdk-web-signature / x-secsdk-web-expire 头。
    let urlQuery = qs + "&a_bogus=" + a_bogus;
    const webSignHeaders = {};
    if (options.webSign) {
      const uifid = String(params.uifid || "");
      if (uifid) {
        const tsSec = Math.floor((Date.now() + (await credentials.getClockSkew())) / 1000);
        urlQuery += "&timestamp=" + tsSec;
        const sig = Crypto.md5Hex(uifid + "_" + tsSec + "_" + CONFIG.WEB_SIGN_SALT + "_" + urlQuery);
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
          "User-Agent": credentials.userAgent,
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
          const freshWebId = await credentials.refreshWebIdChain();
          if (freshWebId) params.webid = freshWebId;
          return this.request(apiPath, params, { ...options, _webIdRetried: true });
        }
        throw new Error(bodyText ? `HTTP_${resp.status}: ${bodyText}` : `HTTP_${resp.status}`);
      }
      const data = await resp.json();
      if (data.status_code !== undefined && data.status_code !== 0) {
        console.warn("[DY] API_ERROR status_code=%s url=%s", data.status_code, apiPath);
        const err = new Error("API_ERROR");
        err.statusCode = data.status_code;
        throw err;
      }
      return data;
    } catch (e) {
      clearTimeout(tid);
      throw e;
    }
  }

  // 用签名客户端解析自身 sec_uid（消费方，非身份原语）
  async resolveSelfSecUid() {
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
      const data = await this.request("/aweme/v1/web/im/user/info/", await credentials.buildBaseParams(), {
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
}
const independentClient = new IndependentClient();

export { independentClient };
