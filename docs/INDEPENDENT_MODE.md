# 双模式架构：依赖标签页 / 独立运行

## 背景

默认链路 `options → background → sendToTab → content.js → inject.js → API fetch` 有两个固有依赖：必须有打开的抖音标签页（`withDouyinTab()`）、必须先浏览产生对应 API 请求的页面才能捕获签名。

**独立模式**让 background service worker 直接生成签名并调用 API，不依赖任何抖音标签页。

---

## 两种模式对比

|            | 依赖标签页模式                      | 独立模式                                      |
|------------|-------------------------------------|-----------------------------------------------|
| API 执行者 | inject.js（主世界）                 | background.js（Service Worker）               |
| 签名来源   | Fetch Hook 从页面请求捕获           | crypto.js 本地算法生成                        |
| 抖音标签页 | **必需**                            | **不必要**                                    |
| Cookie     | 浏览器自动携带（同源请求）          | 浏览器 cookie jar（`credentials: "include"`） |
| 消息链路   | `options → bg → sendToTab → inject` | `options → bg → direct fetch`                 |
| a_bogus    | 从 URL 捕获                         | 本地生成（SM3 + RC4）                         |
| 浏览器特征 | 从真实浏览器环境获取                | 从 `chrome.storage.local` 读取                |

**两模式隔离**，不共享算法代码、不共用缓存变量。

### 关键约束

options.js 发出的消息类型和参数格式与模式无关。background.js 消息路由检查 `independentMode` 标志后分发到对应处理器，两者产出相同响应形状。

### 时序参数

两模式共用 `background.js` 中的 `CONFIG.DELAY`、`CONFIG.SYNC`、`CONFIG.TIMEOUT`。

---

## background 消息路由

```
chrome.runtime.onMessage
  ├─ GET_SECURITY_STATUS → 始终走 sendToTab（需检查 Hook 注入）
  ├─ FETCH_FOLLOWING / FETCH_FAVORITES / FETCH_COLLECTION
  ├─ CANCEL_LIKE / CANCEL_COLLECTION → 独立模式需 browserFeatures.securityKey
  ├─ FETCH_WORKS_PAGE
  ├─ SYNC_WORKS
  │   └── 以上均：independentMode ? 独立 handler : sendToTab
  └─ 其他（SAVE_WORDS / 分组管理等）→ 不变
```

独立模式不支持 `GET_SECURITY_STATUS`（始终需要标签页）。

---

## 各处理器端点

| 操作             | 端点                                  | 方法 | 分页参数                                 |
|------------------|---------------------------------------|------|------------------------------------------|
| FETCH_FOLLOWING  | `/aweme/v1/web/user/following/list`   | GET  | `offset`, `count`                        |
| FETCH_FAVORITES  | `/aweme/v1/web/aweme/favorite/`       | GET  | `max_cursor`, `count`                    |
| FETCH_COLLECTION | `/aweme/v1/web/aweme/listcollection/` | POST | `cursor`, `count`                        |
| 取消点赞         | `/aweme/v1/web/commit/item/digg/`     | POST | body: `aweme_id, item_type=0, type=0`    |
| 取消收藏         | `/aweme/v1/web/aweme/collect/`        | POST | body: `action=0, aweme_id, aweme_type=0` |
| SYNC_WORKS       | `/aweme/v1/web/aweme/detail/`         | GET  | `aweme_id`                               |
| FETCH_WORKS_PAGE | `/aweme/v1/web/aweme/post/`           | GET  | `sec_user_id, max_cursor, count`         |

DNR rule 3 为独立模式所有 API 请求注入泛用 `Referer: https://www.douyin.com/`；rules 5/6 为取消端点注入精确 Referer（带 `?showTab=like` / `?showTab=favorite_collection`）。

### Argus webSign 签名（listcollection）

`listcollection` POST 被服务端 ArgusSecurityPlugin 额外校验：缺签名时返回 403 `Blocked by ArgusSecurityPlugin Signature Not Found`。页面端由 secsdk 的 `window.use("webSignUrl")` 在 XHR 上附加 `x-secsdk-web-signature`；独立模式在 `independentRequest` 内以 `options.webSign: true` 复刻同一算法：

```text
ts  = floor(now/1000)                       // 与 a_bogus 共用时钟偏移校正
qs' = qs + "&a_bogus=" + a_bogus + "&timestamp=" + ts
sig = md5( uifid + "_" + ts + "_" + SALT + "_" + qs' )
最终 query = qs' + "&x-secsdk-web-signature=" + sig
```

- 待签串为**最终完整 query 去掉 sig 自身**（含 `a_bogus` 与 `timestamp`，改任意参数即 `Sign Invalid`）；`uifid` 不参与待签串但服务端另行校验其归属（不匹配返回 `Validate Error`）
- 必带请求头：`uifid` / `x-secsdk-web-signature` / `x-secsdk-web-expire`（= ts）
- 盐 `SALT = A96D855A08C0A9707F8BEF0D9A527E4E`（`CONFIG.WEB_SIGN_SALT`，secsdk 动态策略常量，2026-08 实测跨会话稳定；**抖音换策略版本则盐变更，该端点将重现 Signature Not Found**，需重新逆向抓盐）
- 当前仅 `handleIndependentFetchCollection` 启用；若其他端点日后被拦，同款方案平移即可

> 完整链路（请求要素、线格式、定位手法、绑定域实验、盐变更复发处置）见 [COLLECTION_SCAN_REVERSE.md](./COLLECTION_SCAN_REVERSE.md)。

---

## msToken 缓存模型

`getMsToken()` 从以下来源依次获取：

1. 缓存：`chrome.storage.local` 中 `savedMsToken`（**无过期逻辑**，写入即终身）
2. 浏览器 Cookie jar：`chrome.cookies.getAll({ domain: 'douyin.com' })`
3. mssdk 兑换：POST 静态载荷（`background/mssdk_strdata.js`）到 `mssdk.bytedance.com/web/common`，从响应 Set-Cookie 经 cookie jar 读回新签发的真 msToken（参考 TikTokDownloader `src/encrypt/msToken.py`；2026-08 实测有效）
4. `savedCookie` 字符串中正则提取 `msToken=...`
5. 兜底：生成 156 位随机字符（服务端不认，严格端点如 listcollection POST 会 403；SW 控制台会告警）

> 抖音页面 SDK 现同样走 mssdk 兑换机制，签发的 cookie 落在 **bytedance.com** 域——douyin.com 的 cookie jar 里没有 msToken 属正常现象。

刷新：面板点击「刷新」→ background 删 `savedMsToken` → 重走 `getMsToken()`；jar 无 douyin.com msToken 时必然触发一次 mssdk 兑换，因此每次刷新都会拿到刚签发的新值。

---

## Cookie 管理

独立模式使用 `credentials: 'include'`，浏览器自动携带 douyin.com cookie jar。`savedCookie` 仅用于门禁检查及提取 UIFID、uid。

### Cookie 差异

|          | 依赖标签页模式           | 独立模式                                                           |
|----------|--------------------------|--------------------------------------------------------------------|
| 来源     | 浏览器自动携带（同源）   | `chrome.cookies.getAll` 采集                                       |
| 请求方式 | `credentials: 'include'` | `credentials: 'include'`（Cookie 头为 Chrome SW forbidden header） |
| 采集方式 | 自动                     | 面板「刷新」或自动采集，存为 `savedCookie` 字符串                  |

### 消息协议

| 消息类型          | 行为                                                                    |
|-------------------|-------------------------------------------------------------------------|
| `GET_COOKIE_INFO` | 返回 `{ pairs[], rawCookie, hasSessionid, count, time }`                |
| `REFRESH_COOKIE`  | 清空 `savedCookie`，重采 `chrome.cookies.getAll({domain:"douyin.com"})` |

### 存储

```js
chrome.storage.local: { savedCookie: string, savedCookieTime: number }
```

### 配置面板

设置面板 4 个 section：独立模式（开关 + secUid 输入 + 缓存列表）、Cookie 配置（键值对表格）、浏览器特征（只读表格）、Tab 模式（安全状态）。缓存列表 4 项各带状态和刷新按钮，`TYPE_MAP` 映射 `data-refresh` → 消息类型：`cookie` → `REFRESH_COOKIE`、`mstoken` → `REFRESH_MSTOKEN`、`webid` → `REFRESH_WEBID`、`browser_features` → `REFRESH_BROWSER_FEATURES`。

---

## 浏览器特征管理

`collectBrowserFeatures()` 在 inject.js 中采集 `navigator.*`、`screen.*`、`localStorage.securityKey`，通过 `CustomEvent("DY_CAPTURE_BROWSER_FEATURES")` 经 content.js 桥接转发到 background.js，存入 `chrome.storage.local.set({ browserFeatures, browserFeaturesTime })`。

触发时机：`DOMContentLoaded` 时自动采集一次；`DY_REQUEST_BROWSER_FEATURES` 事件可请求强制采集。

### 消息协议

| 消息类型                   | 行为                                                                                      |
|----------------------------|-------------------------------------------------------------------------------------------|
| `CAPTURE_BROWSER_FEATURES` | inject → content → bg，保存浏览器特征                                                     |
| `GET_BROWSER_FEATURES`     | 返回存储的浏览器特征                                                                      |
| `REFRESH_BROWSER_FEATURES` | 清空缓存，通过 `sendToTabAsync("REQUEST_CAPTURE_BROWSER_FEATURES")` 请求抖音 tab 重新采集 |

### ABogus 构造

`ensureABogus()` 从 `chrome.storage.local` 读取 `browserFeatures`，传入 ABogus constructor。各字段有 `|| 默认值` fallback（`userAgent` → `navigator.userAgent`、`screenWidth` → `1536`、`cpuCoreNum` → `8`、`deviceMemory` → `16` 等）。

### 存储结构

```js
chrome.storage.local: {
  browserFeatures: {
    userAgent, platform, browserLanguage, browserName, browserVersion,
    engineName, engineVersion, osName, osVersion,
    screenWidth, screenHeight, cpuCoreNum, deviceMemory,
    securityKey,  // 用于独立模式取消操作
  },
  browserFeaturesTime: number,
  independentMode: bool,
  secUid: string,
}
```

---

## 存储键表

所有缓存均无过期逻辑，需通过设置面板显式刷新。

| Key                                       | 类型            | 写入者                | 读取者                                     |
|-------------------------------------------|-----------------|-----------------------|--------------------------------------------|
| `savedMsToken` + `savedMsTokenTime`       | string + number | `getMsToken()`        | `getMsToken()`                             |
| `savedWebId` + `savedWebIdTime`           | string + number | `getWebId()`          | `getWebId()`                               |
| `savedCookie` + `savedCookieTime`         | string + number | 采集/刷新             | `independentRequest`, `buildBaseParams` 等 |
| `browserFeatures` + `browserFeaturesTime` | object + number | 自动采集/刷新         | `ensureABogus`, `buildBaseParams`          |
| `independentMode`                         | boolean         | 开关切换              | options.js                                 |
| `secUid`                                  | string          | 输入框 debounce 500ms | options.js                                 |

---

## 模式切换注意事项

| 场景               | 行为                                                    |
|--------------------|---------------------------------------------------------|
| 依赖→独立          | 发送 `CANCEL_ACTIVE_TASK` 中止 inject 中的循环          |
| 独立→依赖          | 下次走 `sendToTab`；无 tab 时弹 `showNoSignatureDialog` |
| `savedCookie` 为空 | `independentRequest` 抛 `NO_COOKIE`                     |
| Cookie 过期        | 401/403 → `AUTH_FAILED`                                 |
| msToken 刷新失败   | fallback 到随机假 token                                 |
| 取消信号           | 独立模式下由 `AbortController` 内部消化                 |

---

## 独立模式的优点

1. 扩展加载后立即可用，无需预先浏览抖音
2. 无竞争条件（不存在 `_dyInternal` 解决的自污染）
3. 资源消耗低（不注入、不 Hook、不观察 DOM）
4. 时序稳定（`sendToTab` 的 30s 超时不再成为瓶颈）
5. Service Worker 可独立完成任务，不依赖页面存活

## 独立模式的限制

1. Cookie 依赖浏览器 cookie jar（非手动粘贴）
2. 取消收藏/点赞需 `browserFeatures.securityKey`（需首次访问 douyin.com 捕获）
3. 安全状态面板仍依赖标签页（需检查 Hook 注入）
4. 浏览器特征需预先捕获或使用默认值兜底