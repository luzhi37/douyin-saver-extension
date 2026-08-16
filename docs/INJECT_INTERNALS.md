# inject.js 内部机制

> 本文档描述主世界脚本 `content/inject.js` 的数据提取、签名捕获与缓存、fetch/XHR Hook、以及安全密钥获取机制。

## 1. 数据提取

### transformAwemeItem

输入为 API 返回的 `aweme_list` 中单个 item，委托给 `normalizeWork(aw, "api")` 提取核心字段（`awemeId`, `type`, `desc`, `nickname/uid/authorHomeUrl`, `cover`, `video`, `images`, `music`, `createTime`, `statistics`）。`includeAuthorFollowed` 选项通过 `extractAuthorFollowed` 读取 `author.follow_status` 判断作者是否被关注。

### extractWorkFromRaw

薄包装，委托给 `normalizeWork(awemeData, source)`，根据 `source` 选择码率提取逻辑：
- `"fiber"`（React Fiber 注入按钮）：码率字段 `video.bitRateList`（驼峰），按分辨率降序，排除 `gearName` 含 `adapt` 的档位
- `"api"`（API 响应）：码率字段 `video.bit_rate`（下划线），按 `height` 取最高分辨率，同分辨率取最大 `dataSize`

### React Fiber 遍历

`getAwemeInfoFromButton(btn)` → `getReactFiber(el)` 查找 `__reactFiber$` 属性 → `searchAwemeInfoFromFiber(fiber)` 递归搜索 `memoizedProps.awemeInfo`。两级策略：先 `parentElement` 向上，再 `btn.closest('.basePlayerContainer')`。

### 按钮注入

`createSaveButton` / `onSaveButtonClick`：mouseenter 显示 tooltip，点击阻止冒泡 + dispatch `DY_BUTTON_CLICK`。`injectButtons` 用 `:not(:has(.dy-saver-btn))` 防重复注入。`startObserver` 用 MutationObserver + 100ms 防抖。

## 2. 签名捕获与缓存

`captureFromUrl(url)` 从请求 URL 的 query 中提取签名参数存入 `Map` 实例缓存变量（`__capturedFollowingQuery`、`__capturedPostQuery`、`__capturedFavoriteQuery`、`__capturedCollectionQuery`、`__lastCapturedDetailQuery`），并记录 `__dyCaptureTime`（Map 实例属性，不参与 entries 遍历）。每个端点签名**一一对应**不可混用。

`mergeParams(url, captured)` 将缓存的签名参数合并到新 URL，已有参数不覆盖。`stripPageKeys(captured)` 剥离分页参数（`cursor`, `max_cursor` 等），只保留签名参数用于点赞/收藏扫描。

### 请求签名（点赞/收藏扫描）

**抖音页面覆盖 `window.fetch` 自动注入签名参数**：扩展请求无需（也不能）自行携带 `a_bogus` 等签名——构造与页面一致的"未签名" URL，直接走 `window.fetch`（抖音 fetch 包装器在扩展 Hook 外层，先注入 `a_bogus`/`msToken`/`timestamp`/`x-secsdk-web-signature`/`verifyFp`/`fp`/`uifid` 再发出）。实测：console 中 `fetch(favorite URL)` 返回 200，最终 `response.url` 已被包装器附加完整签名。

`stripSdkKeys(captured)`（`SDK_INJECT_KEYS`）从捕获参数中**剥离全部签名注入项**，防止预塞旧签名组合（如复用旧 `a_bogus`）导致 wrapper 不再处理、argus 校验失败（`web_id_sign_invalid` 403）。`fetchOneFavoritesPage` / `fetchOneCollectionPage` 通过 `mergeParams(url, stripPageKeys(stripSdkKeys(__capturedXXXQuery)))` 复用非签名业务参数（`webid`/`sec_user_id` 等）后直接 `window.fetch` 发出。

### `_dyInternal` 保护

6 个 API 请求函数均使用 `window.fetch`（经 Fetch Hook），在 fetch options 中添加 `_dyInternal: true` 标志。Hook 检测到该标志后跳过 `captureFromUrl` 和 `dispatchWorks`，避免自污染。相比旧 save/restore 模式的优势：
- 消除自污染
- 不丢弃并发真实捕获
- 无样板代码

## 3. Hook 实现

Fetch Hook 替换 `window.fetch` Hook，对匹配 `CONFIG.API_PATTERNS` 的请求：捕获签名 + 用 `response.clone().json()` 提取作品数据（分离 Promise 链，不阻塞响应交付）。对其他 HTTP 请求仅捕获签名。`window.__dyManagerFetchHooked` 标志位供安全状态面板读取。Hook 自身使用 `origFetch` 避免递归。

XHR Hook 包装 `XMLHttpRequest.prototype.open` 保存 URL 到 `_dyUrl`，在 `load` 事件中用 `/aweme/` 预检后调用 `captureFromUrl`。仅用于签名捕获，不提取作品数据。`window.__dyManagerXhrHooked` 标志位供安全状态面板读取。

### 取消信号

inject.js 维护 `activeTask` 单槽位（模块级闭包变量），`setActiveTask(abortFn)` 注册，`DY_CANCEL_ACTIVE_TASK` 事件触发取消。各操作通过 `AbortController` 实现单条请求取消。信号通过 `options → background → withDouyinTab → content.js → dispatch CustomEvent` 送达 inject.js。

## 4. 密钥获取

`getSecurityKey()` 从 `localStorage['security-sdk/s_sdk_cert_key']` 读取 JSON，取 `data` 字段，去掉 `pub.` 前缀。用于取消操作时作为 `bd-ticket-guard-ree-public-key` 请求头发送。每次 XHR 前重读，密钥在批次中途自动更新。若 key 为空，请求不带该 header，服务器返回 401/403。