# 冗余代码与死代码审计

> 审计日期：2026-08-13
> 范围：`background/*.js`、`content/*.js`、`options/options.js`、`options/options.html`、`options/options.css`
> 方法：跨文件调用链人工核对 + grep 交叉验证
> 状态：**仅记录，未改动任何代码**

## 摘要

| 编号 | 类型 | 位置 | 说明 |
|------|------|------|------|
| D1 | 死代码 | `background/background.js:1003-1009` | `domainStorage()` 返回的 6 个方法从未被调用 |
| D2 | 死代码+不一致 | `background/background.js:1630-1697` | 独立模式取消点赞分支不可达；`CANCEL_LIKE` 独立模式行为与收藏不对称 |
| D3 | 死数据 | `content/inject.js:1064` | `collectSecurityStatus()` 的 `signatures.detail` 生产后无 UI 消费 |
| R1 | 冗余 | `background.js:466` / `inject.js:539` / `inject.js:26` | 设备/浏览器参数构造 3 份，版本号已分叉 |
| R2 | 冗余 | `background.js:126` / `background.js:182` / `options.js:239` | 延迟/批次默认配置 3 份，需手工同步 |
| R3 | 冗余 | `content/inject.js:193/240/661/701` | 4 个几乎相同的 fetch 页包装 |
| R4 | 冗余 | `background.js` 分页/取消循环 | 8 个几乎相同的循环 |
| R5 | 冗余 | `background.js:593/653` vs `inject.js:407/894` | 作品/关注格式化逻辑双份且已分叉 |
| R6 | 冗余 | `background.js:307` vs `background.js:674-691` | cookie 解析 uid 逻辑重复实现 |
| B1 | **真实 bug** | `background/background.js:777` | 收藏延迟误用 `syncFollowings` 配置 |

---

## 一、确认死代码（建议删除）

### D1. `domainStorage()` 中 6 个从未被调用的方法

`background/background.js:994-1011` 的 `domainStorage(domain)` 返回对象暴露了：

```js
getByGroup,       // line 1003  实际调用处都直接用 storage.getByIndex
clear,            // line 1004  handleResetDomain 直接用 storage.clear
putGroups,        // line 1006  handleResetDomain / 分组 handler 直接用 storage.putGroups
getDefaultGroups, // line 1007  从未使用
idField,          // line 1008  从未使用
itemKey,          // line 1009  从未使用（各处取的是 cfg.itemKey）
```

grep 交叉验证：`ds.get / ds.putBatch / ds.count / ds.getAll / ds.getGroups` 有真实调用点（1086-1105、1713-1762、2064-2070）；上述 6 个属性仅在定义处出现。可安全删除。

### D2. `handleIndependentCancel` 不可达的取消点赞分支

`background/background.js:1630-1697` 的 `handleIndependentCancel(awemeIds, kind, sendResponse)` 被 `kind` 参数泛化设计成可同时处理 `like` 与 `collection`，但：

- 消息路由中 `CANCEL_COLLECTION`（1263-1268）在独立模式下调用 `handleIndependentCancel(idList, "collection", ...)`；
- `CANCEL_LIKE`（1259-1261）从不检查独立模式，始终走 tab 模式 `runCancelBatch`；
- `CONFIG.CANCEL`（160-167）只声明了 `collection` 一项，即便传入 `"like"` 也会命中 `UNKNOWN_KIND` 提前返回。

因此 `delayKind = kind === "collection" ? "cancelCollection" : "cancelLike"` 中的 `cancelLike` 分支不可达。

**旁注（行为不一致，非死代码）**：独立模式下 `CANCEL_LIKE` 会退回 tab 模式，要求存在抖音标签页；而 `CANCEL_COLLECTION` 可无标签页运行。commit `b4606f3`（"independent mode for … scan/cancel collect, but not for scan fav"）表明扫描点赞不支持独立模式是有意为之，但取消点赞在独立模式下静默降级到 tab 模式，建议后续统一为显式报错或补全。

### D3. `inject.js` 安全面板的 `signatures.detail` 生成但从不消费

`content/inject.js:1044-1075` 的 `collectSecurityStatus()` 返回：

```js
signatures: { detail, following, post, favorite, collection }
```

而设置面板 `options.js:2106-2132` 的 `_renderStatus` 只渲染 `following / post / favorite / collection` 四项 + key（2127-2130），`detail`（inject.js:1064）没有任何 UI 读取。属于"生产但不消费"的死数据输出，可随重构删除或补渲染。

---

## 二、冗余代码（复制粘贴分叉，建议后续重构）

### R1. 设备/浏览器参数构造 3 份，版本号已分叉

| 位置 | 用途 | 版本号 |
|------|------|--------|
| `background/background.js:466` `buildBaseParams()` | 独立模式请求公共参数 | `version_code: "290100"`，`browser_version: "149"`（硬编码） |
| `content/inject.js:539` `getDetailBrowserParams()` | 页面内 detail 请求参数 | `update_version_code: "170400"`，`browser_version: "149.0.0.0"` |
| `content/inject.js:26` `CONFIG.DEVICE_PARAMS` | 页面内分页请求基础参数 | `version_code: "170400"` |

`aid / channel / pc_client_type / browser_* / os_* / cpu_core_num / device_memory` 等字段三处重复，且 background 与 inject 的版本号已分叉，改动时易漏。

### R2. 延迟/批次默认配置 3 份

- `background.js:126-140` `CONFIG.DELAY` + `CONFIG.SYNC`（静态默认）
- `background.js:182-202` `RUNTIME_CONFIG_DEFAULTS`（storage 默认值）
- `options/options.js:239-259` `runtimeConfig.DEFAULTS`（options 页默认值）

三处必须手工同步，任何一处漂移都会造成"保存配置后行为不一致"类 bug。建议以 `RUNTIME_CONFIG_DEFAULTS` 为唯一权威，options 侧从 background 下发。

### R3. 4 个几乎相同的 fetch 页包装

`content/inject.js`：

| 函数 | 行号 | 端点 |
|------|------|------|
| `fetchOneFavoritesPage` | 193 | favorite |
| `fetchOneCollectionPage` | 240 | collection |
| `fetchFollowingPage` | 661 | following |
| `fetchAuthorWorks` | 701 | post |

共享同一模板：`buildUrl` + `mergeParams` + `stripPageKeys(stripSdkKeys(...))` + AbortController + `setTimeout` 超时 + `window.fetch(_dyInternal: true)` + `resp.ok` 校验 + 事件监听器/`setActiveTask`。差异仅限 URL、翻页参数名（`max_cursor` vs `cursor` vs `offset`）、方法与 content-type。可抽取统一 `fetchDouyinPage({pathname, params, method, headers, signalTimeout})`。

### R4. 8 个几乎相同的分页/取消循环

`background/background.js`：

| 函数 | 模式 | 说明 |
|------|------|------|
| `handleFetchFollowing` | tab | 1398 |
| `handleFetchFavorites` | tab | 1455 |
| `handleFetchCollection` | tab | 1514 |
| `handleSyncWorks` | tab | 1880 |
| `handleIndependentFetchFollowing` | 独立 | 665 |
| `handleIndependentFetchCollection` | 独立 | 731 |
| `handleIndependentSyncWorks` | 独立 | 787 |
| `handleIndependentCancel` / `runCancelBatch` | 独立/tab | 1572 / 1630 |

消除方法：抽象"分页驱动"（`requestId` + `cancelHandler` + `while(hasMore && !cancelled)` + 进度上报 + `getDelayRange` 节流），tab 与独立模式仅差别在于取数回调（`sendToTabAsync` vs `independentRequest`）。

### R5. 作品/关注格式化逻辑双份且已分叉

- 作品：`background.js:593` `formatWork()` vs `inject.js:407` `normalizeWork()`。
  前者含 `videoExpireAt`（URL expire 解析）与 `authorFollowed`，后者均不含；候选码率选择逻辑（`bitRate`/`bitRateList`、`play_addr.url_list` 去重、最高清档）各写一遍，行为可能漂移。
- 关注：`background.js:653` `formatFollowing()` vs `inject.js:894-900` 的 `FETCH_FOLLOWING_PAGE_REQUEST` handler 内联映射（uid/nickname/avatarLarger/followerCount/profileUrl）。

独立模式无法复用页面侧代码是合理的架构约束，但两份逻辑应抽成共享纯函数并以单一格式契约约束字段集。

### R6. `resolveSelfSecUid` 与独立模式抓取循环中重复的 cookie 解析

`background.js:307` `resolveSelfSecUid()` 与 `handleIndependentFetchFollowing`（674-691）各实现一遍"从 `chrome.cookies` / `savedCookie` 解析 `uid` 字段"。代码库本就有 `parseCookieToPairs()`（`crypto.js:277`）可用，建议复用消除重复。

---

## 三、审计中发现的一个真实 Bug

### B1. 独立模式收藏扫描误用关注延迟配置

`background/background.js:775-778`，`handleIndependentFetchCollection` 中：

```js
await new Promise((r) =>
  setTimeout(r, getDelayRange("syncFollowings").MIN + Math.random() * (...MAX)));
```

应为 `getDelayRange("syncCollection")`。该循环自 `handleIndependentFetchFollowing` 复制而来，延迟配置项未随业务切换，导致独立模式下扫描收藏使用"同步关注"的延迟档位。同文件 `runCancelBatch` 与 `handleIndependentCancel` 的延迟选择是按 `kind` 区分的（正确），此处为漏改。

---

## 四、后续清理优先级建议

以下均未执行，仅供后续排期参考：

1. **P0** 修复 B1 一行 bug：`"syncFollowings"` → `"syncCollection"`（零风险）。
2. **P1** 删除 D1 死属性、D3 死输出；D2 泛化逻辑收敛（显式 duplicated `like` 或标注不支持并报错）。
3. **P2** R1/R2 统一单一配置源，保持 `runtimeConfig` storage key 不变。
4. **P3** R3/R4/R5/R6 抽取共享函数，依赖 P1/P2 落地后，需要按既有进度消息/响应契约做回归。