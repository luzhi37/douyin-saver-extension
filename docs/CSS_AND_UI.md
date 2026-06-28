# CSS 与 UI 约定

> 本文档描述 `options/options.css` 的架构、VirtualGrid 渲染约定、弹窗/详情页/UI 组件的设计约定。

## 1. CSS 架构

`options/options.css` 约 1220 行，23+ 区块。

### 变量（`--dy-*` 命名空间）
- 背景：`--dy-bg: #161823` / `--dy-surface: #252632` / `--dy-surface-elevated: #2c2d3a`
- 强调：`--dy-primary: #fe2c55`（抖音粉，仅用于强调色，按钮不再使用）
- 文字：`--dy-text: #fff` / `--dy-text-secondary: #9a9a9a` / `--dy-text-muted: #7a7a8a`
- 边框：`--dy-border: #363744` / `--dy-border-light: #404153`
- 圆角：`--dy-radius: 8px`
- 阴影：`--dy-shadow` / `--dy-shadow-lg`
- 过渡：`--dy-transition: 0.2s cubic-bezier(0.4,0,0.2,1)`

### 按钮系统
- `.dy-btn` — 基础：`background: var(--dy-surface)` / `border: 1px solid var(--dy-border)` / `color: var(--dy-text)`
- `.dy-btn-ghost` — 透明背景，hover: `rgba(255,255,255,0.06)`（"批量"、"取消"等）
- `.dy-btn-primary` — **已改为 ghost 风格**：`background: transparent` / `border-color: var(--dy-border)`（"添加"、"好的"、"重试"等）
- `.dy-btn-danger` — 红色文字 `#ff4d6a`，hover 粉底（"删除"等）
- `.dy-btn-sm` — 小号：`padding: 4px 10px; font-size: 12px`

### 布局
- Top bar：固定 56px，flex 布局
- 内容区：`display: flex; flex: 1`，含 mainGrid + sidebar
- 分段控件（作品 | 关注）：active 状态 `rgba(255,255,255,0.12)` 浅色背景，无红色
- 作品网格容器：`.main-container`，`grid-template-columns: repeat(auto-fill, var(--dy-card-size))`，`justify-content: center`
- 关注网格容器：`.main-container`，`grid-template-columns: repeat(5, 1fr)`（`.domain-followings` 下）
- 侧边栏：固定 650px（snap point），可拖拽，折叠时 `width: 0 !important`（`.sidebar-zero`）
- 侧边栏作品网格：`repeat(3, 1fr)`，gap 6px，padding 8px
- 详情弹窗：全屏 fixed overlay，blur 背景，居中内容，键盘/触摸/滚轮导航

### 字体
- `@font-face` 加载本地 `assets/LXGWWenKai-Regular.ttf`
- `font-family` 在 `body` 上显式声明，备用链：系统中文字体 + sans-serif
- `input, textarea, select, button, optgroup` 强制 `font-family: inherit` 覆盖浏览器默认

### 动画
- `cardFadeIn` — 网格项淡入 + 上移（无 `forwards` fill-mode，动画结束后自然回到最终状态）
- `dialogIn` — 弹窗缩放
- `spin` — 旋转加载
- `shimmer` — 骨架屏伪元素 `transform: translateX()` GPU 合成动画（1.5s）

### 死类审计结论
已完整扫描 `options/options.css` 中全部 151 个类名，未发现未使用的 CSS 类。部分 HTML 类名（如 `delete-btn`、`import-added`、`stat-followers` 等）仅作为 JS 查询钩子，无对应 CSS 规则，属于正常设计。

## 2. 网格渲染优化（VirtualGrid）

- **VirtualGrid 基类：** `WorksGrid` / `FollowingsGrid` 共享骨架、IntersectionObserver、分块渲染、事件委托逻辑
- **Skeleton + IntersectionObserver：** 网格项先渲染骨架（`#workSkeletonTemplate` / `#followingSkeletonTemplate`），每 chunk 渲染后立即对新骨架建立 `IntersectionObserver`（`rootMargin: '400px'`），进入视口后 `populateItem()` 填充真实内容
- 关注卡片同样使用 skeleton（`following-skeleton`）
- `content-visibility: auto` 配合骨架实现延迟渲染
- 视频重试：`CONFIG.VIDEO_RETRY_DELAYS`，最多 3 次
- **事件委托：** 网格 click 事件委托到 `mainContainer`（`VirtualGrid.#onClick` 中绑定），通过 `e.target.closest('.' + this.#itemClass)` 匹配项，每项不再单独绑定 click 监听器
- **图片重试：** `thumb.onerror` 首次自动重试加载原 URL，失败后才显示占位符
- **Shimmer 骨架：** `.work-skeleton` / `.following-skeleton` 使用伪元素 `transform: translateX()` GPU 合成动画（1.5s 循环）
- **Hover 性能：** `.work-card` / `.following-card` 使用 `isolation: isolate`，hover 时不改变 `z-index`；checkbox/badge 移除 `backdrop-filter: blur()`
- `WorksGrid.updateCardDOM(awemeId)` 使用 `#worksMap.get(awemeId)` O(1) 查找，并支持在骨架尚未填充时直接 `populateItem()`
- **批量模式勾选状态同步（关键）：** 骨架卡片延迟填充为真实卡片时，`createItem` 必须同时同步两件事：
  1. 显示/隐藏：`checkbox.style.display = state.batchMode ? '' : 'none'`
  2. 选中状态：必须调用 `batch.updateCheckboxDOM(checkbox, state.selectedIds.has(id))`，**不能只设置 `innerHTML`**。因为 `.work-checkbox` / `.following-checkbox` 默认 `color: transparent`，没有 `checked` 类时勾号不可见。漏加 `checked` 类会导致“全选后滚动，新填充卡片看起来未被选中”的 Bug。

## 3. UI 设计约定

- 侧边栏 snap point 650px，仅两档：展开和折叠
- `secUid` 运行时从 `profileUrl.split('/user/')[1]` 解析，不持久化
- 导出按域类型分文件：`works-日期.json` / `followings-日期.json`（含 `groups`）
- 点赞/收藏取消弹窗：无进度条、无复选框、无全选按钮，一键取消所有未关注作品；右上角 X 全程可见，点击中止。取消按钮点击后显示 `.dy-btn-loading` 旋转圆圈（`::before` 伪元素，纯 CSS spinner）
- 弹窗模板全部使用 `<template>` 元素，无 JS 字符串拼接
- `.dy-btn-primary` **不使用红色**，改为 ghost 风格透明背景
- 弹窗布局复用公共 `.dy-dialog-*` 类，点赞/收藏弹窗无专用 `.fav-dialog-content` / `.fav-dialog-footer`
- 详情页初始 `#loopMode = 'single'`（单作品循环 / 幻灯片循环），用户点击按钮后会在 `single → group → off` 之间循环并保持到 session 结束
- 详情页图文（note）切图直接 `img.src = newSrc`，**无**淡入淡出动画（之前的 100ms 黑屏 setTimeout + `.detail-image-fade` class 已移除，避免闪烁）
- 顶层 `addEventListener` 与 IIFE `init()` 的分工：简单 DOM 事件绑定就近写在顶层（18 个），需要异步/启动顺序的（图标加载、`store.on` 注册、首屏 `loadDomainData`）才进 `init()`
- 批量操作局部更新：`Batch.deleteSelected/moveSelected` 成功后调用 `store.removeWorksSilent/removeFollowingsSilent` 静默更新 state，并调用 `worksGrid.removeItems/followingsGrid.removeItems` 直接操作 DOM，避免触发全量重建
- Detail 事件复用：详情页持久 DOM 监听器在 `Detail.initDetailEvents()` 中绑定一次，`renderDetail()` 不再反复拆装；切换作品时通过当前索引与 `getCurrentWork()` 分发
- Dialog 关闭：`showDialog` 接受可选 `onClose` 回调存入 `state.activeDialog`，关闭按钮调用 `state.activeDialog?.()` 后清除；各打开 dialog 的位置传入 onClose 回调（sync.closeSyncDialog、favorites 取消等）
- **短操作弹窗锁定**（`state.preventDialogClose`）：导入/导出/安全状态/分组管理/删除确认等短耗时操作，在异步开始前设 `state.preventDialogClose = true`，`try/finally` 中完成后解锁。长操作（同步/扫描）不走此路径，X 按钮始终可点以中止任务。详见下方 [弹窗关闭策略](#弹窗关闭策略)。
- Favorites 内部状态：`state.favoriteWorks` / `favoriteFetching` / `cancelingFavorites` 等 8 个字段仅 Favorites class 读写，不走 `store.set()` 响应式通知
- 命名约定：options 层按域区分命名，作品域使用 `work-*` / `WorksGrid`，关注域使用 `following-*` / `FollowingsGrid`，避免混用 `card`/`Cards`/`Following` 等歧义命名
- 安全状态面板布局：每个条目**两行**（状态行 `label + 状态·时间` + 值行 `值 + [展开/收起]` + hint 行），无单一独立状态行；`[展开/收起]` 靠右对齐（`.sec-expand-hint { margin-left: auto }`），密钥状态时间戳来自 inject.js 读取时刻（`Date.now()`），签名时间戳来自 `__captured*Query.__dyCaptureTime`

### 弹窗关闭策略

options.js 中弹窗分为两类，关闭行为不同：

| 类别 | 特点 | 关闭行为 | 涉及操作 |
|---|---|---|---|
| **短操作** | 秒级完成，用户期望看到结果 | 操作期间 X 按钮被 `state.preventDialogClose` 锁定，不可关闭；完成后自动解锁，用户可正常关闭 | 导入、导出、安全状态加载、分组管理加载、删除分组/批量删除/批量移动/移除作品/重置数据的确认按钮回调 |
| **长操作** | 分钟级，可能失败需重试 | X 按钮始终可点，点击后发送 `CANCEL_ACTIVE_TASK` 通过 background→content→inject 中止远端任务，清理本地状态后关闭 | 作品同步、关注同步、扫描点赞、扫描收藏 |

⚠ **`CANCEL_ACTIVE_TASK` 仅当 `state.activeDialog` 存在时发送**，短操作弹窗在 X 按钮 handler 中无 `activeDialog` 回调因此不发送取消信号。

短操作锁定模式（所有 11 处均使用 `try/finally` 保证解锁）：
```js
state.preventDialogClose = true;
try {
  // ... async work + showOkDialog() ...
} finally {
  state.preventDialogClose = false;
}
```
