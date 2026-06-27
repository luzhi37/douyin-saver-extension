# inject.js 内部机制

> 本文档描述主世界脚本 `content/inject.js` 的数据提取、签名捕获与缓存、fetch/XHR Hook、以及安全密钥获取机制。

## 1. 数据提取

### transformAwemeItem（`inject.js:173`）

**输入**：原始 aweme JSON（API 返回的 `aweme_list` 中单个 item）。

**提取字段**：
- `awemeId`：`String(aw.aweme_id || '')`
- `desc`：`aw.desc || ''`
- `cover`：`aw.video.cover.url_list[0] || ''`
- `video`：`bit_rate` 数组中码率最高的 `play_addr.url_list[0]`
- `createTime`：`aw.create_time || 0`
- `statistics`：`aw.statistics || {}`
- `type`：`aw.aweme_type === 68 ? 'note' : 'video'`（68 = 图文，`AWEME_TYPE_NOTE`）

**`includeAuthorFollowed` 选项**：提取 `author.follow_status`（`1`/`2` 视为已关注；字段不存在返回 `null`），用于判断作者是否被当前用户关注（点赞/收藏场景必需）。

### extractWorkFromRaw（`inject.js:262`，更复杂，处理两种数据来源）

**`fromFiber: true`**（React Fiber 注入按钮时）：
- 数据来源：`btn` 元素关联的 React fiber 中的 `memoizedProps.awemeInfo`
- 视频码率字段：`video.bitRateList`（**驼峰命名**）
- 排序逻辑：按分辨率降序，`splice(1)` 只保留最高一条
- 排除 `gearName` 包含 `adapt` 的档位

**`fromFiber: false`**（API 响应中提取）：
- 数据来源：`fetch` 响应 JSON
- 视频码率字段：`video.bit_rate`（**下划线命名**）
- 排序逻辑：按 `height` 取最高分辨率，同分辨率去重保留最大 `dataSize`
- 回退逻辑：若筛选后为空，取第一条非 H265 码率

**共同字段提取**：
- `awemeId`：`String(awemeData.aweme_id || awemeData.awemeId)`
- `type`：`aweme_type === 68 ? 'note' : 'video'`
- `cover`：视频封面 `url_list[0]`，图文取第一张图
- `video`：最高分辨率码率的 `play_addr.url_list[0]`
- `images`：图文作品的 `images[].url_list[0]` 数组
- `music`：`music.playUrl.uri` 或 `music.play_url.uri`
- `nickname` / `uid` / `authorHomeUrl`：作者信息

### extractWorksFromResponse 的 pathname 分发
```js
if (pathname.includes(CONFIG.DETAIL_PATH)) {
  list = [data.aweme_detail];                         // 作品详情
} else if (pathname.includes('/aweme/v1/web/follow/feed') || pathname.includes('/aweme/v1/web/familiar/feed')) {
  list = data.data.map(item => item.aweme);           // 关注/朋友 feed
} else if (pathname.includes('/aweme/v1/web/search/') || pathname.includes('/aweme/v1/web/general/search/')) {
  list = data.data.map(item => item.aweme_info);      // 搜索
} else {
  list = data.aweme_list;                             // 默认：作者作品/点赞/收藏
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

### captureFromUrl 工作流程（`inject.js:127`）
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
   if (u.pathname.includes(CONFIG.DETAIL_PATH)) { __lastCapturedDetailQuery = params; }
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

### 签名等待机制
```js
// fetchAllFollowings 开始时
if (!__capturedFollowingQuery) {
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (__capturedFollowingQuery) break;
  }
}
if (!__capturedFollowingQuery) throw new Error('NO_SIGNATURE');
```
- 关注同步开始前，若尚未捕获签名，循环等待最多 80 次 × 100ms = 8s
- 签名通常会在用户访问抖音关注列表后由 Fetch/XHR Hook 自动捕获
- 关注分页出错重试时，会清除 `__capturedFollowingQuery = null`，等待下一次请求捕获新签名

## 3. Hook 实现细节

### Fetch Hook（`inject.js:419`）
```js
const origFetch = window.fetch;
window.fetch = function (...args) {
  const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
  return origFetch.apply(this, args).then(async (response) => {
    const parsedUrl = url && typeof url === 'string' && url.startsWith('http') ? shouldCapture(url) : null;
    if (response.ok && parsedUrl) {
      captureFromUrl(url, parsedUrl);
      const data = await response.clone().json();
      const works = await extractWorksFromResponse(url, data, parsedUrl);
      dispatchWorks(works);  // dispatch DY_CAPTURE_WORKS
    } else if (response.ok && url && url.startsWith('http')) {
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
- **自调用必须用 `origFetch`**（否则触发自身 hook 导致无限递归）

### XHR Hook（`inject.js:447`）
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
| `syncWorks` | 遍历 `controllers` 逐个 `c.abort()` | `AbortController` 数组 |
| `paginatedFetcher`（点赞/收藏扫描） | `controller.abort()` | 单个 `AbortController` |
| `fetchAllFollowings` | `cancelController.abort()` + `cancelled = true` | `AbortController`（修复后） |
| `runCancelLoop`（取消操作） | `if (currentXhr) currentXhr.abort()` | XHR 实例 |

**信号链路**：`DY_CANCEL_ACTIVE_TASK` 必须在抖音标签页的 document 上 dispatch。options 页通过 `chrome.runtime.sendMessage({ type: 'CANCEL_ACTIVE_TASK' })` → background 的 `withDouyinTab()` → `chrome.tabs.sendMessage(tab.id, ...)` → content.js dispatch `CustomEvent`。原实现在 options 页的 document 上直接 `dispatchEvent`，信号到不了 inject.js。

> 取消点赞/收藏为何必须用 XHR 的详细原因见 [SYNC_AND_SCAN.md#4-取消点赞收藏机制](./SYNC_AND_SCAN.md#4-取消点赞收藏机制)。

## 4. 密钥获取机制

### getSecurityKey（`inject.js:547`）
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
// inject.js runCancelLoop
const key = getSecurityKey();
xhr.setRequestHeader('Referer', window.location.origin + '/');
if (key) xhr.setRequestHeader('bd-ticket-guard-ree-public-key', key);
```
- `getSecurityKey()` **每次 XHR 前重读**（`for` 循环内部调用），支持大量取消批次中途更新密钥
- 取消 XHR 增加 `Referer` header
- 若 `key` 为空，请求**不带**该 header，服务器会拒绝（403/401）
- `runCancelLoop` 中任一请求失败即退出整个取消流程
- options.js 检测到 `AUTH_FAILED` 时弹 toast 提示用户刷新页面

### 风险
- 密钥会过期，过期后取消请求返回 401/403
- 用户需刷新抖音页面重新获取密钥
- 服务器可能因无效 ticket-guard 密钥拒绝请求，极端情况下导致登出
