# inject.js 内部机制

> 本文档描述主世界脚本 `content/inject.js` 的数据提取、签名捕获与缓存、fetch/XHR Hook、以及安全密钥获取机制。

## 1. 数据提取

### transformAwemeItem（`inject.js:153`）

**输入**：原始 aweme JSON（API 返回的 `aweme_list` 中单个 item），委托给 `normalizeWork(aw, "api")` 提取核心字段。

**提取字段**（由 `normalizeWork` 通过子函数完成）：
- `awemeId`：`String(raw.aweme_id || raw.awemeId || '')`
- `type`：`(awemeType || aweme_type) === 68 ? 'note' : 'video'`
- `desc`：`raw.desc || ''`
- `nickname` / `uid` / `authorHomeUrl`：作者信息（由 `extractAuthor` 提取）
- `cover`：视频封面或图文首图 URL（由 `extractCover` 提取）
- `video`：最高分辨率码率的 `play_addr.url_list[0]`（由 `extractVideo` 提取）
- `images`：图文作品的图片 URL 数组（由 `extractImages` 提取）
- `music`：音频 URI（由 `extractMusic` 提取）
- `createTime` / `statistics`：直接映射

**`includeAuthorFollowed` 选项**：通过 `extractAuthorFollowed` 读取 `author.follow_status`（`1`/`2` 视为已关注；字段不存在返回 `null`），用于判断作者是否被当前用户关注（点赞/收藏场景必需）。

### extractWorkFromRaw（`inject.js:404`，委托给 `normalizeWork`）

薄包装，委托给 `normalizeWork(awemeData, fromFiber ? "fiber" : "api")`。

`normalizeWork` 根据 `source` 参数选择码率提取逻辑：

**`source: "fiber"`**（React Fiber 注入按钮时）：
- 数据来源：`btn` 元素关联的 React fiber 中的 `memoizedProps.awemeInfo`
- 视频码率字段：`video.bitRateList`（**驼峰命名**）
- 排序逻辑：按分辨率降序，取最高一条
- 排除 `gearName` 包含 `adapt` 的档位

**`source: "api"`**（API 响应中提取）：
- 数据来源：`fetch` 响应 JSON
- 视频码率字段：`video.bit_rate`（**下划线命名**）
- 排序逻辑：按 `height` 取最高分辨率，同分辨率去重保留最大 `dataSize`
- 回退逻辑：若筛选后为空，取第一条非 H265 码率

**共同字段提取**由 `normalizeWork` 内的 `extractAuthor` / `extractCover` / `extractVideo` / `extractImages` / `extractMusic` 完成。

### extractWorksFromResponse 的 pathname 分发
```js
if (pathname.includes(CONFIG.API.DETAIL)) {
  if (data.aweme_detail) list = [data.aweme_detail];   // 作品详情
} else if (pathname.includes('/aweme/v1/web/follow/feed') || pathname.includes('/aweme/v1/web/familiar/feed')) {
  if (Array.isArray(data.data)) {
    for (const item of data.data) {
      if (item.aweme) list.push(item.aweme);           // 关注/朋友 feed
    }
  }
} else if (pathname.includes('/aweme/v1/web/search/item/') || pathname.includes('/aweme/v1/web/general/search/single/')) {
  if (Array.isArray(data.data)) {
    for (const item of data.data) {
      if (item.aweme_info) list.push(item.aweme_info); // 搜索
    }
  }
} else {
  if (Array.isArray(data.aweme_list)) {
    list = data.aweme_list;                            // 默认：作者作品/点赞/收藏
  } else if (Array.isArray(data.data)) {
    for (const item of data.data) {
      if (item.aweme) list.push(item.aweme);
      else if (item.aweme_info) list.push(item.aweme_info);
    }
  }
}
```

### content.js 的作品捕获缓存（`capturedWorksMap`）
```js
const capturedWorksMap = new Map();

function capturedWorksLRUGet(key) {
  if (!capturedWorksMap.has(key)) return undefined;
  const val = capturedWorksMap.get(key);
  capturedWorksMap.delete(key);
  capturedWorksMap.set(key, val);
  return val;
}

document.addEventListener('DY_CAPTURE_WORKS', (event) => {
  for (const w of event.detail) {
    if (w && w.awemeId) capturedWorksMap.set(w.awemeId, w);
  }
  if (capturedWorksMap.size > 200) {
    let toDelete = capturedWorksMap.size - 150;
    const iter = capturedWorksMap.keys();
    while (toDelete-- > 0) capturedWorksMap.delete(iter.next().value);
  }
});
```
- 隔离世界维护一个 LRU 风格的内存缓存，上限 200 条；`capturedWorksLRUGet()` 在读取时将条目提升至 Map 末尾
- 超过 200 时删除最早的 50 条，保留 150 条
- 防止内存无限增长（抖音页面会持续加载新作品）

### React Fiber 遍历（注入按钮时）
```js
getAwemeInfoFromButton(btn)
  → getReactFiber(el)                      // 查找 __reactFiber$ 属性
  → searchAwemeInfoFromFiber(fiber)        // 递归搜索 memoizedProps.awemeInfo
```

**两级查找策略**：
1. 从按钮的 `parentElement` 开始向上查找
2. 若找不到，再尝试 `btn.closest(CONFIG.BUTTON.CONTAINER)`（`.basePlayerContainer`）

### 按钮注入
- `createSaveButton` / `onSaveButtonClick`：mouseenter 显示 tooltip（`@nickname · desc前30字`），点击阻止冒泡 + dispatch `DY_BUTTON_CLICK`
- `injectButtons`：用 `:not(:has(.dy-saver-btn))` 选择器避免重复注入
- `startObserver`：`MutationObserver` 监听 document 子树变化，100ms 防抖后重新 `injectButtons`（SPA 切换作品重渲染播放器）

## 2. 签名捕获与缓存机制

### 签名是什么
抖音 Web API 请求需要在 URL query 中携带签名参数（如 `a_bogus` / `msToken` / `X-Bogus` / `_signature` 等），这些参数由抖音前端 JS 动态生成、具有时效性。扩展无法自行生成签名，因此必须从页面真实请求中**捕获并复用**。

### captureFromUrl 工作流程（`inject.js:98`）
```js
function captureFromUrl(url, parsedUrl) {
  if (!url.startsWith('http')) return;
  const u = parsedUrl || new URL(url);
  const params = new Map();
  for (const entry of u.searchParams.entries()) params.set(entry[0], entry[1]);
  params.__dyCaptureTime = Date.now();  // 记录捕获时间戳
  if (u.pathname.includes(API_FOLLOWING)) { __capturedFollowingQuery = params; }
  if (u.pathname.includes(API_POST)) { __capturedPostQuery = params; }
  if (u.pathname.includes(API_COLLECTION)) { __capturedCollectionQuery = params; }
  if (u.pathname.includes(API_FAVORITE)) { __capturedFavoriteQuery = params; }
   if (u.pathname.includes(CONFIG.API.DETAIL)) { __lastCapturedDetailQuery = params; }
}
```

**缓存变量**（均为 `Map` 实例，模块级闭包变量）：

| 变量 | 用途 | 对应 API |
|---|---|---|
| `__capturedFollowingQuery` | 关注列表签名 | `/aweme/v1/web/user/following/list` |
| `__capturedPostQuery` | 作者作品签名 | `/aweme/v1/web/aweme/post/` |
| `__capturedFavoriteQuery` | 点赞列表签名 | `/aweme/v1/web/aweme/favorite/` |
| `__capturedCollectionQuery` | 收藏列表签名 | `/aweme/v1/web/aweme/listcollection/` |
| `__lastCapturedDetailQuery` | 作品详情签名 | `/aweme/v1/web/aweme/detail/` |

**`__dyCaptureTime`** 是附加在 `Map` 实例上的 JS 属性（不是 Map entry），用于记录签名捕获时间，不参与 `entries()` 遍历，但在安全状态面板中显示。

### 签名合并与分页参数剥离
```js
function mergeParams(url, captured) {
  if (!captured) return url;
  for (const entry of captured.entries()) {
    const [k, v] = entry;
    if (!url.searchParams.has(k)) url.searchParams.set(k, v);
  }
  return url;
}

const PAGE_KEYS = new Set(['cursor', 'max_cursor', 'min_cursor', 'offset', 'count']);
function stripPageKeys(captured) {
  if (!captured) return null;
  const out = new Map();
  for (const [k, v] of captured) {
    if (!PAGE_KEYS.has(k) && !k.startsWith('cursor') && !k.startsWith('max_') && !k.startsWith('min_')) {
      out.set(k, v);
    }
  }
  return out;
}
```
- `mergeParams`：将缓存的签名参数合并到新 URL，**已有参数不覆盖**（保留新 URL 的分页参数）
- `stripPageKeys`：用于点赞/收藏扫描时，只保留签名参数，清除分页参数（`cursor`、`max_cursor` 等）

### 签名一一对应
`a_bogus`/`X-Bogus` 签名基于完整 URL（path + params）计算，不同端点的签名不可混用。每个函数只使用自己端点的缓存：
- `fetchOneFavoritesPage` → `__capturedFavoriteQuery`
- `fetchOneCollectionPage` → `__capturedCollectionQuery`
- `fetchFollowingPage` → `__capturedFollowingQuery`
- `fetchAuthorWorks` → `__capturedPostQuery`
- `fetchOneDetail` → `__lastCapturedDetailQuery`

任一签名缺失时，对应请求监听器立即返回错误（如 `NO_SIGNATURE`），由 background 的 `sendToTabAsync` 超时兜底。

### `_dyInternal` 标志保护

由于所有 6 个 API 请求函数均使用 `window.fetch`（经 Fetch Hook），Hook 的 `captureFromUrl` 会在每个成功响应后自动覆盖对应缓存变量，造成**自污染**。

**自污染根源**：抖音真实请求的签名是抖音 JS 现场实时计算的，`captureFromUrl` 捕获的是新鲜签名，缓存得到正常更新。而扩展请求的签名是 `mergeParams` 从缓存读取的旧签名，`captureFromUrl` 将旧签名+扩展特定参数（`aweme_id`、`cursor` 等）写回，下次合并时签名参数就搭配了错误的 aweme_id，服务器拒绝。详见 [FETCH_AND_CACHE.md](../docs/FETCH_AND_CACHE.md)。

**`_dyInternal` 模式**：每个 API 函数在 fetch options 中添加 `_dyInternal: true` 标志：

```js
const resp = await window.fetch(url, {
  credentials: "include",
  _dyInternal: true,
});
```

Fetch Hook 检测到该标志后完全跳过 `captureFromUrl` 和 `dispatchWorks`，避免自污染。相比于旧的 save/restore 模式，优势如下：
- **消除自污染** — Hook 根本不处理扩展请求的响应
- **不丢弃并发真实捕获** — 扩展请求期间若抖音产生真实请求，Hook 正常更新缓存（旧 save/restore 的 `finally` 会覆盖掉并发捕获的新 Map）
- **无样板代码** — 无需在每个监听器中手动 save/restore

## 3. Hook 实现细节

### Fetch Hook（`inject.js:460`）
```js
const origFetch = window.fetch;
window.fetch = function (...args) {
  const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
  const options = args[1] || {};
  const isInternal = options._dyInternal === true;  // 扩展内部请求跳过 capture
  const parsedUrl = !isInternal && url && typeof url === 'string' && url.startsWith('http') ? shouldCapture(url) : null;
  return origFetch.apply(this, args).then(async (response) => {
    if (response.ok && parsedUrl) {
      captureFromUrl(url, parsedUrl);
      const data = await response.clone().json();
      const works = await extractWorksFromResponse(url, data, parsedUrl);
      dispatchWorks(works);  // dispatch DY_CAPTURE_WORKS
    } else if (response.ok && !isInternal && url && typeof url === 'string' && url.startsWith('http')) {
      captureFromUrl(url);  // 非 API 请求也捕获签名
    }
    return response;
  });
};
window.__dyManagerFetchHooked = true;
```
- 替换全局 `window.fetch`
- `shouldCapture(url)` 返回解析后的 `URL` 对象（非 boolean），传递给下游避免重复解析
- 对匹配 `CONFIG.API_PATTERNS` 的请求：捕获签名 + 用 `response.clone().json()` 提取作品数据
- 对其他 HTTP 请求：仅捕获签名
- `window.__dyManagerFetchHooked` 标志位供安全状态面板读取
- **Hook 自身实现使用 `origFetch`** 避免递归（`return origFetch.apply(this, args)`）
- **外部 API 请求函数统一使用 `window.fetch`**（经过 Hook，能捕获 Douyin 注入的签名参数），而非 `origFetch.call(window, ...)`。详见 [docs/FETCH_AND_CACHE.md](./FETCH_AND_CACHE.md)。

### XHR Hook（`inject.js:487`）
```js
(function hookXHR() {
  if (window.__dyManagerXhrHooked) return;
  window.__dyManagerXhrHooked = true;
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this._dyUrl = typeof url === 'string' ? url : (url && url.href || '');
    return origOpen.apply(this, arguments);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    const self = this;
    this.addEventListener('load', function () {
      const u = self._dyUrl;
      if (u && u.includes('/aweme/')) captureFromUrl(u);
    });
    return origSend.apply(this, arguments);
  };
})();
```
- 包装 `XMLHttpRequest.prototype.open` 保存 URL 到实例属性 `_dyUrl`
- 包装 `XMLHttpRequest.prototype.send`，在 `load` 事件中调用 `captureFromUrl`
- load 事件添加 `/aweme/` 字符串预检，跳过非 API 请求
- `window.__dyManagerXhrHooked` 标志位供安全状态面板读取
- XHR Hook **仅用于签名捕获**，不提取作品数据

### 后台任务取消支持（`setActiveTask` / `DY_CANCEL_ACTIVE_TASK`）

inject.js 维护一个 `activeTask` 单槽位（模块级闭包变量），通过 `setActiveTask(abortFn)` 注册，通过 document 上的 `DY_CANCEL_ACTIVE_TASK` 事件触发取消：

```js
let activeTask = null;

function setActiveTask(abort) {
  activeTask?.abort();
  activeTask = abort ? { abort } : null;
}

document.addEventListener('DY_CANCEL_ACTIVE_TASK', () => {
  if (activeTask) { activeTask.abort(); activeTask = null; }
});
```

各操作注册的 abort 回调：

| 操作 | `setActiveTask` 回调 | 实现方式 |
|---|---|---|
| `FETCH_SINGLE_WORK`（works 同步逐条） | `controller.abort()` | 单个 `AbortController` |
| `FETCH_FOLLOWING_PAGE`（关注同步逐页） | `controller.abort()` | `AbortController`（从 `fetchFollowingPage` 传入） |
| `FETCH_FAVORITES_PAGE`（点赞扫描逐页） | `controller.abort()` | 单个 `AbortController` |
| `FETCH_COLLECTION_PAGE`（收藏扫描逐页） | `controller.abort()` | 单个 `AbortController` |
| `CANCEL_ONE_LIKE_REQUEST`（取消点赞单条） | `controller.abort()` | 单个 `AbortController`（传入 `cancelOneLike`） |
| `CANCEL_ONE_COLLECTION_REQUEST`（取消收藏单条） | `controller.abort()` | 单个 `AbortController`（传入 `cancelOneCollection`） |

**信号链路**：`DY_CANCEL_ACTIVE_TASK` 必须在抖音标签页的 document 上 dispatch。options 页通过 `chrome.runtime.sendMessage({ type: 'CANCEL_ACTIVE_TASK' })` → background 的 `withDouyinTab()` → `chrome.tabs.sendMessage(tab.id, ...)` → content.js dispatch `CustomEvent`。原实现在 options 页的 document 上直接 `dispatchEvent`，信号到不了 inject.js。

> 取消点赞/收藏为何必须用 XHR 的详细原因见 [SYNC_AND_SCAN.md#4-取消点赞收藏机制](./SYNC_AND_SCAN.md#4-取消点赞收藏机制)。

## 4. 密钥获取机制

### getSecurityKey（`inject.js:595`）
```js
function getSecurityKey() {
  try {
    const raw = localStorage.getItem(CONFIG.SECURITY_KEY) || '{}';
    return (JSON.parse(raw).data || '').replace(/^pub\./, '');
  } catch (e) { return ''; }
}
```
- **来源**：抖音页面 `localStorage['security-sdk/s_sdk_cert_key']`
- **格式**：JSON 字符串，`{ data: 'pub.xxx...' }`
- **处理**：取 `data` 字段，去掉 `pub.` 前缀
- **用途**：取消点赞/收藏时作为 `bd-ticket-guard-ree-public-key` 请求头发送

### 密钥与取消操作的关系
```js
// inject.js cancelOneLike / cancelOneCollection
const key = getSecurityKey();
xhr.setRequestHeader('Referer', window.location.origin + '/');
if (key) xhr.setRequestHeader('bd-ticket-guard-ree-public-key', key);
```
- `getSecurityKey()` 每次 XHR 前重读（每次事件处理器独立调用），密钥在批次中途会自动更新
- 取消 XHR 增加 `Referer` header
- 若 `key` 为空，请求**不带**该 header，服务器会拒绝（403/401）
- 单条 XHR 失败不中断整个取消流程；background 收集到 `errors[]` 后通过 `CANCEL_DONE` 消息汇总
- options.js 检测到 `AUTH_FAILED` 时弹 toast 提示用户刷新页面

### 风险
- 密钥会过期，过期后取消请求返回 401/403
- 用户需刷新抖音页面重新获取密钥
- 服务器可能因无效 ticket-guard 密钥拒绝请求，极端情况下导致登出
