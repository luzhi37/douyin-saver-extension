# 11 · 管理页渲染与交互（options/ 模块化）

> 职责边界：options/ 各模块的渲染与交互子系统机制——VirtualGrid 双向虚拟化、Sidebar 升降级虚拟化、媒体加载统一体系与全局熔断、悬停预览事件委托、批量勾选 DOM 约定、弹窗锁定与取消门控、CSS 协同约定。数据流与消息协议见 [01](./01-project-architecture.md)；写入语义见 [10](./10-storage-write-and-import.md)；抖音页面注入侧见 [09](./09-inject-tab-mode.md)。

## 概述

管理页要在单页内承载数千张卡片与条目，渲染层的一切设计都围绕两个约束：**不换根节点**（任何 grid 直接子节点被替换都触发 Blink 全量重排，成本随卡片总数线性增长）与**媒体生命周期显式管理**（探针先行、代际防乱序、全局熔断）。本文收录各子系统的机制定案与历史踩坑结论，改动前先读对应小节的"禁止"条款。

## 核心流程图（文字描述）

### VirtualGrid 渲染管线（双向虚拟化 + 分圈观察 + 活动窗口 + 尾部占位）

自适应卡宽（2026-10 定案：拉伸填满，替代「固定卡宽 + auto-fill 取整」）：列数由`#applyLayout` 在容差带（作者域 [`CARD_SIZE_BAND_MIN`, `CARD_SIZE_BAND_MAX`] / 作品域 [`WORK_CARD_SIZE_BAND_MIN`, `WORK_CARD_SIZE_BAND_MAX`]×理想卡宽，按实例覆盖）内取「拉伸填满后最接近理想卡宽」的候选列数——w(c) = (W−(c−1)·gap)/c 随 c 单调递减、偏差V 形，线性扫全程即全局最优；新列数只会 ≥ 旧 floor 值（密度不回退），带内实际卡宽恒等于w(cols)、右缘余量恒为 0；无可行解（相邻列宽差跨过整个带宽）时容差带按**硬约束**处理——取较少列（hi 列）、卡宽钳到上限，余量由 justify-content: center 均分，**不再向下破下限**（2026-11 定案：破下限会让侧栏固定的「最小卡宽」反过来比网格卡更宽）。结果以 inline style 写共享容器（`gridTemplateColumns` 定列 +`--dy-card-actual` 供 `.work-card` 宽高联动；两域理想卡宽经子类传入的 `cardSizeVar`从 CSS 变量读取，works 249 / followings 212），样式表 `repeat(auto-fill, …)` 仅作未落笔兜底。容器宽变化（窗口缩放/侧边作品栏拖宽）分两条路：RO 观察的是 **#mainGrid**（稳定节点）而不是 #mainContainer——容器是本类唯一会写尺寸的对象（轨宽/上下占位/铺卡都改它的高度），在观察它的回调内写入会触发浏览器的「ResizeObserver loop completed with undelivered notifications」告警；回调内只读宽度、把落笔**推迟到下一帧 rAF**（窗口缩放容忍一帧延迟）。RO 回调入口 `#onContainerResize` 按活跃实例门控——七个网格实例（works/favorites/collections/followings/candidates/reviewWorks/reviewAuthors）共享同一容器、各自 RO 都会触发，`#observer`/`#chunkRaf` 仅活跃网格非空（render 建链、abortRender 断链），据此互斥落笔。侧边作品栏拖宽/开合走 `syncContainerWidth()` 同步路径（调用方 mutate 后直接调用）：读新宽 → 落轨宽 →锚点补偿一次完成，锚点卡由 `setResizeAnchor` 登记（未登记回退视口最上方卡）。改宽前的首测落在 mutate 后的洁净布局上（免费），落笔后的次测即绘制前必然发生的那次重排——总重排次数不增；原实现「测前→mutate→测后」会在改宽前先强制一次 O(已挂载卡) 重排（2 万卡改宽卡顿的主因之一）。改宽当帧 `#skipWindowOnce` 跳过窗口重挂（锚点已钉回）。随后 `#scheduleCatchUp` 的 rAF 统一补占位与视口带区：只读操作（扩容探测/带区追赶）在前、`padding-bottom` 写入收尾——帧内写后再读会多逼一次强制布局；改宽当帧经 `#skipExtendOnce` 跳过扩容探测（锚点保持⇒ 视口相对真实内容底不变）。尾部占位几何按「列数×卡宽」缓存（`#reserveKey`）：滚动帧零测量（原实现每帧扫首行至多 64 张 gBCR），改宽后重测一次即可。#applyLayout 在列数/卡宽均未变化时直接跳过落笔。#mainGrid 必须保持 `scrollbar-gutter: stable`：精确填满使卡宽成为容器宽的函数，竖向滚动条出现/消失会反向改容器宽、与布局互锁成振荡（半屏卡片闪烁 + RO loop报错的根因），恒定槽位使容器宽与滚动条解耦。#applyFill 带区估算与 works-grid scrollTo 兜底优先消费落笔值（`getGridLayout()`），与 CSS 实际轨宽一致。render() 内落笔时序在 `#resetRenderState`**之后**（后者清布局字段）。

分组与域切换同序列清场（2026-09-27 用户定案：点击必须先清空，「旧网格冻结-定格」方案否决——定格被感知为卡顿）：分组走 `currentGroupId` 事件、域走 `switchDomain`，二者都在切换瞬间经`appShell.clearActiveGrid()` 同步 abortRender×7（七个网格实例）+ **O(1) 换空壳**：`stale.replaceWith(fresh)` 令滚动高度瞬间塌缩、画面立即清空——任何「移除 1 万节点」的操作（replaceWith/innerHTML 皆然）都是 O(N) 整树脱离 + 布局对象销毁，阻塞在点击路径上就表现为滚动条迟迟不缩到目标尺寸；脱离渲染树的旧子树由 `#destroyDetached` 在空闲期分批销毁（requestIdleCallback，每轮 8ms 预算逐个移除直接子节点，不可用兜底 setTimeout 0），拆卸与 GC 摊到空闲帧、离开点击关键路径。容器级事件委托（click/pointerover/out/input）绑在 `#mainGrid`（稳定节点）上，换容器零重绑；网格经`attachContainer` 重指向。数据到达后由 render(items) 首屏同步铺骨架、余量拼装一次挂载并按槽回填——点击→首屏的空白收敛为「首页小页（`PAGE.GRID_FIRST`=600，恰为活动 DOM 上限 GRID_MOUNT_MAX，仅够铺满首屏窗口）+ 余页按 `PAGE.GRID` 续传」的一次读取往返；切域监听内首页请求**先发**；旧域分组 tab 立即清空，`GET_DOMAIN_GROUPS` 只读对应 `*_groups` 小表，名称/顺序/计数同一响应到达后一次渲染（计数为 `*_groups.count`，由写入维护、升级 v11 回填，不扫数据表）；**作者主键集（GET_AUTHOR_UID_SETS）延后**（`services.whenFirstScreen`）：主键集在首屏渲染落笔后一个宏任务取（chip 到达后 `syncAuthorFlags()` 原地 patch）。首帧只等 page-0 一条往返。滚动位置随 wipe clamp 归零。

数据侧与渲染侧衔接（`services.loadDomainData`，作品型三域分页渐进）：首页（`GET_WORKS page:0`，bg 端复合索引 keyset 游标直出、**首屏只物化 `PAGE.GRID_FIRST`(600) 条** + `total` 计数，余页按 `PAGE.GRID`(1000) 续传——较 2000 减半把单页反序列化长任务切碎）到达即`store.set` → render() 按 `total` **预铺至 `GRID_PREMOUNT_CAP` 上限**（未到达槽位为无键占位卡，超出上限的部分滚近底部时倍增扩容——滚动条物理上到不了未挂载区，远跳落进空白结构性不存在）；**续页循环在首屏渲染落笔（`state.gridSlots` 被 `renderCards` 消费）且让出一次空闲期后才启动（`services.whenFirstScreen`，首屏错峰；分组计数/作者主键集等装饰性请求共用同一 Promise 先行等待）**——避免续页长任务与并发 IDB 请求把首屏填充、封面探针挤到后面；余量以 `nextCursor`（末条索引键）keyset 续页 `appendWorkRecord`→ `work-record-appended` 事件 → 默认视图 `fillSlots(start)` 按键前缀自锚定回填（零 DOM 增删；落点 = 传入 start 与首个无键槽取小者，删除使 #slots 相对页序收缩时自愈）、`done` 时`pruneEmptyTail` 摘除尾部未回填占位卡（预铺超出的兜底残余，removeItems 已同步收缩 #totalSlots）；筛选激活时静默累积到加载完成再整渲（逆序/作者聚类破坏页序对齐；`renderCards` 消费额度时按 `isFilterActive` 跳过预铺）；关注/候选两域保持单发全量：

```
render(items, emptyMsg, emptyHint, totalSlots, premountCap = GRID_PREMOUNT_CAP)
  → 容器 wipe（render()/abortRender() 重置时必须同时清 #pendingSkeletons / #pendingAppends /
    #slots / #viewItems / #sentinelCard / observers；点击即清场路径滚动随 wipe clamp 归零）
  → #viewItems = items.slice()（视图快照：键控扩容取数源；浅拷贝隔离，头插/移除/追加
    原地维护本表，不反噬调用方数组——SearchBar 视图缓存数组只读）；#viewKeys 为其键集
    （登记去重）。#applyFill 的槽位回填同样补登——快照始终覆盖「已加载条目」全集，
    包括已加载但未挂载的尾部
  → #totalSlots = max(totalSlots, items.length)；铺槽数三重上限（与视图形态无关）：
      slotCount = min(#totalSlots, premountCap, GRID_MOUNT_MAX)
      （筛选态 premountCap = GRID_PREMOUNT_CAP_FILTER；活动 DOM 硬上限 600——改一次卡宽要对
       每张已挂载卡重排内部子树，实测约 60µs/张：2000 张 = 120ms+，600 张 ≈ 20ms）
      ——已加载但超出上限的条目只登记进快照/#itemMap，不挂 DOM；余量行高由**尾部占位**
      （#syncTailReserve：容器 padding-bottom 预留，纯 style 写入零追加）在渲染首帧把
      滚动条总长收敛为已知条目终值——卡片滚近按需铺入、占位等量收缩，净高恒定无滑块回退
      （2026-10 定案；自动翻页全量挂 DOM 会让 2 万条目录入完成后每次改宽都全量重排）
    首段同步挂载前 RENDER_CHUNK_SIZE 个（真数据骨架优先，缺口为无键占位卡）；首段节点打
    data-fade（入场动画仅限定首屏，CSS `.work-card[data-fade]`——筛选切换/扩容的数百张卡
    不再同帧起 350ms 动画，滚入/回填直接呈现），挂载后交接分圈观察
  → 余量按 RENDER_BUILD_BUDGET_MS 时间预算分帧拼装（保持游离态，脱 DOM 不触发布局），
    拼完挂载前对账（拼装窗口内被 removeItems 删除的条目不挂载不占槽），再向容器一次挂载并
    交接观察——容器全程只经历 2 次插入，布局只剩收尾 1 次 O(N)
      （禁止改回首段逐帧向容器追加：每帧 append 都触发全容器 grid 重排，总成本 O(N²/块)。
        封闭视图余量一律走尾部占位 #syncTailReserve 纯 style 预留——禁止任何「预挂/后台
        补铺余量卡」路线，实测大 M 下每次追加都是数百 ms 级全网格重排）
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
  → 槽位越界/已占键 → 逐条回退 appendItems：登记进 #viewItems/#itemMap（活动 DOM 已到
    上限时只登记不挂载），已加载未挂载的条目由滚近键控扩容铺真卡
  → done：pruneEmptyTail 摘除尾部未回填占位卡（兜底），#totalSlots 收敛到已加载条目数

带键骨架进入滚动口+1600px 预填带（OBSERVER_ROOT_MARGIN，≈4 行）→ #enqueueFill 入队
  （1600 定案：600px 只给 0.4-0.7s 领先量，会被结构填充后的封面探针网络延迟吃光，正常
    滚速下骨架可见；4 行给探针完整网络提前量。须 < OBSERVE_CHUNK_SIZE 单圈行距 2400px
    ——哨兵链观察前沿要永远盖得住填充带）
  → rAF 分帧填充：每帧最多花 FILL_FRAME_BUDGET_MS(8ms) 即让出主线程
  → populateItem 原地构建完整卡 → 转卸载 observer observe 完整卡（fill 观察在填充入队时已 unobserve）

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

尾部占位（#syncTailReserve；触发点：#finishRender 收尾 / #scheduleCatchUp 滚动帧 /
  铺卡后 / removeItems 与 pruneEmptyTail 后 / 追加登记后）
  → 容器 padding-bottom 按「已加载行数 − 头部回收行数 − 已挂行数」× 行高预留
    （known = min(#totalSlots, 快照长度)；列数取 #applyLayout 落笔值、行高跨行实测一次
    并按「列数×卡宽」缓存，域无关）——纯 style 写入零追加，滚动中内容零增长、滑块无回退
  → 占位只覆盖**已加载**条目：未加载的尾部保持滚动不可达（杜绝「远跳落进空白」）；已加载
    未挂载的条目滚近由键控扩容铺真卡。渐进加载期 known 随页到达增长，滚动条总长与
    「边加载边追加」一致、done 时不跳变
  → render/abort 经 #resetRenderState 清占位（wipe 的 inline style 必须显式还原）

滚近按需铺卡（#extendIfNeeded，随滚动 rAF 检测）
  → 真实内容底（容器底 − #tailReserve）距视口底不足 GRID_EXTEND_THRESHOLD(1.5) 屏且
    #slots.length < #totalSlots → 扩容铺卡 + 占位等量收缩（净高恒定，滑块不动）
  → 视口带区已越过真实内容底（拖拽跳进占位区）→ 按带区直铺追赶（#scheduleRush 逐帧续铺
    至覆盖即止，单步上限 GRID_EXTEND_JUMP_STEP 防长冻结）
  → 步长 = min(倍增, 单步上限 GRID_EXTEND_STEP)，槽位来源：
      快照已覆盖的槽位一律键控——扩容卡带真实键，从 #viewItems 快照锚接续取条目
      （锚 = 槽尾最后一张带键卡的键在快照中的下标，DOM 实况推导，免维护游标不变量；
      锚失配不扩容留待整刷自愈）。活动 DOM 上限后「已加载未挂载」的条目全靠本路径铺真卡，
      无键占位卡会永久灰卡
      快照尚未覆盖（页未到达）：克隆无键占位卡，数据页经 fillSlots 自锚定回填
      （未加载的尾部物理上滚不到——「远跳落进空白」结构性不存在）

活动 DOM 窗口（#syncWindow / #remountWindow；核心：改一次卡宽要对每张已挂载卡重排内部
  子树，实测约 60µs/张，2000 张 = 120ms+，所以已挂载数必须恒定而不随总条目增长）
  → 槽位 0 对应视图下标 #headTrim（头部回收），容器 padding-top = #headRows × 行高；
    padding-top + 窗口高度 + padding-bottom ≡ 总行数 × 行高——虚拟滚动空间不变，
    重挂时 scrollTop 逻辑上无需修正
  → **可挂载/可滚动的宇宙 = 已加载条目数（known = min(#totalSlots, 快照长度)）**：
    窗口行范围、扩容目标、尾部占位同一口径。分页中断或组计数与实际页数据不一致时，
    若用首页 total，窗口会冲进「没有数据的尾部」——整屏永不填充的占位骨架，且每重挂
    一次就把滚动空间再往前推一段（表现为「滚到底还能无限滚」）
  → **扩容目标必须换算到窗口系（#headTrim）**：headTrim > 0 时 #slots.length 是窗口内
    槽位数、known 是视图系总数，两者不能直接比大小。判定用 mountedEnd = headTrim + slots，
    上限用 min(GRID_MOUNT_MAX, known − headTrim)；#slotsToReach 返回视图系下标，先减
    headTrim 再参与取大。混用（next = min(known, slots×2)）会让窗口每滚动一次就多铺出
    headTrim 张无键占位卡（视图空间被无数据区撑长：整屏骨架 + 可无限下滚），且这些
    占位卡会随重挂反复再生
  → 触发（#scheduleCatchUp 滚动帧 / #scheduleSettleCheck 停稳）：
      视口完全离开窗口（拖拽滚动条/远跳）→ 立即重挂（否则整屏空白，快滚期也不等）
      视口在舒适带内 → 不动；离开舒适带（留半幅滞回）→ 重挂到「视口行 − pre」
      窗口已铺到已加载末尾时（windowEndRow ≥ totalRows）下滚不再重挂——下方没有可预铺
      内容，继续按舒适带触发会让 target 逐行 +1、每滚一行整窗重建（活动卡反复回退骨架）
      任何路径（批量位插等）把窗口撑过 GRID_MOUNT_MAX → 停稳后重挂收回
      总条目 ≤ GRID_MOUNT_MAX → 不窗口化（#headTrim 恒 0，行为与旧版一致）
  → 重挂 = 停媒体 + 断双观察器/清队列 + 新旧窗口重叠区按 itemKey **复用原卡节点**
    （已填充卡保留封面/文案，仅新跨入窗口的边行克隆骨架；整窗从快照重克隆会让视口内
    全部卡瞬间回退灰骨架再淡入——滚动期「网格闪一下」的根因）+
    一次 replaceChildren + 写头部/尾部占位 + 按「占位差 − 行差 × 行高」差值精确平移 scrollTop（保留行内偏移）
    （只靠 padding 保位会随行数累积行高舍入误差，实测约 1600 行偏 50px）；
    复用的完整卡交回 unloadObserver、骨架清 observed 标记后交回分圈填充队列
  → 改宽当帧：头部占位按解析行高（子类 rowHeightFor；行高与卡宽无关的域用实测缓存）
    零读取重算，与锚点补偿在同一帧收口——重挂不在改宽当帧跑（RO 后视口已钉回）
  → 索引换算：#applyFill / insertItems / removeItems 一律以视图下标工作，窗口内换算
    slot = view − #headTrim；头插落在回收区只登记快照（不挂卡）并同步后移 #headTrim
    （padding-top 随之上抬，按占位增量补偿 scrollTop，保持视口内容不跳）；
    删除落在回收区时 #headTrim 随视图前移；#isClosedView 已随快照补全退场
  → **硬不变量：`total ≤ GRID_MOUNT_MAX ⟺ #headTrim === 0`**——删除使已加载数跌破上限
    （或窗口被掏空）却仍残留窗口时，必须重挂回顶铺满（`removeItems` 即时收口 +
    `#syncWindow` 非窗口化分支兜底），否则头部回收区只剩 padding-top，上滚整屏空白；
    `#totalSlots` 收缩下界取视图系剩余数，空态按数据（known）而非 `container.children` 判定

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
  #createWorkItem 只把 {url, cover, placeholder, work, saveBtn, inWorks} 挂进 #workMeta（WeakMap），不发探针
条目进入视口（observer root=dom.sidebarBody, rootMargin=OBSERVER_ROOT_MARGIN）
  → #promoteItem：#enqueueCover 入队 → 每帧 SIDEBAR_IMG_PER_FRAME 张 rAF 发探针+绘制
滚出卸载圈（UNLOAD_ROOT_MARGIN）→ #demoteItem：
  cover.dataset.gen 自增作废在途探针 → 清背景图 → 恢复占位层（根不换，aspect-ratio 保尺寸）
重新滚近 → 重入新代探针（旧回调经 gen 校验后作废）
```

## 接口 / 方法签名

```js
// VirtualGrid（基类）
render(items, emptyMsg, emptyHint, totalSlots, premountCap) // premountCap 按态传（渐进 GRID_PREMOUNT_CAP / 筛选 GRID_PREMOUNT_CAP_FILTER）；封闭视图（totalSlots ≤ 已知条目数）首帧只铺上限张、余量行尾部占位预留（#syncTailReserve）；#viewItems 视图快照同步建立；**节点复用重排**：wipe 前按 key 收集旧窗口卡（骨架 / 已填充且条目对象恒等者），同键槽位搬运原节点（封面/文案/媒体态保留、零重探），同键异对象不复用；完整卡交卸载圈、骨架/占位走分圈填充观察；abortRender 同时清空 observer 与分圈/#slots/#viewItems 状态
fillSlots(startIndex, items)                  // 渐进分页按槽回填（零 DOM 增删；预铺拼装未完成时排队；落点按键前缀自锚定；错位逐条回退追加）。对齐模式（saved 排序键且取数方向=视图方向）下 startIndex 为**视图下标**（全量视图长度 − 本页可见条数），筛选子集不再依赖页域下标
pruneEmptyTail()                              // 加载收尾：摘除尾部未回填占位卡
appendItems(items)                            // 追加兜底（槽位越界/已占键时由 fillSlots 回退调用）；#viewItems 快照同步 push
insertItems(index, items)                     // 位插原语（STORE_CHANGED 增量收口）：state 与 #slots 对位 splice + 骨架卡挂载 + #viewItems 对位 splice，removeItems 的对偶；落点越界/重复键返回 false 交整刷自愈；头插卡插队到待观察队列最前（分圈哨兵停在旧网格尾部，向下链推进够不到文档更靠前的头插卡）+ 落点在视口上方时按锚点卡实测位移补偿 scrollTop；落在回收区（#headTrim 之前）经 #insertAboveWindow 只登记快照、同步后移 #headTrim，并按 padding-top 增量补偿 scrollTop
removeItems(idSet)                            // 单遍批量删除：摘 itemMap 记 known 集 → 单遍 #slots 收集命中卡 → 槽位表一次 filter 重建（禁改回 per-id querySelector + indexOf 的 O(N×M)）；#slots/#totalSlots/#viewItems 同步收缩；哨兵命中整批清理后统一续接一次
#extendObservation()                          // 哨兵触发时放下一批 OBSERVE_CHUNK_SIZE 个
#enqueueFill(card) → #scheduleDrain → #doFill // 时间预算制填充分帧
populateItem(skeleton, item)                  // 原地填充入口；负责 observe 完整卡（交接点）
#demote(card)                                 // 原地降级回骨架；fill observer 重新 observe
fillCard(card, item) / clearCard(card)        // 子类钩子：只允许改类名与增删根节点后代

// WorksGrid / AuthorGrid
renderCards(view) / renderAuthorCards(view) // view 无缺省回退；refreshGridView 是唯一调用方并恒注入现成视图；筛选态首帧预铺降档至 GRID_PREMOUNT_CAP_FILTER（余量行尾部占位预留）
#bindMediaEvents()                            // pointerover/out 容器级委托（见下文）

// Sidebar
openSidebar(author, sourceCard) / #loadMoreWorks() // author={uid,nickname,profileUrl}；触发 FETCH_WORKS_PAGE（见 07）
#createWorkItem / #promoteItem / #demoteItem / #enqueueCover / #scheduleImgDrain

// Batch / Detail / Sync
Batch.updateCheckboxDOM(checkboxEl, isSelected)
Batch.handleBatchSelectAll()                  // 按域选择 checkbox 选择器
Detail.markMediaFail() / markMediaOk() / mediaRetryBlocked()
WorksGrid.#scheduleCoverDrain / AuthorGrid.#showAvatarFallback / Detail.#imgProbeToken
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
    // ……（节选）：此处先有快滚门控——#scrollFast 停稳 epoch 检测命中则
    // #refillBand() 丢弃沿路积压 + #syncWindow() 整窗重挂，再落到下方填充循环
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
    checkboxEl.innerHTML = config.icons.check || ""; // 缺 checked 类则透明不可见
  } else {
    checkboxEl.classList.remove("checked");
    checkboxEl.textContent = "";
  }
  checkboxEl.setAttribute("aria-checked", isSelected ? "true" : "false");
}

handleBatchSelectAll() {
  const selector = utils.isAuthorRecordDomain() ? ".following-checkbox" : ".work-checkbox"; // 必须按域选择
  …
}
```

- **勾选框显隐由 `body.batch-mode` 纯 CSS 驱动（红线）**：基类 `.work-checkbox`/`.following-checkbox` 为 `display:none`，`body.batch-mode` 下才 `flex`。JS 侧（fillCard/clearCard/handleBatchToggle）**禁止逐元素写 inline display**——勾选框随卡片填充创建且滚出卸载圈降级（clearCard）时**即移除**，但万级域滚动后勾选框仍可达数千，逐个 style 写入会让进/出批量模式触发秒级样式重算+重排（2026-09 卡顿报告的根因）。退出批量只清 `.checked` 的勾选框（未勾选框本就无内容）。
- **批量禁选文本走 mousedown preventDefault，禁止 CSS user-select（红线）**：`.batch-mode` 系 user-select 规则（逐卡 `.work-card` 或容器 `#mainGrid` 继承覆盖均可）会随 body class 翻转触发全网格级联重算——容器继承方案更糟（继承传播让全部 ~4 万后代节点全量重算，5000 卡高保真复现实测 ~800ms/次，禁用后 43ms），是「进入批量模式卡顿」的主因。改为 main.js 在批量模式下对 `#mainGrid` mousedown `preventDefault()`（O(1)、零样式成本；限定主键并排除 input/textarea，保住视频进度条拖拽）。
- **Ctrl/Cmd 旁路（2026-11 修订）**：关注/候选域作者卡 Ctrl/Cmd+点击（任意区域，含头像/统计区/勾选圆）统一在新标签打开作者主页，不再打开侧边作品栏、不切换勾选、不退出批量模式（`AuthorGrid.handleClick` 顶部守卫）。作品/点赞/收藏域卡片**作者名的 Ctrl/Cmd+点击在新标签打开作者主页**，普通点击作者名打开侧边作品栏（`WorksGrid.handleClick` 链接分支，见「侧边栏作者上下文入口」）。**批量模式选中命中区收窄（保留正常点击语义）**：作品卡仅 `.work-media` 内容区参与选中；信息条不参与选中，作者链接在批量模式下仍按普通点击语义工作——作者名打开侧边作品栏（日期/空白信息区不改变选中态）。作者卡仅 `.following-main`（头像+昵称行）参与选中（头像随该行参与选中，非批量模式仍保持点头像打开主页）；该行以外的卡片区域保持正常点击语义——打开侧边作品栏。Ctrl/Cmd+点击外链不切换勾选、不退出批量；勾选圆/媒体控件保持原有行为。光标：作品卡根为 default、`.work-media` 为 pointer，作者链接自身保持 pointer 与 hover 变色；作者卡整卡 pointer（身份行选中、其余区域开侧栏）。**作者卡分区视觉**：卡片内容内边距与作品卡信息条共用 `--dy-card-pad-x/top/bottom`（8/8/6），顶部留白挂 `.following-main`（点击卡片顶部留白也命中选中区）；身份行（选中命中区）保持 `--dy-surface`，统计/更新行由 `.following-details` 以 1px `--dy-border` 分隔线独立成次级区块——不使用亮色面板、文字维持次级色，视觉重心保持在身份行；批量模式两处点击区域仍可按分隔线辨认。hover 只提亮卡片底色。
- **作者卡侧栏激活态**：与作品卡同款，仅替换整圈 `--dy-primary` 描边；禁止「`inset` 左色条 + 外部投影」组合——与 toast 的左色条+圆角+阴影视觉同构，易被误读为提示条（2026-11 修订）。
- **Shift 连选（2026-10-25 定案；显式减选模式已于 2026-10-28 移除；取序与锚点已于 2026-10-29 修正）**：Shift+点击 = 从上次点击锚点连选到目标；范围应用统一 `Batch.#applyRange` 按**网格已渲染顺序快照**（`VirtualGrid.renderedItems()`，与挂载卡 DOM 同序）批量选中 `state.selectedIds` 并遍历已挂载勾选框走 `Batch.updateCheckboxDOM`。取消选择走普通点击逐项切换（复选框/减选按钮与 X 快捷键均已移除）。Ctrl/Cmd 外链旁路（`WorksGrid` 链接分支 / `AuthorGrid` 顶部守卫）不受影响。**区间取序禁止按 `getWorksView()`/`getAuthorRecordsView()` 现算下标**：排序/筛选后视图随 `dataVersion` 重建（作者作品数 rank 重排、渐进加载静默累积、局部替换），可能与尚未重渲的 DOM 顺序不一致——按视图下标圈选会把区间落到视口/挂载窗口之外，是「视觉选中两点间、实际移走的却是别的卡」（视图内左上与右下两张卡的区间被算成 1800+ 项）的根因；快照缺失（render 前/abort 后）才回退视图函数。**用户重定义结果集（排序/关键词/范围/类型/逆序/清除）且视图确已变化时，旧选区与 Shift 锚点一并作废**（批量模式保留，`SearchBar.refreshGridView` → `Batch.resetSelection()`）——锚点通常是视口外的旧卡且位置只在新顺序里现算，保留会让重排后的首次 Shift 点击跨到任意位置、圈出视口外的大段区间；分组切换与域切换同样选区+锚点一并清空。

### 悬停预览事件委托（禁用 pointerenter/leave）

```js
#bindMediaEvents() {
  // pointerenter/leave 不冒泡、无法做容器级委托；用冒泡的 pointerover/out，
  // relatedTarget 仍在同一 .work-media 内部时忽略，实现"跨界只触发一次"
  dom.mainGrid.addEventListener("pointerover", (e) => {
    const media = e.target.closest?.(".work-media");
    if (!media) return;
    if (e.relatedTarget && media.contains(e.relatedTarget)) return;
    …
    if (state.batchMode) return;
    if (!dom.dialogOverlay.classList.contains("hidden")) return;
    if (detail.mediaRetryBlocked()) return;   // 熔断冷却期不启动预览
```

enter/leave 不冒泡——挂在 grid 容器上的监听器只有 target 是容器自身时才触发，卡片上的进入事件永远收不到（功能**静默失效**）。换卡时必须先静音旧预览再判守卫，否则旧视频音频残留。

**滚动侧悬停收口（2026-10-20 修复，红线）**：预览的停止只挂 `pointerout`，但滚动/布局变化会让卡片从指针下移走，而浏览器不重算 hover、**不补发 `pointerout`**（「hover 粘住」），于是预览没人停——唯一停靠点退化为 `#demote`/`#remountWindow`/`visibilitychange`，表现为「指针已不在卡上（甚至卡已滚出视口）预览仍在出声」。因此 `#bindMediaEvents` 另挂两条：`pointermove`（passive，保鲜 `#pointer` 客户端坐标——同卡内移动不跨越 over/out 边界，只有 move 能拿到最新位置）+ `scroll`（passive，`#scheduleHoverRecheck`：rAF 节流后取 `#currentMediaCard` 的 `.work-media` `getBoundingClientRect`，指针仍在框内则保留预览、出框或卡已摘除则 `#stopPreview`）。仅在有活动预览卡时排程，无预览零成本。

### 离开扩展页面即暂停全部播放（visibilitychange）

`main.js` init 绑定 `visibilitychange`（`document.hidden` 时触发，即切标签/最小化；窗口失焦不暂停），回调为 `worksGrid.stopAllMedia() + sidebar.stopAllMedia() + detail.pauseOnHidden()`：

- 卡片悬浮/按钮预览：`WorksGrid.stopAllMedia()` 遍历容器内全部 `.work-video-player` 走 `#stopPreview`——pause、清 `hoverTimer/_retryTimer/_hoverTimeout`、摘 hovered 标记并还原封面。覆盖悬停起播与播放按钮直启两条路径。
- 详情视频：`Detail.pauseOnHidden()` 先 `clearTimeout(video._retryTimer)`（防挂起重试在后台 `load()+play()` 静默续播）再 pause，播放按钮复位为 play 图标与「播放」文案。
- 详情图集：`#noteStopAutoPlay()`（无条件清轮播定时器，music 模式同步 pause 音频）+ `#stopNoteClip()` + `#noteUpdatePlayBtn()`。

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

四个槽位 `.following-avatar` / `.work-thumb` / `#detailImage` 为 `<div role="img">`（`.sidebar-work-cover` 无 role 属性，同为 div+background-image 槽位）。验收标准：`grep '<img'` 模板应只剩图标 `<use>`。背景图加载失败时浏览器不绘制任何占位图标——原生断裂图在元素层面失去载体，这是历史三轮"切换/滚动时瞬态裂图"报告的根治手段。

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
| 图集实况小视频 | `#noteClipToken`（与 `#imgProbeToken` 比对） | 切条/关闭置 0，失效在途 ended/error 回调 |
| 侧边栏封面 | `cover.dataset.gen` | `#demoteItem` 自增作废，重升级入新代 |

`#showAvatarFallback` 与 `clearCard` 必须清空 `backgroundImage`，防止旧图残留。

### 卡片封面选源（图集取轻）与详情首帧占位链（2026-10 定案）

背景：平台给图集（note）首图签发的 `:3000:3000` 档 ≈ 原图（实测 6-8.7MP、解码 25-35MB/张，是侧边栏/网格滚动卡顿根因）；`~tplv` 改写小变体被 x-signature 拒绝（实测 403）、url_list 无更小档——"取轻"只能在 cover 与首图这两个既有资产间做。

- **卡片（四网格/侧边栏）统一经 `utils.pickCardCover(work)` 选源**：视频与模板不可解析一律 `cover` 优先；图集在 `cover` 与 `images[0]` 间取轻——首图模板短边 <2000（如 `:1440:` 压缩档）时保留首图，否则用平台 cover（`video.cover` 的 `~noop.jpeg` 封面档，实测轻 1.4-4.6×）。三处接入点：`Sidebar.#createWorkItem`、`WorksGrid.fillCard`、`WorksGrid.#applyCardUpdate`；禁止手写 `isNote ? images[0] : cover` 旧式分支。
- **提取端语义**：Tab `#extractCover` 对图集存平台封面优先、回退首图；独立 `formatWork` 无 note 分支，仅取 `video.cover`（缺失为空串、不回退首图）——两模式在回退语义上不一致。
- **详情首帧占位链**：`renderDetailNote` 候选 `[cover, images[0]]`——cover 命网格缓存先落屏（瞬开），随后独立探针加载 `images[0]` 静默替换（图集详情要原图细节）。换图守卫三重：`#imgProbeToken` 代际（翻页/重渲自增）+ `#noteWork===work && #noteImgIndex===0`（已翻走）+ `detailOverlay` 非 hidden（closeDetail/#clearDetailImage 不清代际）。静默换图不加熔断计数。
- **旧数据无迁移**：历史已存记录 `cover===images[0]`（小封面 URL 当时已在提取端丢弃、无从追溯），重采集/重同步自动升级。
- **详情实况小视频（note 内容项）**：`renderDetailNote` / `#noteShowImage` 切条经 `#playNoteClip(idx, token)` 单次播放该条 `imageVideos[idx]`（单例 `<video class="note-live-video">` 懒建复用，muted、无控件、`pointer-events:none` 叠于 `#detailImage` 同槽位；尺寸/contain 由 `.detail-body video` 规则提供）。`ended` → `#hideNoteClip()` 回静帧（静帧已由候选链换高清）；`play()` 拒绝与媒体 `error` 静默隐藏。守卫：`#noteClipToken`/`#imgProbeToken` 代际 + `#stopNoteClip` 置 0 失效在途回调；`#releaseNoteClip` 挂 `addCleanup`（切作品/关闭释放 src），`pauseOnHidden` 在 note 分支 `return` 前一并停播。**不调 `markMediaOk/Fail`、不写 `state.mediaMuted`**（声源仍是音乐）、**不设 `#setMediaAspect`**（静帧是布局基准，避免与候选链 last-writer 竞态）。旧记录无 `imageVideos` → 不播实况，重采集自动升级。**切条起步时机对齐本条静帧（2026-10-20 修复）**：`#noteShowImage` 里小视频的 `#playNoteClip` 移入静帧提交点（探针 `onload` 的 `doCommit`）而非探针之前——切条零空档要求旧静帧背景保留到新静帧提交，小视频若同步先上屏就会叠在「尚未替换的旧静帧」之上（两层错位叠加的根因）；提交点后再播即保证小视频只在其同一条静帧就位时出现。

### 静音偏好全页单一共享（网格预览 + 详情播放器）

- 全页媒体静音偏好 `state.mediaMuted`（core.js）是网格卡片预览与详情播放器共用的单一事实源，两处静音按钮双向同步：
- 网格侧 `WorksGrid.#toggleMediaMute()` 翻转标志后经 `syncMediaMute()` 遍历容器内全部已渲染 `.work-video-player` 同步 `video.muted` 与按钮图标；卡片填充与悬停起播都读该标志保证新卡继承。禁止改回单卡独立静音。
- 详情侧 `Detail.#toggleMediaMute(el)`（视频/图集音乐两路共用）翻转同一标志、施加到当前媒体元素，并调 `worksGrid.syncMediaMute()` 回写网格卡片元素态。
- `syncMediaMute()` 的按钮经 DOM 定位（`video.closest(".work-card")`）而非实例 `#videoStates`：详情层切换时当前域卡片可能由另一个 WorksGrid 实例填充，WeakMap 查不到。
- 详情渲染路径（`renderDetailVideo`/`renderDetailNote`）与浏览器拦截自动播放的强制静音路径统一读写该标志，勿读元素 `muted` 回写偏好。禁止改回卡片/详情两套独立标志——历史实现按「详情独立」落地，进入详情即丢静音/非静音状态（2026-10 定案改为全页共享）。

### 媒体全局熔断

`Detail.markMediaFail / markMediaOk / mediaRetryBlocked` 维护滑动窗口失败计数：视频/封面失败密集超阈值（`MEDIA_FAIL_WINDOW` 内超 `MEDIA_FAIL_MAX` 次）即进入冷却期（`MEDIA_BREAK_COOLDOWN`），期间跳过重试直接降级；任何媒体成功加载即复位。**新增媒体重试逻辑必须接入该机制，不要自行计数**。

### 下载文件命名（2026-10-25 定案）

- `Detail.getFilename` 统一生成单作品与批量 zip 内条目名：`{nickname}_{uid}_{awemeId}.{ext}`。
- `nickname` 缺失沿用 `unknown`；作者 `uid` 为空时整个 `uid` 段省略（不写空占位）；`awemeId` 始终保留——私密/被删作品昵称等展示字段可能缺失或变化，作品 ID 是唯一稳定主键。
- 图集内页为 `..._<index>.<ext>`，图集打包名为 `..._<ext>`；批量下载外层 zip 名不带单条信息。

### 短操作弹窗锁定与取消门控

- 短操作（如分组刷新）：`state.preventDialogClose = true` + `try/finally` 解锁，防止异步期间用户误关。
- `state.activeDialog` 在弹窗挂载时由 `Dialog.#mountLayer` 写入（恒等于顶层 onClose），X/Esc 经 `requestDialogClose` 联动发送 `CANCEL_ACTIVE_TASK`；只在 `closeDialog` 出栈时补写会使「本次打开后的首次关闭」静默失效（941a369 分层重构曾回归、2026-09 修复）。无 onClose 的弹窗（设置/维护/确认框）该值为 null，走兜底关闭。
- 长操作弹窗 X 按钮**始终可点**，点击即发送 `CANCEL_ACTIVE_TASK`。
- 为避免短操作误发取消信号，`CANCEL_ACTIVE_TASK` 仅当 `state.activeDialog` 存在时发送（信号路径见 01/09）。

### 多层弹窗（pushDialog 叠层）

- 单 overlay 多实例：基层为静态 `#dialogOverlay`，`showDialog` = 销毁全部上层后重置基层（既有调用点语义不变）；`pushDialog` = 当前层原地保留为父层、新 overlay 实例叠加（z-index 逐层递增、`.layered` 遮罩减淡至 0.4），关闭顶层即销毁实例、露出父层——父层 DOM 原地不动，监听器/输入值天然保留。
- `dom.dialogTitle/dialogBody/dialogFooter/dialogClose` 由 Dialog 动态指向顶层实例元素（仅该类可写），调用方即时访问自动命中顶层；`dom.dialogOverlay` 恒指基层，其 hidden 即「有无弹窗」全局信号（Esc 分流、悬停预览守卫、键盘守卫均依赖）。
- 同层内容切换（进度 → 结果）**必须就地改写** `dom.dialogTitle/dialogBody` + `showOkDialog`（唯一存留点：AuthorImport.#showDone 的 PARTIAL 分支），禁止改调 `showDialog`——那会清栈重建基层、摧毁父层。终态无需停留阅读的提示型结果（导入/导出/重置/删除分组的完成与失败）一律 `closeDialog()` + `showToast` 收口、关层回父弹窗，不再弹「好的」结果层（2026-10-04 定案）。
- 关闭入口 `requestDialogClose` 以 depth 快照防连关：`activeDialog()`（onClose 通常自行关层）已使 depth 变化时直接返回；`settings.saveBeforeClose` 仅在关闭基层（`dialog.isBase`）时触发。X 按钮为 document 级 `.dy-dialog-close` 委托（每层各有 ✕）。
- 焦点三段式：基层打开记触发元素 → 关闭顶层焦点移入父层第一控件 → 最终关闭归还触发元素。

### 弹窗 footer 按钮键盘直达（无焦点设计）

- 键盘不依赖焦点、不管理 Tab：**Enter = 顶层弹窗主动作**（footer 按钮 danger 优先于 primary 推断，ghost 永不占——取消语义 Esc 已覆盖）、**Ctrl+Enter = 显式 `hotkey: "ctrl+enter"` 标注的次要动作**（唯一使用点：批量取消点赞/收藏确认弹窗的「直接移除」）。Ctrl+Enter 槽不做自动推断，避免危险弹窗两个动作都被键盘直达。
- 登记随 footer 增清同步（`Dialog` 每层四个槽位字段 enterExplicit/dangerAction/primaryAction/ctrlEnterAction）：`#mountLayer` 重置、`addDialogBtn` 追加补登（`showOkDialog` 的「好的」由此成为 Enter 目标，现仅 AuthorImport.#showDone 的 PARTIAL 分支使用）、`updateDialog` 清 footer 即失效——进度态 Enter 自动 no-op，杜绝悬空引用已移除按钮的回调。
- 收口在 `Dialog#handleKeydown`（document 级监听绑定于 dialog.js 底部）：只作用顶层弹窗；输入框（input/textarea/select/contenteditable）一律让位；焦点落在顶层弹窗内部操作按钮（原生 Tab / 鼠标点击残留）时全让位走原生激活，不与直达键争抢——**✕ 关闭钮除外**：它是 `focusFirstControl` 对纯文本弹窗的默认落点，若让位则 Enter 恒走原生「点击 ✕ = 关闭」，直达键永无生效机会（2026-10-03 修复）。弹窗外的残留焦点则被 `preventDefault` 屏蔽（Chrome 鼠标点过的按钮保留 DOM 焦点，否则弹窗开着按 Enter/Space 会被隐形触发——Space 在弹窗开启、非输入位时直接吞掉）。Esc 不在此处理（main.js 单点收口）。
- footer 按钮内以 `.dy-btn-kbd` 徽标显示实际绑定（Enter / Ctrl+Enter）：徽标在按钮创建时按槽位解析结果追加，**只标真正占用槽位的按钮**（danger>primary 推断赢家、显式 hotkey 按钮），随 footer 增清同步重建，与 `handleKeydown` 分发同源不脱钩；`.dy-btn` 为 flex（gap 6px），徽标免 margin。
- 纯关闭型「取消」ghost 按钮已整体移除（2026-10-03 定案）：Esc 与 header ✕ 与其功能完全相同，footer 只保留真实动作按钮——确认型弹窗 footer 仅剩主动作键（danger/primary，带 Enter 徽标）与显式 `hotkey` 次要动作（如「直接移除」Ctrl+Enter）；「好的」（签名引导/入库 PARTIAL 结果弹窗）为 primary 动作键、Enter 目标，不属于冗余关闭件；速查弹窗的「好的」已移除（2026-10-04，Esc/✕ 关闭）。
- footer 无按钮的弹窗（进度/移动到分组/设置/分组管理/数据维护/工具/快捷键速查）不参与本机制，行为零变化。
- **分组管理 / 工具弹窗打开时不自动聚焦文本输入框（2026-10-28 定案）**：`showDialog(..., { autoFocus: false })` 跳过 `focusFirstControl`，初始焦点留在触发元素；从叠层（如确认删除/导入进度）返回时同样不重新聚焦。其余弹窗默认仍聚焦首个控件。

### 同步进度过滤的 requestId 时序差异

`SYNC_WORKS` **立即**返回 requestId；`FETCH_FOLLOWING` 等**收集完成才**返回。关注进度过滤因此必须兼容 `Sync.#requestId === null`（列表阶段尚未拿到 requestId 时不得按 requestId 过滤丢弃进度消息）。进度消息载荷见 01。

### 分组 tab 滑块（对齐域切换 ds-slider）

`.group-slider` 常驻 `.group-tabs` 内，高亮职责整体移交滑块（`.group-tab.active` 自身背景必须透明，否则过渡期双重高亮）。**滑块动画的前提是元素跨切换存活**：`renderGroupTabs()` 全量重建仅在分组集合/计数变化时走（groups 事件、换域、init、导入、同步完成）；分组切换只走 `groups.syncActiveTabs()` 切 active 类 + 滑块带动画滑动。`updateGroupSlider(animated)` 中 `animated=false`（重建/resize）必须 no-anim 瞬移——resize 绝不允许滑块从旧位置横穿飞行；active 缺失（删除当前分组的重建瞬间）收拢为零宽、不残留旧高亮。

**单次快照重建（2026-11 修订，替代两段式）**：`renderGroupTabs()` 只发 `GET_DOMAIN_GROUPS`——background 只读对应 `*_groups` 一张小表，返回 `{ groups, counts }` 后一次性渲染名称/顺序/数字，复杂度 O(分组数)。tab 内名称与计数拆为 `.group-tab-name` / `.group-tab-count` 两个 span（计数更弱、独立 tabular-nums）：高频计数刷新只改 count 文本并重定滑块，不重建节点。**计数为分组记录的 `count` 字段，由数据写入同事务维护**：`storage.putBatch/deleteBatch/clear` 在写数据的同时更新对应 `*_groups.count`（升级 v11 时一次性回填），读取端不扫数据表；因此名字与计数同一响应到达。**不保留快照、不显示进度计数**：每次域切换/分组刷新都重新取；域切换时 `AppShell.switchDomain` 与 `domain` 监听先 `groups.clearForDomainSwitch()` 清空旧域 tab，快照到达后一次落正确值。page-0 的 `grid-total` 只校正当前分组 tab（覆盖快照与 page-0 之间的写入）。禁止改回“先 `GET_GROUPS` 出名字、再异步 `GET_STATS`/扫描补计数/逐页进度累加”。`#renderGen` 作废在途旧帧；存储指示器仍经 `#refreshStorageIndicator()` 独立 fire-and-forget。**分组快照请求先于 page-0 发出**（`main.js` domain 监听先调 `groups.renderGroupTabs()`）。

**打开分组弹窗不得重建顶栏**——`showGroupManage` 只调 `#renderDialogGroupList()`（弹窗内列表），顶栏分组栏没变、重建纯属无谓开销；增删改才经 `#refreshGroupList()`（= 顶栏重建 + 弹窗列表）或 `store.refreshGroups()`。

`.group-tabs` 必须声明 `scrollbar-width: none`（横滚条不得占布局高度）：全局 `*` 的 `scrollbar-color` 使新 Chromium 忽略 `::-webkit-scrollbar{display:none}`，窗口变窄 tab 溢出时横滚条回退为占位经典滚动条，把条内横向滚动区压矮 ~15px——分组按钮居中基准上移，与顶栏右侧按钮不再对齐（2026-10-16 修复）。隐藏滚动条不影响横向滚动本身（触控板/水平滚轮照常），溢出提示由 `tab-overflow` 遮罩承担。

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

播放条最右端作品序号「K / N」中 K 为真实输入框（`#detailCounterInput`，外观与静态文本一致，悬停/聚焦下划线提示）：聚焦全选、输入仅留数字、宽度随总位数/输入位数自适应（ch）。**Enter 提交跳转**（非数字/越界钳制到 [1, N]；相邻序号复用 ↑/↓ 方向感过渡、远跳走普通淡入）、**Esc 还原退出**（stopPropagation 拦在 document 层「Esc 关弹窗」单点收口之前）、**失焦还原**——展示值与当前作品恒一致。详情 document keydown 在 Tab 圈定后对该输入框整体让位（数字/方向键不得切作品、删键不得触发移除），Tab 焦点圈定照常覆盖该输入框。跳转经 `#setCurrent` 同步 `#index`/`#currentId` + `renderDetail`；关闭详情时按 awemeId 恢复网格滚动（`restoreGridScroll`），跳转结果自然落位。

### 详情导航顺序 = 网格已渲染顺序（2026-10-30 修复）

- 详情翻页与 K/N 计数一律以 `VirtualGrid.renderedItems()`（`#viewItems` 快照，与挂载卡 DOM 同序）为准，快照缺失（尚未渲染/清场后）才回退 `search.getWorksView()`。背景：渐进加载期（作品数排序、加载中途切排序 → 页序与视图序失配）网格静默累积、加载完成才整渲，视图函数已随 `dataVersion` 增长而 DOM 仍停在上一版渲染顺序——按视图现算会让详情全程与网格可见顺序错位（「进入详情后作品顺序与网格不匹配」的根因）。
- 展示作品以 `#currentId`（awemeId）钉住：详情打开期间网格重渲换序（完成整渲/STORE_CHANGED 整刷）后，`#index` 按 id 换算到新顺序，↑/↓ 继续沿当前渲染顺序推进；关闭详情按同一 id 滚回原卡（`restoreGridScroll(awemeId)` 不再用下标——下标在新旧顺序间不可信）。

### 详情层几何（对齐抖音播放界面）

- **几何**：`.detail-body` 全屏宽、`flex:1`（高度=视口−56px 播放条，零重叠）；`.media-view` 居中，宽度=`min(视口宽, 可视高×媒体宽高比)`（`--media-aspect` 由 `Detail.#setMediaAspect` 写入 overlay：视频 `loadedmetadata` 的 videoWidth/Height、图片探针成功后的 naturalWidth/Height，图集逐图跟随；切作品在 `#transitionToNext` 复位 9:16 缺省防上一件残留），竖版/横版/方形一律等比铺满可视高、零裁切（2026-09-29 修订：废弃横版/方形 39.3vw 封顶——`.media-view` 高度恒为满高列，封顶使横版在列内只剩一条居中横带，与「对齐抖音播放界面」相悖；超宽媒体由 `min(100%, …)` 截断）；视频/大图 `object-fit/background-size: contain` 完整显示（2026-09 定案，反转旧 cover 裁切——9:16 竖版在固定 3:4 胖容器里会被裁掉约 24% 画面），列内留白由 `#detailOverlay::before` 模糊背景透出填充（全亮度：无压暗/无渐晕，对齐抖音播放器——2026-10 修订，旧 0.4→0.8 渐暗叠加边缘渐晕后两缘过暗、左上关闭钮难辨，废弃）。
- **⌃⌄ 切换器**（`#detailSwitcher`）：右缘垂直居中（`position:fixed` 必须用 `calc((100% - var(--detail-bar-height)) / 2)` 显式扣除底栏高度——与绝对定位于 `.detail-body` 内的左右箭头共用同一居中基准，否则比箭头中心线低半个底栏），只切上一个/下一个作品（接 `prevDetail/nextDetail`），不参与图集翻页——图集翻页归左右箭头（56px、锚定 10vw、悬浮/聚焦常显）、分段条 seek 与自动轮播。
- **bar-controls 信息位**：视频=`#detailTime`（0:00/0:00），图集=`#detailOrder`（K/N），由 `#updateCounters` 分工写入；`#detailCounter`（作品序号）仍在最右端。
- `.detail-bar-btn` 仍被卡片预览按钮复用（options.html `.video-play-btn/.video-mute-btn`），调整其尺寸参数时须回归卡片预览。

### SearchBar 搜索/筛选约定

- **布局（2026-10-31 定案；2026-11 导航轨改造；2026-11-08 顶栏合并）**：搜索框、分组按钮组与域特定控件同处顶栏单行工具区，DOM 顺序固定为 **分组按钮组 → 搜索控件组 → 域特定控件组（类型/排序）**；批量入口位于右侧导航轨顶部；顶栏 `flex-wrap`，宽度不足时按此顺序折成两行或三行：`.group-selector` 以 `flex:1 1 auto` + `min(500px, 100%)` 下限（500px = Win10 Chromium 系浏览器窗口最小宽度；行内不足 500px 时占满整行）按标签内容自然宽参与折行：分组标签与控件簇并排放不下时整簇落到下一行，分组独占一行且标签不被裁切（组多时铺满搜索簇左侧、多到放不下才横向滚动，不再留出中间空档），`.sb-field` 以 `flex:1 1 120px` + `min-width:120px` + `max-width:240px` 保持紧凑（120px = 框内图标 + 结果数的真实下限，行宽不足时先收缩到该下限）——宽屏下长到 240px，剩余空间才归分组；压缩到 120px 下限后不再继续压扁，空间仍不足时按序折行，`#searchInput` 内部再按需收缩、`overflow:hidden` 防溢出。搜索与尾部（`.topbar-tail`：域筛选）同处 `.topbar-controls` 控件簇，**整簇**参与顶栏折行：分组标签与它并排放不下时整簇落到第二行（分组独占一行、标签不被裁切）；簇内再不足时搜索与尾部二次换行——典型折行为「分组 / 搜索 + 筛选」，更窄时「分组 / 搜索 / 筛选」三行。`#searchBar` 已删除，网格与侧边作品栏直接位于 `#mainCol` 下的内容行（`#contentRow`）左右并排；最右侧 48px 导航轨独立于 appBody（body 两行网格的第 2 列，`grid-row: 1 / -1`），从顶栏上缘贯穿到页面底部；域切换与工具以 `.menu-divider` 分隔。`#contentRow` 需 `flex:1; min-height:0`，否则网格的 overflow-y 在纵向 flex 列内失去确定高度。
- **搜索栏常驻（2026-11-08 定案，红线；同日并入顶栏单行）**：搜索框与分组行合并进顶栏，`closeSearchBar` / `toggleSearchBar` / 顶栏搜索入口 / S 键开关全部移除，任何路径均不自动聚焦输入框（仅用户点击输入框才获得焦点）。**域切换只重置搜索态**（`resetSearchState(false)`：清筛选 + 收菜单，重置不做重渲——网格随域切换即清场重载，2026-10-28 定案）；筛选状态**不落 URL hash**——除 main.js init 的一次性残留清理外，全仓无 hash 读写方。
- **布局顺序（2026-10-14 定案；2026-11-09 修订：搜索框位于顶栏，类型/排序下拉移出 `.sb-field` 与输入框并排；`.sb-field` 只收 输入框 + ✕ + 🔍 + 结果数 K，顶栏同排控件统一 34px 高）**：输入框 → ✕（清除搜索输入文本，即去掉关键词过滤；其余筛选（排序/类型）就地保留，**不再恢复默认视图**——2026-10-20 修订）→ 🔍（搜索按钮，回车同效）→ 结果数 K → 作品类型下拉（全部/视频/图集，默认全部）→ 排序下拉（作品型三域：保存时间(降)（默认）/ 保存时间(升) / 作品数(降) / 作品数(升)，键与方向合并为单值下拉，选中即生效——2026-10-28 定案：原「点激活键翻转方向」分段器改为四选一下拉，内部 `sort`/`reverse` 状态、isFilterActive 计入与视图缓存键均不变；**作品数为两层排序：一级作品数量随方向升/降，二级发布时间（`createTime`）恒从新到旧、方向只翻转一级序**（`sortKey` 对 authorCount 并入 `reverse`、view 段跳过整体翻转，2026-10-21 定案；「发布时间」独立排序键同日移除）；关注域排序同为下拉、四项：作品数(降)（默认）/作品数(升)/最近更新(降)/最近更新(升)，同样选中即生效（2026-10-28 定案；粉丝数排序 2026-11-01 移除））。作品类型与两域排序均为自绘下拉（`SelectMenu` 单份交互），状态字段 `workType`（all/video/note）、`sort`/`followingsSort` 与 `reverse`；**类型项文案精简为「全部/视频/图集」（2026-10-28 定案）**——相邻排序下拉折叠值自带「保存时间(降)」等明确语义，两个折叠态并排不再有「全部」歧义，维度词要求解除；默认项须保持首位（默认=不筛选），只靠文案区分（2026-10-23 定案）；作者域（关注/候选）隐藏类型下拉，仅 输入→✕→🔍→结果数→排序下拉（作品数/最近更新 × 降/升）。**搜索框与分组按钮组同处顶栏单行（2026-11-08，分组在前；窄窗按「分组 → 搜索 → 域控件」折行）**——折叠开关（S 键、顶栏搜索入口、`closeSearchBar` / `toggleSearchBar`）已移除；任何路径均不自动聚焦输入框（仅用户点击输入框才获得焦点），**按 Esc 可退出输入聚焦**（Esc 层级为「弹窗→详情→失焦」，无覆盖层时才失焦、不关层；批量模式不归 Esc）。**输入不即时响应（2026-10 修订）**：移除 input 即时搜索与 200ms 防抖，回车（IME 组合中让位）或点击 🔍 才实施，实施后 `searchInput.blur()` 令输入框失焦（光标不滞留文本区，2026-10-20 修订）；结果数 K 随各刷新路径更新（N 由分组按钮数字承担，2026-11-08 起不再展示）。
- **下拉键盘与 ARIA（2026-11-09）**：搜索栏三个下拉与设置弹窗的回顾来源下拉统一由 `SelectMenu` 承载；触发器 `role="combobox" tabindex="0"` + `aria-expanded/aria-controls`，菜单 `role="listbox"`、选项 `role="option" aria-selected`；键盘支持 `Enter/Space` 开合、`↑/↓/Home/End` 移动、`Enter` 选择、`Esc` 关闭（stopPropagation，保留 main.js 的弹层 Esc 单点收口）、`Tab` 关闭。隐藏选项不参与键盘导航；激活项为白字 + 600 字重（**不显示 ✓**，选中语义由 `aria-selected` 承担；原红字 4.02:1 不达 AA）。菜单 `width:100%` 跟随按钮实际宽度（按钮不被菜单撑宽）；选项超长时单行省略，避免菜单被长选项撑得比按钮宽。**全局焦点环仍按既定决策抑制，不因本次改动恢复。**
- **关键词自动判定（2026-11-09 定案）**：范围下拉已移除，输入框按文本形态自动判定检索字段——**昵称子串始终参与匹配；纯数字关键词额外按作者 UID 匹配**（纯数字昵称不会被漏掉，UID 与昵称命中取并集）。所有域共用同一提示文案「输入昵称或 UID」。空关键词不触发任何过滤。
- **关键词匹配口径**：作品型三域 = 昵称**子串**始终匹配；纯数字关键词额外 → 作者 `uid` **精确**（uid 约 19 位纯数字，子串匹配会让任意数字关键词大面积误命中）。关注/候选域 = 昵称子串始终匹配；纯数字额外 → uid 子串（该域无作品 ID 维度）。**作品 `awemeId` 不参与任何关键词匹配**——2026-10-14 定案：行为与提示文案严格对齐。sec_uid（`MS4wLjAB…`，作者主页 URL 形态）不在检索字段内，暂不支持。
- **取数方向与视图序对齐（2026-11 修订）**：「保存时间(升)」时 `loadDomainData` 传 `ascending`，后台改 next 方向从最旧一端分页（首页即全组最旧，余页在视图尾部单调追加），首屏不再出现完成态整渲；saved 排序键（含关键词/类型筛选）一律逐页续填（`fillSlots` 起点改用视图下标）。**作品数排序改由 background 作者视图直出最终页序**（`sort:"authorCount"`）：page0 即最终视图前 600 条，续页 cursor `{ token, dir, ai, off }`，页序 = 作者视图序，`fillSlots` 逐页续填、`done` 只 `pruneEmptyTail`，不再「静默累积 + 完成整渲」。`isPageAligned(event)` 按事件 `mode/direction` + `state.authorViewOrder` trusted 判定；加载中途切排序/逆序/方向一律整域重载。**作品数排序首屏仍先渲内容**：page0 返回即渲染，不做骨架等待。

### 壳层导航 / 批量条 / 空态（2026-11 实施）

- **右侧导航轨**：宽度 48px（`--right-sidebar-width`，保持原栏宽），从顶到底占满全高（body 网格第 2 列跨两行）；**「批量」入口位于导航轨最顶部**，与下方域切换以 `.menu-divider` 分隔；域与工具均采用「18px 线性图标 + 10px 标签」纵向布局；域切换与工具菜单以 `.menu-divider` 分隔，活跃域由 `.ds-slider` 原本的中性白灰滑块承载（不引入红色强调）。原右栏「搜索」菜单项与顶栏搜索入口均已移除（搜索框常驻顶栏）。底部分组新增「状态」入口（`#btnStatus`：Cookie 配置 / 浏览器特征 / Tab 模式捕获状态，2026-11-08 自设置弹窗迁出）。宽度固定 48px、无折叠（折叠按钮 / `toggleRightSidebar` / `--right-sidebar-live-width` 已于 2026-11-08 移除）；域滑块仍由 `updateDomainSlider()` 按按钮实测高度定位。
- **批量底部工具条**：批量入口位于右侧导航轨顶部（`#btnBatch`，批量态红色高亮）；操作动作在 `#batchBar`（保留原 id 与事件绑定），由 `body.batch-mode` 纯 CSS 显隐；计数拆为 `#batchCount` 数字节点 + `#batchTotal` 分母（`Batch.syncSelectionUI` 写「已选 N / 视图长度」）；移动/下载/移除按钮保留 `title` 与 `aria-keyshortcuts`，**不在按钮内显示快捷键徽标**。工具条 fixed 定位，`left:50%` + `transform` 扣除右侧导航轨固定宽 / `--sidebar-live-width` / 6px 分割条得到主网格中心；`width:max-content` + 主区域 `max-width` 防窄窗 shrink-to-fit 提前折行；`Sidebar.setSidebarWidth` 实时更新 `--sidebar-live-width`。批量态 `#mainGrid` 增加 96px 底部安全区，防末行被浮层遮挡。
- **空态（2026-11-09 精简）**：所有域共用同一空态结构（图标 + 文案 + 提示），作品域不再展示首次使用行动区与快捷键引导；筛选零命中与错误态保持各自文案。
- **作者作品栏身份头**：`#sidebarAuthorHead` 为 `sidebarBody` 正常流子项 + `position: sticky`，展示昵称、关注/候选状态与「已加载 / 作者作品总数 · 最近更新」副标题；身份头右侧为四个动作：导入该作者全部作品到作品域（复用 `IMPORT_USER_WORKS` 长任务链路）、加入候选域、从候选域移除（`DELETE_CANDIDATES` + 本地摘卡）、刷新作品栏（代际作废在途回包后从第一页重取）。头像探针成功才提交背景图，失败保留昵称首字。头部数据仅复用 `openSidebar(author)` 入参与已加载作者记录，不向作品域写派生字段。

### SearchBar 视图阶段缓存与筛选切换性能（2026-09 定案）

大库（十万级）搜索态下过滤切换的耗时由三部分叠加：视图重复计算、字符串归一化重复分配、筛选态全量拆建 DOM。对应三层定案如下，**回退任何一层都会复现切换卡顿**：

- **三段视图流水线（`#viewCache`）**：`getWorksView`/`getAuthorRecordsView` 拆为`base`（关键词/类型过滤）→ `sorted`（排序）→ `view`（逆序）三段，各段以自身输入签名增量失效——切类型只重算 base 及其后，切排序从缓存 base 重排，切逆序只翻转一次拷贝。数据侧失效判据是 **`state.dataVersion`**（见下条），`baseSource` 引用相等作冗余校验。**视图函数返回共享缓存数组，调用方一律只读**（网格/Detail/Batch 现有调用均为只读遍历）；需要变更序（reverse 等）自行拷贝。逆序段必须拷贝后翻转，原地 reverse 会串段污染缓存。
- **`state.dataVersion` 写入版本号（红线）**：视图缓存的唯一数据侧失效判据。store 的域数据变更方法（set/appendWorkRecord/removeWorkRecordSilent/removeAuthorRecordsSilent）自动自增；**绕过 store 封装的原地写入必须手动自增**——现存两处：`main.js` `tryHeadInsert`（头插 splice）、`applyStoreUpserts`（原地替换 `list[idx] = work`）。新增绕行写入点若漏增，视图缓存将读到脏数据（漏增不炸、错显，最难排查）。
- **关键词归一化侧表（`lcFields` + WeakMap）**：每条记录的 nickname/uid 小写形与作者簇键（authorCount 口径）惰性缓存一次。用 WeakMap 而非往记录挂字段：记录经EXPORT_DATA 原样序列化，挂字段会污染导出 JSON；options 侧内容更新一律整对象替换，旧对象连同缓存一并失效。authorCount 全库 rank Map（counts 只依赖数据源、与筛选正交）缓存于 `#rankCache`，**失效判据 = `state.dataVersion`（+ source 引用冗余校验）**——作品域数组经 `appendWorkRecord`/`tryHeadInsert`/`applyStoreUpserts` 原地变更、引用不变，仅 dataVersion 自增；只看 source 引用会让早快照（首页/首屏）算出的 rank 永久滞留、后到作品漏统计（rank 缺失按 `?? 0` 排到最前、已有作者计数被低估下沉），表现为「作品数排序乱」（2026-10-20 修复）；排序走 decorate-sort-undecorate（比较键预计算成并行数组），禁止改回 comparator 内逐对字符串拼接 + Map 查找。
- **单次视图计算 + 恒等快速路径（`refreshGridView`）**：视图只算一次，同一数组贯穿渲染与计数（历史实现经 renderCards/syncCount 各算一遍）；结果数组与 `#lastRenderedView` 恒等时跳过重渲只刷计数（切了不改变结果集的筛选、重复点击同段成本归零）。`refreshGridView` 是renderCards/renderAuthorCards 的唯一调用方，`#lastRenderedView` 仅在其渲染分支写入——域/分组切换必经数据重载（dataVersion 自增 → 数组重建），不存在「DOM 已清场但数组恒等」的假跳过。**段数组不可变发布（不变量）**：base/sorted/view 一经产出不得再原地sort/reverse/写，恒等快路径的前提是「同引用必同内容」。2026-10-03 关注域切作品数/最近更新不重排即违反此不变量：sorted 段曾在 base 上原地 sort，reverse=false 时view/sorted/base 三者同引用，切排序被误判无变化而跳过重渲；修复为拷贝后排序（`[...base]`，O(n) 拷贝远低于排序本身）。作品域 authorCount 段本就产出新数组、saved 段返回的 base后续不再被改，均满足不变量。
- **结果数 K 口径（2026-11-08 修订）**：搜索框只显示 K（当前过滤视图条数），N（域/分组总量）由分组按钮数字承担、不再展示。切域/切组时 `state.gridPending=true`，K 恒 0（网格已清场、不读旧缓存视图）：有 `state.gridTotals` 同源缓存显示 `0`，无缓存显示占位「…」；首页落库清 pending 后 K 随各刷新路径更新。`state.gridTotal`（作品型三域 = `GET_* page:0` 的 `total`；作者域 = 单发全量长度）仅用于占位判定与分组 tab 校正。分组按钮数字由 `GET_DOMAIN_GROUPS` 原子快照一次渲染。
- **筛选态降档首帧 + 尾部占位 + 滚近按需铺卡**：筛选态是封闭视图（无未来分页、无 fillSlots回填方），首帧同步预铺降档至 `GRID_PREMOUNT_CAP_FILTER`(600) 保持切换响应；余量行以容器padding-bottom **尾部占位**（`#syncTailReserve`）预留，滚动条总长渲染首帧即终值——否则滚动中内容持续变长会把滑块按比例打回（实测 600→1200 时滑块 0.95→0.49，2026-10 定案）。卡片滚近按需铺入（`#extendIfNeeded`：真实内容底 = 容器底 − 占位）并等量收缩占位、净高恒定；拖拽远跳进占位区按视口带区追赶（`#scheduleRush` 逐帧续铺，单步 ≤`GRID_EXTEND_JUMP_STEP`=4000 防长冻结）。**禁止改回「预挂/后台补铺余量卡」**——大 M 下每次容器追加都是全网格重排（实测 2 万卡单次约 130ms、4 万约 1s），曾致排序切换连帧卡顿。铺卡走 `#extendSlotsTo` 键控分支（锚 = 槽尾带键卡在快照中的下标，DOM 实况推导；快照未覆盖的槽位才落无键占位卡 + fillSlots 回填）。**封闭态铺卡/扩容禁止退回无键占位卡**——没有回填方，永久灰卡。
- **筛选切换不保滚动位置（2026-09 定案，反转旧「筛选切换锚点」；2026-10 改显式归零）**：切筛选/排序/逆序即新结果集，从头浏览——撤销了 captureViewportAnchor/restoreViewportAnchor三段式（其恢复时机早于两段式铺设的拼装完成，深锚会被 clamp 到错误位置，且与「新结果集从头看」的预期语义相悖）。**尾部占位（#syncTailReserve）使「wipe clamp 天然回顶」失效**（重渲任务内总高即恢复终值、旧偏移合法存留，表现为「跟随锚点」停在深处），回顶改为显式：搜索态条件变化经 `refreshGridView(resetScroll=true)` 重渲后归零，域切换 `switchDomain`显式归零，分组切换 `groups.js` 既有显式归零；数据驱动整渲（同步完成/STORE_CHANGED 整刷）不归零——不打断用户阅读位置。锚点仅保留两处：详情退回网格（`restoreGridScroll(awemeId)` 按 id 定位、在已渲染快照中取下标，网格 DOM 不重建时直接实测）与侧边栏开合/拖宽（`Sidebar.#preserveAnchor` 登记锚点 →`VirtualGrid.#onContainerResize` 在 RO 回调内补偿，几何变化后同卡同位）。

### 作者数排序 trusted 视图（方案 B，2026-11 定案）

- background `AuthorViews` 用 `groupId_uid_sort` 复合索引 `openKeyCursor` 只扫键，在 SW 内存构建 `作者 → 有序 id`；不持久化 `author_views`，靠内存 revision + epoch 失效。
- options `state.pagingMode` 由 SearchBar `syncPagingState()` 维护；`state.authorViewOrder = { domain, groupId, direction, items, counts, complete }`（items 为按作者视图序到达的已加载前缀，complete 表示全部作者页已到达）。
- `getWorksView()` trusted 分支直接返回视图前缀（无筛选零拷贝），只做关键词/类型过滤，跳过 rank/排序/reverse；`#authorRank` 优先用 page0 `authorMeta` 的 counts。
- 续页 `store.appendAuthorViewRecord`：先把页按 savedAt 排序再与 `state[domain]` 双指针归并（保持 savedAt 降序不变量），event 附 `mode:"authorCount"` / `direction`；`isPageAligned(event)` 对齐时走 `fillSlots`、`done` 只 `pruneEmptyTail` 并置 `complete`。
- 重载矩阵：进入/离开 authorCount、切方向、加载中切排序、切组、STORE_CHANGED → 整域重载；删除/移动在 `isAuthorViewPatchable()`（trusted + complete + 非加载中）成立时走**本地稳定序收口**：`store.removeWorkRecordSilent(..., { preserveAuthorOrder:true })` 过滤视图前缀并递减作者计数 + `grid.removeItems`，不整域重载；「全部」分组内移动仅 `updateWorkGroupSilent` 改分组归属，网格零变化。视图不完整/加载中才回退整域重载。详情删除的重载传 `keepDetail`，覆盖层保留并在完成后按新视图顺延。`VIEW_EXPIRED` 清场后按同一模式重试一次，`AUTHOR_VIEW_INCOMPLETE` 降级 saved 分页 + 本地 rank。
- 稳定序语义：本地摘卡后视图顺序暂不重排，下次显式切排序/分组/域（或整域重载）时由后台作者视图恢复严格序；此期间 `getWorksView` 仍以 `authorViewOrder.items` 为展示序，禁止调用 `refreshGridView` 整刷。
- 红线：禁止绕过 `storage.putBatch/deleteBatch/clear` 写作品域（rev 不前进会让旧视图被误用）；禁止 `.catch(() => {})` 吞掉 `VIEW_EXPIRED`；不得把作者视图到达序直接 push 进 `state[domain]`。

### 全局 Tooltip（2026-11）

剩余 `title` 属性统一由 `Tooltip`（`options/components/tooltip.js`）接管显示：单例 `#dyTooltip` 使用抖音风格深色浮层与小箭头，按目标位置在上/下自动摆放并在视口内收敛。显示前临时移除目标 `title`，防止浏览器原生 tooltip 叠加；离开时恢复，若控件在悬浮期间被动态写入新 title 则以新值为准。滚动/缩放只收起浮层、保留 title 移除状态，避免原生提示补弹。`title` 仅用于纯图标控件、快捷键或确有隐藏语义的入口，可见文字/日期/状态 chip 不重复添加。

### CSS 协同约定（.hidden 成对声明）

自带 display 值的组件类与通用 `.hidden` 同用时，**必须成对声明 `.X.hidden { display: none }`**。原因：通用 `.hidden` 定义在 options.css 前部（组件规则之前），同特异性（0,1,0）下会被文件后部组件规则里的 `display: flex/…` 覆盖，`hidden` 类静默失效、占位层常显（曾导致作品卡中央 emoji 常显、关注卡头像旁多出一个空占位圆）。既有先例：`.work-type-badge.hidden`、`.following-avatar-fallback.hidden`。

### 骨架模板同构要求（原地切换的配套约束）

骨架模板必须与完整卡在根层同构（勾选框除外——勾选框随填充创建、降级即移除，模板本不含）：

```
.work-card       > .work-media + .work-info(.work-author-row(.work-author + .work-create-time))
.following-card  > .following-main(.following-avatar/.following-avatar-fallback
                                          + .following-nickname)
                 + .following-details(.following-stats + .following-update)
```

媒体子树等可从完整模板取新节点移入；unloadObserver 因此持续观察同一根节点无需重挂，fill observer 在 `#demote` 时重新 observe。新增会替换卡片 DOM 的逻辑必须保持 dataset key 与两个 observer 的交接（`populateItem` 负责 observe 完整卡）；`updateCardsDOM` 已兼容骨架态。

- **信息条字号层级（2026-11-09 修订：标题行已移除）**：作者 13px/600（主），发布日期 11px；`.work-info` 为 30px（8 顶 + 16 作者行高 + 6 底），`config.CARD_HEIGHT_OFFSET` 同步为 30。

### 侧边栏作品卡信息条（日期 / 点赞·收藏切换按钮 / 入库切换按钮）

侧边作品栏（作者作品网格，跨各域共用）每张卡的信息条（2026-10 定案；2026-10-20 将原独立存在性徽标并入「存入」按钮——徽标与按钮本就在同一行重复表达 `inWorks`，合并为单一三态控件；关注者卡不再承担入库入口——其「存入作品域」按钮曾于本版短暂存在后移除；作者档案入库统一走关注域批量模式「入库」与菜单「工具」弹窗）：

- **作者上下文入口（2026-10-31 定案；2026-11-06 点击语义调整）**：关注/候选域点击作者卡；作品/点赞/收藏/回顾域 **点击作品的作者名**（作者名的 Ctrl/Cmd+点击则在新标签打开作者主页，批量模式下同样不切换勾选）。侧栏内容恒为该作者的远端作品列表（与当前域无关），故切换作者即替换内容，切换域仍收起侧栏并清空作者上下文。**分割条仅在侧栏展开时可见（折叠态整体隐藏，2026-11-08），点击收起、拖拽调宽；展开入口为点击作者卡或作品作者名**；`openSidebar` 以 `#loadToken` 代际作废上一作者在途分页回包；`Sidebar.#calibrateFollowing` 仅关注/候选域执行（作品型三域无可回写作者记录）。`#activeGrid()`（`search.gridForDomain()`）保证展开/拖宽/锚点作用于当前域网格；各域默认展开 3 列（面板宽度档位 = N×`SIDEBAR_CARD_SIZE` + 间距 + 内边距 + 滚动条槽宽（`sidebarBody` 的 `scrollbar-gutter: stable`，实测 ~15px）；窗口放不下时按可用宽度自动回退 2/1 列）。**列轨宽恒等于档位卡宽**（`SIDEBAR_CARD_SIZE`，`repeat(auto-fill, 卡宽)`）：档位宽按 N×卡宽 + 间距 + 内边距 + 滚动条槽精确推算，因此每个档位恰好排 N 列、零余量；卡片宽与主网格解耦，靠作品域「主网格至少保留 3 列」的保底让两侧尺寸接近。**禁止再让轨宽跟随主网格实际落笔宽**——轨宽与档位宽脱钩会在面板里留下大片空白。主网格保底宽按域取（作品型三域取作品卡带宽下限 `CARD_SIZE_FALLBACK × WORK_CARD_SIZE_BAND_MIN`）。可用上限按 `appBody − 分割条 − 主网格保底宽` 计算（`appBody` 是 body 网格第 1 列，已不含右侧导航轨，**不得再减 `--right-sidebar-width`**）；窗口缩窄到连 1 列都放不下时侧栏被动收起到 0 并记住原宽，**窗口回宽后自动恢复**（用户主动收起/切域归零会清掉该标记，不会自动弹开）。
- **作者身份头（2026-11）**：`#sidebarAuthorHead` 位于 `#sidebarWorksGrid` 之前、`sidebarBody` 正常流内，`position: sticky` 吸顶；单行布局（28px 头像 + 上下 5px 内边距，`min-height: 44px` 与顶栏同高）：昵称/关注或候选 chip → 「已加载 / 作品总数 · 最近更新」→ 右侧动作按钮组（导入作品域 / 加入候选域 / 从候选域移除 / 刷新 / 收起，34px 图标按钮，与顶栏同行控件同高）；统计文本过长省略。头像 `#sidebarAuthorAvatar` 走探针先行（成功才写 background-image，失败保留昵称首字）；头像 URL 回退链为当前记录 `avatarLarger || avatar` → options 已加载的同 UID 另一作者域记录 → `GET_AUTHOR_BY_UID` 后台跨域补取（主键各取一条，补齐头像/统计后原地重渲头），昵称/关注或候选 chip/粉丝与作品计数/最近更新/已加载作品数由 `Sidebar.#applyAuthorHead` + `#syncAuthorHeadMeta` 维护。分页加载后只更新副标题的「已加载 / 总数」计数；校准成功时合并统计字段但缺失字段不覆盖旧值。收起按钮复用 `toggleSidebar()`；昵称本身即 `profileUrl` 外链（新标签打开），不另设主页按钮，统计副文本不挂 `title` tooltip。
- **结构**：`.sidebar-work-item > .sidebar-work-link(封面+类型角标) + .sidebar-work-info(日期 + ♥/★ 图标按钮 + 存入图标按钮)`——信息条在**封面链接之外**，避免「存入」/♥/★ 点击触发外链跳转；卡改纵向 flex（封面 `aspect-ratio: 3/4` + 信息条固定高），`#createWorkItem` 用类选择器取节点（不再依赖 `children` 下标）。`SIDEBAR_CARD_SIZE`=199px（= 作品域网格卡基础宽 `--dy-card-size` 249 × 80%，恒小于网格卡最窄档 224），信息条高度 `var(--dy-card-info-height)`（30px）与作品域 `.work-info` 一致，但纵向内边距压到 3px（内容行 24px），♥/★/存入 三个按钮均 24px 高、上下各留 3px，可点面积覆盖整条内容行（内容仍为单行四元素：日期 + ♥/★/存入 三个图标按钮）。
- **发布日期**：`utils.formatPublishDate(work.createTime)`（与作品域网格 `.work-create-time` 同源同格式；空值显示 `-`；不挂精确时间 tooltip）。
- **点赞/收藏域状态按钮（♥ 点赞 / ★ 收藏，可点击切换）**：信息条内 `.sidebar-presence-like` / `.sidebar-presence-collect` 为 `<button type="button">`，图标按钮无可见文案，两态常显——存在加 `.on`（♥ 着色 `#ff4d6d`、★ 着色 `#ffb84d`），不存在为暗态（muted + opacity），动作语义只放 `aria-label`（点赞并加入点赞域 / 取消点赞并移出点赞域），不重复挂 `title`。点击发 `SET_FAVORITES` / `SET_COLLECTION { awemeId, active, work? }`：**远端设置成功后**才把当前作品经 `mergeAndSave` 写入对应域（新增）或删除该域本地记录（取消），卡片原地翻转 `.on` 态；失败保持原态并 toast。点赞无独立模式分支（background 返回 `UNSUPPORTED_INDEPENDENT`），收藏双模均通；`Sidebar.#pendingReactions` 按 `${domain}:${awemeId}` 防重入（在途按钮 `.pending` + disabled）。图标来自 SVG 符号 `#icon-heart` / `#icon-star`（`options.html` 图标区）。
- **三域存在性判据（按 awemeId）**：`loadSidebarWorks` 拉到页数据后，对当前页 id 一次批量 `GET_WORKS_BY_IDS { domain, ids }`（`works`/`favorites`/`collections` **三域并行**，主键直取）→ 各域命中集即存在性；任一域失败该域降级为空集（保守按不存在展示）。放弃原 uid 集合方案（`GET_WORKS_UIDS`/works.uid 索引已裁撤——按作品维度判定是本区的真实语义）。
- **「入库」按钮（两态图标按钮，toggle 动作 + 状态）**：与 ♥/★ 同款切换语义——未入库为暗态、点击 `SAVE_WORKS { works:[work] }` 入库（toast「已存入作品域（新增 X · 更新 Y）」）；已入库 `.in-works` 提亮为灰白色（`--dy-w-90`、常显）、再点 `DELETE_WORKS { awemeIds:[awemeId] }` 移出作品域（toast「已移出作品域」；`DELETE_WORKS` 不广播 `STORE_CHANGED`，当前域为作品域时由 `Sidebar.#dropWorkFromGrid` 本地摘卡并重算分组计数/结果数）。图标固定 `#icon-bookmark`（与批量条「存入作品 / 入库候选」同一入库图标），仅有图标，`aria-label` / `aria-pressed` 随态切换，不重复挂 `title`；请求在途 `disabled`（`#pendingSaves` 防重入）。动作为短操作，不走进度弹窗。**禁止再拆出一个独立存在性徽标**（重复表达同一状态）。
- **交互与防重入**：`dom.sidebarWorksGrid` 容器级 click 委托（一次绑定，卡片增删不重绑），命中 `.sidebar-work-save` 或 `.sidebar-presence` 即 `stopPropagation + preventDefault`；`Sidebar.#pendingSaves` / `#pendingReactions` 集防双击重入（按钮原地禁用态）。刷新时机：重开作者（`#resetSidebarGrid` 重建）自然重查；STORE_CHANGED 不为此加订阅（下次分页/重开刷新）。
- **加载圈生命周期与列表终点提示**（2026-10 修复）：加载圈只在请求在途期存在——收起动作收敛在 `loadSidebarWorks` 的 `finally`（成功/失败/取消统一），禁止再放回成功分支之内（原实现失败分支漏收，页尾触底后加载圈永挂，无法辨别是否已取完）。失败态兜底文案填入 loader 后，**下一轮加载开始前必须还原纯 spinner**（否则重试/续页期间无加载态、错误文案滞留到成功之后）。列表终点：游标 null（无更多页）且有成列内容时显示 `#sidebarEndNotice`「已全部加载」（`#resetSidebarGrid` 与每次加载开始先复位，收尾重判）；空结果/失败不显示。

### 侧边栏作品悬停预览（2026-11-01 定案）

侧边作品栏条目与作品域卡片同源播放：`FETCH_WORKS_PAGE` 返回的每条 work 已带 `video`（三级取链，见 [02](./02-independent-sync-works.md)），`#createWorkItem` 按 `utils.getVideoUrl(work)` 保留模板里的 `.sidebar-work-player`（`preload="none"`、无 src 常驻；图集 note 直接移除节点，同作品卡无预览）。

- **起停**：`dom.sidebarWorksGrid` 容器级 `pointerover/out` 委托 `.sidebar-work-link`（`relatedTarget` 仍在同一链接内则忽略 = 跨界只触发一次），`HOVER_PREVIEW_DELAY` 后赋 src 起播；`canplay` 才 `play()`，`play` 事件提交 `.video-ready`（封面 `.video-hidden` 透明过渡，零空档）。`#stopPreview` 清 `hovered`、暂停、复位封面。
- **停播收口**：指针移出、外链点击（新标签页打开时指针未必移出）、条目降级（`#demoteItem` 同时移除 src 释放解码缓冲）、切作者/列表重置（`#resetSidebarGrid`）、侧栏收起（`setSidebarWidth(0)`）、页面隐藏（main.js `visibilitychange` → `Sidebar.stopAllMedia`）。`sidebarBody` 滚动后按保鲜的指针坐标重判（补「滚动把条目移走、浏览器不重发 pointerout」的 hover 粘住）。
- **共用媒体体系**：起播读 `state.mediaMuted`，网格/详情切换静音经 `WorksGrid.syncMediaMute → Sidebar.syncMediaMute` 同步在播预览；起播前守 `detail.mediaRetryBlocked()`，error 走 `detail.handleVideoError`（重试耗尽即停播复位），成功 `detail.markMediaOk`。预览无控件（指针事件穿透到封面链接），故不提供播放/进度/静音按钮。

### 作品卡作者域状态 chip（关注/候选，2026-10-31 定案）

作品/点赞/收藏域的作品卡在 `.work-author-row` 内、作者名与发布日期之间显示两个状态 chip（`关注` / `候选`），表达「该作者是否在本地关注/候选域中」：

- **数据（uid 主键集，禁止拉全量记录）**：作者域主键即 `uid`（IDB keyPath），`GET_AUTHOR_UID_SETS` 经 `storage.getAllKeys` 并行返回两域 uid 数组（不反序列化记录）→ options `services.loadAuthorUidSets()` 建 `state.followedUids`/`state.candidateUids`（关注集同时供候选域重叠清理复用）。失败保持旧集合并返回 false，调用方按「不显示 chip」降级，不阻塞网格加载。
- **刷新时机**：init 首屏渲染前、切域进入作品型三域前（`store.on("domain")` 内 await）、停留在作品域时收到关注/候选域 `STORE_CHANGED`（`flushStoreChanged` 的 bulk 分支：先重取主键集，再 `syncAuthorFlags()` 原地 patch）。作者域删除/移动不发广播（导入/重置由 `ImportExport` 主动同步主键集），切域刷新即兜底。
- **渲染**：chip 随 `fillCard` 懒创建（同 `.work-checkbox`，骨架模板不含、`clearCard` 移除），不在骨架卡上常驻；`#applyAuthorFlags` 写 `card.dataset.uid` 并按 `Set.has(uid)` toggle `.hidden`；主键集刷新后 `WorksGrid.syncAuthorFlags()` 只遍历挂载卡 toggle、**禁止整刷**（零封面重探/零滚动跳位）。
- **语义**：按域内存在性判定（跨分组，「稍后删除」组也算命中）；关注/候选同时命中显示两个 chip；作品无 `uid` 不显示；chip 为普通 span、`pointer-events:none` 不可点击。**`authorFollowed`（平台关注快照）已从 Work 记录移除；禁止在 Work 上重建该派生字段**。
- **视觉**：10px 字号 / 14px 行高嵌在 16px 作者行内，不改变 `.work-info` 30px 高度数学；关注绿、候选紫，仅命中时显示。

### STORE_CHANGED 增量收口管线（options 侧合并处理）

载荷与发送侧语义（point/bulk、`changed>0` 门控、`GET_WORKS_BY_IDS` 补拉）见 [10](./10-storage-write-and-import.md)；options 侧接收管线在本册定案。

- **合并处理节奏**：隐藏期只标脏（rAF 冻结期拉数据/排队渲染皆白做）、回前台 `visibilitychange` flush 一次、可见期 300ms 去抖——逐件保存连发只触发一次收口（排队 N 次全网格重载会让回扩展页首帧卡死，2026-09 定案）。
- **flush 时统一走局部应用管线，逐条分流**：
- state 内已存在 → 原地替换 + `updateCardsDOM` 批量更新（入口一次建 id→下标 Map 替代逐条 findIndex 的 O(N×M)；网格侧一次 `querySelectorAll` 建 id→卡映射，逐卡注入调用方持有的合并记录，免逐条 state.find + querySelector）；
- 新增落在当前视图内 → **头插收口** `tryHeadInsert`：state 按视图序二分落点 + 网格 `insertItems` 原地挂载（含视口锚定补偿），零整刷。落点计算与落库分离——全部在原始 list 上二分（sorted 与 list 同为视图序，落点单调不减），runs 按「同原始落点」分组后**逆序** splice / insertItems（O(条数×N) 搬移收敛为 O(runs×N)；网格侧 #slots 尚无前序 run 的插入，原始落点即对位下标，逆序插入不改变已插区段相对位置）；bulk 载荷先经 `GET_WORKS_BY_IDS`（`DomainHandlers.getByIds` 主键直取）补拉合并后记录再走同管线；
- 新增落在当前视图外 → 仅 `refreshGroups`（分组计数重算）；分组 tab 渲染按「集合/顺序/名称」diff，结构不变时只 patch 变化 tab 的文本（保横向滚动、hover/focus 与滑块），不重建顶栏节点；
- 守卫分流：筛选 / 批量 / 详情 / 快滚冻结 `grid.isScrollFrozen()` / 口径意外 / **规模超限** → 整域重载兜底，正确性优先，不得绕过守卫强行走增量；**在途分页加载 `services.isGridLoading()` 不整刷**：点变化按 id 合并排队（`deferredUpserts`），本轮分页收尾时 `store.notify("grid-load-idle")` 再走同一增量管线（头插/原地更新）——单条保存落在长分页窗口内若整刷，会把整屏卡推回骨架重建（封面全量重探，视口黑屏）且重载重启整轮分页，连续「存入」会反复命中守卫、反复黑屏；守卫**仅对触及当前视图的变化生效**——一批变化全部落在当前视图外（如浏览分组 Z 时新作品落未分组）时，筛选/批量/详情/作者数排序均不构成整刷理由，只 patch 分组计数；预铺待消费 `state.gridSlots` → `"deferred"`（借道待渲渲染：state 已就位、排队中的整渲接管），不触发重载。
- **增量路径的规模守卫（2026-09 定案）**：bulk 补拉 id 数超过 `GRID_PREMOUNT_CAP`(1500) 在 `applyBulkChanged` 入口直接整刷兜底——`insertItems` 为每条挂一张骨架卡，超预铺容量即突破活 DOM 规模封顶；补拉响应是全记录过消息通道（千条 ≈ MB 级 structured clone），入口拦截省一次巨型往返。`tryHeadInsert` 不重复设防：其输入经调用方有界（点载荷 ≤ `UPSERTS_MAX`=8、bulk 路径 ≤ 上述上限），超大新增的兜底统一发生在补拉入口。
- **落点比较器必须与 `savedAt_id`/`groupId_savedAt_id` 索引的 prev 遍历同序**（savedAt 降序、平级 id 降序）——错序会在平级记录间插错位（下次整刷自愈但不该发生）。
- **域不匹配（跨域回声，如批量入库的 works 广播绕回点赞/收藏域）接收时直接丢弃**，连分组重算都省；flush 时刻须再校验域一致（接收后用户可能已切域，过期载荷不能信）。
- **红线**：新增落当前视图禁止改回「视图内新增 → `loadDomainData` 整刷」（wipe→灰骨架→封面重探即用户感知的「页面闪烁」）；bulk 广播载荷只带 id 集，禁止改回广播全量记录（万级消息膨胀）。

### 回顾域（真实域：随机卡片网格 + 引用持久化，2026-11 定案）

- **真实域**：右侧域切换新增「回顾」页签，`state.domain` 可取 `review`；`review` 表只存批次引用 `{ reviewId, sourceDomain, sourceId, kind, groupId, addedAt }`，展示时由 `review-handlers` 回源域 hydration，不复制完整作品/作者记录；来源记录删除后对应引用失效并被清理。
- **配置与批次**：**来源域下拉 + 本轮抽取数量**作为配置迁入**设置弹窗**（面板顶部单行；数量 1–500 整数，关闭时校验并随运行参数一并持久化）；**随机入口并入右侧导航轨「同步」按钮**（回顾域下点击该按钮触发抽样，按钮文案/图标保持「同步」不变），顶栏不再有回顾动作按钮，**「追加」功能已移除**；「随机回顾」创建/替换批次：有当前批次时优先排除本批记录，排除后无新数据则允许整批重抽；配置持久化在 `chrome.storage.local.randomReviewConfig`，批次引用在 IDB `review` 表。
- **抽样**：`GET_RANDOM_RECORDS` 由 background 按主键（全域名 `getAllKeys` / 组内 `getAllKeysByIndex`）部分 Fisher-Yates 抽样，再 `getBatch` 取记录；只返回最多 500 条，不物化整域；`excludeIds` 供「随机回顾」优先排除当前批次记录。
- **渲染**：`GET_REVIEW` 按整批回源 hydration 后返回 `reviewItems / sourceDomain / kind / total`；`state.reviewKind` 为 `works`/`authors`，`SearchBar.#isWorkRecordDomain` 与 `gridForDomain("review")` 动态选择作品/作者视图；作品批次复用 `WorksGrid`/`Detail`，作者批次复用 `AuthorGrid`/右侧作品栏。
- **域能力**：回顾域保留搜索/筛选、**分组顶栏与分组管理**、**批量模式**（批量删除/移动/下载；删除与移动只改回顾引用）；不含导入/导出/重置入口；详情移除只改 `review` 引用，来源域数据不变。批量模式与右栏「随机」入口同时可用，不互相隐藏。
- **抽样入口**：`GET_REVIEW` / `SAVE_REVIEW_BATCH { sourceDomain, sourceIds, groupId }` / `DELETE_REVIEW { sourceDomain, sourceIds }` / `MOVE_REVIEW { sourceDomain, sourceIds, targetGroupId }`；`SAVE_REVIEW_BATCH` 清空旧引用后写入新批次（`groupId` 缺省/“all” 落默认「未分组」），只写引用不复制记录。
- **红线**：禁止把回顾记录复制进 `review` 表（只存引用）；批量删除/移动禁止直接调用来源域的 `DELETE_*`/`MOVE_*`；回顾域不参与导入/导出；`review` 引用表不得替代源域记录。

## 异常场景及处理

| 场景 | 表现 | 处理/禁止事项 |
|------|------|----------------|
| 绕过 store 的域数据原地写入未自增 `state.dataVersion` | 视图阶段缓存读到脏数据（新条目不出现、删除条目残留），不炸只错显 | 现存两处手动自增点（main.js tryHeadInsert 头插 splice / applyStoreUpserts 原地替换）；detail.removeWork 走 store.removeWorkRecordSilent、自增在封装内；新增绕行写入点必须同步自增（见「视图阶段缓存」节） |
| 调用方原地变更 `getWorksView`/`getAuthorRecordsView` 返回数组 | 污染共享缓存，后续视图/计数/Detail 导航全部串位 | 视图函数返回共享缓存数组，调用方只读；需要变更序自行拷贝 |
| 封闭视图（筛选态）扩容克隆无键占位卡 | 没有 fillSlots 回填方，第 601 张起永久灰卡 | `#extendSlotsTo` 键控分支从 `#viewItems` 快照取真实条目（补铺与滚近扩容共用）；锚失配不扩容留待整刷自愈 |
| 键控扩容的在册判定写反（`!#itemMap.has` 才克隆） | render 已把视图全集登记进 itemMap，条件恒假 → 扩容全落无键占位卡，封闭视图 600 以远永久灰区（2026-09 修复） | 在册（`itemMap.has` 命中）才克隆带键卡；快照含已移除条目（removeItems 已从 itemMap 摘除）时落占位兜底 |
| `removeItems`/`insertItems`/`appendItems`/`#applyFill` 不同步维护 `#viewItems` | 键控扩容的锚接续取数错位（复活已删条目/漏掉新插条目） | 四个变更原语与快照同步维护（filter/splice/push/补登），`#viewKeys` 负责去重 |
| 筛选态首帧同步全量预铺（预铺数 = 结果数） | 每次筛选切换付出 O(结果数) 的骨架克隆 + 整容器布局（十万级 = 秒级卡顿） | 首帧恒为 `GRID_PREMOUNT_CAP_FILTER`，余量行走尾部占位预留（#syncTailReserve 纯 style 写入） |
| 封闭视图不做尾部占位、只靠滚近扩容 | 滚动到远处时内容持续变长，滚动条滑块被按比例打回（实测 600→1200 时 0.95→0.49，反复出现） | `#syncTailReserve` 首帧预留总长；铺卡/占位等量收缩、净高恒定（2026-10 定案） |
| 封闭视图余量用「预挂/后台补铺真实卡」实现总长预留 | 大 M 下每次容器追加都是全网格重排（实测 2 万卡单次约 130ms、4 万约 1s），曾致排序切换连帧卡顿 | 占位必须是纯 style（padding-bottom），卡片一律滚近按需铺入 |
| 自动翻页把全部条目挂进 DOM（append 无上限） | 活动 DOM = 全库条目；改一次卡宽就是全量重排（实测 2 万卡约 900ms），窗口缩放/作品栏拖宽整页卡顿 | `#mountAppend` 到 `GRID_MOUNT_MAX` 即止：超出只登记进 `#viewItems`/`#itemMap`，滚近由键控扩容铺真卡（2026-10 定案） |
| 活动窗口重挂时整窗从快照重克隆骨架 | 视口内已填充卡瞬间回退灰骨架、再经 0.3s 封面淡入恢复（滚动期「网格闪一下」）；窗口铺到已加载末尾后每滚一行 target 就 +1，逐行整窗重建 | 新旧窗口重叠区按 itemKey 复用原卡节点（完整卡保留封面/文案，仅新边行克隆骨架）；`windowEndRow ≥ totalRows` 时下滚不再重挂（2026-10 修复） |
| 视图计算在渲染与计数间各跑一遍（改回 `syncCount()` 内重算、renderCards 内重取） | 大库下重复整段过滤+排序（每遍 30–100ms 起） | `refreshGridView` 单次计算贯穿渲染与计数；`syncCount` 接受注入 count |
| 哨兵卡被 `removeItems` 删除 | 分圈观察断链，后续骨架永不 observe | 删除后立刻续接哨兵 |
| `removeItems` 只 splice `#slots` 不收缩 `#totalSlots` | 差额被 `#extendIfNeeded` 当作未铺配额，滚近底部时原样补回等量无键占位卡——被删卡片的骨架永久滞留（2026-09 修复） | 两者必须同步收缩；拼装窗口内无连接卡的已删条目同样计入（其节点挂载前被对账丢弃、永不占槽） |
| 窗口态下 `removeItems` 把已加载数缩到 ≤ `GRID_MOUNT_MAX`（或窗口被掏空），却仍残留 `#headTrim > 0` | `#syncWindow` 的「非窗口化」早退认定无需窗口化 → 永不重挂；头部回收区只剩 `padding-top`，上滚即整屏空白（无卡无骨架），且自锁不复原；`children.length === 0` 还会误报「没有作品」 | **`total ≤ GRID_MOUNT_MAX ⟺ #headTrim === 0` 为硬不变量**：`removeItems` 收缩后若 `known ≤ GRID_MOUNT_MAX && #headTrim > 0` 立即 `#remountWindow(0)`、窗口掏空（`#slots.length === 0 && known > 0`）按视口行重挂；`#syncWindow` 非窗口化分支兜底重挂；`#totalSlots` 下界取**视图系**剩余数（`#viewItems.length`，非窗口系 `#slots.length`）；空态按 `known` 判定（禁止 `container.children.length`）（2026-10 修复） |
| 回收区删除（`removeItems` headHits）收缩 `padding-top` 后未补偿 scrollTop | 窗口内容整体上移、视口落到另一段行；浏览器滚动锚定对 padding 收缩不生效（实测 scrollTop 原样保留），又没有 scroll 事件调度 `#catchUpToViewport`——暴露出来的卡若在分圈观察前沿之外就无人 observe，视口整屏停在灰骨架、等到下一次滚动才渲染（批量移动/删除已滚过的卡片后必现） | 与 `#insertAboveWindow` 的对偶：`#syncHeadPad` 后按占位差值反补 scrollTop（Δ>0 时减回、clamp 0）保持视口内同一批卡原位；删除收尾统一补一次 `#scheduleCatchUp`（与 `#finishRender` 同一收口纪律，覆盖节点级删除的残余位移）（2026-10-30 修复） |
| 快滚停稳直接清空积压填充队列 | 积压卡入队时已 unobserve，滚回带区再无 IO 触发——被快滚扫过的区段永久停在骨架态（2026-09 修复） | `#refillBand` 丢弃前全量重新 observe；快滚判定基准只在 scroll 事件侧推进（rAF 双读者各自推进会互相污染 delta，冻结逐帧被打断） |
| 原位整刷（等高重渲）后视口带区骨架无人观察 | wipe 与重挂同任务同步完成、前后内容等高 → 滚动位置保留、无 scroll 事件；分圈哨兵停在网格顶部够不着中部视口，`#catchUpToViewport` 只由 scroll 事件调度——批量同步 SYNC_DONE 整刷后卡片滞留灰骨架，手动滚动才出封面（2026-09 修复） | `#finishRender` 收尾统一补一次 `#scheduleCatchUp`（与 scroll 触发共用同一追赶机制；rAF 下一帧测量时全量挂载已完成） |
| 拼装窗口内删除的条目照常挂载 | 带键但 itemMap 已无条目的无主骨架，`#doFill` 永远填不上（永久灰卡） | 挂载前按 itemMap 对账，死节点不挂载不占槽 |
| 余量骨架未挂载就交接观察 | `#extendObservation` 把未连接节点视作重渲染死节点直接丢弃，分圈断链 | 拼装完成后必须先 `appendChild` 挂载、再 `#observeNewSkeletons` |
| fill IO 回调对占位卡 unobserve | 预铺占位卡被摘除观察后，回填完成也永不再触发填充（永久灰卡） | 回调对无键占位卡保持观察；带内回填由 `fillSlots` 主动入队 |
| 网格卡片层挂 `content-visibility: auto` | 屏外卡整棵跳过渲染（无像素），远跳落点要走「相关性判定→补布局→绘制→光栅」按需管线，瞬间只见空占位框（透底色）、骨架延迟出现；快速滚动期 CV 进出判定 = Layerize 抖动 | 网格全量预铺架构下禁用 CV（2026-09 定案，`.work-card`/`.work-skeleton`/`.following-card`）；骨架扫光随之静态化（动画元素各自晋升合成层，万级下成本不可接受） |
| 渐进分页经 `'works'` 事件逐页 `store.set` 消费 | 每页触发全量重渲：骨架闪烁、已填卡封面重探 | 回填必须走 `appendWorkRecord`/`prependWorkRecord` → `fillSlots`；页序与视图序对齐（saved 排序键）时逐页续填，作品数排序或加载中途切排序（方向失配）时静默累积、加载完整渲 |
| `render()`/`abortRender()` 未清队列状态 | 旧骨架引用残留、重复填充 | 重置时同步清 `#pendingSkeletons`/`#sentinelCard`/observers |
| 用 `replaceChild`/`replaceWith` 换卡片根节点 | Blink 全量重排，3000 卡单次 >10ms | 只允许原地切换（改类名 + 增删后代） |
| 把填充/卸载两圈 rootMargin 调近 | 边界抖动、反复填/降级 | 保持滞回间隙（1600px vs 2400px，800px） |
| 媒体重试自行计数 | 与熔断窗口叠加放大请求量 | 一律接 `Detail.markMediaFail/mediaRetryBlocked` |
| 在途探针回调不校验代际 | 旧 URL 提交到已换人槽位（错图） | 先验 fillGen/coverGen/gen/imgProbeToken 再提交 |
| hover 预览改用 pointerenter/leave | 功能静默失效 | 只用冒泡的 pointerover/out 委托 |
| 旧网格不 abort 直接保画面（"不清场保无闪烁"及其「冻结-定格」变体） | 在途工作不中止 + 同容器重建聚帧，体感卡顿；定格变体被用户定案否决（旧画面定格感知为卡顿，必须先清空） | 切换瞬间 `clearActiveGrid()`（abortRender×7 + wipe）先清空，数据到达后 render() 重建 |
| options 侧 Toast 改为顶部居中堆叠后，content 注入侧同为顶部单条 | 两侧视觉漂移（options `.toast` 与 content.js `Toast` 是两处实现） | **有意分层（2026-11-09，2026-11-09 二次修订）**：options 侧顶部居中堆叠、纯文本 pill（无图标/关闭钮，半透明黑底 + 左侧 3px 类型色条，宽度随内容收缩，最多 3 条，info·success 2s、error 4.5s）；content 侧继续顶部单条非交互，仅保留颜色语义与时长。不要为了「看起来一样」把注入侧改成可交互浮层。文案不带 emoji |

## 配置项说明

options 侧 `config`（64 键，含 icons 图标表）的权威键表与默认值统一维护在 [01](./01-project-architecture.md)「配置项说明 · options/core.js 顶层 config」，本册不再重复分表；各分册只收录与其机制直接相关的键（如 `GRID_PREMOUNT_CAP`/`FAST_SCROLL_THRESHOLD` 见上文渲染管线）。

## 响应式状态管理（store.on 事件表）

> 本节自 AGENTS.md 迁入（2026-10-03 瘦身）。`store.on()` 监听事件：

| 事件               | 处理                                                                                                     |
|--------------------|----------------------------------------------------------------------------------------------------------|
| `'domain'`         | 刷新入库按钮可用态（`syncSaveToWorksBtn`/`syncSaveToCandidatesBtn`）；**首页数据请求先发**；`groups.clearForDomainSwitch()` 立即清空旧域 tab，`GET_DOMAIN_GROUPS` 只读对应 `*_groups` 小表一次渲染新域分组名/顺序/计数（与 page0 并行）；作者主键集经 `services.whenFirstScreen` 在首屏后一个宏任务取（chip 到达后 `syncAuthorFlags()` 原地 patch） |
| `'works'` / `'favorites'` / `'collections'` | `search.refreshGridView()`（仅 domain 命中该域时）                                                       |
| `'work-record-appended'` | 渐进分页回填（作品型三域，loadDomainData 逐页发）：页序与视图序对齐时 `fillSlots`（视图下标）+ `syncCount`，`done` 时 `pruneEmptyTail` 摘尾；不对齐（作品数排序/加载中途切排序）时静默累积、加载完成整渲；domain/groupId 双校验防旧页混入（细节见本册「STORE_CHANGED 增量收口管线」） |
| `'followings'` / `'candidates'` | domain 命中时 `search.refreshGridView()`                                                                  |
| `'groups'`         | `groups.renderGroupTabs()`                                                                               |
| `'grid-total'`     | `loadDomainData` 首页权威 total 到达后广播：`groups.onGridTotal` 校正当前分组 tab 数字（快照通常已含计数；快照与 page-0 之间若发生写入，以 page-0 为准） |
| `'currentGroupId'` | `appShell.clearActiveGrid()` + `groups.syncActiveTabs()` + 加载域数据（tab 集合未变，不重建 tab；分组计数沿用当前域快照）         |
| `'batchMode'`      | toggle body `.batch-mode` class + `Batch.syncSelectionUI`（独立 `#batchBar` 显隐与主网格底部安全区均由 CSS `body.batch-mode` 驱动）        |

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
| 13 | [13-design-red-lines.md](./13-design-red-lines.md) | 设计红线与知识点陷阱完整版（自 AGENTS.md 迁出） |
