// ===== 平台标注说明 =====
// 抖音（Douyin）：a_bogus 签名（ABogus）及其依赖（SM3 国密哈希 / RC4 / 自定义 Base64）、
//                mssdk 静态设备上报载荷（MSSDK_STR_DATA，独立模式兑换真 msToken 用）
// 通用：两平台共用（msToken 生成 / Cookie 解析）
// 注：TikTok 相关签名（X-Bogus / X-Gnarly / device_id）已于 2026-08-04 移除，本扩展仅支持抖音
// ============================

// 平台：抖音 — SM3 国密哈希初始向量（ABogus 依赖）
const IV = [0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e];

// ===== ABogus 算法实现常量（平台：抖音 Douyin）=====
const S3 = "ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe";
const S4 = "Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe";
const END_STRING = "cus";
const UA_ENCRYPT_KEY = "\x00\x01\x0e";
const UA_DEFAULT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

// ===== 平台标注说明 =====
// 平台：抖音 — mssdk 静态设备上报载荷（独立模式兑换真 msToken 用）
// ============================

// 抓包固定的预加密上报 blob：POST 到 mssdk.bytedance.com/web/common，服务端校验通过后
// 通过 Set-Cookie 签发真 msToken（domain=bytedance.com，有效期 7 天）。
// 来源：TikTokDownloader src/encrypt/msToken.py MsToken.DATA（2026-08 实测有效）。
export const MSSDK_STR_DATA =
"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";

// 平台：抖音 — SM3 压缩轮函数（ABogus 依赖）
function rotl(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

// 平台：抖音 — SM3 压缩函数（ABogus 依赖，TikTokDownloader 风格的修改版 SM3，用于 abogusSum→uaCode）
function sm3Compress(v, block) {
  const W = new Array(68);
  for (let i = 0; i < 16; i++)
    W[i] = (block[i * 4] << 24) | (block[i * 4 + 1] << 16) | (block[i * 4 + 2] << 8) | block[i * 4 + 3];
  for (let i = 16; i < 68; i++) {
    const p1 = W[i - 16] ^ W[i - 9] ^ rotl(W[i - 3], 15);
    W[i] = (p1 ^ rotl(p1, 15) ^ rotl(p1, 23) ^ rotl(W[i - 13], 7) ^ W[i - 6]) >>> 0;
  }
  let [A, B, C, D, E, F, G, H] = v;
  for (let j = 0; j < 64; j++) {
    const T = j < 16 ? 0x79cc4519 : 0x7a879d8a;
    const FF = j < 16 ? A ^ B ^ C : (A & B) | (A & C) | (B & C);
    const GG = j < 16 ? E ^ F ^ G : (E & F) | (~E & G);
    const SS1 = rotl((rotl(A, 12) + E + rotl(T, j)) >>> 0, 7);
    const SS2 = SS1 ^ rotl(A, 12);
    const TT1 = (FF + D + SS2 + (W[j] ^ W[j + 4])) >>> 0;
    const TT2 = (GG + H + SS1 + W[j]) >>> 0;
    D = C;
    C = rotl(B, 9);
    B = A;
    A = TT1;
    H = G;
    G = rotl(F, 19);
    F = E;
    E = TT2 ^ rotl(TT2, 9) ^ rotl(TT2, 17);
  }
  v[0] = (v[0] ^ A) >>> 0; v[1] = (v[1] ^ B) >>> 0;
  v[2] = (v[2] ^ C) >>> 0; v[3] = (v[3] ^ D) >>> 0;
  v[4] = (v[4] ^ E) >>> 0; v[5] = (v[5] ^ F) >>> 0;
  v[6] = (v[6] ^ G) >>> 0; v[7] = (v[7] ^ H) >>> 0;
}

// 平台：抖音 — SM3 哈希（ABogus 依赖）；标准 64 字节填充格式（用于 pa/ma 双重哈希，与 TikTokDownloader sm3_to_array→gmssl.sm3_hash 一致）
function sm3Hash(data) {
  if (typeof data === "string") data = new TextEncoder().encode(data);
  const bits = data.length * 8;
  const padLen = (data.length + 1 + 8 + 63) & ~63;
  const padded = new Uint8Array(padLen);
  padded.set(data);
  padded[data.length] = 0x80;
  const dv = new DataView(padded.buffer, padLen - 8, 8);
  dv.setBigUint64(0, BigInt(bits), false);
  const v = IV.slice();
  for (let off = 0; off < padLen; off += 64) sm3Compress(v, padded.subarray(off, off + 64));
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = v[i] >>> 24;
    out[i * 4 + 1] = (v[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (v[i] >>> 8) & 0xff;
    out[i * 4 + 3] = v[i] & 0xff;
  }
  return out;
}

// 平台：抖音 — SM3 摘要转字节数组（ABogus 依赖）
function sm3ToArray(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  return Array.from(sm3Hash(bytes));
}

// 平台：抖音 — a_bogus 求和摘要（ABogus 依赖）
function abogusSum(str) {
  const codes = [...str].map((c) => c.charCodeAt(0));
  const v = IV.slice();
  let chunk = codes.slice();
  while (chunk.length > 64) {
    sm3Compress(v, new Uint8Array(chunk.splice(0, 64)));
  }
  const size = codes.length;
  chunk.push(0x80);
  if (chunk.length > 60) {
    while (chunk.length < 64) chunk.push(0);
    sm3Compress(v, new Uint8Array(chunk.splice(0, 64)));
  }
  while (chunk.length < 60) chunk.push(0);
  const bitLen = size * 8;
  for (let i = 3; i >= 0; i--) chunk.push((bitLen >>> (i * 8)) & 0xff);
  sm3Compress(v, new Uint8Array(chunk));
  const out = new Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = v[i] >>> 24;
    out[i * 4 + 1] = (v[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (v[i] >>> 8) & 0xff;
    out[i * 4 + 3] = v[i] & 0xff;
  }
  return out;
}

// 平台：抖音 — RC4 流加密（ABogus 依赖）
function rc4Encrypt(plaintext, key) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key.charCodeAt(i % key.length)) % 256;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = [];
  for (let k = 0, i = 0, j = 0; k < plaintext.length; k++) {
    i = (i + 1) % 256;
    j = (j + s[i]) % 256;
    [s[i], s[j]] = [s[j], s[i]];
    out.push(String.fromCharCode(s[(s[i] + s[j]) % 256] ^ plaintext.charCodeAt(k)));
  }
  return out.join("");
}

// 平台：抖音 — 自定义 Base64（ABogus 依赖）
function customB64Encode(str, alphabet) {
  const out = [];
  for (let i = 0; i < str.length; i += 3) {
    let n;
    if (i + 2 < str.length) {
      n = (str.charCodeAt(i) << 16) | (str.charCodeAt(i + 1) << 8) | str.charCodeAt(i + 2);
    } else if (i + 1 < str.length) {
      n = (str.charCodeAt(i) << 16) | (str.charCodeAt(i + 1) << 8);
    } else {
      n = str.charCodeAt(i) << 16;
    }
    for (let j = 18, k = 0xfc0000; j >= 0; j -= 6, k = k >>> 6) {
      if (j === 6 && i + 1 >= str.length) break;
      if (j === 0 && i + 2 >= str.length) break;
      out.push(alphabet[(n & k) >> j]);
    }
  }
  out.push("=".repeat((4 - out.length % 4) % 4));
  return out.join("");
}

// 平台：抖音 — ABogus string_1 随机数列表
function list1(r, a = 170, b = 85, c = 45) {
  const v = [r, r & 255, (r >> 8) & 255];
  return [(v[1] & a) | 1, (v[1] & b) | 2, (v[2] & a) | 5, (v[2] & b) | (c & a)];
}

// 平台：抖音 — ABogus string_1 随机数列表
function list2(r, a = 170, b = 85) {
  const v = [r, r & 255, (r >> 8) & 255];
  return [(v[1] & a) | 1, (v[1] & b) | 0, (v[2] & a) | 0, (v[2] & b) | 0];
}

// 平台：抖音 — ABogus string_1 随机数列表
function list3(r, a = 170, b = 85) {
  const v = [r, r & 255, (r >> 8) & 255];
  return [(v[1] & a) | 1, (v[1] & b) | 0, (v[2] & a) | 5, (v[2] & b) | 0];
}

// 平台：抖音 — ABogus 12 字符随机串 string_1
function genString1(rand1, rand2, rand3) {
  const a = list1(rand1),
    b = list2(rand2),
    c = list3(rand3);
  return String.fromCharCode(a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3], c[0], c[1], c[2], c[3]);
}

// 平台：抖音 — ABogus browserInfo 构造（完整 64 字符，用于注入列表末尾）
function genBrowserInfo(platform, features = {}) {
  const sw = features.screenWidth || 1536;
  const sh = features.screenHeight || 864;
  const iw = sw, ih = sh - 122;
  const ow = sw, oh = sh;
  return `${iw}|${ih}|${ow}|${oh}|0|0|0|0|${ow}|${oh}|${ow}|${oh}|${iw}|${ih}|24|24|${platform || "Win32"}`;
}

// 平台：抖音 — ABogus 校验位 endCheck
function endCheck(a) {
  let r = 0;
  for (const x of a) r ^= x;
  return r;
}

// 平台：抖音 — a_bogus 签名主算法（background 独立模式请求使用）
export class ABogus {
  constructor(userAgent, platform, features = {}) {
    this.userAgent = userAgent || UA_DEFAULT;
    const browser = genBrowserInfo(platform, features);
    this.uaCode = this.#genUaCode(this.userAgent);
    this.browserLen = browser.length;
    this.browserCode = [...browser].map((c) => c.charCodeAt(0));
  }

  // 平台：抖音
  #genUaCode(ua) {
    const e = rc4Encrypt(ua, UA_ENCRYPT_KEY);
    const b64 = customB64Encode(e, S3);
    return abogusSum(b64);
  }

  // 平台：抖音 — TikTokDownloader list_4 布局（a=etB3, b=pa[21], c=uaCode[23], d=etB2, e=pa[22], f=uaCode[24], g=etB1, h=etB0, i=stB3, j=stB2, k=stB1, m=stB0, n=ma[21], o=ma[22], p=etH, q=stH, r=browserLen）
  #genString2List(params, method, startTime, endTime) {
    const pa = sm3ToArray(sm3ToArray(params + END_STRING));
    const ma = sm3ToArray(sm3ToArray(method + END_STRING));
    const etB0 = endTime % 256,
      etB1 = Math.floor(endTime / 256) % 256,
      etB2 = Math.floor(endTime / 65536) % 256,
      etB3 = Math.floor(endTime / 16777216) % 256,
      etH = Math.floor(endTime / 4294967296);
    const stB0 = startTime % 256,
      stB1 = Math.floor(startTime / 256) % 256,
      stB2 = Math.floor(startTime / 65536) % 256,
      stB3 = Math.floor(startTime / 16777216) % 256,
      stH = Math.floor(startTime / 4294967296);
    return [
      44, etB3, 0, 0, 0, 0,
      24, pa[21], ma[21], 0, this.uaCode[23], etB2, 0, 0, 0, 1,
      0, 239, pa[22], ma[22], this.uaCode[24], etB1, 0, 0, 0, 0,
      etB0, 0, 0, 14, stB3, stB2, 0, stB1, stB0, 3,
      etH, 1, stH, 1,
      this.browserLen, 0, 0, 0,
    ];
  }

  // 平台：抖音
  #genString2(params, method, startTime, endTime, clockSkew = 0) {
    startTime = startTime || (Date.now() + clockSkew);
    endTime = endTime || (startTime + 4 + Math.random() * 4);
    const list = this.#genString2List(params, method, startTime, endTime);
    const ec = endCheck(list);
    const all = [...list, ...this.browserCode, ec];
    return rc4Encrypt(String.fromCharCode(...all), "y");
  }

  // 平台：抖音 — 生成 a_bogus 值
  getValue(urlParams, method = "GET", clockSkew = 0) {
    const qs = typeof urlParams === "string" ? urlParams : new URLSearchParams(urlParams).toString();
    const r1 = (Math.random() * 10000) | 0,
      r2 = (Math.random() * 10000) | 0,
      r3 = (Math.random() * 10000) | 0;
    const s1 = genString1(r1, r2, r3);
    const s2 = this.#genString2(qs, method, undefined, undefined, clockSkew);
    return customB64Encode(s1 + s2, S4);
  }
}

// 平台：抖音 — 标准 MD5（UTF-8 字符串 → 32 位小写 hex；Argus x-secsdk-web-signature 依赖）
// 通用：Cookie 解析 / msToken 生成。三者均为无状态纯函数，折进 Crypto 静态类
// （小写 crypto 是全局 Web Crypto，故类名首字母大写以免遮蔽）
export class Crypto {
  static md5Hex(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    const bitLenHi = Math.floor(bytes.length / 0x20000000);
    const bitLenLo = (bytes.length << 3) >>> 0;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (let i = 0; i < 4; i++) bytes.push((bitLenLo >>> (i * 8)) & 0xff);
    for (let i = 0; i < 4; i++) bytes.push((bitLenHi >>> (i * 8)) & 0xff);

    const K = new Array(64);
    for (let i = 0; i < 64; i++) K[i] = (Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    const S = [
      7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];

    const add = (x, y) => (x + y) | 0;
    const rotl = (x, n) => (x << n) | (x >>> (32 - n));
    let a0 = 1732584193, b0 = -271733879, c0 = -1732584194, d0 = 271733878;

    for (let off = 0; off < bytes.length; off += 64) {
      const M = new Array(16);
      for (let j = 0; j < 16; j++)
        M[j] =
          bytes[off + j * 4] |
          (bytes[off + j * 4 + 1] << 8) |
          (bytes[off + j * 4 + 2] << 16) |
          (bytes[off + j * 4 + 3] << 24);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
        else { F = C ^ (B | ~D); g = (7 * i) & 15; }
        F = add(add(F, A), add(K[i], M[g]));
        A = D; D = C; C = B;
        B = add(B, rotl(F, S[i]));
      }
      a0 = add(a0, A); b0 = add(b0, B); c0 = add(c0, C); d0 = add(d0, D);
    }
    const hex = (x) => {
      let s = "";
      for (let i = 0; i < 4; i++) s += ((x >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
      return s;
    };
    return hex(a0) + hex(b0) + hex(c0) + hex(d0);
  }

  // 平台：通用 — Cookie 字符串解析工具
  static parseCookieToPairs(cookieStr) {
    return cookieStr
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const idx = s.indexOf("=");
        return idx > 0 ? { key: s.slice(0, idx), value: s.slice(idx + 1) } : null;
      })
      .filter(Boolean);
  }

  // 平台：通用 — msToken 生成（抖音/TikTok 共用；本项目用于抖音请求）
  static generateRandomMsToken(size = 156) {
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let result = "";
    for (let i = 0; i < size; i++) {
      result += chars[(Math.random() * chars.length) | 0];
    }
    return result;
  }
}
