# 07 · 独立模式（逆向）— 获取用户作品列表

> 职责边界：`FETCH_WORKS_PAGE` 的双模实现——作者主页作品分页（`/aweme/v1/web/aweme/post/`），供管理页作者侧边栏滚动加载。独立模式为 background 单次直连；Tab 模式为 sendToTab → inject `fetchAuthorWorks`。侧边栏的渲染与虚拟化不在本文范围（见 [12-class-map](./12-class-map.md) `Sidebar` 条目与 AGENTS.md 渲染红线）。

## 概述

侧边栏滚动到距底部 `SIDEBAR_SCROLL_THRESHOLD`(100px) 内触发 `#loadMoreWorks()`，发 `FETCH_WORKS_PAGE { secUid, cursor }`。这是**单次请求**（无循环、无进度消息、无取消注册）：background 按模式分流后一次请求即返回 `{ works, hasMore, maxCursor }`，options 追加渲染；若内容不足以填满容器则递归再取一页。

## 核心流程图（文字描述）

```
options Sidebar 滚动近底
  → 守卫：sidebarLoading || !sidebarCursor || !currentFollowingSecUid → 直接返回
  → bgMsg({ type:"FETCH_WORKS_PAGE", secUid, cursor })
    → background switch "FETCH_WORKS_PAGE" → independentClient.loadMode()
        ├─ true：independentTasks.fetchWorksPage(secUid, cursor, sendResponse)
        │    ├─ credentials.ensureABogus()
        │    └─ data = independentClient.request(API.POST, credentials.buildBaseParams({
        │           sec_user_id, max_cursor: String(cursor||0), count: String(PAGE.POST=20) }))
        │         // GET /aweme/v1/web/aweme/post/，webSign 由 request 默认叠加
        │       works = (data.aweme_list||[]).map(formatWork).filter(Boolean)
        │       sendResponse({ ok:true, works,
        │                     hasMore: has_more===true|1, maxCursor: data.max_cursor || "" })
        │       异常 → sendResponse({ ok:false, error: e.message })
        │
        └─ false：sendToTab("FETCH_WORKS_PAGE", { secUid, cursor, count:PAGE.POST,
                    timeout: CONFIG.TIMEOUT.REQUEST }, sendResponse)
             → content BRIDGE（固定 60s 兜底超时）→ DY_FETCH_WORKS_PAGE_REQUEST
             → inject fetchAuthorWorks(secUid, maxCursor, count)
                  url = buildUrl(API.POST, DEVICE_PARAMS + { sec_user_id, max_cursor, count })
                  merged = mergeParams(url, stripPageKeys(stripSdkKeys(signatureCapture.postQuery)))   // 剥签名键+分页键，包装器代签
                  window.fetch(merged, { _dyInternal:true })                      // 15s 超时
             → 结果事件回传 → sendResponse 同形状

options 收到结果：
  works 追加进侧边栏虚拟化列表（经视口门控 + 分帧队列加载封面）
  sidebarCursor ← maxCursor；hasMore=false 停止监听
  内容不足容器高 → 递归 #loadMoreWorks()
```

## 接口 / 方法签名

```js
// background/tasks/independent-tasks.js（独立分支）
async function independentTasks.fetchWorksPage(secUid, cursor, sendResponse)
// 出参：{ ok:true, works: Work[], hasMore: boolean, maxCursor: string }
//     | { ok:false, error }
// 注意：单次请求协议——不 ack requestId、不发进度消息、无 CANCEL_ACTIVE_TASK 监听

// inject.js（Tab 分支）
async function fetchAuthorWorks(secUid, startCursor, count)
// -> { works: Work[], hasMore, maxCursor }；超时 CONFIG.TIMEOUT.FETCH_PAGE = 15000ms
```

### 超时分级

| 模式 | 层级 |
|------|------|
| Tab模式 | sendToTab 超时（`msg.timeout` = CONFIG.TIMEOUT.REQUEST，默认 30s）+ content.js requestResponse 固定 60s 兜底 |
| 独立模式 | independentClient.request 单层超时（runtimeConfig.timeoutRequest，默认 30s） |

## 关键代码片段

### 独立分支全貌

```js
async function independentTasks.fetchWorksPage(secUid, cursor, sendResponse) {
  try {
    await credentials.ensureABogus();
    const data = await independentClient.request(
      CONFIG.API.POST,                                   // "/aweme/v1/web/aweme/post/"
      await credentials.buildBaseParams({
        sec_user_id: secUid,
        max_cursor: String(cursor || 0),
        count: String(CONFIG.PAGE.POST),               // 20
      }),
    );
    const works = (data.aweme_list || []).map(formatWork).filter(Boolean);
    sendResponse({
      ok: true, works,
      hasMore: utils.hasMoreFlag(data),
      maxCursor: data.max_cursor || "",
    });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
}
```

### Tab 分支的签名复用点

```js
const merged = mergeParams(url, stripPageKeys(stripSdkKeys(signatureCapture.postQuery)));
// 剥签名键（stripSdkKeys）+ 分页键（stripPageKeys）后仅合并业务/环境参数，签名由页面
// 包装器代签——post 端点已被风控强制 Argus webSign 校验，复用捕获的旧
// x-secsdk-web-signature 会被原样重放、包装器不再重签 → Blocked by ArgusSecurityPlugin
// Sign Invalid（详见 09 签名策略节）。signatureCapture.postQuery 为空时 mergeParams 原样返回，
// 发裸参数请求由包装器从零补签，不报错。
```

## 链接拼装实例（真实数据走查）

> sec_uid 取自扩展「导出数据」功能落盘的真实关注记录；会话敏感值以 `<webid>` 等占位。

### 第一步：输入从哪来

两个入参都现成：`secUid` 是当前侧边栏作者（关注卡片 profileUrl 的路径段，如"梨涡远点_" = `MS4wLjABAAAA1Y94tsS-DdoR4Ky9mMY7TghX-mvm0NDMjS9cxby5B1Y`）；`cursor` 是上一页响应回传的 `max_cursor`，首屏为 0。

### 第二步：拼装请求

业务三键排在环境参数全集之后、msToken/a_bogus 之前（键序规则同 [03](./03-independent-sync-followings.md)）：

```text
GET https://www.douyin.com/aweme/v1/web/aweme/post/
    ?device_platform=webapp&aid=6383&channel=channel_pc_web&…&webid=<webid>
     &uifid=<uifid>&odin_tt=<odin_tt>
     &sec_user_id=MS4wLjABAAAA1Y94tsS-DdoR4Ky9mMY7TghX-mvm0NDMjS9cxby5B1Y
     &max_cursor=0&count=20
     &msToken=<msToken>&a_bogus=<a_bogus>&timestamp=<ts秒>&x-secsdk-web-signature=<sig>
     // 另带请求头三件套：uifid / x-secsdk-web-signature / x-secsdk-web-expire（同 05）
```

| 业务参数 | 示例值 | 含义 |
|---|---|---|
| `sec_user_id` | `MS4wLjABAAAA1Y94…` | 目标作者——拉**谁的**作品列表 |
| `max_cursor` | `0 → 服务端回传值 → …` | 不透明续页游标（见下） |
| `count` | `20` | 每页条数 = `PAGE.POST` |

### max_cursor 与 offset 的语义差异（与关注列表的关键不同）

`/aweme/post/` **不是等步长 offset 翻页**：响应的 `max_cursor` 是服务端计算的不透明续页值（通常对应最后一条作品的排序键），下一页必须原样回传，扩展不做任何算术推进：

```text
第 1 页  max_cursor=0            → aweme_list[20]  has_more=1  max_cursor=<M1>
第 2 页  max_cursor=<M1>          → aweme_list[20]  has_more=?  max_cursor=<M2>
…
has_more=false → options 置 sidebarCursor=null 停止监听滚动
```

对照：[03](./03-independent-sync-followings.md) 的 following/list 用 `offset += 20` 自行推进；本文游标完全由服务端掌舵。响应 `aweme_list[]` 每条经 `formatWork` 三级取链（直链解剖见 [02](./02-independent-sync-works.md) 第四步）。

Tab 模式对照：inject `fetchAuthorWorks` 以 DEVICE_PARAMS + 业务键建 URL 后 `mergeParams(url, stripPageKeys(stripSdkKeys(signatureCapture.postQuery)))` 合并页面捕获的业务/环境键（签名键已剥离），签名由页面包装器代注入——缓存缺失时不报错、发裸参数请求由包装器从零补签（已知偏差见异常表）。

## 异常场景及处理

| 场景 | 表现 | 处理 |
|------|------|------|
| 独立模式 `savedCookie` 缺失 / HTTP 错误 | `{ ok:false, error:"NO_COOKIE"/"HTTP_*" }` | options 侧边栏停止追加；无自动重试 |
| a_bogus 被拒 `web_id_sign_invalid` | independentClient.request 内部刷新 webid 重试一次 | 内建恢复 |
| Argus 风控间歇强制 webSign（403 `Signature Not Found`） | request 默认叠加 webSign 后消除；盐轮换会复发 | 按 [05](./05-independent-scan-collection.md) 复发处置指南更新 `CONFIG.WEB_SIGN_SALT` |
| Tab模式签名缓存缺失（冷启动未浏览过作者页） | 发出裸参数请求，服务端大概率拒绝或返回错误码 | **待补充**：可对齐 following/favorite 的做法在缓存缺失时显式回 `NO_SIGNATURE` 引导用户先浏览页面 |
| 双层超时（Tab） | sendToTab 先 TIMEOUT 并补发 CANCEL_ACTIVE_TASK | content 60s 兜底仅在 background 未及时应答时生效 |
| 无限递归保护 | — | 依赖 `sidebarLoading` 标志 + `hasMore=false` 终止；cursor 不前进的服务端异常响应会自然停摆（待补充：可加连续空页熔断） |

## 配置项说明

| 配置 | 默认 | 作用 |
|------|------|------|
| `CONFIG.PAGE.POST` | 20 | 每页条数 |
| `config.SIDEBAR_SCROLL_THRESHOLD`（options/core.js） | 100px | 触发加载的距底阈值 |
| `runtimeConfig.timeoutRequest` | 30000ms | 独立模式单请求超时；Tab模式 msg.timeout 同源 |
| `inject CONFIG.TIMEOUT.FETCH_PAGE` | 15000ms | Tab模式 inject 侧 fetch 超时 |
| content BRIDGE FETCH_WORKS_PAGE timeout | 60000ms 固定 | 事件桥兜底超时 |

## 衍生长任务：作者作品批量入库（IMPORT_USER_WORKS）

> 同端点的循环形态：菜单「入库」弹窗（options `AuthorImport`）触发，把**任意作者**（不要求在关注域）的全部作品分页批量落库作品域。双模循环壳抽为共用模块 `tasks/author-works-import.js` 的 `runAuthorWorksImport(secUid, fetchPage, sendResponse)`——去重/落库/进度/取消守卫/收尾全在壳内，两个任务类只注入各自取页器：Tab 模式 `scanTasks.importUserWorks` 经 `tabBridge.sendAsync` 取页；独立模式 `independentTasks.importUserWorks` 直连 `API.POST` 取页（取页器内抛错即记入 `lastError`）。

### 与收藏扫描（#paginate）的结构差异

| 差异点 | 原因 |
|--------|------|
| 响应字段 `works`/`maxCursor`（非 `items`/`cursor`） | aweme/post 响应形状；不能直接复用 `#paginate` |
| **无丢失检测**（不走 `persistScan`） | 导入的是他人作品列表，不是本域全集；丢失检测会把存量全部误判 lost |
| **每页即落库**（每页一次 `mergeAndSave(WORKS, page)`） | 取消/异常保留已扫部分；进度弹窗可实时显示「已入库 N」 |
| 重叠页去重（`seen` Set，空页即终止） | 服务端偶发返回重叠页；cursor 不前进时防死循环 |
| 延迟档独立 `importWorks`（曾错用 `syncCollection`，域词对齐后独立成键） | 运行参数面板「作者入库 延迟」可调 |

### 分组语义（与「添加作品」同一条函数保证）

分页结果**原样**交给 `domainStore.mergeAndSave(WORKS, page)`（不预置 `groupId`，`formatWork` 产物本身无该字段），由 `mergeWork` 的 `old?.groupId || w.groupId || DEFAULT_ID` 链保证：已在作品域的条目**保留原分组**，新条目落**「未分组」**（`uncategorized`）。重复导入幂等且不打乱既有排序（`savedAt` 旧值优先）。

### 消息与进度

- `IMPORT_USER_WORKS { secUid }` → 循环期间逐页发 `IMPORT_WORKS_PROGRESS { requestId, collected, saved, total, hasMore }`，终态 `sendResponse { ok, collected, added, updated, timedOut, error? }`（`added`/`updated` 即「新增入未分组/更新保留原分组」计数；首页即失败才 `ok:false`）。
- **UI 刷新时机**：循环内**不发** `STORE_CHANGED`（进度弹窗数字由 `IMPORT_WORKS_PROGRESS` 驱动）；全部批次落库完成后统一广播一次 `STORE_CHANGED { domain: works, changedIds, addedIds }`——载荷为轻量 id 集（实际写入记录 id + 其中的新增子集，万级 ≈ 几十 KB，禁全量记录防消息膨胀），options flush 时经 `GET_WORKS_BY_IDS` 补拉合并后记录，走与点载荷相同的增量收口管线（视图内新增头插、已有记录原地更新，**零整刷**）+ `refreshGroups()` 重算分组数字。取消/部分失败同样补发（已落库部分收口），一页未落（`collected=0`）或 `changed=0`（全部为无变化重复入库）不发。`AuthorImport.#showDone` 不再手动 `loadDomainData`（避免与广播双重收口）。
- 取消：进度弹窗 X/Esc → `requestDialogClose` → `CANCEL_ACTIVE_TASK` → `withCancelGuard` 置位 → 下一页前退出。
- 错误映射（options `AuthorImport`）：`NO_SIGNATURE` → 关进度弹窗改弹签名引导（URL 指向作者主页）；错误串含 `2096` → 「账号作品因隐私设置不可见」。

### 姊妹消息

| 消息 | 语义 | 实现位置 |
|------|------|----------|
| `IMPORT_FOLLOWING { secUid }` | profile/other 单请求收录作者档案入关注域；`formatFollowingFromProfile` + `#fetchLatestWorkTime` 补 lastUpdateAt；`mergeAndSaveFollowings` 非 import 分支（已在域保组/新作者落未分组） | `scanTasks.importFollowing`（双模分支内联，与 `calibrateOne` 共用 `#fetchProfileUser`） |

## 相关文档

| 编号 | 文档 | 关联内容 |
|------|------|----------|
| 01 | [01-project-architecture.md](./01-project-architecture.md) | formatWork 字段模型；sendToTab/requestResponse 协议 |
| 02 | [02-independent-sync-works.md](./02-independent-sync-works.md) | independentClient.request 骨架与三级取链（formatWork 与 inject extractVideo 双实现约束） |
| 08 | [08-dnr-rules.md](./08-dnr-rules.md) | rule 3（独立模式 GET 头改写） |
| 09 | [09-inject-tab-mode.md](./09-inject-tab-mode.md) | fetchAuthorWorks 所在的签名复用体系与 `_dyInternal` 保护 |
