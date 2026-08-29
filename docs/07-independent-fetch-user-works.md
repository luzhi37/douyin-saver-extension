# 07 · 独立模式（逆向）— 获取用户作品列表

> 职责边界：`FETCH_WORKS_PAGE` 的双模实现——作者主页作品分页（`/aweme/v1/web/aweme/post/`），供管理页作者侧边栏滚动加载。独立模式为 background 单次直连；Tab 模式为 sendToTab → inject `fetchAuthorWorks`。侧边栏的渲染与虚拟化不在本文范围（见 AGENTS.md Sidebar 条目）。

## 概述

侧边栏滚动到距底部 `SIDEBAR_SCROLL_THRESHOLD`(100px) 内触发 `#loadMoreWorks()`，发 `FETCH_WORKS_PAGE { secUid, cursor }`。这是**单次请求**（无循环、无进度消息、无取消注册）：background 按模式分流后一次请求即返回 `{ works, hasMore, maxCursor }`，options 追加渲染；若内容不足以填满容器则递归再取一页。

## 核心流程图（文字描述）

```
options Sidebar 滚动近底
  → 守卫：sidebarLoading || !sidebarCursor || !currentFollowingSecUid → 直接返回
  → bgMsg({ type:"FETCH_WORKS_PAGE", secUid, cursor })
    → background switch "FETCH_WORKS_PAGE" → loadIndependentMode()
        ├─ true：handleIndependentFetchWorksPage(secUid, cursor, sendResponse)
        │    ├─ ensureABogus()
        │    └─ data = independentRequest(API.POST, buildBaseParams({
        │           sec_user_id, max_cursor: String(cursor||0), count: String(PAGE.AUTHOR=20) }))
        │         // GET /aweme/v1/web/aweme/post/，仅 a_bogus，无 webSign
        │       works = (data.aweme_list||[]).map(formatWork).filter(Boolean)
        │       sendResponse({ ok:true, works,
        │                     hasMore: has_more===true|1, maxCursor: data.max_cursor || "" })
        │       异常 → sendResponse({ ok:false, error: e.message })
        │
        └─ false：sendToTab("FETCH_WORKS_PAGE", { secUid, cursor, count:PAGE.AUTHOR,
                    timeout: CONFIG.TIMEOUT.REQUEST }, sendResponse)
             → content BRIDGE（固定 60s 兜底超时）→ DY_FETCH_WORKS_REQUEST
             → inject fetchAuthorWorks(secUid, maxCursor, count)
                  url = buildUrl(API.POST, DEVICE_PARAMS + { sec_user_id, max_cursor, count })
                  merged = mergeParams(url, stripPageKeys(__capturedPostQuery))   // 复用页面捕获签名
                  window.fetch(merged, { _dyInternal:true })                      // 15s 超时
             → 结果事件回传 → sendResponse 同形状

options 收到结果：
  works 追加进侧边栏虚拟化列表（经视口门控 + 分帧队列加载封面）
  sidebarCursor ← maxCursor；hasMore=false 停止监听
  内容不足容器高 → 递归 #loadMoreWorks()
```

## 接口 / 方法签名

```js
// background.js（独立分支）
async function handleIndependentFetchWorksPage(secUid, cursor, sendResponse)
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
| 独立模式 | independentRequest 单层超时（runtimeConfig.timeoutRequest，默认 30s） |

## 关键代码片段

### 独立分支全貌

```js
async function handleIndependentFetchWorksPage(secUid, cursor, sendResponse) {
  try {
    await ensureABogus();
    const data = await independentRequest(
      CONFIG.API.POST,                                   // "/aweme/v1/web/aweme/post/"
      await buildBaseParams({
        sec_user_id: secUid,
        max_cursor: String(cursor || 0),
        count: String(CONFIG.PAGE.AUTHOR),               // 20
      }),
    );
    const works = (data.aweme_list || []).map(formatWork).filter(Boolean);
    sendResponse({
      ok: true, works,
      hasMore: data.has_more === true || data.has_more === 1,
      maxCursor: data.max_cursor || "",
    });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
}
```

### Tab 分支的签名复用点

```js
const merged = mergeParams(url, stripPageKeys(__capturedPostQuery));
// __capturedPostQuery 为空时 mergeParams 原样返回 —— post 端点不像 following/favorite 那样
// 在签名缓存缺失时直接报 NO_SIGNATURE，而是发出仅含基础参数的请求，成败取决于页面包装器是否补签。
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
     &msToken=<msToken>&a_bogus=<a_bogus>
```

| 业务参数 | 示例值 | 含义 |
|---|---|---|
| `sec_user_id` | `MS4wLjABAAAA1Y94…` | 目标作者——拉**谁的**作品列表 |
| `max_cursor` | `0 → 服务端回传值 → …` | 不透明续页游标（见下） |
| `count` | `20` | 每页条数 = `PAGE.AUTHOR` |

### max_cursor 与 offset 的语义差异（与关注列表的关键不同）

`/aweme/post/` **不是等步长 offset 翻页**：响应的 `max_cursor` 是服务端计算的不透明续页值（通常对应最后一条作品的排序键），下一页必须原样回传，扩展不做任何算术推进：

```text
第 1 页  max_cursor=0            → aweme_list[20]  has_more=1  max_cursor=<M1>
第 2 页  max_cursor=<M1>          → aweme_list[20]  has_more=?  max_cursor=<M2>
…
has_more=false → options 置 sidebarCursor=null 停止监听滚动
```

对照：[03](./03-independent-sync-followings.md) 的 following/list 用 `offset += 20` 自行推进；本文游标完全由服务端掌舵。响应 `aweme_list[]` 每条经 `formatWork` 三级取链（直链解剖见 [02](./02-independent-sync-works.md) 第四步）。

Tab 模式对照：inject `fetchAuthorWorks` 以 DEVICE_PARAMS + 业务键建 URL 后 `mergeParams(url, stripPageKeys(__capturedPostQuery))` 合并页面捕获的环境键，签名由页面包装器代注入——缓存缺失时不报错、发裸参数请求碰运气（已知偏差见异常表）。

## 异常场景及处理

| 场景 | 表现 | 处理 |
|------|------|------|
| 独立模式 `savedCookie` 缺失 / HTTP 错误 | `{ ok:false, error:"NO_COOKIE"/"HTTP_*" }` | options 侧边栏停止追加；无自动重试 |
| a_bogus 被拒 `web_id_sign_invalid` | independentRequest 内部刷新 webid 重试一次 | 内建恢复 |
| Tab模式签名缓存缺失（冷启动未浏览过作者页） | 发出裸参数请求，服务端大概率拒绝或返回错误码 | **待补充**：可对齐 following/favorite 的做法在缓存缺失时显式回 `NO_SIGNATURE` 引导用户先浏览页面 |
| 双层超时（Tab） | sendToTab 先 TIMEOUT 并补发 CANCEL_ACTIVE_TASK | content 60s 兜底仅在 background 未及时应答时生效 |
| 无限递归保护 | — | 依赖 `sidebarLoading` 标志 + `hasMore=false` 终止；cursor 不前进的服务端异常响应会自然停摆（待补充：可加连续空页熔断） |

## 配置项说明

| 配置 | 默认 | 作用 |
|------|------|------|
| `CONFIG.PAGE.AUTHOR` | 20 | 每页条数 |
| `config.SIDEBAR_SCROLL_THRESHOLD`（options/core.js） | 100px | 触发加载的距底阈值 |
| `runtimeConfig.timeoutRequest` | 30000ms | 独立模式单请求超时；Tab模式 msg.timeout 同源 |
| `inject CONFIG.TIMEOUT.FETCH_PAGE` | 15000ms | Tab模式 inject 侧 fetch 超时 |
| content BRIDGE FETCH_WORKS_PAGE timeout | 60000ms 固定 | 事件桥兜底超时 |

## 相关文档

| 编号 | 文档 | 关联内容 |
|------|------|----------|
| 01 | [01-project-architecture.md](./01-project-architecture.md) | formatWork 字段模型；sendToTab/requestResponse 协议 |
| 02 | [02-independent-sync-works.md](./02-independent-sync-works.md) | independentRequest 骨架与三级取链（formatWork 与 inject extractVideo 双实现约束） |
| 08 | [08-dnr-rules.md](./08-dnr-rules.md) | rule 3（独立模式 GET 头改写） |
| 09 | [09-inject-tab-mode.md](./09-inject-tab-mode.md) | fetchAuthorWorks 所在的签名复用体系与 `_dyInternal` 保护 |
