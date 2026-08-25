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
options.js (管理 UI)        — store 响应式, 弹窗/侧边栏/网格/导出导入
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
| 数据操作                   | `SAVE_WORKS` / `GET_WORKS` / `DELETE_WORKS` / `MOVE_WORKS` / `SYNC_WORKS` / `GET_WORK` / `SAVE_FOLLOWINGS` / `GET_FOLLOWINGS` / `DELETE_FOLLOWINGS` / `MOVE_FOLLOWINGS`                                                                                                                          |
| 分组管理                   | `GET_GROUPS` / `ADD_GROUP` / `RENAME_GROUP` / `DELETE_GROUP` / `REORDER_GROUPS`                                                                                                                                                                                                                  |
| 工具                       | `IMPORT_DATA` / `EXPORT_DATA` / `RESET_DOMAIN` / `GET_STATS` / `GET_SECURITY_STATUS` / `CALIBRATE_FOLLOWING`（单用户校准：打开侧边栏触发，background 按模式取 profile/other 后直接落库）                                                                                                                            |
| 扫描入口                   | `FETCH_FOLLOWING` / `FETCH_FAVORITES` / `FETCH_COLLECTION` — options.js 触发 background 的循环扫描；background 内逐页请求后透传进度。`FETCH_FOLLOWING` 列表收集完成后自动进入校准阶段（`calibrateFollowingStats` 逐用户请求 profile/other，覆盖 awemeCount/followerCount），受运行参数 `calibrateFollowings` 开关门控                              |
| 取消入口                   | `CANCEL_LIKE` / `CANCEL_COLLECTION` — options.js 触发 background 的批量取消；tab 模式下逐条派发 `CANCEL_ONE_*` 到 inject；独立模式下由 `handleIndependentCancel` 直接在 background 循环 POST                                                                                                     |
| 取消信号                   | `CANCEL_ACTIVE_TASK` — tab 模式下经 options→background→content→inject 触发 `activeTask.abort()`；独立模式下直接在 background 取消循环；仅在长操作弹窗关闭时发送（无 `state.activeDialog` 时不发送）                                                                                              |
| Tab 转发（background→tab） | `FETCH_SINGLE_WORK` / `FETCH_FOLLOWING_PAGE` / `FETCH_USER_PROFILE` / `FETCH_FAVORITES_PAGE` / `FETCH_COLLECTION_PAGE` / `CANCEL_ONE_LIKE` / `CANCEL_ONE_COLLECTION`（tab 模式下经 content→inject；独立模式下由 background 直接 POST） / `FETCH_WORKS_PAGE`（独立模式下由 background 直接处理） / `GET_SECURITY_STATUS` |
| 进度消息                   | `SYNC_PROGRESS` / `FOLLOWING_PROGRESS` / `FAVORITES_PROGRESS` / `COLLECTION_PROGRESS` / `CANCEL_PROGRESS` / `CANCEL_DONE` — 由 background 循环 handler 直接发出到 options，不再经 content.js 转发（`FOLLOWING_PROGRESS` 带 `phase:"calibrate"` 表示关注校准阶段）                                                                                                |

**长任务链路模式**：
- `sendToTab`：background 生成 `requestId`，向抖音标签页发消息，等待超时 `CONFIG.TIMEOUT.REQUEST`（默认 30s，`GET_SECURITY_STATUS` 5s）。`sendToTab` 内部 `.catch()` 处理 `withDouyinTab()` 极端异常路径。
- `sendToTabAsync`：`sendToTab` 的 Promise 封装，用于 background 循环 handler 中逐条/逐页请求（`SYNC_WORKS`、`FETCH_FOLLOWING`、`FETCH_FAVORITES`、`FETCH_COLLECTION` 的 background 循环均使用此模式；独立模式下 `CANCEL_LIKE`/`CANCEL_COLLECTION` 由 `handleIndependentCancel` 在 background 内直接循环，不走此路径）。
- `requestResponse`：content.js **先 `addEventListener(resultEvent)` 再 `dispatchEvent(requestEvent)`**，消除同步 handler 的 `setTimeout(0)` workaround 需求。

> 同步/扫描/取消的完整链路、时序差异、分页参数见 [docs/SYNC_AND_SCAN.md](./docs/SYNC_AND_SCAN.md)。

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
| `SearchBar`      | 搜索/筛选子系统（数据层视图 getWorksView/getFollowingsView/isFilterActive + 搜索栏 UI 同步与开关；元素事件在构造器内自绑定） |
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

## 设计约定与知识点陷阱

- **所有变量定义在 options.js 顶层** — `config` / `dom` / `state` / `store` / `utils` / `services` 在文件顶部定义，所有 class 直接引用这些全局变量。
- **私有方法使用 `#` 语法** — 类外部不可访问。
- **class field 箭头仅用于 add/remove 对称的事件回调** — 如 `Sidebar.#onResizeDown/Move/Up`、`Detail.#noteKeyHandler`。
- **自引用用 `this.xxx()` 而非单例名** — class 内部调用自身方法必须用 `this`，不要用模块级单例变量。
- **批量勾选必须用 `Batch.updateCheckboxDOM`** — 手动设置 `checkbox.innerHTML` 只能显示图标，必须同时添加/移除 `checked` 类（默认 `color: transparent`）。
- **`handleBatchSelectAll` 必须按域选择 checkbox** — 作品域 `.work-checkbox`，关注域 `.following-checkbox`。
- **取消信号必须发到抖音 document** — `DY_CANCEL_ACTIVE_TASK` 通过 background→content 路径送达 inject.js，不能直接在 options 页 dispatch。
- **同步 requestId 时序差异** — `SYNC_WORKS` 立即返回 requestId；`FETCH_FOLLOWING` 等 fetch 完成后才返回。关注进度过滤必须兼容 `#followingsRequestId === null`。
- **同步 handler 已无需延迟派发结果** — `requestResponse` 先 `addEventListener` 再 `dispatchEvent`，同步 handler 不再需要 `setTimeout(0)` workaround。
- **签名展开/收起 selector 必须兼容两种状态** — 用 `row.querySelector('.sec-truncate, .sec-expanded')`。
- **安全面板值截断依赖 CSS** — JS 不截断文本，靠 `.sec-truncate` 做视觉截断。
- **取消点赞/收藏用 XHR 而非 fetch** — 抖音的 a_bogus 签名与 XHR 原型链深度绑定。注意：独立模式下取消由 background 直接用 `fetch()` POST，不经过 XHR（因为无页面上下文），但需 DNR rules 5/6（取消收藏/取消点赞）注入 Referer。
- **inject `extractVideo` 与 background `formatWork` 取链语义必须保持一致** — 三级优先：长效（各档 playApi）作为整体类目优先于 CDN，只在同类内部比分辨率；无 playApi 时用最高清档 `play_addr.uri` 合成长效链；CDN 兜底先取最高清档再档内比 `expire` 取最长。禁止改回"混池按最高分辨率挑选"——最高清档恰好缺 playApi 时会把短效直链存进库且 `videoExpireAt` 失真。fiber 源分支有意不同（只认 playApi、仅留最高一档），勿混改。
- **独立模式 listcollection 需 Argus webSign 签名** — 该端点被服务端额外校验，缺签名返回 403 `Blocked by ArgusSecurityPlugin Signature Not Found`。`independentRequest` 的 `options.webSign` 分支复刻页面 `window.use("webSignUrl")` 算法（query 追加 `timestamp` 与 md5 签名，并带 uifid/expire 头）。盐变更会复发，算法与风险详见 [docs/INDEPENDENT_MODE.md](./docs/INDEPENDENT_MODE.md)。
- **短操作弹窗锁定** — `state.preventDialogClose = true` + `try/finally` 解锁；长操作 X 按钮始终可点以发送 `CANCEL_ACTIVE_TASK`。为避免短操作误发，`CANCEL_ACTIVE_TASK` 仅当 `state.activeDialog` 存在时发送。
- **API 请求统一用 `window.fetch` + `_dyInternal` 标志** — inject.js 的 6 个 API 请求函数全部使用 `window.fetch`（经 Fetch Hook），通过 `_dyInternal: true` 避免被 Hook 再次捕获，而非 `origFetch.call(window, ...)`（绕 Hook）。因为 Douyin 可能通过覆盖 `window.fetch` 注入签名参数，走 `origFetch` 会错过注入。详见 [docs/FETCH_AND_CACHE.md](./docs/FETCH_AND_CACHE.md)。
- **媒体加载有全局熔断** — `Detail.markMediaFail / markMediaOk / mediaRetryBlocked` 维护滑动窗口失败计数：视频/封面失败密集超阈值（`MEDIA_FAIL_*`）即进入冷却期，期间跳过重试直接降级；任何媒体成功加载即复位。新增媒体重试逻辑必须接入该机制，不要自行计数。
- **侧边栏封面必须走"视口门控 + 分帧队列"** — Sidebar 的条目创建（`#createWorkItem`）只把 `{url, cover, placeholder}` 挂进 `#workMeta`（WeakMap），**不发探针**；条目进入视口由 `#promoteItem` 经 `#enqueueCover` 入队（每帧 `SIDEBAR_IMG_PER_FRAME` 张 rAF 分帧）。禁止改回"创建即全量急切加载"——那会让翻页风暴期每页 20 张探针全部立即发起。整页 DOM 用单个 fragment 追加。
- **侧边栏是升降级式轻量虚拟化，且不用 `content-visibility:auto`** — Sidebar 有自己的填充/卸载 observer 对（root 必须显式传 `dom.sidebarBody`：rootMargin 相对滚动容器自身矩形展开，用 null root 会被祖先裁剪抵消导致预填失效），`#promoteItem` 发探针+绘制、`#demoteItem` 原地清背景图/恢复占位层/代际自增作废在途探针（根节点不换，尺寸由 aspect-ratio 保持）。`.sidebar-work-item` 上不要加 `content-visibility: auto`：媒体生命周期已由显式升降级管理，降级后子树为空，CV 只剩相关状态切换的每帧 Layerize 抖动（实测占滚动风暴 CPU 约三成）。
- **VirtualGrid 填充观察者是分圈观察，不是全量 observe** — 新骨架进 `#pendingSkeletons` 队列，每次只把最靠前 `OBSERVE_CHUNK_SIZE` 个交给 IO，圈尾哨兵（`#sentinelCard`）进入 `OBSERVER_ROOT_MARGIN` 时才放下一批（`#extendObservation`）。原因：`computeIntersections` 成本随已观察目标数线性，全量 observe 2000 卡时滚动期每帧重算 O(全部卡) 次几何（trace 实测 1.2s/5s）。注意三点：哨兵被删（`removeItems`）会断链，必须立刻续接；`render()`/`abortRender()` 重置时要同时清 `#pendingSkeletons`/`#sentinelCard`；`#demote` 重 observe 走直连路径不经队列。
- **网格卡片是双向虚拟化的** — VirtualGrid 有两个 IntersectionObserver：填充 observer（`OBSERVER_ROOT_MARGIN`，骨架进入视口即经 `#enqueueFill` 重填；观察范围按上条分圈扩展）与卸载 observer（`UNLOAD_ROOT_MARGIN`，完整卡滚出后由 `#demote` 降级回骨架）。卡片填充分时间预算制（每帧最多 `FILL_FRAME_BUDGET_MS`），不要改回固定张数/帧。新增会替换卡片 DOM 的逻辑必须保持 dataset key 与两个 observer 的交接（`populateItem` 负责 observe 完整卡）；`updateCardDOM` 已兼容骨架态。卸载圈远大于填充圈形成滞回，勿把两者调近。
- **填充/降级必须在骨架根节点上原地切换（禁止换根节点）** — 子类实现 `fillCard`/`clearCard`，只允许改类名与增删根节点的后代；grid 容器任一直接子节点被 `replaceChild`/`replaceWith` 都会触发 Blink 全量重排，成本随卡片总数线性增长（3000 卡单次 >10ms）。因此骨架模板必须与完整卡在根层同构（`.work-card > .work-media + .work-checkbox + .work-title`、`.following-card > .following-checkbox + .following-main(.following-avatar/.following-avatar-fallback + .following-nickname) + .following-stats`），媒体子树/操作按钮等可从完整模板取新节点移入。unloadObserver 因此持续观察同一根节点无需重挂，fill observer 在 `#demote` 时重新 observe。
- **悬停预览的媒体事件用 `pointerover/out` 委托，禁用 `pointerenter/leave`** — enter/leave 不冒泡，挂在 grid 容器上的监听器只有 target 是容器自身时才触发，卡片上的进入事件永远收不到（功能静默失效）。 WorksGrid 的 `#bindMediaEvents` 用冒泡的 pointerover/out + `relatedTarget && media.contains(relatedTarget)` 判断实现"跨 `.work-media` 边界只触发一次"。
- **网格媒体一律 `div`+`background-image`，禁止改回 `<img src>`** — `.following-avatar`/`.work-thumb`/`.sidebar-work-cover`/`.fav-work-thumb` 四个槽位全是 `<div role="img">`（详情大图 `#detailImage` 因依赖 object-fit:contain 与淡入过渡保留 `<img>`+探针）：背景图加载失败时浏览器不绘制任何占位图标，原生断裂图在元素层面失去载体（历史三轮"切换/滚动时瞬态裂图"报告的根治手段，`grep '<img'` 模板应只剩详情大图与图标 `<use>`）。加载统一走离屏 `new Image()` 探针先行，成功才提交 `style.backgroundImage`；死链在探针阶段终结。各槽位失败语义：关注头像（`#scheduleAvatarDrain`）切首字回退并退出 media-loading；作品缩略图（`#scheduleCoverDrain`）原样重试一次（`dataset.retry` 挂可见节点、随重填换新自然复位，熔断冷却中不重试），仍失败停留透明渐变占位态；侧边栏封面（`#scheduleImgDrain`，仅升级态才发探针）成功后直接隐藏 `.sidebar-work-cover-placeholder`，失败由条目底色兜底；收藏弹窗 fav-work-thumb 无熔断联动，直赋背景图即可。代际防乱序：关注头像用 `dataset.fillGen`+`#avatarTargetAlive`（骨架原地重填会复用根节点）；作品缩略图用 `dataset.coverGen`（`updateCardDOM` 复用同一节点再次入队）；Detail 大图用 `#imgProbeToken`（快速切换作品时作废在途探针）；侧边栏封面用 `cover.dataset.gen`（`#demoteItem` 自增作废在途探针，重升级再入新代）；在途探针回调必须先校验代际再提交，否则旧 URL 会提交到已换人的槽位。`#showAvatarFallback`/`clearCard` 必须清空 `backgroundImage` 防止旧图残留。options.js 启动打印 `[DDM] options build …` 构建标记，用于排查用户端跑旧构建的情况。
- **自带 display 值的组件类与 `.hidden` 同用必须成对声明 `.X.hidden { display: none }`** — 通用 `.hidden` 在 options.css 前部（约 66 行），同特异性（0,1,0）下会被文件后部组件规则里的 `display: flex/…` 覆盖，`hidden` 类静默失效、占位层常显（曾导致作品卡中央 emoji 常显、关注卡头像旁多出一个空占位圆）。既有先例：`.work-type-badge.hidden`、`.following-avatar-fallback.hidden`。

## config 分组速查

`options/options.js` 顶层 `config` 常量（35 个键。`background.js` 另有 `CONFIG` 含 `TIMEOUT` / `DELAY` / `SYNC` / `STORAGE_KEYS` / `DNR_RULES` / `GROUPS` / `PAGE` / `TOKEN_TTL` / `CANCEL` / `FATAL_ERRORS` / `WEBID_API` 等）：

| 分组       | 键                                                                                                                            |
|------------|-------------------------------------------------------------------------------------------------------------------------------|
| 视频重试   | `VIDEO_RETRY_DELAYS` `[200,400,600]` / `VIDEO_RETRY_MAX` `3` / `VIDEO_RETRY_FALLBACK_DELAY` `1000`                            |
| 媒体熔断   | `MEDIA_FAIL_WINDOW` `5000` / `MEDIA_FAIL_MAX` `10` / `MEDIA_BREAK_COOLDOWN` `15000`                                           |
| 超时       | `FETCH_RETRY_DELAY` `1000` / `SYNC_TIMEOUT` `30000` / `VIDEO_FALLBACK_TIMEOUT` `5000`                                         |
| 详情页     | `DETAIL_TITLE_MAX_LEN` `40` / `TOAST_DURATION` `2000` / `DOWNLOAD_MAX_RETRY` `1`                                              |
| UI 延迟    | `HOVER_PREVIEW_DELAY` `200` / `BLOB_REVOKE_DELAY` `10000` / `NOTE_AUTO_PLAY_INTERVAL` `3000`                                  |
| 侧边栏     | `SIDEBAR_SNAP_POINTS` `[650,0]` / `SIDEBAR_SCROLL_THRESHOLD` `100` / `SIDEBAR_FILL_THRESHOLD` `50` / `SIDEBAR_IMG_PER_FRAME` `6` |
| 网格项尺寸 | `CARD_SIZE_FALLBACK` `261` / `CARD_GAP` `9` / `CARD_HEIGHT_OFFSET` `35`                                                       |
| 分块渲染   | `RENDER_CHUNK_SIZE` `50` / `OBSERVER_ROOT_MARGIN` `'200px'` / `OBSERVE_CHUNK_SIZE` `48` / `FILL_FRAME_BUDGET_MS` `8` / `UNLOAD_ROOT_MARGIN` `'1200px'`    |
| 分组/存储  | `GROUP_NAME_MAX_LEN` `20` / `STORAGE_MAX_BYTES` `10MB` / `TRASH_GROUP_NAME` `'稍后删除'`                                      |
| Tab 滚动   | `TAB_SCROLL_THRESHOLD` `2`                                                                                                    |
| 抖音 URL   | `URL_BASE` / `URL_USER_SELF` / `URL_LIKE_TAB` / `URL_COLLECTION_TAB` / `URL_FOLLOWING_TAB`                                    |
| 正则/图标  | `SEC_UID_REGEX` `/^\/user\/([^/?]+)/` / `icons` `{}`（init 填充）                                                             |

## 文档索引

| 文档                                                     | 阅读场景                                                                       |
|----------------------------------------------------------|--------------------------------------------------------------------------------|
| [docs/SYNC_AND_SCAN.md](./docs/SYNC_AND_SCAN.md)         | 作品同步、关注同步、点赞/收藏扫描、取消点赞/收藏、作者主页分页的完整链路与时序 |
| [docs/INJECT_INTERNALS.md](./docs/INJECT_INTERNALS.md)   | inject.js 数据提取、签名捕获与缓存、fetch/XHR Hook、安全密钥获取               |
| [docs/FETCH_AND_CACHE.md](./docs/FETCH_AND_CACHE.md)     | window.fetch 与 origFetch 的抉择、save/restore 缓存保护机制、六类 API 请求对比 |
| [docs/STORAGE_AND_MERGE.md](./docs/STORAGE_AND_MERGE.md) | IndexedDB 结构、作品合并、关注丢失检测、导入分组去重合并                       |
| [docs/SECURITY_AND_DNR.md](./docs/SECURITY_AND_DNR.md)   | declarativeNetRequest 规则、安全状态查询链路、安全风险                         |
| [docs/INDEPENDENT_MODE.md](./docs/INDEPENDENT_MODE.md)   | 独立模式架构 + msToken/webId/Cookie/浏览器特征缓存模型与存储键表               |
| [docs/TIKTOK_REFERENCE.md](./docs/TIKTOK_REFERENCE.md)   | 参考项目 TikTokDownloader 算法/凭据模块 + Douyin API 端点总表                  |
| [docs/COLLECTION_SCAN_REVERSE.md](./docs/COLLECTION_SCAN_REVERSE.md) | 独立模式扫描收藏全链路实录：请求要素、线格式、webSign 逆向过程与盐变更处置 |
