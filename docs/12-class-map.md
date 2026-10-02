# 12 · 类职责总表（options 侧 + background 侧）

> 本文自 AGENTS.md「Class 职责概览」迁出（2026-10-03 瘦身）。AGENTS.md 保留分层架构图与规则红线，本册承载两侧类模块的职责对照表，与源码同步维护。
> 术语规范见 01：**Tab模式**=页面注入脚本方式；**独立模式**=纯后台逆向请求流程。

## options/ 侧类模块

| Class            | 职责                                                              |
|------------------|-------------------------------------------------------------------|
| `SearchBar`      | 搜索/筛选子系统（数据层视图 getWorksView/getFollowingsView + 检索状态 `#searchState`；三段视图缓存 `#viewCache` + `state.dataVersion` 失效判据 + 恒等快速路径，见 docs/11「视图阶段缓存与筛选切换性能」；归属判定与收起即重置见 docs/11「SearchBar」） |
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
| `Detail`         | 详情播放器（对齐抖音播放界面：全宽播放器、.media-view 宽度随媒体宽高比自适应、双形态进度条、⌃⌄ 作品切换胶囊、计数 K 可编辑跳转；定案见 docs/11） |
| `AppShell`       | 应用壳（域切换滑块 switchDomain/updateDomainSlider、全局错误态 renderErrorState、弹窗关闭统一入口 requestDialogClose；事件构造器内自绑定） |

## background/ 类单例（按职责分模块，与 options 侧类模块同构）

| 类 / 对象              | 文件                         | 职责                                                                                                                                                  |
|------------------------|------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------|
| `runtimeConfig` (对象) | `core.js`                    | 运行时配置：从 `chrome.storage.local` 读入叠加进 `CONFIG`（`KEY`/`DEFAULTS`/`load`/`apply`/`reload`/`delayRange`）；校准开关写入 `IndependentClient`；SW 冷启动补 reload 恢复运行参数 |
| `utils` (对象)         | `core.js`                    | 纯函数集：`parseExpire` / `urlExpireAt` / `isLongLivedVideoUrl` / `extractMsTokenFromCookie` / `asyncHandler` / `sendSyncDone`                         |
| `formatters` (对象)    | `core.js`                    | `formatWork` / `formatFollowing` / `formatFollowingFromProfile`                                                                                       |
| `Crypto` (静态)        | `identity/crypto.js`        | 哈希/解析工具静态类：`md5Hex`（Argus webSign）/ `parseCookieToPairs` / `generateRandomMsToken`                                                        |
| `ABogus`               | `identity/crypto.js`        | a_bogus 签名算法类（按 UA/浏览器特性实例化，`Credentials.ensureABogus` 使用）；同文件导出 `MSSDK_STR_DATA`（mssdk 兑换载荷）                          |
| `Credentials`          | `identity/credentials.js`    | 客户端凭据/签名：`ensureABogus`/`getClockSkew`/`buildBaseParams`/`getMsToken`/`refreshWebIdChain`；吸收凭据类消息（见 [01](./01-project-architecture.md)「消息类型总表」工具行） |
| `IndependentClient`    | `identity/independent-client.js` | 独立模式开关/校准开关 + 签名直连 `request` + `resolveSelfSecUid`（内含 `resolveSecUidById` 兑换）；`request` 经 `credentials` 跨类取签名/时钟/msToken |
| `Storage`              | `data/storage.js`           | IndexedDB 封装层（单例连接 `#db`，DB v5：无改名迁移代码——低版本旧库升级前须先在旧版导出备份；作品型三域 `savedAt_id`/`groupId_savedAt_id` 复合索引 + 升级回填缺失 savedAt/groupId）；`readIndexPage` keyset 翻页（prev 取 limit+1 探测），API 全集见文件 |
| `DomainStore`          | `data/domain-store.js`       | 域存储封装：`storeName`/`groupsName`/`toStorageId`/`facade`；`mergeWork`；`mergeAndSave`（三作品型域通用）/ `mergeAndSaveFollowings`（计数保护）——两者均做**真实变更检测**：内容全等的重复入库不写库、不计入 `changed`（写入路径语义见 docs/10） |
| `DomainHandlers`       | `data/domain-handlers.js`    | 域数据操作入口（4 实例 works/followings/favorites/collections）；`save` 仅 `changed>0` 广播 `STORE_CHANGED`（`changed ≤ BROADCAST.UPSERTS_MAX` 附 point 载荷，`#saveFollowings` 恒 bulk——followings 无单卡更新原语）、响应剔除 `written`/`addedIds` 防大批量保存响应膨胀；`get`（keyset 游标翻页，无参一次性全量）/`delete`/`move`/`getByIds`（bulk 收口补拉通道）；写入语义见 docs/10 |
| `TabBridge`            | `identity/tab-bridge.js`     | 抖音标签页查找/转发（`find`/`send`/`sendAsync`）；吸收 `CANCEL_ACTIVE_TASK`/`GET_SECURITY_STATUS`/`FETCH_WORKS_PAGE` 非独立分支                    |
| `Groups`               | `data/groups.js`             | 分组 tab + 管理（域感知）                                                                                                                            |
| `DataTools`            | `data/data-tools.js`         | 导入导出/重置/统计（域感知）；`reconcileImportGroups`                                                                                                 |
| `ScanTasks`            | `tasks/scan-tasks.js`        | Tab 模式长任务：同步/扫描/取消/校准循环（含 `persistScan` 落库）；`importUserWorks`（注入 Tab 取页器）/`importFollowing`（含 `#fetchProfileUser` 双模档案取数） |
| `IndependentTasks`     | `tasks/independent-tasks.js` | 独立模式长任务：`fetchFollowing`/`fetchCollection`/`syncWorks`/`fetchWorksPage`/`importUserWorks`（注入直连取页器）/`cancel`                                            |
| `runAuthorWorksImport`（函数） | `tasks/author-works-import.js` | 作者作品入库双模共用循环壳：BAD_PARAMS 守卫、重叠页去重防死循环、逐页 `mergeAndSave` 落库、全部批次结束后统一广播一次 `STORE_CHANGED`（轻量 id 集，**禁止移回循环内逐页发**）、`IMPORT_WORKS_PROGRESS`、取消守卫；双模任务类各注入 `fetchPage(cursor)` 页取数器（细节见 docs/07） |
| `App`                  | `main.js`                    | 初始化（注册 `onInstalled`/`onStartup`/`onClicked` + `setupDeclarativeNetRequest`）+ 消息路由 `route`（`SET_MODE` 调 `independentClient.setMode`）  |

## 相关文档

| 编号 | 文档 | 关联内容 |
|------|------|----------|
| 01 | [01-project-architecture.md](./01-project-architecture.md) | 四层架构、代码布局约束、消息类型总表、配置项说明 |
| 07 | [07-independent-fetch-user-works.md](./07-independent-fetch-user-works.md) | `Sidebar`/`AuthorImport` 数据来源（FETCH_WORKS_PAGE 双模） |
| 10 | [10-storage-write-and-import.md](./10-storage-write-and-import.md) | `Storage`/`DomainStore`/`DomainHandlers` 写入语义 |
| 11 | [11-options-ui.md](./11-options-ui.md) | options 侧类模块的机制定案与渲染红线 |
