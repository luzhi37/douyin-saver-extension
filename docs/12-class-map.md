# 12 · 类职责总表（options 侧 + background 侧）

> 本文自 AGENTS.md「Class 职责总表」迁出（2026-10-03 瘦身）。AGENTS.md 保留分层架构图与规则红线，本册承载两侧类模块的职责对照表，与源码同步维护。
> 术语规范见 01：**Tab模式**=页面注入脚本方式；**独立模式**=纯后台逆向请求流程。

## options/ 侧类模块

| Class            | 职责                                                              |
|------------------|-------------------------------------------------------------------|
| `SearchBar`      | 搜索/筛选子系统（数据层视图 getWorksView/getAuthorRecordsView + 检索状态 `#searchState`；三段视图缓存 `#viewCache` + `state.dataVersion` 失效判据 + 恒等快速路径，见 docs/11「视图阶段缓存与筛选切换性能」；搜索框常驻顶栏、分组行常驻（无折叠开关），见 docs/11「SearchBar」） |
| `SelectMenu`     | 自绘下拉基类（`.sb-scope`）：开合/键盘（Enter/Space、↑↓/Home/End、Esc/Tab）/ARIA（combobox·listbox·activedescendant·selected）；搜索栏 3 个下拉与回顾来源下拉同构复用；隐藏选项不参与键盘导航。 |
| `VirtualGrid`    | 网格渲染基类（双向虚拟化：填充/卸载双 observer + 时间预算填充 + 事件委托 + `insertItems`/`removeItems` 位插对偶；机制与红线见 docs/11） |
| `Dialog`         | 多层弹窗管理（基层 #dialogOverlay + pushDialog 动态实例叠层，关闭顶层自动回父层；`dom.dialogTitle/dialogBody/dialogFooter/dialogClose` 由其动态指向顶层实例元素，仅该类可写） |
| `AuthorGrid`     | 作者卡片网格（关注/候选/回顾作者三实例；共用 `following-card` 模板与勾选框，按域键守卫点击） |
| `Groups`         | 分组 tab + 管理（域切换/刷新经 `GET_DOMAIN_GROUPS` 原子快照一次渲染名称/顺序/计数；无进度缓存）                                                   |
| `Batch`          | 批量操作（勾选、Shift 连选、全选、删除、移动、下载；批量下载支持作品/点赞/收藏与回顾作品批次）+ 跨域存入作品域（`saveSelectedToWorks`，点赞/收藏域批量模式经 `SAVE_WORKS` 写入作品域）+ 关注域批量入库候选域（`saveSelectedToCandidates`，经 `SAVE_CANDIDATES` 复制）；按钮常驻 `#batchBar` 底部工具条，计数只写 `#batchCount` 数字节点 + `#batchTotal` 分母；移动/下载/移除保留 title/aria-keyshortcuts，不显示按钮内快捷键徽标 |
| `ImportExport`   | 数据维护弹窗（五域导出/导入/重置聚合单弹窗，按钮由 `DOMAINS_META` 生成、显式指定目标域不随当前域自适应；导入经隐藏 fileInput 按 `#pendingImportDomain` 分流；确认/进度弹窗经 pushDialog 叠加） |
| `Sidebar`        | 侧边作品栏（跨各域共用：关注/候选域由作者卡打开、作品/点赞/收藏/回顾域点击作品作者名打开（作者名的 Ctrl/Cmd+点击则在新标签打开作者主页）；作者作品分页 + 条目升降级虚拟化 + 作品卡「存入」/♥/★ 状态切换 + 悬停预览播放（`stopAllMedia` 统一收口）+ 吸顶作者身份头（`#sidebarAuthorHead`，作品型三域缺少统计时降级为已加载数量）；`setSidebarWidth` 同步 `--sidebar-live-width` 供批量条居中）                                            |
| `Sync`           | 同步状态机（作品/关注）                                           |
| `DomainScanSync` | 点赞/收藏域扫描同步（进度弹窗 + 丢失检测 UI；与 Sync 同构的姊妹状态机，落库由 background `persistScan` 直写，本类只驱动进度与刷新） |
| `AuthorImport`   | 入库（菜单「工具」弹窗：作品域=分页循环长任务+进度弹窗复用 syncDialogBodyTemplate，候选域=单请求收录作者档案；另提供关注/候选两域批量校准；输入仅支持作者主页链接，sec_uid 从链接直提、`/user/self` 经 RESOLVE_SEC_UID 兑换；与 Sync/DomainScanSync 三链路互斥；底部 uid 反查区块走 RESOLVE_USER_PROFILE，只读短请求、结果显示昵称/抖音号/主页链接，错误统一 toast；另有清理三按钮「清理点赞域」「清理收藏域」「清理候选域」：关注全集比对后确认移入「稍后删除」，候选域重叠清理即原「同步」按钮功能（2026-11-05 迁入本弹窗）） |
| `Settings`       | 设置面板（仅运行参数/缓存状态/secUid/独立模式；开关仅切视觉态，校验与持久化统一走 `saveBeforeClose`；私有成员全部 `#` 前缀） |
| `Status`         | 状态面板（右栏 `#btnStatus`；Cookie 配置 / 浏览器特征 / Tab 模式捕获状态，只读；`openDialog` 拉取 `GET_COOKIE_INFO` / `GET_BROWSER_FEATURES` / `GET_SECURITY_STATUS` 并渲染，含展开/复制交互；2026-11-08 自设置面板迁出） |
| `WorksGrid`      | 作品卡片网格（作品/点赞/收藏/回顾作品四实例共用；卡片填充/媒体预览 + 作者域状态 chip 与 `syncAuthorFlags` 原地 patch）                                                      |
| `Detail`         | 详情播放器（对齐抖音播放界面：全宽播放器、.media-view 宽度随媒体宽高比自适应、双形态进度条、⌃⌄ 作品切换胶囊、计数 K 可编辑跳转；定案见 docs/11） |
| `AppShell`       | 应用壳（域切换滑块 switchDomain/updateDomainSlider、域数据加载包装 loadDomainDataSafe（按搜索栏排序取数方向）、全局错误态 renderErrorState、弹窗关闭统一入口 requestDialogClose、右侧导航轨固定 48px（折叠功能与按钮已于 2026-11-08 移除）、reloadCurrentDomain；事件构造器内自绑定；回顾域作者布局 data-review-kind 写入） |
| `Tooltip`        | 全局自绘 tooltip（接管剩余 `title` 属性；深色浮层+箭头、视口内定位；显示期间临时移除 `title` 防原生浮层叠加，动态改写 title 时以新值为准；滚动/缩放只收起浮层，离开目标才恢复 title） |
| `RandomReview`   | 回顾域（分组行内联配置：来源下拉/本轮数量自定义 1–500/随机回顾/追加、`GET_RANDOM_RECORDS` 抽样、`SAVE_REVIEW_BATCH` 只写批次引用（随机=替换，追加=同来源域去重后落「未分组」）、优先排除当前批次并在无新数据时整批重抽；网格由 reviewWorksGrid/reviewAuthorsGrid 渲染，不复制来源记录） |

## background/ 类单例（按职责分模块，与 options 侧类模块同构）

| 类 / 对象              | 文件                         | 职责                                                                                                                                                  |
|------------------------|------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------|
| `runtimeConfig` (对象) | `core.js`                    | 运行时配置：从 `chrome.storage.local` 读入叠加进 `CONFIG`（`KEY`/`DEFAULTS`/`load`/`apply`/`reload`/`delayRange`）；SW 冷启动补 reload 恢复运行参数 |
| `utils` (对象)         | `core.js`                    | 纯函数集：`normalizeGroups` / `awemeIdCreateTime` / `parseExpire` / `urlExpireAt` / `isLongLivedVideoUrl` / `stripHttp` / `extractMsTokenFromCookie` / `hasMoreFlag` / `isFatalTaskError` / `withCancelGuard` / `asyncHandler` / `sendSyncDone` / `sendMessageSafe` / `pauseWithKeepalive` / `emitCancelDone` |
| `formatters` (对象)    | `core.js`                    | `formatWork` / `formatFollowing` / `formatAuthorFromProfile`                                                                                       |
| `Crypto` (静态)        | `identity/crypto.js`        | 哈希/解析工具静态类：`md5Hex`（Argus webSign）/ `parseCookieToPairs` / `generateRandomMsToken`                                                        |
| `ABogus`               | `identity/crypto.js`        | a_bogus 签名算法类（按 UA/浏览器特性实例化，`Credentials.ensureABogus` 使用）；同文件导出 `MSSDK_STR_DATA`（mssdk 兑换载荷）                          |
| `Credentials`          | `identity/credentials.js`    | 客户端凭据/签名：`ensureABogus`/`getClockSkew`/`buildBaseParams`/`getMsToken`/`refreshWebIdChain`；吸收凭据类消息（见 [01](./01-project-architecture.md)「消息类型总表」工具行） |
| `IndependentClient`    | `identity/independent-client.js` | 独立模式开关 + 签名直连 `request` + `resolveSelfSecUid`（内含 `resolveSecUidById` 兑换）；`request` 经 `credentials` 跨类取签名/时钟/msToken |
| `Storage`              | `data/storage.js`           | IndexedDB 封装层（单例连接 `#db`，DB v12：无改名迁移代码——低版本旧库升级前须先在旧版导出备份；新增 candidates/candidates_groups；作品型三域 `savedAt_id`/`groupId_savedAt_id`/`groupId_uid_sort` 复合索引 + 升级回填缺失 savedAt/groupId/uid/createTime、剔除废弃标题字段 desc；`*_groups.count` 派生计数随 putBatch/deleteBatch/clear 同事务维护 + v11 回填/删除旧 group_counts）；`readIndexPage` keyset 翻页（prev 取 limit+1 探测）/`scanIndexKeys`（keyCursor 只读索引键，不物化记录值）/`getGroupsWithStats`（只读 groups 小表），API 全集见文件 |
| `DomainStore`          | `data/domain-store.js`       | 域存储封装：`storeName`/`groupsName`/`toStorageId`/`facade`；`mergeWork`（uid/createTime/savedAt/groupId 类型归一化——作者数索引硬前提）；`mergeAndSave`（三作品型域通用）/ `mergeAndSaveAuthors`（作者域 followings/candidates，计数保护 + 丢失检测键集）——两者均做**真实变更检测**：内容全等的重复入库不写库、不计入 `changed`（写入路径语义见 docs/10） |
| `DomainHandlers`       | `data/domain-handlers.js`    | 域数据操作入口（5 实例 works/followings/favorites/collections/candidates）；`save` 仅 `changed>0` 广播 `STORE_CHANGED`（`changed ≤ BROADCAST.UPSERTS_MAX` 附 point 载荷，`#saveAuthorRecords` 恒 bulk——作者域无单卡更新原语）、响应剔除 `written`/`addedIds` 防大批量保存响应膨胀；`get({ groupId, page, cursor, ascending, sort, direction })`（saved keyset / authorCount → `AuthorViews.readPage`；作者域单发全量）/`delete`/`move`/`getByIds`（bulk 收口补拉通道）；写入语义见 docs/10 |
| `AuthorViews`          | `data/author-views.js`       | 作者数排序视图：`groupId_uid_sort` 索引 `openKeyCursor` 只扫键 → `shared/author-view-core` 构建 `作者 → 有序 id` → SW 内存 LRU（`AUTHOR_VIEW_CACHE_MAX`）；`readPage` 校验 token/epoch/rev 后 `getBatch` 取页；空 uid 按 nickname 兜底；rev 变化返回 `VIEW_EXPIRED`、索引项与记录数不符返回 `AUTHOR_VIEW_INCOMPLETE`（options 降级 saved） |
| `TabBridge`            | `identity/tab-bridge.js`     | 抖音标签页查找/转发（`find`/`send`/`sendAsync`）；吸收 `CANCEL_ACTIVE_TASK`/`GET_SECURITY_STATUS`/`FETCH_WORKS_PAGE` 非独立分支                    |
| `Groups`               | `data/groups.js`             | 分组 tab + 管理（域感知）；`getWithStats` 只读 `*_groups` 小表返回分组表与 count（计数由存储写入维护，O(分组数)）                                                                                                                            |
| `DataTools`            | `data/data-tools.js`         | 导入导出/重置/统计（域感知）；`reconcileImportGroups`                                                                                                 |
| `ReviewHandlers`       | `data/review-handlers.js`    | 回顾引用域处理器：`get`（按组读引用并回源 hydration、清理失效引用）/`saveBatch`（替换或同来源域去重追加）/`deleteBySource`/`moveBySource`；只改引用，不触碰来源域 |
| `ScanTasks`            | `tasks/scan-tasks.js`        | Tab 模式长任务：同步/扫描/取消循环（含 `persistScan` 落库）；`calibrateOne(uid, secUid, domain)`（单用户校准）/`calibrateAll(domain)`（工具弹窗批量校准，双模 `#fetchProfileUser({ secUid, uid })` 取数）/`calibrateStats`（批量迭代器）；`resolveUserProfile(uid)`（数字 uid→sec_uid/主页链接，双模短查询）；`importUserWorks`（注入 Tab 取页器）/`importCandidate` |
| `IndependentTasks`     | `tasks/independent-tasks.js` | 独立模式长任务：`fetchFollowing`/`fetchCollection`/`syncWorks`/`fetchWorksPage`/`importUserWorks`（注入直连取页器）/`cancel`/`setReaction`（侧边栏单作品收藏/取消）                                            |
| `runAuthorWorksImport`（函数） | `tasks/author-works-import.js` | 作者作品入库双模共用循环壳：BAD_PARAMS 守卫、重叠页去重防死循环、逐页 `mergeAndSave` 落库、全部批次结束后统一广播一次 `STORE_CHANGED`（轻量 id 集，**禁止移回循环内逐页发**）、`IMPORT_WORKS_PROGRESS`、取消守卫；双模任务类各注入 `fetchPage(cursor)` 页取数器（细节见 docs/07） |
| `App`                  | `main.js`                    | 初始化（注册 `onInstalled`/`onStartup`/`onClicked` + `setupDeclarativeNetRequest`）+ 消息路由 `route`（`SET_MODE` 调 `independentClient.setMode`）  |

## 相关文档

| 编号 | 文档 | 关联内容 |
|------|------|----------|
| 01 | [01-project-architecture.md](./01-project-architecture.md) | 四层架构、代码布局约束、消息类型总表、配置项说明 |
| 07 | [07-independent-fetch-user-works.md](./07-independent-fetch-user-works.md) | `Sidebar`/`AuthorImport` 数据来源（FETCH_WORKS_PAGE 双模） |
| 10 | [10-storage-write-and-import.md](./10-storage-write-and-import.md) | `Storage`/`DomainStore`/`DomainHandlers` 写入语义 |
| 11 | [11-options-ui.md](./11-options-ui.md) | options 侧类模块的机制定案与渲染红线 |
| 13 | [13-design-red-lines.md](./13-design-red-lines.md) | 设计红线与知识点陷阱完整版（自 AGENTS.md 迁出） |
