> 本文件是面向 **AI Agent**（Claude Code 等）的技术参考：只保留架构骨架、协议索引与最易踩的红线。
> 完整机制、实测数据与历史踩坑见 `docs/*.md`（文末索引）；人类用户请先阅读 [README.md](./README.md) 了解功能与安装。

# AGENTS.md — 抖音数据管理 (Douyin Data Manager)

任何具体行为以源码为准；本文件与分册冲突时，以分册与源码为准。

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

- **`background/` 按职责分子目录、每类独立成文件（文件名 = kebab-case 类名）** — 子目录划分与 `main.js` 组合根见 [docs/12](./docs/12-class-map.md) 类职责总表；类间循环 import 靠 live binding 在调用时安全消解
- **`options/` 共享全局只存在于 `core.js`** — `config` / `dom` / `state` / `store` / `utils` / `runtimeConfig` / `services` 七个对象在此定义并 export；类内自引用一律 `this.xxx()`，不用模块级单例变量（完整约定见 [docs/13](./docs/13-design-red-lines.md)）

## 四层架构

```
inject.js (主世界)          — fetch/XHR hook, 签名捕获, 按钮注入, 抓取逻辑
    ↓ CustomEvent
content.js (隔离世界)       — 桥接, requestResponse 模式, 作品捕获 LRU
    ↓ chrome.runtime.sendMessage
background/ (Service Worker) — ES 模块化：core.js 共享基础 + identity/data/tasks 子目录类模块 + main.js 组合根（消息路由 App.route）
    ↓ chrome.runtime.sendMessage
options/ (管理 UI)          — ES 模块化：core.js 共享基础 + 类模块（grids/components/data/sync）+ main.js 组合根（事件绑定/订阅/init）
```

## 六域存储模型（五数据域 + 回顾引用域）

```js
DOMAIN_CONFIG = {
  works:       { storeName, groupsName, defaultGroups, itemKey: 'works',       idField: 'awemeId' },
  followings:  { storeName, groupsName, defaultGroups, itemKey: 'followings',  idField: 'uid', idToString: true },
  favorites:   { storeName, groupsName, defaultGroups, itemKey: 'favorites',   idField: 'awemeId' },
  collections: { storeName, groupsName, defaultGroups, itemKey: 'collections', idField: 'awemeId' },
  candidates:  { storeName, groupsName, defaultGroups, itemKey: 'candidates',  idField: 'uid', idToString: true },
  review:      { storeName, groupsName, defaultGroups, itemKey: 'reviewItems', idField: 'reviewId' },
}
```

- `works` — `{ [awemeId]: Work }`（含 `video` 直链与 `videoExpireAt`；三级取链与长短效防覆盖见 [docs/02](./docs/02-independent-sync-works.md)）
- `favorites` / `collections` — 与 `works` 同构的 Work 记录；无独立保存消息，本域落库经 `persistScan` 的 `mergeAndSave`；跨域存入作品域走 `SAVE_WORKS`
- `followings` / `candidates` — 作者档案 7 字段（`uid/nickname/avatarLarger/followerCount/awemeCount/profileUrl/lastUpdateAt`）；关注=账号原生镜像，候选=扩展自建池（链接收录/关注域批量入库/手动校准，无账号同步源）；计数与 `lastUpdateAt` 由校准写入，导入快照 >0 时也按快照写入；0 值保留旧计数（见 [docs/01](./docs/01-project-architecture.md) / [docs/04](./docs/04-independent-calibrate-followings.md) / [docs/10](./docs/10-storage-write-and-import.md)）
- `review` — **真实回顾域，只存批次引用** `{ reviewId, sourceDomain, sourceId, kind, groupId, addedAt }`；展示时由 `review-handlers` 回源域 hydration，来源记录删除后引用失效并被清理；不复制完整记录、不参与导入/导出，删除/移动只改引用（见 [docs/11](./docs/11-options-ui.md)「回顾域」）
- `*_groups`（六域同构）— `[{ id, name, fixed, order? }]`，显示序一律经 `utils.normalizeGroups`（IDB `getAll` 主键序不是显示序）

## 消息协议

`App.route()`（`background/main.js`）switch 分发所有 `chrome.runtime.sendMessage`。**完整类型总表（载荷语义、分页参数、双模分支、进度载荷）见 [docs/01](./docs/01-project-architecture.md)「消息类型总表」**；此处仅速查：

- 数据操作：`SAVE_WORKS` / `GET_WORKS` / `DELETE_WORKS` / `MOVE_WORKS` / `SYNC_WORKS` / `GET_WORKS_BY_IDS`（`{ domain, ids }`，三作品域主键直取）/ `GET_RANDOM_RECORDS`（`{ domain, groupId, count, excludeIds? }`：随机回顾按主键抽样，返回 `items/poolSize/eligible/remaining`，不写存储）/ `GET_REVIEW`（`{ groupId }`：回顾引用回源 hydration）/ `SAVE_REVIEW_BATCH`（`{ sourceDomain, sourceIds, groupId, append? }`：缺省替换回顾批次引用；`append:true` 按 sourceId 去重后追加到目标分组，受 500 条上限约束，跨来源域拒绝）/ `DELETE_REVIEW` / `MOVE_REVIEW`（只改回顾引用，不触碰来源域）/ `SAVE_FOLLOWINGS` / `GET_FOLLOWINGS` / `DELETE_FOLLOWINGS` / `MOVE_FOLLOWINGS` / `SAVE_CANDIDATES` / `GET_CANDIDATES` / `DELETE_CANDIDATES` / `MOVE_CANDIDATES` / `GET_FAVORITES` / `DELETE_FAVORITES` / `MOVE_FAVORITES` / `GET_COLLECTIONS` / `DELETE_COLLECTIONS` / `MOVE_COLLECTIONS`。作品型三域 `GET_*` 必须带 `page`/`cursor` keyset 分页参数（可选 `ascending` 保存时间升序；缺省分页参数返回 `BAD_PARAMS`）；`sort:"authorCount"` + `direction` 走 background 作者视图（page0 附 `authorMeta`，续页 cursor `{ token, dir, ai, off }`，错误码 `VIEW_EXPIRED`/`BAD_CURSOR`/`AUTHOR_VIEW_INCOMPLETE`）；作者域单发全量
- 分组 / 工具：`GET_GROUPS` / `GET_DOMAIN_GROUPS`（`{ domain }`：只读 `*_groups` 小表，count 随数据写入同事务维护，升级 v11 回填）/ `ADD_GROUP` / `RENAME_GROUP` / `DELETE_GROUP` / `REORDER_GROUPS`；`IMPORT_DATA` / `EXPORT_DATA` / `RESET_DOMAIN` / `GET_STATS`（`{ domain }` 或 `{ bytesOnly:true }`）/ `GET_AUTHOR_UID_SETS` / `GET_AUTHOR_BY_UID`（`{ uid }`：关注/候选两域主键直取作者档案，侧栏头跨域补头像/统计）/ `GET_RECORD_STATUS`（`{ awemeId, uid }`：抖音标签页保存按钮状态角标，works/candidates 两域主键直读，返回 `work.exists` + `author.uid/candidate`）/ `GET_SECURITY_STATUS` / `SET_MODE` / `RESOLVE_SEC_UID` / `RESOLVE_USER_PROFILE` / `RELOAD_CONFIG` / 凭据刷新族（`CAPTURE_BROWSER_FEATURES` / `GET_COOKIE_INFO` / `GET_BROWSER_FEATURES` / `GET_CACHE_TIMES` / `REFRESH_MSTOKEN` / `REFRESH_WEBID` / `REFRESH_BROWSER_FEATURES` / `REFRESH_COOKIE`）
- 扫描 / 入库 / 校准：`FETCH_FOLLOWING` / `FETCH_FAVORITES` / `FETCH_COLLECTION`（列表扫描入口，与校准分离）；`IMPORT_USER_WORKS` / `IMPORT_CANDIDATE`（过程消息 `IMPORT_WORKS_PROGRESS`）；`CALIBRATE_FOLLOWING`（侧栏单用户关注）/ `CALIBRATE_FOLLOWINGS`（工具弹窗批量关注）/ `CALIBRATE_CANDIDATE`（侧栏单用户候选）/ `CALIBRATE_CANDIDATES`（工具弹窗批量候选，进度 `CALIBRATE_PROGRESS`）
- 状态切换 / 取消：`SET_FAVORITES` / `SET_COLLECTION { awemeId, active, work? }`（侧边作品栏 ♥/★：远端成功后才落库或删本地；点赞无独立模式分支）；`CANCEL_FAVORITES` / `CANCEL_COLLECTION` / `CANCEL_ACTIVE_TASK`（取消信号须经 background→content→inject 送达抖音 document）
- Tab 转发（background→tab）：`FETCH_WORK_DETAIL` / `FETCH_FOLLOWING_PAGE` / `FETCH_PROFILE_OTHER`（`{ secUid? , uid? }` 二选一）/ `FETCH_FAVORITES_PAGE` / `FETCH_COLLECTION_PAGE` / `CANCEL_ONE_FAVORITES` / `CANCEL_ONE_COLLECTION` / `SET_ONE_FAVORITES` / `SET_ONE_COLLECTION` / `FETCH_WORKS_PAGE` / `GET_SECURITY_STATUS`
- 进度 / 广播：`SYNC_PROGRESS` / `SYNC_DONE` / `FOLLOWING_PROGRESS` / `CALIBRATE_PROGRESS` / `FAVORITES_PROGRESS` / `COLLECTION_PROGRESS` / `IMPORT_WORKS_PROGRESS` / `CANCEL_PROGRESS` / `CANCEL_DONE` / `IMPORT_PROGRESS` / `STORE_CHANGED`（**仅在 `changed>0` 时广播**；point/bulk 两种载荷见 [docs/01](./docs/01-project-architecture.md)）

## 响应式状态管理

`store.on()` 事件 → 处理的完整映射表（含 `'work-record-appended'` 渐进分页回填、`'grid-total(s)'` 分组计数）已迁至 [docs/11](./docs/11-options-ui.md)「响应式状态管理（store.on 事件表）」。

## Class 职责总表

options 侧 19 类与 background 侧 19 类/对象的职责对照表（含每类机制红线指引）见 [docs/12-class-map.md](./docs/12-class-map.md)；`background/` 子目录划分与组合根见其「background/ 类单例」表。

## 高频红线（完整版见 docs/13）

> 下面是最易踩的 14 条；完整规则、机制原理与历史踩坑见 [docs/13-design-red-lines.md](./docs/13-design-red-lines.md)。未单独标注依据时，机制定案见 [docs/11](./docs/11-options-ui.md)。

1. **`state.dataVersion` 是视图缓存唯一失效判据** — store 数据变更方法自动自增；绕过封装的原地写入（`tryHeadInsert`/`applyStoreUpserts`）必须手动自增。`getWorksView`/`getAuthorRecordsView` 返回共享缓存数组，调用方一律只读。
2. **虚拟网格窗口化** — `GRID_MOUNT_MAX`(600) 是活动 DOM 硬上限；活动窗口（`#syncWindow`/`#remountWindow`）+ 尾部占位（`#syncTailReserve`）+ 滚近键控扩容（`#extendIfNeeded`）维持恒定挂载量。**禁止改回「预挂/后台补铺余量卡」**；硬不变量 `total ≤ GRID_MOUNT_MAX ⟺ #headTrim === 0`；整窗重挂按 itemKey 复用重叠卡，禁止整窗重克隆回灰骨架。
3. **分页回填按视图下标** — 页序与视图序对齐时 `fillSlots(view.length - pageView.length)` 逐页续填：saved 按 keyset 方向对齐，authorCount 按 trusted 作者视图对齐（`work-record-appended` 载荷 `mode/direction`）；中途切排序或 `isPageAligned` 失配时静默累积、完成整渲。`work-record-appended` 的 domain/groupId 双校验不得省略。
4. **详情导航顺序 = 网格已渲染顺序** — Detail 取 `VirtualGrid.renderedItems()`，快照缺失才回退 `getWorksView()`；展示作品以 `#currentId` 钉住，关闭详情按 awemeId `restoreGridScroll`，不得用下标。
5. **批量勾选与 Shift 连选** — 必须走 `Batch.updateCheckboxDOM`（否则图标透明）；Shift 区间按 `renderedItems()` 取序（与挂载卡 DOM 同序）；用户重定义结果集时 `Batch.resetSelection` 作废选区与锚点；Ctrl/Cmd 旁路：作者卡（任意区域）→新标签打开作者主页，作品卡作者名→新标签打开作者主页（普通点击=开侧边作品栏）。
6. **搜索栏与键盘** — 搜索框常驻顶栏、分组行常驻搜索栏（无折叠、无 S 开关；不自动聚焦输入框）；Esc 层级「弹窗 → 详情 → 失焦」；搜索显式提交（Enter/🔍，输入不即时响应）；域切换只重置搜索态；筛选不落 URL hash；关键词昵称子串始终匹配、纯数字额外按作者 UID（作品域精确、作者域子串），提示文案须与行为一致（`awemeId` 不参与）。
7. **弹窗锁定与键盘直达** — 长操作 `state.preventDialogClose = true` + `try/finally`；`state.activeDialog` 在 `Dialog.#mountLayer` 挂载时写入；footer Enter=主动作、Ctrl+Enter 仅显式绑定；Esc 由 main.js 单点收口，详情不得自管 Esc。
8. **媒体体系** — 媒体加载全局熔断，重试必须接入 `Detail.markMediaFail/markMediaOk/mediaRetryBlocked`；静音偏好全页单一 `state.mediaMuted`（网格/详情/侧栏同步）；页面隐藏即停播；图片类媒体槽位一律 `div`+`background-image`（探针先行、代际守卫），禁止 `<img src>`（视频仍用 `<video>`）；图集 `imageVideos[]` 与 `images[]` 逐位对位，实况小视频必须在静帧提交点才起播。
9. **作者域状态 chip** — 仅经 `GET_AUTHOR_UID_SETS` 取关注/候选主键集（`getAllKeys` 不物化记录），作品型三域等首屏后经 `services.whenFirstScreen` 再取；刷新后 `WorksGrid.syncAuthorFlags()` 只 toggle 挂载卡，**禁止整刷**；`authorFollowed` 已从 Work 记录移除，禁止重建该派生字段。
10. **布局 / DOM** — 网格卡片层禁用 `content-visibility: auto`；容器级事件委托绑 `#mainGrid`；填/卸载 IO root 显式传 `#mainGrid`；自带 display 的组件类必须成对声明 `.X.hidden`；禁止换卡片根节点；`#mainGrid` 保持 `scrollbar-gutter: stable`。
11. **词汇与 API 关键词** — 点赞=favorite（`favorites` 域/`FETCH_FAVORITES` 族）、收藏=collection(s)（`collections` 域/`FETCH_COLLECTION` 族）、作品/关注/候选=works/followings/candidates；数据域/消息/存储标识符中 `like`/`digg` 清零（端点等字符串值保留；UI 展示类 `.sidebar-presence-like` / `likeEl` 为历史命名例外）；`aweme` 为平台实体词（`awemeId`/`aweme_list`/`aweme_type`）；`SYNC_WORKS` 是重取已存作品详情，不是列表扫描。
12. **网络与存储写入** — 点赞/收藏状态设置走 XHR（Tab 模式，签名绑 XHR 原型链）；独立模式仅收藏直连 POST，点赞拒绝 `UNSUPPORTED_INDEPENDENT`；API 请求统一 `window.fetch` + `_dyInternal`；`STORE_CHANGED` 仅在 `changed>0` 广播、bulk 只带 id 集；fav/col 落库经 `SAVE_WORKS`/`persistScan`；作者域 0 值计数不得覆盖已校准值；分组显示序必须经 `normalizeGroups`。
13. **作者数排序分页（方案 B）** — 视图由 `groupId_uid_sort` 索引键扫描 + SW 内存构建，禁止改回持久化 `author_views`/全量记录扫描；IDB 字符串 uid 的索引范围不得用 `[groupId, Infinity]`（number 排在 string 前），用 `lowerBound([groupId])` + 分组边界提前停止；写入 rev 必须在事务 `oncomplete` 后自增；每页校验 rev，`VIEW_EXPIRED` 必须上抛给 options 重载（禁止 `.catch(() => {})` 吞掉）；uid/createTime 缺失或类型混杂必须经 `backfillPagingKeys` / `mergeWork` 归一化，否则记录不进索引。
14. **分组计数 `*_groups.count`（DB v11）** — 只由 `storage.putBatch/deleteBatch/clear` 在数据写事务内维护；禁止绕开 storage 直接写数据 store，否则计数永久漂移；`GET_DOMAIN_GROUPS` 只读 `*_groups` 小表；`putGroups` 保留已有 count（新组 0、RESET 用 `resetCounts:true`），升级 v11 一次性回填并删除 v10 `group_counts`。

## config 分组速查

- **options/core.js 顶层 `config`（64 键）** — 权威键表与默认值见 [docs/01](./docs/01-project-architecture.md)「配置项说明 · options/core.js 顶层 config」。
- **background/core.js `CONFIG`**（`TIMEOUT`/`DELAY`/`SYNC`/`STORAGE_KEYS`/`DNR_RULES`/`GROUPS`/`PAGE`/`BROADCAST`/`CANCEL`/`FATAL_ERRORS`/`WEBID_API`/`WEB_SIGN_SALT` 等）与 `runtimeConfig` 对象（从 `chrome.storage.local` 读入叠加进 `CONFIG`，SW 冷启动补 reload；键表同见 docs/01「配置项说明」）——运行时状态已塌缩为类私有字段，类职责见 [docs/12](./docs/12-class-map.md)「background/ 类单例」表。

## 文档索引

技术文档已按单一职责拆分为编号分册（术语规范见 01：**Tab模式**=页面注入脚本方式；**独立模式**=纯后台逆向请求流程）：

| 文档 | 阅读场景 |
|------|----------|
| [docs/01-project-architecture.md](./docs/01-project-architecture.md) | 项目架构：双模运行与路由隔离、代码布局约束、六域存储模型（五数据域 + 回顾引用域）、消息类型总表、进度消息载荷、全局配置 |
| [docs/02-independent-sync-works.md](./docs/02-independent-sync-works.md) | 独立模式同步作品（SYNC_WORKS / formatWork 三级取链） |
| [docs/03-independent-sync-followings.md](./docs/03-independent-sync-followings.md) | 独立模式同步关注（FETCH_FOLLOWING 分页采集） |
| [docs/04-independent-calibrate-followings.md](./docs/04-independent-calibrate-followings.md) | 作者域计数校准（工具弹窗批量 + 侧边栏单用户，关注/候选两域各自独立）+ 最近更新日期 lastUpdateAt |
| [docs/05-independent-scan-collection.md](./docs/05-independent-scan-collection.md) | 独立模式扫描收藏（listcollection 线格式 + Argus webSign 定案、绑定域实验、盐轮换处置） |
| [docs/06-independent-cancel-collection.md](./docs/06-independent-cancel-collection.md) | 独立模式取消收藏（background 直连 POST 循环） |
| [docs/07-independent-fetch-user-works.md](./docs/07-independent-fetch-user-works.md) | 作者主页作品分页（FETCH_WORKS_PAGE 双模分支） |
| [docs/08-dnr-rules.md](./docs/08-dnr-rules.md) | 全部 DNR 动态规则（6 条）、优先级关系与排障 |
| [docs/09-inject-tab-mode.md](./docs/09-inject-tab-mode.md) | Tab模式注入侧技术方案：签名捕获/三种签名策略/_dyInternal、事件桥、按钮注入、取消信号 |
| [docs/10-storage-write-and-import.md](./docs/10-storage-write-and-import.md) | 存储写入与导入合并：mergeWork/计数保护/丢失检测/reconcileImportGroups 三级对账 |
| [docs/11-options-ui.md](./docs/11-options-ui.md) | 管理页渲染与交互：VirtualGrid 窗口化/尾部占位、Sidebar 虚拟化、媒体探针与熔断、store.on 事件表、勾选 DOM 约定、弹窗锁定 |
| [docs/12-class-map.md](./docs/12-class-map.md) | 类职责总表：options 侧与 background/ 侧全部类/对象的职责对照与红线指引 |
| [docs/13-design-red-lines.md](./docs/13-design-red-lines.md) | 设计红线与知识点陷阱完整版（编码/消息/签名/数据语义/UI/渲染/媒体，自 AGENTS.md 迁出） |
| [docs/TIKTOK_REFERENCE.md](./docs/TIKTOK_REFERENCE.md) | 参考项目 TikTokDownloader 算法/凭据模块 + Douyin API 端点总表 |
