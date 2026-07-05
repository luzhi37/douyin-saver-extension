# 双模式架构：依赖标签页 / 独立运行

## 背景

扩展当前完全依赖抖音标签页中的 `inject.js` 来执行 API 请求。流程为：

```
options → background → sendToTab → content.js → inject.js → API fetch
```

所有签名参数（`a_bogus`、`msToken` 等）通过 Fetch Hook 从页面真实请求中**被动捕获**。此方式有两个固有依赖：

1. 必须有一个打开的抖音标签页（`withDouyinTab()`）
2. 必须先浏览产生对应 API 请求的页面才能捕获签名

本项目新增**独立模式**：background service worker 直接生成签名并调用 Douyin API，不依赖任何抖音标签页。

---

## 两种模式

| | 依赖标签页模式（现有 + 微调） | 独立模式（新增） |
|---|---|---|
| API 执行者 | inject.js（在抖音页面主世界） | background.js（Service Worker） |
| 签名来源 | Fetch Hook 从页面请求捕获 | crypto.js 本地算法生成 |
| 抖音标签页 | **必需** | **不必要** |
| Cookie | 浏览器自动携带（inject.js 同源请求） | 仅从 `chrome.storage.local` 的 `savedCookie` 读取，独立模式所有请求使用显式 `Cookie` header，不会自动携带浏览器 cookie |
| 消息链路 | `options → background → sendToTab → inject` | `options → background → direct fetch` |
| msToken | 从 URL 捕获或 Cookie 读取 | 从 Cookie 解析 / mssdk API / 假 token |
| ttwid | 从 Cookie 读取 | Cookie 自动携带 / ttwid API 刷新 |
| verifyFp | 从 localStorage 或 URL 捕获 | 本地生成 |
| a_bogus | 从 URL 捕获 | 本地生成（SM3 + RC4） |
| 浏览器特征 | 自动从真实页面环境获取 | 从 `chrome.storage.local` 读取（可自动捕获或手动填写） |

**两个模式完全隔离**，不共享算法代码、不共用缓存变量。

### 关键约束：options–background 消息接口与模式无关

无论当前哪种模式，**options.js 发出的消息类型和参数格式完全相同**，收到的响应和数据格式也完全相同。模式路由完全由 background.js 内部消化，对 options.js 透明。

| 接口层 | 职责 |
|---|---|
| `options.js` | 发送 `FETCH_FOLLOWING`、`SYNC_WORKS` 等消息，消费返回的标准响应格式。**不知道也不关心当前模式** |
| `background.js` 消息路由 | 检查 `independentMode` 标志，分发到 tab 处理器或独立处理器。两个处理器产出**完全相同的响应形状** |
| 进度消息 | `FOLLOWING_PROGRESS` / `FAVORITES_PROGRESS` / `COLLECTION_PROGRESS` / `SYNC_PROGRESS` / `CANCEL_DONE` 等已在 background.js 循环中直接发出，与模式无关 |

`CANCEL_ACTIVE_TASK`：tab 模式下转发到 inject（现有逻辑），独立模式下由 background 内部消化 AbortController。options.js 只需发 `{ type: 'CANCEL_ACTIVE_TASK' }`，无需区分模式。

### 时序参数统一

双模式共用同一套请求时序参数，定义在 `background.js` 顶层的 `CONFIG` 对象中：

```js
CONFIG.DELAY = { MIN: 500, MAX: 1000 }                    // 单次请求间隔
CONFIG.SYNC  = { BATCH_SIZE: 40, BATCH_PAUSE_MIN: 10000,   // 同步批量暂停
                 BATCH_PAUSE_MAX: 20000, KEEPALIVE_INTERVAL: 2000 }
CONFIG.TIMEOUT = { REQUEST: 30000, SECURITY_STATUS: 5000 }
```

- 现有 tab 模式的 5 个 handler（`handleFetchFollowing`、`handleFetchFavorites`、`handleFetchCollection`、`runCancelBatch`、`handleSyncWorks`）已使用这些参数
- 独立模式的 handler 在同一个 `background.js` 中，直接引用同一个 `CONFIG` 对象
- 未来可在设置面板中添加 UI 控件让用户自定义这些参数

---

## 文件变更清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `background/crypto.js` | **新建** | SM3 + RC4 + 自定义 Base64 + ABogus + VerifyFp + msToken/ttwid 刷新 + cookie 解析 |
| `background/background.js` | 修改 | 导入 crypto.js；新增独立模式处理器；消息路由分叉；新增 cookie handler |
| `options/options.html` | 修改 | 菜单中新增"设置"项；新增 settings dialog 模板 |
| `options/options.js` | 修改 | 新增 Settings 类（cookie 展示/解析/保存/清除 + 浏览器特征 + 模式开关）；绑定菜单事件 |
| `options/options.css` | 修改 | 新增 settings-panel / cookie / browser-features / 开关样式 |
| `content/inject.js` | **修改** | 新增 `collectBrowserFeatures()` + `DY_CAPTURE_BROWSER_FEATURES` 事件发送 |
| `content/content.js` | **修改** | 新增 `DY_CAPTURE_BROWSER_FEATURES` 事件监听 + 转发到 background |

---

## background 消息路由分叉

`background/background.js` 中现有 handler 全部不动。新增一个 `independentHandlers` 分支，通过 `isIndependentMode()` 判断是否切换到独立模式：

```
chrome.runtime.onMessage
  ├─ GET_SECURITY_STATUS
  │   └── 始终走现有的 sendToTab（需要检查 Hook 注入状态和页面请求缓存）
  │
  ├─ FETCH_FOLLOWING / FETCH_FAVORITES / FETCH_COLLECTION
  │   └── independentMode ? 独立 handler : sendToTab
  │
  ├─ CANCEL_LIKE / CANCEL_COLLECTION
  │   └── independentMode ? 独立 handler（需要 `browserFeatures.securityKey`）: sendToTab
  │
  ├─ FETCH_WORKS_PAGE
  │   └── independentMode ? 独立 handler（/aweme/v1/web/aweme/post/）: sendToTab
  │
  ├─ SYNC_WORKS
  │   └── independentMode ? 独立 handler : sendToTab
  │
  └─ 其他（SAVE_WORKS / 分组管理等）
      └── 不变
```

### 独立模式不支持的操作（始终需要标签页）

- `GET_SECURITY_STATUS` — 需要检查 Hook 注入状态和页面请求缓存

---

## 独立模式各处理器详解

### 通用 fetch 辅助

```js
async function independentRequest(apiPath, params, options = {}) {
  const { savedCookie } = await chrome.storage.local.get('savedCookie');
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
        "User-Agent": abOgus ? abOgus.userAgent : getBrowserFeatures().userAgent,
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
```

关键变更：
- `credentials: "include"` 而非 `"omit"`，浏览器自动携带 douyin.com 域 cookie
  - 请求头仅保留 `Accept`、`User-Agent`，移除 `Cookie`、`Origin`、`Referer`、`Accept-Language`、`sec-ch-ua*` 等（因为 `Cookie` 和 `Referer` 在 Chrome Service Worker 的 `fetch()` 中属于 forbidden request-header，JS 无法设置；改用 `referrer` fetch 选项 + DNR rules 3/5/6 在底层网络层设置 `Referer` 头；rule 3 配泛用 Referer，rules 5/6 配取消端点的精确 Referer）
  - 不发送 `X-Bogus` 头——参考项目表明抖音端点无需 `X-Bogus`，仅 `a_bogus` 即可
- `params.msToken = await getMsToken()` 统一通过 `getMsToken()` 获取，不再从 cookie 解析

### 统一参数构建（`buildBaseParams`）

独立模式不再使用固定的 `DEVICE_PARAMS` 对象，而是通过 `buildBaseParams()` 动态构建包含 30+ 参数的对象：

```js
async function buildBaseParams(extra = {}) {
  const bf = (await chrome.storage.local.get("browserFeatures")).browserFeatures || getBrowserFeatures();
  const verifyFp = getVerifyFp();
  const [webid, { savedCookie }] = await Promise.all([getWebId(), chrome.storage.local.get("savedCookie")]);
  let uifid = "";
  if (savedCookie) {
    const m = savedCookie.match(/\bUIFID=([^;]+)/);
    if (m) uifid = m[1];
  }
  return {
    device_platform: "webapp", aid: "6383", channel: "channel_pc_web",
    pc_client_type: "1", version_code: "290100", version_name: "29.1.0",
    cookie_enabled: "true", platform: "PC",
    publish_video_strategy_type: "2",
    cpu_core_num: String(bf.cpuCoreNum || 8),
    screen_width: String(bf.screenWidth || 1536),
    screen_height: String(bf.screenHeight || 864),
    browser_language: bf.browserLanguage || "zh-CN",
    // ... 更多浏览器指纹参数 ...
    webid, uifid,
    verifyFp, fp: verifyFp,
    ...extra,
  };
}
```

各 handler 调用时传入端点特有参数：
```js
const data = await independentRequest("/aweme/v1/web/aweme/favorite/",
  await buildBaseParams({ sec_user_id: "self", count: String(CONFIG.PAGE.FAVORITE), max_cursor: String(cursor) }),
);
```

### FETCH_FOLLOWING（关注列表扫描）

- 端點：`/aweme/v1/web/user/following/list`
- 方法：GET
- 分页参数：`offset`, `count`
- 循环逻辑迁移自现有 `handleFetchFollowing`（background.js:432）
- 返回：`{ ok, requestId, followings, total }`

### FETCH_FAVORITES（点赞扫描）

- 端點：`/aweme/v1/web/aweme/favorite/`
- 方法：GET
- 分页参数：`max_cursor`, `count`
- 额外参数：`sec_user_id`
- 循环逻辑迁移自现有 `handleFetchFavorites`（background.js:481）
- 数据提取：`data.aweme_list` → `transformAwemeItem`（提取逻辑由 background 内联实现，不依赖 inject.js）
- 返回：`{ ok, requestId, works, total }`

### FETCH_COLLECTION（收藏扫描）

- 端點：`/aweme/v1/web/aweme/listcollection/`
- 方法：POST
- 分页参数：`cursor`, `count`
- 数据提取同 FETCH_FAVORITES

### CANCEL_LIKE / CANCEL_COLLECTION（取消点赞 / 取消收藏）

- 端点：
  - 取消点赞：`POST /aweme/v1/web/commit/item/digg/?aid=6383`，body: `aweme_id={id}&item_type=0&type=0`，content-type: `application/x-www-form-urlencoded; charset=UTF-8`
  - 取消收藏：`POST /aweme/v1/web/aweme/collect/?aid=6383`，body: `action=0&aweme_id={id}&aweme_type=0`，content-type: `application/x-www-form-urlencoded`
- 使用 `handleIndependentCancel()`（`background.js:1282`），循环逐条发 POST
- 需要 `browserFeatures.securityKey`（即 `bd-ticket-guard-ree-public-key`，从 douyin.com 页面的 `localStorage` 中自动捕获）
- 请求不使用 `a_bogus` 签名（端点本身不需要），依赖 `credentials: "include"` 携带 cookie
- DNR rule 5（收藏）/ rule 6（点赞）在底层网络层注入正确的 `Referer`（带 `showTab` 参数），由 `referrer` fetch 选项兜底
- 取消点赞端点（`/commit/item/digg/`）的 guard 机制可能更严格，独立模式下可能仍需要兜回到 tab 模式

### SYNC_WORKS（作品同步）

- 端點：`/aweme/v1/web/aweme/detail/`
- 参数：`aweme_id`
- 逐条 fetch + 延迟
- 循环逻辑迁移自现有 `handleSyncWorks`（background.js:843）
- 批量暂停、keepalive 等保留

### FETCH_WORKS_PAGE（侧边栏作者作品分页）

- 端点：`/aweme/v1/web/aweme/post/`
- 参数：`sec_user_id`、`max_cursor`、`count`（`CONFIG.PAGE.AUTHOR`）
- 使用 `handleIndependentFetchWorksPage()`，调用 `independentRequest()`
- 与 tab 模式的区别：无需等待 inject.js 的签名捕获（`__capturedPostQuery`），直接由 background 的 ABogus/XBogus 签名
  - DNR rule 3 的关键作用：`/aweme/v1/web/aweme/post/` 要求 `Referer` 头，若缺失则返回 `{"status_code":0,"aweme_list":[]}`；DNR 在底层网络层注入 `Referer: https://www.douyin.com/`，绕过 Chrome SW 的 forbidden header 限制
- DNR rules 5/6 为取消端点分别设精确的 Referer（带 `?showTab=like` 或 `?showTab=favorite_collection`），rule 3 的泛用 Referer 不适用于取消端点
- `referrer` fetch 选项充当 fallback，虽在 Chrome SW 中无效，但保留以兼容 Node.js 测试环境

### 设备参数

独立模式使用与 inject.js 一致的 `DEVICE_PARAMS`。其中浏览器相关字段（`screen_width`、`browser_language` 等）优先从 `browserFeatures` 存储读取，不存在时使用默认值：

```js
const DEVICE_PARAMS = {
  device_platform: 'webapp',
  aid: '6383',
  channel: 'channel_pc_web',
  pc_client_type: '1',
  version_code: '290100',
  version_name: '29.1.0',
  cookie_enabled: 'true',
  platform: 'PC',
  publish_video_strategy_type: '2',
  // 以下字段从 browserFeatures 动态填充
  screen_width: String(browserFeatures?.screenWidth || 1536),
  screen_height: String(browserFeatures?.screenHeight || 864),
  browser_language: browserFeatures?.browserLanguage || 'zh-CN',
  cpu_core_num: String(browserFeatures?.cpuCoreNum || 16),
  device_memory: String(browserFeatures?.deviceMemory || 4),
};
```

---

## crypto.js 模块设计

`background/crypto.js` 是一个 ES Module，纯 JS 实现所有签名算法。不依赖任何外部库。

### expose 的 API

```js
export class ABogus {
  constructor(userAgent, platform?)   // UA 编码初始化
  getValue(urlParams, method='GET')   // → a_bogus 字符串
}

export class XBogus {
  getXBogus(query, params, userAgent, timestamp?)  // → X-Bogus 字符串
}

export function getVerifyFp(timestamp?)  // → verify_xxx 字符串

export async function refreshMsToken(cookie?)  // → msToken 字符串

export async function refreshTtWid(cookie?)     // → ttwid 字符串
```

### 内部算法

| 符号 | 算法 | 行数 | 输入 | 输出 |
|---|---|---|---|---|
| `sm3Hash` | SM3 国密哈希 | ~120 | string / Uint8Array | Uint8Array(32) |
| `rc4Encrypt` | RC4 流加密 | ~25 | (plaintext, key) | string |
| `customB64Encode` | 自定义 Base64（s3/s4 表） | ~30 | (data, tableName) | string |
| `charCodeAt` | 字符串→字符码数组 | ~5 | string | int[] |
| `urlEncode` | URL 参数按字典排序 + encode | ~15 | dict | string |

### SM3 哈希

SM3 算法的 JavaScript 实现，参考 GMSLL 标准：

- 消息填充：补 1 位 + 若干 0 位 + 64 位长度
- 8 个 32 位工作变量（IV：`0x7380166F` 等）
- 64 轮压缩函数
- 布尔函数：`FF_j(X,Y,Z)`、`GG_j(X,Y,Z)`
- 置换函数：`P_0(X)`、`P_1(X)`

### ABogus.getParamsCode / getUaCode

两次 SM3 + 两次自定义 Base64：

```js
1. getUaCode(ua)
   → rc4Encrypt(ua, '\x00\x01\x0e')
   → customB64Encode(result, 's3')
   → sm3Hash(result)
   → int[32]

2. getParamsCode(params)
   → sm3Hash(sm3Hash(params + 'cus'))
   → int[32]

3. getMethodCode(method)
   → sm3Hash(sm3Hash(method + 'cus'))
   → int[32]

4. getValue(params, method)
   → 随机 string_1 (12 chars)
   → string_2 = buildString2(...) → rc4Encrypt(array, 'y')
   → customB64Encode(string_1 + string_2, 's4')
```

### msToken

`getMsToken()` 从 3 个来源依次获取：

1. **缓存**：`chrome.storage.local` 中缓存的 `savedMsToken`（1 小时 TTL）
2. **浏览器 Cookie jar**：`chrome.cookies.getAll({ domain: 'douyin.com', name: 'msToken' })` —— 访问抖音时浏览器已自动存储
3. **savedCookie 解析**：解析用户在设置面板粘贴的 `savedCookie` 字符串中的 `msToken=...` 段
4. **回退**：生成 156 位随机字符的假 msToken（服务端可能拒绝，但兜底可用）

```js
async function fetchMsToken() {
  // 1) 浏览器 cookie jar
  const cookies = await chrome.cookies.getAll({ domain: "douyin.com", name: "msToken" });
  if (cookies.length > 0 && cookies[0].value) return cookies[0].value;
  // 2) savedCookie 字符串
  const { savedCookie } = await chrome.storage.local.get("savedCookie");
  const msToken = extractMsTokenFromCookie(savedCookie);
  if (msToken) return msToken;
  return "";
}

async function getMsToken() {
  // 1h 缓存
  const { savedMsToken, savedMsTokenTime } = await chrome.storage.local.get([...]);
  if (savedMsToken && savedMsTokenTime && Date.now() - savedMsTokenTime < MSTOKEN_TTL) {
    return savedMsToken;
  }
  const msToken = (await fetchMsToken()) || generateRandomMsToken();
  await chrome.storage.local.set({ savedMsToken: msToken, savedMsTokenTime: Date.now() });
  return msToken;
}
```

不再使用 mssdk API 路径，避免了额外的 API 调用。

### ttwid 刷新

```js
async function refreshTtWid() {
  const resp = await fetch('https://ttwid.bytedance.com/ttwid/union/register/', {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      region: 'cn',
      aid: 1768,
      needFid: false,
      service: 'www.ixigua.com',
      migrate_info: { ticket: '', source: 'node' },
      cbUrlProtocol: 'https',
      union: true,
    }),
  });
  // 从 Set-Cookie 头解析 ttwid
}
```

### VerifyFp 生成

```js
function getVerifyFp(timestamp) {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const t = (timestamp || Date.now()).toString(36);
  const arr = Array(36).fill('');
  arr[8] = arr[13] = arr[18] = arr[23] = '_';
  arr[14] = '4';
  for (let i = 0; i < 36; i++) {
    if (!arr[i]) {
      const n = Math.random() * chars.length | 0;
      arr[i] = i === 19 ? chars[(3 & n | 8)] : chars[n];
    }
  }
  return `verify_${t}_${arr.join('')}`;
}
```

---

## Cookie 管理（独立模式的凭据来源）

独立模式使用 `credentials: 'include'` 并显式设置 `Cookie` header 发送 `savedCookie`。注：Service Worker 的 fetch() 中 `Cookie` 属于禁止修改的请求头，Chrome 实际仅使用 `credentials: 'include'` 发送浏览器 cookie jar 中的 douyin.com cookies，显式设置的 `Cookie` header 可能被静默忽略。因此独立模式的 cookie 可用性取决于浏览器是否存储了 douyin.com 的 cookies。

### 与依赖标签页模式的 Cookie 差异

| | 依赖标签页模式 | 独立模式 |
|---|---|---|
| Cookie 来源 | 浏览器自动携带（inject.js 同源请求） | `chrome.storage.local` 中用户手动设置的 `savedCookie` |
| 请求方式 | `credentials: 'include'` | `credentials: 'include'` + 显式 `Cookie` header |
| 用户是否可见 | 不可见，由浏览器管理 | 可在配置面板中查看和编辑 |
| 依赖外部 | 需打开抖音标签页（浏览器自动带 Cookie） | 需用户手动粘贴 Cookie |

### 消息协议（background 新增）

| 消息类型 | 方向 | 行为 |
|---|---|---|
| `GET_COOKIE_INFO` | options → bg | 返回当前存储的 cookie 的摘要信息 |
| `SET_COOKIE` | options → bg | 保存用户粘贴的 cookie 到 `savedCookie` |
| `CLEAR_COOKIE` | options → bg | 清除 `savedCookie`，独立模式恢复 `NO_COOKIE` 状态 |

### cookie 辅助函数

```js
// 解析 cookie 为键值对数组，供展示用
function parseCookieToPairs(cookieStr) {
  return cookieStr.split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const idx = s.indexOf('=');
      return idx > 0 ? { key: s.slice(0, idx), value: s.slice(idx + 1) } : null;
    })
    .filter(Boolean);
}
```

### 存储

`chrome.storage.local` 中新增键：

```js
savedCookie: string  // 用户手动粘贴的原始 cookie 字符串
```

### 配置面板 UI

#### 入口

菜单 `.menu-dropdown` 中新增"设置"项（在"安全状态"与"重置"之间）：

```
[菜单]
  ├── 同步
  ├── 导入
  ├── 导出
  ├── 分组
  ├── 扫描点赞
  ├── 扫描收藏
  ├── ─────────
  ├── 安全状态
  ├── 设置          ← 新增
  ├── ─────────
  ├── 重置
  └── — MB
```

点击"设置" → 弹出 Dialog，body 内容：

```html
<div class="settings-panel">
  <!-- Cookie 配置 -->
  <section class="settings-section">
    <h3 class="settings-section-title">Cookie 配置</h3>

    <div class="cookie-status" id="cookieStatus">
      <span class="cookie-status-icon" id="cookieStatusIcon">○</span>
      <span id="cookieStatusText">未设置 Cookie</span>
    </div>

    <div class="cookie-detail hidden" id="cookieDetail">
      <div class="cookie-item">
        <span class="cookie-key">sessionid</span>
        <code class="cookie-val" id="cookieValSessionid"></code>
      </div>
      <div class="cookie-item">
        <span class="cookie-key">msToken</span>
        <code class="cookie-val" id="cookieValMsToken"></code>
      </div>
      <div class="cookie-item">
        <span class="cookie-key">ttwid</span>
        <code class="cookie-val" id="cookieValTtwid"></code>
      </div>
      <div class="cookie-item">
        <span class="cookie-key">全部键数</span>
        <code class="cookie-val" id="cookieValCount"></code>
      </div>
    </div>

    <textarea id="cookieInput" class="cookie-input" rows="4"
      placeholder="粘贴 Cookie 字符串...&#10;例如: sessionid=abc...; msToken=xyz..."></textarea>

    <div class="cookie-actions">
      <button class="dy-btn dy-btn-primary" id="btnUpdateCookie">更新 Cookie</button>
      <button class="dy-btn dy-btn-ghost dy-btn-danger" id="btnClearCookie">清除</button>
    </div>
  </section>

  <!-- 独立模式开关 -->
  <section class="settings-section">
    <h3 class="settings-section-title">独立模式</h3>
    <label class="settings-switch-row">
      <span>启用独立模式（无需抖音标签页）</span>
      <input type="checkbox" id="settingsIndependentMode" />
      <span class="switch-knob"></span>
    </label>
    <p class="settings-hint">开启后，同步/扫描等操作在后台直接执行，无需打开抖音页面</p>
  </section>

  <!-- 预留 -->
  <section class="settings-section">
    <h3 class="settings-section-title">其他设置（待添加）</h3>
    <p class="settings-hint">后续版本将在此添加更多配置项</p>
  </section>
</div>
```

#### Cookie 展示规则

对已存储的 cookie，解析为键值对后展示：

- 值超过 16 位：只显示末尾 8 位，前缀 `***`（如 `sessionid: ***a1b2c3d4`）
- 关键键缺失：在状态行用黄色警告标识
- 内容为空时显示 `（空）`

| 状态 | 显示 |
|---|---|
| 已存储且包含 `sessionid` | ✅ Cookie 已配置（sessionid: ***末尾8位） |
| 已存储但缺少 `sessionid` | ⚠️ Cookie 缺少 sessionid，可能无法通过认证 |
| 未存储 | ○ 未设置 Cookie |

#### Cookie 校验

用户点击"更新 Cookie"时：

1. 去除首尾空白
2. 检查是否包含 `=` 分割的键值对
3. 至少有 1 个有效键值对 → 保存到 `chrome.storage.local`
4. 无有效键值对 → 显示错误提示 "Cookie 格式无效，请检查后重试"

### options.js 新增逻辑

```js
// 菜单事件
dom.btnSettings.addEventListener('click', () => settings.openPanel());

// Settings 类（或函数集）
const settings = {
  async openPanel() { /* 构造 dialog 内容、加载 cookie 摘要、绑定事件 */ },
  async refreshCookieStatus() { /* 从 background 获取 cookie 摘要并刷新 UI */ },
  async updateCookie() { /* 校验并保存粘贴的 cookie */ },
  async clearCookie() { /* 清除存储的 cookie */ },
};
```

### background.js 新增 handler

```js
case 'GET_COOKIE_INFO': {
  const { savedCookie } = await chrome.storage.local.get('savedCookie');
  if (!savedCookie) return sendResponse({ ok: true, pairs: [], hasSessionid: false });
  const pairs = parseCookieToPairs(savedCookie);
  const hasSessionid = pairs.some(p => p.key === 'sessionid');
  sendResponse({ ok: true, pairs, hasSessionid, count: pairs.length });
  break;
}
case 'SET_COOKIE': {
  await chrome.storage.local.set({ savedCookie: message.cookie });
  sendResponse({ ok: true });
  break;
}
case 'CLEAR_COOKIE': {
  await chrome.storage.local.remove('savedCookie');
  sendResponse({ ok: true });
  break;
}
```

---

## 浏览器特征管理（独立模式的 ABogus 输入）

ABogus 的 `getValue()` 需要两个输入参数：`User-Agent` 和 `platform`（如 `"Win32"`）。同时 `DEVICE_PARAMS` 也需要屏幕分辨率、CPU 核心数、设备内存等参数。独立模式中无真实浏览器环境，因此需要从 tab 模式捕获或用户手动设置。

### 流程序列

```
tab 模式：
  inject.js 采集 navigator / screen 等特征
  → dispatch CustomEvent → content.js 转发
  → background.js 存入 chrome.storage.local

独立模式：
  background.js 从 storage 读取 browserFeatures
  → 传给 ABogus constructor（userAgent, platform）
  → 其余字段注入 DEVICE_PARAMS
```

### 存储结构

```js
chrome.storage.local: {
  savedCookie: string,
  browserFeatures: {
    userAgent: "Mozilla/5.0 ...",
    platform: "Win32",
    browserLanguage: "zh-CN",
    browserName: "Chrome",
    browserVersion: "139.0.0.0",
    engineName: "Blink",
    engineVersion: "139.0.0.0",
    osName: "Windows",
    osVersion: "10",
    screenWidth: 1536,
    screenHeight: 864,
    cpuCoreNum: 16,
    deviceMemory: 8,
  },
  independentMode: bool,
}
```

### 消息协议（新增/修改）

| 消息类型 | 方向 | 行为 |
|---|---|---|
| `CAPTURE_BROWSER_FEATURES` | inject → content → bg | 保存从真实页面采集的浏览器特征 |
| `GET_BROWSER_FEATURES` | options → bg | 返回存储的浏览器特征 |

### inject.js 采集

```js
function collectBrowserFeatures() {
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    browserLanguage: navigator.language,
    browserName: navigator.userAgent.includes('Edg') ? 'Edge'
                 : navigator.userAgent.includes('Chrome') ? 'Chrome'
                 : 'Unknown',
    browserVersion: navigator.userAgent.match(/Chrome\/(\d+)/)?.[1] || '139',
    engineName: 'Blink',
    engineVersion: navigator.userAgent.match(/Chrome\/(\d+)/)?.[1] || '139',
    osName: navigator.platform.includes('Win') ? 'Windows'
           : navigator.platform.includes('Mac') ? 'Mac OS'
           : 'Unknown',
    osVersion: '10',
    screenWidth: screen.width,
    screenHeight: screen.height,
    cpuCoreNum: navigator.hardwareConcurrency || 4,
    deviceMemory: navigator.deviceMemory || 4,
  };
}
```

触发时机：`DOMContentLoaded` 时采集一次，通过 `CustomEvent`（事件名 `DY_CAPTURE_BROWSER_FEATURES`）发送到 content.js。后续不再重复采集。

### content.js 转发

与现有 `DY_CAPTURE_WORKS` 事件相同的 `requestResponse` 模式，转发到 background。

### background.js 存储

```js
case 'CAPTURE_BROWSER_FEATURES':
  await chrome.storage.local.set({ browserFeatures: message.features });
  sendResponse({ ok: true });
  break;
```

### 配置面板 UI（设置 Dialog 中新增区域）

在 "Cookie 配置" 与 "独立模式开关" 之间插入：

```html
<section class="settings-section">
  <h3 class="settings-section-title">浏览器特征</h3>
  <p class="settings-hint">
    用于独立模式下生成签名。打开抖音页面时可自动捕获，
    也可手动输入。
  </p>
  <div class="bf-grid" id="bfGrid"></div>
  <div class="bf-actions">
    <button class="dy-btn dy-btn-primary" id="btnUpdateBF">更新</button>
    <button class="dy-btn dy-btn-ghost" id="btnResetBF">重置为默认值</button>
  </div>
</section>
```

每个特征项 JS 动态渲染为：

```html
<div class="bf-item">
  <label class="bf-label">User-Agent</label>
  <input class="bf-input" id="bf-userAgent" type="text" />
</div>
```

### ABogus 构造适配（background.js）

```js
async function initABogus() {
  const { browserFeatures } = await chrome.storage.local.get('browserFeatures');
  const ua = browserFeatures?.userAgent || 'Mozilla/5.0 ...';
  const platform = browserFeatures?.platform || 'Win32';
  abOgus = new ABogus(ua, platform);
  // DEVICE_PARAMS 补充
  DEVICE_PARAMS.browser_language = browserFeatures?.browserLanguage || 'zh-CN';
  DEVICE_PARAMS.screen_width = String(browserFeatures?.screenWidth || 1536);
  DEVICE_PARAMS.screen_height = String(browserFeatures?.screenHeight || 864);
  DEVICE_PARAMS.cpu_core_num = String(browserFeatures?.cpuCoreNum || 16);
  DEVICE_PARAMS.device_memory = String(browserFeatures?.deviceMemory || 8);
}
```

每次切换到独立模式时调用 `initABogus()`。

### 默认 fallback 值

当 `browserFeatures` 完全为空（从未捕获、用户也未填写）时，使用一组保守的默认值：

```js
const DEFAULT_BROWSER_FEATURES = {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
           + '(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  platform: 'Win32',
  browserLanguage: 'zh-CN',
  browserName: 'Chrome',
  browserVersion: '139',
  engineName: 'Blink',
  engineVersion: '139',
  osName: 'Windows',
  osVersion: '10',
  screenWidth: 1536,
  screenHeight: 864,
  cpuCoreNum: 16,
  deviceMemory: 8,
};
```

---

## 模式切换时的注意事项

| 场景 | 行为 |
|---|---|---|
| 从"依赖"切换到"独立" | 发送 `CANCEL_ACTIVE_TASK` 中止 inject 中可能运行的循环；background 下次收到消息时走独立模式处理器 |
| 从"独立"切换到"依赖" | 下次操作走 `sendToTab` 路径；若无抖音标签页，弹出 `showNoSignatureDialog` 引导用户 |
| 独立模式下 `savedCookie` 为空 | `independentRequest` 立即抛 `NO_COOKIE` → options 显示提示"请先在设置中配置 Cookie" |
| 独立模式下 Cookie 过期 | 收到 401/403 → 返回 `AUTH_FAILED` → options 显示错误提示"请更新 Cookie" |
| 独立模式下 msToken 刷新失败 | fallback 到 156 位随机字符假 token |
| 独立模式下（非首次）msToken 有缓存 | 在内存中缓存上次获取的 msToken，减少重复 API 调用 |
| 独立模式下 `FETCH_FOLLOWING` 等分页循环 | 循环逻辑与现有 `handleFetchFollowing` 一致（分页 + 延迟 + 进度上报 + cancel 支持） |
| 同时触发取消信号 | 独立模式下通过 `AbortController` 链式传递；`CANCEL_ACTIVE_TASK` 由 background 内部消化（无需转发到 tab） |

---

## 不依赖标签页的优点

1. **扩展加载后立即可用**— 无需预先浏览抖音页面
2. **无竞争条件**— 不存在自污染（当前 `_dyInternal` 解决的问题在独立模式中不存在）
3. **资源消耗低** — 不注入、不 Hook、不观察 DOM
4. **时序稳定** — `sendToTab` 的 30s 超时不再成为瓶颈
5. **后台运行** — Service Worker 可独立完成任务，不依赖页面存活

---

## 不依赖标签页的限制

1. **Cookie 必须手动设置** — 独立模式依赖 `chrome.storage.local` 中的 `savedCookie` 作为门禁检查，用户需在设置面板中粘贴有效的抖音 Cookie（`credentials: "include"` 仍使用浏览器 cookie jar 中的 cookie 进行实际请求）
2. **取消收藏/取消点赞** — 独立模式下 `handleIndependentCancel()` 可直接在 background 内循环 POST，需 `browserFeatures.securityKey`（首次需访问 douyin.com 页面以捕获）。取消收藏已验证 ✅，取消点赞类似但 guard 机制可能更严格
3. **安全状态面板仍依赖标签页** — 因为需要检查 Hook 注入状态
4. **浏览器特征需预先捕获或手动填写** — 独立模式需要浏览器特征参数（UA、分辨率等），需通过标签页自动捕获或手动设置。不过有合理的默认值可兜底

---

## 实施顺序

```
1. background/crypto.js (SM3 → RC4 → Base64 → ABogus → VerifyFp → msToken → ttwid → cookie 解析)
   ↓
2. content/inject.js + content/content.js (浏览器特征采集 + 事件转发)
   ↓
3. background/background.js (independentHandlers + 消息路由分叉 + cookie/browserFeatures handler)
   ↓
4. options/options.js (Settings 类 + cookie 展示/解析/保存/清除 + 浏览器特征编辑 + 模式开关)
   ↓
5. options/options.html (菜单"设置"项 + settings dialog 模板)
   ↓
6. options/options.css (settings-panel / cookie / browser-features / 开关样式)
   ↓
7. node --check 语法验证全量文件
```
