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
5. **`background/` 按职责分子目录、每类独立成文件（文件名 = kebab-case 类名）** — 子目录划分与 `main.js` 组合根见「background/ 类单例」表；类间循环 import 靠 live binding 在调用时安全消解

## 四层架构

```
inject.js (主世界)          — fetch hook, 按钮注入, 抓取逻辑
    ↓ CustomEvent
content.js (隔离世界)       — 桥接, requestResponse 模式
    ↓ chrome.runtime.sendMessage
background/ (Service Worker) — ES 模块化：core.js 共享基础 + identity/data/tasks 子目录类模块 + main.js 组合根（消息路由 App.route）
    ↓ chrome.runtime.sendMessage
options/ (管理 UI)          — ES 模块化：core.js 共享基础（7 全局对象）+ 类模块（grids/components/data/sync）+ main.js 组合根（事件绑定/订阅/init）
```

## 四域存储模型

```js
DOMAIN_CONFIG = {
  works:       { storeName, groupsName, defaultGroups, itemKey: 'works',       idField: 'awemeId' },
  followings:  { storeName, groupsName, defaultGroups, itemKey: 'followings',  idField: 'uid', idToString: true },
  likes:       { storeName, groupsName, defaultGroups, itemKey: 'likes',       idField: 'awemeId' },
  favorites:   { storeName, groupsName, defaultGroups, itemKey: 'favorites',   idField: 'awemeId' },
}
```

- `works` — `{ [awemeId]: Work }`（每条含 `video` 视频直链与 `videoExpireAt` 过期时间戳；三级取链由 inject `extractVideo` 与 background `formatWork` **两处同款实现**：长效 playApi → CDN 短效兜底，`mergeWork` 防短效覆盖长效，细则见 docs/02）
- `works_groups` — `[{ id, name, fixed, order? }]`
- `likes` / `favorites` — 与 `works` 同构的 Work 记录（itemKey 各自独立）；无独立保存消息，落库经 `persistScan` 的 `mergeAndSave`（persist="likes"/"favorites"）与跨域 `SAVE_WORKS`
- `likes_groups` / `favorites_groups` — 与 `works_groups` 同构
- `followings` — `{ [uid]: Following }`（7 个稳定字段：uid / nickname / avatarLarger / followerCount / awemeCount / profileUrl / lastUpdateAt（毫秒时间戳）；followerCount/awemeCount 仅由校准写入、lastUpdateAt 仅由校准取作品第一页 max(create_time) 写入——未校准占位 0，`SAVE_FOLLOWINGS` 对 0 值保留旧计数）
- `followings_groups` — `[{ id, name, fixed, order? }]`

## 消息协议

`App.route()`（`background/main.js`）switch 分发所有 `chrome.runtime.sendMessage`。

| 类别                       | 消息类型                                                                                                                                                                                                                                                                                         |
|----------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 数据操作                   | `SAVE_WORKS` / `GET_WORKS` / `DELETE_WORKS` / `MOVE_WORKS` / `SYNC_WORKS` / `GET_WORK` / `SAVE_FOLLOWINGS` / `GET_FOLLOWINGS` / `DELETE_FOLLOWINGS` / `MOVE_FOLLOWINGS` / `GET_LIKES` / `DELETE_LIKES` / `MOVE_LIKES` / `GET_FAVORITES` / `DELETE_FAVORITES` / `MOVE_FAVORITES`（likes/favorites 无独立保存消息，落库经 `SAVE_WORKS`/`persistScan`） |
| 分组管理                   | `GET_GROUPS` / `ADD_GROUP` / `RENAME_GROUP` / `DELETE_GROUP` / `REORDER_GROUPS`                                                                                                                                                                                                                  |
| 工具                       | `IMPORT_DATA` / `EXPORT_DATA` / `RESET_DOMAIN` / `GET_STATS` / `GET_SECURITY_STATUS` / `CALIBRATE_FOLLOWING`（单用户校准：打开侧边栏触发，background 按模式取 profile/other 后直接落库） / `SET_MODE` / `CAPTURE_BROWSER_FEATURES` / `GET_COOKIE_INFO` / `GET_BROWSER_FEATURES` / `GET_CACHE_TIMES` / `RESOLVE_SEC_UID` / `REFRESH_MSTOKEN` / `REFRESH_WEBID` / `REFRESH_BROWSER_FEATURES` / `REFRESH_COOKIE` / `RELOAD_CONFIG` |
| 扫描入口                   | `FETCH_FOLLOWING` / `FETCH_FAVORITES` / `FETCH_COLLECTION` — options/（main.js 触发）background 的循环扫描；background 内逐页请求后透传进度。`FETCH_FOLLOWING` 列表收集完成后自动进入校准阶段（`calibrateFollowings` 开关门控，校准细节见 docs/04）                              |
| 入库                       | `IMPORT_USER_WORKS`（作者作品分页循环批量入作品域：每页 mergeAndSave 落库、无丢失检测、不预置 groupId——已在域的保留原分组、新条目落「未分组」；过程消息 `IMPORT_WORKS_PROGRESS`）/ `IMPORT_FOLLOWING`（profile/other 单请求收录作者档案入关注域，同款分组语义）/ `RESOLVE_AUTHOR`（输入解析：sec_uid 直通，纯数字 uid 经 im/user/info 兑换，见 `IndependentClient.resolveSecUidById`）— 均双模支持，入口为菜单「入库」弹窗（`AuthorImport`） |
| 取消入口                   | `CANCEL_LIKE` / `CANCEL_COLLECTION` — options/ 触发 background 的批量取消；tab 模式下逐条派发 `CANCEL_ONE_*` 到 inject；独立模式下仅 `CANCEL_COLLECTION` 走 `independentTasks.cancel` 在 background 循环 POST（取消点赞独立模式在路由层拒绝 `UNSUPPORTED_INDEPENDENT`）                                                                                                     |
| 取消信号                   | `CANCEL_ACTIVE_TASK` — tab 模式下经 options→background→content→inject 触发 `activeTask.abort()`；独立模式下直接在 background 取消循环；仅在长操作弹窗关闭时发送（无 `state.activeDialog` 时不发送）                                                                                              |
| Tab 转发（background→tab） | `FETCH_SINGLE_WORK` / `FETCH_FOLLOWING_PAGE` / `FETCH_USER_PROFILE` / `FETCH_FAVORITES_PAGE` / `FETCH_COLLECTION_PAGE` / `CANCEL_ONE_LIKE` / `CANCEL_ONE_COLLECTION`（tab 模式下经 content→inject；独立模式下由 background 直接 POST） / `FETCH_WORKS_PAGE`（独立模式下由 background 直接处理） / `GET_SECURITY_STATUS` |
| 进度消息                   | `SYNC_PROGRESS` / `FOLLOWING_PROGRESS` / `FAVORITES_PROGRESS` / `COLLECTION_PROGRESS` / `IMPORT_WORKS_PROGRESS` / `CANCEL_PROGRESS` / `CANCEL_DONE` — 由 background 循环 handler 直接发出到 options，不再经 content.js 转发（`FOLLOWING_PROGRESS` 带 `phase:"calibrate"` 表示关注校准阶段）                                                                                                |

**长任务链路模式**：
- `tabBridge.send`（`sendToTab`）：`TabBridge` 生成 `requestId`，向抖音标签页发消息，等待超时 `CONFIG.TIMEOUT.REQUEST`（默认 30s，`GET_SECURITY_STATUS` 5s）。内部 `.catch()` 处理 `find()` 极端异常路径。
- `tabBridge.sendAsync`（`sendToTabAsync`）：`send` 的 Promise 封装，用于 background 循环 handler 中逐条/逐页请求（同步/扫描/取消循环均用此模式；独立模式 `CANCEL_COLLECTION` 由 `independentTasks.cancel` 在 background 内直接循环，不走此路径）。
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
| `'batchMode'`      | toggle body `.batch-mode` class + `Batch.syncSelectionUI`（批量栏显隐与「批量」按钮文案由 CSS `body.batch-mode` 驱动，无独立 #batchBar 元素）        |
| `'work-updated'`   | `worksGrid.updateCardDOM(awemeId)` + 若详情打开则重渲染                                                  |

## Class 职责概览

| Class            | 职责                                                              |
|------------------|-------------------------------------------------------------------|
| `SearchBar`      | 搜索/筛选子系统（数据层视图 getWorksView/getFollowingsView/isFilterActive + 检索状态 `#searchState`；作品型三域带「已关注/未关注」归属勾选与「全部/视频/图集」类型筛选；结果数 K/N=过滤视图/域全量；收起即重置见「设计约定」；事件构造器内自绑定） |
| `VirtualGrid`    | 网格渲染基类（骨架 + 双向虚拟化：填充/卸载双 observer + 分时间预算填充 + 事件委托） |
| `Dialog`         | 多层弹窗管理（基层静态 #dialogOverlay + pushDialog 动态实例叠层，关闭顶层自动回父层；`dom.dialogTitle/dialogBody/dialogFooter/dialogClose` 由其动态指向顶层实例元素，仅该类可写） |
| `FollowingsGrid` | 关注卡片网格                                                      |
| `Groups`         | 分组 tab + 管理                                                   |
| `Batch`          | 批量操作（勾选、全选、删除、移动、下载；批量下载仅作品/点赞/收藏域）+ 未关注作品批量入库（添加按钮，跨域经 `SAVE_WORKS` 写入作品域） |
| `ImportExport`   | 备份弹窗（四域导出/导入聚合于单弹窗，按钮由 `DOMAINS_META` 生成、显式指定目标域，不随当前域自适应；导入经隐藏 fileInput 按 `#pendingImportDomain` 分流） |
| `Sidebar`        | 侧边栏（作者作品分页 + 条目升降级虚拟化）                                            |
| `Sync`           | 同步状态机（作品/关注）                                           |
| `DomainScanSync` | 点赞/收藏域扫描同步（`FETCH_FAVORITES`/`FETCH_COLLECTION` 进度弹窗 + 丢失检测 UI；与 Sync 同构的姊妹状态机，落库由 background `persistScan` 直写，本类只驱动进度与刷新） |
| `AuthorImport`   | 入库（菜单「入库」弹窗：作品域/关注域两行输入；作品域=分页循环长任务+进度弹窗复用 syncDialogBodyTemplate，关注域=单请求收录作者档案；输入解析 sec_uid/uid/主页链接；与 Sync/DomainScanSync 三链路互斥） |
| `Settings`       | 设置面板（安全状态/ Cookie/浏览器特征/运行参数面板；开关仅切视觉态，校验与持久化统一走 `saveBeforeClose`；私有成员全部 `#` 前缀） |
| `WorksGrid`      | 作品卡片网格                                                      |
| `Detail`         | 详情播放器（对齐抖音播放界面：全宽播放器 + .media-view 居中 39.3vw cover 裁切、双形态进度条（视频连续轨道/图集分段音乐驱动）、⌃⌄ 作品切换胶囊） |
| `AppShell`       | 应用壳（域切换滑块 switchDomain/updateDomainSlider、全局错误态 renderErrorState、弹窗关闭统一入口 requestDialogClose；ds-btn/resize/btnRetry 事件构造器内自绑定） |

### background/ 类单例（按职责分模块，与 options 侧类模块同构）

| 类 / 对象              | 文件                         | 职责                                                                                                                                                  |
|------------------------|------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------|
| `runtimeConfig` (对象) | `core.js`                    | 运行时配置：从 `chrome.storage.local` 读入叠加进 `CONFIG`（`KEY`/`DEFAULTS`/`load`/`apply`/`reload`/`delayRange`，`save` 仅 options 侧有）；校准开关写入 `IndependentClient`；SW 冷启动补 reload 恢复运行参数 |
| `utils` (对象)         | `core.js`                    | 纯函数集：`parseExpire` / `urlExpireAt` / `isLongLivedVideoUrl` / `extractMsTokenFromCookie` / `asyncHandler` / `sendSyncDone`                         |
| `formatters` (对象)    | `core.js`                    | `formatWork` / `formatFollowing` / `formatFollowingFromProfile`                                                                                       |
| `Crypto` (静态)        | `identity/crypto.js`        | 哈希/解析工具静态类：`md5Hex`（Argus webSign）/ `parseCookieToPairs` / `generateRandomMsToken`                                                        |
| `ABogus`               | `identity/crypto.js`        | a_bogus 签名算法类（按 UA/浏览器特性实例化，`Credentials.ensureABogus` 使用）；同文件导出 `MSSDK_STR_DATA`（mssdk 兑换载荷）                          |
| `Credentials`          | `identity/credentials.js`    | 客户端凭据/签名：持有 `#abOgus`/`#cachedClockSkew`/`#clockSkewTime`；`ensureABogus`/`getClockSkew`/`buildBaseParams`/`getMsToken`/`refreshWebIdChain`；吸收凭据类消息（见「消息协议」工具行） |
| `IndependentClient`    | `identity/independent-client.js` | 独立模式开关/校准开关（持有 `#mode`/`#loaded`/`#calibrate`）+ 签名直连 `request` + `resolveSelfSecUid`（内含 `resolveSecUidById` 兑换）；`request` 经 `credentials` 跨类取签名/时钟/msToken |
| `Storage`              | `data/storage.js`           | IndexedDB 封装层（单例连接 `#db`）：`getAll`/`get`/`putBatch`/`deleteBatch`/`clear`/`count`/`getByIndex`/`countByIndex`/`getGroups`/`putGroups`/`estimate` |
| `DomainStore`          | `data/domain-store.js`       | 域存储封装：`storeName`/`groupsName`/`defaultGroups`/`toStorageId`/`facade`；`mergeWork`；`mergeAndSave`（三作品型域通用）/ `mergeAndSaveFollowings`（计数保护） |
| `DomainHandlers`       | `data/domain-handlers.js`    | 域数据操作入口（4 实例 works/followings/likes/favorites）；`save` 已域驱动闭合 likes/favorites 断路；`get`/`delete`/`move`/`getOne`/`#saveFollowings`  |
| `TabBridge`            | `identity/tab-bridge.js`     | 抖音标签页查找/转发（`find`/`send`/`sendAsync`）；吸收 `CANCEL_ACTIVE_TASK`/`GET_SECURITY_STATUS`/`FETCH_WORKS_PAGE` 非独立分支                    |
| `Groups`               | `data/groups.js`             | 分组 tab + 管理（域感知）                                                                                                                            |
| `DataTools`            | `data/data-tools.js`         | 导入导出/重置/统计（域感知）；`reconcileImportGroups`                                                                                                 |
| `ScanTasks`            | `tasks/scan-tasks.js`        | Tab 模式长任务：同步/扫描/取消/校准循环（含 `persistScan` 落库、`#fetchLatestWorkTime` 校准日期采集）；`importUserWorks`（作者作品入库循环）/`importFollowing`（含 `#fetchProfileUser` 双模档案取数） |
| `IndependentTasks`     | `tasks/independent-tasks.js` | 独立模式长任务：`fetchFollowing`/`fetchCollection`/`syncWorks`/`fetchWorksPage`/`importUserWorks`/`cancel`                                            |
| `App`                  | `main.js`                    | 初始化（注册 `onInstalled`/`onStartup`/`onClicked` + `setupDeclarativeNetRequest`）+ 消息路由 `route`（`SET_MODE` 调 `independentClient.setMode`）  |

## 设计约定与知识点陷阱

> 本节只保留规则红线；机制原理、历史踩坑与实测数据见各条目指向的分册。未单独标注依据的条目，均为 [docs/11](./docs/11-options-ui.md)。

### 编码约定

- **所有共享全局变量定义在 `options/core.js` 顶部** — `config` / `dom` / `state` / `store` / `utils` / `runtimeConfig` / `services` 在此定义并 export，其余模块经 ES import 引用；各模块文件自身仍遵守「class 定义后紧跟实例化」（类间循环 import 靠 live binding 在调用时安全消解）。
- **私有方法用 `#` 语法** — 类外部不可访问；class field 箭头仅用于 add/remove 对称的事件回调（如 `Sidebar.#onResizeDown/Move/Up`、`Detail.#noteKeyHandler`）；类内自引用一律 `this.xxx()`，不用模块级单例变量。

### 消息与通信

- **取消信号必须发到抖音 document** — `DY_CANCEL_ACTIVE_TASK` 经 background→content→inject 路径送达，不能直接在 options 页 dispatch（路径差异见 [docs/01](./docs/01-project-architecture.md) / [docs/09](./docs/09-inject-tab-mode.md)）。
- **同步 requestId 时序差异** — `SYNC_WORKS` 立即返回 requestId；`FETCH_FOLLOWING` 等 fetch 完成才返回，关注进度过滤必须兼容 `Sync.#followingsRequestId === null`（见 [docs/03](./docs/03-independent-sync-followings.md)）。

### 网络与签名

- **取消点赞/收藏用 XHR 而非 fetch（Tab 模式）** — a_bogus 签名与 XHR 原型链深度绑定，fetch 发不出有效签名；独立模式仅取消收藏由 background 直接 `fetch()` POST（无页面上下文，取消点赞无独立分支、路由层拒绝 `UNSUPPORTED_INDEPENDENT`），Referer / Sec-Fetch-* 靠 DNR 规则网络层注入（见 [docs/06](./docs/06-independent-cancel-collection.md) / [docs/08](./docs/08-dnr-rules.md) / [docs/09](./docs/09-inject-tab-mode.md)）。
- **独立模式全端点需 Argus webSign 签名** — listcollection 被服务端额外校验，缺签名 403 `Signature Not Found`；webSign 已在 `IndependentClient.request` 默认开启（`options.webSign !== false`），aweme/post 亦被风控间歇强制同款校验（算法、线格式与盐轮换处置见 [docs/05](./docs/05-independent-scan-collection.md)）。
- **API 请求统一用 `window.fetch` + `_dyInternal` 标志** — inject 六个 API 请求函数经 Fetch Hook 但不被捕获；走 `origFetch.call(window, ...)` 绕过 Hook 会错过页面包装器注入的签名参数（见 [docs/09](./docs/09-inject-tab-mode.md)）。

### 数据语义

- **inject `extractVideo` 与 background `formatWork` 取链语义必须保持一致** — 三级优先定案（长效 playApi 作为整体类目优先于 CDN、只在同类内部比分辨率；禁止改回混池挑最高分辨率；fiber 分支有意不同勿混改）见 [docs/02](./docs/02-independent-sync-works.md) / [docs/09](./docs/09-inject-tab-mode.md)。
- **「已关注/未关注」归属判定走方案A：作品 `uid` 实时关联关注全集** — 全集用 `state.followedUids`（`services.loadFollowedUids()` 全量 `groupId:'all'` 加载，不受关注分组影响，init/域切换/`followings` 事件三处刷新）；记录无 `uid` 或全集未加载成功（`state.followedUidsLoaded`）时**不归判**，避免把已关注作者作品误算为未关注引入误删。禁止改用扫描快照 `authorFollowed` 做该判定的主判据。

### UI 交互与 CSS

- **批量勾选必须用 `Batch.updateCheckboxDOM`** — 手动设置 `checkbox.innerHTML` 只能显示图标，必须同时添加/移除 `checked` 类（默认 `color: transparent`）；`handleBatchSelectAll` 按域选择 checkbox（作品域 `.work-checkbox`，关注域 `.following-checkbox`）。
- **短操作弹窗锁定** — `state.preventDialogClose = true` + `try/finally` 解锁；`CANCEL_ACTIVE_TASK` 仅当 `state.activeDialog` 存在时发送（长操作 X 恒可点）。
- **详情层双形态进度条（docs/11 定案）** — `#detailProgress` 一个容器两种形态（`note-mode` 类切换）：视频=连续轨道（`#renderVideoProgress` 真实媒体事件驱动），图集=`#noteSegs` 分段进度（有音乐=音频 timeupdate 驱动、无音乐=虚拟时钟兜底，收尾走 `nextOnEnd()`）；seek 统一 `#applySeek`，键盘 role=slider ±5%/Home/End。`.media-view` 39.3vw cover 裁切与模糊背景 `brightness(0.8)` 为既定视觉，勿改回 contain/0.4。
- **安全面板值截断依赖 CSS，展开/收起 selector 兼容两种状态** — JS 不截断文本，靠 `.sec-truncate` 视觉截断；selector 用 `row.querySelector('.sec-truncate, .sec-expanded')`（见 [docs/09](./docs/09-inject-tab-mode.md)）。
- **自带 display 值的组件类与 `.hidden` 同用必须成对声明 `.X.hidden { display: none }`** — 同特异性下通用 `.hidden` 被文件后部组件规则覆盖，hidden 静默失效、占位层常显。
- **搜索栏收起即重置，筛选不跨收起保留** — `closeSearchBar()` 必须先调 `clearSearchFilters()` 恢复默认初始状态（关键词/排序/归属勾选/类型/逆序全部复位）；无「收起但筛选仍生效」的摘要条。域切换**不**重置（搜索栏展开期间改动按现态保留）。

### 渲染与虚拟化

- **侧边栏虚拟化（视口门控 + 分帧队列 + 升降级式）** — 条目创建只挂 meta 不发探针，进视口由 `#promoteItem` 经 `#enqueueCover` 每帧限量 rAF 发出，整页 DOM 用单个 fragment 追加；禁止改回创建即全量急切加载。不用 `content-visibility:auto`（每帧 Layerize 抖动）：observer root 必须显式传 `dom.sidebarBody`（null root 被祖先裁剪抵消致预填失效）；`#promoteItem`/`#demoteItem` 原地升降级、根节点不换。
- **VirtualGrid 虚拟化（分圈观察 + 双向 + 原地切换）** — 填充/卸载双 observer 分圈观察（新骨架进 `#pendingSkeletons` 队列逐批交给 IO，圈尾哨兵触发续批，哨兵被删须立刻续接）；时间预算制分帧填充，勿改回固定张数/帧；卸载圈远大于填充圈形成滞回勿调近；`populateItem` 负责 observe 完整卡的交接，`updateCardDOM` 已兼容骨架态；填充/降级必须在骨架根节点上原地切换、禁止换根节点（grid 容器任一直接子节点被替换都触发 Blink 全量重排，成本随卡片总数线性；骨架模板必须与完整卡根层同构）；`render()`/`abortRender()` 重置须同清队列状态。
- **分组切换不清场，域切换同步清场** — 分组切换在 `currentGroupId` 事件不 wipe、不铺骨架占位：旧分组卡片保留到新数据到达，数据到达后由域 store 事件触发 `render()` 整批重建（加载期间无网格 loading 指示）；域切换仍在 `switchDomain` 同步清场（abortRender×4 + 容器 wipe，只清不铺）。禁止改回「切换瞬间 wipe + 按视口铺骨架占位」。
- **悬停预览的媒体事件用 `pointerover/out` 委托，禁用 `pointerenter/leave`** — enter/leave 不冒泡，容器级委托收不到卡片进入事件（静默失效）；跨界只触发一次靠 `relatedTarget && media.contains(relatedTarget)` 判断。

### 媒体体系

- **媒体加载有全局熔断** — 视频/封面失败密集超阈值进入冷却期，期间跳过重试直接降级；新增媒体重试逻辑必须接入 `Detail.markMediaFail / markMediaOk / mediaRetryBlocked`，不要自行计数。
- **卡片预览静音是全局联动，详情播放器独立** — 作品/点赞/收藏域卡片静音切换走 `WorksGrid.#togglePreviewMute()`（共享 `#previewMuted` 标志，遍历容器内全部已渲染 `.work-video-player` 同步 `video.muted` 与按钮图标）；卡片填充与悬停起播都读该标志保证新卡继承。禁止改回单卡独立静音；`Detail.toggleVideoMute` 只服务详情覆盖层（`dom.detailVideo`/note 音频），勿与卡片联动。
- **离开扩展页面即暂停全部播放** — `visibilitychange`(hidden) 触发：卡片悬浮/按钮预览走 `WorksGrid.stopAllMedia`，详情播放走 `Detail.pauseOnHidden`（视频 pause 复位播放按钮并清挂起 `_retryTimer`，图集 `#noteStopAutoPlay`+`#noteUpdatePlayBtn`）。仅页面真正隐藏时暂停（切标签/最小化），窗口失焦不暂停。禁止改回切走后台静默续播。
- **网格媒体一律 `div`+`background-image`，禁止改回 `<img src>`** — 四个槽位全是 `<div role="img">`（唯一例外详情大图 `<img>`+探针）；离屏探针先行、成功才提交背景图；在途探针回调必须先校验代际再提交。

## config 分组速查

`options/core.js` 顶层 `config` 常量（43 个键，下表）。`background/core.js` 另有 `CONFIG`（`TIMEOUT`/`DELAY`/`SYNC`/`STORAGE_KEYS`/`DNR_RULES`/`GROUPS`/`PAGE`/`CANCEL`/`FATAL_ERRORS`/`WEBID_API`/`WEB_SIGN_SALT` 等）与 `runtimeConfig` 对象（`KEY`/`DEFAULTS`/`load`/`apply`/`reload`/`delayRange`，从 `chrome.storage.local` 读取叠加进 `CONFIG`）——说明见「background/ 类单例」表，运行时状态已塌缩为类私有字段：

| 分组       | 键                                                                                                                            |
|------------|-------------------------------------------------------------------------------------------------------------------------------|
| 视频重试   | `VIDEO_RETRY_DELAYS` `[200,400,600]` / `VIDEO_RETRY_MAX` `3` / `VIDEO_RETRY_FALLBACK_DELAY` `1000`                            |
| 媒体熔断   | `MEDIA_FAIL_WINDOW` `5000` / `MEDIA_FAIL_MAX` `10` / `MEDIA_BREAK_COOLDOWN` `15000`                                           |
| 超时       | `FETCH_RETRY_DELAY` `1000` / `SYNC_TIMEOUT` `30000` / `VIDEO_FALLBACK_TIMEOUT` `5000`                                         |
| 详情页     | `DETAIL_TITLE_MAX_LEN` `40` / `TOAST_DURATION` `2000` / `TOAST_ERROR_DURATION` `4500` / `DOWNLOAD_MAX_RETRY` `1`                                              |
| UI 延迟    | `HOVER_PREVIEW_DELAY` `200` / `BLOB_REVOKE_DELAY` `10000` / `NOTE_AUTO_PLAY_INTERVAL` `3000` / `SEARCH_DEBOUNCE` `200`                                  |
| 侧边栏     | `SIDEBAR_SNAP_POINTS` `[650,0]` / `SIDEBAR_SCROLL_THRESHOLD` `100` / `SIDEBAR_FILL_THRESHOLD` `50` / `SIDEBAR_IMG_PER_FRAME` `6` / `SIDEBAR_DRAG_THRESHOLD` `4` |
| 网格项尺寸 | `CARD_SIZE_FALLBACK` `261` / `CARD_GAP` `11` / `CARD_HEIGHT_OFFSET` `44`                                                       |
| 分块渲染   | `RENDER_CHUNK_SIZE` `50` / `OBSERVER_ROOT_MARGIN` `'200px'` / `OBSERVE_CHUNK_SIZE` `48` / `FILL_FRAME_BUDGET_MS` `8` / `UNLOAD_ROOT_MARGIN` `'1200px'`    |
| 分组/存储  | `GROUP_NAME_MAX_LEN` `20` / `STORAGE_MAX_BYTES` `10MB` / `TRASH_GROUP_NAME` `'稍后删除'`                                      |
| Tab 滚动   | `TAB_SCROLL_THRESHOLD` `2`                                                                                                    |
| 抖音 URL   | `URL_BASE` / `URL_USER_SELF` / `URL_LIKE_TAB` / `URL_COLLECTION_TAB` / `URL_FOLLOWING_TAB`                                    |
| 域元数据   | `WORK_LIKE_DOMAINS` `['works','likes','favorites']` / `DOMAINS_META`（四域 label/itemKey/idKey/isFollowings）                       |
| 正则/图标  | `SEC_UID_REGEX` `/^\/user\/([^/?]+)/` / `icons` `{}`（init 填充）                                                             |

## 文档索引

技术文档已按单一职责拆分为编号分册（术语规范见 01：**Tab模式**=页面注入脚本方式；**独立模式**=纯后台逆向请求流程）：

| 文档 | 阅读场景 |
|------ | ---------- |
| [docs/01-project-architecture.md](./docs/01-project-architecture.md) | 项目架构：双模运行与路由隔离、代码布局约束、四域存储模型、通信协议、全局配置 |
| [docs/02-independent-sync-works.md](./docs/02-independent-sync-works.md) | 独立模式同步作品（SYNC_WORKS / formatWork 三级取链） |
| [docs/03-independent-sync-followings.md](./docs/03-independent-sync-followings.md) | 独立模式同步关注（FETCH_FOLLOWING 分页采集） |
| [docs/04-independent-calibrate-followings.md](./docs/04-independent-calibrate-followings.md) | 关注计数校准（批量 calibrateFollowingStats + 侧边栏单用户 CALIBRATE_FOLLOWING）+ 最近更新日期 lastUpdateAt（作品第一页 max create_time 采集） |
| [docs/05-independent-scan-collection.md](./docs/05-independent-scan-collection.md) | 独立模式扫描收藏（listcollection 线格式 + Argus webSign 定案、绑定域实验、盐轮换处置） |
| [docs/06-independent-cancel-collection.md](./docs/06-independent-cancel-collection.md) | 独立模式取消收藏（background 直连 POST 循环） |
| [docs/07-independent-fetch-user-works.md](./docs/07-independent-fetch-user-works.md) | 作者主页作品分页（FETCH_WORKS_PAGE 双模分支） |
| [docs/08-dnr-rules.md](./docs/08-dnr-rules.md) | 全部 DNR 动态规则（7 条）、优先级关系与排障 |
| [docs/09-inject-tab-mode.md](./docs/09-inject-tab-mode.md) | Tab模式注入侧技术方案：签名捕获/三种签名策略/_dyInternal、事件桥、按钮注入、取消信号 |
| [docs/10-storage-write-and-import.md](./docs/10-storage-write-and-import.md) | 存储写入与导入合并：mergeWork/计数保护/丢失检测/reconcileImportGroups 三级对账 |
| [docs/11-options-ui.md](./docs/11-options-ui.md) | 管理页渲染与交互：VirtualGrid/Sidebar 虚拟化与分圈观察、媒体探针体系与全局熔断、勾选 DOM 约定、弹窗锁定与取消门控、CSS 协同约定 |
| [docs/TIKTOK_REFERENCE.md](./docs/TIKTOK_REFERENCE.md)   | 参考项目 TikTokDownloader 算法/凭据模块 + Douyin API 端点总表                  |
