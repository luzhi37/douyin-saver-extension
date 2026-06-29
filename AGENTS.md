> 本文件是面向 AI Agent 的项目速览与入口索引。**任何具体行为以源码为准。**
> 深度技术细节已拆分到 `docs/*.md`，见下方 [文档索引](#文档索引)。

# AGENTS.md — 抖音数据管理 (Douyin Data Manager)

## 项目性质

Chrome Manifest V3 扩展，统一管理抖音作品、关注、点赞与收藏数据。
**纯原生 JS，无构建工具、无 npm、无 package.json、无 bundler。** 不要尝试 `npm install` 或 `npm run dev`。

## 文件结构

```
manifest.json
background/
  background.js          — Service Worker（ES Module）
  storage.js             — IndexedDB 封装层
content/
  content.js             — 隔离世界桥接层
  inject.js              — 主世界脚本
options/
  options.css            — 样式（~1500 行）
  options.html           — 管理页面
  options.js             — 全部 View 逻辑（VirtualGrid 基类 + 11 个业务 class）
assets/
  LXGWWenKai-Regular.ttf — 楷体字体
  icon16.png / icon48.png / icon128.png
docs/                    — 深度技术文档（见索引）
```

## 加载顺序

options.html 只加载一个脚本：
```html
<script src="options.js"></script>
```

options.js 内部从上到下：
1. `config` 常量对象
2. `dom` 对象 — 常用 DOM 引用
3. `state` 对象 — 可变应用状态
4. `store` 对象 — 响应式事件系统
5. `utils` 工具函数
6. `services` 业务服务
7. 12 个 class 定义并立即实例化
8. `chrome.runtime.onMessage` 监听器
9. 顶层函数与 DOM 事件绑定
10. IIFE `init()` — 异步启动、响应式监听、首屏数据

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
|---|---|---|
| 数据操作 | `SAVE_WORKS` / `GET_WORKS` / `DELETE_WORKS` / `MOVE_WORKS` / `SYNC_WORKS` / `GET_WORK` / `SAVE_FOLLOWINGS` / `GET_FOLLOWINGS` / `DELETE_FOLLOWINGS` / `MOVE_FOLLOWINGS` |
| 分组管理 | `GET_GROUPS` / `ADD_GROUP` / `RENAME_GROUP` / `DELETE_GROUP` / `REORDER_GROUPS` |
| 工具 | `IMPORT_DATA` / `EXPORT_DATA` / `RESET_DOMAIN` / `GET_STATS` / `GET_SECURITY_STATUS` |
| 扫描入口 | `FETCH_FOLLOWING` / `FETCH_FAVORITES` / `FETCH_COLLECTION` — options.js 触发 background 的循环扫描；background 内逐页请求后透传进度 |
| 取消入口 | `CANCEL_LIKE` / `CANCEL_COLLECTION` — options.js 触发 background 的批量取消；background 内部循环后逐条派发 `CANCEL_ONE_*` 到 inject |
| 取消信号 | `CANCEL_ACTIVE_TASK` — 从 options 经 background→content→inject 触发 `activeTask.abort()`；仅在长操作弹窗（同步/扫描）关闭时发送，短操作弹窗不发送（无 `state.activeDialog` 时不发送） |
| Tab 转发（background→tab） | `FETCH_SINGLE_WORK` / `FETCH_FOLLOWING_PAGE` / `FETCH_FAVORITES_PAGE` / `FETCH_COLLECTION_PAGE` / `CANCEL_ONE_LIKE` / `CANCEL_ONE_COLLECTION` / `FETCH_WORKS_PAGE` / `GET_SECURITY_STATUS` |
| 进度消息 | `SYNC_PROGRESS` / `FOLLOWING_PROGRESS` / `FAVORITES_PROGRESS` / `COLLECTION_PROGRESS` / `CANCEL_PROGRESS` / `CANCEL_DONE` — 由 background 循环 handler 直接发出到 options，不再经 content.js 转发 |

**长任务链路模式**：
- `sendToTab`：background 生成 `requestId`，向抖音标签页发消息，等待超时 `CONFIG.TIMEOUT.REQUEST`（默认 30s，`GET_SECURITY_STATUS` 5s）。`sendToTab` 内部 `.catch()` 处理 `withDouyinTab()` 极端异常路径。
- `sendToTabAsync`：`sendToTab` 的 Promise 封装，用于 background 循环 handler 中逐条/逐页请求（`SYNC_WORKS`、`FETCH_FOLLOWING`、`FETCH_FAVORITES`、`FETCH_COLLECTION` 的 background 循环均使用此模式）。
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
| `SecurityStatus` | 安全状态面板 |
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
- **取消点赞/收藏用 XHR 而非 fetch** — 抖音的 a_bogus 签名与 XHR 原型链深度绑定。
- **短操作弹窗锁定** — `state.preventDialogClose = true` + `try/finally` 解锁；长操作 X 按钮始终可点以发送 `CANCEL_ACTIVE_TASK`。为避免短操作误发，`CANCEL_ACTIVE_TASK` 仅当 `state.activeDialog` 存在时发送。
- **API 请求统一用 `window.fetch` + save/restore** — inject.js 的 6 个 API 请求函数全部使用 `window.fetch`（经 Fetch Hook），而非 `origFetch.call(window, ...)`（绕 Hook）。因为 Douyin 可能通过覆盖 `window.fetch` 注入签名参数，走 `origFetch` 会错过注入。代价是 Hook 的 `captureFromUrl` 会污染缓存，因此在每个监听器内用 save/restore 模式在 `finally` 中恢复缓存变量。详见 [docs/FETCH_AND_CACHE.md](./docs/FETCH_AND_CACHE.md)。

> CSS、VirtualGrid、弹窗关闭策略、UI 约定见 [docs/CSS_AND_UI.md](./docs/CSS_AND_UI.md)。

## config 分组速查

`options/options.js` 顶层 `config` 常量（29 个键。`background.js` 另有 `CONFIG` 含 `TIMEOUT` / `DELAY` / `SYNC` / `STORAGE_KEYS` / `DNR` / `GROUPS` 等）：

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
| 抖音 URL | `URLS` `{ BASE, USER_SELF, LIKE_TAB, COLLECTION_TAB, FOLLOWING_TAB }` |
| 正则/图标 | `SEC_UID_REGEX` `/^\/user\/([^/?]+)/` / `icons` `{}`（init 填充） |

## 文档索引

| 文档 | 阅读场景 |
|---|---|---|
| [docs/SYNC_AND_SCAN.md](./docs/SYNC_AND_SCAN.md) | 作品同步、关注同步、点赞/收藏扫描、取消点赞/收藏、作者主页分页的完整链路与时序 |
| [docs/INJECT_INTERNALS.md](./docs/INJECT_INTERNALS.md) | inject.js 数据提取、签名捕获与缓存、fetch/XHR Hook、安全密钥获取 |
| [docs/FETCH_AND_CACHE.md](./docs/FETCH_AND_CACHE.md) | window.fetch 与 origFetch 的抉择、save/restore 缓存保护机制、六类 API 请求对比 |
| [docs/STORAGE_AND_MERGE.md](./docs/STORAGE_AND_MERGE.md) | IndexedDB 结构、作品合并、关注丢失检测、导入分组去重合并 |
| [docs/SECURITY_AND_DNR.md](./docs/SECURITY_AND_DNR.md) | declarativeNetRequest 规则、安全状态查询链路、安全风险 |
| [docs/CSS_AND_UI.md](./docs/CSS_AND_UI.md) | CSS 架构、VirtualGrid 渲染约定、弹窗/详情页/UI 约定 |
| [docs/VUE_REFACTOR_EVALUATION.md](./docs/VUE_REFACTOR_EVALUATION.md) | Vue 重构可行性评估（不进版本控制） |

## 验证

- 语法检查：`node --check background/background.js content/content.js content/inject.js options/options.js`
- 实机测试：在 `chrome://extensions` 开启开发者模式 → 重新加载
