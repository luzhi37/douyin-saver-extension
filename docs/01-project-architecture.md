# 01 · 项目架构

> 职责边界：描述扩展的整体分层、**双模运行**（Tab模式 / 独立模式）的路由与隔离、全仓代码布局约束、四域存储模型、跨层通信协议与全局配置。所有具体业务流程（同步/扫描/校准/取消）见对应编号文档，本文不展开。

## 术语规范（全仓统一）

| 术语 | 定义 | 别名（废弃） |
|------|------|--------------|
| **Tab模式** | 页面注入脚本方式：options 发消息 → background `sendToTab` → content.js（隔离世界）桥接 → inject.js（主世界）借页面环境发起请求 | ~~依赖标签页模式~~ |
| **独立模式** | 纯后台逆向请求流程：background Service Worker 直接 `fetch()` 调用抖音 API，签名由 `crypto.js` 本地生成，不需要任何抖音标签页 | ~~独立运行~~ |
| **域（domain）** | 数据域：`works`（作品）/ `followings`（关注），各自独立的 store + 分组 store + 处理器组 | — |
| **长任务** | background 内 for 循环驱动的多请求批次（同步/扫描/取消），带进度回报与取消信号 | — |

---

## 概述

Chrome MV3 扩展，用于抓取并管理抖音作品、关注、点赞、收藏数据。四个运行层级：

```
inject.js (主世界)            — fetch/XHR Hook、签名捕获、按钮注入、页面内 API 请求
    ↓ CustomEvent（DY_* 事件对）
content.js (隔离世界)         — 主世界脚本加载器、requestResponse 事件桥、作品捕获 LRU 缓存
    ↓ chrome.runtime.sendMessage
background/ (ES 模块化)        — Service Worker：main.js 组合根 + 入口（消息路由 App.route、初始化）；core.js 共享基础（CONFIG/DOMAIN_CONFIG/utils/formatters/runtimeConfig）；
  identity/（Crypto/ABogus/Credentials/IndependentClient/TabBridge）+ data/（Storage/DomainStore/DomainHandlers/Groups/DataTools）+ tasks/（ScanTasks/IndependentTasks）；独立模式下直接 fetch API
    ↑↓ chrome.runtime.sendMessage
options/ (main.js 组合根)      — 管理 UI（ES 模块化）：core.js 共享基础（config/dom/state/store/utils/runtimeConfig/services）+ grids/components/data/sync 类模块 + main.js 事件绑定/订阅/init
```

manifest 要点：SW 为 `type: "module"`；content script 仅匹配 `*://*.douyin.com/*` 且排除 `creator.douyin.com`，`run_at: document_start`；`inject.js` 经 `web_accessible_resources` 以 `<script src>` 注入主世界（不走 `chrome.scripting` API，manifest 无 scripting 权限）；权限含 `storage / declarativeNetRequest / tabs / unlimitedStorage / cookies`。

## 核心流程图（文字描述）

### 双模消息路由（background 唯一入口）

```
chrome.runtime.onMessage (background/main.js App.route switch)
  │
  ├─ 与模式无关的数据操作 ──→ SAVE_WORKS / GET_WORKS / DELETE_WORKS / MOVE_WORKS / GET_WORKS_BY_IDS
  │                            SAVE_FOLLOWINGS / GET_FOLLOWINGS / DELETE_FOLLOWINGS / MOVE_FOLLOWINGS
  │                            GET_GROUPS / ADD_GROUP / RENAME_GROUP / DELETE_GROUP / REORDER_GROUPS
  │                            IMPORT_DATA / EXPORT_DATA / RESET_DOMAIN / GET_STATS / RELOAD_CONFIG
  │     （作品型三域 GET_* 分页：page:0 经复合索引 savedAt_id / groupId_savedAt_id
  │       （DB v5，无改名迁移；升级回填缺失 savedAt/groupId）keyset 游标直出首页 + hasMore/nextCursor；
  │       cursor 以上页末条索引键（含主键，全序唯一）为开区间上界续页，免疫并发增删位移；
  │       省略 page/cursor = 一次性全量。每次只物化 PAGE.GRID 条，无全量读取）
  │
  ├─ 按模式分支（读 independentClient.loadMode()）──→
  │     SYNC_WORKS          → im ? independentTasks.syncWorks         : scanTasks.syncWorks（逐条 tabBridge.sendAsync）
  │     FETCH_FOLLOWING     → im ? independentTasks.fetchFollowing   : scanTasks.fetchFollowing
  │     FETCH_COLLECTION     → im ? independentTasks.fetchCollection   : scanTasks.fetchCollection
  │     FETCH_WORKS_PAGE    → im ? independentTasks.fetchWorksPage   : tabBridge.fetchWorksPage
  │     CANCEL_COLLECTION    → im ? independentTasks.cancel           : scanTasks.runCancelBatch(CANCEL_ONE_COLLECTION)
  │
  ├─ 仅 Tab 模式（无独立分支）──→
  │     FETCH_FAVORITES         → scanTasks.fetchFavorites（独立模式不支持点赞扫描）
  │     CANCEL_FAVORITES         → scanTasks.runCancelBatch(CANCEL_ONE_FAVORITES)
  │     GET_SECURITY_STATUS → tabBridge.getSecurityStatus（恒走 Tab，需检查 Hook 注入）
  │
  ├─ 校准（内部按模式二次分支）──→ CALIBRATE_FOLLOWING → scanTasks.calibrateOne
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
  → chrome.storage.local.set({ independentMode }) + setIndependentMode() 写 SW 内存缓存
  → enabled=true 时预热 ensureABogus()（构造 ABogus 实例供后续签名）
读取：independentClient.loadMode() 首次从 storage 读入并缓存到私有字段 #mode（SW 存活期内不再回读）
```

> 关键约束：**options 发出的消息类型与参数格式与模式无关**。两模式的差异完全封装在 background 路由之后，产出相同响应形状。两模式不共享算法代码、不共用缓存变量。

### 模式切换注意事项

| 场景 | 行为 |
|------|------|
| Tab → 独立 | options 先发 `CANCEL_ACTIVE_TASK` 中止 inject 中在途的循环任务 |
| 独立 → Tab | 下次走 `sendToTab`；无可用 tab 时弹 `showNoSignatureDialog`（见 09） |
| `savedCookie` 为空 | `independentRequest` 抛 `NO_COOKIE`（各流程首请求即失败） |
| Cookie 过期 | 401/403 → `AUTH_FAILED` / `HTTP_4xx` |
| msToken 刷新失败 | 兜底随机假 token，严格端点（listcollection）403 |
| 取消信号路径差异 | Tab：options→background→content→inject；独立：background 循环内自挂监听消化 |

### 独立模式的选型依据

优点：扩展加载后立即可用（无需预浏览抖音产生签名）；无 `_dyInternal` 要解决的自污染竞争；资源消耗低（不注入、不 Hook、不观察 DOM）；时序稳定（不受 `sendToTab` 30s 超时约束）；SW 可独立完成整批任务，不依赖页面存活。

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

// BRIDGE 表：chrome 消息类型 ↔ CustomEvent 事件对 的映射（10 个条目），每项定义：
// { req: "DY_..._REQUEST", res: "DY_..._RESULT", timeout: (msg)=>ms, detail: (msg)=>{...} }
```

### 长任务链路模式

- `tabBridge.send`（`sendToTab`）：生成 `requestId` 向抖音标签页发消息，等待超时 `CONFIG.TIMEOUT.REQUEST`（默认 30s，`GET_SECURITY_STATUS` 5s）；内部 `.catch()` 处理 `find()` 极端异常路径。
- `tabBridge.sendAsync`（`sendToTabAsync`）：`send` 的 Promise 封装，background 循环 handler 中逐条/逐页请求（同步/扫描/取消循环）均用此模式；独立模式 `CANCEL_COLLECTION` 由 `independentTasks.cancel` 在 background 内直接循环，不走此路径。
- `requestResponse`：content.js **先 `addEventListener(resultEvent)` 再 `dispatchEvent(requestEvent)`**，消除同步 handler 的 `setTimeout(0)` workaround 需求。

### 进度消息（background 循环 handler 直接发给 options，不经 content 转发）

| 消息类型 | 载荷 |
|----------|------|
| `SYNC_PROGRESS` | `{ requestId, index, total, status:"ok"\|"error", awemeId }` |
| `SYNC_DONE` | `{ requestId, ok, refreshed?, failed?, failedAwemeIds?, error? }` |
| `FOLLOWING_PROGRESS` | `{ collected, hasMore, total, requestId, phase?: "calibrate" }` |
| `FAVORITES_PROGRESS` / `COLLECTION_PROGRESS` | `{ collected, unfollowedCount, hasMore, total, requestId }` |
| `CANCEL_PROGRESS` | `{ requestId, index, total, status, awemeId }` |
| `CANCEL_DONE` | `{ requestId, ok, cancelled, refreshed, failed, failedAwemeIds, deletedIds }` |
| `IMPORT_PROGRESS` | `{ domain, processed, total }`（IMPORT_DATA 作品域分块落库逐块回报） |

## 消息类型总表（App.route 全量分发）

> 本表自 AGENTS.md「消息协议」迁入（2026-10-03 瘦身）。`App.route()`（`background/main.js`）switch 分发所有 `chrome.runtime.sendMessage`。

| 类别                       | 消息类型                                                                                                                                                                                                                                                                                         |
|----------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 数据操作                   | `SAVE_WORKS` / `GET_WORKS` / `DELETE_WORKS` / `MOVE_WORKS` / `SYNC_WORKS` / `GET_WORKS_BY_IDS`（bulk 广播收口的补拉通道）/ `SAVE_FOLLOWINGS` / `GET_FOLLOWINGS` / `DELETE_FOLLOWINGS` / `MOVE_FOLLOWINGS` / `GET_FAVORITES` / `DELETE_FAVORITES` / `MOVE_FAVORITES` / `GET_COLLECTIONS` / `DELETE_COLLECTIONS` / `MOVE_COLLECTIONS`（favorites/collections 无独立保存消息，落库经 `SAVE_WORKS`/`persistScan`）；作品型三域 `GET_*` 支持分页（`page:0` / `cursor` keyset / 缺省全量，机制见本册「接口 / 方法签名」） |
| 分组管理                   | `GET_GROUPS` / `ADD_GROUP` / `RENAME_GROUP` / `DELETE_GROUP` / `REORDER_GROUPS`                                                                                                                                                                                                                  |
| 工具                       | `IMPORT_DATA` / `EXPORT_DATA` / `RESET_DOMAIN` / `GET_STATS` / `GET_SECURITY_STATUS` / `CALIBRATE_FOLLOWING`（单用户校准，见 docs/04） / `SET_MODE` / `CAPTURE_BROWSER_FEATURES` / `GET_COOKIE_INFO` / `GET_BROWSER_FEATURES` / `GET_CACHE_TIMES` / `RESOLVE_SEC_UID` / `REFRESH_MSTOKEN` / `REFRESH_WEBID` / `REFRESH_BROWSER_FEATURES` / `REFRESH_COOKIE` / `RELOAD_CONFIG` |
| 扫描入口                   | `FETCH_FOLLOWING` / `FETCH_FAVORITES` / `FETCH_COLLECTION` — options 触发 background 循环扫描、逐页透传进度；`FETCH_FOLLOWING` 收集完成后自动校准（门控与细节见 docs/04）                              |
| 入库                       | `IMPORT_USER_WORKS` / `IMPORT_FOLLOWING` — 作者作品分页入作品域 + 作者档案入关注域，均双模支持（分组/去重语义见 docs/07）；过程消息 `IMPORT_WORKS_PROGRESS`。入口为菜单「入库」弹窗（`AuthorImport`） |
| 存储广播                   | `STORE_CHANGED { domain, upserts?, addedIds?, changedIds? }` — 落库成功后 background 广播（发送方可能是抖音标签页等外部上下文），**仅在 `changed>0` 时发**（no-op 不广播）。两种载荷：**point**（works 域单发保存，`changed ≤ BROADCAST.UPSERTS_MAX`=8 时附带合并后记录 `upserts` 与新增 id 集 `addedIds`）；**bulk**（入库循环收尾等批量变化，附带轻量 id 集 `changedIds`/`addedIds`——禁止改回全量记录载荷防消息膨胀；关注域无载荷）。载荷语义见 [docs/10](./10-storage-write-and-import.md)；options 侧去抖/flush/头插收口管线与红线见 [docs/11](./11-options-ui.md)「STORE_CHANGED 增量收口」 |
| 取消入口                   | `CANCEL_FAVORITES` / `CANCEL_COLLECTION` — options 触发 background 批量取消：tab 模式逐条派发 `CANCEL_ONE_*` 到 inject；独立模式仅 `CANCEL_COLLECTION` 在 background 循环 POST（细节见 docs/06）                                                                                                     |
| 取消信号                   | `CANCEL_ACTIVE_TASK` — tab 模式下经 options→background→content→inject 触发 `activeTask.abort()`；独立模式下直接在 background 取消循环；仅在长操作弹窗关闭时发送（无 `state.activeDialog` 时不发送）                                                                                              |
| Tab 转发（background→tab） | `FETCH_WORK_DETAIL` / `FETCH_FOLLOWING_PAGE` / `FETCH_PROFILE_OTHER` / `FETCH_FAVORITES_PAGE` / `FETCH_COLLECTION_PAGE` / `CANCEL_ONE_FAVORITES` / `CANCEL_ONE_COLLECTION` / `FETCH_WORKS_PAGE` / `GET_SECURITY_STATUS`（tab 模式经 content→inject；独立模式由 background 直接 POST，见 docs/07） |
| 进度消息                   | `SYNC_PROGRESS` / `FOLLOWING_PROGRESS` / `FAVORITES_PROGRESS` / `COLLECTION_PROGRESS` / `IMPORT_WORKS_PROGRESS` / `CANCEL_PROGRESS` / `CANCEL_DONE`（载荷含 `deletedIds`：取消成功条目已同步删除该域本地记录）/ `IMPORT_PROGRESS`（IMPORT_DATA 分块落库逐块回报） — 由 background 循环 handler 直接发出到 options，不再经 content.js 转发（`FOLLOWING_PROGRESS` 带 `phase:"calibrate"` 表示关注校准阶段）                                                                                                |

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

```js
// 作品同步每完成 BATCH_SIZE 条暂停 BATCH_PAUSE_MIN~MAX 秒。
// SW 约 30s 空闲即被回收，故暂停拆分为 KEEPALIVE_INTERVAL 段，每段以一次
// chrome.storage.local.get 重置空闲计时器。其余循环每次延迟前均有 chrome.* 调用，无需额外处理。
if (BATCH_SIZE > 0 && (i + 1) % BATCH_SIZE === 0) {
  const deadline = Date.now() + BATCH_PAUSE_MIN + Math.random() * (BATCH_PAUSE_MAX - BATCH_PAUSE_MIN);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, KEEPALIVE_INTERVAL));
    await chrome.storage.local.get("keepalive");
  }
}
```

## 代码布局约束（全仓 JS 强制）

1. **从上到下、先声明后使用**。config/const 必须在文件最顶部；执行语句不得出现在声明之前。
2. **class 定义与实例化成对出现**——类定义后紧跟 `const name = new Class()`，不允许先集中列出所有 class 再集中实例化。
3. 大段分隔用边框注释 `// ---------- 标签 ----------`。
4. options/core.js 顶层集中定义并 export `config / dom / state / store / utils / runtimeConfig / services`，所有类模块经 ES import 引用这些模块级变量；类内部自引用必须用 `this.xxx()`，不得用单例变量名。
5. 私有方法使用 `#` 语法；**class field 箭头函数仅用于 add/remove 对称的事件回调**（如 `Sidebar.#onResizeDown/Move/Up`）。
6. options/main.js 组合根启动打印 `[DDM] options build …` 构建标记，用于排查用户端跑旧构建。

## 四域存储模型

### IndexedDB（data/storage.js 封装，库名 `douyin-saver`，DB_VERSION = 5；无改名迁移——低版本旧库升级前须先在旧版导出备份）

| store | keyPath | 索引 | 内容 |
|-------|---------|------|------|
| `works` | `awemeId` | `groupId` / `savedAt_id` / `groupId_savedAt_id` | `{ [awemeId]: Work }` |
| `works_groups` | `id` | — | `[{ id, name, fixed, order? }]` |
| `favorites` | `awemeId` | `groupId` / `savedAt_id` / `groupId_savedAt_id` | `{ [awemeId]: Work }`（与 works 同构） |
| `favorites_groups` | `id` | — | 同 groups 结构 |
| `collections` | `awemeId` | `groupId` / `savedAt_id` / `groupId_savedAt_id` | `{ [awemeId]: Work }`（与 works 同构） |
| `collections_groups` | `id` | — | 同 groups 结构 |
| `followings` | `uid`（字符串化） | `groupId` | `{ [uid]: Following }` |
| `followings_groups` | `id` | — | 同 groups 结构 |

`DOMAIN_CONFIG` 是四个域的统一描述：

```js
DOMAIN_CONFIG = {
  works:      { storeName, groupsName, defaultGroups, itemKey: "works",      idField: "awemeId" },
  followings: { storeName, groupsName, defaultGroups, itemKey: "followings", idField: "uid", idToString: true },
  favorites:      { storeName, groupsName, defaultGroups, itemKey: "favorites",      idField: "awemeId" },
  collections:  { storeName, groupsName, defaultGroups, itemKey: "collections",  idField: "awemeId" },
}
```

`domainStore.facade(domain)` 返回域封装（get/getBatch/getAllKeys/putBatch/deleteBatch/count/countByGroup/getGroups + idField，条目收敛为调用方实际消费集合，无消费的包装不设）；分组写入由 `storage.putGroups` 采用"clear() + 逐条 put()"实现"覆盖数组"语义；`countByIndex` 只做索引计数不反序列化整表。

### Work 记录字段（formatWork / normalizeWork 共同产出）

`awemeId, type("video"|"note"), desc, nickname, uid, authorHomeUrl, cover, video, videoExpireAt, images[], music, createTime（抖音发布时间，秒级 Unix 时间戳；卡片作者行右侧与详情底栏标题右侧展示。fiber 捕获路径的原始对象缺 create_time，采集与落库均按 aweme_id 高 32 位推导兜底，mergeWork 恒保证非零）, authorFollowed(bool|null)`
视频直链三级取链语义见 [02](./02-independent-sync-works.md) / [09](./09-inject-tab-mode.md)。落库合并规则（groupId/savedAt 保护、长效链降级防护、导入分组对账等**全部写入路径语义**）统一见 [10](./10-storage-write-and-import.md)，本文只维护字段模型。

### Following 记录字段（7 个稳定字段）

`uid, nickname, avatarLarger, followerCount, awemeCount, profileUrl, lastUpdateAt`
`followerCount / awemeCount` **仅由 profile/other 校准写入**（列表接口计数为滞后快照，采集时占位 0）；`lastUpdateAt`（最近更新日期，毫秒时间戳）**仅由校准阶段取作品第一页 max(create_time) 写入**（秒→毫秒），未校准占位 0。落库时的 0 值保护、同批保序与丢失检测见 [10](./10-storage-write-and-import.md)。

### chrome.storage.local 键表

| Key | 类型 | 写入者 | 说明 |
|-----|------|--------|------|
| `savedMsToken` + `savedMsTokenTime` | string + number | getMsToken / REFRESH_MSTOKEN | 独立模式 msToken 缓存，无过期逻辑 |
| `savedWebId` + `savedWebIdTime` | string + number | getWebId / REFRESH_WEBID | 设备身份缓存 |
| `savedCookie` + `savedCookieTime` | string + number | REFRESH_COOKIE | douyin.com cookie jar 全量字符串快照；门禁与 UIFID/uid 提取源 |
| `browserFeatures` + `browserFeaturesTime` | object + number | CAPTURE_BROWSER_FEATURES / REFRESH_BROWSER_FEATURES | 浏览器特征指纹（含 securityKey） |
| `independentMode` | boolean | SET_MODE | 模式开关 |
| `secUid` | string | options 设置面板 `saveBeforeClose` 关闭面板时一次性写入 | 独立模式目标用户 |
| `runtimeConfig` | object | options 设置面板保存 → RELOAD_CONFIG | 运行参数（见配置项说明） |

### 设置面板与凭据缓存刷新链

设置面板含 4 个 section：**运行参数**（独立模式开关 + 校准开关 + secUid 输入 + 缓存列表 + 延迟/超时参数）、**Cookie 配置**（键值对表格）、**浏览器特征**（只读表格）、**Tab 模式**（安全状态）。缓存列表各项的「刷新」按钮经 `TYPE_MAP = { cookie:"COOKIE", mstoken:"MSTOKEN", webid:"WEBID", browser_features:"BROWSER_FEATURES" }` 映射为消息：

| 面板项 | 消息 | 行为 |
|--------|------|------|
| cookie | `REFRESH_COOKIE` | 重采 `chrome.cookies.getAll({domain:"douyin.com"})` 全量存 `savedCookie` |
| mstoken | `REFRESH_MSTOKEN` | 删缓存重走五级来源（jar 无值必触发一次 mssdk 兑换，见 05） |
| webid | `REFRESH_WEBID` | 删缓存重兑换并回写 webid cookie |
| browser_features | `REFRESH_BROWSER_FEATURES` | 需抖音标签页在线：`REQUEST_CAPTURE_BROWSER_FEATURES` 强制重采（链路见 09） |

另有两个非刷新入口：`GET_CACHE_TIMES`（四项时间戳展示）、`GET_COOKIE_INFO`（解析 savedCookie 为键值对 + sessionid 存在性检查）。

## 异常场景及处理

### 错误分类（长任务）

| 类别 | 错误码 | 处理 |
|------|--------|------|
| 致命（终止整批） | `NO_DOUYIN_TAB` / `TAB_QUERY_FAILED` / `NO_LISTENER` / `EMPTY_RESPONSE` / `RATE_LIMITED` / `CANCELLED`，HTTP 401/429 | `CONFIG.FATAL_ERRORS.has(err)` 判定，剩余条目记 `BATCH_TERMINATED` |
| 非致命（跳过当前继续） | `TIMEOUT`、HTTP 403/5xx、`status_code` 非零、网络异常、`DELETED` | 记入 errors，继续下一条 |

### 其他全局异常路径

- `sendToTab` 超时后向 inject 补发 `CANCEL_ACTIVE_TASK`，防止僵尸任务在后台继续产生回调。
- 独立模式凭据缺失：`savedCookie` 为空 → `independentRequest` 抛 `NO_COOKIE`；Cookie 过期 → 401/403 → `AUTH_FAILED` 或 `HTTP_4xx`。
- 所有 `chrome.runtime.sendMessage` 进度发送均 `.catch(() => {})`——options 未开页时静默丢弃，不影响循环。
- DNR 注册失败：`setupDeclarativeNetRequest` 捕获后仅 `console.warn`，不阻塞启动（后果见 08 文档）。

## 配置项说明

### background/core.js `CONFIG`（编译期默认值，部分被 runtimeConfig 覆盖）

| 分组 | 键 |
|------|----|
| TIMEOUT | `REQUEST:30000` / `SECURITY_STATUS:5000` |
| DELAY | 七类任务各 `{MIN:500, MAX:1000}`：syncWorks / syncFollowings / syncFavorites / syncCollection / cancelFavorites / cancelCollection / importWorks |
| SYNC | `BATCH_SIZE:40` / `BATCH_PAUSE_MIN/MAX:10000/20000` / `KEEPALIVE_INTERVAL:2000` / `RETRY_MAX:2` |
| PAGE | 各列表端点页大小，均 20（FAVORITE/COLLECTION/POST/FOLLOWING）；`GRID: 2000`（网格渐进加载页大小，keyset 游标串行依赖上一页末键，吞吐靠加大页体摊薄每页固定开销） |
| IMPORT_CHUNK | `2000`（导入分块落库块大小：单事务 10 万级 put 长时间独占 SW 的 IDB，按块 mergeAndSave + IMPORT_PROGRESS 逐块回报） |
| GROUPS | `ID_PREFIX:"custom_"` / `DEFAULT_ID:"uncategorized"` |
| STORAGE_KEYS | 四个 store 名常量（唯一来源） |
| FATAL_ERRORS | 致命错误集合（见上表） |
| WEB_SIGN_SALT | Argus webSign 盐（见 05） |
| CANCEL.collection | 取消收藏端点四要素 url/body/type/referrer |
| API | FOLLOWING / PROFILE_OTHER / COLLECTION / DETAIL / POST 五个端点路径 |
| MSSDK / WEBID_API / WEBID_QUERY | msToken 兑换与 webid 兑换常量 |

### `runtimeConfig`（chrome.storage.local，设置面板可改，RELOAD_CONFIG 热加载进 CONFIG）

键与 CONFIG 一一对应加 Min/Max 后缀：`timeoutRequest / timeoutSecurityStatus / syncWorksDelayMin..Max / … / syncBatchSize / syncBatchPauseMin..Max / syncKeepaliveInterval / syncRetryMax / calibrateFollowings`（默认值同上表；`calibrateFollowings` 默认 true，控制同步关注后的批量校准开关）。SW 冷启动（background `App.init`）补一次 `runtimeConfig.reload()`，全部运行参数（含校准开关）随存随恢复，重开扩展（非重载）不回退编译期默认值；`IndependentClient.isCalibrateEnabled` 另有 storage 惰性加载兜底（首次调用才读，跨 SW 重建仍生效）。

### options/core.js 顶层 `config`（UI 侧，50 键，权威键表）

| 分组       | 键（默认值）                                                                                                                                                  |
|------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 视频重试   | `VIDEO_RETRY_DELAYS` `[200,400,600]` / `VIDEO_RETRY_MAX` `3` / `VIDEO_RETRY_FALLBACK_DELAY` `1000`                                                            |
| 媒体熔断   | `MEDIA_FAIL_WINDOW` `5000` / `MEDIA_FAIL_MAX` `10` / `MEDIA_BREAK_COOLDOWN` `15000`                                                                           |
| 超时       | `FETCH_RETRY_DELAY` `1000` / `VIDEO_FALLBACK_TIMEOUT` `5000`                                                                                                  |
| 详情页     | `DETAIL_TITLE_MAX_LEN` `40` / `TOAST_DURATION` `2000` / `TOAST_ERROR_DURATION` `4500` / `DOWNLOAD_MAX_RETRY` `1`                                              |
| UI 延迟    | `HOVER_PREVIEW_DELAY` `200` / `BLOB_REVOKE_DELAY` `10000` / `NOTE_AUTO_PLAY_INTERVAL` `3000` / `SEARCH_DEBOUNCE` `200`                                        |
| 侧边栏     | `SIDEBAR_SNAP_POINTS` `[650,0]` / `SIDEBAR_SCROLL_THRESHOLD` `100` / `SIDEBAR_FILL_THRESHOLD` `50` / `SIDEBAR_IMG_PER_FRAME` `6` / `SIDEBAR_DRAG_THRESHOLD` `4` |
| 网格项尺寸 | `CARD_SIZE_FALLBACK` `261` / `CARD_GAP` `11` / `CARD_HEIGHT_OFFSET` `44`                                                                                      |
| 分块渲染   | `RENDER_CHUNK_SIZE` `50` / `RENDER_BUILD_BUDGET_MS` `8` / `OBSERVER_ROOT_MARGIN` `'1600px'`（≈4 行，须 < OBSERVE_CHUNK_SIZE 单圈行距） / `OBSERVE_CHUNK_SIZE` `48` / `FILL_FRAME_BUDGET_MS` `8` / `UNLOAD_ROOT_MARGIN` `'2400px'`（≈6 行，与填充圈保持 800px 滞回间隙） / `FAST_SCROLL_THRESHOLD` `300` / `GRID_PREMOUNT_CAP` `1500` / `GRID_PREMOUNT_CAP_FILTER` `600`（筛选态封闭视图预铺降档） / `GRID_EXTEND_THRESHOLD` `1.5` / `GRID_EXTEND_STEP` `1000`（扩容单步新增槽位上限，防深域后段单步长任务） / `DEMOTE_FRAME_BUDGET_MS` `8`（停稳降级分帧预算） / `GRID_IMG_PER_FRAME` `10`（网格媒体探针每帧派发配额，sidebar 沿用 `SIDEBAR_IMG_PER_FRAME`） |
| 分组/存储  | `GROUP_NAME_MAX_LEN` `20` / `STORAGE_MAX_BYTES` `10MB` / `TRASH_GROUP_NAME` `'稍后删除'`                                                                      |
| Tab 滚动   | `TAB_SCROLL_THRESHOLD` `2`                                                                                                                                    |
| 抖音 URL   | `URL_BASE` / `URL_USER_SELF` / `URL_FAVORITE_TAB` / `URL_COLLECTION_TAB` / `URL_FOLLOWING_TAB`                                                                    |
| 域元数据   | `WORK_RECORD_DOMAINS` `['works','favorites','collections']` / `DOMAINS_META`（四域 label/itemKey/idKey/isFollowings）                                                 |
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
| — | [TIKTOK_REFERENCE.md](./TIKTOK_REFERENCE.md) | 参考项目算法/凭据对照与 API 端点总表 |
