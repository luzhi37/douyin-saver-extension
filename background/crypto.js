const IV = [0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e];

// ===== ABogus 算法实现常量 =====
const S3 = "ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe";
const S4 = "Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe";
const END_STRING = "cus";
const UA_ENCRYPT_KEY = "\x00\x01\x0e";
const UA_DEFAULT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

// ===== XBogus 常量 =====
const XBOGUS_ALPHABET = "Dkdpgh4ZKsQB80/Mfvw36XI1R25-WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=";
const XBOGUS_MD5_INDEX = [
  ...Array(48).fill(null),
  ...Array.from({ length: 10 }, (_, i) => i),
  ...Array(39).fill(null),
  ...Array.from({ length: 6 }, (_, i) => i + 10),
];
const XBOGUS_CANVAS = 3873194319;

// ===== XGnarly 常量 =====
const XGNARLY_AA = [
  0xFFFFFFFF, 138, 1498001188, 211147047, 253, null, 203, 288, 9, 1196819126,
  3212677781, 135, 263, 193, 58, 18, 244, 2931180889, 240, 173, 268, 2157053261,
  261, 175, 14, 5, 171, 270, 156, 258, 13, 15, 3732962506, 185, 169, 2, 6, 132,
  162, 200, 3, 160, 217618912, 62, 2517678443, 44, 164, 4, 96, 183, 2903579748,
  3863347763, 119, 181, 10, 190, 8, 2654435769, 259, 104, 230, 128, 2633865432,
  225, 1, 257, 143, 179, 16, 600974999, 185100057, 32, 188, 53, 2718276124, 177,
  196, 4294967296, 147, 117, 17, 49, 7, 28, 12, 266, 216, 11, 0, 45, 166, 247,
  1451689750,
];
const XGNARLY_OT = [XGNARLY_AA[9], XGNARLY_AA[69], XGNARLY_AA[51], XGNARLY_AA[92]];
const XGNARLY_ALPHABET = "u09tbS3UvgDEe6r-ZVMXzLpsAohTn7mdINQlW412GqBjfYiyk8JORCF5/xKHwacP=";

// ===== TikTok 常量 =====
const TIKTOK_DEVICE_ID_REGEX = /"wid":"(\d{19})"/;

function rotl(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

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

function sm3ToArray(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  return Array.from(sm3Hash(bytes));
}

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

function list1(r, a = 170, b = 85, c = 45) {
  const v = [r, r & 255, (r >> 8) & 255];
  return [(v[1] & a) | 1, (v[1] & b) | 2, (v[2] & a) | 5, (v[2] & b) | (c & a)];
}

function list2(r, a = 170, b = 85) {
  const v = [r, r & 255, (r >> 8) & 255];
  return [(v[1] & a) | 1, (v[1] & b) | 0, (v[2] & a) | 0, (v[2] & b) | 0];
}

function list3(r, a = 170, b = 85) {
  const v = [r, r & 255, (r >> 8) & 255];
  return [(v[1] & a) | 1, (v[1] & b) | 0, (v[2] & a) | 5, (v[2] & b) | 0];
}

function genString1(rand1, rand2, rand3) {
  const a = list1(rand1),
    b = list2(rand2),
    c = list3(rand3);
  return String.fromCharCode(a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3], c[0], c[1], c[2], c[3]);
}

function genBrowserInfo(platform, features = {}) {
  const sw = features.screenWidth || 1536;
  const sh = features.screenHeight || 864;
  const iw = sw, ih = sh - 122;
  const ow = sw, oh = sh;
  return `${iw}|${ih}|${ow}|${oh}|0|0|0|0|${ow}|${oh}|${ow}|${oh}|${iw}|${ih}|24|24|${platform || "Win32"}`;
}

function endCheck(a) {
  let r = 0;
  for (const x of a) r ^= x;
  return r;
}

export class ABogus {
  constructor(userAgent, platform, features = {}) {
    this.userAgent = userAgent || UA_DEFAULT;
    const browser = genBrowserInfo(platform, features);
    this.uaCode = this.#genUaCode(this.userAgent);
    this.browserLen = browser.length;
    this.browserCode = [...browser].map((c) => c.charCodeAt(0));
  }

  #genUaCode(ua) {
    const e = rc4Encrypt(ua, UA_ENCRYPT_KEY);
    const b64 = customB64Encode(e, S3);
    return abogusSum(b64);
  }

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

export function getVerifyFp(timestamp) {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const t = (timestamp || Date.now()).toString(36);
  const arr = Array(36).fill("");
  arr[8] = arr[13] = arr[18] = arr[23] = "_";
  arr[14] = "4";
  for (let i = 0; i < 36; i++) {
    if (!arr[i]) {
      const n = (Math.random() * chars.length) | 0;
      arr[i] = i === 19 ? chars[(3 & n) | 8] : chars[n];
    }
  }
  return "verify_" + t + "_" + arr.join("");
}

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

// ===== MD5 哈希 =====

function md5(message) {
  function rh(n) {
    let j;
    const s = "0123456789abcdef";
    let str = "";
    for (j = 0; j <= 3; j++) str += s[(n >> (j * 8 + 4)) & 0x0f] + s[(n >> (j * 8)) & 0x0f];
    return str;
  }
  function ad(x, y) {
    const l = (x & 0xffff) + (y & 0xffff);
    const m = (x >> 16) + (y >> 16) + (l >> 16);
    return (m << 16) | (l & 0xffff);
  }
  function rl(n, c) {
    return (n << c) | (n >>> (32 - c));
  }
  function cm(q, a, b, x, s, t) {
    return ad(rl(ad(ad(a, q), ad(x, t)), s), b);
  }
  function ff(a, b, c, d, x, s, t) {
    return cm((b & c) | (~b & d), a, b, x, s, t);
  }
  function gg(a, b, c, d, x, s, t) {
    return cm((b & d) | (c & ~d), a, b, x, s, t);
  }
  function hh(a, b, c, d, x, s, t) {
    return cm(b ^ c ^ d, a, b, x, s, t);
  }
  function ii(a, b, c, d, x, s, t) {
    return cm(c ^ (b | ~d), a, b, x, s, t);
  }
  function sb(s) {
    const nblk = ((s.length + 8) >> 6) + 1;
    const blks = new Array(nblk * 16);
    let i;
    for (i = 0; i < nblk * 16; i++) blks[i] = 0;
    for (i = 0; i < s.length; i++) blks[i >> 2] |= s.charCodeAt(i) << ((i % 4) * 8);
    blks[i >> 2] |= 0x80 << ((i % 4) * 8);
    blks[nblk * 16 - 2] = s.length * 8;
    return blks;
  }
  const x = sb(message);
  let a = 1732584193;
  let b = -271733879;
  let c = -1732584194;
  let d = 271733878;
  for (let i = 0; i < x.length; i += 16) {
    const oa = a, ob = b, oc = c, od = d;
    a = ff(a, b, c, d, x[i], 7, -680876936);
    d = ff(d, a, b, c, x[i + 1], 12, -389564586);
    c = ff(c, d, a, b, x[i + 2], 17, 606105819);
    b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, x[i + 4], 7, -176418897);
    d = ff(d, a, b, c, x[i + 5], 12, 1200080426);
    c = ff(c, d, a, b, x[i + 6], 17, -1473231341);
    b = ff(b, c, d, a, x[i + 7], 22, -45705983);
    a = ff(a, b, c, d, x[i + 8], 7, 1770035416);
    d = ff(d, a, b, c, x[i + 9], 12, -1958414417);
    c = ff(c, d, a, b, x[i + 10], 17, -42063);
    b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, x[i + 12], 7, 1804603682);
    d = ff(d, a, b, c, x[i + 13], 12, -40341101);
    c = ff(c, d, a, b, x[i + 14], 17, -1502002290);
    b = ff(b, c, d, a, x[i + 15], 22, 1236535329);
    a = gg(a, b, c, d, x[i + 1], 5, -165796510);
    d = gg(d, a, b, c, x[i + 6], 9, -1069501632);
    c = gg(c, d, a, b, x[i + 11], 14, 643717713);
    b = gg(b, c, d, a, x[i], 20, -373897302);
    a = gg(a, b, c, d, x[i + 5], 5, -701558691);
    d = gg(d, a, b, c, x[i + 10], 9, 38016083);
    c = gg(c, d, a, b, x[i + 15], 14, -660478335);
    b = gg(b, c, d, a, x[i + 4], 20, -405537848);
    a = gg(a, b, c, d, x[i + 9], 5, 568446438);
    d = gg(d, a, b, c, x[i + 14], 9, -1019803690);
    c = gg(c, d, a, b, x[i + 3], 14, -187363961);
    b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, x[i + 13], 5, -1444681467);
    d = gg(d, a, b, c, x[i + 2], 9, -51403784);
    c = gg(c, d, a, b, x[i + 7], 14, 1735328473);
    b = gg(b, c, d, a, x[i + 12], 20, -1926607734);
    a = hh(a, b, c, d, x[i + 5], 4, -378558);
    d = hh(d, a, b, c, x[i + 8], 11, -2022574463);
    c = hh(c, d, a, b, x[i + 11], 16, 1839030562);
    b = hh(b, c, d, a, x[i + 14], 23, -35309556);
    a = hh(a, b, c, d, x[i + 1], 4, -1530992060);
    d = hh(d, a, b, c, x[i + 4], 11, 1272893353);
    c = hh(c, d, a, b, x[i + 7], 16, -155497632);
    b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, x[i + 13], 4, 681279174);
    d = hh(d, a, b, c, x[i], 11, -358537222);
    c = hh(c, d, a, b, x[i + 3], 16, -722521979);
    b = hh(b, c, d, a, x[i + 6], 23, 76029189);
    a = hh(a, b, c, d, x[i + 9], 4, -640364487);
    d = hh(d, a, b, c, x[i + 12], 11, -421815835);
    c = hh(c, d, a, b, x[i + 15], 16, 530742520);
    b = hh(b, c, d, a, x[i + 2], 23, -995338651);
    a = ii(a, b, c, d, x[i], 6, -198630844);
    d = ii(d, a, b, c, x[i + 7], 10, 1126891415);
    c = ii(c, d, a, b, x[i + 14], 15, -1416354905);
    b = ii(b, c, d, a, x[i + 5], 21, -57434055);
    a = ii(a, b, c, d, x[i + 12], 6, 1700485571);
    d = ii(d, a, b, c, x[i + 3], 10, -1894986606);
    c = ii(c, d, a, b, x[i + 10], 15, -1051523);
    b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, x[i + 8], 6, 1873313359);
    d = ii(d, a, b, c, x[i + 15], 10, -30611744);
    c = ii(c, d, a, b, x[i + 6], 15, -1560198380);
    b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, x[i + 4], 6, -145523070);
    d = ii(d, a, b, c, x[i + 11], 10, -1120210379);
    c = ii(c, d, a, b, x[i + 2], 15, 718787259);
    b = ii(b, c, d, a, x[i + 9], 21, -343485551);
    a = ad(a, oa);
    b = ad(b, ob);
    c = ad(c, oc);
    d = ad(d, od);
  }
  return rh(a) + rh(b) + rh(c) + rh(d);
}

function md5Bytes(input) {
  const hex = md5(input);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// ===== XBogus - 抖音/TikTok 旧版签名 =====

function xbogusDisturbArray(a, b, e, d, c, f, t, n, o, i, r, _, x, u, s, l, v, h, g) {
  const arr = new Array(19);
  arr[0] = a; arr[10] = b; arr[1] = e; arr[11] = d; arr[2] = c; arr[12] = f;
  arr[3] = t; arr[13] = n; arr[4] = o; arr[14] = i; arr[5] = r; arr[15] = _;
  arr[6] = x; arr[16] = u; arr[7] = s; arr[17] = l; arr[8] = v; arr[18] = h; arr[9] = g;
  return arr;
}

function xbogusGarbled1(a, b, e, d, c, f, t, n, o, i, r, _, x, u, s, l, v, h, g) {
  const arr = new Array(19);
  arr[0] = a; arr[1] = r; arr[2] = b; arr[3] = _; arr[4] = e; arr[5] = x;
  arr[6] = d; arr[7] = u; arr[8] = c; arr[9] = s; arr[10] = f; arr[11] = l;
  arr[12] = t; arr[13] = v; arr[14] = n; arr[15] = h; arr[16] = o; arr[17] = g; arr[18] = i;
  return arr.map((v) => String.fromCharCode(v | 0)).join("");
}

function xbogusNum(text) {
  const result = [];
  for (let i = 0; i < 21; i += 3) {
    result.push((text.charCodeAt(i) << 16) | (text.charCodeAt(i + 1) << 8) | text.charCodeAt(i + 2));
  }
  return result;
}

function xbogusGarbled2(a, b, c) {
  return String.fromCharCode(a) + String.fromCharCode(b) + c;
}

function xbogusGarbled3(key, b) {
  const d = Array.from({ length: 256 }, (_, i) => i);
  let c = 0;
  for (let bIdx = 0; bIdx < 256; bIdx++) {
    c = (c + d[bIdx] + key.charCodeAt(bIdx % key.length)) % 256;
    [d[bIdx], d[c]] = [d[c], d[bIdx]];
  }
  let t = 0, c2 = 0;
  let result = "";
  for (let bIdx = 0; bIdx < b.length; bIdx++) {
    t = (t + 1) % 256;
    c2 = (c2 + d[t]) % 256;
    [d[t], d[c2]] = [d[c2], d[t]];
    result += String.fromCharCode(b.charCodeAt(bIdx) ^ d[(d[t] + d[c2]) % 256]);
  }
  return result;
}

function xbogusMd5ToArray(input) {
  if (typeof input === "string" && input.length > 32) {
    return Array.from(input, (ch) => ch.charCodeAt(0));
  }
  const arr = input;
  const result = [];
  for (let i = 0; i < arr.length; i += 2) {
    result.push((XBOGUS_MD5_INDEX[arr.charCodeAt(i)] << 4) | XBOGUS_MD5_INDEX[arr.charCodeAt(i + 1)]);
  }
  return result;
}

function xbogusProcessUrlPath(path) {
  return xbogusMd5ToArray(md5(xbogusMd5ToArray(md5(path)).map((b) => String.fromCharCode(b)).join("")));
}

function xbogusGenerateStr(num) {
  const shifts = [18, 12, 6, 0];
  const masks = [16515072, 258048, 4032, 63];
  const parts = masks.map((m, j) => (num & m) >> shifts[j]);
  return parts.map((i) => XBOGUS_ALPHABET[i]).join("");
}

function xbogusHandleUa(a, bBytes) {
  const d = Array.from({ length: 256 }, (_, i) => i);
  let c = 0;
  for (let i = 0; i < 256; i++) {
    c = (c + d[i] + a.charCodeAt(i % a.length)) % 256;
    [d[i], d[c]] = [d[c], d[i]];
  }
  let t = 0, c2 = 0;
  const result = new Uint8Array(bBytes.length);
  for (let i = 0; i < bBytes.length; i++) {
    t = (t + 1) % 256;
    c2 = (c2 + d[t]) % 256;
    [d[t], d[c2]] = [d[c2], d[t]];
    result[i] = bBytes[i] ^ d[(d[t] + d[c2]) % 256];
  }
  return result;
}

function xbogusGenerateUaArray(userAgent, params) {
  const uaKey = "\x00\x01" + String.fromCharCode(params);
  const enc = xbogusHandleUa(uaKey, new TextEncoder().encode(userAgent));
  let bin = "";
  for (let i = 0; i < enc.length; i++) bin += String.fromCharCode(enc[i]);
  const b64 = btoa(bin);
  return Array.from(md5Bytes(b64));
}

export class XBogus {
  getXBogus(query, params = 8, userAgent, timestamp) {
    if (!timestamp) timestamp = Math.floor(Date.now() / 1000);
    const queryStr = typeof query === "object" ? new URLSearchParams(query).toString() : String(query);
    const queryArr = xbogusProcessUrlPath(queryStr);
    const uaArray = xbogusGenerateUaArray(userAgent, params);
    const arr = [
      64,
      0.00390625,
      1,
      params,
      queryArr[queryArr.length - 2],
      queryArr[queryArr.length - 1],
      69,
      63,
      uaArray[uaArray.length - 2],
      uaArray[uaArray.length - 1],
      (timestamp >> 24) & 255,
      (timestamp >> 16) & 255,
      (timestamp >> 8) & 255,
      timestamp & 255,
      (XBOGUS_CANVAS >> 24) & 255,
      (XBOGUS_CANVAS >> 16) & 255,
      (XBOGUS_CANVAS >> 8) & 255,
      XBOGUS_CANVAS & 255,
      null,
    ];
    let xor = 0;
    for (const v of arr.slice(0, -1)) xor ^= v | 0;
    arr[arr.length - 1] = xor;
    const disturbed = xbogusDisturbArray(...arr);
    const garbled = xbogusGarbled1(...disturbed);
    const garbled3 = xbogusGarbled3("\u00ff", garbled);
    const garbled2 = xbogusGarbled2(2, 255, garbled3);
    return xbogusNum(garbled2).map(xbogusGenerateStr).join("");
  }
}

// ===== ChaCha20 - XGnarly 依赖 =====

function chachaU32(x) {
  return x >>> 0;
}

function chachaRotl(x, n) {
  return chachaU32(((x << n) | (x >>> (32 - n))) >>> 0);
}

function chachaQuarter(st, a, b, c, d) {
  st[a] = chachaU32(st[a] + st[b]);
  st[d] = chachaRotl(st[d] ^ st[a], 16);
  st[c] = chachaU32(st[c] + st[d]);
  st[b] = chachaRotl(st[b] ^ st[c], 12);
  st[a] = chachaU32(st[a] + st[b]);
  st[d] = chachaRotl(st[d] ^ st[a], 8);
  st[c] = chachaU32(st[c] + st[d]);
  st[b] = chachaRotl(st[b] ^ st[c], 7);
}

function chachaBlock(state, rounds) {
  const w = state.slice();
  for (let r = 0; r < rounds; ) {
    chachaQuarter(w, 0, 4, 8, 12);
    chachaQuarter(w, 1, 5, 9, 13);
    chachaQuarter(w, 2, 6, 10, 14);
    chachaQuarter(w, 3, 7, 11, 15);
    r++;
    if (r >= rounds) break;
    chachaQuarter(w, 0, 5, 10, 15);
    chachaQuarter(w, 1, 6, 11, 12);
    chachaQuarter(w, 2, 7, 12, 13);
    chachaQuarter(w, 3, 4, 13, 14);
    r++;
  }
  for (let i = 0; i < 16; i++) w[i] = chachaU32(w[i] + state[i]);
  return w;
}

// ===== XGnarly - TikTok Web 最新签名 =====

function xgnarlyNumToBytes(val) {
  if (val < 65535) return [(val >> 8) & 0xff, val & 0xff];
  return [(val >> 24) & 0xff, (val >> 16) & 0xff, (val >> 8) & 0xff, val & 0xff];
}

function xgnarlyBeInt(s) {
  const b = new TextEncoder().encode(s).slice(0, 4);
  let acc = 0;
  for (const x of b) acc = ((acc << 8) | x) >>> 0;
  return acc;
}

export class XGnarly {
  constructor() {
    this.St = 0;
    this.kt = new Array(16);
    this.#initPrngState();
  }

  #initPrngState() {
    const nowMs = Date.now();
    this.kt[0] = XGNARLY_AA[44];
    this.kt[1] = XGNARLY_AA[74];
    this.kt[2] = XGNARLY_AA[10];
    this.kt[3] = XGNARLY_AA[62];
    this.kt[4] = XGNARLY_AA[42];
    this.kt[5] = XGNARLY_AA[17];
    this.kt[6] = XGNARLY_AA[2];
    this.kt[7] = XGNARLY_AA[21];
    this.kt[8] = XGNARLY_AA[3];
    this.kt[9] = XGNARLY_AA[70];
    this.kt[10] = XGNARLY_AA[50];
    this.kt[11] = XGNARLY_AA[32];
    this.kt[12] = (XGNARLY_AA[0] & nowMs) >>> 0;
    this.kt[13] = Math.floor(Math.random() * XGNARLY_AA[77]);
    this.kt[14] = Math.floor(Math.random() * XGNARLY_AA[77]);
    this.kt[15] = Math.floor(Math.random() * XGNARLY_AA[77]);
    this.St = XGNARLY_AA[88];
  }

  #bumpCounter() {
    this.kt[12] = (this.kt[12] + 1) >>> 0;
  }

  rand() {
    const e = chachaBlock(this.kt, 8);
    const t = e[this.St];
    const r = (e[this.St + 8] & 0xfffffff0) >>> 11;
    if (this.St === 7) {
      this.#bumpCounter();
      this.St = 0;
    } else {
      this.St++;
    }
    return (t + 4294967296 * r) / Math.pow(2, 53);
  }

  #encryptChacha(keyWords, rounds, data) {
    const len = data.length;
    const nFull = (len / 4) | 0;
    const leftover = len % 4;
    const words = new Array(Math.ceil(len / 4)).fill(0);

    for (let i = 0; i < nFull; i++) {
      const j = i * 4;
      words[i] = (data[j] | (data[j + 1] << 8) | (data[j + 2] << 16) | (data[j + 3] << 24)) >>> 0;
    }
    if (leftover) {
      let v = 0;
      const base = nFull * 4;
      for (let c = 0; c < leftover; c++) v |= data[base + c] << (8 * c);
      words[nFull] = v >>> 0;
    }

    const state = keyWords.slice();
    let o = 0;
    while (o + 16 < words.length) {
      const stream = chachaBlock(state, rounds);
      state[12] = (state[12] + 1) >>> 0;
      for (let k = 0; k < 16; k++) words[o + k] = (words[o + k] ^ stream[k]) >>> 0;
      o += 16;
    }
    if (o < words.length) {
      const stream = chachaBlock(state, rounds);
      for (let k = 0; k < words.length - o; k++) words[o + k] = (words[o + k] ^ stream[k]) >>> 0;
    }

    for (let i = 0; i < nFull; i++) {
      const w = words[i];
      const j = i * 4;
      data[j] = w & 0xff;
      data[j + 1] = (w >> 8) & 0xff;
      data[j + 2] = (w >> 16) & 0xff;
      data[j + 3] = (w >> 24) & 0xff;
    }
    if (leftover) {
      const w = words[nFull];
      const base = nFull * 4;
      for (let c = 0; c < leftover; c++) data[base + c] = (w >> (8 * c)) & 0xff;
    }
  }

  #ab22(key12Words, rounds, s) {
    const state = [...XGNARLY_OT, ...key12Words];
    const data = Array.from(s, (ch) => ch.charCodeAt(0));
    this.#encryptChacha(state, rounds, data);
    return data.map((x) => String.fromCharCode(x)).join("");
  }

  generate(queryString, body = "", userAgent, envcode = 0, version = "5.1.1") {
    const timestampMs = Date.now();

    const obj = new Map();
    obj.set(1, 1);
    obj.set(2, envcode);
    obj.set(3, md5(String(queryString)));
    obj.set(4, md5(String(body)));
    obj.set(5, md5(String(userAgent)));
    obj.set(6, Math.floor(timestampMs / 1000));
    obj.set(7, 1508145731);
    obj.set(8, Math.floor((timestampMs * 1000) % 2147483648));
    obj.set(9, version);

    if (version === "5.1.1") {
      obj.set(10, "1.0.0.314");
      obj.set(11, 1);
      let v12 = 0;
      for (let i = 1; i <= 11; i++) {
        const v = obj.get(i);
        const toXor = typeof v === "number" ? v : xgnarlyBeInt(v);
        v12 ^= toXor;
      }
      obj.set(12, v12 >>> 0);
    } else if (version !== "5.1.0") {
      throw new Error("Unsupported version: " + version);
    }

    let v0 = 0;
    for (let i = 1; i <= obj.size; i++) {
      const v = obj.get(i);
      if (typeof v === "number") v0 ^= v;
    }
    obj.set(0, v0 >>> 0);

    const payload = [obj.size];
    for (const [k, v] of obj) {
      payload.push(k);
      const valBytes = typeof v === "number" ? xgnarlyNumToBytes(v) : Array.from(new TextEncoder().encode(v));
      payload.push(...xgnarlyNumToBytes(valBytes.length));
      payload.push(...valBytes);
    }
    const baseStr = payload.map((x) => String.fromCharCode(x & 0xff)).join("");

    const keyWords = [];
    const keyBytes = [];
    let roundAccum = 0;
    for (let i = 0; i < 12; i++) {
      const word = Math.floor(this.rand() * 4294967296) >>> 0;
      keyWords.push(word);
      roundAccum = (roundAccum + (word & 15)) & 15;
      keyBytes.push(word & 0xff, (word >> 8) & 0xff, (word >> 16) & 0xff, (word >> 24) & 0xff);
    }
    const rounds = roundAccum + 5;

    const enc = this.#ab22(keyWords, rounds, baseStr);

    let insertPos = 0;
    for (const b of keyBytes) insertPos = (insertPos + b) % (enc.length + 1);
    for (const ch of enc) insertPos = (insertPos + ch.charCodeAt(0)) % (enc.length + 1);

    const keyBytesStr = keyBytes.map((b) => String.fromCharCode(b)).join("");
    const finalStr = String.fromCharCode(((1 << 6) ^ (1 << 3) ^ 3) & 0xff) + enc.slice(0, insertPos) + keyBytesStr + enc.slice(insertPos);

    const out = [];
    const fullLen = (finalStr.length / 3 | 0) * 3;
    for (let i = 0; i < fullLen; i += 3) {
      const block = (finalStr.charCodeAt(i) << 16) | (finalStr.charCodeAt(i + 1) << 8) | finalStr.charCodeAt(i + 2);
      out.push(
        XGNARLY_ALPHABET[(block >> 18) & 63],
        XGNARLY_ALPHABET[(block >> 12) & 63],
        XGNARLY_ALPHABET[(block >> 6) & 63],
        XGNARLY_ALPHABET[block & 63],
      );
    }
    return out.join("");
  }
}

// ===== device_id - TikTok 设备 ID =====

export async function fetchDeviceId(userAgent) {
  const { savedDeviceId, savedDeviceIdTime } = await chrome.storage.local.get(["savedDeviceId", "savedDeviceIdTime"]);
  if (savedDeviceId && savedDeviceIdTime && Date.now() - savedDeviceIdTime < 3600000) {
    return savedDeviceId;
  }
  try {
    const resp = await fetch("https://www.tiktok.com/explore", {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": userAgent,
        "Accept-Language": "en-US,en;q=0.9",
      },
      credentials: "include",
    });
    if (!resp.ok) return "";
    const html = await resp.text();
    const m = html.match(TIKTOK_DEVICE_ID_REGEX);
    const deviceId = m ? m[1] : "";
    if (deviceId) await chrome.storage.local.set({ savedDeviceId: deviceId, savedDeviceIdTime: Date.now() });
    return deviceId;
  } catch {
    return "";
  }
}

export function generateRandomMsToken(size = 156) {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let result = "";
  for (let i = 0; i < size; i++) {
    result += chars[(Math.random() * chars.length) | 0];
  }
  return result;
}
