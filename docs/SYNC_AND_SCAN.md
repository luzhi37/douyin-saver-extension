# 同步与扫描机制

> 本文档描述所有长耗时任务（作品同步、关注同步、点赞/收藏扫描、取消点赞/收藏、作者主页分页）的完整链路、时序差异、AbortController 使用与分页参数。

## 1. 同步作品机制

**完整链路**：`options.js → background.js → content.js → inject.js → 回传`

### 触发
`sync.syncCurrentGroup()` → `sync.syncAwemeIds(awemeIds)` → `sync.openSyncDialog(total)` → `sync.startSync(awemeIds)` → `services.bgMsg({ type: 'SYNC_WORKS', awemeIds })`

### background.js 循环（`handleSyncWorks`）
- 生成 `requestId = crypto.randomUUID()`
- 立即返回 `{ ok: true, requestId, total: awemeIds.length }`
- 逐作品 for 循环：
  1. `sendToTabAsync('FETCH_SINGLE_WORK', { awemeId, timeout: CONFIG.TIMEOUT.REQUEST })` — 每次请求独立 requestId
  2. 收集成功的结果到 `allWorks[]`
  3. 发送 `SYNC_PROGRESS` 到 options（含 `index`、`total`、`status`）
  4. 页间随机延迟 500–1200ms（`CONFIG.DELAY.MIN/MAX`）
  5. 每完成 `BATCH_SIZE`（默认 30）条后暂停 20–30s 随机（`CONFIG.SYNC.BATCH_PAUSE_MIN/MAX`），避免命中滑动窗口限流。暂停期间每 `KEEPALIVE_INTERVAL`（5s）调用一次 `chrome.storage.local.get`，防止 Chrome MV3 因无扩展 API 活动而终止 Service Worker 导致异步状态丢失。
- 循环中检查 `cancelled` 标志（来自 `CANCEL_ACTIVE_TASK`）
- 循环结束调用 `mergeAndSaveWorks(allWorks)` 写入存储
- `sendSyncDone()` 发送完成消息

#### 错误分类与处理

`FATAL_ERRORS`（终止整个批次）：
| 错误 | 含义 |
|---|---|
| `NO_DOUYIN_TAB` | 找不到抖音标签页 |
| `TAB_QUERY_FAILED` | chrome.tabs.query 异常 |
| `NO_LISTENER` | content.js 未注入 |
| `EMPTY_RESPONSE` | 返回空响应 |
| `RATE_LIMITED` | 服务器返回空 body（限流信号） |
| `CANCELLED` | 用户主动取消 |
| `HTTP 401` | 认证失效（cookie 过期） |
| `HTTP 429` | 明确限流 |

非致命错误（跳过该作品，继续下一个）：
| 错误 | 含义 |
|---|---|
| `TIMEOUT` | 单次请求超时 |
| `HTTP 403` | 作品不可访问（私密/删除） |
| `HTTP 5xx` | 服务器偶发错误 |
| `status_code=xxx` | API 业务错误 |
| 网络异常 | 单次网络抖动 |

终止时，剩余未同步的 awemeId 均标记为 `BATCH_TERMINATED`。

### content.js 桥接
`requestResponse('DY_FETCH_SINGLE_WORK_REQUEST', 'DY_FETCH_SINGLE_WORK_RESULT', message.timeout, ...)`

### inject.js 执行（`fetchOneDetail`）
- 构建 `CONFIG.API.DETAIL` URL
- 合并 `CONFIG.DEVICE_PARAMS` 和缓存的 `__lastCapturedDetailQuery`
- `origFetch` 发起请求，超时 `CONFIG.TIMEOUT.FETCH_DETAIL`（8s）
- 返回单个 work 对象
- 空 body 时抛出 `RATE_LIMITED`（由 background 判定为致命错误，终止批次）

**`mergeAndSaveWorks()`**（background.js）：
- 逐条 `storage.get` 读取旧数据（仅 incoming 的 awemeId），保留旧 `groupId` 与 `savedAt`
- 调用 `storage.putBatch` 仅写入变更的条目
- 用 `storage.count` 获取总数

### options.js 接收进度
- `SYNC_PROGRESS` → `sync.onSyncProgress(message)` 更新弹窗进度
- `SYNC_DONE` → `sync.onSyncDone(message)` 显示结果

## 2. 同步关注机制

### 触发
`sync.syncFollowings()` → `sync.vmSyncFollowings()` → `services.findSecUid()` 解析 secUid → `services.bgMsg({ type: 'FETCH_FOLLOWING', secUid })`

### background.js 循环（`handleFetchFollowing`）
- 生成 `requestId = crypto.randomUUID()`
- 立即返回 `{ ok: true, requestId, followings, total }`（注：`sendResponse` 在循环完成后才调用，但 options 层的 `bgMsg` await 等全部完成才会拿到结果）
- 逐页 for 循环：
  1. `sendToTabAsync('FETCH_FOLLOWING_PAGE', { secUid, offset, timeout: CONFIG.TIMEOUT.REQUEST })`
  2. 每页结果中的 `items` 追加到 `all[]`，`hasMore` / `cursor` 更新
  3. 发送 `FOLLOWING_PROGRESS` 到 options（含 `collected`、`hasMore`、`total`、`requestId`）
  4. 页间随机延迟 500–1200ms（`CONFIG.DELAY.MIN/MAX`）
- 循环中检查 `cancelled` 标志
- 标准化（inject.js 中完成）：`{ uid, nickname, avatarLarger, followerCount, profileUrl }`（仅 5 字段）
- 最终调用 `handleSaveFollowings` 写入存储（在 vmSyncFollowings 的调用方进行）

### 进度回传
```
background 循环内 chrome.runtime.sendMessage({ type: 'FOLLOWING_PROGRESS', ... })
→ options chrome.runtime.onMessage → sync.onFollowingProgress()
```

### inject.js 执行（`FETCH_FOLLOWING_PAGE` 单页 handler）
- **签名**：仅使用 `__capturedFollowingQuery`（签名与端点一一对应，不可混用），为空时立即返回 `{ ok: false, error: 'NO_SIGNATURE' }`
- **fetchFollowingPage**：发送 `/aweme/v1/web/user/following/list` + DEVICE_PARAMS + 签名；内部不重试，失败由 background 循环 handler 的 `sendToTabAsync` 超时兜底
- **返回**：`{ items, hasMore, cursor, total, ok }`

## 3. 扫描点赞/收藏机制

两个流程高度相似，共用 `Favorites.openScanDialog(cfg)`，通过 cfg 参数驱动差异。

### 点赞（`options.js:3151`）
```js
favorites.openScanDialog({
  title: '扫描点赞',
  stateKey: 'favoriteWorks',          // state.favoriteWorks
  fetchingKey: 'favoriteFetching',    // state.favoriteFetching
  cancelingKey: 'cancelingFavorites', // state.cancelingFavorites
  cancelType: 'CANCEL_LIKE',
  formatStats: (total, unfollowed) => `已扫描 ${total} 个点赞作品，发现 ${unfollowed} 个未关注作者作品`,
  cancelLabel: '取消点赞',
  noSignatureUrl: config.URLS.USER_SELF + config.URLS.LIKE_TAB,
  noSignatureStep: '点赞',
  noSignatureScan: '扫描点赞列表',
  buildFetchArgs: () => ({ type: 'FETCH_FAVORITES', secUid: null }),
  needSecUid: true,                   // 需要先找 secUid
});
```

### 收藏（`options.js:3167`）
```js
favorites.openScanDialog({
  title: '扫描收藏',
  stateKey: 'collectionWorks',
  fetchingKey: 'collectionFetching',
  cancelingKey: 'cancelingCollections',
  cancelType: 'CANCEL_COLLECTION',
  formatStats: (total, unfollowed) => `${total} 件 · 未关注 ${unfollowed} 件`,
  cancelLabel: '取消收藏',
  noSignatureUrl: config.URLS.USER_SELF + config.URLS.COLLECTION_TAB,
  noSignatureStep: '收藏',
  noSignatureScan: '扫描收藏列表',
  buildFetchArgs: () => ({ type: 'FETCH_COLLECTION' }),
  needSecUid: false,                  // 收藏不需要 secUid
});
```

### openScanDialog 流程
1. 若 `cfg.needSecUid`：`services.findSecUid()` 获取 secUid
2. `services.bgMsg(fetchArgs)` 发请求
3. 收到结果存入 `state[cfg.stateKey]`
4. `#renderGrid()` 渲染未关注作品网格
5. 添加 `cfg.cancelLabel` 按钮，点击触发 `services.bgMsg({ type: cfg.cancelType, awemeIds })` 取消

### background.js 循环（`handleFetchFavorites` / `handleFetchCollection`）

两个函数结构相同，差异仅在转发的消息类型和目标 API：

| 项 | 点赞 | 收藏 |
|---|---|---|
| background handler | `handleFetchFavorites` | `handleFetchCollection` |
| 转发消息类型 | `FETCH_FAVORITES_PAGE` | `FETCH_COLLECTION_PAGE` |
| 进度消息 | `FAVORITES_PROGRESS` | `COLLECTION_PROGRESS` |

循环流程：
1. 生成 `requestId = crypto.randomUUID()`
2. `sendToTabAsync('FETCH_FAVORITES_PAGE' / 'FETCH_COLLECTION_PAGE', { secUid, cursor, timeout })`
3. 每页结果追加到 `all[]`，更新 `hasMore` / `cursor`
4. 发送进度消息到 options（含 `collected`、`unfollowedCount`、`hasMore`、`total`、`requestId`）
  5. 页间随机延迟 500–1200ms（`CONFIG.DELAY.MIN/MAX`）
6. 最终返回 `{ ok: true, works, requestId, timedOut }`

### inject.js 单页 handler（`fetchOneFavoritesPage` / `fetchOneCollectionPage`）

| 项 | 点赞 | 收藏 |
|---|---|---|
| API | `/aweme/v1/web/aweme/favorite/` | `/aweme/v1/web/aweme/listcollection/` |
| method | GET | POST |
| headers | 仅 Referer | `content-type: COLLECTION_CONTENT_TYPE` |
| 签名来源 | `__capturedFavoriteQuery` | `__capturedCollectionQuery` |
| transformAwemeItem | `includeAuthorFollowed: true` | `includeAuthorFollowed: true` |
| 超时 | 15s（`CONFIG.TIMEOUT.FETCH_PAGE`） | 同左 |
| 返回 | `{ items, hasMore, cursor, total, ok }` | 同左 |

- 每次请求合并 `stripPageKeys(capturedQuery)` 剥离分页参数、只保留签名
- `origFetch` 发起请求
- 超时 15s（`CONFIG.TIMEOUT.FETCH_PAGE`）

## 4. 取消点赞/收藏机制

### 触发
```js
targets = state[cfg.stateKey].filter(w => w.authorFollowed === false);
ids = targets.map(w => w.awemeId);
services.bgMsg({ type: cfg.cancelType, awemeIds: ids });
```

### background.js → content.js → inject.js（background-driven per-awemeId 循环）
```js
// background.js handleCancelLike / handleCancelCollection
for (let i = 0; i < awemeIds.length && !cancelled; i++) {
  const resp = await sendToTabAsync('CANCEL_ONE_LIKE', {
    awemeId: awemeIds[i],
    timeout: CONFIG.TIMEOUT.REQUEST,  // 单条超时 30s,与批大小无关
  });
  // ...
}

// content.js 路由:每次单条转发
requestResponse('DY_CANCEL_ONE_LIKE_REQUEST', 'DY_CANCEL_ONE_LIKE_RESULT', 30000)
```

**与早期实现的差异**：早期使用 `runCancelLoop`（inject.js 内循环）+ `TIMEOUT.CANCEL=120000` 一次性派发。N>120 时必然 TIMEOUT 但 inject.js 循环仍在跑,状态不一致。新实现与 SYNC_WORKS / FETCH_FOLLOWING 等长操作一致,逐条派发 + 实时进度 + 完成消息。

### inject.js 单条取消（cancelOneLike / cancelOneCollection）
```js
function cancelOne(awemeId, url, bodyFn, referrer, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    // ... signal 监听 abort ...
    const key = getSecurityKey();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('content-type', CONFIG.CANCEL_CONTENT_TYPE);
    xhr.setRequestHeader('Referer', referrer);
    if (key) xhr.setRequestHeader('bd-ticket-guard-ree-public-key', key);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else if (xhr.status === 401 || xhr.status === 403) reject(new Error('AUTH_FAILED'));
      else reject(new Error('HTTP_' + xhr.status));
    };
    xhr.onerror = () => reject(new Error('NETWORK_ERROR'));
    xhr.onabort = () => reject(new Error('CANCELLED'));
    xhr.send(bodyFn(awemeId));
  });
}
```

**为什么用 XHR 而非 fetch**：抖音的 a_bogus 签名绑定在 XHR 原型链上。

### 进度与完成消息
| 消息 | 触发时机 | 字段 |
|---|---|---|
| `CANCEL_PROGRESS` | 每条 XHR 完成后 | `requestId, index, total, status, awemeId` |
| `CANCEL_DONE` | 整个批次完成(或用户取消) | `requestId, ok, cancelled, refreshed, failed, failedAwemeIds` |

options.js 通过 `favorites.onCancelProgress` / `favorites.onCancelDone` 监听,实时更新按钮文字(取消中... (5/200))和最终 UI。

### 点赞 vs 收藏参数对比

| 项 | 取消点赞 | 取消收藏 |
|---|---|---|
| URL | `https://www.douyin.com/aweme/v1/web/commit/item/digg/?aid=6383` | `https://www.douyin.com/aweme/v1/web/aweme/collect/?aid=6383` |
| Body | `aweme_id=${id}&item_type=0&type=0` | `action=0&aweme_id=${id}&aweme_type=0` |
| Referrer | `https://www.douyin.com/user/self?showTab=like` | `https://www.douyin.com/user/self?showTab=favorite_collection` |
| ContentType | `application/x-www-form-urlencoded; charset=UTF-8` | 同左 |
| bd-ticket-guard 公钥 | `getSecurityKey()`（每次请求前重读） | 同左 |
| 请求间延迟 | `CONFIG.DELAY.MIN/MAX` 500-1200ms 随机（位于 background.js） | 同左 |
| 错误处理 | 失败项记入 `failedAwemeIds`,继续后续项 | 同左 |

**AUTH_FAILED 提示**：单个 XHR 返回 401/403 时抛 `AUTH_FAILED` 错误,该项记入失败列表但不中断整个批次。最终 toast 显示成功/失败数量。

### TIMEOUT 概览
background 侧单次 Tab 请求超时使用 `CONFIG.TIMEOUT.REQUEST = 30000`（由 `sendToTab` 主导）。inject.js 侧另有独立超时：`TIMEOUT.FETCH_PAGE = 15000`（单页 fetch 超时）、`TIMEOUT.FETCH_DETAIL = 8000`（详情 fetch）。安全面板查询保留独立的 `SECURITY_STATUS = 5000`（UI 阻塞场景）。

### Service Worker 保活
作品同步的批次暂停（20–30s）是唯一可能触发 SW 终止的长空闲窗口。`CONFIG.SYNC.KEEPALIVE_INTERVAL = 5000` 控制保活间隔：暂停被拆分为 5s 分段，每段结束后调用 `chrome.storage.local.get` 重置 SW 空闲计时器。其余循环（关注同步、点赞/收藏扫描、取消操作）每次延迟前均有 `chrome.*` API 调用，无需额外处理。

## 5. 作者主页作品分页

### 触发（侧边栏滚动）
```js
// Sidebar 滚动监听
if (dom.sidebarBody.scrollTop + dom.sidebarBody.clientHeight >= dom.sidebarBody.scrollHeight - 100) {
  this.#loadMoreWorks();
}
```
**守卫条件**：`state.sidebarLoading || !state.sidebarCursor || !state.currentFollowingSecUid` 时不触发。

### loadSidebarWorks
```js
services.bgMsg({ type: 'FETCH_WORKS_PAGE', secUid, cursor })
```
收到结果后：
- 追加到 `dom.sidebarWorksGrid`
- 更新 `state.sidebarCursor = res.hasMore ? res.maxCursor : null`
- 若内容不足以填满容器，递归调用 `#loadMoreWorks()`

### 超时分级
`sendToTab('FETCH_WORKS_PAGE', { secUid, cursor, timeout: CONFIG.TIMEOUT.REQUEST })`（background 侧 30s 超时；content.js 侧 `requestResponse` 硬编码 60s 兜底）

### inject.js 抓取（`fetchAuthorWorks(secUid, startCursor)`）
- **API**：`/aweme/v1/web/aweme/post/`
- **参数**：`sec_user_id, max_cursor, count(CONFIG.PAGE.AUTHOR), DEVICE_PARAMS`
- **签名**：仅使用 `__capturedPostQuery`（签名与端点一一对应，不可混用）
- 失败由 background 的 `sendToTabAsync` 超时兜底，侧边栏不再加载该页，用户重滚触发重新请求
