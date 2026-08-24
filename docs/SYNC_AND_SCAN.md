# 同步与扫描机制

> 本文档描述所有长耗时任务（作品同步、关注同步、点赞/收藏扫描、取消点赞/收藏、作者主页分页）的完整链路、时序差异与分页参数。

## 1. 同步作品

**链路**：`options.js:sync.syncCurrentGroup()` → `SYNC_WORKS` → background.js `handleSyncWorks` → 逐条 `sendToTabAsync('FETCH_SINGLE_WORK')` → inject.js `fetchOneDetail`

**循环**：
- 逐作品 for 循环，页间延迟 500–1200ms
- 每完成 40 条后暂停 10–20s（`CONFIG.SYNC.BATCH_SIZE`），暂停期间每 2s 调用 `chrome.storage.local.get` 保活 SW
- 检查 `cancelled` 标志，循环结束调用 `mergeAndSaveWorks(allWorks)` 写入存储

**视频直链时效**：tab 模式链路的实际取链点是 inject.js `extractVideo`（api 源，由 `normalizeWork` 调用并带出 `videoExpireAt`），与独立模式 background.js `formatWork` **同款三级优先取链接（两处实现需同步修改）**——① `bit_rate[].playApi`（与推荐页手动"添加"按钮同款的长效 ID 型播放链接，`/aweme/v1/play/?video_id=…`）；② 无 playApi 时用最高清档 `play_addr.uri` 合成同形态裸链接（实测服务端认可，访问即 302 到新签 douyinvod 直链，参数仅需 `video_id/aid/is_play_url/line`）；③ 前两者皆缺时回落 CDN `url_list` 预签名直链（**短效**，几小时过期；部分直链过期时间藏在路径段 `/<sig>/<8位hex过期秒>` 而非 query 的 `expire`）。长效作为整体类目优先于 CDN，只在同类内部比分辨率，禁止改回"混池按最高分辨率挑选"——最高清档恰好缺 playApi 时会把短效直链存进库。前两级 `videoExpireAt = 0`（长效），第③级解析 `expire` 参数写入（inject 与 background 各有一份同款 `parseExpire`/`urlExpireAt`）。fiber 源分支有意不同：只认 playApi、无 url_list 回退、仅留最高一档。另：`mergeWork` 有降级保护——旧记录已是长效 v1/play 链接而新结果为短效 CDN 直链时不覆盖。

**错误分类**：

| 类别   | 错误                                                                                                            | 处理           |
|--------|-----------------------------------------------------------------------------------------------------------------|----------------|
| 致命   | `NO_DOUYIN_TAB`, `TAB_QUERY_FAILED`, `NO_LISTENER`, `EMPTY_RESPONSE`, `RATE_LIMITED`, `CANCELLED`, HTTP 401/429 | 终止整个批次   |
| 非致命 | `TIMEOUT`, HTTP 403/5xx, `status_code`, 网络异常                                                                | 跳过该作品继续 |

## 2. 同步关注

**链路**：`sync.syncFollowings()` → `services.findSecUid()` → `FETCH_FOLLOWING` → background.js `handleFetchFollowing` → 逐页 `sendToTabAsync('FETCH_FOLLOWING_PAGE')` → inject.js `fetchFollowingPage`

**循环**：逐页 for 循环，`offset` 分页，延迟 500–1200ms。标准化为 6 字段 `{ uid, nickname, avatarLarger, followerCount, awemeCount, profileUrl }`。**列表阶段不采集 `followerCount`/`awemeCount`**（关注列表接口的计数是滞后快照，常与主页展示差很远，两字段占位为 0）；二者仅由 profile/other 校准写入。

**校准阶段**：列表收集完成后（未取消且非空），background 调用 `calibrateFollowingStats(list, fetchStats, isCancelled, requestId)` 逐用户请求 `GET /aweme/v1/web/user/profile/other/?sec_user_id=…`，用返回的 `user.aweme_count`/`user.follower_count` 原地覆盖条目，再随整体结果交给 options 走既有 `handleSaveFollowings` 落库。要点：

- sec_uid 从 `entry.profileUrl` 反解（存储仍是 6 字段，不新增字段）
- 单条失败静默跳过保留旧值；全部失败不影响同步结果
- 条目间延迟 500–1200ms；取消复用 `CANCEL_ACTIVE_TASK` 链路（inject 端 `setActiveTask` 中止在途 fetch）
- 进度经 `FOLLOWING_PROGRESS { phase: "calibrate", collected, total, requestId }` 透传，options 端文案切「正在校准作品数…」
- 整个校准阶段受运行参数 `calibrateFollowings` 门控（设置弹窗「运行参数 → 同步关注后校准作品/粉丝数」开关，默认开启）
- `fetchStats` 按模式注入：tab 模式 `sendToTabAsync('FETCH_USER_PROFILE')` → inject.js `fetchProfileOther`（签名源多源 fallback：profile/following/post/favorite/collection 任一捕获 query）；独立模式直接 `independentRequest(CONFIG.API.PROFILE_OTHER, …)`（a_bogus 本地生成，无 webSign）

**侧边栏单用户校准**：打开作者侧边栏（`Sidebar.openSidebar`）时另发一次 `CALIBRATE_FOLLOWING { uid, secUid }`（不受上述开关门控），background 按模式取 profile/other 后直接写存储并返回计数，options 端更新 `state.followings` 与可见卡片 DOM；失败静默忽略。

## 3. 扫描点赞/收藏

共用 `Favorites.openScanDialog(cfg)`，通过 cfg 参数驱动差异：

| 项                 | 点赞                      | 收藏                          |
|--------------------|---------------------------|-------------------------------|
| background handler | `handleFetchFavorites`    | `handleFetchCollection`       |
| 转发消息           | `FETCH_FAVORITES_PAGE`    | `FETCH_COLLECTION_PAGE`       |
| 进度消息           | `FAVORITES_PROGRESS`      | `COLLECTION_PROGRESS`         |
| 端点               | `/aweme/favorite/` GET    | `/aweme/listcollection/` POST |
| 分页               | `max_cursor`, `count`     | `cursor`, `count`             |
| 签名来源           | `__capturedFavoriteQuery` | `__capturedCollectionQuery`   |
| 超时               | 15s                       | 15s                           |
| 独立模式           | 不支持（Turing 验证）     | ✅ 支持                       |

**openScanDialog 流程**：`services.findSecUid()` → `services.bgMsg(fetchArgs)` → 收到结果存入 `state[cfg.stateKey]` → `#renderGrid()` 渲染未关注作品网格 → footer 添加「添加」与「取消点赞/收藏」两个按钮。「添加」= 把未关注作者的作品（`authorFollowed === false`，与取消同批 targets）经 `SAVE_WORKS` 批量入扩展作品库：`mergeWork` 按 awemeId 去重合并、新记录落默认"未分类"分组；已入账的 awemeId 在弹窗会话内记入 `addedIds` 集合不重复计数，成功后按钮进入"已添加"态。取消进行中添加按钮禁用，`onCancelDone` 三个出口（中止/全失败/正常完成）经 `ctx.syncAddBtn` 按剩余数量恢复或刷新。「取消」= 同批 targets 走下述取消链路。

**失败处理**：tab 模式下当 `secUid === "self"`（用户在 `/user/self` 页面）时，inject.js 通过 `resolveSelfSecUidFromCaptures()` 从捕获的签名参数（`sec_user_id`）解析真实 sec_uid——与签名同源，签名缓存存在则必然可解析；签名缓存缺失时 inject.js 直接返回 `NO_SIGNATURE`（options 弹引导对话框）；首页请求失败时 background 返回 `{ ok: false, error }` 而非假成功（0 结果），避免弹窗显示"已扫描 0 个"误导结论。

## 4. 取消点赞/收藏

### Tab 模式（inject.js XHR）

逐条 `sendToTabAsync('CANCEL_ONE_LIKE' / 'CANCEL_ONE_COLLECTION')` → inject.js `cancelOne()` 使用 XHR（抖音 a_bogus 签名绑定 XHR 原型链）。单条超时 30s。

| 项      | 取消点赞                                           | 取消收藏                                 |
|---------|----------------------------------------------------|------------------------------------------|
| URL     | `/commit/item/digg/?aid=6383`                      | `/aweme/collect/?aid=6383`               |
| Body    | `aweme_id=${id}&item_type=0&type=0`                | `action=0&aweme_id=${id}&aweme_type=0`   |
| Referer | `/user/self?showTab=like`                          | `/user/self?showTab=favorite_collection` |
| 密钥头  | `bd-ticket-guard-ree-public-key: getSecurityKey()` | 同左                                     |

XHR 失败不中断，记入 `failedAwemeIds`。`CANCEL_PROGRESS` 每条完成后发送，`CANCEL_DONE` 批次完成发送。

### 独立模式

`handleIndependentCancel()` 在 background 内直接循环 POST。差异：

| 维度     | Tab 模式 (XHR)                     | 独立模式 (fetch)                            |
|----------|------------------------------------|---------------------------------------------|
| 网络引擎 | `XMLHttpRequest`                   | `fetch()`                                   |
| Referer  | JS 可直接设置                      | forbidden header，靠 DNR rules 5/6 注入     |
| 密钥     | `getSecurityKey()` 从 localStorage | `browserFeatures.securityKey`（需事先捕获） |
| 取消信号 | 经 content→inject                  | 直接在 background 取消循环                  |

## 5. 作者主页作品分页

**触发**：侧边栏滚动到距底部 100px 内 → `#loadMoreWorks()` → `FETCH_WORKS_PAGE` → `/aweme/v1/web/aweme/post/`（参数 `sec_user_id, max_cursor, count`）。守卫条件：`sidebarLoading || !sidebarCursor || !currentFollowingSecUid`。结果追加到 DOM，若内容不足容器则递归加载。

**超时分级**：
- Tab 模式：`sendToTab` 30s 超时 + content.js `requestResponse` 60s 兜底
- 独立模式：`independentRequest` 单层超时

## 6. Service Worker 保活

作品同步批次暂停（10–20s）是唯一可能触发 SW 终止的长空闲窗口。`KEEPALIVE_INTERVAL=2000` 控制保活：暂停拆分为 2s 分段，每段结束后调用 `chrome.storage.local.get` 重置空闲计时器。其余循环每次延迟前均有 `chrome.*` API 调用，无需额外处理。