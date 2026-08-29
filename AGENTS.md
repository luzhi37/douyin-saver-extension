> 本文件是面向 **AI Agent**（Claude Code 等）的技术参考，内容侧重于实现细节与设计约束。
> 人类用户请先阅读 [README.md](./README.md) 了解功能与安装。

# AGENTS.md — 抖音数据管理 (Douyin Data Manager)

任何具体行为以源码为准。深度技术细节已拆分到 `docs/*.md`，见下方[文档索引](#文档索引)。

## 代码布局规范

**所有 JS 文件必须遵守从上到下、先声明后使用的顺序**。不允许将 config/const 放在文件中部或底部、类定义与实例化分开、或执行语句出现在声明之前。

### 通用层级

```
config/const 定义          ┐ 常量在最顶部
模块级变量声明             ┘ let/const 集中
函数定义（分组）           以 `// ---------- 标签 ----------` 分隔
类定义 + 立即实例化         类定义后紧跟 const instance = new Class()
事件绑定 / 消息监听         函数定义之后，执行之前
启动逻辑                    IIFE / DOMContentLoaded 在最底部
```

### 核心规则

1. **config/const 必须在文件最顶部** — 所有后续代码可能直接引用，不允许出现在文件中部或底部
2. **class 定义与实例化成对出现** — 每个 class 定义后紧跟 `const name = new Class()`，不允许先集中列出所有 class 再集中实例化
3. **执行语句不得出现在声明之前** — 函数调用、事件绑定必须在所有配置和定义之后
4. **大段分隔用 `// ---------- 标签 ----------`** — 每个逻辑段的开头用带边框的注释标记

## 四层架构

```
inject.js (主世界)          — fetch hook, 按钮注入, 抓取逻辑
    ↓ CustomEvent
content.js (隔离世界)       — 桥接, requestResponse 模式
    ↓ chrome.runtime.sendMessage
background.js (Service Worker) — 消息路由, 存储操作, sendToTab 转发
    ↓ chrome.runtime.sendMessage
options/ (管理 UI)          — ES 模块化：core.js 共享基础（7 全局对象）+ 类模块（grids/components/data/sync）+ main.js 组合根（事件绑定/订阅/init）
```

## 双域存储模型

```js
DOMAIN_CONFIG = {
  works:       { storeName, groupsName, defaultGroups, itemKey: 'works',       idField: 'awemeId' },
  followings:  { storeName, groupsName, defaultGroups, itemKey: 'followings',  idField: 'uid', idToString: true },
}
```

- `works` — `{ [awemeId]: Work }`（每条含 `video` 视频直链与 `videoExpireAt` 过期时间戳。三级取链由 inject `extractVideo`（api 源）与 background `formatWork` **两处同款实现**：`bit_rate[].playApi` → `uri` 合成的 `/aweme/v1/play/?video_id=…` 长效链接（同手动"添加"按钮，`videoExpireAt`=0）→ CDN `url_list` 短效直链兜底（解析 `expire` 参数写入）；`mergeWork` 防止短效直链覆盖旧长效链接）
- `works_groups` — `[{ id, name, fixed, order? }]`
- `followings` — `{ [uid]: Following }`（仅保留 6 个稳定字段：uid / nickname / avatarLarger / followerCount / awemeCount 作品数 / profileUrl。followerCount/awemeCount **仅由 profile/other 校准写入**——列表接口不采集、占位为 0；`SAVE_FOLLOWINGS` 对 0 值保留旧计数）
- `followings_groups` — `[{ id, name, fixed, order? }]`

## 消息协议

background.js switch 分发所有 `chrome.runtime.sendMessage`。

| 类别                       | 消息类型                                                                                                                                                                                                                                                                                         |
|----------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 数据操作                   | `SAVE_WORKS` / `GET_WORKS` / `DELETE_WORKS` / `MOVE_WORKS` / `SYNC_WORKS` / `GET_WORK` / `SAVE_FOLLOWINGS` / `GET_FOLLOWINGS` / `DELETE_FOLLOWINGS` / `MOVE_FOLLOWINGS` / `SAVE_LIKES` / `GET_LIKES` / `DELETE_LIKES` / `MOVE_LIKES` / `SAVE_FAVORITES` / `GET_FAVORITES` / `DELETE_FAVORITES` / `MOVE_FAVORITES`（likes/favorites 经 `DomainHandlers.save` 域驱动落库，闭合原断路缺陷） |
| 分组管理                   | `GET_GROUPS` / `ADD_GROUP` / `RENAME_GROUP` / `DELETE_GROUP` / `REORDER_GROUPS`                                                                                                                                                                                                                  |
| 工具                       | `IMPORT_DATA` / `EXPORT_DATA` / `RESET_DOMAIN` / `GET_STATS` / `GET_SECURITY_STATUS` / `CALIBRATE_FOLLOWING`（单用户校准：打开侧边栏触发，background 按模式取 profile/other 后直接落库） / `SET_MODE` / `CAPTURE_BROWSER_FEATURES` / `GET_COOKIE_INFO` / `GET_BROWSER_FEATURES` / `GET_CACHE_TIMES` / `RESOLVE_SEC_UID` / `REFRESH_MSTOKEN` / `REFRESH_WEBID` / `REFRESH_BROWSER_FEATURES` / `REFRESH_COOKIE` / `RELOAD_CONFIG` |
| 扫描入口                   | `FETCH_FOLLOWING` / `FETCH_FAVORITES` / `FETCH_COLLECTION` — options/（main.js 触发）background 的循环扫描；background 内逐页请求后透传进度。`FETCH_FOLLOWING` 列表收集完成后自动进入校准阶段（`scanTasks.calibrateStats` 逐用户请求 profile/other，覆盖 awemeCount/followerCount），受运行参数 `calibrateFollowings` 开关门控                              |
| 取消入口                   | `CANCEL_LIKE` / `CANCEL_COLLECTION` — options/ 触发 background 的批量取消；tab 模式下逐条派发 `CANCEL_ONE_*` 到 inject；独立模式下由 `independentTasks.cancel` 直接在 background 循环 POST                                                                                                     |
| 取消信号                   | `CANCEL_ACTIVE_TASK` — tab 模式下经 options→background→content→inject 触发 `activeTask.abort()`；独立模式下直接在 background 取消循环；仅在长操作弹窗关闭时发送（无 `state.activeDialog` 时不发送）                                                                                              |
| Tab 转发（background→tab） | `FETCH_SINGLE_WORK` / `FETCH_FOLLOWING_PAGE` / `FETCH_USER_PROFILE` / `FETCH_FAVORITES_PAGE` / `FETCH_COLLECTION_PAGE` / `CANCEL_ONE_LIKE` / `CANCEL_ONE_COLLECTION`（tab 模式下经 content→inject；独立模式下由 background 直接 POST） / `FETCH_WORKS_PAGE`（独立模式下由 background 直接处理） / `GET_SECURITY_STATUS` |
| 进度消息                   | `SYNC_PROGRESS` / `FOLLOWING_PROGRESS` / `FAVORITES_PROGRESS` / `COLLECTION_PROGRESS` / `CANCEL_PROGRESS` / `CANCEL_DONE` — 由 background 循环 handler 直接发出到 options，不再经 content.js 转发（`FOLLOWING_PROGRESS` 带 `phase:"calibrate"` 表示关注校准阶段）                                                                                                |

**长任务链路模式**：
- `tabBridge.send`（`sendToTab`）：`TabBridge` 生成 `requestId`，向抖音标签页发消息，等待超时 `CONFIG.TIMEOUT.REQUEST`（默认 30s，`GET_SECURITY_STATUS` 5s）。内部 `.catch()` 处理 `find()` 极端异常路径。
- `tabBridge.sendAsync`（`sendToTabAsync`）：`send` 的 Promise 封装，用于 background 循环 handler 中逐条/逐页请求（`SYNC_WORKS`、`FETCH_FOLLOWING`、`FETCH_FAVORITES`、`FETCH_COLLECTION` 的 background 循环均使用此模式；独立模式下 `CANCEL_LIKE`/`CANCEL_COLLECTION` 由 `independentTasks.cancel` 在 background 内直接循环，不走此路径）。
- `requestResponse`：content.js **先 `addEventListener(resultEvent)` 再 `dispatchEvent(requestEvent)`**，消除同步 handler 的 `setTimeout(0)` workaround 需求。

> 同步/扫描/取消的完整链路、时序差异、分页参数见 docs/02–09 各分册（索引见文末「文档索引」）。

## 响应式状态管理

`store.on()` 监听事件：

| 事件               | 处理                                                                                                     |
|--------------------|----------------------------------------------------------------------------------------------------------|
| `'domain'`         | 更新同步按钮、渲染分组 tab、加载域数据（`currentGroupId` 由 `switchDomain` 直接赋 `'all'` 而非通过事件） |
| `'works'`          | `worksGrid.renderCards()`（仅 domain=works）                                                             |
| `'followings'`     | `followingsGrid.renderFollowingCards()`（仅 domain=followings）                                          |
| `'groups'`         | `groups.renderGroupTabs()`                                                                               |
| `'currentGroupId'` | `groups.renderGroupTabs()` + 加载域数据                                                                  |
| `'batchMode'`      | toggle body `.batch-mode` class                                                                          |
| `'work-updated'`   | `worksGrid.updateCardDOM(awemeId)` + 若详情打开则重渲染                                                  |

## Class 职责概览

| Class            | 职责                                                              |
|------------------|-------------------------------------------------------------------|
| `SearchBar`      | 搜索/筛选子系统（数据层视图 getWorksView/getFollowingsView/isFilterActive + 搜索栏 UI 同步与开关；检索状态封装为 `#searchState` 私有实例字段；作品型三域带「已关注/未关注」作者归属勾选；**收起即重置**——所有筛选/排序改动不跨收起保留，无筛选摘要条；元素事件在构造器内自绑定） |
| `VirtualGrid`    | 网格渲染基类（骨架 + 双向虚拟化：填充/卸载双 observer + 分时间预算填充 + 事件委托） |
| `Dialog`         | 弹窗管理                                                          |
| `FollowingsGrid` | 关注卡片网格                                                      |
| `Groups`         | 分组 tab + 管理                                                   |
| `Batch`          | 批量操作（勾选、全选、删除、移动）                                |
| `ImportExport`   | 导入导出                                                          |
| `Sidebar`        | 侧边栏（作者作品分页 + 条目升降级虚拟化）                                            |
| `Sync`           | 同步状态机（作品/关注）                                           |
| `Favorites`      | 点赞/收藏扫描、未关注作品批量入库（添加按钮）与取消               |
| `WorksGrid`      | 作品卡片网格                                                      |
| `Detail`         | 详情播放器                                                        |
| `AppShell`       | 应用壳（域切换滑块 switchDomain/updateDomainSlider、全局错误态 renderErrorState、弹窗关闭统一入口 requestDialogClose；ds-btn/resize/btnRetry 事件构造器内自绑定） |

### background.js 类单例（重构后与 options 侧类模块同构）

`background/background.js` 已由「纯函数 + 模块级 let」重构为 3 个对象 + 10 个类，状态全部塌缩为类私有字段；`App.route()` 吸收原 `route` 内全部分支（含 11 个内联处理器）。

| 类 / 对象              | 职责                                                                                                                                                      |
|------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------|
| `runtimeConfig` (对象) | 运行时配置：从 `chrome.storage.local` 读 `runtimeConfig` 叠加进 `CONFIG`（`KEY`/`DEFAULTS`/`load`/`save`/`apply`/`reload`/`delayRange`）；校准开关写入 `IndependentClient` |
| `utils` (对象)        | 纯函数集：`parseExpire` / `urlExpireAt` / `isLongLivedVideoUrl` / `extractMsTokenFromCookie` / `asyncHandler` / `sendSyncDone`                             |
| `formatters` (对象)   | `formatWork` / `formatFollowing`                                                                                                                          |
| `Credentials`         | 客户端凭据/签名：持有 `#abOgus`/`#cachedClockSkew`/`#clockSkewTime`；`ensureABogus`/`getClockSkew`/`buildBaseParams`/`getMsToken`/`refreshWebIdChain`；吸收 `GET_COOKIE_INFO`/`GET_BROWSER_FEATURES`/`GET_CACHE_TIMES`/`REFRESH_MSTOKEN`/`REFRESH_WEBID`/`REFRESH_BROWSER_FEATURES`/`REFRESH_COOKIE`/`CAPTURE_BROWSER_FEATURES` |
| `IndependentClient`   | 独立模式开关/校准开关（持有 `#mode`/`#loaded`/`#calibrate`）+ 签名直连 `request` + `resolveSelfSecUid`；`request` 经 `credentials` 跨类取签名/时钟/msToken |
| `DomainStore`         | 域存储封装：`storeName`/`groupsName`/`defaultGroups`/`toStorageId`/`facade`；`mergeWork`；`mergeAndSave`（三作品型域通用）/ `mergeAndSaveFollowings`（计数保护） |
| `DomainHandlers`      | 域数据操作入口（4 实例 works/followings/likes/favorites）；`save` 已域驱动闭合 likes/favorites 断路；`get`/`delete`/`move`/`getOne`/`#saveFollowings`       |
| `TabBridge`           | 抖音标签页查找/转发（`find`/`send`/`sendAsync`）；吸收 `CANCEL_ACTIVE_TASK`/`GET_SECURITY_STATUS`/`FETCH_WORKS_PAGE` 非独立分支                            |
| `Groups`              | 分组 tab + 管理（域感知）                                                                                                                                 |
| `DataTools`           | 导入导出/重置/统计（域感知）；`reconcileImportGroups`                                                                                                     |
| `ScanTasks`           | Tab 模式长任务：`calibrateStats`/`calibrateOne`/`fetchFollowing`/`persistScan`/`fetchFavorites`/`fetchCollection`/`runCancelBatch`/`deleteCancelled`/`syncWorks` |
| `IndependentTasks`    | 独立模式长任务：`fetchFollowing`/`fetchCollection`/`syncWorks`/`fetchWorksPage`/`cancel`                                                                   |
| `App`                 | 初始化（注册 `onInstalled`/`onStartup`/`onClicked` + `setupDeclarativeNetRequest`）+ 消息路由 `route`（`SET_MODE` 调 `independentClient.setMode`）         |

## 设计约定与知识点陷阱

> 本节只保留规则红线；机制原理、历史踩坑与实测数据见各条目指向的分册。

- **所有共享全局变量定义在 `options/core.js` 顶部** — `config` / `dom` / `state` / `store` / `utils` / `runtimeConfig` / `services` 在 core.js 顶部定义并 export，其余模块经 ES import 引用；各模块文件自身仍遵守「class 定义后紧跟实例化」（类间循环 import 靠 live binding 在调用时安全消解，拆分方案见 [plans/options-module-split-plan.md](./plans/options-module-split-plan.md)）。
- **私有方法使用 `#` 语法** — 类外部不可访问。
- **class field 箭头仅用于 add/remove 对称的事件回调** — 如 `Sidebar.#onResizeDown/Move/Up`、`Detail.#noteKeyHandler`。
- **自引用用 `this.xxx()` 而非单例名** — class 内部调用自身方法必须用 `this`，不要用模块级单例变量。
- **批量勾选必须用 `Batch.updateCheckboxDOM`** — 手动设置 `checkbox.innerHTML` 只能显示图标，必须同时添加/移除 `checked` 类（默认 `color: transparent`）。
- **`handleBatchSelectAll` 必须按域选择 checkbox** — 作品域 `.work-checkbox`，关注域 `.following-checkbox`。
- **取消信号必须发到抖音 document** — `DY_CANCEL_ACTIVE_TASK` 经 background→content→inject 路径送达，不能直接在 options 页 dispatch（路径差异见 [docs/01](./docs/01-project-architecture.md) / [docs/09](./docs/09-inject-tab-mode.md)）。
- **同步 requestId 时序差异** — `SYNC_WORKS` 立即返回 requestId；`FETCH_FOLLOWING` 等 fetch 完成才返回，关注进度过滤必须兼容 `Sync.#followingsRequestId === null`（见 [docs/03](./docs/03-independent-sync-followings.md) / [docs/11](./docs/11-options-ui.md)）。
- **同步 handler 已无需延迟派发结果** — `requestResponse` 先 `addEventListener` 再 `dispatchEvent`，`setTimeout(0)` workaround 已废除（见 [docs/09](./docs/09-inject-tab-mode.md)）。
- **安全面板值截断依赖 CSS，展开/收起 selector 兼容两种状态** — JS 不截断文本，靠 `.sec-truncate` 视觉截断；selector 用 `row.querySelector('.sec-truncate, .sec-expanded')`（见 [docs/09](./docs/09-inject-tab-mode.md)）。
- **取消点赞/收藏用 XHR 而非 fetch（Tab模式）** — a_bogus 签名与 XHR 原型链深度绑定，fetch 发不出有效签名；独立模式由 background 直接 `fetch()` POST（无页面上下文），Referer / Sec-Fetch-* 靠 DNR 规则网络层注入（见 [docs/06](./docs/06-independent-cancel-collection.md) / [docs/08](./docs/08-dnr-rules.md) / [docs/09](./docs/09-inject-tab-mode.md)）。
- **inject `extractVideo` 与 background `formatWork` 取链语义必须保持一致** — 三级优先定案（长效 playApi 作为整体类目优先于 CDN、只在同类内部比分辨率；禁止改回混池挑最高分辨率；fiber 分支有意不同勿混改）见 [docs/02](./docs/02-independent-sync-works.md) / [docs/09](./docs/09-inject-tab-mode.md)。
- **独立模式 listcollection 需 Argus webSign 签名** — 该端点被服务端额外校验，缺签名 403 `Signature Not Found`；算法、线格式与盐轮换处置见 [docs/05-independent-scan-collection.md](./docs/05-independent-scan-collection.md)。
- **短操作弹窗锁定** — `state.preventDialogClose = true` + `try/finally` 解锁；`CANCEL_ACTIVE_TASK` 仅当 `state.activeDialog` 存在时发送（长操作 X 恒可点）。机制见 [docs/11](./docs/11-options-ui.md)。
- **API 请求统一用 `window.fetch` + `_dyInternal` 标志** — inject 六个 API 请求函数经 Fetch Hook 但不被捕获；走 `origFetch.call(window, ...)` 绕过 Hook 会错过页面包装器注入的签名参数（见 [docs/09](./docs/09-inject-tab-mode.md)）。
- **媒体加载有全局熔断** — 视频/封面失败密集超阈值进入冷却期，期间跳过重试直接降级；新增媒体重试逻辑必须接入 `Detail.markMediaFail / markMediaOk / mediaRetryBlocked`，不要自行计数（见 [docs/11](./docs/11-options-ui.md)）。
- **侧边栏封面必须走"视口门控 + 分帧队列"** — 条目创建只挂 meta 不发探针，进视口由 `#promoteItem` 经 `#enqueueCover` 每帧限量 rAF 发出；整页 DOM 用单个 fragment 追加。禁止改回创建即全量急切加载（见 [docs/11](./docs/11-options-ui.md)）。
- **侧边栏是升降级式轻量虚拟化，且不用 `content-visibility:auto`** — observer root 必须显式传 `dom.sidebarBody`（null root 被祖先裁剪抵消致预填失效）；`#promoteItem`/`#demoteItem` 原地升降级、根节点不换；`.sidebar-work-item` 加 CV 只剩每帧 Layerize 抖动（详见 [docs/11](./docs/11-options-ui.md)）。
- **VirtualGrid 填充观察者是分圈观察，不是全量 observe** — 新骨架进 `#pendingSkeletons` 队列逐批交给 IO，圈尾哨兵触发续批；哨兵被删须立刻续接，`render()`/`abortRender()` 重置须同清队列状态（成本依据与细则见 [docs/11](./docs/11-options-ui.md)）。
- **网格卡片是双向虚拟化的** — 填充/卸载双 observer + 时间预算制分帧填充（勿改回固定张数/帧）；卸载圈远大于填充圈形成滞回勿调近；`populateItem` 负责 observe 完整卡的交接，`updateCardDOM` 已兼容骨架态（见 [docs/11](./docs/11-options-ui.md)）。
- **填充/降级必须在骨架根节点上原地切换（禁止换根节点）** — grid 容器任一直接子节点被替换都触发 Blink 全量重排，成本随卡片总数线性；子类只允许改类名与增删根节点后代，骨架模板必须与完整卡根层同构（见 [docs/11](./docs/11-options-ui.md)）。
- **悬停预览的媒体事件用 `pointerover/out` 委托，禁用 `pointerenter/leave`** — enter/leave 不冒泡，容器级委托收不到卡片进入事件（静默失效）；跨界只触发一次靠 `relatedTarget && media.contains(relatedTarget)` 判断（见 [docs/11](./docs/11-options-ui.md)）。
- **网格媒体一律 `div`+`background-image`，禁止改回 `<img src>`** — 四个槽位全是 `<div role="img">`（唯一例外详情大图 `<img>`+探针）；离屏探针先行、成功才提交背景图；在途探针回调必须先校验代际再提交。各槽位失败语义、代际机制与清背景要求全文见 [docs/11](./docs/11-options-ui.md)。
- **自带 display 值的组件类与 `.hidden` 同用必须成对声明 `.X.hidden { display: none }`** — 同特异性下通用 `.hidden` 被文件后部组件规则覆盖，hidden 静默失效、占位层常显（见 [docs/11](./docs/11-options-ui.md)）。
- **搜索栏收起即重置，筛选不跨收起保留** — `closeSearchBar()` 必须先调 `clearSearchFilters()` 恢复默认初始状态（关键词/排序/归属勾选/逆序全部复位）；无「收起但筛选仍生效」的摘要条。域切换**不**重置（搜索栏展开期间改动按现态保留）。
- **「已关注/未关注」归属判定走方案A：作品 `uid` 实时关联关注全集** — 全集用 `state.followedUids`（`services.loadFollowedUids()` 全量 `groupId:'all'` 加载，不受关注分组影响，init/域切换/`followings` 事件三处刷新）；记录无 `uid` 或全集未加载成功（`state.followedUidsLoaded`）时**不归判**，避免把已关注作者作品误算为未关注引入误删。禁止改用扫描快照 `authorFollowed` 做该判定的主判据。

## config 分组速查

`options/core.js` 顶层 `config` 常量（35 个键）。`background.js` 另有顶层 `CONFIG` 含 `TIMEOUT` / `DELAY` / `SYNC` / `STORAGE_KEYS` / `DNR_RULES` / `GROUPS` / `PAGE` / `CANCEL` / `FATAL_ERRORS` / `WEBID_API` / `WEB_SIGN_SALT` 等，以及重构后的 `runtimeConfig` 对象（含 `KEY`/`DEFAULTS`/`load`/`save`/`apply`/`reload`/`delayRange`，从 `chrome.storage.local` 读取并叠加进 `CONFIG`）；`background.js` 的模块级可变状态（原 `abOgus`/`cachedClockSkew`/clockSkewTime/独立模式三开关）已全部塌缩为 `Credentials`/`IndependentClient` 的类私有字段：

| 分组       | 键                                                                                                                            |
|------------|-------------------------------------------------------------------------------------------------------------------------------|
| 视频重试   | `VIDEO_RETRY_DELAYS` `[200,400,600]` / `VIDEO_RETRY_MAX` `3` / `VIDEO_RETRY_FALLBACK_DELAY` `1000`                            |
| 媒体熔断   | `MEDIA_FAIL_WINDOW` `5000` / `MEDIA_FAIL_MAX` `10` / `MEDIA_BREAK_COOLDOWN` `15000`                                           |
| 超时       | `FETCH_RETRY_DELAY` `1000` / `SYNC_TIMEOUT` `30000` / `VIDEO_FALLBACK_TIMEOUT` `5000`                                         |
| 详情页     | `DETAIL_TITLE_MAX_LEN` `40` / `TOAST_DURATION` `2000` / `DOWNLOAD_MAX_RETRY` `1`                                              |
| UI 延迟    | `HOVER_PREVIEW_DELAY` `200` / `BLOB_REVOKE_DELAY` `10000` / `NOTE_AUTO_PLAY_INTERVAL` `3000`                                  |
| 侧边栏     | `SIDEBAR_SNAP_POINTS` `[650,0]` / `SIDEBAR_SCROLL_THRESHOLD` `100` / `SIDEBAR_FILL_THRESHOLD` `50` / `SIDEBAR_IMG_PER_FRAME` `6` / `SIDEBAR_DRAG_THRESHOLD` `4` |
| 网格项尺寸 | `CARD_SIZE_FALLBACK` `261` / `CARD_GAP` `9` / `CARD_HEIGHT_OFFSET` `35`                                                       |
| 分块渲染   | `RENDER_CHUNK_SIZE` `50` / `OBSERVER_ROOT_MARGIN` `'200px'` / `OBSERVE_CHUNK_SIZE` `48` / `FILL_FRAME_BUDGET_MS` `8` / `UNLOAD_ROOT_MARGIN` `'1200px'`    |
| 分组/存储  | `GROUP_NAME_MAX_LEN` `20` / `STORAGE_MAX_BYTES` `10MB` / `TRASH_GROUP_NAME` `'稍后删除'`                                      |
| Tab 滚动   | `TAB_SCROLL_THRESHOLD` `2`                                                                                                    |
| 抖音 URL   | `URL_BASE` / `URL_USER_SELF` / `URL_LIKE_TAB` / `URL_COLLECTION_TAB` / `URL_FOLLOWING_TAB`                                    |
| 正则/图标  | `SEC_UID_REGEX` `/^\/user\/([^/?]+)/` / `icons` `{}`（init 填充）                                                             |

## 文档索引

技术文档已按单一职责拆分为编号分册（术语规范见 01：**Tab模式**=页面注入脚本方式；**独立模式**=纯后台逆向请求流程）：

| 文档 | 阅读场景 |
|------|----------|
| [docs/01-project-architecture.md](./docs/01-project-architecture.md) | 项目架构：双模运行与路由隔离、代码布局约束、双域存储模型、通信协议、全局配置 |
| [docs/02-independent-sync-works.md](./docs/02-independent-sync-works.md) | 独立模式同步作品（SYNC_WORKS / formatWork 三级取链） |
| [docs/03-independent-sync-followings.md](./docs/03-independent-sync-followings.md) | 独立模式同步关注（FETCH_FOLLOWING 分页采集） |
| [docs/04-independent-calibrate-followings.md](./docs/04-independent-calibrate-followings.md) | 关注计数校准（批量 calibrateFollowingStats + 侧边栏单用户 CALIBRATE_FOLLOWING） |
| [docs/05-independent-scan-collection.md](./docs/05-independent-scan-collection.md) | 独立模式扫描收藏（listcollection 线格式 + Argus webSign 定案、绑定域实验、盐轮换处置） |
| [docs/06-independent-cancel-collection.md](./docs/06-independent-cancel-collection.md) | 独立模式取消收藏（background 直连 POST 循环） |
| [docs/07-independent-fetch-user-works.md](./docs/07-independent-fetch-user-works.md) | 作者主页作品分页（FETCH_WORKS_PAGE 双模分支） |
| [docs/08-dnr-rules.md](./docs/08-dnr-rules.md) | 全部 DNR 动态规则（7 条）、优先级关系与排障 |
| [docs/09-inject-tab-mode.md](./docs/09-inject-tab-mode.md) | Tab模式注入侧技术方案：签名捕获/三种签名策略/_dyInternal、事件桥、按钮注入、取消信号 |
| [docs/10-storage-write-and-import.md](./docs/10-storage-write-and-import.md) | 存储写入与导入合并：mergeWork/计数保护/丢失检测/reconcileImportGroups 三级对账 |
| [docs/11-options-ui.md](./docs/11-options-ui.md) | 管理页渲染与交互：VirtualGrid/Sidebar 虚拟化与分圈观察、媒体探针体系与全局熔断、勾选 DOM 约定、弹窗锁定与取消门控、CSS 协同约定 |
| [docs/TIKTOK_REFERENCE.md](./docs/TIKTOK_REFERENCE.md)   | 参考项目 TikTokDownloader 算法/凭据模块 + Douyin API 端点总表                  |
