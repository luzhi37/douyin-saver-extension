# 12 · 类职责总表（options 侧 + background 侧）

> 本文自 AGENTS.md「Class 职责总表」迁出（2026-10-03 瘦身）。AGENTS.md 保留分层架构图与规则红线，本册承载两侧类模块的职责对照表，与源码同步维护。
> 术语规范见 01：**Tab模式**=页面注入脚本方式；**独立模式**=纯后台逆向请求流程。

## options/ 侧类模块

| Class            | 职责                                                              |
|------------------|-------------------------------------------------------------------|
| `SearchBar`      | 搜索/筛选子系统（数据层视图 getWorksView/getAuthorRecordsView + 检索状态 `#searchState`；三段视图缓存 `#viewCache` + `state.dataVersion` 失效判据 + 恒等快速路径，见 docs/11「视图阶段缓存与筛选切换性能」；搜索框与分组按钮组同处顶栏单行（窄窗按序折行、无折叠开关），见 docs/11「SearchBar」） |
| `SelectMenu`     | 自绘下拉基类（`.sb-scope`）：开合/键盘（Enter/Space、↑↓/Home/End、Esc/Tab）/ARIA（combobox·listbox·activedescendant·selected）；搜索栏 3 个下拉与顶栏回顾来源下拉同构复用；隐藏选项不参与键盘导航。 |
| `VirtualGrid`    | 网格渲染基类（双向虚拟化：填充/卸载双 observer + 时间预算填充 + 事件委托 + `insertItems`/`removeItems` 位插对偶；机制与红线见 docs/11） |
| `Dialog`         | 多层弹窗管理（基层 #dialogOverlay + pushDialog 动态实例叠层，关闭顶层自动回父层；`dom.dialogTitle/dialogBody/dialogFooter/dialogClose` 由其动态指向顶层实例元素，仅该类可写） |
| `AuthorGrid`     | 作者卡片网格（关注/候选/回顾作者三实例；共用 `following-card` 模板与勾选框，按域键守卫点击） |
| `Groups`         | 分组 tab + 管理（域切换/刷新经 `GET_DOMAIN_GROUPS` 原子快照一次渲染名称/顺序/计数；无进度缓存；回顾域禁用分组——顶栏分组按钮组隐藏、不加载快照，右栏「分组」入口置灰）                                                   |
| `Batch`          | 批量操作（勾选、Shift 连选、全选、删除、移动——回顾域禁用分组、移动入口隐藏；批量下载支持作品/点赞/收藏与回顾作品批次——任务坞本地任务 `batchDownload`，不经 background 队列/不占 RequestGate 车道，暂停=条目边界协作让出（在途条目收尾后挂起）、继续续跑、取消 abort 在途 fetch/zip worker，行状态经 `setLocalStatus` 回写）+ 跨域存入作品域（`saveSelectedToWorks`，点赞/收藏域批量模式经 `SAVE_WORKS` 写入作品域）+ 关注域批量入库候选域（`saveSelectedToCandidates`，经 `SAVE_CANDIDATES` 复制）+ 点赞/收藏域「取消并移除」（确认弹窗保留「直接移除」ghost 分支；主分支登记任务坞发送 `CANCEL_*`，`onDone` 按 `deletedIds` 本地摘卡）；批量入口位于顶栏最右（`#btnBatch`），操作按钮常驻 `#batchBar` 底部工具条，计数只写 `#batchCount` 数字节点 + `#batchTotal` 分母；移动/下载/移除保留 title/aria-keyshortcuts，不显示按钮内快捷键徽标 |
| `ImportExport`   | 数据维护弹窗（五域导出/导入/重置聚合单弹窗，按钮由 `DOMAINS_META` 生成、显式指定目标域不随当前域自适应；导入经隐藏 fileInput 按 `#pendingImportDomain` 分流；确认/进度弹窗经 pushDialog 叠加；导入分两路——作者域同步弹窗流程，作品型三域 begin-before-send 登记 `importData` 坞行后弹窗仅承载传输/解析阶段，ack 即收层，刷新与终态移交任务坞/STORE_CHANGED；导出走本地任务 `exportData` 坞行——不经队列/不参与互斥，暂停/取消宿主自理，不再用弹窗进度层） |
| `Sidebar`        | 侧边作品栏（跨各域共用：关注/候选域由作者卡打开、作品/点赞/收藏/回顾域点击作品作者名打开（作者名的 Ctrl/Cmd+点击则在新标签打开作者主页）；作者作品分页 + 条目升降级虚拟化 + 作品卡「存入」/♥/★ 状态切换 + 悬停预览播放（`stopAllMedia` 统一收口）+ 吸顶作者身份头（`#sidebarAuthorHead`：作品型/回顾域打开时并行 `RESOLVE_AUTHOR_STATS` 取 profile 精准作品数/粉丝数（只读不落库，失败静默降级为已加载数量），作者域由校准回写；成员资格 chip 按真实成员域显示（`#resolveAuthorMembership`/`#syncAuthorDomainActions`，关注只展示无动作入口），候选域按钮按成员资格自适应「加入」（`IMPORT_CANDIDATE` 快捷收录）/「移除」（`DELETE_CANDIDATES` 确认直删））；`setSidebarWidth` 同步 `--sidebar-live-width` 供批量条居中）                                            |
| `Sync`           | 作品同步 / 关注同步的入口：生成 taskId、登记任务坞并发送 `SYNC_WORKS` / `FETCH_FOLLOWING`；两者的 progress/终态均由 `TaskDock` 消费，`onDone` 只收口 `NO_SIGNATURE` 引导与 lostUids trash（数据/分组刷新由终态 STORE_CHANGED 管线统一承担） |
| `TaskDock`       | 非模态任务坞（右下角固定面板）：**全部 10 类 API 长任务**共用（本地任务 `batchDownload`/`exportData` 同坞渲染，不经队列、宿主回调自理），订阅 `TASK_PROGRESS`/`TASK_DONE` 与 `GET_TASK_STATE`；按 `KIND_CONFIG[kind]` 用各自原弹窗文案渲染 `.sync-line`，`STATE_TEXT` 含 `PARTIAL`；`begin({onDone,onTrash})` 回调只对本地行执行；控制端口绑定（断线即关页取消）、取消直接生效、`failedAwemeIds`/`lostUIds` 直接移入「稍后删除」；`onRunningChange` 驱动设置入口禁用；不写 store、不触发网格重渲 |
| `DomainScanSync` | 点赞/收藏域扫描入口：登记任务坞并发送 `FETCH_FAVORITES`/`FETCH_COLLECTION`，`onDone` 只处理 `NO_SIGNATURE` 引导；落库/丢失检测/终态 STORE_CHANGED 全在 background `createScanWriter` 分块确认写 |
| `AuthorImport`   | 工具弹窗：作品域入库 / 关注·候选批量校准登记任务坞（无进度弹窗）；候选域入库为单请求短操作（**不登记任务坞/队列**：按钮 busy 态 + toast/签名引导就地收口，发出即清空输入）；输入仅支持作者主页链接，sec_uid 从链接直提、`/user/self` 经 RESOLVE_SEC_UID 兑换；长任务由任务坞 FIFO 队列串行（同类型可排队）；底部 uid 反查区块走 RESOLVE_USER_PROFILE（只读短请求）；清理三按钮「清理点赞域」「清理收藏域」「清理候选域」：关注全集比对后确认移入「稍后删除」（2026-11-05 迁入本弹窗） |
| `Settings`       | 设置面板（运行参数/缓存状态/secUid/独立模式；开关仅切视觉态，校验与持久化统一走 `saveBeforeClose`；订阅任务坞运行态——任务进行中禁用导航轨「设置」按钮、已打开面板 `inert`；私有成员全部 `#` 前缀） |
| `Status`         | 状态面板（右栏 `#btnStatus`；Cookie 配置 / 浏览器特征 / Tab 模式捕获状态，只读；`openDialog` 拉取 `GET_COOKIE_INFO` / `GET_BROWSER_FEATURES` / `GET_SECURITY_STATUS` 并渲染，含展开/复制交互；2026-11-08 自设置面板迁出） |
| `WorksGrid`      | 作品卡片网格（作品/点赞/收藏/回顾作品四实例共用；卡片填充/媒体预览 + 作者域状态 chip 与 `syncAuthorFlags` 原地 patch）                                                      |
| `Detail`         | 详情播放器（对齐抖音播放界面：全宽播放器、.media-view 宽度随媒体宽高比自适应、双形态进度条、⌃⌄ 作品切换胶囊、计数 K 可编辑跳转；定案见 docs/11） |
| `AppShell`       | 应用壳（域切换滑块 switchDomain/updateDomainSlider、域数据加载包装 loadDomainDataSafe（按搜索栏排序取数方向）、全局错误态 renderErrorState、弹窗关闭统一入口 requestDialogClose、右侧导航轨固定 48px（折叠功能与按钮已于 2026-11-08 移除）、reloadCurrentDomain；事件构造器内自绑定；回顾域作者布局 data-review-kind 写入） |
| `Tooltip`        | 全局自绘 tooltip（接管剩余 `title` 属性；深色浮层+箭头、视口内定位；显示期间临时移除 `title` 防原生浮层叠加，动态改写 title 时以新值为准；滚动/缩放只收起浮层，离开目标才恢复 title） |
| `RandomReview`   | 回顾域（配置（来源域/本轮数量 1–500）由**顶栏回顾控件**维护（回顾域下占据顶栏左侧，变更即校验并持久化）、本类提供 `getConfig` 并持久化 `randomReviewConfig`；随机入口为顶栏回顾配置组内的「随机」按钮、`GET_RANDOM_RECORDS` 抽样、`SAVE_REVIEW_BATCH` 整批替换只写引用、优先排除当前批次并在无新数据时整批重抽；网格由 reviewWorksGrid/reviewAuthorsGrid 渲染，不复制来源记录） |

## background/ 类单例（按职责分模块，与 options 侧类模块同构）

| 类 / 对象              | 文件                         | 职责                                                                                                                                                  |
|------------------------|------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------|
| `runtimeConfig` (对象) | `core.js`                    | 运行时配置：从 `chrome.storage.local` 读入叠加进 `CONFIG`（`KEY`/`DEFAULTS`/`load`/`apply`/`reload`/`delayRange`）；SW 冷启动补 reload 恢复运行参数 |
| `utils` (对象)         | `core.js`                    | 纯函数集：`normalizeGroups` / `awemeIdCreateTime` / `parseExpire` / `urlExpireAt` / `isLongLivedVideoUrl` / `stripHttp` / `extractMsTokenFromCookie` / `hasMoreFlag` / `isFatalTaskError` / `asyncHandler` / `sendMessageSafe` / `sleepWithKeepalive` / `pauseWithKeepalive` / `emitTaskProgress` / `emitTaskDone` |
| `formatters` (对象)    | `core.js`                    | `formatWork` / `formatFollowing` / `formatAuthorFromProfile`                                                                                       |
| `Crypto` (静态)        | `identity/crypto.js`        | 哈希/解析工具静态类：`md5Hex`（Argus webSign）/ `parseCookieToPairs` / `generateRandomMsToken`                                                        |
| `ABogus`               | `identity/crypto.js`        | a_bogus 签名算法类（按 UA/浏览器特性实例化，`Credentials.ensureABogus` 使用）；同文件导出 `MSSDK_STR_DATA`（mssdk 兑换载荷）                          |
| `Credentials`          | `identity/credentials.js`    | 客户端凭据/签名：`ensureABogus`（幂等，按 features 镜像对象代数重建）/`getClockSkew`/`buildBaseParams`/`getMsToken`/`refreshWebIdChain`；凭据 SW 内存镜像（写穿 + `storage.onChanged` 兜底 + `cookies.onChanged` jar 三键精确失效，读取一律走 `getFeatures`/`getSavedCookie`/`getMsToken`/`getWebId`，契约见 [13](./13-design-red-lines.md)）；吸收凭据类消息（见 [01](./01-project-architecture.md)「消息类型总表」工具行） |
| `IndependentClient`    | `identity/independent-client.js` | 独立模式开关 + 签名直连 `request` + `resolveSelfSecUid`（内含 `resolveSecUidById` 兑换）；`request` 经 `credentials` 跨类取签名/时钟/msToken |
| `Storage`              | `data/storage.js`           | IndexedDB 封装层（单例连接 `#db`，DB v12：升级路径仅做 schema 收敛（补建缺失 store/索引），不携带数据迁移；作品型三域 `savedAt_id`/`groupId_savedAt_id`/`groupId_uid_sort` 复合索引；`*_groups.count` 派生计数随 putBatch/deleteBatch/clear 同事务维护）；`readIndexPage` keyset 翻页（prev 取 limit+1 探测）/`scanIndexKeys`（keyCursor 只读索引键，不物化记录值）/`patchBatch`（单事务字段补丁：get→mergeFn→put，update-only，分页键变化才 bump rev）/`getGroupsWithStats`（只读 groups 小表），API 全集见文件 |
| `DomainStore`          | `data/domain-store.js`       | 域存储封装：`storeName`/`groupsName`/`toStorageId`/`facade`；`mergeWork`（uid/createTime/savedAt/groupId 类型归一化——作者数索引硬前提）；`mergeAndSave`（三作品型域通用）/ `patchWorks`（同步 checkpoint 专用：单事务 update-only，旧记录缺失跳过、内容无变化跳过）/ `mergeAndSaveAuthors`（作者域 followings/candidates，计数保护 + 丢失检测键集）——除补丁外均做**真实变更检测**：内容全等的重复入库不写库、不计入 `changed`（写入路径语义见 docs/10） |
| `DomainHandlers`       | `data/domain-handlers.js`    | 域数据操作入口（5 实例 works/followings/favorites/collections/candidates）；`save` 仅 `changed>0` 广播 `STORE_CHANGED`（`changed ≤ BROADCAST.UPSERTS_MAX` 附 point 载荷，`#saveAuthorRecords` 恒 bulk——作者域无单卡更新原语）、响应剔除 `written`/`addedIds` 防大批量保存响应膨胀；`get({ groupId, page, cursor, ascending, sort, direction })`（saved keyset / authorCount → `AuthorViews.readPage`；作者域单发全量）/`delete`/`move`（单事务只写 groupId 的字段补丁）/`getByIds`（bulk 收口补拉通道）；写入语义见 docs/10 |
| `AuthorViews`          | `data/author-views.js`       | 作者数排序视图：`groupId_uid_sort` 索引 `openKeyCursor` 只扫键 → `shared/author-view-core` 构建 `作者 → 有序 id` → SW 内存 LRU（`AUTHOR_VIEW_CACHE_MAX`）；`readPage` 校验 token/epoch/rev 后 `getBatch` 取页；空 uid 按 nickname 兜底；rev 变化返回 `VIEW_EXPIRED`、索引项与记录数不符返回 `AUTHOR_VIEW_INCOMPLETE`（options 降级 saved） |
| `TabBridge`            | `identity/tab-bridge.js`     | 抖音标签页查找/转发（`find`/`send`/`sendAsync`）；吸收 `GET_SECURITY_STATUS`/`FETCH_WORKS_PAGE` 非独立分支；`cancelActiveTask` 供 `CANCEL_TASK` 转发页面侧中断与 send 超时补发                    |
| `Groups`               | `data/groups.js`             | 分组 tab + 管理（域感知）；`getWithStats` 只读 `*_groups` 小表返回分组表与 count（计数由存储写入维护，O(分组数)）                                                                                                                            |
| `DataTools`            | `data/data-tools.js`         | 导入导出/重置/统计（域感知）；`reconcileImportGroups`；作品型三域导入登记 `importData` 任务坞长任务（校验后 start、先 ack 再落库、块边界 checkpoint、收尾裸 `STORE_CHANGED` + `TASK_DONE`）；分块导出会话（`#exportSessions`）/导入缓冲（`#importBuffers`），机制见 docs/10「分块传输」                                                                                                 |
| `ReviewHandlers`       | `data/review-handlers.js`    | 回顾引用域处理器：`get`（按组读引用并回源 hydration、清理失效引用）/`saveBatch`（整批替换）/`deleteBySource`/`moveBySource`；只改引用，不触碰来源域 |
| `RequestGate`          | `tasks/request-gate.js`      | 全局请求闸门：优先级队列（2=交互 / 1=任务）、串行 + 全局最小间隔、取消票据；所有独立模式请求与 Tab 任务循环共用一条车道 |
| `TaskRegistry`         | `tasks/task-registry.js`     | 长任务内存注册表：taskId/状态机/`exclusive` 全局单飞（+ 同域二次防御）/控制端口绑定（断开即取消）/终态快照；不做跨页恢复与续跑。全部 10 类 API 长任务共用 |
| `ScanTasks`            | `tasks/scan-tasks.js`        | Tab 模式长任务循环：全部登记 TaskRegistry 并发 `TASK_PROGRESS`/`TASK_DONE`——`syncWorks`/`fetchFollowing`（=`#paginate` 包装）/`#paginate`（关注·点赞·收藏三扫描统一 `createScanWriter` 分块确认写 + 终态丢失检测 + 终态 STORE_CHANGED）/`calibrateAll`+`calibrateStats`（批量校准）/`runCancelBatch`（批量取消并移除）/`importUserWorks`（注入 Tab 取页器）；另有短查询 `calibrateOne`/`resolveUserProfile`/`importCandidate`。双模共用壳驻留本文件：`runSyncWorks`（syncWorks 循环主体，注入 `fetchOne` 取详情器）/`runCancelTask`（批量取消循环主体，注入 `cancelOne`）/`startScanTask`/`makeScanReporter`/`finishScanTask`（扫描族首段/进度/收尾——异常收尾同函数，取消口径统一读 `isCancelled`，shape 区分 followings/works 两族载荷） |
| `createScanWriter`（函数） | `tasks/scan-tasks.js`    | 扫描分块确认写落库器（三扫描双模共用）：任务开始快照域键集、收集时全局下标分配 savedAt 戳、每 `SYNC.SCAN_CHUNK` 条单事务 upsert（`lost:false` 静默）、写后释放内存；`lostIds()` 结论写仅由完整扫描终态调用 |
| `createCancelWriter`（函数） | `tasks/scan-tasks.js`    | 取消任务分块确认删落库器（`runCancelBatch`/`cancel` 双模共用）：远端成功 id 进缓冲、满 `SYNC.SCAN_CHUNK` 条单事务 `deleteBatch` 静默删除、`deletedIds` 累计实删集；与 `createScanWriter` 确认写同构——失败/被杀已删块不回滚，无僵尸记录 |
| `createProbeQueue`（函数） | `grids/probe-queue.js`   | 媒体探针分帧队列共用壳（works 封面/author 头像/sidebar 封面三处）：rAF 预算出队 + `new Image()` 离屏探针 + alive 校验；代际自增与失败语义（重试一次/首字回退/占位兜底）由调用方注入，见 docs/11「媒体加载统一体系」 |
| `IndependentTasks`     | `tasks/independent-tasks.js` | 独立模式长任务：全部登记 TaskRegistry 并发 `TASK_PROGRESS`/`TASK_DONE`——`fetchFollowing`/`fetchCollection`（同一 `createScanWriter` 落库器，`runIndependentScan` 共用循环壳注入 `preflight`/`buildRequest`/`parsePage`/`errorMap`）/`syncWorks`/`importUserWorks`（注入直连取页器）/`cancel`（与 Tab `runCancelBatch` 共用 `runCancelTask` 循环壳）；短操作 `fetchWorksPage`/`setReaction` |
| `runAuthorWorksImport`（函数） | `tasks/author-works-import.js` | 作者作品入库双模共用循环壳：登记 TaskRegistry（`exclusive`）、BAD_PARAMS 守卫、重叠页去重防死循环、分块确认写（页结果进缓冲，满 `SYNC.SCAN_CHUNK` 条单事务 `mergeAndSave`，暂停/终态/异常冲刷）、全部批次结束后统一广播一次 `STORE_CHANGED` 裸载荷（`changed>0`，三族统一，**禁止移回循环内逐页发**）、`TASK_PROGRESS`/`TASK_DONE`、取消守卫；双模任务类各注入 `fetchPage(cursor, isCancelled)` 页取数器（细节见 docs/07） |
| `App`                  | `main.js`                    | 初始化（注册 `onInstalled`/`onStartup`/`onClicked`/`onConnect` + `setupDeclarativeNetRequest`）+ 消息路由 `route`（10 个启动消息透传 taskId 入队排队，队满由 `TaskRegistry.start` 返回 null 回 `QUEUE_FULL`；`SET_MODE`/`IMPORT_DATA`/`RESET_DOMAIN` 带 TaskRegistry BUSY 门禁——IMPORT_DATA 门禁同时保护传输分块，任务在末块之后才登记故不误拒自身；`CANCEL_TASK`/`GET_TASK_STATE`）  |

## 相关文档

| 编号 | 文档 | 关联内容 |
|------|------|----------|
| 01 | [01-project-architecture.md](./01-project-architecture.md) | 四层架构、代码布局约束、消息类型总表、配置项说明 |
| 07 | [07-independent-fetch-user-works.md](./07-independent-fetch-user-works.md) | `Sidebar`/`AuthorImport` 数据来源（FETCH_WORKS_PAGE 双模） |
| 10 | [10-storage-write-and-import.md](./10-storage-write-and-import.md) | `Storage`/`DomainStore`/`DomainHandlers` 写入语义 |
| 11 | [11-options-ui.md](./11-options-ui.md) | options 侧类模块的机制定案与渲染红线 |
| 13 | [13-design-red-lines.md](./13-design-red-lines.md) | 设计红线与知识点陷阱完整版（自 AGENTS.md 迁出） |
