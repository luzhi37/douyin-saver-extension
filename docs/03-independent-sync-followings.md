# 03 · 独立模式（逆向）— 同步关注

> 职责边界：`FETCH_FOLLOWING` 在**独立模式**下的完整链路——background 直接翻页拉取目标用户的关注列表，收集完成后（可选）进入批量校准阶段。校准阶段细节见 [04](./04-independent-calibrate-followings.md)；落库与丢失检测见 [10](./10-storage-write-and-import.md)。

## 概述

options 关注域点击同步 → `services.findSecUid()` 解析目标 sec_uid → 发 `FETCH_FOLLOWING { secUid }`。background 路由按模式分流到 `handleIndependentFetchFollowing`：

- **sec_uid 再解析**：入参为 `"self"` 或空时，依次尝试 storage 中的 `secUid` 设置值 → `resolveSelfSecUid()`（uid cookie + `im/user/info` 兑换）；两者皆空报 `NO_SEC_UID`。
- **while 循环翻页**：GET `/aweme/v1/web/user/following/list`，`offset += PAGE.FOLLOWING` 推进；条目按 uid 去重（`seen` Set），连续整页重复即提前终止。
- 每页经 `formatFollowing` 归一化为 6 字段记录，`followerCount/awemeCount` 占位 0。
- 列表收集完成后、未被取消且非空时，受 `calibrateFollowings` 开关门控进入 `calibrateFollowingStats` 批量校准（详见 [04](./04-independent-calibrate-followings.md)）。
- 结果一次性 `sendResponse({ ok, requestId, followings, total })` 返回，options 收到后自行发 `SAVE_FOLLOWINGS` 落库。

## 核心流程图（文字描述）

```
options: findSecUid() → bgMsg({ type:"FETCH_FOLLOWING", secUid })
  → background switch "FETCH_FOLLOWING" → loadIndependentMode() === true
    → handleIndependentFetchFollowing(secUid, sendResponse)
        ├─ ensureABogus()
        ├─ secUid 解析链：
        │     secUid ∈ {undefined,"self",""} → storage.secUid（非 self）→ resolveSelfSecUid()
        │     仍为空 → sendResponse({ ok:false, error:"NO_SEC_UID" }); 结束
        ├─ userId ← douyin.com cookie jar 的 uid cookie；缺失则从 savedCookie 正则提取
        ├─ requestId = randomUUID()；注册 cancelHandler（CANCEL_ACTIVE_TASK → cancelled）
        │
        └─ while (hasMore && !cancelled):
             params = { sec_user_id, count:PAGE.FOLLOWING(20), offset,
                        min_time:"0", max_time:"0", source_type:"4",
                        gps_access:"0", address_book_access:"0", is_top:"1" }
             data = independentRequest(API.FOLLOWING, buildBaseParams(params))   // GET + a_bogus
             data.status_code===0 且 followings 为数组？
               ├─ 空数组 → break（自然到底）
               ├─ newItems = 过滤 seen 中已有 uid；newItems 为空 → break（服务端重复推送保护）
               ├─ all.push(...newItems.map(formatFollowing))
               ├─ hasMore = has_more===true|1；data.total>0 && all.length>=total → hasMore=false
               └─ offset += PAGE.FOLLOWING
             sendMessage(FOLLOWING_PROGRESS { collected, hasMore, total, requestId })
             页间延迟 syncFollowings MIN~MAX ms
        │
        ├─ !cancelled && all.length>0 && _calibrateFollowings
        │     → calibrateFollowingStats(all, fetchStats=独立直连 profile/other, ()=>cancelled, requestId)
        │       （进度 phase:"calibrate"，详见 04 文档）
        ├─ 移除 cancelHandler
        └─ sendResponse({ ok:true, requestId, followings: all, total: all.length })

options: res.ok → bgMsg({ type:"SAVE_FOLLOWINGS", followings: res.followings })
              → handleSaveFollowings 落库（保留 groupId/savedAt，丢失检测返回 lostUids）
```

### resolveSelfSecUid（"self" 兜底解析）

```
uid cookie (douyin.com jar) → savedCookie 正则提取 uid
  → POST /aweme/v1/web/im/user/info/  body: JSON { sec_user_ids:[uid] }
  → 响应 users[] 中取 sec_uid
失败静默返回 ""（调用方据此报 NO_SEC_UID）
```

## 接口 / 方法签名

```js
// background/tasks/independent-tasks.js
async function handleIndependentFetchFollowing(secUid, sendResponse)
// 出参：{ ok:true, requestId, followings: Following[], total } | { ok:false, error }
// 进度：FOLLOWING_PROGRESS（列表阶段无 phase 字段）

async function resolveSelfSecUid() -> Promise<string>   // 空 = 解析失败

function formatFollowing(item) -> Following
// { uid:String, nickname:item.nickname||"未知",
//   avatarLarger: avatar_larger.url_list[0] || "",
//   followerCount: 0, awemeCount: 0,                    // 占位 0，仅由校准写入
//   profileUrl: URL_BASE + "/user/" + sec_uid }
```

Tab 模式对照：同消息走 `handleFetchFollowing`，逐页 `sendToTabAsync("FETCH_FOLLOWING_PAGE")` → inject `fetchFollowingPage`；签名复用 `__capturedFollowingQuery`（缺失时 inject 直接回 `NO_SIGNATURE`）。两模式产出相同的 items 形状与进度消息。

## 关键代码片段

### 分页推进与去重终止

```js
const seen = new Set();
while (hasMore && !cancelled) {
  const params = { sec_user_id: secUid, count: String(CONFIG.PAGE.FOLLOWING), offset: String(offset),
                   min_time: "0", max_time: "0", source_type: "4",
                   gps_access: "0", address_book_access: "0", is_top: "1" };
  const data = await independentRequest(CONFIG.API.FOLLOWING, await buildBaseParams(params));
  if (data.status_code === 0 && Array.isArray(data.followings)) {
    if (data.followings.length === 0) break;
    const newItems = data.followings.filter((item) => !seen.has(String(item.uid)));
    if (newItems.length === 0) break;          // 服务端重复推送 → 提前收尾，避免死循环
    newItems.forEach((item) => seen.add(String(item.uid)));
    all.push(...newItems.map(formatFollowing));
    hasMore = data.has_more === true || data.has_more === 1;
    if (data.total > 0 && all.length >= data.total) hasMore = false;
    offset += CONFIG.PAGE.FOLLOWING;
  } else break;
}
```

### 计数占位约定

```js
function formatFollowing(item) {
  return {
    uid: String(item.uid || ""),
    nickname: item.nickname || "未知",
    avatarLarger: ((item.avatar_larger && item.avatar_larger.url_list) || [])[0] || "",
    // 粉丝/作品数不再取自关注列表（滞后快照，常与主页展示差很远），字段占位为 0，
    // 仅由 profile/other 校准写入 —— 见 04 文档
    followerCount: 0,
    awemeCount: 0,
    profileUrl: CONFIG.URL_BASE + "/user/" + (item.sec_uid || ""),
  };
}
```

## 链接拼装实例（真实数据走查）

> 样本取自扩展「导出数据」功能落盘的真实库快照（602 条关注）。会话敏感值以 `<webid>` 等占位。

### 第一步：从主页链接提取 sec_uid

```text
profileUrl: https://www.douyin.com/user/MS4wLjABAAAARrc8YjQCd8-nzW0qad8Nu4fghV0ouiLKKuUm107nj1DEGGW1NQ2qmpotMdNQb667
→ sec_uid = MS4wLjABAAAARrc8YjQCd8-nzW0qad8Nu4fghV0ouiLKKuUm107nj1DEGGW1NQ2qmpotMdNQb667
```

sec_uid 是服务端签发的不可逆字符串 ID，**统一以 `MS4wLjABAAAA` 开头**（base64 解码即版本头 `1.0.0\x01` + 填充），无法从中还原数字 uid。数字 uid（如本例"双一" = `1002380664252222`）属于另一套体系，只能从 Cookie 取，仅作 `user_id` 参数附带。

### 第二步：拼装分页请求

query 键序 = 对象插入序：环境参数全集在前（同 [02](./02-independent-sync-works.md) 第二步的表，此处不重复）、业务参数随后、msToken 最末、a_bogus 收尾：

| 业务参数 | 示例值 | 含义 |
|---|---|---|
| `sec_user_id` | `MS4wLjABAAAARrc8…NQb667` | 目标用户——翻**谁的**关注列表 |
| `count` | `20` | 每页条数 = `PAGE.FOLLOWING` |
| `offset` | `0 → 20 → 40 …` | 翻页游标（简单偏移量，步长=count） |
| `min_time` / `max_time` | `0` / `0` | 时间窗过滤占位（对齐页面真实请求） |
| `source_type` | `4` | 列表来源场景码 |
| `gps_access` / `address_book_access` | `0` / `0` | 关闭 GPS/通讯录授权过滤 |
| `is_top` | `1` | 包含置顶关注 |

> **不传 `user_id`**：关注列表归属由 Cookie 决定（与收藏扫描同款）。旧实现曾从 `uid` cookie 取第一个值附加 `user_id`，但多账号/过期 cookie 下该值可能与当前会话 uid 不一致；私密账号会据此判定为「他人查看」而返回 `status_code:2096`，故移除。

完整形态（截去环境中段）：

```text
GET https://www.douyin.com/aweme/v1/web/user/following/list
    ?device_platform=webapp&aid=6383&channel=channel_pc_web&…&webid=<webid>
     &uifid=<uifid>&odin_tt=<odin_tt>
     &sec_user_id=MS4wLjABAAAARrc8…
     &count=20&offset=0&min_time=0&max_time=0&source_type=4
     &gps_access=0&address_book_access=0&is_top=1
     &msToken=<msToken>&a_bogus=<a_bogus>
```

Tab 模式对照：inject `fetchFollowingPage` 只填 DEVICE_PARAMS + 业务键并合并页面捕获 query（`stripPageKeys` 剔除 offset/count 后补环境），签名由页面包装器代注入。

### 第三步：翻页推进演示

以导出库 602 条关注的真实数据为例：

```text
第 1 页  offset=0    → followings[20]   has_more=1  total=602
第 2 页  offset=20   → followings[20]
…
第 31 页 offset=600  → followings[2]    all.length(602) >= total → hasMore=false 收尾
```

两道防死循环闸门贯穿全程：uid 去重（`seen` Set）后整页无新条目即提前终止；`total > 0 && all.length >= total` 强制收尾。

### 第四步：响应 → 入库字段映射

响应单条（字段名照录接口返回，数值真实）：

```jsonc
{
  "uid": "1002380664252222",
  "nickname": "双一",
  "sec_uid": "MS4wLjABAAAARrc8…",
  "avatar_larger": { "url_list": ["https://p3-pc.douyinpic.com/aweme/1080x1080/aweme-avatar/tos-cn-avt-0015_196eb762e9561d68fd28ccbbc5c96a71.jpeg?from=2956013662"] }
}
```

经 `formatFollowing` 归一化后入库（followerCount/awemeCount 占位 0，待校准写入）：

```jsonc
{
  "uid": "1002380664252222",
  "nickname": "双一",
  "avatarLarger": "https://p3-pc.douyinpic.com/aweme/1080x1080/aweme-avatar/tos-cn-avt-0015_<hash>.jpeg?from=2956013662",  // 公开头图，无签名参数、永不过期
  "profileUrl": "https://www.douyin.com/user/MS4wLjABAAAARrc8…",   // URL_BASE + "/user/" + sec_uid
  "followerCount": 0,
  "awemeCount": 0
}
```

列表收集完成后若开启校准开关，逐用户走 profile/other 权威计数（链接拼装见 [04](./04-independent-calibrate-followings.md)）。

## 异常场景及处理

| 场景 | 表现 | 处理 |
|------|------|------|
| sec_uid 无法解析（self 且无存储值、im/user/info 失败） | `{ ok:false, error:"NO_SEC_UID" }` | options 弹窗引导打开抖音用户页面或填写独立模式 secUid |
| 目标账号关注列表不可见（抖音 `status_code:2096`「由于该用户隐私设置，列表不可见」） | 独立模式 `IndependentClient.request` 抛 `API_ERROR` 并带 `statusCode:2096`，`handleIndependentFetchFollowing` 捕获后返回 `{ ok:false, error:"FOLLOWING_LIST_PRIVATE" }` | options 状态栏提示「关注列表不可见（账号隐私设置）」；最常见诱因是 self 解析落到他人 sec_uid（如独立模式仍打开了某 `/user/*` 标签页）——`vmSyncFollowings` 现已对独立模式强制传 `"self"` 经 background 自解析链路规避 |
| `savedCookie` 缺失 | 首次请求抛 `NO_COOKIE` | 设置面板刷新 Cookie |
| 服务端返回非 0 status_code / HTTP 错误 | 抛 `API_ERROR` / `HTTP_*` | 外层 catch → `{ ok:false, error }`（此时 all 为空，无部分成功语义） |
| 首页即失败但已收集部分数据 | Tab 模式分支特有 `lastError` 判定：`all.length===0 && lastError` 才报错，否则按部分结果返回 | 独立模式请求异常直接整体失败 |
| 用户取消 | `CANCEL_ACTIVE_TASK` → cancelled | 已收集部分照常返回（`ok:true`），不进入校准 |
| 服务端重复推送同一页 | newItems 为空 | break 终止，防止死循环 |

## 配置项说明

| 配置 | 默认 | 作用 |
|------|------|------|
| `CONFIG.PAGE.FOLLOWING` | 20 | 每页条数（offset 步长） |
| `runtimeConfig.syncFollowingsDelayMin/Max` | 500/1000ms | 页间延迟；校准阶段条目间延迟复用同一档 |
| `runtimeConfig.timeoutRequest` | 30000ms | 单请求超时 |
| `runtimeConfig.calibrateFollowings` | true | 是否在收集完成后执行批量校准（04 文档） |
| chrome.storage.local `secUid` | — | "self" 时的目标用户兜底 |
| 固定 query 参数 | — | `min_time/max_time/source_type=4/gps_access/address_book_access/is_top=1`：对齐页面真实请求的列表过滤参数 |

## 相关文档

| 编号 | 文档 | 关联内容 |
|------|------|----------|
| 01 | [01-project-architecture.md](./01-project-architecture.md) | Following 六字段模型、SAVE_FOLLOWINGS 0 值保留与丢失检测 |
| 02 | [02-independent-sync-works.md](./02-independent-sync-works.md) | independentRequest 通用骨架与 NO_COOKIE 门禁（本文不重复展开） |
| 04 | [04-independent-calibrate-followings.md](./04-independent-calibrate-followings.md) | 收集后的批量校准阶段 + 单用户侧边栏校准 |
| 08 | [08-dnr-rules.md](./08-dnr-rules.md) | rule 3 注入 Referer / 剥离 Sec-Fetch-* |
| 09 | [09-inject-tab-mode.md](./09-inject-tab-mode.md) | Tab模式 FETCH_FOLLOWING_PAGE / fetchProfileOther 与签名多源 fallback |
