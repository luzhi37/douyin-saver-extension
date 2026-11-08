# 04 · 独立模式（逆向）— 作者域校准（关注 / 候选）

> 职责边界：作者域（关注 `followings` / 候选 `candidates`）的计数（`awemeCount`/`followerCount`）、**档案字段**（`nickname`/`avatarLarger`）与**最近更新日期**（`lastUpdateAt`）的**校准写入机制**——批量校准（工具弹窗手动触发，逐用户请求 profile/other + 作品第一页）与单用户校准（打开作者侧边栏触发）。两流程均按模式分支取数，本文以独立模式为主线、Tab 模式对照。列表采集阶段为何占位 0 见 [03](./03-independent-sync-followings.md)。**同步关注列表与校准已彻底分离**：`FETCH_FOLLOWING` 收集完成后不再自动校准，校准只能手动发起；候选域无账号同步源，校准消息为 `CALIBRATE_CANDIDATE` / `CALIBRATE_CANDIDATES`。

## 概述

关注列表接口返回的粉丝/作品计数是**滞后快照**（与主页展示差异大），因此全仓约定：列表采集一律占位 0，权威计数只从 `GET /aweme/v1/web/user/profile/other/?sec_user_id=…` 的 `user.aweme_count / user.follower_count` 获取。同名接口的 `user.nickname / user.avatar_larger` 同样是**档案权威值**——列表接口下发的昵称/头像是列表快照，**改名只能靠校准收口**（同步链路不逐个拉 profile，故同步后昵称仍可能是旧名）；校准取到非空值即覆盖 `nickname`/`avatarLarger`，空值保留旧值（取数失败不破坏档案）。`lastUpdateAt`（最近更新日期，毫秒时间戳）由校准阶段写入（导入快照 >0 时也按快照写入，见 [10](./10-storage-write-and-import.md)）——来源为**该关注者作品列表第一页全部作品 `create_time` 的最大值**（`GET /aweme/v1/web/aweme/post/`，`max_cursor=0`，秒 → 毫秒换算），未校准占位 0。校准有两条入口：

1. **批量校准**（`scanTasks.calibrateAll(domain)`）：options「工具」弹窗两个按钮手动发起，关注域消息 `CALIBRATE_FOLLOWINGS`、候选域消息 `CALIBRATE_CANDIDATES`；对**该域全部已存作者**逐个重取权威计数；进度以 `CALIBRATE_PROGRESS { domain, phase:"calibrate" }` 透传；收尾整批 `mergeAndSaveAuthors` 落库（0 值保护）。
2. **单用户校准**（`scanTasks.calibrateOne(uid, secUid, domain)`）：options 打开作者侧边栏时按当前域发 `CALIBRATE_FOLLOWING` / `CALIBRATE_CANDIDATE { uid, secUid }`；background 取到计数后**直接落库**并返回，options 更新对应域 state 与可见卡片 DOM。

两条入口的 `fetchStats` 都按模式注入：

- Tab模式：`tabBridge.sendAsync("FETCH_PROFILE_OTHER")` → inject `fetchProfileOther`；
- 独立模式：`independentClient.request(CONFIG.API.PROFILE_OTHER, credentials.buildBaseParams({ sec_user_id }))` 直接 GET。

## 核心流程图（文字描述）

### 批量校准（工具弹窗手动触发）

```
options AuthorImport.startCalibrate（三链路互斥守卫 → CANCEL_ACTIVE_TASK 清残留 → 进度层）
  → bgMsg({ type: domain === "candidates" ? "CALIBRATE_CANDIDATES" : "CALIBRATE_FOLLOWINGS" })
    → background scanTasks.calibrateAll(domain, sendResponse)
        all ← Object.values(storage.getAll(domain))   // getAll 返回 { uid: record } 映射
        all.length === 0 → { ok:false, error:"EMPTY" }
        guard ← utils.withCancelGuard()   // 进度层关闭联动的 CANCEL_ACTIVE_TASK 中断循环
        → calibrateStats(list, fetchStats, isCancelled, requestId, "CALIBRATE_PROGRESS", domain)
            for entry of list（&& !isCancelled()）:
              sec_uid ← String(entry.profileUrl).match(/\/user\/([^/?#]+)/)[1]
              try: stats = await fetchStats(sec_uid)
                   entry.awemeCount = stats.awemeCount
                   entry.followerCount = stats.followerCount
                   if (stats.nickname)     entry.nickname = stats.nickname        // 档案字段：非空才覆盖
                   if (stats.avatarLarger) entry.avatarLarger = stats.avatarLarger
              catch: 静默跳过（保留旧值）
              try: t = await fetchLatestWorkTime(sec_uid)      // 作品第一页 max(create_time)
                   if (t) entry.lastUpdateAt = t               // 失败/全 0 静默跳过保留旧值
              catch: 静默跳过
              sendMessage(CALIBRATE_PROGRESS { domain, phase:"calibrate", collected:++processed,
                                                total:list.length, hasMore:false, requestId })
              条目间延迟 syncFollowings MIN~MAX ms
            返回 processed（取消时 < list.length）
        guard.dispose()
        → mergeAndSaveAuthors(domain, all)   // 0 值保护：取数失败保留旧计数、分组保留
        changed > 0 → 广播 STORE_CHANGED { domain }
        → sendResponse({ ok:true, requestId, cancelled, total, processed, updated, changed })

fetchStats 注入（scanTasks 私有 #fetchProfileUser，双模自治）：
  独立模式：independentClient.request(API.PROFILE_OTHER, …)
            data.user 缺失 → throw "PROFILE_FETCH_FAILED"
  Tab模式：  tabBridge.sendAsync("FETCH_PROFILE_OTHER", { secUid })
            !resp.ok → throw resp.error || "PROFILE_FETCH_FAILED"

fetchLatestWorkTime 注入（scanTasks 私有方法 #fetchLatestWorkTime，两模式分支取作品第一页）：
  独立模式：independentClient.request(API.POST, credentials.buildBaseParams({ sec_user_id, max_cursor:"0", count:PAGE.POST }))
            → data.aweme_list → formatWork 归一化 → max createTime
  Tab模式：  tabBridge.sendAsync("FETCH_WORKS_PAGE", { secUid, cursor:"", count:PAGE.POST, timeout })
            → resp.works → max createTime
  返回 max × 1000（毫秒）；无作品/全 0 返回 0
```

### 单用户校准（侧边栏打开即触发）

```
options Sidebar.openSidebar(following)
  → #calibrateFollowing(following)：secUid = state.currentAuthorSecUid
  → bgMsg({ type:"CALIBRATE_FOLLOWING", uid, secUid })
    → background scanTasks.calibrateOne(uid, secUid, sendResponse)
        ├─ 参数缺失 → { ok:false, error:"BAD_PARAMS" }
        ├─ independentClient.loadMode()
        │   ├─ true：credentials.ensureABogus → independentClient.request(PROFILE_OTHER, { sec_user_id })
        │   │        data.user 缺失 → throw PROFILE_FETCH_FAILED
        │   └─ false：tabBridge.sendAsync("FETCH_PROFILE_OTHER", { secUid })
        ├─ ds.get(String(uid)) 无记录 → { ok:false, error:"NOT_FOUND" }
        ├─ record.awemeCount/followerCount ← stats
        ├─ record.nickname/avatarLarger ← stats（非空才覆盖，空值保留旧值）
        ├─ record.lastUpdateAt ← fetchLatestWorkTime(secUid) || record.lastUpdateAt || 0   // 失败保留旧值
        ├─ ds.putBatch([record])   // 直接落库
        └─ sendResponse({ ok:true, awemeCount, followerCount, nickname, avatarLarger, lastUpdateAt })
  → options：更新 state.followings 对应条目（含 nickname/avatarLarger）
    命中 [data-uid] 卡片时走当前域 AuthorGrid.fillCard 整体重填
    （昵称/头像/统计/最近更新一并刷新，头像经探针管线）
    失败静默忽略（不影响作品加载）
```

## 接口 / 方法签名

```js
// background/tasks/scan-tasks.js —— 批量迭代器（纯内存改写，不落库；写回发生在调用方的落库路径上）
async function scanTasks.calibrateStats(list, fetchStats, isCancelled, requestId, progressType, domain)
// list: Following[]（原地改写 awemeCount/followerCount/nickname/avatarLarger/lastUpdateAt）
// fetchStats: (secUid) => Promise<{ awemeCount, followerCount, nickname, avatarLarger }>（空字符串 = 未取到，调用方保留旧值）
// isCancelled: () => boolean
// 返回：实际处理条数（取消时 < list.length）
// 进度：type 由 progressType 决定（当前唯一调用方 calibrateAll 传 "CALIBRATE_PROGRESS"），
//      载荷 { phase:"calibrate", collected, total, hasMore:false, requestId }

async function scanTasks.calibrateAll(domain, sendResponse)
// 工具弹窗批量校准：getAll(domain) → calibrateStats → mergeAndSaveAuthors（0 值保护）→ changed>0 广播 STORE_CHANGED
// 出参：{ ok:true, requestId, cancelled, total, processed, updated, changed }
//     | { ok:false, error:"EMPTY"|其他 }

async function scanTasks.calibrateOne(uid, secUid, domain, sendResponse)
// 出参：{ ok:true, awemeCount, followerCount, nickname, avatarLarger, lastUpdateAt }
//     | { ok:false, error:"BAD_PARAMS"|"NOT_FOUND"|其他 }

async #fetchLatestWorkTime(secUid) -> Promise<number>
// 最近更新日期采集（毫秒）：作品列表第一页 max(create_time)×1000；失败返回 0 由调用方静默保留旧值；无作品/全 0 → 0
// 独立模式：复用 independentTasks.fetchWorksPage 首页取数（同端点同参数，避免第二份实现）
// Tab 模式：tabBridge.sendAsync("FETCH_WORKS_PAGE", { secUid, cursor:"", count:PAGE.POST, timeout })

independentClient.request(CONFIG.API.PROFILE_OTHER, params)   // GET，a_bogus + webSign（request 默认叠加）
```

```js
// options/components/sidebar.js —— 侧边栏触发点（Sidebar 私有方法）
async #calibrateFollowing(following)
// bgMsg CALIBRATE_FOLLOWING → 成功后更新 state 条目（计数 + 非空 nickname/avatarLarger）
// + 命中 [data-uid] 卡片时当前域 AuthorGrid 实例（followingsGrid / candidatesGrid）.fillCard 整体重填
```

Tab 模式对照：inject 端 `fetchProfileOther({ secUid })`（或 `{ uid }` 走数字 uid 分支）的签名源为多源 fallback——`signatureCapture.profileQuery || signatureCapture.followingQuery || signatureCapture.postQuery || signatureCapture.favoriteQuery || signatureCapture.collectionQuery`，经 `stripSdkKeys`（剥签名键）+ `stripPageKeys`（剥分页键）合并后走 `window.fetch(_dyInternal:true)`，签名由页面包装器代签；全部为空时事件层直接回 `NO_SIGNATURE`。fallback 链每环都必须剥签名键——profile/other 已被强制 Argus webSign 校验，任一来源带入的旧 `x-secsdk-web-signature` 都会导致包装器跳过重签而被 Argus 拒绝（见 09 签名策略节）。uid 分支合并前还必须删除捕获源里的 `sec_user_id`（反之亦然），避免一次请求同时带两个用户标识。

## 关键代码片段

### sec_uid 反解与静默跳过

```js
for (const entry of list) {
  if (isCancelled()) break;
  processed += 1;
  const m = String(entry.profileUrl || "").match(/\/user\/([^/?#]+)/);
  if (m && m[1]) {
    try {
      const stats = await fetchStats(m[1]);
      entry.awemeCount = stats.awemeCount;       // 原地覆盖，存储仍是 7 字段，不新增字段
      entry.followerCount = stats.followerCount;
      if (stats.nickname) entry.nickname = stats.nickname;            // 档案字段：列表快照 → profile 权威值
      if (stats.avatarLarger) entry.avatarLarger = stats.avatarLarger; // 非空才覆盖，空值保留旧值
    } catch (_e) {}                              // 单条失败静默跳过保留旧值；全部失败不影响同步结果
    try {
      const t = await this.#fetchLatestWorkTime(m[1]);
      if (t) entry.lastUpdateAt = t;             // 作品第一页 max(create_time)；失败/全 0 静默保留旧值
    } catch (_e) {}
  }
  // CALIBRATE_PROGRESS { phase:"calibrate" } …（options 端工具弹窗进度层计数「已校准作者 X / Y」）
}
```

### 字段写入策略（SAVE_FOLLOWINGS 侧的配套规则）

```js
// 常规列表同步携带的 0 不覆盖已校准旧值；校准结果/导入快照 >0 时正常写入
followerCount: f.followerCount > 0 ? f.followerCount : old?.followerCount || 0,
awemeCount:    f.awemeCount    > 0 ? f.awemeCount    : old?.awemeCount    || 0,
lastUpdateAt:  f.lastUpdateAt  > 0 ? f.lastUpdateAt  : old?.lastUpdateAt  || 0,   // 常规同步携带 0，不覆盖已校准值
// nickname/avatarLarger 无 0 值保护：合并按 ...f 展开直写——同步带入列表快照、校准带入 profile 权威值，
// 空值由校准迭代器写入前置守卫拦下（记录字段恒有值）
```

## 链接拼装实例（真实数据走查）

> 样本取自扩展「导出数据」功能落盘的真实库快照。会话敏感值以 `<webid>` 等占位。

### 第一步：从库内记录反解 sec_uid

校准不新增请求参数字段——sec_uid 就藏在每条 Following 记录的 profileUrl 路径里：

```text
entry.profileUrl = https://www.douyin.com/user/MS4wLjABAAAARrc8YjQCd8-nzW0qad8Nu4fghV0ouiLKKuUm107nj1DEGGW1NQ2qmpotMdNQb667
正则 /\/user\/([^/?#]+)/ → sec_uid = MS4wLjABAAAARrc8…NQb667
```

### 第二步：拼装单条请求

业务键只有一个 `sec_user_id`，排在环境参数全集之后、msToken/a_bogus 之前（键序规则同 [03](./03-independent-sync-followings.md)）：

```text
GET https://www.douyin.com/aweme/v1/web/user/profile/other/
    ?device_platform=webapp&aid=6383&channel=channel_pc_web&…&webid=<webid>
     &uifid=<uifid>&odin_tt=<odin_tt>
     &sec_user_id=MS4wLjABAAAARrc8YjQCd8-nzW0qad8Nu4fghV0ouiLKKuUm107nj1DEGGW1NQ2qmpotMdNQb667
     &msToken=<msToken>&a_bogus=<a_bogus>
```

无分页、无游标：一次请求即该用户的权威计数**与档案（昵称/头像）**。批量校准就是对本域全部条目逐条发这个请求（条目间延迟复用 syncFollowings 档）。

同一用户另发**作品第一页请求**采集最近更新日期（同一循环内、profile 之后）：

```text
GET https://www.douyin.com/aweme/v1/web/aweme/post/
    ?device_platform=webapp&aid=6383&…&sec_user_id=MS4wLjABAAAARrc8…
     &max_cursor=0&count=20&msToken=<msToken>&a_bogus=<a_bogus>
```

响应 `aweme_list[]`（经 `formatWork` 归一化后含 `createTime` 秒级时间戳）取 `max(create_time) × 1000` 写入 `lastUpdateAt`。Tab 模式对照：inject `fetchAuthorWorks` 以同一 URL 分页请求，background 经 `tabBridge.sendAsync("FETCH_WORKS_PAGE", { secUid, cursor:"" })` 取第一页。

### 第三步：响应取数与真实对照

```jsonc
{
  "user": {
    "sec_uid": "MS4wLjABAAAARrc8…",
    "nickname": "双一",
    "aweme_count": 142,        // → entry.awemeCount
    "follower_count": 414445   // → entry.followerCount
  }
}
```

`data.user` 缺失即抛 `PROFILE_FETCH_FAILED`；批量路径 catch 静默跳过保留占位 0。落库后导出可见真实对照：双一 `followerCount=414445` / `awemeCount=142`——这两个值只可能来自本端点（列表接口从不采集）。

Tab 模式对照：同一 URL 由 inject `fetchProfileOther` 以 DEVICE_PARAMS + 多源捕获 query 拼出，页面包装器代签。

## 异常场景及处理

| 场景 | 表现 | 处理 |
|------|------|------|
| 单用户 profile/other 失败（网络/403/API_ERROR） | fetchStats 抛错 | 批量：catch 静默跳过，该条保持占位 0；单用户：`{ ok:false, error }`，options 静默忽略 |
| 作品第一页获取失败（网络/403/无作品/全 0 create_time） | #fetchLatestWorkTime 抛错或返回 0 | 批量：catch 静默跳过保留旧值；单用户：`record.lastUpdateAt` 保留旧值，响应仍返回当前值 |
| profileUrl 缺失或无 sec_uid 段 | 正则不匹配 | 跳过该条（不发请求），进度照常推进 |
| uid 不在库中（侧边栏场景数据已变） | `{ ok:false, error:"NOT_FOUND" }` | options 忽略 |
| 校准期间用户取消/关进度层 | `CANCEL_ACTIVE_TASK` | isCancelled() 在条目边界生效；在途请求由各自模式的取消链路中止；已校准部分随 mergeAndSaveAuthors 落库 |
| 关注域为空 | `{ ok:false, error:"EMPTY" }` | 工具弹窗 toast 报错 |

## 配置项说明

| 配置 | 默认 | 作用 |
|------|------|------|
| `runtimeConfig.syncFollowingsDelayMin/Max` | 500/1000ms | 校准条目间延迟 |
| `runtimeConfig.timeoutRequest` | 30000ms | profile/other 与作品第一页单请求超时（独立模式）；Tab 模式经 FETCH_PROFILE_OTHER / FETCH_WORKS_PAGE 的 msg.timeout |
| `CONFIG.API.PROFILE_OTHER` | `/aweme/v1/web/user/profile/other/` | 权威计数端点（逐用户、无分页） |
| `CONFIG.API.POST` | `/aweme/v1/web/aweme/post/` | lastUpdateAt 采集端点（作品第一页，`max_cursor=0`）；页大小 `CONFIG.PAGE.POST`（20） |

## 相关文档

| 编号 | 文档 | 关联内容 |
|------|------|----------|
| 01 | [01-project-architecture.md](./01-project-architecture.md) | SAVE_FOLLOWINGS 的 0 值保留规则与丢失检测 |
| 02 | [02-independent-sync-works.md](./02-independent-sync-works.md) | independentClient.request 通用骨架 |
| 03 | [03-independent-sync-followings.md](./03-independent-sync-followings.md) | 上游列表采集流程与 formatFollowing 占位约定 |
| 08 | [08-dnr-rules.md](./08-dnr-rules.md) | rule 3（独立模式 GET 头改写） |
| 09 | [09-inject-tab-mode.md](./09-inject-tab-mode.md) | FETCH_PROFILE_OTHER 事件对、fetchProfileOther 签名多源 fallback |
