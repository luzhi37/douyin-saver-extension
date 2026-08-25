# 11 · 管理页渲染与交互（options.js）

> 职责边界：options.js 的渲染与交互子系统机制——VirtualGrid 双向虚拟化、Sidebar 升降级虚拟化、媒体加载统一体系与全局熔断、悬停预览事件委托、批量勾选 DOM 约定、弹窗锁定与取消门控、CSS 协同约定。数据流与消息协议见 [01](./01-project-architecture.md)；写入语义见 [10](./10-storage-write-and-import.md)；抖音页面注入侧见 [09](./09-inject-tab-mode.md)。

## 概述

管理页要在单页内承载数千张卡片与条目，渲染层的一切设计都围绕两个约束：**不换根节点**（任何 grid 直接子节点被替换都触发 Blink 全量重排，成本随卡片总数线性增长）与**媒体生命周期显式管理**（探针先行、代际防乱序、全局熔断）。本文收录各子系统的机制定案与历史踩坑结论，改动前先读对应小节的"禁止"条款。

## 核心流程图（文字描述）

### VirtualGrid 渲染管线（双向虚拟化 + 分圈观察）

```
render(items)
  → 容器 wipe（render()/abortRender() 重置时必须同时清 #pendingSkeletons / #sentinelCard / observers）
  → 骨架分块创建（RENDER_CHUNK_SIZE）
  → 新骨架进 #pendingSkeletons 队列；每次只把最靠前 OBSERVE_CHUNK_SIZE 个交给填充 IO
  → 圈尾哨兵 #sentinelCard 进入 OBSERVER_ROOT_MARGIN 时 #extendObservation 放下一批
      （原因：IO 回调的 computeIntersections 成本随已观察目标数线性，
        全量 observe 2000 卡时滚动期每帧重算 O(全部卡) 次几何——trace 实测 1.2s/5s）

骨架进入视口（OBSERVER_ROOT_MARGIN '200px'）→ #enqueueFill 入队
  → rAF 分帧填充：每帧最多花 FILL_FRAME_BUDGET_MS(8ms) 即让出主线程
  → populateItem 原地构建完整卡 → fill observer 转 observe 完整卡

完整卡滚出 UNLOAD_ROOT_MARGIN('1200px') → #demote 原地降级回骨架
  （卸载圈远大于填充圈形成滞回，勿把两者调近；#demote 重 observe 走直连路径不经队列）
```

### Sidebar 条目升降级生命周期

```
翻页结果 → 整页 DOM 用单个 fragment 追加
  #createWorkItem 只把 {url, cover, placeholder} 挂进 #workMeta（WeakMap），不发探针
条目进入视口（observer root=dom.sidebarBody, rootMargin=OBSERVER_ROOT_MARGIN）
  → #promoteItem：#enqueueCover 入队 → 每帧 SIDEBAR_IMG_PER_FRAME 张 rAF 发探针+绘制
滚出卸载圈（UNLOAD_ROOT_MARGIN）→ #demoteItem：
  cover.dataset.gen 自增作废在途探针 → 清背景图 → 恢复占位层（根不换，aspect-ratio 保尺寸）
重新滚近 → 重入新代探针（旧回调经 gen 校验后作废）
```

## 接口 / 方法签名

```js
// VirtualGrid（基类）
render(items) / abortRender()                 // 后者同时清空 observer 与分圈队列状态
removeItems(idSet)                            // 删除哨兵会断链，调用方必须立刻续接
#extendObservation()                          // 哨兵触发时放下一批 OBSERVE_CHUNK_SIZE 个
#enqueueFill(card) → #scheduleDrain → #doFill // 时间预算制填充分帧
populateItem(skeleton, item)                  // 原地填充入口；负责 observe 完整卡（交接点）
#demote(card)                                 // 原地降级回骨架；fill observer 重新 observe
fillCard(card, item) / clearCard(card)        // 子类钩子：只允许改类名与增删根节点后代

// WorksGrid / FollowingsGrid
renderCards() / renderFollowingCards()
updateCardDOM(awemeId)                        // 兼容骨架态：骨架只更新数据，完整卡原地重填
#bindMediaEvents()                            // pointerover/out 容器级委托（见下文）

// Sidebar
openSidebar(following) / #loadMoreWorks()     // 触发 FETCH_WORKS_PAGE（见 07）
#createWorkItem / #promoteItem / #demoteItem / #enqueueCover / #scheduleImgDrain

// Batch / Detail / Sync
Batch.updateCheckboxDOM(checkboxEl, isSelected)
Batch.handleBatchSelectAll()                  // 按域选择 checkbox 选择器
Detail.markMediaFail() / markMediaOk() / mediaRetryBlocked()
Detail.#scheduleCoverDrain / #showAvatarFallback / #imgProbeToken
Sync.#followingsRequestId                     // 关注进度过滤（可 === null）
```

## 关键代码片段

### 时间预算制填充（禁止改回固定张数/帧）

```js
#scheduleDrain() {
  if (this.#drainRafId) return;
  this.#drainRafId = requestAnimationFrame(() => {
    this.#drainRafId = 0;
    // 时间预算制：每帧最多花 FILL_FRAME_BUDGET_MS 填卡即让出主线程，
    // 避免首屏集中填充时单帧超预算（固定张数在低端机上仍会卡）
    const deadline = performance.now() + config.FILL_FRAME_BUDGET_MS;
    while (this.#fillQueue.length && performance.now() < deadline) {
      this.#doFill(this.#fillQueue.shift());
    }
    if (this.#fillQueue.length) this.#scheduleDrain();
  });
}
```

### Sidebar 观察器对与升降级（root 必须显式传 dom.sidebarBody）

```js
// 观察圈以 sidebarBody 为 root（rootMargin 相对滚动容器自身矩形展开，不受祖先裁剪抵消；
// 用 null root 会被祖先裁剪抵消导致预填失效）
new IntersectionObserver(cb, { root: dom.sidebarBody, rootMargin: config.OBSERVER_ROOT_MARGIN })

#demoteItem(item) {
  const meta = this.#workMeta.get(item);
  if (!meta || !meta.url) return;
  meta.cover.dataset.gen = String((Number(meta.cover.dataset.gen) || 0) + 1); // 作废在途探针
  meta.cover.style.backgroundImage = "";
  meta.placeholder.style.display = "";
  this.#sideUnloadObs.unobserve(item);
  this.#sideFillObs.observe(item);          // 根节点不换，尺寸由 aspect-ratio 保持
}
```

> `.sidebar-work-item` 上**不要加 `content-visibility: auto`**：媒体生命周期已由显式升降级管理，降级后子树为空，CV 只剩相关状态切换的每帧 Layerize 抖动（实测占滚动风暴 CPU 约三成）。

### 批量勾选 DOM 约定

```js
updateCheckboxDOM(checkboxEl, isSelected) {
  if (isSelected) {
    checkboxEl.classList.add("checked");     // 手动设 innerHTML 只能显示图标，
    checkboxEl.innerHTML = (config.icons && config.icons.check) || ""; // 缺 checked 类则透明不可见
  } else {
    checkboxEl.classList.remove("checked");
    checkboxEl.textContent = "";
  }
  checkboxEl.setAttribute("aria-checked", isSelected ? "true" : "false");
}

handleBatchSelectAll() {
  const selector = state.domain === "followings" ? ".following-checkbox" : ".work-checkbox"; // 必须按域选择
  …
}
```

### 悬停预览事件委托（禁用 pointerenter/leave）

```js
#bindMediaEvents() {
  // pointerenter/leave 不冒泡、无法做容器级委托；用冒泡的 pointerover/out，
  // relatedTarget 仍在同一 .work-media 内部时忽略，实现"跨界只触发一次"
  this.#container.addEventListener("pointerover", (e) => {
    const media = e.target.closest?.(".work-media");
    if (!media) return;
    if (e.relatedTarget && media.contains(e.relatedTarget)) return;
    …
    if (state.batchMode) return;
    if (!dom.dialogOverlay.classList.contains("hidden")) return;
    if (detail.mediaRetryBlocked()) return;   // 熔断冷却期不启动预览
```

enter/leave 不冒泡——挂在 grid 容器上的监听器只有 target 是容器自身时才触发，卡片上的进入事件永远收不到（功能**静默失效**）。换卡时必须先静音旧预览再判守卫，否则旧视频音频残留。

### 头像探针的代际校验（在途回调先验代际再提交）

```js
probe.onload = () => {
  if (!this.#avatarTargetAlive(img, gen)) return; // 已重填/降级，结果作废
  img.style.backgroundImage = `url("${url.replace(/["\\]/g, "\\$&")}")`;
  img.classList.remove("media-loading");
  detail.markMediaOk();
};
probe.onerror = () => {
  if (!this.#avatarTargetAlive(img, gen)) return;
  detail.markMediaFail();
  … this.#showAvatarFallback(img, …);
};
```

## 子系统机制定案

### 媒体加载统一体系（div + background-image，禁止改回 `<img src>`）

四个槽位 `.following-avatar` / `.work-thumb` / `.sidebar-work-cover` / `.fav-work-thumb` 全是 `<div role="img">`；唯一例外是详情大图 `#detailImage`（依赖 object-fit:contain 与淡入过渡，保留 `<img>` + 探针）。验收标准：`grep '<img'` 模板应只剩详情大图与图标 `<use>`。背景图加载失败时浏览器不绘制任何占位图标——原生断裂图在元素层面失去载体，这是历史三轮"切换/滚动时瞬态裂图"报告的根治手段。

加载统一走离屏 `new Image()` 探针先行，成功才提交 `style.backgroundImage`，死链在探针阶段终结。各槽位失败语义：

| 槽位 | 探针调度 | 失败处理 |
|------|----------|----------|
| 关注头像 | `#scheduleAvatarDrain` | 切首字回退并退出 media-loading |
| 作品缩略图 | `#scheduleCoverDrain` | 原样重试一次（`dataset.retry` 挂可见节点、随重填换新自然复位；熔断冷却中不重试），仍失败停留透明渐变占位态 |
| 侧边栏封面 | `#scheduleImgDrain`（仅升级态发探针） | 成功隐藏 `.sidebar-work-cover-placeholder`；失败由条目底色兜底 |
| 收藏弹窗 fav-work-thumb | 无熔断联动 | 直赋背景图即可 |

代际防乱序（在途探针回调必须先校验代际再提交，否则旧 URL 会提交到已换人的槽位）：

| 槽位 | 代际机制 | 场景 |
|------|----------|------|
| 关注头像 | `dataset.fillGen` + `#avatarTargetAlive` | 骨架原地重填复用根节点 |
| 作品缩略图 | `dataset.coverGen` | `updateCardDOM` 复用同一节点再次入队 |
| Detail 大图 | `#imgProbeToken` | 快速切换作品作废在途探针 |
| 侧边栏封面 | `cover.dataset.gen` | `#demoteItem` 自增作废，重升级入新代 |

`#showAvatarFallback` 与 `clearCard` 必须清空 `backgroundImage`，防止旧图残留。

### 媒体全局熔断

`Detail.markMediaFail / markMediaOk / mediaRetryBlocked` 维护滑动窗口失败计数：视频/封面失败密集超阈值（`MEDIA_FAIL_WINDOW` 内超 `MEDIA_FAIL_MAX` 次）即进入冷却期（`MEDIA_BREAK_COOLDOWN`），期间跳过重试直接降级；任何媒体成功加载即复位。**新增媒体重试逻辑必须接入该机制，不要自行计数**。

### 短操作弹窗锁定与取消门控

- 短操作（如分组刷新）：`state.preventDialogClose = true` + `try/finally` 解锁，防止异步期间用户误关。
- 长操作弹窗 X 按钮**始终可点**，点击即发送 `CANCEL_ACTIVE_TASK`。
- 为避免短操作误发取消信号，`CANCEL_ACTIVE_TASK` 仅当 `state.activeDialog` 存在时发送（信号路径见 01/09）。

### 同步进度过滤的 requestId 时序差异

`SYNC_WORKS` **立即**返回 requestId；`FETCH_FOLLOWING` 等**收集完成才**返回。关注进度过滤因此必须兼容 `Sync.#followingsRequestId === null`（列表阶段尚未拿到 requestId 时不得按 requestId 过滤丢弃进度消息）。进度消息载荷见 01。

### CSS 协同约定（.hidden 成对声明）

自带 display 值的组件类与通用 `.hidden` 同用时，**必须成对声明 `.X.hidden { display: none }`**。原因：通用 `.hidden` 定义在 options.css 前部（约 66 行），同特异性（0,1,0）下会被文件后部组件规则里的 `display: flex/…` 覆盖，`hidden` 类静默失效、占位层常显（曾导致作品卡中央 emoji 常显、关注卡头像旁多出一个空占位圆）。既有先例：`.work-type-badge.hidden`、`.following-avatar-fallback.hidden`。

### 骨架模板同构要求（原地切换的配套约束）

骨架模板必须与完整卡在根层同构：

```
.work-card       > .work-media + .work-checkbox + .work-title
.following-card  > .following-checkbox + .following-main(.following-avatar/.following-avatar-fallback
                                          + .following-nickname) + .following-stats
```

媒体子树、操作按钮等可从完整模板取新节点移入；unloadObserver 因此持续观察同一根节点无需重挂，fill observer 在 `#demote` 时重新 observe。新增会替换卡片 DOM 的逻辑必须保持 dataset key 与两个 observer 的交接（`populateItem` 负责 observe 完整卡）；`updateCardDOM` 已兼容骨架态。

## 异常场景及处理

| 场景 | 表现 | 处理/禁止事项 |
|------|------|----------------|
| 哨兵卡被 `removeItems` 删除 | 分圈观察断链，后续骨架永不 observe | 删除后立刻续接哨兵 |
| `render()`/`abortRender()` 未清队列状态 | 旧骨架引用残留、重复填充 | 重置时同步清 `#pendingSkeletons`/`#sentinelCard`/observers |
| 用 `replaceChild`/`replaceWith` 换卡片根节点 | Blink 全量重排，3000 卡单次 >10ms | 只允许原地切换（改类名 + 增删后代） |
| 把填充/卸载两圈 rootMargin 调近 | 边界抖动、反复填/降级 | 保持滞回（200px vs 1200px） |
| 媒体重试自行计数 | 与熔断窗口叠加放大请求量 | 一律接 `Detail.markMediaFail/mediaRetryBlocked` |
| 在途探针回调不校验代际 | 旧 URL 提交到已换人槽位（错图） | 先验 fillGen/coverGen/gen/imgProbeToken 再提交 |
| hover 预览改用 pointerenter/leave | 功能静默失效 | 只用冒泡的 pointerover/out 委托 |

## 配置项说明

| 分组 | 键（默认值） |
|------|--------------|
| 分块渲染 | `RENDER_CHUNK_SIZE`(50) / `OBSERVER_ROOT_MARGIN`('200px') / `OBSERVE_CHUNK_SIZE`(48) / `FILL_FRAME_BUDGET_MS`(8) / `UNLOAD_ROOT_MARGIN`('1200px') |
| 侧边栏 | `SIDEBAR_SNAP_POINTS`([650,0]) / `SIDEBAR_SCROLL_THRESHOLD`(100) / `SIDEBAR_FILL_THRESHOLD`(50) / `SIDEBAR_IMG_PER_FRAME`(6) / `SIDEBAR_DRAG_THRESHOLD`(4) |
| 媒体熔断 | `MEDIA_FAIL_WINDOW`(5000) / `MEDIA_FAIL_MAX`(10) / `MEDIA_BREAK_COOLDOWN`(15000) |
| 详情播放器 | `VIDEO_RETRY_DELAYS`([200,400,600]) / `VIDEO_RETRY_MAX`(3) / `VIDEO_FALLBACK_TIMEOUT`(5000) / `HOVER_PREVIEW_DELAY`(200) / `BLOB_REVOKE_DELAY`(10000) / `NOTE_AUTO_PLAY_INTERVAL`(3000) |
| 卡片尺寸 | `CARD_SIZE_FALLBACK`(261) / `CARD_GAP`(9) / `CARD_HEIGHT_OFFSET`(35) |
| 其他 UI | `TOAST_DURATION`(2000) / `DOWNLOAD_MAX_RETRY`(1) / `DETAIL_TITLE_MAX_LEN`(40) / `TAB_SCROLL_THRESHOLD`(2) / `GROUP_NAME_MAX_LEN`(20) |

## 相关文档

| 编号 | 文档 | 关联内容 |
|------|------|----------|
| 01 | [01-project-architecture.md](./01-project-architecture.md) | options.js 代码布局约束、进度消息载荷表、CANCEL_ACTIVE_TASK 双路径 |
| 02 | [02-independent-sync-works.md](./02-independent-sync-works.md) | SYNC_PROGRESS/SYNC_DONE 的产生侧（本册的消费侧过滤） |
| 03 | [03-independent-sync-followings.md](./03-independent-sync-followings.md) | FOLLOWING_PROGRESS 时序（#followingsRequestId 过滤的上游） |
| 07 | [07-independent-fetch-user-works.md](./07-independent-fetch-user-works.md) | 侧边栏滚动加载的数据来源 |
| 09 | [09-inject-tab-mode.md](./09-inject-tab-mode.md) | CANCEL_ACTIVE_TASK 抵达 inject 的后半程 |
| 10 | [10-storage-write-and-import.md](./10-storage-write-and-import.md) | 网格数据源（GET_WORKS/GET_FOLLOWINGS 结果）的落库语义 |
