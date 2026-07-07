# 同步与扫描机制

> 本文档描述所有长耗时任务（作品同步、关注同步、点赞/收藏扫描、取消点赞/收藏、作者主页分页）的完整链路、时序差异与分页参数。

## 1. 同步作品

**链路**：`options.js:sync.syncCurrentGroup()` → `SYNC_WORKS` → background.js `handleSyncWorks` → 逐条 `sendToTabAsync('FETCH_SINGLE_WORK')` → inject.js `fetchOneDetail`

**循环**：
- 逐作品 for 循环，页间延迟 500–1200ms
- 每完成 40 条后暂停 10–20s（`CONFIG.SYNC.BATCH_SIZE`），暂停期间每 2s 调用 `chrome.storage.local.get` 保活 SW
- 检查 `cancelled` 标志，循环结束调用 `mergeAndSaveWorks(allWorks)` 写入存储

**错误分类**：

| 类别 | 错误 | 处理 |
|------|------|------|
| 致命 | `NO_DOUYIN_TAB`, `TAB_QUERY_FAILED`, `NO_LISTENER`, `EMPTY_RESPONSE`, `RATE_LIMITED`, `CANCELLED`, HTTP 401/429 | 终止整个批次 |
| 非致命 | `TIMEOUT`, HTTP 403/5xx, `status_code`, 网络异常 | 跳过该作品继续 |

## 2. 同步关注

**链路**：`sync.syncFollowings()` → `services.findSecUid()` → `FETCH_FOLLOWING` → background.js `handleFetchFollowing` → 逐页 `sendToTabAsync('FETCH_FOLLOWING_PAGE')` → inject.js `fetchFollowingPage`

**循环**：逐页 for 循环，`offset` 分页，延迟 500–1200ms。标准化为 5 字段 `{ uid, nickname, avatarLarger, followerCount, profileUrl }`。最终调用 `handleSaveFollowings` 写入存储。

## 3. 扫描点赞/收藏

共用 `Favorites.openScanDialog(cfg)`，通过 cfg 参数驱动差异：

| 项 | 点赞 | 收藏 |
|----|------|------|
| background handler | `handleFetchFavorites` | `handleFetchCollection` |
| 转发消息 | `FETCH_FAVORITES_PAGE` | `FETCH_COLLECTION_PAGE` |
| 进度消息 | `FAVORITES_PROGRESS` | `COLLECTION_PROGRESS` |
| 端点 | `/aweme/favorite/` GET | `/aweme/listcollection/` POST |
| 分页 | `max_cursor`, `count` | `cursor`, `count` |
| 签名来源 | `__capturedFavoriteQuery` | `__capturedCollectionQuery` |
| 超时 | 15s | 15s |
| 独立模式 | 不支持（Turing 验证） | ✅ 支持 |

**openScanDialog 流程**：`services.findSecUid()` → `services.bgMsg(fetchArgs)` → 收到结果存入 `state[cfg.stateKey]` → `#renderGrid()` 渲染未关注作品网格 → 添加取消按钮。

## 4. 取消点赞/收藏

### Tab 模式（inject.js XHR）

逐条 `sendToTabAsync('CANCEL_ONE_LIKE' / 'CANCEL_ONE_COLLECTION')` → inject.js `cancelOne()` 使用 XHR（抖音 a_bogus 签名绑定 XHR 原型链）。单条超时 30s。

| 项 | 取消点赞 | 取消收藏 |
|----|---------|---------|
| URL | `/commit/item/digg/?aid=6383` | `/aweme/collect/?aid=6383` |
| Body | `aweme_id=${id}&item_type=0&type=0` | `action=0&aweme_id=${id}&aweme_type=0` |
| Referer | `/user/self?showTab=like` | `/user/self?showTab=favorite_collection` |
| 密钥头 | `bd-ticket-guard-ree-public-key: getSecurityKey()` | 同左 |

XHR 失败不中断，记入 `failedAwemeIds`。`CANCEL_PROGRESS` 每条完成后发送，`CANCEL_DONE` 批次完成发送。

### 独立模式

`handleIndependentCancel()` 在 background 内直接循环 POST。差异：

| 维度 | Tab 模式 (XHR) | 独立模式 (fetch) |
|------|---------------|-----------------|
| 网络引擎 | `XMLHttpRequest` | `fetch()` |
| Referer | JS 可直接设置 | forbidden header，靠 DNR rules 5/6 注入 |
| 密钥 | `getSecurityKey()` 从 localStorage | `browserFeatures.securityKey`（需事先捕获） |
| 取消信号 | 经 content→inject | 直接在 background 取消循环 |

## 5. 作者主页作品分页

**触发**：侧边栏滚动到距底部 100px 内 → `#loadMoreWorks()` → `FETCH_WORKS_PAGE` → `/aweme/v1/web/aweme/post/`（参数 `sec_user_id, max_cursor, count`）。守卫条件：`sidebarLoading || !sidebarCursor || !currentFollowingSecUid`。结果追加到 DOM，若内容不足容器则递归加载。

**超时分级**：
- Tab 模式：`sendToTab` 30s 超时 + content.js `requestResponse` 60s 兜底
- 独立模式：`independentRequest` 单层超时

## 6. Service Worker 保活

作品同步批次暂停（10–20s）是唯一可能触发 SW 终止的长空闲窗口。`KEEPALIVE_INTERVAL=2000` 控制保活：暂停拆分为 2s 分段，每段结束后调用 `chrome.storage.local.get` 重置空闲计时器。其余循环每次延迟前均有 `chrome.*` API 调用，无需额外处理。