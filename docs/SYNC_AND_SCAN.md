# 同步与扫描机制

> 本文档描述所有长耗时任务（作品同步、关注同步、点赞/收藏扫描、取消点赞/收藏、作者主页分页）的完整链路、时序差异、AbortController 使用与分页参数。

## 1. 同步作品机制

**完整链路**：`options.js → background.js → content.js → inject.js → 回传`

### 触发
`sync.syncCurrentGroup()` → `sync.syncAwemeIds(awemeIds)` → `sync.openSyncDialog(total)` → `sync.startSync(awemeIds)` → `services.bgMsg({ type: 'SYNC_WORKS', awemeIds })`

### background.js 接收
- 生成 `requestId = crypto.randomUUID()`
- `syncSessions.set(requestId, true)` 记录会话
- `sendToTab('SYNC_WORKS', { awemeIds, requestId, timeout: 300000 })`
- 立即返回 `{ ok: true, requestId, total: awemeIds.length }`

### content.js 桥接
`requestResponse('DY_SYNC_WORKS_REQUEST', 'DY_SYNC_WORKS_RESULT', 300000, buildDetail)`

### inject.js 执行
**防重入**：`document.__dy_sync_requests` Set 防止重复 requestId。

**`syncWorks()`**（concurrency 池）：
- worker 池并发：`CONCURRENCY = 5`
- 每作品调用 `fetchOneDetail(awemeId)`
- 每请求间延迟 250ms
- dispatch `DY_SYNC_WORKS_PROGRESS` 进度事件
- 完成后 dispatch `DY_SYNC_WORKS_RESULT`

**`fetchOneDetail()`**：
- 构建 `/aweme/v1/web/aweme/detail/` URL
- 合并 `CONFIG.DEVICE_PARAMS` 和缓存的 `__lastCapturedDetailQuery`
- `origFetch` 发起请求，超时 8s（`CONFIG.TIMEOUT.FETCH_DETAIL`）

### 回传与存储
- inject → content：`DY_SYNC_WORKS_RESULT` CustomEvent
- content → background：`requestResponse` 的 `onResult` handler 调用 `sendResponse`
- background → options：`sendToTab` callback → `mergeAndSaveWorks(incoming)` 写入存储
- `sendSyncDone()` 发送完成消息

**`mergeAndSaveWorks()`**（background.js）：
- 逐条 `storage.get` 读取旧数据（仅 incoming 的 awemeId），保留旧 `groupId` 与 `savedAt`
- 调用 `storage.putBatch` 仅写入变更的条目
- 用 `storage.count` 获取总数

### options.js 接收进度
- `SYNC_PROGRESS` → `sync.onSyncProgress(message)` 更新弹窗进度
  - 进度计数使用 `#doneCount` 单调递增计数器（非 `index + 1`），避免并发 worker 完成顺序不同导致数字回跳
- `SYNC_DONE` → `sync.onSyncDone(message)` 显示结果

## 2. 同步关注机制

### 触发
`sync.syncFollowings()` → `sync.vmSyncFollowings()` → `services.findSecUid()` 解析 secUid → `services.bgMsg({ type: 'FETCH_FOLLOWING', secUid })`

### background.js → content.js → inject.js
```js
sendToTab('FETCH_FOLLOWING', { secUid, timeout: 300000 })
requestResponse('DY_FETCH_FOLLOWING_REQUEST', 'DY_FETCH_FOLLOWING_RESULT', 300000)
```

### inject.js 抓取（`fetchAllFollowings(secUid, requestId)`）
- **等待签名**：循环等待 80 次 × 100ms，若 `__capturedFollowingQuery` 为空
- **分页**：offset 从 0 开始，count = 20
- **API**：`/aweme/v1/web/user/following/list` + DEVICE_PARAMS + 签名
- **每页延迟**：300-400ms 随机
- **重试**：最多 3 次，间隔 3000ms（`CONFIG.RETRY.FOLLOWING`）
- **标准化**：`{ uid, nickname, avatarLarger, followerCount, profileUrl }`（仅 5 字段，**不含** `signature` / `secUid` 等易变字段）
- **AbortController**：创建 `cancelController`，`setActiveTask` 回调中 `cancelController.abort()`，`cancelController.signal` 作为 `externalSignal` 传入 `fetchFollowingPage`。修复前只有 `cancelled = true` 标志位，无即时 abort 能力。

### progress 时序差异（常见 bug 来源）
`SYNC_WORKS` 与 `FETCH_FOLLOWING` 的 `requestId` 返回时序不同：

| 操作 | background handler | requestId 返回时机 | progress 过滤策略 |
|---|---|---|---|
| 作品同步 | `handleSyncWorks` 用 `sendToTab` 回调 + `sendResponse` 立即返回 | `startSync` 中 await bgMsg 返回后立即拿到 `#requestId` | onSyncProgress 直接 `msg.requestId !== this.getRequestId()` |
| 关注同步 | `sendToTab` 直接把 `sendResponse` 传入 `chrome.tabs.sendMessage` 回调 | 等 fetch 完成后才拿到 `#followingsRequestId` | onFollowingProgress 必须兼容 `null`：`this.#followingsRequestId !== null && msg.requestId !== this.#followingsRequestId` |

### 进度回传
```
inject dispatch DY_FOLLOWING_PROGRESS
→ content forwardEvent('FOLLOWING_PROGRESS')
→ background registerProgressForwarder
→ options chrome.runtime.onMessage → sync.onFollowingProgress()
```

## 3. 扫描点赞/收藏机制

两个流程高度相似，共用 `Favorites.openScanDialog(cfg)`，通过 cfg 参数驱动差异。

### 点赞（`options.js:3035`）
```js
favorites.openScanDialog({
  title: '扫描点赞',
  stateKey: 'favoriteWorks',          // state.favoriteWorks
  fetchingKey: 'favoriteFetching',    // state.favoriteFetching
  requestIdKey: 'favRequestId',       // state.favRequestId
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

### 收藏（`options.js:3050`）
```js
favorites.openScanDialog({
  title: '扫描收藏',
  stateKey: 'collectionWorks',
  fetchingKey: 'collectionFetching',
  requestIdKey: 'collectionRequestId', // 注意：是 collectionRequestId，不是 colRequestId
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

### inject.js 抓取差异

| 项 | 点赞（`fetchFavoriteWorks`） | 收藏（`fetchCollectionWorks`） |
|---|---|---|
| API | `/aweme/v1/web/aweme/favorite/` | `/aweme/v1/web/aweme/listcollection/` |
| method | GET | POST |
| headers | 仅 Referer | `content-type: COLLECTION_CONTENT_TYPE` |
| cursorKey | `'max_cursor'` | `'cursor'` |
| extractCursor | `data.cursor \|\| data.max_cursor \|\| (cur + 18)` | 同左 |
| transformAwemeItem | `includeAuthorFollowed: true` | `includeAuthorFollowed: true` |
| 进度事件 | `EVENTS.FAVORITES_PROGRESS` | `EVENTS.COLLECTION_PROGRESS` |

两者都使用 `paginatedFetcher`，签名取 `stripPageKeys(__capturedFavoriteQuery || __capturedPostQuery || __capturedFollowingQuery)`（收藏取 collection 优先）。

### paginatedFetcher 工作流程
- 循环：`while (hasMore && retries < CONFIG.RETRY.MAX)`
- 构建 URL + 合并签名
- `origFetch` 请求，超时 15s（`CONFIG.TIMEOUT.FETCH_PAGE`）
- 提取作品列表和 hasMore
- 去重：`seenIds` Set
- cursor 更新，若不变则终止
- 页间延迟 300-400ms（`CONFIG.PAGE.DELAY_MIN`/`DELAY_MAX`）
- 重试延迟 2000ms（`CONFIG.RETRY.PAGINATION`）
- 进度事件发送增量 `newWorks`（仅新采集的作品）+ 预计算 `unfollowedCount`，不再发送全量 works 数组

## 4. 取消点赞/收藏机制

### 触发
```js
targets = state[cfg.stateKey].filter(w => w.authorFollowed === false);
ids = targets.map(w => w.awemeId);
services.bgMsg({ type: cfg.cancelType, awemeIds: ids });
```

### background.js → content.js → inject.js
```js
sendToTab('CANCEL_LIKE', { awemeIds, timeout: 120000 })    // 或 CANCEL_COLLECTION
requestResponse('DY_CANCEL_LIKE_REQUEST', 'DY_CANCEL_LIKE_COMPLETE', 120000)
```

### runCancelLoop（inject.js）
```js
const xhr = new XMLHttpRequest();
xhr.open('POST', url);
xhr.withCredentials = true;
xhr.setRequestHeader('content-type', CONFIG.CANCEL_CONTENT_TYPE);
xhr.setRequestHeader('Referer', window.location.origin + '/');
const key = getSecurityKey();  // 每次 XHR 前重读
if (key) xhr.setRequestHeader('bd-ticket-guard-ree-public-key', key);
xhr.send(bodyFn(ids[i]));
```

**为什么用 XHR 而非 fetch**：抖音的 a_bogus 签名绑定在 XHR 原型链上。

### 点赞 vs 收藏参数对比

| 项 | 取消点赞 | 取消收藏 |
|---|---|---|
| URL | `https://www.douyin.com/aweme/v1/web/commit/item/digg/?aid=6383` | `https://www.douyin.com/aweme/v1/web/aweme/collect/?aid=6383` |
| Body | `aweme_id=${id}&item_type=0&type=0` | `action=0&aweme_id=${id}&aweme_type=0` |
| Referrer | `https://www.douyin.com/user/self?showTab=like` | `https://www.douyin.com/user/self?showTab=favorite_collection` |
| ContentType | `application/x-www-form-urlencoded; charset=UTF-8` | 同左 |
| bd-ticket-guard 公钥 | `getSecurityKey()`（每次请求前重读） | 同左 |
| 请求间延迟 | 800-1200ms 随机 | 同左 |
| 错误处理 | 任一失败立即退出整个流程 | 同左 |

**AUTH_FAILED 提示**：`options.js:1599-1604` 检测到 `cancelRes.error.includes('AUTH_FAILED')` 时，弹出 toast「密钥已过期，请刷新抖音页面后重试」。

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
`sendToTab('FETCH_WORKS_PAGE', { secUid, cursor, timeout: 60000 })`（60s，因为是单页请求）

### inject.js 抓取（`fetchAuthorWorks(secUid, startCursor)`）
- **API**：`/aweme/v1/web/aweme/post/`
- **参数**：`sec_user_id, max_cursor, count(18), DEVICE_PARAMS`
- **签名合并**：`mergeParams(url, __capturedPostQuery || __capturedFollowingQuery)`
- **重试**：最多 3 次，延迟 2000ms（`CONFIG.RETRY.AUTHOR`）
