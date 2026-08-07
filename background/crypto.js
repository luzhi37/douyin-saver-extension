// ===== 平台标注说明 =====
// 抖音（Douyin）：a_bogus 签名（ABogus）及其依赖（SM3 国密哈希 / RC4 / 自定义 Base64）
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

// 平台：抖音 — SM3 压缩轮函数（ABogus 依赖）
function rotl(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

// 平台：抖音 — SM3 压缩函数（ABogus 依赖）
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
  v[0] ^= A;
  v[1] ^= B;
  v[2] ^= C;
  v[3] ^= D;
  v[4] ^= E;
  v[5] ^= F;
  v[6] ^= G;
  v[7] ^= H;
  for (let i = 0; i < 8; i++) v[i] >>>= 0;
}

// 平台：抖音 — SM3 哈希（ABogus 依赖）
function sm3Hash(data) {
  if (typeof data === "string") data = new TextEncoder().encode(data);
  const bits = data.length * 8;
  const padLen = (data.length + 1 + 8 + 63) & ~63;
  const padded = new Uint8Array(padLen);
  padded.set(data);
  padded[data.length] = 0x80;
  for (let i = 0; i < 8; i++) padded[padLen - 8 + i] = (bits >>> (56 - i * 8)) & 0xff;
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
    const n = (str.charCodeAt(i) << 16) | (str.charCodeAt(i + 1) << 8) | str.charCodeAt(i + 2);
    out.push(alphabet[(n >>> 18) & 63], alphabet[(n >>> 12) & 63], alphabet[(n >>> 6) & 63], alphabet[n & 63]);
  }
  const rem = str.length % 3;
  if (rem === 1) {
    out.splice(-2, 2, "=", "=");
  } else if (rem === 2) {
    out.splice(-1, 1, "=");
  }
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

// 平台：抖音 — ABogus browserInfo 构造
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

// 平台：抖音 — a_bogus 签名主算法（background.js 独立模式请求使用）
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

  // 平台：抖音
  #genString2(params, method, startTime, endTime, clockSkew = 0) {
    startTime = startTime || (Date.now() + clockSkew) >>> 0;
    endTime = endTime || (startTime + 4 + Math.random() * 4) >>> 0;
    const pa = sm3ToArray(sm3ToArray(params + END_STRING));
    const ma = sm3ToArray(sm3ToArray(method + END_STRING));
    const list = [
      44,
      Math.floor(endTime / 16777216) % 256,
      0,
      0,
      0,
      0,
      24,
      pa[21],
      ma[21],
      0,
      this.uaCode[23],
      Math.floor(endTime / 65536) % 256,
      0,
      0,
      0,
      1,
      0,
      239,
      pa[22],
      ma[22],
      this.uaCode[24],
      Math.floor(endTime / 256) % 256,
      0,
      0,
      0,
      0,
      endTime % 256,
      0,
      0,
      14,
      Math.floor(startTime / 16777216) % 256,
      Math.floor(startTime / 65536) % 256,
      0,
      Math.floor(startTime / 256) % 256,
      startTime % 256,
      3,
      Math.floor(endTime / 4294967296),
      1,
      Math.floor(startTime / 4294967296),
      1,
      this.browserLen,
      0,
      0,
      0,
    ];
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

// 平台：通用 — Cookie 字符串解析工具
export function parseCookieToPairs(cookieStr) {
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
export function generateRandomMsToken(size = 156) {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let result = "";
  for (let i = 0; i < size; i++) {
    result += chars[(Math.random() * chars.length) | 0];
  }
  return result;
}
