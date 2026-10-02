# 11 · 管理页渲染与交互（options/ 模块化）

> 职责边界：options/ 各模块的渲染与交互子系统机制——VirtualGrid 双向虚拟化、Sidebar 升降级虚拟化、媒体加载统一体系与全局熔断、悬停预览事件委托、批量勾选 DOM 约定、弹窗锁定与取消门控、CSS 协同约定。数据流与消息协议见 [01](./01-project-architecture.md)；写入语义见 [10](./10-storage-write-and-import.md)；抖音页面注入侧见 [09](./09-inject-tab-mode.md)。

## 概述

管理页要在单页内承载数千张卡片与条目，渲染层的一切设计都围绕两个约束：**不换根节点**（任何 grid 直接子节点被替换都触发 Blink 全量重排，成本随卡片总数线性增长）与**媒体生命周期显式管理**（探针先行、代际防乱序、全局熔断）。本文收录各子系统的机制定案与历史踩坑结论，改动前先读对应小节的"禁止"条款。

## 核心流程图（文字描述）

### VirtualGrid 渲染管线（双向虚拟化 + 分圈观察 + 全量骨架预铺）

分组与域切换同序列清场（2026-09-27 用户定案：点击必须先清空，「旧网格冻结-定格」方案否决——
定格被感知为卡顿）：分组走 `currentGroupId` 事件、域走 `switchDomain`，二者都在切换瞬间经
`appShell.clearActiveGrid()` 同步 abortRender×4 + **样式塌缩**：旧容器三条内联样式
（height:0 + overflow:hidden + visibility:hidden）令滚动高度瞬间塌缩、画面立即清空——
任何「移除 1 万节点」的操作（replaceWith/innerHTML 皆然）都是 O(N) 整树脱离 + 布局对象
销毁，阻塞在点击路径上就表现为滚动条迟迟不缩到目标尺寸；子树销毁整体推迟到首帧渲染后的
空闲期一次性执行（requestIdleCallback，timeout 1s 兜底）。容器级事件委托
（click/pointerover/out/input）绑在 `#mainGrid`（稳定节点）上，换容器零重绑；网格经
`attachContainer` 重指向。数据到达后由 render(items) 首屏同步铺骨架、
余量拼装一次挂载并按槽回填——点击→首屏的空白由首页快取数（~50ms 量级）+ 全量预铺压到
不可感知，滚动位置随 wipe clamp 归零。

数据侧与渲染侧衔接（`services.loadDomainData`，作品型三域分页渐进）：首页（`GET_WORKS page:0`，
bg 端复合索引 keyset 游标直出、每次只物化单页 + `total` 计数，首页延迟几十毫秒量级）到达即
`store.set` → render() 按 `total` **预铺至 `GRID_PREMOUNT_CAP` 上限**（未到达槽位为无键占位卡，
超出上限的部分滚近底部时倍增扩容——滚动条物理上到不了未挂载区，远跳落进空白结构性不存在）；
余量以 `nextCursor`（末条索引键）keyset 续页 `appendWorkRecord`
→ `work-record-appended` 事件 → 默认视图 `fillSlots(start)` 按键前缀自锚定回填（零 DOM 增删；
  落点 = 传入 start 与首个无键槽取小者，删除使 #slots 相对页序收缩时自愈）、`done` 时
`pruneEmptyTail` 摘除尾部未回填占位卡（预铺超出的兜底残余，removeItems 已同步收缩 #totalSlots）；筛选激活时静默累积到
加载完成再整渲（逆序/作者聚类破坏页序对齐；`renderCards` 消费额度时按 `isFilterActive` 跳过预铺）；
followings 与 `loadWorks`（同步清单/重试）保持单发全量：

```
render(items, emptyMsg, emptyHint, totalSlots, premountCap = GRID_PREMOUNT_CAP)
  → 容器 wipe（render()/abortRender() 重置时必须同时清 #pendingSkeletons / #pendingAppends /
    #slots / #viewItems / #sentinelCard / observers；点击即清场路径滚动随 wipe clamp 归零）
  → #viewItems = items.slice()（视图快照：键控扩容取数源；浅拷贝隔离，头插/移除/追加
    原地维护本表，不反噬调用方数组——SearchBar 视图缓存数组只读）
  → #totalSlots = max(totalSlots, items.length)；按视图形态分流铺槽数：
      封闭视图（items.length ≥ #totalSlots = 筛选态/全量单发，无「未来分页」）：
        slotCount = min(items.length, premountCap)——筛选态传 GRID_PREMOUNT_CAP_FILTER 降档，
        全量铺设只会让每次筛选切换付出 O(结果数) 的克隆+布局成本；余量滚近底部键控扩容
      渐进视图（totalSlots > 已知条目数，fillSlots 按槽回填的前提是槽位对号存在）：
        slotCount = min(#totalSlots, max(premountCap, items.length))——已知条目始终全量铺，
        未到达槽位为无键占位卡
    首段同步挂载前 RENDER_CHUNK_SIZE 个（真数据骨架优先，缺口为无键占位卡）；首段节点打
    data-fade（入场动画仅限定首屏，CSS `.work-card[data-fade]`——筛选切换/扩容的数百张卡
    不再同帧起 350ms 动画，滚入/回填直接呈现），挂载后交接分圈观察
  → 余量按 RENDER_BUILD_BUDGET_MS 时间预算分帧拼装（保持游离态，脱 DOM 不触发布局），
    拼完挂载前对账（拼装窗口内被 removeItems 删除的条目不挂载不占槽），再向容器一次挂载并
    交接观察——容器全程只经历 2 次插入，布局只剩收尾 1 次 O(N)
      （禁止改回逐帧向容器追加：每帧 append 都触发全容器 grid 重排，总成本 O(N²/块)）
  → 新骨架进 #pendingSkeletons 队列；每次只把最靠前 OBSERVE_CHUNK_SIZE 个交给填充 IO
  → 圈尾哨兵 #sentinelCard 进入 OBSERVER_ROOT_MARGIN 时 #extendObservation 放下一批
      （原因：IO 回调的 computeIntersections 成本随已观察目标数线性，
        全量 observe 2000 卡时滚动期每帧重算 O(全部卡) 次几何——trace 实测 1.2s/5s）
  → 整渲收尾（#finishRender）统一补一次视口追赶 #scheduleCatchUp：原位整刷（wipe 与重挂
    同任务同步完成）前后内容等高时滚动位置原样保留、全程无 scroll 事件，哨兵停在网格
    顶部、向下链推进够不着中部视口，视口带区骨架无人观察——批量同步 SYNC_DONE 整刷后
    卡片滞留灰骨架、手动滚动才出封面的根因（2026-09 修复）

fillSlots(startIndex, items)（渐进分页按槽回填）
  → 预铺 buildChunk 未完成时进 #pendingFills 排队（槽位尚不存在，直接回填会误走追加造成双卡），
    拼装完成后 drain（先于 #pendingAppends）
  → 落点自锚定：#applyFill 以「首个无键占位卡」为基准、与传入 start 取小者
    （删除会使 #slots 相对页序收缩——拼装窗口内的在途删除、push→回填 rAF 间隙的删除——
      固定下标会整页写偏、留下永久无键灰卡；网格键前缀是唯一可信对齐基准）
  → 页内条目按 #slots[start + i] 对号：写真实键 + itemMap.set（零 DOM 增删、零布局）
  → 视口带内的占位卡主动 unobserve + #enqueueFill；带外的保持观察、滚近自然触发
      （fill IO 回调对无键占位卡不 unobserve——摘除后回填即永不填充，铁律）
  → 槽位越界/已占键 → 逐条回退 appendItems 追加
  → done：pruneEmptyTail 摘除尾部未回填占位卡（兜底）

带键骨架进入滚动口+1600px 预填带（OBSERVER_ROOT_MARGIN，≈4 行）→ #enqueueFill 入队
  （1600 定案：600px 只给 0.4-0.7s 领先量，会被结构填充后的封面探针网络延迟吃光，正常
    滚速下骨架可见；4 行给探针完整网络提前量。须 < OBSERVE_CHUNK_SIZE 单圈行距 2400px
    ——哨兵链观察前沿要永远盖得住填充带）
  → rAF 分帧填充：每帧最多花 FILL_FRAME_BUDGET_MS(8ms) 即让出主线程
  → populateItem 原地构建完整卡 → fill observer 转 observe 完整卡

完整卡滚出滚动口+2400px 卸载带（UNLOAD_ROOT_MARGIN，≈6 行）→ #demote 原地降级回骨架
  （与填充圈保持 800px 滞回间隙：振幅超过间隙的往返滚动才会反复填/降级，发生在屏外、
    探针走缓存，勿调到重合；#demote 重 observe 走直连路径不经队列。闲置预热范围 ⊆ 卸载圈）
  两 IO 的 root 必须显式传 #mainGrid：隐式根=文档视口时 rootMargin 会被 #mainGrid
  作为祖先滚动容器的裁剪盒抵消，两圈塌缩到滚动口边缘——卡刚出可视区即降级、滚回
  即重填（小幅滚动往返重载的根因，2026-09 定案修复；sidebar 的 dom.sidebarBody 同款规则）
  降级经 #pendingDemotes 队列按 DEMOTE_FRAME_BUDGET_MS 预算分帧执行（2026-09 定案）：
  快滚期沿途积压的降级一次性同步执行是数百毫秒长任务，会把停稳后的视窗填充顶到后面——
  drain 快滚期保持冻结（旧门控语义不变）、让位于填充队列（#fillQueue 非空即延后），
  勿改回 IO 回调内同步成批降级

接近底部扩容（#extendIfNeeded，随滚动 rAF 检测）
  → 内容底距视口底不足 GRID_EXTEND_THRESHOLD(1.5) 屏且 #slots.length < #totalSlots
  → 步长 = min(倍增, 单步上限 GRID_EXTEND_STEP)（深域后段一次倍增会是数千上万张占位卡
    克隆 + 整容器布局的长任务，超出部分由后续滚动 rAF 继续扩），槽位来源按视图形态分流：
      封闭视图（#totalSlots ≤ #viewItems.length）：扩容卡带真实键——从 #viewItems 快照
        锚接续取条目（锚 = 槽尾最后一张带键卡的键在快照中的下标，DOM 实况推导，
        免维护游标不变量；锚失配不扩容留待整刷自愈）。封闭态没有 fillSlots 回填方，
        无键占位卡会永久灰卡
      渐进视图：克隆无键占位卡追加（走分圈观察既有机制），数据页经 fillSlots 自锚定回填
      （滚动条物理上到不了未挂载区——「远跳落进空白」结构性不存在）

快滚门控（判定在 scroll 事件时刻完成：帧间差 > FAST_SCROLL_THRESHOLD 300px，见 #onGridScroll）
  → 判定基准只由 scroll 事件推进：rAF 侧一帧内有 catchUp / drain 轮询两个读取者，
    若各自推进基准，第二位读者必得 delta 0、逐帧误判停稳——冻结被打断、#refillBand
    每帧空转、积压卡被反复丢弃（快滚扫过区段滞留灰卡的根因，2026-09 修复）
  → 快滚态：填充 drain 挂起、#demote 跳过——DOM 变更冻结后 paint ops 保持有效，
    合成器脱离主线程滚动显示灰骨架；drain 轮询入快滚态即自持启动（不依赖队列非空），
    停稳检测走 epoch 计数（轮询帧内无新 scroll 事件 = 停稳）
  → 停稳：#refillBand 丢弃沿路积压填充队列（丢弃前全量重新 observe——积压卡入队时
    已 unobserve，直接清空会让被扫过区段滚回也永不填充）、对落点带区无视 observed
    标记强制补填
      （万级网格每次填充/降级变更都打脏布局（尾部帧 30-50ms），把瓦片光栅化挤到主线程后面）
  → 滚轮级停稳收口（#scheduleSettleCheck，2026-09 定案）：FAST_SCROLL_THRESHOLD 是
    帧间位移阈值，只有拖拽滚动条达得到——滚轮平滑滚动全程 scrollFast 恒 false，上面
    的 settle→#refillBand 链路永不执行、停稳没有收口。scroll 事件无条件调度 settle-
    checker：滚动静止一帧后、若 scrollFast 仍为 false（快滚路径未收口）则补一次
    #refillBand（幂等：已填卡被 #doFill 的骨架类检查无害跳过）。勿让滚轮路径失去停稳收口
      （实测不对称：拖拽快滚停稳即填，滚轮快滚停稳要等 IO 逐卡管线——根因即此）
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
render(items, emptyMsg, emptyHint, totalSlots, premountCap) // premountCap 按态传（渐进 GRID_PREMOUNT_CAP / 筛选 GRID_PREMOUNT_CAP_FILTER）；封闭视图（totalSlots ≤ 已知条目数）只铺上限张；#viewItems 视图快照同步建立；abortRender 同时清空 observer 与分圈/#slots/#viewItems 状态
fillSlots(startIndex, items)                  // 渐进分页按槽回填（零 DOM 增删；预铺拼装未完成时排队；落点按键前缀自锚定；错位逐条回退追加）
pruneEmptyTail()                              // 加载收尾：摘除尾部未回填占位卡
appendItems(items)                            // 追加兜底（槽位越界/已占键时由 fillSlots 回退调用）；#viewItems 快照同步 push
insertItems(index, items)                     // 位插原语（STORE_CHANGED 增量收口）：state 与 #slots 对位 splice + 骨架卡挂载 + #viewItems 对位 splice，removeItems 的对偶；落点越界/重复键返回 false 交整刷自愈；头插卡插队到待观察队列最前（分圈哨兵停在旧网格尾部，向下链推进够不到文档更靠前的头插卡）+ 落点在视口上方时按锚点卡实测位移补偿 scrollTop
removeItems(idSet)                            // 单遍批量删除：摘 itemMap 记 known 集 → 单遍 #slots 收集命中卡 → 槽位表一次 filter 重建（禁改回 per-id querySelector + indexOf 的 O(N×M)）；#slots/#totalSlots/#viewItems 同步收缩；哨兵命中整批清理后统一续接一次
#extendObservation()                          // 哨兵触发时放下一批 OBSERVE_CHUNK_SIZE 个
#enqueueFill(card) → #scheduleDrain → #doFill // 时间预算制填充分帧
populateItem(skeleton, item)                  // 原地填充入口；负责 observe 完整卡（交接点）
#demote(card)                                 // 原地降级回骨架；fill observer 重新 observe
fillCard(card, item) / clearCard(card)        // 子类钩子：只允许改类名与增删根节点后代

// WorksGrid / FollowingsGrid
renderCards(view?) / renderFollowingCards(view?) // view 缺省经视图函数取（内部阶段缓存）；refreshGridView 是唯一调用方并注入现成视图；筛选态预铺降档至 GRID_PREMOUNT_CAP_FILTER
#bindMediaEvents()                            // pointerover/out 容器级委托（见下文）

// Sidebar
openSidebar(following) / #loadMoreWorks()     // 触发 FETCH_WORKS_PAGE（见 07）
#createWorkItem / #promoteItem / #demoteItem / #enqueueCover / #scheduleImgDrain

// Batch / Detail / Sync
Batch.updateCheckboxDOM(checkboxEl, isSelected)
Batch.handleBatchSelectAll()                  // 按域选择 checkbox 选择器
Detail.markMediaFail() / markMediaOk() / mediaRetryBlocked()
Detail.#scheduleCoverDrain / #showAvatarFallback / #imgProbeToken
Detail.#renderVideoProgress / #resetVideoProgressUI / #applySeek(frac)
Detail.#buildNoteSegs / #renderNoteSegs(cur, total) / #onNoteAudioTimeUpdate / #onNoteAudioEnded
Sync.#requestId                               // 同步进度过滤（收集期可为 null，null 时全收）
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
  if (!checkboxEl) return;                 // 骨架卡无勾选框：批量点击直启路径容错
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

- **勾选框显隐由 `body.batch-mode` 纯 CSS 驱动（红线）**：基类 `.work-checkbox`/`.following-checkbox` 为 `display:none`，`body.batch-mode` 下才 `flex`。JS 侧（fillCard/clearCard/handleBatchToggle）**禁止逐元素写 inline display**——勾选框随卡片填充创建且滚出卸载圈降级（clearCard）时**即移除**，但万级域滚动后勾选框仍可达数千，逐个 style 写入会让进/出批量模式触发秒级样式重算+重排（2026-09 卡顿报告的根因）。退出批量只清 `.checked` 的勾选框（未勾选框本就无内容）。
- **批量禁选文本走 mousedown preventDefault，禁止 CSS user-select（红线）**：`.batch-mode` 系 user-select 规则（逐卡 `.work-card` 或容器 `#mainGrid` 继承覆盖均可）会随 body class 翻转触发全网格级联重算——容器继承方案更糟（继承传播让全部 ~4 万后代节点全量重算，5000 卡高保真复现实测 ~800ms/次，禁用后 43ms），是「进入批量模式卡顿」的主因。改为 main.js 在批量模式下对 `#mainGrid` mousedown `preventDefault()`（O(1)、零样式成本；限定主键并排除 input/textarea，保住视频进度条拖拽）。

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

### 离开扩展页面即暂停全部播放（visibilitychange）

`main.js` init 绑定 `visibilitychange`（`document.hidden` 时触发，即切标签/最小化；窗口失焦不暂停），回调为 `worksGrid.stopAllMedia() + detail.pauseOnHidden()`：

- 卡片悬浮/按钮预览：`WorksGrid.stopAllMedia()` 遍历容器内全部 `.work-video-player` 走 `#stopPreview`——pause、清 `hoverTimer/_retryTimer/_hoverTimeout`、摘 hovered 标记并还原封面。覆盖悬停起播与播放按钮直启两条路径。
- 详情视频：`Detail.pauseOnHidden()` 先 `clearTimeout(video._retryTimer)`（防挂起重试在后台 `load()+play()` 静默续播）再 pause，播放按钮复位为 play 图标与「播放」文案。
- 详情图集：`#noteStopAutoPlay()`（music 模式同步 pause 音频、virtual 模式清定时器）+ `#noteUpdatePlayBtn()`。

回到页面不自动恢复播放，由用户手动续播（预览需移出再移入卡片重新触发）。

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

四个槽位 `.following-avatar` / `.work-thumb` / `.sidebar-work-cover` / `#detailImage` 全是 `<div role="img">`。验收标准：`grep '<img'` 模板应只剩图标 `<use>`。背景图加载失败时浏览器不绘制任何占位图标——原生断裂图在元素层面失去载体，这是历史三轮"切换/滚动时瞬态裂图"报告的根治手段。

加载统一走离屏 `new Image()` 探针先行，成功才提交 `style.backgroundImage`，死链在探针阶段终结。各槽位失败语义：

| 槽位 | 探针调度 | 失败处理 |
|------|----------|----------|
| 关注头像 | `#scheduleAvatarDrain` | 切首字回退并退出 media-loading |
| 作品缩略图 | `#scheduleCoverDrain` | 原样重试一次（`dataset.retry` 挂可见节点、随重填换新自然复位；熔断冷却中不重试），仍失败停留透明渐变占位态 |
| 侧边栏封面 | `#scheduleImgDrain`（仅升级态发探针） | 成功隐藏 `.sidebar-work-cover-placeholder`；失败由条目底色兜底 |

代际防乱序（在途探针回调必须先校验代际再提交，否则旧 URL 会提交到已换人的槽位）：

| 槽位 | 代际机制 | 场景 |
|------|----------|------|
| 关注头像 | `dataset.fillGen` + `#avatarTargetAlive` | 骨架原地重填复用根节点 |
| 作品缩略图 | `dataset.coverGen` | `updateCardsDOM` 复用同一节点再次入队 |
| Detail 大图 | `#imgProbeToken` | 快速切换作品作废在途探针 |
| 侧边栏封面 | `cover.dataset.gen` | `#demoteItem` 自增作废，重升级入新代 |

`#showAvatarFallback` 与 `clearCard` 必须清空 `backgroundImage`，防止旧图残留。

### 卡片预览静音全局联动（详情播放器独立）

- 三域卡片静音切换走 `WorksGrid.#togglePreviewMute()`：共享 `#previewMuted` 标志，遍历容器内全部已渲染 `.work-video-player` 同步 `video.muted` 与按钮图标；卡片填充与悬停起播都读该标志保证新卡继承。禁止改回单卡独立静音。
- `Detail.toggleVideoMute` 只服务详情覆盖层（`dom.detailVideo`/note 音频），勿与卡片联动。

### 媒体全局熔断

`Detail.markMediaFail / markMediaOk / mediaRetryBlocked` 维护滑动窗口失败计数：视频/封面失败密集超阈值（`MEDIA_FAIL_WINDOW` 内超 `MEDIA_FAIL_MAX` 次）即进入冷却期（`MEDIA_BREAK_COOLDOWN`），期间跳过重试直接降级；任何媒体成功加载即复位。**新增媒体重试逻辑必须接入该机制，不要自行计数**。

### 短操作弹窗锁定与取消门控

- 短操作（如分组刷新）：`state.preventDialogClose = true` + `try/finally` 解锁，防止异步期间用户误关。
- `state.activeDialog` 在弹窗挂载时由 `Dialog.#mountLayer` 写入（恒等于顶层 onClose），X/Esc 经 `requestDialogClose` 联动发送 `CANCEL_ACTIVE_TASK`；只在 `closeDialog` 出栈时补写会使「本次打开后的首次关闭」静默失效（941a369 分层重构曾回归、2026-09 修复）。无 onClose 的弹窗（设置/维护/确认框）该值为 null，走兜底关闭。
- 长操作弹窗 X 按钮**始终可点**，点击即发送 `CANCEL_ACTIVE_TASK`。
- 为避免短操作误发取消信号，`CANCEL_ACTIVE_TASK` 仅当 `state.activeDialog` 存在时发送（信号路径见 01/09）。

### 多层弹窗（pushDialog 叠层）

- 单 overlay 多实例：基层为静态 `#dialogOverlay`，`showDialog` = 销毁全部上层后重置基层（既有调用点语义不变）；`pushDialog` = 当前层原地保留为父层、新 overlay 实例叠加（z-index 逐层递增、`.layered` 遮罩减淡至 0.4），关闭顶层即销毁实例、露出父层——父层 DOM 原地不动，监听器/输入值天然保留。
- `dom.dialogTitle/dialogBody/dialogFooter/dialogClose` 由 Dialog 动态指向顶层实例元素（仅该类可写），调用方即时访问自动命中顶层；`dom.dialogOverlay` 恒指基层，其 hidden 即「有无弹窗」全局信号（Esc 分流、悬停预览守卫、键盘守卫均依赖）。
- 同层内容切换（进度 → 结果）**必须就地改写** `dom.dialogTitle/dialogBody` + `showOkDialog`（import-export / AuthorImport.#showDone 同款），禁止改调 `showDialog`——那会清栈重建基层、摧毁父层。
- 关闭入口 `requestDialogClose` 以 depth 快照防连关：`activeDialog()`（onClose 通常自行关层）已使 depth 变化时直接返回；`settings.saveBeforeClose` 仅在关闭基层（`dialog.isBase`）时触发。X 按钮为 document 级 `.dy-dialog-close` 委托（每层各有 ✕）。
- 焦点三段式：基层打开记触发元素 → 关闭顶层焦点移入父层第一控件 → 最终关闭归还触发元素。

### 同步进度过滤的 requestId 时序差异

`SYNC_WORKS` **立即**返回 requestId；`FETCH_FOLLOWING` 等**收集完成才**返回。关注进度过滤因此必须兼容 `Sync.#requestId === null`（列表阶段尚未拿到 requestId 时不得按 requestId 过滤丢弃进度消息）。进度消息载荷见 01。

### 分组 tab 滑块（对齐域切换 ds-slider）

`.group-slider` 常驻 `.group-tabs` 内，高亮职责整体移交滑块（`.group-tab.active` 自身背景必须透明，否则过渡期双重高亮）。**滑块动画的前提是元素跨切换存活**：`renderGroupTabs()` 全量重建仅在分组集合/计数变化时走（groups 事件、换域、init、导入、同步完成）；分组切换只走 `groups.syncActiveTabs()` 切 active 类 + 滑块带动画滑动。`updateGroupSlider(animated)` 中 `animated=false`（重建/resize）必须 no-anim 瞬移——resize 绝不允许滑块从旧位置横穿飞行；active 缺失（删除当前分组的重建瞬间）收拢为零宽、不残留旧高亮。

### 详情层双形态进度条（视频轨道 / 图集分段）

`#detailProgress` 贴播放条顶缘通栏，一个容器两种形态，由 `note-mode` 类切换：

- **视频模式**：`.track-wrap` 连续轨道（buffered/played/thumb + hover 时间气泡），由 `#detailVideo` 的 `timeupdate` 驱动 `#renderVideoProgress`；`#detailTime`（bar-controls 信息位）同源更新。
- **图集模式**：`#noteSegs` 分段进度接管同一位置（`note-mode` 下 `.track-wrap` 隐藏），N 段对应 N 张图，段内渐进填充。驱动分两路：有音乐时 `#detailAudio` 的 `timeupdate` 驱动（总时长=音乐真实时长，`loadedmetadata` 后接管）；无音乐兜底虚拟时钟（每图 `NOTE_AUTO_PLAY_INTERVAL`，收尾语义与旧定时轮播一致）。收尾均走 `nextOnEnd()` 的 single/group/off 循环模式语义。
- **手动切图语义（方案A·音乐不跳段）**：箭头/键盘走 `#noteManualSwitch`——重定基周期偏移量 `#noteSegOffset`（周期时间 = `audio.currentTime - offset`）对齐目标段起点，指示器/`#noteVirtualElapsed` 同步，**音乐本身不 seek**；驱动按重定基后的周期时间继续推进，手动位置不被弹回。进度条 seek 同样只重定基偏移量。周期提前耗尽（前跳）或音乐先结束（后跳）均按 `nextOnEnd()` 收尾；'off' 播完后音频停在末尾，再点播放先清零 `currentTime/offset`（否则 play 后立即又触发 ended，播放键失灵）。
- 键盘可达：容器 `role="slider"` + `tabindex="0"`，左右键 ±5%、Home/End 到两端；`seek` 统一走 `#applySeek`（视频=currentTime，图集=音乐进度且段落随位置切换）。
- 悬浮特效：整段加高 6px + 指针段 `scaleY(1.8)` 提亮（`transform-origin: top` 向下伸展不遮画面）。
- **模糊背景仅随作品切换（2026-09 性能定案，反转旧「逐图跟随」）**：视频=封面、图集=首图，在 renderDetail 时更新一次；图内翻页不再调 `#applyDetailBg`——全屏 `blur(70px)` 层随背景源变化整体重光栅化（1080p 每次 10-50ms 级 paint），图集自动播放逐图跟随等于每 3s 一次全屏重绘，得不偿失。
- **详情大图 div+background-image 载体（红线）**：`#detailImage` 曾是 `<img>`——其失败态由浏览器原生渲染裂图图标+空框，JS 的 error 处理赢不了"请求失败→绘制"竞态（短暂裂图），2026-09 换为 div 载体（`role="img"`+`aria-label` 无障碍标注，`background-size: contain` 完整显示、列宽随媒体比例收窄见下方「几何」）。背景失败在结构上不可见（旧背景保持、新背景只在探针成功后提交），禁止改回 `<img src>`。
- **图集零空档切图（红线）**：顺序固定为 `#prefetchNoteImage(idx+1)` 预取下一张（纯预热缓存，无回调不进熔断计数、冷却期跳过）→ 旧背景保持 → 探针成功 `markMediaOk` → `probe.decode()` 就绪 → 提交背景（模糊背景不再随图切换，见上条）。探针失败 `markMediaFail` 时旧图本就未离开，无需恢复；任何成功展示前先 `#hideImageFailed()` 清失效态。禁止改回"先淡出让位再加载"（黑屏空窗）。
- **分段填充跃迁双写 + wheel 冷却（2026-09 性能定案）**：`#buildNoteSegs` 建表时缓存各段 fill 引用，`#renderNoteSegs` 每 tick 只写当前段、段界跃迁（seek 跳段/续播重置）一次性收敛区间段——替代逐 tick 全段展开 + `querySelector` + 全段写 width（50 图图集 ≈ 每秒 200 次无效布局失效写入）；详情 overlay 的 wheel 切作品有 300ms 冷却（`#wheelAt` 时间戳），触控板惯性不再每秒连发数十次全量 `renderDetail`。

### 详情计数 K 可编辑跳转

播放条最右端作品序号「K / N」中 K 为真实输入框（`#detailCounterInput`，外观与静态文本一致，悬停/聚焦下划线提示）：聚焦全选、输入仅留数字、宽度随总位数/输入位数自适应（ch）。**Enter 提交跳转**（非数字/越界钳制到 [1, N]；相邻序号复用 ↑/↓ 方向感过渡、远跳走普通淡入）、**Esc 还原退出**（stopPropagation 拦在 document 层「Esc 关详情」之前）、**失焦还原**——展示值与当前作品恒一致。详情 document keydown 在 Tab 圈定后对该输入框整体让位（数字/方向键不得切作品、删键不得触发移除），Tab 焦点圈定照常覆盖该输入框。跳转只改 `#index` + `renderDetail`；关闭详情时网格滚动恢复走既有 `restoreGridScroll`，跳转结果自然落位。

### 详情层几何（对齐抖音播放界面）

- **几何**：`.detail-body` 全屏宽、`flex:1`（高度=视口−56px 播放条，零重叠）；`.media-view` 居中，宽度=`min(视口宽, 可视高×媒体宽高比)`（`--media-aspect` 由 `Detail.#setMediaAspect` 写入 overlay：视频 `loadedmetadata` 的 videoWidth/Height、图片探针成功后的 naturalWidth/Height，图集逐图跟随；切作品在 `#transitionToNext` 复位 9:16 缺省防上一件残留），竖版/横版/方形一律等比铺满可视高、零裁切（2026-09-29 修订：废弃横版/方形 39.3vw 封顶——`.media-view` 高度恒为满高列，封顶使横版在列内只剩一条居中横带，与「对齐抖音播放界面」相悖；超宽媒体由 `min(100%, …)` 截断）；视频/大图 `object-fit/background-size: contain` 完整显示（2026-09 定案，反转旧 cover 裁切——9:16 竖版在固定 3:4 胖容器里会被裁掉约 24% 画面），列内留白由 `#detailOverlay::before` 模糊背景透出填充（`brightness(0.8)`，非旧版 0.4）。
- **⌃⌄ 切换器**（`#detailSwitcher`）：右缘垂直居中（`position:fixed` 必须用 `calc((100% - var(--detail-bar-height)) / 2)` 显式扣除底栏高度——与绝对定位于 `.detail-body` 内的左右箭头共用同一居中基准，否则比箭头中心线低半个底栏），只切上一个/下一个作品（接 `prevDetail/nextDetail`），不参与图集翻页——图集翻页归左右箭头（56px、锚定 10vw、悬浮/聚焦常显）、分段条 seek 与自动轮播。
- **bar-controls 信息位**：视频=`#detailTime`（0:00/0:00），图集=`#detailOrder`（K/N），由 `#updateCounters` 分工写入；`#detailCounter`（作品序号）仍在最右端。
- **`#detailTitle` 全文**：描述不再 JS 截断（`DETAIL_TITLE_MAX_LEN` 仅剩移除确认框使用），CSS 单行省略。
- `.detail-bar-btn` 仍被卡片预览按钮复用（options.html `.video-play-btn/.video-mute-btn`），调整其尺寸参数时须回归卡片预览。

### SearchBar 搜索/筛选约定

- **搜索栏收起即重置（红线）**：`closeSearchBar()` 必须先调 `clearSearchFilters()`，筛选不跨收起保留；域切换**不**重置；筛选状态**不落 URL hash**——P1-8 的刷新恢复已移除：hash 会残留在标签页 URL 里被下一次加载「自动展开搜索栏」（即便本会话从未打开过），且只要在展开状态下刷新就自续循环；现全仓无 hash 读写方，main.js init 仅保留一次性残留清理。
- **「已关注/未关注」归属判定走方案A：作品 `uid` 实时关联关注全集**（2026-09 定案）：全集 `state.followedUids` 经 `services.loadFollowedUids()` 全量 `groupId:'all'` 加载（不受关注分组影响），init / 域切换 / `followings` 事件三处刷新；记录无 `uid` 或全集未加载成功（`state.followedUidsLoaded` 为假）时**不归判**，避免把已关注作者作品误算为未关注引入误删。**禁止改用扫描快照 `authorFollowed` 做该判定的主判据**。

### SearchBar 视图阶段缓存与筛选切换性能（2026-09 定案）

大库（十万级）搜索态下过滤切换的耗时由三部分叠加：视图重复计算、字符串归一化重复分配、
筛选态全量拆建 DOM。对应三层定案如下，**回退任何一层都会复现切换卡顿**：

- **三段视图流水线（`#viewCache`）**：`getWorksView`/`getFollowingsView` 拆为
  `base`（关键词/类型/归属过滤）→ `sorted`（排序）→ `view`（逆序）三段，各段以自身输入
  签名增量失效——切类型/归属只重算 base 及其后，切排序从缓存 base 重排，切逆序只翻转一次
  拷贝。数据侧失效判据是 **`state.dataVersion`**（见下条），`baseSource` 引用相等作冗余校验。
  **视图函数返回共享缓存数组，调用方一律只读**（网格/Detail/Batch 现有调用均为只读遍历）；
  需要变更序（reverse 等）自行拷贝。逆序段必须拷贝后翻转，原地 reverse 会串段污染缓存。
- **`state.dataVersion` 写入版本号（红线）**：视图缓存的唯一数据侧失效判据。store 的域数据
  变更方法（set/appendWorkRecord/spliceWork/removeWorkRecordSilent/removeFollowingsSilent）
  与 `services.loadFollowedUids`（归属判定输入）自动自增；**绕过 store 封装的
  原地写入必须手动自增**——现存两处：`main.js` `tryHeadInsert`（头插 splice）、
  `applyStoreUpserts`（原地替换 `list[idx] = work`）。新增绕行写入点若漏增，视图缓存
  将读到脏数据（漏增不炸、错显，最难排查）。
- **关键词归一化侧表（`lcFields` + WeakMap）**：每条记录的 desc/nickname/id/uid 小写形与
  作者簇键（authorCount 口径）惰性缓存一次。用 WeakMap 而非往记录挂字段：记录经
  EXPORT_DATA 原样序列化，挂字段会污染导出 JSON；options 侧内容更新一律整对象替换，
  旧对象连同缓存一并失效。authorCount 全库 rank Map（counts 只依赖数据源、与筛选正交）
  同理按 source 引用缓存于 `#rankCache`；排序走 decorate-sort-undecorate（比较键预计算成
  并行数组），禁止改回 comparator 内逐对字符串拼接 + Map 查找。
- **单次视图计算 + 恒等快速路径（`refreshGridView`）**：视图只算一次，同一数组贯穿渲染与
  计数（历史实现经 renderCards/syncCount 各算一遍）；结果数组与 `#lastRenderedView` 恒等时
  跳过重渲只刷计数（切了不改变结果集的筛选、重复点击同段成本归零）。`refreshGridView` 是
  renderCards/renderFollowingCards 的唯一调用方，`#lastRenderedView` 仅在其渲染分支写入——
  域/分组切换必经数据重载（dataVersion 自增 → 数组重建），不存在「DOM 已清场但数组恒等」
  的假跳过。
- **筛选态降档预铺 + 键控扩容**：筛选态是封闭视图（无未来分页、无 fillSlots 回填方），预铺
  降档至 `GRID_PREMOUNT_CAP_FILTER`(600)，滚近底部 `#extendIfNeeded` 键控分支从 `#viewItems`
  快照锚接续铺真实键卡（锚 = 槽尾带键卡在快照中的下标，DOM 实况推导；渐进态维持无键占位卡
  + fillSlots 回填不变）。**封闭态扩容禁止退回无键占位卡**——没有回填方，永久灰卡。
- **筛选切换不保滚动位置（2026-09 定案，反转旧「筛选切换锚点」）**：切筛选/排序/逆序即新
  结果集，重渲后 wipe 天然回顶、从头浏览——撤销了 captureViewportAnchor/restoreViewportAnchor
  三段式（其恢复时机早于两段式铺设的拼装完成，深锚会被 clamp 到错误位置，且与「新结果集
  从头看」的预期语义相悖）。锚点仅保留两处：详情退回网格（`restoreGridScroll`，网格 DOM
  不重建、直接实测）与侧边栏开合/拖宽（`Sidebar.#preserveAnchor`，几何变化后同卡同位）。

### CSS 协同约定（.hidden 成对声明）

自带 display 值的组件类与通用 `.hidden` 同用时，**必须成对声明 `.X.hidden { display: none }`**。原因：通用 `.hidden` 定义在 options.css 前部（约 66 行），同特异性（0,1,0）下会被文件后部组件规则里的 `display: flex/…` 覆盖，`hidden` 类静默失效、占位层常显（曾导致作品卡中央 emoji 常显、关注卡头像旁多出一个空占位圆）。既有先例：`.work-type-badge.hidden`、`.following-avatar-fallback.hidden`。

### 骨架模板同构要求（原地切换的配套约束）

骨架模板必须与完整卡在根层同构：

```
.work-card       > .work-media + .work-checkbox + .work-info(.work-title-text + .work-author)
.following-card  > .following-checkbox + .following-main(.following-avatar/.following-avatar-fallback
                                          + .following-nickname) + .following-stats
```

媒体子树等可从完整模板取新节点移入；unloadObserver 因此持续观察同一根节点无需重挂，fill observer 在 `#demote` 时重新 observe。新增会替换卡片 DOM 的逻辑必须保持 dataset key 与两个 observer 的交接（`populateItem` 负责 observe 完整卡）；`updateCardsDOM` 已兼容骨架态。

### STORE_CHANGED 增量收口管线（options 侧合并处理）

载荷与发送侧语义（point/bulk、`changed>0` 门控、`GET_WORKS_BY_IDS` 补拉）见 [10](./10-storage-write-and-import.md)；options 侧接收管线在本册定案。

- **合并处理节奏**：隐藏期只标脏（rAF 冻结期拉数据/排队渲染皆白做）、回前台 `visibilitychange` flush 一次、可见期 300ms 去抖——逐件保存连发只触发一次收口（排队 N 次全网格重载会让回扩展页首帧卡死，2026-09 定案）。
- **flush 时统一走局部应用管线，逐条分流**：
  - state 内已存在 → 原地替换 + `updateCardsDOM` 批量更新（入口一次建 id→下标 Map 替代逐条 findIndex 的 O(N×M)；网格侧一次 `querySelectorAll` 建 id→卡映射，逐卡注入调用方持有的合并记录，免逐条 state.find + querySelector）；
  - 新增落在当前视图内 → **头插收口** `tryHeadInsert`：state 按视图序二分落点 + 网格 `insertItems` 原地挂载（含视口锚定补偿），零整刷。落点计算与落库分离——全部在原始 list 上二分（sorted 与 list 同为视图序，落点单调不减），runs 按「同原始落点」分组后**逆序** splice / insertItems（O(条数×N) 搬移收敛为 O(runs×N)；网格侧 #slots 尚无前序 run 的插入，原始落点即对位下标，逆序插入不改变已插区段相对位置）；bulk 载荷先经 `GET_WORKS_BY_IDS`（`DomainHandlers.getByIds` 主键直取）补拉合并后记录再走同管线；
  - 新增落在当前视图外 → 仅 `refreshGroups`（分组计数重算）；
  - 守卫不过（在途分页加载 `services.isGridLoading()` / 快滚冻结 `grid.isScrollFrozen()` / 预铺待消费 `state.gridSlots` / 筛选 / 批量 / 详情 / 口径意外 / **规模超限**）→ 整域重载兜底，正确性优先，不得绕过守卫强行走增量。
- **增量路径的规模守卫（2026-09 定案）**：bulk 补拉 id 数超过 `GRID_PREMOUNT_CAP`(1500) 在 `applyBulkChanged` 入口直接整刷兜底——`insertItems` 为每条挂一张骨架卡，超预铺容量即突破活 DOM 规模封顶；补拉响应是全记录过消息通道（千条 ≈ MB 级 structured clone），入口拦截省一次巨型往返。`tryHeadInsert` 不重复设防：其输入经调用方有界（点载荷 ≤ `UPSERTS_MAX`=8、bulk 路径 ≤ 上述上限），超大新增的兜底统一发生在补拉入口。
- **落点比较器必须与 `savedAt_id`/`groupId_savedAt_id` 索引的 prev 遍历同序**（savedAt 降序、平级 id 降序）——错序会在平级记录间插错位（下次整刷自愈但不该发生）。
- **域不匹配（跨域回声，如批量入库的 works 广播绕回点赞/收藏域）接收时直接丢弃**，连分组重算都省；flush 时刻须再校验域一致（接收后用户可能已切域，过期载荷不能信）。
- **红线**：新增落当前视图禁止改回「视图内新增 → `loadDomainData` 整刷」（wipe→灰骨架→封面重探即用户感知的「页面闪烁」）；bulk 广播载荷只带 id 集，禁止改回广播全量记录（万级消息膨胀）。

## 异常场景及处理

| 场景 | 表现 | 处理/禁止事项 |
|------|------|----------------|
| 绕过 store 的域数据原地写入未自增 `state.dataVersion` | 视图阶段缓存读到脏数据（新条目不出现、删除条目残留、归属判定过期），不炸只错显 | 现存三处手动自增点（main.js 头插/局部应用、detail.removeWork）；新增写入点必须同步自增（见「视图阶段缓存」节） |
| 调用方原地变更 `getWorksView`/`getFollowingsView` 返回数组 | 污染共享缓存，后续视图/计数/Detail 导航全部串位 | 视图函数返回共享缓存数组，调用方只读；需要变更序自行拷贝 |
| 封闭视图（筛选态）扩容克隆无键占位卡 | 没有 fillSlots 回填方，第 601 张起永久灰卡 | `#extendIfNeeded` 键控分支从 `#viewItems` 快照取真实条目；锚失配不扩容留待整刷自愈 |
| 键控扩容的在册判定写反（`!#itemMap.has` 才克隆） | render 已把视图全集登记进 itemMap，条件恒假 → 扩容全落无键占位卡，封闭视图 600 以远永久灰区（2026-09 修复） | 在册（`itemMap.has` 命中）才克隆带键卡；快照含已移除条目（removeItems 已从 itemMap 摘除）时落占位兜底 |
| `removeItems`/`insertItems`/`appendItems` 不同步维护 `#viewItems` | 键控扩容的锚接续取数错位（复活已删条目/漏掉新插条目） | 三个变更原语与快照同步维护（filter/splice/push） |
| 筛选态改回全量预铺（预铺数 = 结果数） | 每次筛选切换付出 O(结果数) 的骨架克隆 + 整容器布局（十万级 = 秒级卡顿） | 封闭视图预铺恒为 `GRID_PREMOUNT_CAP_FILTER`，余量键控扩容 |
| 视图计算在渲染与计数间各跑一遍（改回 `syncCount()` 内重算、renderCards 内重取） | 大库下重复整段过滤+排序（每遍 30–100ms 起） | `refreshGridView` 单次计算贯穿渲染与计数；`syncCount` 接受注入 count |
| 哨兵卡被 `removeItems` 删除 | 分圈观察断链，后续骨架永不 observe | 删除后立刻续接哨兵 |
| `removeItems` 只 splice `#slots` 不收缩 `#totalSlots` | 差额被 `#extendIfNeeded` 当作未铺配额，滚近底部时原样补回等量无键占位卡——被删卡片的骨架永久滞留（2026-09 修复） | 两者必须同步收缩；拼装窗口内无连接卡的已删条目同样计入（其节点挂载前被对账丢弃、永不占槽） |
| 快滚停稳直接清空积压填充队列 | 积压卡入队时已 unobserve，滚回带区再无 IO 触发——被快滚扫过的区段永久停在骨架态（2026-09 修复） | `#refillBand` 丢弃前全量重新 observe；快滚判定基准只在 scroll 事件侧推进（rAF 双读者各自推进会互相污染 delta，冻结逐帧被打断） |
| 原位整刷（等高重渲）后视口带区骨架无人观察 | wipe 与重挂同任务同步完成、前后内容等高 → 滚动位置保留、无 scroll 事件；分圈哨兵停在网格顶部够不着中部视口，`#catchUpToViewport` 只由 scroll 事件调度——批量同步 SYNC_DONE 整刷后卡片滞留灰骨架，手动滚动才出封面（2026-09 修复） | `#finishRender` 收尾统一补一次 `#scheduleCatchUp`（与 scroll 触发共用同一追赶机制；rAF 下一帧测量时全量挂载已完成） |
| 拼装窗口内删除的条目照常挂载 | 带键但 itemMap 已无条目的无主骨架，`#doFill` 永远填不上（永久灰卡） | 挂载前按 itemMap 对账，死节点不挂载不占槽 |
| 余量骨架未挂载就交接观察 | `#extendObservation` 把未连接节点视作重渲染死节点直接丢弃，分圈断链 | 拼装完成后必须先 `appendChild` 挂载、再 `#observeNewSkeletons` |
| fill IO 回调对占位卡 unobserve | 预铺占位卡被摘除观察后，回填完成也永不再触发填充（永久灰卡） | 回调对无键占位卡保持观察；带内回填由 `fillSlots` 主动入队 |
| 网格卡片层挂 `content-visibility: auto` | 屏外卡整棵跳过渲染（无像素），远跳落点要走「相关性判定→补布局→绘制→光栅」按需管线，瞬间只见空占位框（透底色）、骨架延迟出现；快速滚动期 CV 进出判定 = Layerize 抖动 | 网格全量预铺架构下禁用 CV（2026-09 定案，`.work-card`/`.work-skeleton`/`.following-card`）；骨架扫光随之静态化（动画元素各自晋升合成层，万级下成本不可接受） |
| 渐进分页经 `'works'` 事件逐页 `store.set` 消费 | 每页触发全量重渲：骨架闪烁、已填卡封面重探 | 回填必须走 `appendWorkRecord` → `fillSlots`；筛选激活时静默累积、加载完整渲 |
| `render()`/`abortRender()` 未清队列状态 | 旧骨架引用残留、重复填充 | 重置时同步清 `#pendingSkeletons`/`#sentinelCard`/observers |
| 用 `replaceChild`/`replaceWith` 换卡片根节点 | Blink 全量重排，3000 卡单次 >10ms | 只允许原地切换（改类名 + 增删后代） |
| 把填充/卸载两圈 rootMargin 调近 | 边界抖动、反复填/降级 | 保持滞回间隙（1600px vs 2400px，800px） |
| 媒体重试自行计数 | 与熔断窗口叠加放大请求量 | 一律接 `Detail.markMediaFail/mediaRetryBlocked` |
| 在途探针回调不校验代际 | 旧 URL 提交到已换人槽位（错图） | 先验 fillGen/coverGen/gen/imgProbeToken 再提交 |
| hover 预览改用 pointerenter/leave | 功能静默失效 | 只用冒泡的 pointerover/out 委托 |
| 旧网格不 abort 直接保画面（"不清场保无闪烁"及其「冻结-定格」变体） | 在途工作不中止 + 同容器重建聚帧，体感卡顿；定格变体被用户定案否决（旧画面定格感知为卡顿，必须先清空） | 切换瞬间 `clearActiveGrid()`（abortRender×4 + wipe）先清空，数据到达后 render() 重建 |
| 只改 options 或 content 任意一侧的 toast 样式 | 两侧视觉漂移（options `.toast` 与 content.js `Toast` 内联样式是两处同款实现） | 两侧同步：13px 字号 / `7px 16px` 内边距 / 6px 圆角 / `top:20px` / info`#60a5fa`·success`#4ade80`·error`#f5222d` 左色条 / info·success 2s、error 4.5s / `max-width:80vw` 允许换行；文案不带 emoji |

## 配置项说明

options 侧 `config`（50 键，含 icons 图标表）的权威键表与默认值统一维护在 [01](./01-project-architecture.md)「配置项说明 · options/core.js 顶层 config」，本册不再重复分表；各分册只收录与其机制直接相关的键（如 `GRID_PREMOUNT_CAP`/`FAST_SCROLL_THRESHOLD` 见上文渲染管线）。

## 响应式状态管理（store.on 事件表）

> 本节自 AGENTS.md 迁入（2026-10-03 瘦身）。`store.on()` 监听事件：

| 事件               | 处理                                                                                                     |
|--------------------|----------------------------------------------------------------------------------------------------------|
| `'domain'`         | 更新同步按钮、渲染分组 tab、加载域数据 |
| `'works'` / `'favorites'` / `'collections'` | `search.refreshGridView()`（仅 domain 命中该域时）                                                       |
| `'work-record-appended'` | 渐进分页回填（作品型三域，loadDomainData 逐页发）：默认视图 `fillSlots` 回填 + `syncCount`，`done` 时 `pruneEmptyTail` 摘尾；筛选激活时静默累积、加载完成整渲；domain/groupId 双校验防旧页混入（细节见本册「STORE_CHANGED 增量收口管线」） |
| `'followings'`     | 刷新关注全集（方案A 归属判定输入）+ domain 命中或归属筛选激活时 `search.refreshGridView()`                |
| `'groups'`         | `groups.renderGroupTabs()`                                                                               |
| `'currentGroupId'` | `appShell.clearActiveGrid()` + `groups.syncActiveTabs()` + 加载域数据（tab 集合未变，不重建 tab）         |
| `'batchMode'`      | toggle body `.batch-mode` class + `Batch.syncSelectionUI`（批量栏显隐由 CSS `body.batch-mode` 驱动，无独立 #batchBar）        |

## 相关文档

| 编号 | 文档 | 关联内容 |
|------|------|----------|
| 01 | [01-project-architecture.md](./01-project-architecture.md) | options/ 代码布局约束、进度消息载荷表、CANCEL_ACTIVE_TASK 双路径 |
| 02 | [02-independent-sync-works.md](./02-independent-sync-works.md) | SYNC_PROGRESS/SYNC_DONE 的产生侧（本册的消费侧过滤） |
| 03 | [03-independent-sync-followings.md](./03-independent-sync-followings.md) | FOLLOWING_PROGRESS 时序（#requestId 过滤的上游） |
| 07 | [07-independent-fetch-user-works.md](./07-independent-fetch-user-works.md) | 侧边栏滚动加载的数据来源 |
| 09 | [09-inject-tab-mode.md](./09-inject-tab-mode.md) | CANCEL_ACTIVE_TASK 抵达 inject 的后半程 |
| 10 | [10-storage-write-and-import.md](./10-storage-write-and-import.md) | 网格数据源（GET_WORKS/GET_FOLLOWINGS 结果）的落库语义 |
| 12 | [12-class-map.md](./12-class-map.md) | options 侧各类职责对照表（本册机制细节的上层导览） |
