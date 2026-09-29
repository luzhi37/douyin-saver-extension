> 本文件是面向 **AI Agent**（Claude Code 等）的技术参考，内容侧重于实现细节与设计约束。
> 人类用户请先阅读 [README.md](./README.md) 了解功能与安装。

# AGENTS.md — 抖音数据管理 (Douyin Data Manager)

任何具体行为以源码为准。深度技术细节已拆分到 `docs/*.md`，见下方[文档索引](#文档索引)。

## 代码布局规范

**所有 JS 文件必须遵守从上到下、先声明后使用的顺序**。通用层级：

```
config/const 定义          ┐ 常量在最顶部；执行语句不得出现在声明之前
模块级变量声明             ┘ let/const 集中
函数定义（分组）           以 `// ---------- 标签 ----------` 分隔
类定义 + 立即实例化         类定义后紧跟 const instance = new Class()，禁止先集中列出所有 class 再集中实例化
事件绑定 / 消息监听         函数定义之后，执行之前
启动逻辑                    IIFE / DOMContentLoaded 在最底部
```

- **`background/` 按职责分子目录、每类独立成文件（文件名 = kebab-case 类名）** — 子目录划分与 `main.js` 组合根见「background/ 类单例」表；类间循环 import 靠 live binding 在调用时安全消解

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

- `works` — `{ [awemeId]: Work }`（每条含 `video` 直链与 `videoExpireAt`；三级取链与防短效覆盖长效细则见 docs/02）
- `likes` / `favorites` — 与 `works` 同构的 Work 记录（itemKey 各自独立）；无独立保存消息，落库经 `persistScan` 的 `mergeAndSave`（persist="likes"/"favorites"）与跨域 `SAVE_WORKS`
- `followings` — `{ [uid]: Following }`（7 个稳定字段：uid/nickname/avatarLarger/followerCount/awemeCount/profileUrl/lastUpdateAt；计数与 lastUpdateAt 仅由校准写入、未校准占位 0 且 `SAVE_FOLLOWINGS` 对 0 值保留旧计数——见 docs/01/04/10）
- `*_groups`（四域同构）— `[{ id, name, fixed, order? }]`

## 消息协议

`App.route()`（`background/main.js`）switch 分发所有 `chrome.runtime.sendMessage`。

| 类别                       | 消息类型                                                                                                                                                                                                                                                                                         |
|----------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 数据操作                   | `SAVE_WORKS` / `GET_WORKS` / `DELETE_WORKS` / `MOVE_WORKS` / `SYNC_WORKS` / `GET_WORK` / `GET_WORKS_BY_IDS`（bulk 广播收口的补拉通道）/ `SAVE_FOLLOWINGS` / `GET_FOLLOWINGS` / `DELETE_FOLLOWINGS` / `MOVE_FOLLOWINGS` / `GET_LIKES` / `DELETE_LIKES` / `MOVE_LIKES` / `GET_FAVORITES` / `DELETE_FAVORITES` / `MOVE_FAVORITES`（likes/favorites 无独立保存消息，落库经 `SAVE_WORKS`/`persistScan`）；作品型三域 `GET_*` 支持分页（`page:0` / `cursor` keyset / 缺省全量，机制见 docs/01） |
| 分组管理                   | `GET_GROUPS` / `ADD_GROUP` / `RENAME_GROUP` / `DELETE_GROUP` / `REORDER_GROUPS`                                                                                                                                                                                                                  |
| 工具                       | `IMPORT_DATA` / `EXPORT_DATA` / `RESET_DOMAIN` / `GET_STATS` / `GET_SECURITY_STATUS` / `CALIBRATE_FOLLOWING`（单用户校准，见 docs/04） / `SET_MODE` / `CAPTURE_BROWSER_FEATURES` / `GET_COOKIE_INFO` / `GET_BROWSER_FEATURES` / `GET_CACHE_TIMES` / `RESOLVE_SEC_UID` / `REFRESH_MSTOKEN` / `REFRESH_WEBID` / `REFRESH_BROWSER_FEATURES` / `REFRESH_COOKIE` / `RELOAD_CONFIG` |
| 扫描入口                   | `FETCH_FOLLOWING` / `FETCH_FAVORITES` / `FETCH_COLLECTION` — options 触发 background 循环扫描、逐页透传进度；`FETCH_FOLLOWING` 收集完成后自动校准（门控与细节见 docs/04）                              |
| 入库                       | `IMPORT_USER_WORKS` / `IMPORT_FOLLOWING` — 作者作品分页入作品域 + 作者档案入关注域，均双模支持（分组/去重语义见 docs/07）；过程消息 `IMPORT_WORKS_PROGRESS`。入口为菜单「入库」弹窗（`AuthorImport`） |
| 存储广播                   | `STORE_CHANGED { domain, upserts?, addedIds?, changedIds? }` — 落库成功后 background 广播（发送方可能是抖音标签页等外部上下文），**仅在 `changed>0` 时发**（no-op 不广播）。两种载荷：**point**（works 域单发保存，`changed ≤ BROADCAST.UPSERTS_MAX`=8 时附带合并后记录 `upserts` 与新增 id 集 `addedIds`）；**bulk**（入库循环收尾等批量变化，附带轻量 id 集 `changedIds`/`addedIds`——禁止改回全量记录载荷防消息膨胀；关注域无载荷）。载荷语义见 [docs/10](./docs/10-storage-write-and-import.md)；options 侧去抖/flush/头插收口管线与红线见 [docs/11](./docs/11-options-ui.md)「STORE_CHANGED 增量收口」 |
| 取消入口                   | `CANCEL_LIKE` / `CANCEL_COLLECTION` — options 触发 background 批量取消：tab 模式逐条派发 `CANCEL_ONE_*` 到 inject；独立模式仅 `CANCEL_COLLECTION` 在 background 循环 POST（细节见 docs/06）                                                                                                     |
| 取消信号                   | `CANCEL_ACTIVE_TASK` — tab 模式下经 options→background→content→inject 触发 `activeTask.abort()`；独立模式下直接在 background 取消循环；仅在长操作弹窗关闭时发送（无 `state.activeDialog` 时不发送）                                                                                              |
| Tab 转发（background→tab） | `FETCH_SINGLE_WORK` / `FETCH_FOLLOWING_PAGE` / `FETCH_USER_PROFILE` / `FETCH_FAVORITES_PAGE` / `FETCH_COLLECTION_PAGE` / `CANCEL_ONE_LIKE` / `CANCEL_ONE_COLLECTION` / `FETCH_WORKS_PAGE` / `GET_SECURITY_STATUS`（tab 模式经 content→inject；独立模式由 background 直接 POST，见 docs/07） |
| 进度消息                   | `SYNC_PROGRESS` / `FOLLOWING_PROGRESS` / `FAVORITES_PROGRESS` / `COLLECTION_PROGRESS` / `IMPORT_WORKS_PROGRESS` / `CANCEL_PROGRESS` / `CANCEL_DONE` — 由 background 循环 handler 直接发出到 options，不再经 content.js 转发（`FOLLOWING_PROGRESS` 带 `phase:"calibrate"` 表示关注校准阶段）                                                                                                |

> 长任务链路原语（`tabBridge.send`/`sendAsync`/`requestResponse`）与同步/扫描/取消的完整链路、时序差异、分页参数见 [docs/01](./docs/01-project-architecture.md) 与 docs/02–09 各分册（索引见文末「文档索引」）。

## 响应式状态管理

`store.on()` 监听事件：

| 事件               | 处理                                                                                                     |
|--------------------|----------------------------------------------------------------------------------------------------------|
| `'domain'`         | 更新同步按钮、渲染分组 tab、加载域数据 |
| `'works'`          | `worksGrid.renderCards()`（仅 domain=works）                                                             |
| `'work-like-appended'` | 渐进分页回填（作品型三域，loadDomainData 逐页发）：默认视图 `fillSlots` 回填 + `syncCount`，`done` 时 `pruneEmptyTail` 摘尾；筛选激活时静默累积、加载完成整渲；domain/groupId 双校验防旧页混入（细节见 docs/11） |
| `'followings'`     | `followingsGrid.renderFollowingCards()`（仅 domain=followings）                                          |
| `'groups'`         | `groups.renderGroupTabs()`                                                                               |
| `'currentGroupId'` | `groups.renderGroupTabs()` + 加载域数据                                                                  |
| `'batchMode'`      | toggle body `.batch-mode` class + `Batch.syncSelectionUI`（批量栏显隐由 CSS `body.batch-mode` 驱动，无独立 #batchBar）        |
| `'work-updated'`   | `worksGrid.updateCardDOM(awemeId)` + 若详情打开则重渲染                                                  |

## Class 职责概览

| Class            | 职责                                                              |
|------------------|-------------------------------------------------------------------|
| `SearchBar`      | 搜索/筛选子系统（数据层视图 getWorksView/getFollowingsView + 检索状态 `#searchState`；归属判定与收起即重置见 docs/11「SearchBar」） |
| `VirtualGrid`    | 网格渲染基类（双向虚拟化：填充/卸载双 observer + 时间预算填充 + 事件委托 + `insertItems`/`removeItems` 位插对偶；机制与红线见 docs/11） |
| `Dialog`         | 多层弹窗管理（基层 #dialogOverlay + pushDialog 动态实例叠层，关闭顶层自动回父层；`dom.dialogTitle/dialogBody/dialogFooter/dialogClose` 由其动态指向顶层实例元素，仅该类可写） |
| `FollowingsGrid` | 关注卡片网格                                                      |
| `Groups`         | 分组 tab + 管理                                                   |
| `Batch`          | 批量操作（勾选、全选、删除、移动、下载；批量下载仅作品/点赞/收藏域）+ 未关注作品批量入库（添加按钮，跨域经 `SAVE_WORKS` 写入作品域） |
| `ImportExport`   | 数据维护弹窗（四域导出/导入/重置聚合单弹窗，按钮由 `DOMAINS_META` 生成、显式指定目标域不随当前域自适应；导入经隐藏 fileInput 按 `#pendingImportDomain` 分流；确认/进度弹窗经 pushDialog 叠加） |
| `Sidebar`        | 侧边栏（作者作品分页 + 条目升降级虚拟化）                                            |
| `Sync`           | 同步状态机（作品/关注）                                           |
| `DomainScanSync` | 点赞/收藏域扫描同步（进度弹窗 + 丢失检测 UI；与 Sync 同构的姊妹状态机，落库由 background `persistScan` 直写，本类只驱动进度与刷新） |
| `AuthorImport`   | 入库（菜单「入库」弹窗：作品域=分页循环长任务+进度弹窗复用 syncDialogBodyTemplate，关注域=单请求收录作者档案；输入仅支持作者主页链接，sec_uid 从链接直提、`/user/self` 经 RESOLVE_SEC_UID 兑换；与 Sync/DomainScanSync 三链路互斥） |
| `Settings`       | 设置面板（安全状态/ Cookie/浏览器特征/运行参数面板；开关仅切视觉态，校验与持久化统一走 `saveBeforeClose`；私有成员全部 `#` 前缀） |
| `WorksGrid`      | 作品卡片网格                                                      |
| `Detail`         | 详情播放器（对齐抖音播放界面：全宽播放器、.media-view 宽度随媒体宽高比自适应、双形态进度条、⌃⌄ 作品切换胶囊；定案见 docs/11） |
| `AppShell`       | 应用壳（域切换滑块 switchDomain/updateDomainSlider、全局错误态 renderErrorState、弹窗关闭统一入口 requestDialogClose；事件构造器内自绑定） |

### background/ 类单例（按职责分模块，与 options 侧类模块同构）

| 类 / 对象              | 文件                         | 职责                                                                                                                                                  |
|------------------------|------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------|
| `runtimeConfig` (对象) | `core.js`                    | 运行时配置：从 `chrome.storage.local` 读入叠加进 `CONFIG`（`KEY`/`DEFAULTS`/`load`/`apply`/`reload`/`delayRange`）；校准开关写入 `IndependentClient`；SW 冷启动补 reload 恢复运行参数 |
| `utils` (对象)         | `core.js`                    | 纯函数集：`parseExpire` / `urlExpireAt` / `isLongLivedVideoUrl` / `extractMsTokenFromCookie` / `asyncHandler` / `sendSyncDone`                         |
| `formatters` (对象)    | `core.js`                    | `formatWork` / `formatFollowing` / `formatFollowingFromProfile`                                                                                       |
| `Crypto` (静态)        | `identity/crypto.js`        | 哈希/解析工具静态类：`md5Hex`（Argus webSign）/ `parseCookieToPairs` / `generateRandomMsToken`                                                        |
| `ABogus`               | `identity/crypto.js`        | a_bogus 签名算法类（按 UA/浏览器特性实例化，`Credentials.ensureABogus` 使用）；同文件导出 `MSSDK_STR_DATA`（mssdk 兑换载荷）                          |
| `Credentials`          | `identity/credentials.js`    | 客户端凭据/签名：`ensureABogus`/`getClockSkew`/`buildBaseParams`/`getMsToken`/`refreshWebIdChain`；吸收凭据类消息（见「消息协议」工具行） |
| `IndependentClient`    | `identity/independent-client.js` | 独立模式开关/校准开关 + 签名直连 `request` + `resolveSelfSecUid`（内含 `resolveSecUidById` 兑换）；`request` 经 `credentials` 跨类取签名/时钟/msToken |
| `Storage`              | `data/storage.js`           | IndexedDB 封装层（单例连接 `#db`，DB v3：作品型三域 `savedAt_id`/`groupId_savedAt_id` 复合索引 + 升级回填缺失 savedAt/groupId）；`readIndexPage` keyset 翻页（prev 取 limit+1 探测），API 全集见文件 |
| `DomainStore`          | `data/domain-store.js`       | 域存储封装：`storeName`/`groupsName`/`toStorageId`/`facade`；`mergeWork`；`mergeAndSave`（三作品型域通用）/ `mergeAndSaveFollowings`（计数保护）——两者均做**真实变更检测**：内容全等的重复入库不写库、不计入 `changed`（写入路径语义见 docs/10） |
| `DomainHandlers`       | `data/domain-handlers.js`    | 域数据操作入口（4 实例 works/followings/likes/favorites）；`save` 仅 `changed>0` 广播 `STORE_CHANGED`（`changed ≤ BROADCAST.UPSERTS_MAX` 附 point 载荷，`#saveFollowings` 恒 bulk——followings 无单卡更新原语）、响应剔除 `written`/`addedIds` 防大批量保存响应膨胀；`get`（keyset 游标翻页，无参一次性全量）/`delete`/`move`/`getOne`/`getByIds`（bulk 收口补拉通道）；写入语义见 docs/10 |
| `TabBridge`            | `identity/tab-bridge.js`     | 抖音标签页查找/转发（`find`/`send`/`sendAsync`）；吸收 `CANCEL_ACTIVE_TASK`/`GET_SECURITY_STATUS`/`FETCH_WORKS_PAGE` 非独立分支                    |
| `Groups`               | `data/groups.js`             | 分组 tab + 管理（域感知）                                                                                                                            |
| `DataTools`            | `data/data-tools.js`         | 导入导出/重置/统计（域感知）；`reconcileImportGroups`                                                                                                 |
| `ScanTasks`            | `tasks/scan-tasks.js`        | Tab 模式长任务：同步/扫描/取消/校准循环（含 `persistScan` 落库）；`importUserWorks`（注入 Tab 取页器）/`importFollowing`（含 `#fetchProfileUser` 双模档案取数） |
| `IndependentTasks`     | `tasks/independent-tasks.js` | 独立模式长任务：`fetchFollowing`/`fetchCollection`/`syncWorks`/`fetchWorksPage`/`importUserWorks`（注入直连取页器）/`cancel`                                            |
| `runAuthorWorksImport`（函数） | `tasks/author-works-import.js` | 作者作品入库双模共用循环壳：BAD_PARAMS 守卫、重叠页去重防死循环、逐页 `mergeAndSave` 落库、全部批次结束后统一广播一次 `STORE_CHANGED`（轻量 id 集，**禁止移回循环内逐页发**）、`IMPORT_WORKS_PROGRESS`、取消守卫；双模任务类各注入 `fetchPage(cursor)` 页取数器（细节见 docs/07） |
| `App`                  | `main.js`                    | 初始化（注册 `onInstalled`/`onStartup`/`onClicked` + `setupDeclarativeNetRequest`）+ 消息路由 `route`（`SET_MODE` 调 `independentClient.setMode`）  |

## 设计约定与知识点陷阱

> 本节只保留规则红线；机制原理、历史踩坑与实测数据见各条目指向的分册。未单独标注依据的条目，均为 [docs/11](./docs/11-options-ui.md)。

### 编码约定

- **所有共享全局变量定义在 `options/core.js` 顶部** — `config` / `dom` / `state` / `store` / `utils` / `runtimeConfig` / `services` 在此定义并 export，其余模块经 ES import 引用；类内自引用一律 `this.xxx()`，不用模块级单例变量。
- **私有方法用 `#` 语法**；class field 箭头仅用于 add/remove 对称的事件回调（如 `Sidebar.#onResizeDown/Move/Up`、`Detail.#noteKeyHandler`）。

### 消息与通信

- **取消信号必须发到抖音 document** — `DY_CANCEL_ACTIVE_TASK` 经 background→content→inject 路径送达，不能直接在 options 页 dispatch（路径差异见 [docs/01](./docs/01-project-architecture.md) / [docs/09](./docs/09-inject-tab-mode.md)）。
- **同步 requestId 时序差异** — `SYNC_WORKS` 立即返回 requestId；`FETCH_FOLLOWING` 等 fetch 完成才返回，关注进度过滤必须兼容 `Sync.#followingsRequestId === null`（见 [docs/03](./docs/03-independent-sync-followings.md)）。

### 网络与签名

- **取消点赞/收藏用 XHR 而非 fetch（Tab 模式）** — a_bogus 签名与 XHR 原型链深度绑定，fetch 发不出有效签名；独立模式仅取消收藏由 background 直接 `fetch()` POST（取消点赞路由层拒绝 `UNSUPPORTED_INDEPENDENT`），Referer / Sec-Fetch-* 靠 DNR 规则网络层注入（见 docs/06/08/09）。
- **独立模式全端点需 Argus webSign 签名** — listcollection 缺签名 403 `Signature Not Found`；`IndependentClient.request` 默认开启（`options.webSign !== false`），aweme/post 亦被风控间歇强制同款校验（算法与盐轮换处置见 docs/05）。
- **API 请求统一用 `window.fetch` + `_dyInternal` 标志** — inject 六个 API 请求函数经 Fetch Hook 但不被捕获；走 `origFetch.call(window, ...)` 绕过 Hook 会错过页面包装器注入的签名参数（见 docs/09）。

### 数据语义

- **inject `extractVideo` 与 background `formatWork` 取链语义必须保持一致** — 三级优先定案见 docs/02/09（长效 playApi 作为整体类目优先于 CDN、只在同类内部比分辨率；禁止改回混池挑最高分辨率；fiber 分支有意不同勿混改）。
- **「已关注/未关注」归属判定走方案A：作品 `uid` 实时关联关注全集** — 全集 `state.followedUids`（init/域切换/`followings` 事件三处刷新）；记录无 `uid` 或全集未加载成功时**不归判**，避免把已关注作者作品误算为未关注引入误删；**禁止改用扫描快照 `authorFollowed` 做该判定的主判据**（细节见 docs/11「SearchBar」）。

### UI 交互与 CSS

- **批量勾选必须用 `Batch.updateCheckboxDOM`** — 只设 `innerHTML` 不加/移除 `checked` 类则图标透明不可见；`handleBatchSelectAll` 按域选择 checkbox（作品域 `.work-checkbox`，关注域 `.following-checkbox`）。勾选框**显隐由 `body.batch-mode` 纯 CSS 驱动**，JS 禁止逐元素写 inline display；勾选框随填充创建、降级（clearCard）即移除，退出批量只清 `.checked` 的。**批量禁选文本走 `#mainGrid` mousedown preventDefault，禁止用 CSS user-select**（全网格级联重算是进入批量模式卡顿主因，见 docs/11）。
- **短操作弹窗锁定** — `state.preventDialogClose = true` + `try/finally` 解锁；`CANCEL_ACTIVE_TASK` 仅当 `state.activeDialog` 存在时发送。
- **`state.activeDialog` 在弹窗挂载时由 `Dialog.#mountLayer` 写入（恒等于顶层 onClose）** — 只在 `closeDialog` 出栈时补写会使「本次打开后的首次关闭」静默失效（机制与回归教训见 docs/11）。无 onClose 的弹窗该值为 null，走兜底关闭。
- **详情层双形态进度条**（视频连续轨道/图集分段音乐驱动，seek 统一 `#applySeek`）、`.media-view` 宽度随媒体宽高比自适应（`--media-aspect` 由 `Detail.#setMediaAspect` 写入，切作品复位 9:16）与模糊背景 `brightness(0.8)` 为既定视觉，定案细节见 docs/11（2026-09-29 修订：废弃横版 39.3vw 封顶）。
- **安全面板值截断依赖 CSS，展开/收起 selector 兼容两种状态** — `row.querySelector('.sec-truncate, .sec-expanded')`（见 docs/09）。
- **自带 display 值的组件类与 `.hidden` 同用必须成对声明 `.X.hidden { display: none }`** — 同特异性下通用 `.hidden` 被后部组件规则覆盖，hidden 静默失效。
- **搜索栏收起即重置，筛选不跨收起保留** — `closeSearchBar()` 必须先调 `clearSearchFilters()`；域切换**不**重置；筛选状态**不落 URL hash**（P1-8 的刷新恢复已移除：hash 残留会让搜索栏在从没打开过它的会话里被「自动展开」，main.js init 仅保留一次性残留清理，全仓无 hash 读写方）（见 docs/11「SearchBar」）。

### 渲染与虚拟化

> 管线全景、机制细节与历史踩坑见 [docs/11](./docs/11-options-ui.md)；本节只保留规则红线。

- **快滚门控** — 快滚判定在 scroll 事件时刻做（scrollTop 帧间差超 `FAST_SCROLL_THRESHOLD`），rAF 侧（catchUp/drain 轮询两个读取者）不推进判定基准、drain 轮询经 epoch 计数检测停稳：快滚态挂起填充 drain、跳过 `#demote`；停稳后 `#refillBand` 丢弃沿路积压（**丢弃前必须全量重新 observe**）只补落点带区。容器级事件委托（click/pointerover/out/input）一律绑 `#mainGrid` 而非容器——清场换壳后零重绑。
- **网格卡片层禁用 `content-visibility: auto`** — `.work-card`/`.work-skeleton`/`.following-card` 一律不加（屏外跳过渲染会让远跳落点骨架延迟出现）；sidebar 的 CV 禁令是另一条理由，互不影响。
- **侧边栏虚拟化** — 条目只挂 meta、进视口限量发探针、整页 fragment 追加（禁止创建即全量急切加载）；observer root 必须显式传 `dom.sidebarBody`；`#promoteItem`/`#demoteItem` 原地升降级、根节点不换；不用 `content-visibility:auto`。
- **VirtualGrid 虚拟化（分圈观察 + 双向 + 原地切换）** — 分圈观察哨兵链推进填充（哨兵被删须立刻续接）；填充/卸载 IO 的 root 必须显式传 `#mainGrid`（同 sidebar 的 `dom.sidebarBody` 规则）；两段式铺设（首段同步 + 余量游离态拼装一次挂载，禁止逐帧向容器追加）；预铺有上限（`GRID_PREMOUNT_CAP`）+ 滚近底部倍增扩容（`#extendIfNeeded`）；`fillSlots` 落点按键前缀自锚定回填，占位卡在 fill IO 回调中**不得 unobserve**；`removeItems` 必须同步收缩 `#slots` 与 `#totalSlots`；`insertItems` 位插与 `removeItems` 对偶——state 与 `#slots` 必须同任务内对位 splice、头插卡须插队到待观察队列最前；8ms 时间预算填充，勿改回固定张数/帧；填充/降级原地切换、禁止换根节点；卸载圈滞回勿调近；`render()`/`abortRender()` 重置须同清队列与 `#slots`。
- **STORE_CHANGED 收口优先增量、整刷仅作兜底** — 新增落当前视图走 `tryHeadInsert` 头插，禁止改回「视图内新增→`loadDomainData` 整刷」；头插与在途分页的交错窗口守卫（`services.isGridLoading()`/`grid.isScrollFrozen()`/`state.gridSlots` 等）不过必须整刷兜底、不得绕过；落点比较器必须与 `savedAt_id`/`groupId_savedAt_id` 索引 prev 遍历同序；bulk 载荷只带 id 集、记录经 `GET_WORKS_BY_IDS` 补拉（管线全景与红线见 docs/11「STORE_CHANGED 增量收口」）。
- **分组与域切换同序列清场（点击即清空）** — 切换瞬间 `appShell.clearActiveGrid()`：abortRender×4 + 样式塌缩（height:0/overflow:hidden/visibility:hidden）+ 旧子树空闲期一次性销毁；「冻结-定格」与「不清场保无闪烁」均已定案否决/禁止。数据侧配套 `loadDomainData` 分页渐进（followings 单发全量）。
- **悬停预览的媒体事件用 `pointerover/out` 委托，禁用 `pointerenter/leave`** — enter/leave 不冒泡，容器级委托收不到卡片进入事件；跨界只触发一次靠 `relatedTarget && media.contains(relatedTarget)` 判断。

### 媒体体系

- **媒体加载有全局熔断** — 失败密集超阈值进入冷却期，期间跳过重试直接降级；新增媒体重试逻辑必须接入 `Detail.markMediaFail / markMediaOk / mediaRetryBlocked`。
- **卡片预览静音是全局联动，详情播放器独立** — 三域卡片静音走 `WorksGrid.#togglePreviewMute()`（共享 `#previewMuted`），填充与悬停起播读该标志保证继承；`Detail.toggleVideoMute` 勿与卡片联动。
- **离开扩展页面即暂停全部播放** — `visibilitychange`(hidden) 触发：卡片预览走 `WorksGrid.stopAllMedia`，详情走 `Detail.pauseOnHidden`；仅页面真正隐藏时暂停，窗口失焦不暂停。
- **全站媒体一律 `div`+`background-image`，禁止改回 `<img src>`** — 离屏探针先行、成功才提交背景图；在途探针回调必须先校验代际；切换路径旧背景保持到新背景提交（零空档）。

## config 分组速查

- **options/core.js 顶层 `config`（47 键）** — 权威键表与默认值见 [docs/01](./docs/01-project-architecture.md)「配置项说明 · options/core.js 顶层 `config`」。
- **background/core.js `CONFIG`**（`TIMEOUT`/`DELAY`/`SYNC`/`STORAGE_KEYS`/`DNR_RULES`/`GROUPS`/`PAGE`/`BROADCAST`/`CANCEL`/`FATAL_ERRORS`/`WEBID_API`/`WEB_SIGN_SALT` 等）与 `runtimeConfig` 对象（从 `chrome.storage.local` 读入叠加进 `CONFIG`，SW 冷启动补 reload；键表同见 docs/01「配置项说明」）——运行时状态已塌缩为类私有字段，类职责见「background/ 类单例」表。

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
