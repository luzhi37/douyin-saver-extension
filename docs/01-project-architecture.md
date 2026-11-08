# 01 · 项目架构

> 职责边界：描述扩展的整体分层、**双模运行**（Tab模式 / 独立模式）的路由与隔离、全仓代码布局约束、六域存储模型（五数据域 + 回顾引用域）、跨层通信协议与全局配置。所有具体业务流程（同步/扫描/校准/取消）见对应编号文档，本文不展开。

## 术语规范（全仓统一）

| 术语 | 定义 | 别名（废弃） |
|------|------|--------------|
| **Tab模式** | 页面注入脚本方式：options 发消息 → background `tabBridge.send` → content.js（隔离世界）桥接 → inject.js（主世界）借页面环境发起请求 | ~~依赖标签页模式~~ |
| **独立模式** | 纯后台逆向请求流程：background Service Worker 直接 `fetch()` 调用抖音 API，签名由 `crypto.js` 本地生成，不需要任何抖音标签页 | ~~独立运行~~ |
| **域（domain）** | 五个数据域：`works`（作品）/ `followings`（关注）/ `favorites`（点赞）/ `collections`（收藏）/ `candidates`（候选），各自独立的 store + 分组 store；另有回顾引用域 `review`（只存批次引用，不复制来源记录） | — |
| **长任务** | background 内 for 循环驱动的多请求批次（同步/扫描/取消），带进度回报与取消信号 | — |

---

## 概述

Chrome MV3 扩展，用于抓取并管理抖音作品、关注、候选、点赞、收藏数据，并提供随机回顾批次。四个运行层级：

```
inject.js (主世界)            — fetch/XHR Hook、签名捕获、按钮注入、页面内 API 请求
    ↓ CustomEvent（DY_* 事件对）
content.js (隔离世界)         — 主世界脚本加载器、requestResponse 事件桥、作品捕获 LRU 缓存
    ↓ chrome.runtime.sendMessage
background/ (ES 模块化)        — Service Worker：main.js 组合根 + 入口（消息路由 App.route、初始化）；core.js 共享基础（CONFIG/DOMAIN_CONFIG/utils/formatters/runtimeConfig）；
  identity/（Crypto/ABogus/Credentials/IndependentClient/TabBridge）+ data/（Storage/DomainStore/DomainHandlers/Groups/DataTools）+ tasks/（ScanTasks/IndependentTasks/author-works-import）；独立模式下直接 fetch API
    ↑↓ chrome.runtime.sendMessage
options/ (main.js 组合根)      — 管理 UI（ES 模块化）：core.js 共享基础（config/dom/state/store/utils/runtimeConfig/services）+ grids/components/data/sync 类模块 + main.js 事件绑定/订阅/init
```

manifest 要点：SW 为 `type: "module"`；content script 仅匹配 `*://*.douyin.com/*` 且排除 `creator.douyin.com`，`run_at: document_start`；`inject.js` 经 `web_accessible_resources` 以 `<script src>` 注入主世界（不走 `chrome.scripting` API，manifest 无 scripting 权限）；权限含 `storage / declarativeNetRequest / tabs / unlimitedStorage / cookies`。

## 核心流程图（文字描述）

### 双模消息路由（background 唯一入口）

```
chrome.runtime.onMessage (background/main.js App.route switch)
  │
  ├─ 与模式无关的数据操作 ──→ SAVE_WORKS / GET_WORKS / DELETE_WORKS / MOVE_WORKS / GET_WORKS_BY_IDS（`{ domain, ids }`）
  │                            SAVE_FOLLOWINGS / GET_FOLLOWINGS / DELETE_FOLLOWINGS / MOVE_FOLLOWINGS
  │                            SAVE_CANDIDATES / GET_CANDIDATES / DELETE_CANDIDATES / MOVE_CANDIDATES
  │                            GET_FAVORITES / DELETE_FAVORITES / MOVE_FAVORITES / GET_COLLECTIONS / DELETE_COLLECTIONS / MOVE_COLLECTIONS
  │                            GET_GROUPS / GET_DOMAIN_GROUPS / ADD_GROUP / RENAME_GROUP / DELETE_GROUP / REORDER_GROUPS
  │                            IMPORT_DATA / EXPORT_DATA / RESET_DOMAIN / GET_STATS / GET_AUTHOR_UID_SETS / RELOAD_CONFIG
  │     （作品型三域 GET_* 分页：saved 排序 page:0 经复合索引 savedAt_id / groupId_savedAt_id
  │       （DB v12，无改名迁移；升级回填缺失 savedAt/groupId/uid/createTime、回填 *_groups.count 并剔除废弃标题字段 desc）keyset 游标直出首页 + hasMore/nextCursor；
  │       cursor 以上页末条索引键（含主键，全序唯一）为开区间边界续页，免疫并发增删位移；
  │       ascending:true 改 next 方向、从最旧一端分页（「保存时间(升)」用，页序即视图序）；
  │       sort:"authorCount" 走 background 作者视图：索引键扫描构建 SW 内存视图，cursor 为
  │       { token, dir, ai, off }，page0 返回 authorMeta，页面顺序即作者簇序；
  │       page:0 首屏只物化 PAGE.GRID_FIRST(600) 条、cursor 续页 PAGE.GRID(1000) 条，
  │       无全量读取；作者域两域单发全量）
  │
  ├─ 按模式分支（读 independentClient.loadMode()）──→
  │     SYNC_WORKS          → im ? independentTasks.syncWorks         : scanTasks.syncWorks（逐条 tabBridge.sendAsync）
  │     FETCH_FOLLOWING     → im ? independentTasks.fetchFollowing   : scanTasks.fetchFollowing
  │     FETCH_COLLECTION    → im ? independentTasks.fetchCollection  : scanTasks.fetchCollection
  │     FETCH_WORKS_PAGE    → im ? independentTasks.fetchWorksPage   : tabBridge.fetchWorksPage
  │     IMPORT_USER_WORKS   → im ? independentTasks.importUserWorks   : scanTasks.importUserWorks
  │     CANCEL_COLLECTION   → im ? independentTasks.cancel           : scanTasks.runCancelBatch(CANCEL_ONE_COLLECTION)
  │     SET_COLLECTION      → im ? independentTasks.setReaction      : tabBridge.sendAsync(SET_ONE_COLLECTION)
  │
  ├─ 仅 Tab 模式（无独立分支）──→
  │     FETCH_FAVORITES      → scanTasks.fetchFavorites（独立模式不支持点赞扫描）
  │     CANCEL_FAVORITES     → scanTasks.runCancelBatch(CANCEL_ONE_FAVORITES)
  │     SET_FAVORITES        → tabBridge.sendAsync(SET_ONE_FAVORITES)（独立模式拒绝 UNSUPPORTED_INDEPENDENT）
  │     GET_SECURITY_STATUS → tabBridge.getSecurityStatus（恒走 Tab，需检查 Hook 注入）
  │
  ├─ 入库 / 校准 ──→ IMPORT_CANDIDATE → scanTasks.importCandidate（单请求收录作者档案）
  │                  CALIBRATE_FOLLOWING → scanTasks.calibrateOne(…, FOLLOWINGS)（侧栏单用户）
  │                  CALIBRATE_FOLLOWINGS → scanTasks.calibrateAll(FOLLOWINGS)（工具弹窗批量）
  │                  CALIBRATE_CANDIDATE → scanTasks.calibrateOne(…, CANDIDATES)（侧栏单用户）
  │                  CALIBRATE_CANDIDATES → scanTasks.calibrateAll(CANDIDATES)（工具弹窗批量）
  │                  RESOLVE_USER_PROFILE → scanTasks.resolveUserProfile（uid→主页链接，只读）
  │
  └─ 凭据/配置管理 ──→ SET_MODE / CAPTURE_BROWSER_FEATURES / GET_COOKIE_INFO / REFRESH_COOKIE
                       GET_BROWSER_FEATURES / REFRESH_BROWSER_FEATURES / GET_CACHE_TIMES
                       RESOLVE_SEC_UID / REFRESH_MSTOKEN / REFRESH_WEBID / CANCEL_ACTIVE_TASK
```

### 长任务通用时序

```
options 触发（如 SYNC_WORKS）
  → background 立即 ack { ok, requestId, total }（SYNC_WORKS / 取消类）
  → background 循环 handler：逐条(页)请求 → chrome.runtime.sendMessage(进度消息) → 页间随机延迟
  → 结束发完成消息（SYNC_DONE / CANCEL_DONE）或一次性返回全量结果（FETCH_* 类）
取消：options 弹窗关闭 → CANCEL_ACTIVE_TASK
       ├─ Tab 模式：background → tabBridge.find → content → DY_CANCEL_ACTIVE_TASK → inject activeTask.abort()
       └─ 独立模式：background 循环内自挂 cancelHandler 监听同名消息，置 cancelled 标志
```

### 模式标志生命周期

```
options 设置面板开关 → SET_MODE { enabled }
  → chrome.storage.local.set({ independentMode }) + setMode() 写 SW 内存缓存
  → enabled=true 时预热 ensureABogus()（构造 ABogus 实例供后续签名）
读取：independentClient.loadMode() 首次从 storage 读入并缓存到私有字段 #mode（SW 存活期内不再回读）
```

> 关键约束：**options 发出的消息类型与参数格式与模式无关**。两模式的差异完全封装在 background 路由之后，产出相同响应形状。两模式不共享算法代码、不共用缓存变量。

### 模式切换注意事项

| 场景 | 行为 |
|------|------|
| Tab → 独立 | 设置面板关闭时发 `SET_MODE`（写存储 + SW 运行态 + ABogus 预热）；不主动中止在途 Tab 循环任务 |
| 独立 → Tab | 下次走 `tabBridge.send`；无可用抖音标签页返回 `NO_DOUYIN_TAB`（状态行提示），签名缺失才弹 `showNoSignatureDialog`（见 09） |
| `savedCookie` 为空 | `independentClient.request` 抛 `NO_COOKIE`（各流程首请求即失败） |
| Cookie 过期 | 抛 `` `HTTP ${status}` `` 形态（`HTTP 401`/`HTTP 429` 前缀经 `isFatalTaskError` 判致命）；`AUTH_FAILED` 仅 Tab 模式 inject 抛出 |
| msToken 刷新失败 | 兜底随机假 token，严格端点（listcollection）403 |
| 取消信号路径差异 | Tab：options→background→content→inject；独立：background 循环内自挂监听消化 |

### 独立模式的选型依据

优点：扩展加载后立即可用（无需预浏览抖音产生签名）；无 `_dyInternal` 要解决的自污染竞争；资源消耗低（不注入、不 Hook、不观察 DOM）；时序稳定（不受 `tabBridge.send` 30s 超时约束）；SW 可独立完成整批任务，不依赖页面存活。

限制：Cookie 只认浏览器 cookie jar（不支持手动粘贴）；取消操作需 `browserFeatures.securityKey`（须曾访问 douyin.com 捕获）；**点赞扫描不支持**（favorite 端点 Turing 风控，见 05 边界说明）；安全状态面板恒依赖标签页；浏览器特征未捕获时按默认值兜底（存在指纹矛盾风险）。

## 接口 / 方法签名

### background 消息转发原语（Tab模式专用）

```js
// background/identity/tab-bridge.js TabBridge —— 定位一个可用抖音标签页（排除 creator 子域，要求 status === "complete"）
async find() -> Promise<Tab|null>

// 向抖音 tab 发消息并等待 inject 结果；生成 requestId；超时 CONFIG.TIMEOUT.REQUEST（可被 data.timeout 覆盖）
// 错误码：NO_DOUYIN_TAB / TAB_QUERY_FAILED / TIMEOUT / NO_LISTENER / EMPTY_RESPONSE
send(type, data, sendResponse) -> void   // 回调式，仅调用一次 sendResponse

// send 的 Promise 封装；background 循环 handler 中逐条/逐页请求均用此形态
sendAsync(type, data) -> Promise<{ok, error?, ...}>
```

### content.js 事件桥

```js
// 先 addEventListener(resultEvent) 再 dispatchEvent(requestEvent)，同步 handler 无需 setTimeout(0) workaround
function requestResponse(requestEvent, resultEvent, timeoutMs, buildDetail)
  -> (message, sender, sendResponse) => true|false

// BRIDGE 表：chrome 消息类型 ↔ CustomEvent 事件对 的映射（12 个条目），每项定义：
// { req: "DY_..._REQUEST", res: "DY_..._RESULT", timeout: (msg)=>ms, detail: (msg)=>{...} }
```

### 长任务链路模式

- `tabBridge.send`：生成 `requestId` 向抖音标签页发消息，等待超时 `CONFIG.TIMEOUT.REQUEST`（默认 30s，`GET_SECURITY_STATUS` 5s）；内部 `.catch()` 处理 `find()` 极端异常路径。
- `tabBridge.sendAsync`：`send` 的 Promise 封装，background 循环 handler 中逐条/逐页请求（同步/扫描/取消循环）均用此模式；独立模式 `CANCEL_COLLECTION` 由 `independentTasks.cancel` 在 background 内直接循环，不走此路径。
- `requestResponse`：content.js **先 `addEventListener(resultEvent)` 再 `dispatchEvent(requestEvent)`**，消除同步 handler 的 `setTimeout(0)` workaround 需求。

### 进度消息（background 循环 handler 直接发给 options，不经 content 转发）

| 消息类型 | 载荷 |
|----------|------|
| `SYNC_PROGRESS` | `{ requestId, index, total, status:"ok"\|"error", awemeId }` |
| `SYNC_DONE` | `{ requestId, ok, refreshed?, failed?, failedAwemeIds?, error? }` |
| `FOLLOWING_PROGRESS` | `{ collected, hasMore, total, requestId }` |
| `CALIBRATE_PROGRESS` | `{ domain, phase:"calibrate", collected, total, hasMore:false, requestId }`（工具弹窗批量校准逐条回报；domain 区分关注/候选域） |
| `FAVORITES_PROGRESS` / `COLLECTION_PROGRESS` | `{ collected, hasMore, total, requestId }` |
| `CANCEL_PROGRESS` | `{ requestId, index, total, status, awemeId }` |
| `CANCEL_DONE` | `{ requestId, ok, cancelled, refreshed, failed, failedAwemeIds, deletedIds }` |
| `IMPORT_WORKS_PROGRESS` | `{ requestId, collected, saved, total, hasMore }`（IMPORT_USER_WORKS 作者作品分页入库过程回报） |
| `IMPORT_PROGRESS` | `{ domain, processed, total }`（IMPORT_DATA 作品域分块落库逐块回报） |

## 消息类型总表（App.route 全量分发）

> 本表自 AGENTS.md「消息协议」迁入（2026-10-03 瘦身）。`App.route()`（`background/main.js`）switch 分发所有 `chrome.runtime.sendMessage`。

| 类别                       | 消息类型                                                                                                                                                                                                                                                                                         |
|----------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 数据操作                   | `SAVE_WORKS` / `GET_WORKS` / `DELETE_WORKS` / `MOVE_WORKS` / `SYNC_WORKS` / `GET_WORKS_BY_IDS`（bulk 广播收口的补拉通道 + 侧边栏作品域存在性批量判据，见 docs/11）/ `GET_RANDOM_RECORDS`（`{ domain, groupId:"all", count, excludeIds? }`：随机回顾按主键抽样，返回 `items/poolSize/eligible/remaining`；不写存储、不广播）/ `GET_REVIEW`（`{ groupId }`：回顾引用回源 hydration）/ `SAVE_REVIEW_BATCH`（`{ sourceDomain, sourceIds, groupId, append? }`：缺省替换回顾批次；`append:true` 按 sourceId 去重后追加到目标分组，受 500 条上限约束，跨来源域拒绝，只写引用）/ `DELETE_REVIEW` / `MOVE_REVIEW`（按 `sourceDomain + sourceIds` 删除/移动回顾引用，不触碰源域） / `SAVE_FOLLOWINGS` / `GET_FOLLOWINGS` / `DELETE_FOLLOWINGS` / `MOVE_FOLLOWINGS` / `SAVE_CANDIDATES` / `GET_CANDIDATES` / `DELETE_CANDIDATES` / `MOVE_CANDIDATES` / `GET_FAVORITES` / `DELETE_FAVORITES` / `MOVE_FAVORITES` / `GET_COLLECTIONS` / `DELETE_COLLECTIONS` / `MOVE_COLLECTIONS`（favorites/collections 无独立保存消息，落库经 `SAVE_WORKS`/`persistScan`）；作品型三域 `GET_*` 必须分页（`page:0` 首页 / `cursor` keyset 续页 / `ascending:true` 升序取数（保存时间(升)用，页序即视图序），缺省分页参数返回 `BAD_PARAMS`，机制见本册「接口 / 方法签名」）；`sort:"authorCount"` + `direction:"desc|asc"` 走 background 作者视图（page0 附 `authorMeta`，续页 cursor 为 `{ token, dir, ai, off }`；错误码 `VIEW_EXPIRED` / `BAD_CURSOR` / `AUTHOR_VIEW_INCOMPLETE`；视图为 SW 内存快照，写入使 rev 前进后旧游标失效）；作者域（followings/candidates）`GET_*` 单发全量 |
| 分组管理                   | `GET_GROUPS` / `GET_DOMAIN_GROUPS`（`{ domain }`：只读对应 `*_groups` 一张小表，返回 `{ groups, counts, total }`，O(分组数)；计数为分组记录的 `count` 字段，由 `putBatch/deleteBatch/clear` 与数据写入同事务维护，升级 v11 时回填） / `ADD_GROUP` / `RENAME_GROUP` / `DELETE_GROUP` / `REORDER_GROUPS`                                                                                                                                                                                                                  |
| 工具                       | `IMPORT_DATA` / `EXPORT_DATA` / `RESET_DOMAIN` / `GET_STATS`（`{ domain }` 只统计该域分组计数、`{ bytesOnly:true }` 只回存储字节；两者均缺省返回 `BAD_PARAMS`，不再提供全域快照；分组 tab 的原子快照见 `GET_DOMAIN_GROUPS` 与 docs/11）/ `GET_AUTHOR_UID_SETS`（关注/候选两域主键集，`getAllKeys` 不物化记录，作品卡作者状态 chip 用，见 docs/11）/ `GET_AUTHOR_BY_UID`（`{ uid }`：关注/候选两域按主键各取一条作者档案；侧栏作者头在作品摘要缺头像/统计时跨域补齐，见 docs/11）/ `GET_RECORD_STATUS`（`{ awemeId, uid }`：抖音标签页保存按钮状态角标；works/candidates 两域主键直读，不物化整域，返回 `work: { exists }` 与 `author: { uid, candidate }`，不解析分组，见 docs/09）/ `GET_SECURITY_STATUS` / `CALIBRATE_FOLLOWING`（关注域单用户校准，见 docs/04）/ `CALIBRATE_FOLLOWINGS`（工具弹窗批量校准关注域，见 docs/04）/ `CALIBRATE_CANDIDATE`（候选域单用户校准）/ `CALIBRATE_CANDIDATES`（工具弹窗批量校准候选域）/ `SET_MODE` / `CAPTURE_BROWSER_FEATURES` / `GET_COOKIE_INFO` / `GET_BROWSER_FEATURES` / `GET_CACHE_TIMES` / `RESOLVE_SEC_UID` / `RESOLVE_USER_PROFILE` / `REFRESH_MSTOKEN` / `REFRESH_WEBID` / `REFRESH_BROWSER_FEATURES` / `REFRESH_COOKIE` / `RELOAD_CONFIG` |
| 扫描入口                   | `FETCH_FOLLOWING` / `FETCH_FAVORITES` / `FETCH_COLLECTION` — options 触发 background 循环扫描、逐页透传进度（同步与校准已分离，`FETCH_FOLLOWING` 收集后不再自动校准，见 docs/04）                              |
| 入库                       | `IMPORT_USER_WORKS` / `IMPORT_CANDIDATE` — 作者作品分页入作品域 + 作者档案单请求入候选域，均双模支持（分组/去重语义见 docs/07）；过程消息 `IMPORT_WORKS_PROGRESS`。入口为菜单「工具」弹窗（`AuthorImport`） |
| uid 反查主页               | `RESOLVE_USER_PROFILE { uid }` — 工具弹窗只读短请求：数字 uid 经 `profile/other` 的 `user_id` 分支换 `sec_uid` 并拼主页链接，双模（独立直连 / Tab 转发），不落库、不广播；错误统一 toast（含 `NO_SIGNATURE`/`NO_DOUYIN_TAB`，不走签名引导弹窗） |
| 清理                       | 工具弹窗三个按钮（`AuthorImport`）：①点赞/收藏域未关注作品：`GET_FOLLOWINGS { groupId:"all" }` 建关注全集 + `GET_FAVORITES`/`GET_COLLECTIONS`（`groupId:"all"`、`page:0` + keyset `cursor` 逐页、只留 awemeId）筛 `uid` 不在全集的作品 → 确认后 `GET_GROUPS`/`ADD_GROUP`（缺「稍后删除」时建组）+ `MOVE_FAVORITES`/`MOVE_COLLECTIONS` 移入；无 `uid` 作品不参与判定，关注域为空时拒绝执行。②候选域已关注作者（原候选域「同步」按钮功能，2026-11-05 迁入）：同一关注全集 + `GET_CANDIDATES { groupId:"all" }` 本地重叠比对 → 确认后 `MOVE_CANDIDATES` 移入「稍后删除」，判定口径同①（已在该组不重复计入）。候选域「同步」按钮改为与回顾域一致的指引 toast |
| 存储广播                   | `STORE_CHANGED { domain, upserts?, addedIds?, changedIds? }` — 落库成功后 background 广播（发送方可能是抖音标签页等外部上下文），**仅在 `changed>0` 时发**（no-op 不广播）。两种载荷：**point**（作品型三域的单发保存/状态切换，`changed ≤ BROADCAST.UPSERTS_MAX`=8 时附带合并后记录 `upserts` 与新增 id 集 `addedIds`）；**bulk**（入库循环收尾等批量变化，附带轻量 id 集 `changedIds`/`addedIds`——禁止改回全量记录载荷防消息膨胀；关注/候选域无载荷，options 整域重载）。载荷语义见 [docs/10](./10-storage-write-and-import.md)；options 侧去抖/flush/头插收口管线与红线见 [docs/11](./11-options-ui.md)「STORE_CHANGED 增量收口」 |
| 取消入口                   | `CANCEL_FAVORITES` / `CANCEL_COLLECTION` — options 触发 background 批量取消：tab 模式逐条派发 `CANCEL_ONE_*` 到 inject；独立模式仅 `CANCEL_COLLECTION` 在 background 循环 POST（细节见 docs/06）                                                                                                     |
| 单作品状态切换             | `SET_FAVORITES` / `SET_COLLECTION { awemeId, active, work? }` — 侧边栏作品卡 ♥/★ 点击：远端设置成功后才把作品写入对应域（active=true）或删本地记录（false）；tab 模式派发 `SET_ONE_FAVORITES` / `SET_ONE_COLLECTION`，独立模式仅收藏直连 POST（`action=1/0`），点赞返回 `UNSUPPORTED_INDEPENDENT` |
| 取消信号                   | `CANCEL_ACTIVE_TASK` — tab 模式下经 options→background→content→inject 触发 `activeTask.abort()`；独立模式下直接在 background 取消循环。弹窗关闭路径仅在存在 `state.activeDialog` 时发送；各长任务入口（同步/扫描/入库/校准）也会先发一次清残留任务 |
| Tab 转发（background→tab） | `FETCH_WORK_DETAIL` / `FETCH_FOLLOWING_PAGE` / `FETCH_PROFILE_OTHER`（`{ secUid? , uid? }` 二选一，`uid` 走 `user_id` 分支）/ `FETCH_FAVORITES_PAGE` / `FETCH_COLLECTION_PAGE` / `CANCEL_ONE_FAVORITES` / `CANCEL_ONE_COLLECTION` / `SET_ONE_FAVORITES` / `SET_ONE_COLLECTION` / `FETCH_WORKS_PAGE` / `GET_SECURITY_STATUS`（tab 模式经 content→inject；独立模式由 background 直接请求（GET/POST 按端点），见 docs/07） |
| 进度消息                   | `SYNC_PROGRESS` / `FOLLOWING_PROGRESS` / `CALIBRATE_PROGRESS`（工具弹窗批量校准逐条回报，见 docs/04）/ `FAVORITES_PROGRESS` / `COLLECTION_PROGRESS` / `IMPORT_WORKS_PROGRESS` / `CANCEL_PROGRESS` / `CANCEL_DONE`（载荷含 `deletedIds`：取消成功条目已同步删除该域本地记录）/ `IMPORT_PROGRESS`（IMPORT_DATA 分块落库逐块回报） — 由 background 循环 handler 直接发出到 options，不再经 content.js 转发                                                                                                |

> 长任务链路原语（`tabBridge.send`/`sendAsync`/`requestResponse`）与同步/扫描/取消的完整链路、时序差异、分页参数见本册「接口 / 方法签名」与 docs/02–09 各分册。

## 关键代码片段

### 模式分支路由（background/main.js 消息 switch 内）

```js
case "SYNC_WORKS":
  return utils.asyncHandler(async () => {
    const im = await independentClient.loadMode();
    if (im) return independentTasks.syncWorks(message.awemeIds, sendResponse);
    return scanTasks.syncWorks(message.awemeIds, sendResponse);
  }, sendResponse);
```

### TabBridge.send（超时后主动杀灭 inject 在途任务）

```js
const timer = setTimeout(() => {
  if (called) return;
  called = true;
  sendResponse({ ok: false, error: "TIMEOUT" });
  // 超时后中止 inject.js 中的活跃任务，避免其继续运行产生后续回调
  chrome.tabs.sendMessage(tab.id, { type: "CANCEL_ACTIVE_TASK" }).catch(() => {});
}, timeoutMs);
```

### Service Worker 保活（唯一的长空闲窗口）

共享实现：`background/core.js` 的 `utils.pauseWithKeepalive(index, total, delayKind)`。

- `index >= total - 1`（末条）直接返回：末条之后没有下一次请求，批次暂停与条间节流都无意义；
- 每完成 `BATCH_SIZE` 条暂停 `BATCH_PAUSE_MIN~MAX` 秒；暂停拆分为 `KEEPALIVE_INTERVAL` 段，每段以一次 `chrome.storage.local.get` 重置 SW 空闲计时器；
- 非批次边界执行 `runtimeConfig.randomDelay(delayKind)` 的条间随机延迟；
- 其余循环每次延迟前均有 `chrome.*` 调用，无需额外 keepalive。

## 代码布局约束（全仓 JS 强制）

1. **从上到下、先声明后使用**。config/const 必须在文件最顶部；执行语句不得出现在声明之前。
2. **class 定义与实例化成对出现**——类定义后紧跟 `const name = new Class()`，不允许先集中列出所有 class 再集中实例化。
3. 大段分隔用边框注释 `// ---------- 标签 ----------`。
4. options/core.js 顶层集中定义并 export `config / dom / state / store / utils / runtimeConfig / services`，所有类模块经 ES import 引用这些模块级变量；类内部自引用必须用 `this.xxx()`，不得用单例变量名。
5. 私有方法使用 `#` 语法；**class field 箭头函数仅用于 add/remove 对称的事件回调**（如 `Sidebar.#onResizeDown/Move/Up`）。
6. options/main.js 组合根启动打印 `[DDM] options build …` 构建标记，用于排查用户端跑旧构建。

## 六域存储模型（五数据域 + 回顾引用域）

### IndexedDB（data/storage.js 封装，库名 `douyin-saver`，DB_VERSION = 12；无改名迁移——低版本旧库升级前须先在旧版导出备份）

| store | keyPath | 索引 | 内容 |
|-------|---------|------|------|
| `works` | `awemeId` | `groupId` / `savedAt_id` / `groupId_savedAt_id` / `groupId_uid_sort` | `{ [awemeId]: Work }` |
| `works_groups` | `id` | — | `[{ id, name, fixed, order?, count }]`（count 为派生计数，随数据写入同事务维护） |
| `favorites` | `awemeId` | `groupId` / `savedAt_id` / `groupId_savedAt_id` / `groupId_uid_sort` | `{ [awemeId]: Work }`（与 works 同构） |
| `favorites_groups` | `id` | — | 同 groups 结构（含 count） |
| `collections` | `awemeId` | `groupId` / `savedAt_id` / `groupId_savedAt_id` / `groupId_uid_sort` | `{ [awemeId]: Work }`（与 works 同构） |
| `collections_groups` | `id` | — | 同 groups 结构（含 count） |
| `followings` | `uid`（字符串化） | `groupId` | `{ [uid]: Following }` |
| `followings_groups` | `id` | — | 同 groups 结构（含 count） |
| `candidates` | `uid`（字符串化） | `groupId` | `{ [uid]: Candidate }`（复用 Following 7 字段） |
| `candidates_groups` | `id` | — | 同 groups 结构（含 count） |
| `review` | `reviewId` | `groupId` | `{ [reviewId]: ReviewRef }`（只存批次引用：`sourceDomain/sourceId/kind/groupId/addedAt`） |
| `review_groups` | `id` | — | 同 groups 结构（含 count） |

`DOMAIN_CONFIG` 是六个域的统一描述：

```js
DOMAIN_CONFIG = {
  works:      { storeName, groupsName, defaultGroups, itemKey: "works",      idField: "awemeId" },
  followings: { storeName, groupsName, defaultGroups, itemKey: "followings", idField: "uid", idToString: true },
  favorites:  { storeName, groupsName, defaultGroups, itemKey: "favorites",  idField: "awemeId" },
  collections:{ storeName, groupsName, defaultGroups, itemKey: "collections",idField: "awemeId" },
  candidates: { storeName, groupsName, defaultGroups, itemKey: "candidates", idField: "uid", idToString: true },
  review:     { storeName, groupsName, defaultGroups, itemKey: "reviewItems", idField: "reviewId" },
}
```

`domainStore.facade(domain)` 返回域封装（get/getBatch/getAllKeys/putBatch/deleteBatch/count/countByGroup/getGroups + idField，条目收敛为调用方实际消费集合，无消费的包装不设）；分组写入由 `storage.putGroups` 采用"clear() + 逐条 put()"实现"覆盖数组"语义；`countByIndex` 只做索引计数不反序列化整表。

### Work 记录字段（formatWork / normalizeWork 共同产出）

`awemeId, type("video"|"note"), nickname, uid, authorHomeUrl, cover, video, videoExpireAt, images[], imageVideos[]（与 images 逐位对位；图集实况小视频，无视频项空串）, music, createTime（抖音发布时间，秒级 Unix 时间戳；卡片作者行右侧与详情底栏作品 ID 链接右侧展示。fiber 捕获路径的原始对象缺 create_time，采集与落库均按 aweme_id 高 32 位推导兜底，mergeWork 恒保证非零）`

封面语义：视频 `cover`=封面档；图集 `cover`=平台封面（`video.cover`）优先、回退首图——卡片展示「取轻」与详情首帧占位链见 [02](./02-independent-sync-works.md) / [11](./11-options-ui.md)。内容项实况视频 `imageVideos[]` 与 `images[]` 逐位对位（图集每条可为静帧+小视频），详情切条自动单次播放见 [11](./11-options-ui.md)；注意 note 的 aweme 级 `video` 实为背景音乐（M4A，与 `music.play_url.uri` 同文件），不参与内容播放。视频直链三级取链语义见 [02](./02-independent-sync-works.md) / [09](./09-inject-tab-mode.md)。落库合并规则（groupId/savedAt 保护、长效链降级防护、导入分组对账等**全部写入路径语义**）统一见 [10](./10-storage-write-and-import.md)，本文只维护字段模型。

### 作者记录字段（Following / Candidate 共用 7 个稳定字段）

`uid, nickname, avatarLarger, followerCount, awemeCount, profileUrl, lastUpdateAt`

`followerCount / awemeCount` **由 profile/other 校准写入**（列表接口计数为滞后快照，采集时占位 0；导入快照 >0 时也按快照写入）；`lastUpdateAt`（最近更新日期，毫秒时间戳）**由校准阶段取作品第一页 max(create_time) 写入**（秒→毫秒；导入快照 >0 时同样写入），未校准占位 0；`nickname / avatarLarger` 同步时按列表接口快照写入，**改名/换头像靠校准以 profile/other 权威值覆盖**（非空才覆盖，见 [04](./04-independent-calibrate-followings.md)）。落库时的 0 值保护、同批保序与丢失检测见 [10](./10-storage-write-and-import.md)。

`candidates` 为扩展自建候选作者域：记录字段与 followings 完全一致，但数据来源仅限链接收录、关注域批量入库与手动校准；不参与账号关注列表同步、丢失检测或自动迁移。见 [03](./03-independent-sync-followings.md) / [10](./10-storage-write-and-import.md) / [11](./11-options-ui.md)。

### chrome.storage.local 键表

| Key | 类型 | 写入者 | 说明 |
|-----|------|--------|------|
| `savedMsToken` + `savedMsTokenTime` | string + number | getMsToken / REFRESH_MSTOKEN / 页面加载自动刷新 | 独立模式 msToken 缓存，无过期逻辑 |
| `savedWebId` + `savedWebIdTime` | string + number | getWebId / REFRESH_WEBID / 页面加载自动刷新 | 设备身份缓存 |
| `savedCookie` + `savedCookieTime` | string + number | REFRESH_COOKIE / 页面加载自动刷新 | douyin.com cookie jar 全量字符串快照；门禁与 UIFID/uid 提取源 |
| `browserFeatures` + `browserFeaturesTime` | object + number | CAPTURE_BROWSER_FEATURES / REFRESH_BROWSER_FEATURES | 浏览器特征指纹（含 securityKey） |
| `independentMode` | boolean | SET_MODE | 模式开关 |
| `secUid` | string | options 设置面板 `saveBeforeClose` 关闭面板时一次性写入 | 独立模式目标用户 |
| `runtimeConfig` | object | options 设置面板保存 → RELOAD_CONFIG | 运行参数（见配置项说明） |
| `randomReviewConfig` | object | `RandomReview.#applyConfig` | 回顾域上次来源域与抽取数量（`{ sourceDomain, count }`） |

### 设置/状态面板与凭据缓存刷新链

设置面板含运行参数区（独立模式开关 + secUid 输入 + 缓存列表 + 延迟/超时参数）；Cookie 配置、浏览器特征、Tab 模式捕获状态三个只读 section 位于「状态」面板（2026-11-08 自设置迁出）。缓存列表各项的「刷新」按钮经 `TYPE_MAP = { cookie:"COOKIE", mstoken:"MSTOKEN", webid:"WEBID", browser_features:"BROWSER_FEATURES" }` 映射为消息：

| 面板项 | 消息 | 行为 |
|--------|------|------|
| cookie | `REFRESH_COOKIE` | 重采 `chrome.cookies.getAll({domain:"douyin.com"})` 全量存 `savedCookie` |
| mstoken | `REFRESH_MSTOKEN` | 删缓存重走五级来源（jar 无值必触发一次 mssdk 兑换，见 05） |
| webid | `REFRESH_WEBID` | 删缓存重兑换并回写 webid cookie |
| browser_features | `REFRESH_BROWSER_FEATURES` | 需抖音标签页在线：`REQUEST_CAPTURE_BROWSER_FEATURES` 强制重采（链路见 09） |

**自动刷新时机（页面加载驱动）**：每次抖音页面加载，inject 启动即采集浏览器特征经 `CAPTURE_BROWSER_FEATURES` 落库；`Credentials.captureBrowserFeatures` 重建 ABogus 后 fire-and-forget 调 `#autoRefreshCredentials()`——先刷 cookie 快照，再并行刷 msToken / webid，与上表手动刷新完全同链路（仅 sendResponse 缺省、静默执行）。不判断独立模式开关；cookie→msToken 的先后保证快照先落库（msToken 第二来源与 UIFID/odin_tt 兜底都读它）。

另有两个非刷新入口：`GET_CACHE_TIMES`（四项时间戳展示）、`GET_COOKIE_INFO`（解析 savedCookie 为键值对 + sessionid 存在性检查）。

## 异常场景及处理

### 错误分类（长任务）

| 类别 | 错误码 | 处理 |
|------|--------|------|
| 致命（终止整批） | `NO_DOUYIN_TAB` / `TAB_QUERY_FAILED` / `NO_LISTENER` / `EMPTY_RESPONSE` / `RATE_LIMITED` / `CANCELLED`，HTTP 401/429 | `CONFIG.FATAL_ERRORS.has(err)` 判定，剩余条目记 `BATCH_TERMINATED` |
| 非致命（跳过当前继续） | `TIMEOUT`、HTTP 403/5xx、`status_code` 非零、网络异常、`DELETED` | 记入 errors，继续下一条 |

### 其他全局异常路径

- `tabBridge.send` 超时后向 inject 补发 `CANCEL_ACTIVE_TASK`，防止僵尸任务在后台继续产生回调。
- 独立模式凭据缺失：`savedCookie` 为空 → `independentClient.request` 抛 `NO_COOKIE`（不在 `FATAL_ERRORS`，非致命、逐条记入 errors）；Cookie 过期 → 抛 `` `HTTP ${status}` ``（`HTTP 401`/`HTTP 429` 前缀判致命，403 等非致命）。`AUTH_FAILED` 仅 Tab 模式（inject XHR）抛出。
- 所有 `chrome.runtime.sendMessage` 进度发送均 `.catch(() => {})`——options 未开页时静默丢弃，不影响循环。
- DNR 注册失败：`setupDeclarativeNetRequest` 捕获后仅 `console.warn`，不阻塞启动（后果见 08 文档）。

## 配置项说明

### background/core.js `CONFIG`（编译期默认值，部分被 runtimeConfig 覆盖）

| 分组 | 键 |
|------|----|
| TIMEOUT | `REQUEST:30000` / `SECURITY_STATUS:5000` |
| DELAY | 七类任务各 `{MIN:500, MAX:1000}`：syncWorks / syncFollowings / syncFavorites / syncCollection / cancelFavorites / cancelCollection / importWorks |
| SYNC | `BATCH_SIZE:40` / `BATCH_PAUSE_MIN/MAX:10000/20000` / `KEEPALIVE_INTERVAL:2000` / `RETRY_MAX:2` |
| PAGE | 各列表端点页大小，均 20（FAVORITE/COLLECTION/POST/FOLLOWING）；`GRID: 1000`（网格渐进加载续页大小，keyset 游标串行依赖上一页末键；较 2000 减半把单页反序列化长任务切碎，配合 options 侧首屏错峰）/ `GRID_FIRST: 600`（网格首屏页大小，= options 侧活动 DOM 上限 GRID_MOUNT_MAX：首帧只等铺满活动窗口的条数，余页按 GRID 续传） |
| IMPORT_CHUNK | `2000`（导入分块落库块大小：单事务 10 万级 put 长时间独占 SW 的 IDB，按块 mergeAndSave + IMPORT_PROGRESS 逐块回报） |
| GROUPS | `ID_PREFIX:"custom_"` / `DEFAULT_ID:"uncategorized"` |
| STORAGE_KEYS | 六域 store 与分组名常量（12 键，唯一来源） |
| BROADCAST / AUTHOR_VIEW_CACHE_MAX / AWEME_TYPE_NOTE | `UPSERTS_MAX:8`（point 载荷阈值）/ `3`（作者视图 LRU 上限）/ `68`（图集类型码） |
| FATAL_ERRORS | 致命错误集合（见上表） |
| WEB_SIGN_SALT | Argus webSign 盐（见 05） |
| CANCEL.collection | 取消收藏端点四要素 url/body/type/referrer |
| API | FOLLOWING / PROFILE_OTHER / COLLECTION / DETAIL / POST 五个端点路径 |
| MSSDK / WEBID_API / WEBID_QUERY | msToken 兑换与 webid 兑换常量 |

### `runtimeConfig`（chrome.storage.local，设置面板可改，RELOAD_CONFIG 热加载进 CONFIG）

键与 CONFIG 一一对应加 Min/Max 后缀：`timeoutRequest / timeoutSecurityStatus / syncWorksDelayMin..Max / … / syncBatchSize / syncBatchPauseMin..Max / syncKeepaliveInterval / syncRetryMax`（默认值同上表）。SW 冷启动（background `App.init`）补一次 `runtimeConfig.reload()`，全部运行参数随存随恢复，重开扩展（非重载）不回退编译期默认值。

### options/core.js 顶层 `config`（UI 侧，64 键，权威键表）

| 分组       | 键（默认值）                                                                                                                                                  |
|------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 视频重试   | `VIDEO_RETRY_DELAYS` `[200,400,600]` / `VIDEO_RETRY_MAX` `3` / `VIDEO_RETRY_FALLBACK_DELAY` `1000`                                                            |
| 媒体熔断   | `MEDIA_FAIL_WINDOW` `5000` / `MEDIA_FAIL_MAX` `10` / `MEDIA_BREAK_COOLDOWN` `15000`                                                                           |
| 超时       | `FETCH_RETRY_DELAY` `1000` / `VIDEO_FALLBACK_TIMEOUT` `5000`                                                                                                  |
| 详情页     | `TOAST_DURATION` `2000` / `TOAST_ERROR_DURATION` `4500` / `DOWNLOAD_MAX_RETRY` `1`                                              |
| UI 延迟    | `HOVER_PREVIEW_DELAY` `200` / `BLOB_REVOKE_DELAY` `10000` / `NOTE_AUTO_PLAY_INTERVAL` `3000`                                        |
| 侧边栏     | `SIDEBAR_CARD_SIZE` `210` / `SIDEBAR_GRID_GAP` `6` / `SIDEBAR_GRID_PADDING` `8` / `SIDEBAR_MAIN_GRID_MIN` `195` / `SIDEBAR_SCROLL_THRESHOLD` `100` / `SIDEBAR_FILL_THRESHOLD` `50` / `SIDEBAR_IMG_PER_FRAME` `6` / `SIDEBAR_DRAG_THRESHOLD` `4` |
| 网格项尺寸 | `CARD_SIZE_FALLBACK` `261` / `CARD_GAP` `11` / `CARD_HEIGHT_OFFSET` `30` / `CARD_SIZE_BAND_MIN` `0.94` / `CARD_SIZE_BAND_MAX` `1.06`（自适应卡宽容差带，作者域默认）/ `WORK_CARD_SIZE_BAND_MIN` `0.9` / `WORK_CARD_SIZE_BAND_MAX` `1.1`（作品卡专用带 ±10%，WorksGrid 经构造参数按实例覆盖） |
| 分块渲染   | `RENDER_CHUNK_SIZE` `50` / `RENDER_BUILD_BUDGET_MS` `8` / `OBSERVER_ROOT_MARGIN` `'1600px'`（≈4 行，须 < OBSERVE_CHUNK_SIZE 单圈行距） / `OBSERVE_CHUNK_SIZE` `48` / `FILL_FRAME_BUDGET_MS` `8` / `UNLOAD_ROOT_MARGIN` `'2400px'`（≈6 行，与填充圈保持 800px 滞回间隙） / `FAST_SCROLL_THRESHOLD` `300` / `GRID_PREMOUNT_CAP` `1500` / `GRID_PREMOUNT_CAP_FILTER` `600`（筛选态首帧同步预铺降档，余量行尾部占位预留） / `GRID_MOUNT_MAX` `600`（活动 DOM 硬上限：预铺与分页追加都封顶，滚远由头部回收 + 整窗重挂维持恒定） / `GRID_EXTEND_THRESHOLD` `1.5` / `GRID_EXTEND_STEP` `1000`（扩容单步新增槽位上限，防深域后段单步长任务） / `GRID_EXTEND_JUMP_STEP` `4000`（远跳带区追赶单步上限：拖拽跳进尾部占位区后逐帧直铺防长冻结） / `DEMOTE_FRAME_BUDGET_MS` `8`（停稳降级分帧预算） / `GRID_IMG_PER_FRAME` `10`（网格媒体探针每帧派发配额，sidebar 沿用 `SIDEBAR_IMG_PER_FRAME`） |
| 分组/存储  | `GROUP_NAME_MAX_LEN` `20` / `STORAGE_MAX_BYTES` `10MB` / `TRASH_GROUP_NAME` `'稍后删除'`                                                                      |
| 随机回顾   | `RANDOM_REVIEW_DEFAULT_COUNT` `20` / `RANDOM_REVIEW_MAX_COUNT` `500` / `RANDOM_REVIEW_MAX_EXCLUDE` `2000`                                                                      |
| 作者数分页 | `AUTHOR_COUNT_PAGING` `true`（回滚开关：关闭后 options 不再发送 `sort=authorCount`）                                                                      |
| Tab 滚动   | `TAB_SCROLL_THRESHOLD` `2`                                                                                                                                    |
| 抖音 URL   | `URL_BASE` / `URL_USER_SELF` / `URL_FAVORITE_TAB` / `URL_COLLECTION_TAB` / `URL_FOLLOWING_TAB`                                                                    |
| 域元数据   | `WORK_RECORD_DOMAINS` `['works','favorites','collections']` / `AUTHOR_RECORD_DOMAINS` `['followings','candidates']` / `REVIEW_DOMAIN` `'review'` / `SOURCE_DOMAINS`（五个来源域）/ `DOMAINS_META`（六域 label/itemKey/idKey/isAuthorRecord）                                                 |
| 正则/图标  | `SEC_UID_REGEX` `/^\/user\/([^/?]+)/` / `icons` `{}`（init 填充）                                                                                             |

## 相关文档

| 编号 | 文档 | 关联内容 |
|------|------|----------|
| 02 | [02-independent-sync-works.md](./02-independent-sync-works.md) | SYNC_WORKS 独立模式分支全链路 |
| 03 | [03-independent-sync-followings.md](./03-independent-sync-followings.md) | FETCH_FOLLOWING 独立模式分支 |
| 04 | [04-independent-calibrate-followings.md](./04-independent-calibrate-followings.md) | calibrateStats / CALIBRATE_FOLLOWING |
| 05 | [05-independent-scan-collection.md](./05-independent-scan-collection.md) | FETCH_COLLECTION 独立模式分支 + webSign |
| 06 | [06-independent-cancel-collection.md](./06-independent-cancel-collection.md) | CANCEL_COLLECTION 独立模式分支 |
| 07 | [07-independent-fetch-user-works.md](./07-independent-fetch-user-works.md) | FETCH_WORKS_PAGE 双模分支 |
| 08 | [08-dnr-rules.md](./08-dnr-rules.md) | 全部 DNR 动态规则与注册时机 |
| 09 | [09-inject-tab-mode.md](./09-inject-tab-mode.md) | Tab模式注入侧完整技术方案 |
| 10 | [10-storage-write-and-import.md](./10-storage-write-and-import.md) | 落库合并/计数保护/丢失检测/导入分组对账的写入路径语义 |
| 13 | [13-design-red-lines.md](./13-design-red-lines.md) | 设计红线与知识点陷阱完整版（自 AGENTS.md 迁出） |
| — | [TIKTOK_REFERENCE.md](./TIKTOK_REFERENCE.md) | 参考项目算法/凭据对照与 API 端点总表 |
