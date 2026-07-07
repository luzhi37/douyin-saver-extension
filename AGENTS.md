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

- `works` — `{ [awemeId]: Work }`
- `works_groups` — `[{ id, name, fixed, order? }]`
- `followings` — `{ [uid]: Following }`（仅保留 5 个稳定字段）
- `followings_groups` — `[{ id, name, fixed, order? }]`

## 消息协议

background.js switch 分发所有 `chrome.runtime.sendMessage`。

| 类别 | 消息类型 |
|---|---|
| 数据操作 | `SAVE_WORKS` / `GET_WORKS` / `DELETE_WORKS` / `MOVE_WORKS` / `SYNC_WORKS` / `GET_WORK` / `SAVE_FOLLOWINGS` / `GET_FOLLOWINGS` / `DELETE_FOLLOWINGS` / `MOVE_FOLLOWINGS` |
| 分组管理 | `GET_GROUPS` / `ADD_GROUP` / `RENAME_GROUP` / `DELETE_GROUP` / `REORDER_GROUPS` |
| 工具 | `IMPORT_DATA` / `EXPORT_DATA` / `RESET_DOMAIN` / `GET_STATS` / `GET_SECURITY_STATUS` |
| 扫描入口 | `FETCH_FOLLOWING` / `FETCH_FAVORITES` / `FETCH_COLLECTION` — options.js 触发 background 的循环扫描；background 内逐页请求后透传进度 |
| 取消入口 | `CANCEL_LIKE` / `CANCEL_COLLECTION` — options.js 触发 background 的批量取消；tab 模式下逐条派发 `CANCEL_ONE_*` 到 inject；独立模式下由 `handleIndependentCancel` 直接在 background 循环 POST |
| 取消信号 | `CANCEL_ACTIVE_TASK` — tab 模式下经 options→background→content→inject 触发 `activeTask.abort()`；独立模式下直接在 background 取消循环；仅在长操作弹窗关闭时发送（无 `state.activeDialog` 时不发送） |
| Tab 转发（background→tab） | `FETCH_SINGLE_WORK` / `FETCH_FOLLOWING_PAGE` / `FETCH_FAVORITES_PAGE` / `FETCH_COLLECTION_PAGE` / `CANCEL_ONE_LIKE` / `CANCEL_ONE_COLLECTION`（tab 模式下经 content→inject；独立模式下由 background 直接 POST） / `FETCH_WORKS_PAGE`（独立模式下由 background 直接处理） / `GET_SECURITY_STATUS` |
| 进度消息 | `SYNC_PROGRESS` / `FOLLOWING_PROGRESS` / `FAVORITES_PROGRESS` / `COLLECTION_PROGRESS` / `CANCEL_PROGRESS` / `CANCEL_DONE` — 由 background 循环 handler 直接发出到 options，不再经 content.js 转发 |

**长任务链路模式**：
- `sendToTab`：background 生成 `requestId`，向抖音标签页发消息，等待超时 `CONFIG.TIMEOUT.REQUEST`（默认 30s，`GET_SECURITY_STATUS` 5s）。`sendToTab` 内部 `.catch()` 处理 `withDouyinTab()` 极端异常路径。
- `sendToTabAsync`：`sendToTab` 的 Promise 封装，用于 background 循环 handler 中逐条/逐页请求（`SYNC_WORKS`、`FETCH_FOLLOWING`、`FETCH_FAVORITES`、`FETCH_COLLECTION` 的 background 循环均使用此模式；独立模式下 `CANCEL_LIKE`/`CANCEL_COLLECTION` 由 `handleIndependentCancel` 在 background 内直接循环，不走此路径）。
- `requestResponse`：content.js **先 `addEventListener(resultEvent)` 再 `dispatchEvent(requestEvent)`**，消除同步 handler 的 `setTimeout(0)` workaround 需求。

> 同步/扫描/取消的完整链路、时序差异、分页参数见 [docs/SYNC_AND_SCAN.md](./docs/SYNC_AND_SCAN.md)。

## 响应式状态管理

`store.on()` 监听事件：

| 事件 | 处理 |
|---|---|
| `'domain'` | 更新同步按钮、渲染分组 tab、加载域数据（`currentGroupId` 由 `switchDomain` 直接赋 `'all'` 而非通过事件） |
| `'works'` | `worksGrid.renderCards()`（仅 domain=works） |
| `'followings'` | `followingsGrid.renderFollowingCards()`（仅 domain=followings） |
| `'groups'` | `groups.renderGroupTabs()` |
| `'currentGroupId'` | `groups.renderGroupTabs()` + 加载域数据 |
| `'batchMode'` | toggle body `.batch-mode` class |
| `'work-updated'` | `worksGrid.updateCardDOM(awemeId)` + 若详情打开则重渲染 |

## Class 职责概览

| Class | 职责 |
|---|---|
| `VirtualGrid` | 网格渲染基类（骨架 + IntersectionObserver + 分块渲染 + 事件委托） |
| `Dialog` | 弹窗管理 |
| `FollowingsGrid` | 关注卡片网格 |
| `Groups` | 分组 tab + 管理 |
| `Batch` | 批量操作（勾选、全选、删除、移动） |
| `ImportExport` | 导入导出 |
| `Sidebar` | 侧边栏（作者作品分页） |
| `Sync` | 同步状态机（作品/关注） |
| `Favorites` | 点赞/收藏扫描与取消 |
| `WorksGrid` | 作品卡片网格 |
| `Detail` | 详情播放器 |

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
- **短操作弹窗锁定** — `state.preventDialogClose = true` + `try/finally` 解锁；长操作 X 按钮始终可点以发送 `CANCEL_ACTIVE_TASK`。为避免短操作误发，`CANCEL_ACTIVE_TASK` 仅当 `state.activeDialog` 存在时发送。
- **API 请求统一用 `window.fetch` + `_dyInternal` 标志** — inject.js 的 6 个 API 请求函数全部使用 `window.fetch`（经 Fetch Hook），通过 `_dyInternal: true` 避免被 Hook 再次捕获，而非 `origFetch.call(window, ...)`（绕 Hook）。因为 Douyin 可能通过覆盖 `window.fetch` 注入签名参数，走 `origFetch` 会错过注入。详见 [docs/FETCH_AND_CACHE.md](./docs/FETCH_AND_CACHE.md)。

## config 分组速查

`options/options.js` 顶层 `config` 常量（29 个键。`background.js` 另有 `CONFIG` 含 `TIMEOUT` / `DELAY` / `SYNC` / `STORAGE_KEYS` / `DNR_RULES` / `GROUPS` / `PAGE` / `TOKEN_TTL` / `CANCEL` / `FATAL_ERRORS` / `WEBID_API` 等）：

| 分组 | 键 |
|---|---|
| 视频重试 | `VIDEO_RETRY_DELAYS` `[200,400,600]` / `VIDEO_RETRY_MAX` `3` / `VIDEO_RETRY_FALLBACK_DELAY` `1000` |
| 超时 | `FETCH_RETRY_DELAY` `1000` / `SYNC_TIMEOUT` `30000` / `VIDEO_FALLBACK_TIMEOUT` `5000` |
| 详情页 | `DETAIL_TITLE_MAX_LEN` `40` / `TOAST_DURATION` `2000` / `DOWNLOAD_MAX_RETRY` `1` |
| UI 延迟 | `HOVER_PREVIEW_DELAY` `200` / `BLOB_REVOKE_DELAY` `10000` / `NOTE_AUTO_PLAY_INTERVAL` `3000` |
| 侧边栏 | `SIDEBAR_SNAP_POINTS` `[650,0]` / `SIDEBAR_SCROLL_THRESHOLD` `100` / `SIDEBAR_MIN_WIDTH` `80` / `SIDEBAR_FILL_THRESHOLD` `50` |
| 网格项尺寸 | `CARD_SIZE_FALLBACK` `261` / `CARD_GAP` `9` / `CARD_HEIGHT_OFFSET` `35` |
| 分块渲染 | `RENDER_CHUNK_SIZE` `50` / `OBSERVER_ROOT_MARGIN` `'400px'` / `CARD_FILL_MAX_CONCURRENT` `12` |
| 分组/存储 | `GROUP_NAME_MAX_LEN` `20` / `STORAGE_MAX_BYTES` `10MB` / `TRASH_GROUP_NAME` `'稍后删除'` |
| Tab 滚动 | `TAB_SCROLL_THRESHOLD` `2` |
| 抖音 URL | `URL_BASE` / `URL_USER_SELF` / `URL_LIKE_TAB` / `URL_COLLECTION_TAB` / `URL_FOLLOWING_TAB` |
| 正则/图标 | `SEC_UID_REGEX` `/^\/user\/([^/?]+)/` / `icons` `{}`（init 填充） |

## 文档索引

| 文档 | 阅读场景 |
|---|---|
| [docs/SYNC_AND_SCAN.md](./docs/SYNC_AND_SCAN.md) | 作品同步、关注同步、点赞/收藏扫描、取消点赞/收藏、作者主页分页的完整链路与时序 |
| [docs/INJECT_INTERNALS.md](./docs/INJECT_INTERNALS.md) | inject.js 数据提取、签名捕获与缓存、fetch/XHR Hook、安全密钥获取 |
| [docs/FETCH_AND_CACHE.md](./docs/FETCH_AND_CACHE.md) | window.fetch 与 origFetch 的抉择、save/restore 缓存保护机制、六类 API 请求对比 |
| [docs/STORAGE_AND_MERGE.md](./docs/STORAGE_AND_MERGE.md) | IndexedDB 结构、作品合并、关注丢失检测、导入分组去重合并 |
| [docs/SECURITY_AND_DNR.md](./docs/SECURITY_AND_DNR.md) | declarativeNetRequest 规则、安全状态查询链路、安全风险 |
| [docs/INDEPENDENT_MODE.md](./docs/INDEPENDENT_MODE.md) | 独立模式架构 + msToken/webId/Cookie/浏览器特征缓存模型与存储键表 |
| [docs/TIKTOK_REFERENCE.md](./docs/TIKTOK_REFERENCE.md) | 参考项目 TikTokDownloader 算法/凭据模块 + Douyin API 端点总表 |
