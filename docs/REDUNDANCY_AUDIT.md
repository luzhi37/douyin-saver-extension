# 冗余代码审查报告

> 日期：2026-08-04 ｜ 仅审视，未修改源码

---

## 一、background/background.js（1,918 行）

### 死代码（经源码验证）

| # | 位置 | 说明 |
|---|------|------|
| 1 | L1462, 1484, 1507 | **`errors` 数组只计数不读取** — `handleIndependentCancel` 中 `errors` 在 L1462 初始化为 `[]`，但 catch 块 `catch (_) {}` (L1484) 从不 push 条目，最终只用 `errors.length` (L1507) 计算 `refreshed` 计数，以及 `errors.map(...)` (L1509) 生成 `failedAwemeIds`（始终为空数组）。整个 `errors` 数组从未被填充，是死状态 |

### 疑似死代码（经源码验证 — 不成立）

| # | 位置 | 说明 |
|---|------|------|
| ~~1~~ | ~~L959–963~~ | ~~`sendSyncDone` 死代码~~ — **核实结果：有调用方**。`handleSyncWorks` (L1775, 1782, 1785) 三次调用 `sendSyncDone`。`handleIndependentSyncWorks` (L646) 内联发送但不影响此函数的活跃性 |
| ~~2~~ | ~~L826, 830, 834~~ | ~~`getStoreName`/`getGroupsName`/`getDefaultGroups` 死代码~~ — **核实结果：有调用方**。被 `handleGetGroups` (L1598-1599), `handleAddGroup` (L1614-1615), `handleRenameGroup` (L1634-1635), `handleReorderGroups` (L1651-1652), `handleDeleteGroup` (L1670-1672), `reconcileImportGroups` (L1794-1795), `handleImportData` (L1832-1833), `handleExportData` (L1853) 等 8+ handler 调用。同时 `domainStorage()` (L844) 也暴露了同名方法，形成两层并行访问 |
| ~~3~~ | ~~L1292–1342~~ | ~~`handleFetchFavorites` 不可达~~ — **核实结果：可达**。路由器 L1078 注册 `case "FETCH_FAVORITES"`，通过 `asyncHandler(async () => { return handleFetchFavorites(message.secUid, sendResponse); }, sendResponse)` 调用。`asyncHandler` (L818) 调用 `fn()` 获取 promise 并附加 `.catch`，函数体完整执行并调用 `sendResponse` (L1338) |

### 重复代码（经源码验证）

| # | 位置 | 说明 |
|---|------|------|
| 4 | L247–255, L547–559 | **完全相同的 uid cookie 解析块** — `resolveSelfSecUid` 和 `handleIndependentFetchFollowing` 各复制 9 行 `savedCookie.split(";")` 查找 `uid` 的代码；文件已有 `extractMsTokenFromCookie` (L275) 类似模式，可统一提取 `extractCookieValue(cookieStr, name)` |
| 5 | L687–698, 1755–1767 | **批量暂停 keepalive 循环重复 2 次** — `handleIndependentSyncWorks` 和 `handleSyncWorks` 各有一份相同的 6 行 `while(Date.now() < deadline)` + `setTimeout` + `storage.get("keepalive")` 代码，仅缩进不同，可提取为 `batchDelay(i)` |
| 6 | L566–569, 603–609, 654–657, 1246–1251, 1296–1301, 1348–1353, 1403–1406, 1463–1466, 1706–1715 | **取消处理器样板代码重复 9 次** — 每个长运行 handler 都重新实现 `cancelled` 标志 + `cancelHandler` 闭包 + `addListener`/`removeListener`，可提取 `registerCancelHandler()`。注：L707–709 不属于 cancel handler（是 `handleIndependentSyncWorks` 的 `SYNC_DONE` 消息体），不应计入 |
| 7 | L589, 636, 668, 696, 1281, 1333, 1384, 1432, 1497, 1764 | **随机延迟表达式重复 10 次** — `CONFIG.DELAY.MIN + Math.random() * (CONFIG.DELAY.MAX - CONFIG.DELAY.MIN)`。L668 是 `handleIndependentSyncWorks` 的重试延迟，L1432 是 `runCancelBatch` 的项间延迟，均可统一提取为 `randomDelay()` |
| 8 | L570–591, 611–638, 1257–1284, 1307–1335, 1359–1387 | **分页循环骨架重复 5 次** — `while(hasMore && !cancelled)` + fetch + 进度消息 + 延迟，5 个 handler 结构相同，可提取通用 `paginatedFetch` 工具 |
| 9 | L752–756, L1191–1195 | **ABogus 实例化重复** — `handleCaptureBrowserFeatures` 和 `handleRefreshBrowserFeatures` 都做 `new ABogus(ua, platform, features)` |

---

## 二、background/crypto.js（297 行）

文件整体干净，仅两处轻微问题：

| # | 位置 | 说明 |
|---|------|------|
| 1 | L150, 156, 160 | **`v[0]` 计算后从未使用** — `list1`/`list2`/`list3` 都构造 `const v = [r, r & 255, (r >> 8) & 255]`，但只用 `v[1]`、`v[2]`，`v[0]` 是死赋值 |
| 2 | L72–77, L106–111 | **字节数组转换代码完全重复** — `sm3Hash` 和 `abogusSum` 中各有一份相同的 6 行 `out[i*4] = v[i] >>> 24` 循环，可提取为 `sm3StateToBytes(v, out)` |

---

## 三、content/inject.js（1,192 行）

| # | 类型 | 位置 | 说明 |
|---|------|------|------|
| 1 | 逻辑 bug | L245 | **`fetchOneCollectionPage` 缺少 `has_more === "1"` 检查** — 兄弟函数 `fetchOneFavoritesPage` (L196) 有 3 路检查 (`true`/`1`/`"1"`)，此处只有 2 路，Douyin API 返回字符串 `"1"` 时会导致分页提前终止 |
| 2 | 死配置 | L51 | **`CONFIG.CANCEL.COLLECTION_CONTENT_TYPE`** — 值与顶层 `CONFIG.COLLECTION_CONTENT_TYPE` (L50) 完全相同，但只有顶层被读取，嵌套路径从未使用 |
| 3 | 魔术字符串 | L1174 | **`"DY_CAPTURE_BROWSER_FEATURES_REFRESH"`** — 回复事件名未在 `CONFIG.EVENTS` 中定义，是裸字符串；请求事件 `CAPTURE_BROWSER_FEATURES` (L80) 有常量，但配对响应没有 |
| 4 | 跨文件重复 | L164 vs L211 | **`fetchOneFavoritesPage` 和 `fetchOneCollectionPage` 约 80% 代码相同** — URL 构建、params 合并、AbortController、timeout、fetch 结构、JSON 解析、`transformAwemeItem` 映射、结果对象形状全部相同，差异仅在于 endpoint、HTTP method、`hasMore` 检查和 collection 的 content-type header |
| 5 | 跨文件重复 | L378 vs `background.js` L461 | **`normalizeWork` (inject.js) 和 `formatWork` (background.js)** — 两者执行相同的数据转换：`awemeId`、`type`、`desc`、`nickname`、`uid`、`authorHomeUrl`、`cover`、`video`、`images`、`music`、`createTime`、`statistics`、`authorFollowed`，存在于不同执行上下文但逻辑重复 |
| 6 | 跨文件不一致 | L596 vs `background.js` L1456 | **`getSecurityKey` 路径不一致** — inject.js 直接从 `localStorage` 读取，background.js 从缓存的 `browserFeatures.securityKey` 读取，如果 localStorage 在两次捕获之间变化，两条路径可能返回不同值 |
| 7 | 配置重复 | L44 vs L58 | **`CONFIG.API` (5 条目) 和 `CONFIG.API_PATTERNS` (12 条目) 共享全部 5 个 `CONFIG.API` 字符串** — 用于不同的匹配逻辑（`includes` vs `startsWith`），但字面量重复 |
| 8 | 隐式变异 | L131 | **`mergeParams` 变异传入的 URL 对象** — 直接修改参数后返回同一对象，调用方可能误以为返回的是新对象 |

### 经核实不成立

| # | 原结论 | 核实结果 |
|---|------|------|
| ~~1~~ | ~~`source === "fiber"` 分支不可达~~ — 无调用方传入 `fromFiber: true` | **核实结果：可达**。`createSaveButton` 的 mouseenter 监听器 (L1115) 和 click 处理器 (L1138) 都调用 `extractWorkFromRaw(awemeInfo, { fromFiber: true })`，其中 `awemeInfo` 来自 `getAwemeInfoFromButton` (L1044) 通过 React Fiber (`__reactFiber$`) 提取。fiber 分支在 L282-284 和 L301-303 确实会执行 |
| ~~2~~ | ~~`extractWorkFromRaw` 无外部调用方~~ | **核实结果：有内部调用方**。在 inject.js 内部被 L438 (`fromFiber: false`)、L1115 (`fromFiber: true`)、L1138 (`fromFiber: true`) 三处调用 |

### 第三轮审查补充（计数修正）

| # | 项目 | 修正 |
|---|------|------|
| 1 | 取消处理器样板 | 原记 ×10（含 L707–709），修正为 **×9**。L707–709 是 `handleIndependentSyncWorks` 的 `SYNC_DONE` 消息体，不是 cancel handler |
| 2 | 随机延迟表达式 | 原记 ×8，修正为 **×10**（新增 L668 `handleIndependentSyncWorks` 重试延迟、L1432 `runCancelBatch` 项间延迟） |
| 3 | `FETCH_FOLLOWING` 分页参数矛盾 | 原写 `FETCH_COLLECTION`，纠正为 **`FETCH_FOLLOWING`**（TIKTOK_REFERENCE.md 写 `user_id, max_time`，INDEPENDENT_MODE.md 写 `offset, count`；实际代码 L571 同时使用两组参数） |

---

## 四、content/content.js（247 行）

文件干净，无死代码。仅两处轻微问题：

| # | 位置 | 说明 |
|---|------|------|
| 1 | L105, L117 | **`() => 30000` 超时工厂重复 2 次** — `CANCEL_ONE_LIKE` 和 `CANCEL_ONE_COLLECTION` 各定义一次相同箭头函数 |
| 2 | L51 | **`_sender` 参数未使用** — Chrome API 签名要求，有下划线前缀标记，属正常模板代码 |

---

## 五、background/storage.js（153 行）

无真正死代码（所有函数都有调用方），但有结构性冗余：

| # | 位置 | 说明 |
|---|------|------|
| 1 | L50–58, L119 | **`toMap()` 转换浪费** — `getAll` 和 `getByIndex` 将 IDB 结果转为 Map，但所有调用方（L872, 875, 1682, 1859）立即用 `Object.values()` 转回数组，Map 从未被用于 O(1) 查找 |
| 2 | L50 vs L125 | **返回类型不一致** — `getAll` 返回 Map，`getGroups` 返回数组，做相同的事（读全部记录）但接口契约不同 |
| 3 | L50–153 | **事务样板代码重复 9 次** — 每个 CRUD 方法都重复 `openDB()` + `new Promise` + `tx.oncomplete/onerror` 模式，可提取为 `_tx(storeName, mode, fn)` |
| 4 | L8, 10 | **`STORES` 配置 schema 不一致** — `works` 和 `followings` 有 `indexes: ["groupId"]`，`works_groups` 和 `followings_groups` 缺少 `indexes` 字段 |

---

## 六、options/options.js（3,625 行）

文件整体干净，无死函数、无不可达代码、无注释块。重复项均为结构相似：

| # | 类型 | 位置 | 说明 |
|---|------|------|------|
| 1 | 方法重复 | L1644–1674 | **`Sync.moveFailed()` 和 `Sync.moveLostFollowings()`** — 结构完全相同，仅 domain 字符串（`"works"` vs `"followings"`）和 bgMsg 调用方式不同，可合并为 `moveToTrash(ids, domain, serviceFn)` |
| 2 | 去重逻辑重复 | L286–313 | **`services.loadWorks` 和 `services.loadFollowings`** — 相同的 seen-Set + dedup 循环，仅 idField（`awemeId` vs `uid`）和响应键不同，可提取共享 `deduplicate(list, idField)` |
| 3 | DOM 操作重复 | L953–1037 | **`Batch.handleBatchToggle()` 关闭模式时**重新实现 `#clearAllCheckboxes()` 的逻辑（手动 `forEach` + `classList.remove("checked")`），而 `#clearAllCheckboxes` (L953) 已存在且逻辑一致，两条路径可能漂移 |
| 4 | 薄包装方法 | L3251–3259 | **`toggleDetailVideoPlay`/`toggleDetailVideoMute`** — 各调用底层 `toggleVideoPlay`/`toggleVideoMute` 后只多设一个 `title`，可合并或提取 `updateBtnTitle` |
| 5 | 表格构建重复 | L1813–1924 | **`Settings._refresh()` 中的 cookie 表和 browser-features 表** — 相同的 colgroup/thead/tbody 样板代码，可提取 `_buildKVTable(container, data)` |
| 6 | 进度处理器重复 | L2161–2177 | **`Favorites.onFavProgress` 和 `Favorites.onCollectionProgress`** — 完全相同的 DOM 更新逻辑，仅 label 字符串不同，可合并为 `onProgress(msg, label)` |
| 7 | 无操作回退 | L92, 2798 | **`dom.detailBody || document.querySelector(".detail-body")`** — 缓存的 `dom.detailBody` 和回退查询是同一表达式，回退永远不会产生不同结果 |

---

## 七、文档冗余（docs/ + README.md + AGENTS.md + CLAUDE.md）

### 完全重复内容

| # | 内容 | 涉及文件 |
|---|------|----------|
| 1 | **四层架构 ASCII 图** — 逐字重复 4 次 | `README.md` L28–36, `AGENTS.md` L32–40, `CLAUDE.md` L18–26, `INDEPENDENT_MODE.md` L37–46 |
| 2 | **`_dyInternal` 机制说明** — 三优势要点逐字相同 | `FETCH_AND_CACHE.md` L7–15, `INJECT_INTERNALS.md` L31–36 |
| 3 | **Chrome storage 缓存键表** — 5 个键 + 用途重复 | `INDEPENDENT_MODE.md` L148–159, `AGENTS.md` L120–128 |

### 过期 / 矛盾内容

| # | 问题 | 文件 |
|---|------|------|
| 4 | **DNR rule 4 缺失** — 文档列出 rule 1/2/3/5/6，跳过 4，无文件解释原因 | `SECURITY_AND_DNR.md`, `INDEPENDENT_MODE.md` |
| 5 | **`FETCH_FOLLOWING` 分页参数矛盾** — `TIKTOK_REFERENCE.md` 写 `user_id, max_time`，`INDEPENDENT_MODE.md` 写 `offset, count`。实际代码（L571）同时使用两组参数：`offset`/`count`/`min_time`/`max_time` + 可选的 `user_id`，两份文档各只列了一半 | `TIKTOK_REFERENCE.md` L52 vs `INDEPENDENT_MODE.md` L56 |
| 6 | **`verifyFp` 自相矛盾** — 凭据表 (L30–33) 描述生成算法，同文件全景对照表 (L41) 标记已移除 | `TIKTOK_REFERENCE.md` |
| 7 | **XBogus / XGnarly / device_id** — 已移除功能的完整描述仍占文档篇幅 | `TIKTOK_REFERENCE.md` L17–42 |

---

## 优先处理建议（按影响排序）

| 优先级 | 项 | 类型 | 预估影响 |
|--------|------|------|----------|
| P1 | `fetchOneCollectionPage` 缺少 `"1"` 检查 | **逻辑 bug** | 修复分页提前终止 |
| P1 | `errors` 数组只计数不读取 | 死状态 | 清理 L1462 的 `const errors = []` 和 L1507/1509 中对它的引用，改为直接用 `failed` 计数 |
| P1 | 5 个分页循环骨架重复 | 重复 | 提取通用 `paginatedFetch` 工具 |
| P1 | 取消处理器样板 ×9 | 重复 | 提取通用取消包装器 |
| P1 | `fetchOneFavoritesPage` / `fetchOneCollectionPage` 提取共享 `fetchOnePage` | 重复 | 80% 代码相同 |
| P2 | uid cookie 解析块 ×2 | 重复 | 提取为 `extractCookieValue` 工具 |
| P2 | 批量暂停 keepalive 循环 ×2 | 重复 | 提取 `batchDelay()` |
| P2 | `toMap` 浪费 + 返回类型不一致 | 结构冗余 | 修改 storage API 返回数组 |
| P2 | 事务样板 ×9 | 重复 | 提取 `_tx()` 辅助 |
| P2 | `Sync.moveFailed`/`moveLostFollowings` 重复 | 重复 | 合并为 `moveToTrash` |
| P2 | `services.loadWorks`/`loadFollowings` 去重重复 | 重复 | 提取 `deduplicate` 辅助 |
| P2 | `Favorites.onFavProgress`/`onCollectionProgress` 重复 | 重复 | 合并为参数化方法 |
| P2 | `Settings._refresh` 表格构建重复 | 重复 | 提取 `_buildKVTable` |
| P2 | `normalizeWork` / `formatWork` 跨文件数据转换重复 | 重复 | 两个上下文各有一套相同字段映射 |
| P2 | `getSecurityKey` 路径不一致 | 跨文件不一致 | 统一为同一读取路径 |
| P3 | 文档四层架构图 ×4 | 重复 | 保留在 `CLAUDE.md`，其他改为引用 |
| P3 | `_dyInternal` 说明 ×2 | 重复 | 合并为一份 |
| P3 | 文档过期 / 矛盾 | 准确性 | 修正 TIKTOK_REFERENCE、补充 DNR rule 4 说明 |
