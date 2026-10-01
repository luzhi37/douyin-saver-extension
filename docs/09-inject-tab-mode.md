# 09 · Inject.js — Tab模式技术方案

> 职责边界：主世界脚本 `content/inject.js` 与桥接层 `content/content.js` 的完整技术方案——注入机制、签名捕获与缓存、六类 API 请求的签名策略、CustomEvent 事件协议、数据提取、按钮注入、取消信号、安全状态与浏览器特征采集。独立模式对应实现见 02–07 各文档；消息路由总览见 [01](./01-project-architecture.md)。

## 概述

Tab模式的本质是**借页面环境发请求**：inject.js 运行在抖音页面的主世界（main world），能访问页面真实的 `window.fetch` / `XMLHttpRequest` / React Fiber / `localStorage`。由此获得三大能力，也带来一个核心矛盾：

- 能力一：抖音页面覆盖了 `window.fetch`（secsdk 包装器），对"未签名"URL 自动注入新鲜签名（a_bogus/msToken/verifyFp/fp/uifid/timestamp 等）；
- 能力二：页面自身的 API 流量持续产生**可捕获复用的签名参数**；
- 能力三：XHR 原型链被 a_bogus 签名深度绑定——取消点赞/收藏必须用 XHR 而非 fetch。
- 矛盾：扩展自己的请求走完 Hook 后会被 `captureFromUrl` 回写缓存，污染后续请求的签名（自污染）。

解决方案是 `_dyInternal` 标志（见下）。content.js（隔离世界）负责加载 inject.js 并把 chrome 消息翻译成 CustomEvent。

## 核心流程图（文字描述）

### 注入链与世界边界

```
manifest content_scripts（document_start, 匹配 *.douyin.com/*，排除 creator.douyin.com）
  → content.js（隔离世界）创建 <script src=chrome.runtime.getURL("content/inject.js")>
      → inject.js 在主世界执行：
          ├─ DOMContentLoaded（或立即）：dispatch DY_CAPTURE_BROWSER_FEATURES（采集一次特征）
          └─ startObserver()：注入样式 + 首轮按钮注入 + MutationObserver(100ms 无条件防抖——
             扫描移入定时器回调，#injectButtons 的 :not(:has(...)) 幂等；逐批做
             addedNodes×子树的相关性扫描是常驻主线程税，2026-09 定案移除)
content.js 同时常驻监听：
  DY_CAPTURE_WORKS            → capturedWorksMap LRU（上限 200，裁到 150）
  DY_CAPTURE_BROWSER_FEATURES → chrome.runtime.sendMessage(CAPTURE_BROWSER_FEATURES)
  chrome.runtime.onMessage    → BRIDGE 表翻译为 requestResponse 事件对
```

### 签名捕获体系

```
Fetch Hook（window.fetch 替换，origFetch 防递归）：
  入参 URL 命中 CONFIG.API_PATTERNS 且非 _dyInternal
    → captureFromUrl(url)：query 全参数存入对应端点的 Map 缓存（含 __dyCaptureTime 实例属性）。
      双重粗筛前置（2026-09 定案）：①字符串 indexOf("/aweme/v1/web/")——13 个 API_PATTERNS
      均以它开头，shouldCapture 与 captureFromUrl 都在 new URL / 建 Map 之前短路，99% 页面
      流量（埋点/风控/分片）零解析成本；②六端点 pathname.includes 命中判断先于参数 Map 构建
    → response.ok 时 response.clone().json() 分离 Promise 链提取作品数据 → dispatchWorks
  其他 http(s) 请求且非 _dyInternal → 仅 captureFromUrl（XHR 流量经 fetch polyfill 场景兜底）
  _dyInternal:true → 完全跳过捕获与提取（防自污染）

XHR Hook：包装 open 记录 _dyUrl，send 后 load 事件里 /aweme/ 预检 → captureFromUrl
  （仅签名捕获，不提取数据；取消操作走原生 XHR 自动带页面签名）

六个端点缓存一一对应、不可混用：
  __lastCapturedDetailQuery / __capturedProfileQuery / __capturedFollowingQuery /
  __capturedPostQuery / __capturedFavoriteQuery / __capturedCollectionQuery
```

### 六类 API 请求的签名策略

| 函数 | 端点 | 方法 | 签名来源 | 超时 |
|------|------|------|----------|------|
| `fetchOneDetail` | `/aweme/detail/` | GET | **包装器代签**：stripSdkKeys 剥签名键后裸发（跳过 aweme_id 键） | 8s |
| `fetchAuthorWorks` | `/aweme/post/` | GET | 同上（代签，合并 `__capturedPostQuery` 业务参数） | 15s |
| `fetchFollowingPage` | `/user/following/list` | GET | 同上（代签，合并 `__capturedFollowingQuery` 业务参数） | 15s |
| `fetchProfileOther` | `/user/profile/other/` | GET | 同上（代签；sigSource 五源 fallback：profile→following→post→favorite→collection，每环都经 stripSdkKeys） | 15s |
| `fetchOneFavoritesPage` | `/aweme/favorite/` | GET | 同上（代签） | 15s |
| `fetchOneCollectionPage` | `/aweme/listcollection/` | POST | 同上（代签），Content-Type urlencoded | 15s |
| `cancelOne(Like/Collection)` | digg / collect | POST XHR | 页面 XHR 原生签名（不可用 fetch 替代） | 30s（BRIDGE 层） |

两种策略的原理：

1. **包装器代签**（全部 fetch 类请求）：先 `stripSdkKeys` 剥离全部 SDK 注入键（`SDK_INJECT_KEYS = a_bogus/timestamp/x-secsdk-web-signature/msToken/verifyFp/fp/uifid`），再 `stripPageKeys` 剥分页键，保留非签名业务参数（webid/sec_user_id 等），构造"未签名" URL 直接走 `window.fetch` —— 外层 secsdk 包装器会按最终参数集自动注入匹配的新鲜签名。**预塞旧签名会导致包装器不再处理 → argus `web_id_sign_invalid` 403 / `Sign Invalid`**。（页面 `byted_acrawler` SDK 已无 `sign` 函数可调，2026 版仅剩 frontierSign/init。）
   - 历史说明：detail/post/following/profile 曾用"复用捕获签名"策略（stripPageKeys 后带签名合并），在 post 与 profile/other 被风控强制 Argus webSign 校验后，捕获 query 中带入的过期 `x-secsdk-web-signature` 被原样重放、包装器不再重签，导致 `Blocked by ArgusSecurityPlugin Sign Invalid`——已全部统一切换到代签策略。
2. **XHR 原生签名**（取消类）：a_bogus 与 XHR 原型链深度绑定，改用 fetch 即失败。

### 请求—响应全链路（以 FETCH_WORK_DETAIL 为例）

```
background sendToTab({type, requestId, …})
  → content.js BRIDGE.FETCH_WORK_DETAIL 命中
      requestResponse("DY_FETCH_WORK_DETAIL_REQUEST", "DY_FETCH_WORK_DETAIL_RESULT",
                      msg.timeout, msg => ({awemeId}))
        先 addEventListener(resultEvent) 再 dispatchEvent(requestEvent)   // 同步 handler 安全
        结果事件按 requestId 过滤；超时（BRIDGE timeout 字段）移除监听并回 {ok:false,error:"TIMEOUT"}
  → inject.js 对应 listener：
      setActiveTask(() => controller.abort())     // 注册单槽位可取消任务
      执行业务 fetch（_dyInternal:true + AbortController 关联外部 signal）
      dispatch RESULT { requestId, ok, work/items/error }
      finally setActiveTask(null)
  → content onResult → sendResponse → background
```

## 接口 / 方法签名

```js
// inject.js —— 签名缓存与合并
function captureFromUrl(url, parsedUrl?)          // 按 pathname 归位到对应 Map 缓存
function buildUrl(pathname, params) -> URL        // origin 相对路径 + 参数覆盖
function mergeParams(url, captured) -> URL        // 已有键不覆盖
function stripPageKeys(captured) -> Map|null      // 剥 offset/count/cursor*/max_*/min_*
function stripSdkKeys(captured) -> Map|null       // 剥 SDK_INJECT_KEYS 全部签名注入项
function resolveSelfSecUidFromCaptures() -> string// favorite/post/following/collection 缓存中找 sec_user_id

// inject.js —— 数据提取
function normalizeWork(raw, source: "api"|"fiber") -> Work|null
function transformAwemeItem(aw, { includeAuthorFollowed }) -> Work|null
function extractVideo(raw, source) -> { url, expireAt }   // 三级取链，fiber 分支特殊（见下）
function extractWorkFromRaw(awemeData, { fromFiber }) -> Work|null
async function extractWorksFromResponse(url, data, parsedUrl?) -> Work[]
function getAwemeInfoFromButton(btn) -> awemeInfo|null     // React Fiber 两级搜索

// inject.js —— 六个 API 请求函数（均 window.fetch + credentials:include + Referer + _dyInternal）
async function fetchOneDetail(awemeId, externalController?)
async function fetchFollowingPage(secUid, offset, count, externalSignal?)
async function fetchProfileOther(secUid, externalSignal?)
async function fetchOneFavoritesPage(secUid, cursor, count, signal?)
async function fetchOneCollectionPage(cursor, count, signal?)
async function fetchAuthorWorks(secUid, startCursor, count)
function cancelOne(awemeId, url, bodyFn, referrer, signal?) -> Promise   // XHR
function cancelOneLike / cancelOneCollection (awemeId, signal?)

// inject.js —— 任务槽与采集
function setActiveTask(abortFn|null)              // 单槽位：注册前 abort 旧任务
function collectBrowserFeatures() -> object       // navigator/screen/localStorage.securityKey 快照
function collectSecurityStatus() -> object        // 密钥 + 六路捕获缓存摘要（含 webSign 标记） + hook 标志位
function getSecurityKey() -> string               // localStorage["security-sdk/s_sdk_cert_key"].data 去 "pub." 前缀

// content.js
function requestResponse(requestEvent, resultEvent, timeoutMs, buildDetail) -> message handler
function fetchDetailByAwemeId(awemeId, timeoutMs=5000) -> Promise<videoUrl>   // 保存按钮的视频兜底
function saveWork(fullWork)                       // apiData LRU 合并 → SAVE_WORKS
```

### BRIDGE 消息 ↔ 事件对照表（content.js）

| chrome 消息 | REQUEST 事件 | RESULT 事件 | timeout |
|-------------|--------------|-------------|---------|
| FETCH_WORK_DETAIL | DY_FETCH_WORK_DETAIL_REQUEST | …_RESULT | msg.timeout |
| FETCH_FOLLOWING_PAGE | DY_FETCH_FOLLOWING_PAGE_REQUEST | …_RESULT | msg.timeout |
| FETCH_PROFILE_OTHER | DY_FETCH_PROFILE_OTHER_REQUEST | …_RESULT | msg.timeout |
| FETCH_WORKS_PAGE | DY_FETCH_WORKS_PAGE_REQUEST | …_RESULT | 固定 60000 |
| FETCH_FAVORITES_PAGE | DY_FETCH_FAVORITES_PAGE_REQUEST | …_RESULT | msg.timeout |
| FETCH_COLLECTION_PAGE | DY_FETCH_COLLECTION_PAGE_REQUEST | …_RESULT | msg.timeout |
| CANCEL_ONE_FAVORITES / CANCEL_ONE_COLLECTION | DY_CANCEL_ONE_*_REQUEST | …_RESULT | 固定 30000 |
| GET_SECURITY_STATUS | DY_GET_SECURITY_STATUS_REQUEST | …_RESULT | 固定 5000 |
| REQUEST_CAPTURE_BROWSER_FEATURES | DY_REQUEST_BROWSER_FEATURES | DY_CAPTURE_BROWSER_FEATURES_REFRESH | msg.timeout‖10000 |

`CANCEL_ACTIVE_TASK` 不走 BRIDGE：content 直接 dispatch `DY_CANCEL_ACTIVE_TASK` DOM 事件。

## 关键代码片段

### Fetch Hook 与 `_dyInternal` 保护

```js
window.fetch = function (...args) {
  const options = args[1] || {};
  const isInternal = options._dyInternal === true;
  const parsedUrl = !isInternal && url?.startsWith("http") ? shouldCapture(url) : null;
  return origFetch.apply(this, args).then((response) => {
    if (response.ok && parsedUrl) {
      captureFromUrl(url, parsedUrl);
      response.clone().json().then((data) => {
        extractWorksFromResponse(url, data, parsedUrl).then(dispatchWorks).catch(() => {});
      }).catch(() => {});                    // 分离 Promise 链，不阻塞响应交付
    } else if (response.ok && !isInternal && …) { captureFromUrl(url); }
    return response;
  });
};
window.__dyManagerFetchHooked = true;        // 安全状态面板读取的标志位
```

自污染根源：真实页面请求是签名的**生产者**（新鲜签名写缓存），扩展请求应是**消费者**（只读不写）。无 `_dyInternal` 时扩展请求的旧签名+特有 aweme_id 组合回写缓存，下次读取即签名错配 → 服务端拒绝（RATE_LIMITED）。

补充 rationale：六个 API 函数必须走 `window.fetch` 而非 `origFetch.call(window, …)`——抖音可能通过覆盖 `window.fetch` 注入签名参数，走 `origFetch` 绕过 Hook 的同时也绕过了页面包装器，会错过注入。`_dyInternal` 是"经 Hook 但不被 Hook 捕获"的正规通道。

### 取消点赞 XHR（签名绑定的唯一例外路径）

```js
const xhr = new XMLHttpRequest();
xhr.open("POST", CONFIG.CANCEL.favorites.url);           // /commit/item/digg/?aid=6383
xhr.withCredentials = true;
xhr.setRequestHeader("content-type", "application/x-www-form-urlencoded; charset=UTF-8");
xhr.setRequestHeader("Referer", "…/user/self?showTab=like");
if (key) xhr.setRequestHeader("bd-ticket-guard-ree-public-key", key);   // getSecurityKey()
xhr.onload = () => xhr.status < 300 ? resolve()
  : (xhr.status === 401 || xhr.status === 403) ? reject(new Error("AUTH_FAILED"))
  : reject(new Error("HTTP_" + xhr.status));
xhr.send(`aweme_id=${id}&item_type=0&type=0`);      // 收藏版 body: action=0&aweme_id=…&aweme_type=0
```

密钥每次 XHR 前重读 localStorage——批次中途密钥自动更新；key 为空则不带该头，服务器返回 401/403。

### 视频直链三级取链（extractVideo，api 源）

与 background `formatWork` **两处同款实现，必须同步修改**：

```
① 各档 bit_rate[].playApi 存在 → 长效 ID 型链接（同类内比分辨率），expireAt=0
② 无 playApi → 最高清档 play_addr.uri 合成 /aweme/v1/play/?video_id=…&aid=6383&is_play_url=1&line=0，expireAt=0
③ 皆缺 → CDN url_list 兜底：最高清档内比 expire 取最长，urlExpireAt 解析 expire 类参数
禁止改回"混池按最高分辨率挑选"。fiber 源分支有意不同：只认 playApi、无 url_list 回退、
仅留最高一档（gearName 含 智能/smart/adapt 的档位剔除）。
部分 douyinvod 短效直链的过期时间藏在路径段 /<sig>/<8位hex过期秒>，query 里查不到（已知盲区）。
```

### 按钮注入（React Fiber 提取）

```js
function getReactFiber(el) { /* 找 __reactFiber$ 前缀键 */ }
function searchAwemeInfoFromFiber(fiber) { /* 沿 return 向上搜 memoizedProps.awemeInfo */ }
function getAwemeInfoFromButton(btn) {
  const parentFiber = getReactFiber(btn.parentElement);        // 第一级：父元素 fiber 向上搜
  …
  const container = btn.closest(".basePlayerContainer");       // 第二级：播放器容器 fiber
}
// 注入去重：querySelectorAll(".basePlayerContainer xg-right-grid:not(:has(.dy-saver-btn))")
// MutationObserver 过滤相关新增节点后 100ms 防抖再注入
// 点击 → extractWorkFromRaw(fiber源) → dispatch DY_BUTTON_CLICK → content.saveWork()
```

### 浏览器特征采集（独立模式的指纹来源）

```js
function collectBrowserFeatures() {
  return { userAgent, platform, browserLanguage,
    browserName: UA.includes("Edg")?"Edge":UA.includes("Chrome")?"Chrome":"Unknown",
    browserVersion/engineVersion: UA.match(/Chrome\/(\d+)/)[1],
    engineName:"Blink", osName:"Windows", osVersion:"10",
    screenWidth/screenHeight, cpuCoreNum, deviceMemory,
    securityKey: getSecurityKey() };            // 独立模式取消操作的密钥来源（06 文档）
}
// DOMContentLoaded 自动 dispatch DY_CAPTURE_BROWSER_FEATURES → content → CAPTURE_BROWSER_FEATURES 消息落库
// 设置面板「刷新」→ background REFRESH_BROWSER_FEATURES → sendToTabAsync(REQUEST_CAPTURE_BROWSER_FEATURES)
//   → DY_REQUEST_BROWSER_FEATURES 事件 → inject 即时采集 → DY_CAPTURE_BROWSER_FEATURES_REFRESH 回传
```

### 安全状态数据模型（GET_SECURITY_STATUS 输出契约）

`collectSecurityStatus()` 同步执行立即返回（background 5s 超时）：

```js
{
  key: string,            // localStorage[security-sdk/s_sdk_cert_key].data 去 "pub." 前缀；空串表示未捕获
  keyUpdatedAt: number,   // Date.now()；key 为空时为 0
  signatures: {           // 六路捕获缓存的摘要（键与缓存一一对应）
    detail / following / profile / post / favorite / collection:
      { value, updatedAt, captured, webSign }
      // value 为剥除 SDK_INJECT_KEYS 后的业务/环境参数拼接（代签策略下签名键无展示价值）；
      // captured 与 value 分离——捕获可能仅含签名键，此时 value 为空仍算已捕获；
      // webSign = 捕获是否含 x-secsdk-web-signature（面板显示标记，用于观察端点风控策略变化）；
      // updatedAt 来自 Map.__dyCaptureTime
  },
  hooks: { fetch: bool, xhr: bool },    // __dyManagerFetchHooked / __dyManagerXhrHooked 标志位
}
```

视觉截断依赖 CSS `.sec-truncate`（JS 不截断文本）；展开/收起 selector 需兼容两种状态：`row.querySelector('.sec-truncate, .sec-expanded')`。

### showNoSignatureDialog 的触发条件

Tab 模式下 inject 回 `NO_SIGNATURE` 后，options 弹 `showNoSignatureDialog(url, stepName, scanName)` 引导用户先打开对应抖音页面产生真实请求（签名捕获的来源），三个入口：

| 入口 | 引导页 | 文案来源 |
|------|--------|----------|
| 关注同步（vmSyncFollowings 收到 NO_SIGNATURE） | `/user/self?showTab=following` | 硬编码 |
| 扫描点赞（openScanDialog） | `cfg.noSignatureUrl` = `/user/self?showTab=like` | `cfg.noSignatureStep` / `cfg.noSignatureScan` |
| 扫描收藏（openScanDialog） | `cfg.noSignatureUrl` = `/user/self?showTab=favorite_collection` | 同上 |

## 异常场景及处理

| 场景 | 表现 | 处理 |
|------|------|------|
| 冷启动无签名缓存 | following/favorite/collection/profile 事件层直接回 `NO_SIGNATURE` | options 弹 `showNoSignatureDialog` 引导先打开对应抖音页面（触发条件见上文）；detail/post 无此前置检查（见 07 待补充项） |
| 用户在 `/user/self` 页触发扫描 | secUid === "self" | `resolveSelfSecUidFromCaptures()` 从缓存签名解析真实 sec_uid；解析不出仍报 NO_SIGNATURE |
| detail 返回空 body | 抛 `RATE_LIMITED` | 属致命错误码，终止整个同步批次（01 文档分类表） |
| 预塞旧签名（误改 stripSdkKeys） | argus `web_id_sign_invalid` 403 | 保持"剥离全部 SDK 键再裸发"的形态不变 |
| AbortError | fetch/XHR 被 abort | 统一转译为 `CANCELLED`（cancelOne）/由外层 catch 上抛（fetch 路径） |
| Hook 未生效（页面 CSP 变更等） | `__dyManagerFetchHooked/__dyManagerXhrHooked` 为 false | 安全状态面板 hooks 字段可见；GET_SECURITY_STATUS 是唯一恒走 Tab 的诊断入口（01 文档路由表） |
| React 升级致 Fiber 结构变化 | 按钮点击取不到 awemeInfo | toast「无法获取作品信息」；需重新适配选择器/Fiber 搜索（前端耦合风险） |
| 双 Hook 重入 | — | `window.__dyManager*Hooked` 标志位防重复安装 |

## 配置项说明

| 配置 | 默认 | 作用 |
|------|------|------|
| `CONFIG.API_PATTERNS` | 13 条 pathname 前缀 | 捕获与数据提取的命中范围（feed/search/mix 等浏览流量也产出作品） |
| `CONFIG.DEVICE_PARAMS` | aid=6383 等 9 键 | 构造请求的基础设备参数（注意 version_code 与 background buildBaseParams 不同步：170400 vs 290100，属历史差异） |
| `CONFIG.TIMEOUT` | FETCH_PAGE:15000 / FETCH_DETAIL:8000 | inject 侧请求超时 |
| `CONFIG.CANCEL.*` | digg/collect 四要素 | 取消端点（Tab模式 JS 可直接设 Referer，无需 DNR） |
| `CONFIG.SECURITY_KEY` | `security-sdk/s_sdk_cert_key` | ticket-guard 公钥的 localStorage 键 |
| `CONFIG.BUTTON.*` | 选择器 / 防抖 100ms / `TEXT_SAVE:"保存"` | 按钮注入参数；hover tooltip 显示 `@昵称 · 描述前30字符`（截断长度 `TOOLTIP_DESC_MAX_LEN:30`，取不到作品信息时回落纯"保存"） |
| `PAGE_KEYS` / `SDK_INJECT_KEYS` | 两个 Set | stripPageKeys / stripSdkKeys 的剥离清单 |

## 相关文档

| 编号 | 文档 | 关联内容 |
|------|------|----------|
| 01 | [01-project-architecture.md](./01-project-architecture.md) | 四层架构定位、sendToTab/requestResponse 协议、进度消息表 |
| 02 | [02-independent-sync-works.md](./02-independent-sync-works.md) | fetchOneDetail 的独立模式对照（formatWork ⇔ extractVideo 双实现同步约束） |
| 03 | [03-independent-sync-followings.md](./03-independent-sync-followings.md) | fetchFollowingPage / 关注列表归一化的 Tab 分支细节 |
| 04 | [04-independent-calibrate-followings.md](./04-independent-calibrate-followings.md) | fetchProfileOther 五源 fallback 的消费方 |
| 05 | [05-independent-scan-collection.md](./05-independent-scan-collection.md) | fetchOneFavoritesPage/fetchOneCollectionPage 代签方案的独立模式对照 |
| 06 | [06-independent-cancel-collection.md](./06-independent-cancel-collection.md) | cancelOne XHR 的独立模式对照与双模差异表 |
| 07 | [07-independent-fetch-user-works.md](./07-independent-fetch-user-works.md) | fetchAuthorWorks 的独立模式对照 |
| 08 | [08-dnr-rules.md](./08-dnr-rules.md) | Tab模式为何不依赖 rule 4–6（页面内发起天然合规） |
