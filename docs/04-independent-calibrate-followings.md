# 04 · 独立模式（逆向）— 校准关注

> 职责边界：关注计数（`awemeCount`/`followerCount`）的**校准写入机制**——批量校准（同步关注收集完成后逐用户请求 profile/other）与单用户校准（打开作者侧边栏触发）。两流程均按模式分支取数，本文以独立模式为主线、Tab 模式对照。列表采集阶段为何占位 0 见 [03](./03-independent-sync-followings.md)。

## 概述

关注列表接口返回的粉丝/作品计数是**滞后快照**（与主页展示差异大），因此全仓约定：列表采集一律占位 0，权威计数只从 `GET /aweme/v1/web/user/profile/other/?sec_user_id=…` 的 `user.aweme_count / user.follower_count` 获取。校准有两条入口：

1. **批量校准**（`calibrateFollowingStats`）：`FETCH_FOLLOWING` 列表收集完成后自动进入；受运行参数 `calibrateFollowings` 门控；进度以 `FOLLOWING_PROGRESS { phase:"calibrate" }` 透传。
2. **单用户校准**（`handleCalibrateFollowing`）：options 打开作者侧边栏时发 `CALIBRATE_FOLLOWING { uid, secUid }`；不受开关门控；background 取到计数后**直接落库**并返回，options 更新 state 与可见卡片 DOM。

两条入口的 `fetchStats` 都按模式注入：

- Tab模式：`sendToTabAsync("FETCH_USER_PROFILE")` → inject `fetchProfileOther`；
- 独立模式：`independentRequest(CONFIG.API.PROFILE_OTHER, buildBaseParams({ sec_user_id }))` 直接 GET。

## 核心流程图（文字描述）

### 批量校准（同步关注尾部阶段）

```
handleIndependentFetchFollowing / handleFetchFollowing 收集完成
  条件：!cancelled && all.length > 0 && _calibrateFollowings(运行参数)
  → calibrateFollowingStats(list, fetchStats, isCancelled, requestId)
      for entry of list（&& !isCancelled()）:
        sec_uid ← String(entry.profileUrl).match(/\/user\/([^/?#]+)/)[1]
        try: stats = await fetchStats(sec_uid)
             entry.awemeCount = stats.awemeCount
             entry.followerCount = stats.followerCount
        catch: 静默跳过（保留占位 0）
        sendMessage(FOLLOWING_PROGRESS { phase:"calibrate", collected:++processed,
                                          total:list.length, hasMore:false, requestId })
        条目间延迟 syncFollowings MIN~MAX ms
  → 返回调用方，随整体结果 sendResponse → options 发 SAVE_FOLLOWINGS 落库
    （SAVE_FOLLOWINGS 对 >0 计数正常写入，对 0 值保留旧值——见 01 文档）

fetchStats 注入：
  独立模式：(sec_uid) => independentRequest(API.PROFILE_OTHER, …)
            data.user 缺失 → throw "PROFILE_FETCH_FAILED"
  Tab模式：  (sec_uid) => sendToTabAsync("FETCH_USER_PROFILE", { secUid })
            !resp.ok → throw resp.error || "PROFILE_FETCH_FAILED"
```

### 单用户校准（侧边栏打开即触发）

```
options Sidebar.openSidebar(following)
  → #calibrateFollowing(following)：secUid = state.currentFollowingSecUid
  → bgMsg({ type:"CALIBRATE_FOLLOWING", uid, secUid })     // 不受 calibrateFollowings 开关门控
    → background handleCalibrateFollowing(uid, secUid, sendResponse)
        ├─ 参数缺失 → { ok:false, error:"BAD_PARAMS" }
        ├─ loadIndependentMode()
        │   ├─ true：ensureABogus → independentRequest(PROFILE_OTHER, { sec_user_id })
        │   │        data.user 缺失 → throw PROFILE_FETCH_FAILED
        │   └─ false：sendToTabAsync("FETCH_USER_PROFILE", { secUid })
        ├─ ds.get(String(uid)) 无记录 → { ok:false, error:"NOT_FOUND" }
        ├─ record.awemeCount/followerCount ← stats；ds.putBatch([record])   // 直接落库
        └─ sendResponse({ ok:true, awemeCount, followerCount })
  → options：更新 state.followings 对应条目 + 可见卡片 .stat-followers/.stat-works 文本
    失败静默忽略（不影响作品加载）
```

## 接口 / 方法签名

```js
// background.js —— 批量校准（纯迭代器，不落库；写回发生在调用方的整体落库路径上）
async function calibrateFollowingStats(list, fetchStats, isCancelled, requestId)
// list: Following[]（原地改写 awemeCount/followerCount）
// fetchStats: (secUid) => Promise<{ awemeCount, followerCount }>
// isCancelled: () => boolean
// 进度：FOLLOWING_PROGRESS { phase:"calibrate", collected, total, hasMore:false, requestId }

async function handleCalibrateFollowing(uid, secUid, sendResponse)
// 出参：{ ok:true, awemeCount, followerCount }
//     | { ok:false, error:"BAD_PARAMS"|"NOT_FOUND"|其他 }

async function independentRequest(CONFIG.API.PROFILE_OTHER, params)   // GET，仅 a_bogus，无 webSign
```

```js
// options.js —— 侧边栏触发点（Sidebar 私有方法）
async #calibrateFollowing(following)
// bgMsg CALIBRATE_FOLLOWING → 成功后同步 state 与 [data-uid] 卡片的统计文本
```

Tab 模式对照：inject 端 `fetchProfileOther(secUid)` 的签名源为多源 fallback——
`__capturedProfileQuery || __capturedFollowingQuery || __capturedPostQuery || __capturedFavoriteQuery || __capturedCollectionQuery`，
经 `stripPageKeys` 合并后走 `window.fetch(_dyInternal:true)`；全部为空时事件层直接回 `NO_SIGNATURE`。

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
      entry.awemeCount = stats.awemeCount;       // 原地覆盖，存储仍是 6 字段，不新增字段
      entry.followerCount = stats.followerCount;
    } catch (_e) {}                              // 单条失败静默跳过保留旧值；全部失败不影响同步结果
  }
  // FOLLOWING_PROGRESS phase:"calibrate" …（options 端文案切「正在校准作品数…」）
}
```

### 计数写入策略（SAVE_FOLLOWINGS 侧的配套规则）

```js
// 常规列表同步携带的 0 不覆盖已校准旧值；校准结果/导入快照 >0 时正常写入
followerCount: f.followerCount > 0 ? f.followerCount : old?.followerCount || 0,
awemeCount:    f.awemeCount    > 0 ? f.awemeCount    : old?.awemeCount    || 0,
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

无分页、无游标：一次请求即该用户的权威计数。批量校准就是对本域全部条目逐条发这个请求（条目间延迟复用 syncFollowings 档）。

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
| profileUrl 缺失或无 sec_uid 段 | 正则不匹配 | 跳过该条（不发请求），进度照常推进 |
| uid 不在库中（侧边栏场景数据已变） | `{ ok:false, error:"NOT_FOUND" }` | options 忽略 |
| 校准期间用户取消/关弹窗 | `CANCEL_ACTIVE_TASK` | isCancelled() 在条目边界生效；在途请求由各自模式的取消链路中止 |
| 开关门控 | — | 批量校准受 `calibrateFollowings` 控制；侧边栏单用户校准恒执行 |

## 配置项说明

| 配置 | 默认 | 作用 |
|------|------|------|
| `runtimeConfig.calibrateFollowings` | true | 设置面板「运行参数 → 同步关注后校准作品/粉丝数」开关；仅门控批量校准 |
| `runtimeConfig.syncFollowingsDelayMin/Max` | 500/1000ms | 校准条目间延迟 |
| `runtimeConfig.timeoutRequest` | 30000ms | profile/other 单请求超时（独立模式）；Tab 模式经 FETCH_USER_PROFILE 的 msg.timeout |
| `CONFIG.API.PROFILE_OTHER` | `/aweme/v1/web/user/profile/other/` | 权威计数端点（逐用户、无分页） |

## 相关文档

| 编号 | 文档 | 关联内容 |
|------|------|----------|
| 01 | [01-project-architecture.md](./01-project-architecture.md) | SAVE_FOLLOWINGS 的 0 值保留规则与丢失检测 |
| 02 | [02-independent-sync-works.md](./02-independent-sync-works.md) | independentRequest 通用骨架 |
| 03 | [03-independent-sync-followings.md](./03-independent-sync-followings.md) | 上游列表采集流程与 formatFollowing 占位约定 |
| 08 | [08-dnr-rules.md](./08-dnr-rules.md) | rule 3（独立模式 GET 头改写） |
| 09 | [09-inject-tab-mode.md](./09-inject-tab-mode.md) | FETCH_PROFILE_OTHER 事件对、fetchProfileOther 签名多源 fallback |
