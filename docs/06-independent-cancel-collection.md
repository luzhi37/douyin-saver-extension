# 06 · 独立模式（逆向）— 取消收藏

> 职责边界：`CANCEL_COLLECTION` 在**独立模式**下的完整链路——background 内直接循环 `fetch()` POST `/aweme/v1/web/aweme/collect/`，不经过任何标签页。取消点赞（CANCEL_FAVORITES）**没有独立分支**，仅 Tab 模式 XHR 链路（见 [09](./09-inject-tab-mode.md)）；DNR 头注入依赖见 [08](./08-dnr-rules.md)。

## 概述

options 批量操作对选中条目发起批量取消（batch.js 按域派发 `CANCEL_FAVORITES` / `CANCEL_COLLECTION`）。background 路由：

```
CANCEL_COLLECTION → independentClient.loadMode()
  ├─ true  → independentTasks.cancel(awemeIds, "collection", persistDomain, sendResponse)
  └─ false → scanTasks.runCancelBatch(awemeIds, "CANCEL_ONE_COLLECTION", "CANCEL_PROGRESS", persistDomain, …)   // Tab模式
```

独立模式实现要点：

- 端点四要素集中在 `CONFIG.CANCEL.collection`（url / body 函数 / content-type / referrer），当前仅此一个 kind；
- 前置校验：awemeIds 非空（`EMPTY`）、`savedCookie` 存在（`NO_COOKIE`）、kind 存在（`UNKNOWN_KIND`）；
- 密钥头 `bd-ticket-guard-ree-public-key` 取自 `browserFeatures.securityKey`——该值由 inject 在抖音页面采集 localStorage 而来（需用户曾访问过 douyin.com；采集机制见 [09](./09-inject-tab-mode.md)），缺失时**不带该头**继续尝试；
- SW 的 `fetch()` 无法设置 Referer（forbidden header），精确 Referer 与 Sec-Fetch-* 同源元数据由 DNR rules 3/5 在网络层补齐；
- 取消信号在 background 循环内自消化（`utils.withCancelGuard()` 监听 `CANCEL_ACTIVE_TASK`），不经 content→inject；
- 移除 = 取消并删本地：远端取消成功的条目经 `scanTasks.deleteCancelled` 同步删除该域本地记录，`CANCEL_DONE` 载荷携带 `deletedIds` 供 options 增量移除网格卡片。

## 核心流程图（文字描述）

```
options 批量操作「取消收藏」（选中条目）
  → bgMsg({ type:"CANCEL_COLLECTION", awemeIds, domain })
    → background switch → independentClient.loadMode() === true
      → independentTasks.cancel(awemeIds, "collection", domain, sendResponse)
          ├─ 校验：!Array||empty → { ok:false, error:"EMPTY" }
          ├─         !savedCookie → { ok:false, error:"NO_COOKIE" }
          ├─         CONFIG.CANCEL[kind] 不存在 → { ok:false, error:"UNKNOWN_KIND" }
          ├─ key = browserFeatures.securityKey || ""
          ├─ requestId = randomUUID()；guard = utils.withCancelGuard()
          ├─ sendResponse({ ok:true, requestId, total })        // 立即 ack
          │
          └─ for i in awemeIds（&& !cancelled）:
               let ok = false;
               try {
                 resp = await fetch(ep.url, {
                   method: "POST",
                   credentials: "include",
                   referrer: ep.referrer, referrerPolicy: "unsafe-url",
                   headers: { "content-type": ep.type,
                              ...(key ? { "bd-ticket-guard-ree-public-key": key } : {}) },
                   body: ep.body(awemeIds[i]),
                 });
                 ok = resp.ok;
               } catch (_) {}
               if (!ok) errors.push({ awemeId, error: "FAILED" })
               sendMessage(CANCEL_PROGRESS { index, total, status: ok?"ok":"error", awemeId })
               条目间延迟 cancelCollection MIN~MAX ms（末条不加）
          ├─ guard.dispose()
          ├─ deletedIds = scanTasks.deleteCancelled(domain, awemeIds, failedAwemeIds)
          └─ sendMessage(CANCEL_DONE { requestId, ok:true, cancelled,
                                        refreshed, failed, failedAwemeIds, deletedIds })

端点四要素（CONFIG.CANCEL.collection）：
  url      https://www.douyin.com/aweme/v1/web/aweme/collect/?aid=6383
  body     action=0&aweme_id=<id>&aweme_type=0
  type     application/x-www-form-urlencoded
  referrer https://www.douyin.com/user/self?showTab=favorite_collection
```

## 接口 / 方法签名

```js
// background/tasks/independent-tasks.js
async function independentTasks.cancel(awemeIds, kind, persistDomain, sendResponse)
// awemeIds: string[]；kind: "collection"；persistDomain: 取消成功后删本地记录的目标域
// 出参（ack）：{ ok:true, requestId, total }；后续结果仅经 CANCEL_PROGRESS / CANCEL_DONE 消息
// 进度：CANCEL_PROGRESS*N → CANCEL_DONE

async function scanTasks.runCancelBatch(awemeIds, tabType, progressType, persistDomain, sendResponse)   // Tab模式对照分支
```

### 双模式实现差异对照

| 维度 | Tab模式 (inject XHR) | 独立模式 (background fetch) |
|------|----------------------|------------------------------|
| 网络引擎 | `XMLHttpRequest`（a_bogus 签名与 XHR 原型链深度绑定，页面自动签名） | `fetch()`（无页面上下文，无需 a_bogus——该 POST 端点不校验） |
| Referer | JS 直接 `setRequestHeader` | forbidden header → DNR rules 5(+3) 注入 + fetch `referrer` 选项双保险 |
| Sec-Fetch-* | 页面内天然携带 | DNR rule 5 补 `same-origin/cors/empty` |
| 密钥头 | `getSecurityKey()` 每条前从 localStorage 重读（批次中途密钥更新自动生效） | `browserFeatures.securityKey` 静态快照 |
| 单条错误语义 | 401/403 → `AUTH_FAILED`，其他 → `HTTP_<code>` | 仅 `resp.ok` 布尔（不区分鉴权失败） |
| 取消信号 | 经 background→content→DY_CANCEL_ACTIVE_TASK 中止在途 XHR | 循环标志位；**在途单条 fetch 无 AbortController，需等当前条完成才停** |

## 关键代码片段

```js
const ep = CONFIG.CANCEL[kind];
if (!ep) return sendResponse({ ok: false, error: "UNKNOWN_KIND" });
…
const resp = await fetch(ep.url, {
  method: "POST",
  credentials: "include",
  // Referer 不能放 headers（forbidden header，静默忽略）：用 referrer 选项 + rule 5 DNR set 双保险
  referrer: ep.referrer,
  referrerPolicy: "unsafe-url",
  headers: {
    "content-type": ep.type,
    ...(key ? { "bd-ticket-guard-ree-public-key": key } : {}),
  },
  body: ep.body(awemeIds[i]),   // "action=0&aweme_id=" + id + "&aweme_type=0"
});
ok = resp.ok;
```

## 单条取消请求实例（真实值走查）

> 作品 ID 取自扩展导出库真实数据。这是全扩展最简的一条 API 请求——**无任何签名**，与 listcollection（三层校验）恰成两极。

以取消收藏作品 `7267428670501915945` 为例，最终报文：

```text
POST https://www.douyin.com/aweme/v1/web/aweme/collect/?aid=6383
Cookie: （credentials:"include" 自动携带当前登录会话——身份唯一凭据）
Referer: https://www.douyin.com/user/self?showTab=favorite_collection   ← fetch referrer 选项 + DNR rule 5 双保险
Sec-Fetch-Site/Dest/Mode: same-origin/empty/cors                        ← DNR rule 5 补齐
Content-Type: application/x-www-form-urlencoded
bd-ticket-guard-ree-public-key: <browserFeatures.securityKey>           ← 可选头，缺失时整行不带

body: action=0&aweme_id=7267428670501915945&aweme_type=0
```

| 参数 | 值 | 含义 |
|---|---|---|
| `aid`（query） | `6383` | 抖音 web 端应用 ID |
| `action` | `0` | **0 = 取消收藏**（1 = 添加） |
| `aweme_id` | `7267428670501915945` | 目标作品 awemeId（批量勾选条目） |
| `aweme_type` | `0` | 作品类型占位（页面同款固定值） |

要点：

- **没有 a_bogus / msToken / timestamp**——该端点不做签名校验，身份完全由 Cookie 决定。因此独立模式 background 裸 `fetch()` 即可发出；Tab 模式反而必须走 XHR 是因为点赞端点绑签名，收藏端点两条路都无签名负担；
- `bd-ticket-guard-ree-public-key` 来自 inject 在抖音页面采集的 localStorage 公钥（`browserFeatures.securityKey`），缺失时服务端可能 401/403 拒绝——这是本流程唯一可能"缺料"的槽位；
- 成败判据仅 `resp.ok` 布尔值，不解析响应体；逐条结果经 CANCEL_PROGRESS 的 status 字段回报。

## 异常场景及处理

| 场景 | 表现 | 处理 |
|------|------|------|
| securityKey 缺失（从未访问过抖音页面） | 请求不带 ticket-guard 头 | 仍发出请求；服务端按 401/403 拒绝（Tab 模式下同场景报 AUTH_FAILED） |
| 密钥过期 | 服务端拒绝，`resp.ok=false` | options 弹 toast 提示刷新页面重新捕获；无效 ticket-guard 密钥有触发服务端登出的风险 |
| 单条网络异常 | catch 后 ok 保持 false | 记入进度 error 状态，循环继续 |
| 用户关闭弹窗 | `CANCEL_ACTIVE_TASK` | cancelled 置位；当前在途请求完成后停止（无法即时中断） |
| 逐条失败计数的双通道 | `CANCEL_DONE.failed` 为汇总真值；`CANCEL_PROGRESS.status` 为逐条实时反馈 | 循环内 `if (!ok) errors.push({ awemeId, error:"FAILED" })` 填充 errors，`refreshed = 总数 - failed`；两条通道同源于同一循环 |

## 配置项说明

| 配置 | 默认 | 作用 |
|------|------|------|
| `CONFIG.CANCEL.collection.*` | 见上文流程图 | 端点四要素；新增其他 kind（如点赞）时在此扩展并由路由放行独立分支 |
| `runtimeConfig.cancelCollectionDelayMin/Max` | 500/1000ms | 条目间延迟 |
| `browserFeatures.securityKey` | — | ticket-guard 公钥（localStorage `security-sdk/s_sdk_cert_key` 的 data 字段剥 `pub.` 前缀，由 inject 采集） |
| DNR rule 5 / rule 3 | — | Sec-Fetch-* 补齐与精确 Referer 生效的前提（见 08） |

## 相关文档

| 编号 | 文档 | 关联内容 |
|------|------|----------|
| 01 | [01-project-architecture.md](./01-project-architecture.md) | 长任务协议、browserFeatures 缓存键 |
| 05 | [05-independent-scan-collection.md](./05-independent-scan-collection.md) | 上游扫描（persistScan 落库）；同批 targets 的来源 |
| 08 | [08-dnr-rules.md](./08-dnr-rules.md) | rule 5 全文（本流程可用性的根）、rule 3 兜底关系 |
| 09 | [09-inject-tab-mode.md](./09-inject-tab-mode.md) | Tab模式 cancelOne XHR 实现、getSecurityKey、AUTH_FAILED 语义对照 |
