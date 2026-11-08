// ---------- VirtualGrid（抽象基类，仅导出 class 不实例化） ----------
import { config, dom, state } from '../core.js';

// ---------- VirtualGrid ----------
export class VirtualGrid {
  #observer = null;
  #unloadObserver = null;
  #fillQueue = [];
  #drainRafId = 0;
  // 停稳降级分帧：unload IO 成批积压的待降级卡（快滚期冻结），按帧预算 drain
  #pendingDemotes = [];
  #demoteDrainRaf = 0;
  #pendingSkeletons = [];
  #pendingAppends = [];
  #pendingFills = [];
  #pendingInserts = [];
  // 预铺槽位表：render 按文档序持有的全部卡节点（真数据卡 + 未回填占位卡），
  // 渐进页经 fillSlots 以键前缀自锚定回填。与域数组同步收缩（removeItems filter
  // 一次性重建 + #totalSlots 同步递减），对齐不变
  #slots = [];
  #totalSlots = 0; // 预铺目标总槽位（首页响应 total）：#slots 按上限铺、滚近底部倍增扩容至此
  // 视图快照：render 入参条目的浅拷贝，键控扩容（#extendIfNeeded）的取数源。头插/移除
  // 经 insertItems/removeItems 原地维护本表；拷贝隔离保证不反噬调用方持有的数组
  #viewItems = null;
  // 快照键集（登记去重）：页序单调，新页按到达序 push 即维持与视图同序
  #viewKeys = new Set();
  #sentinelCard = null;
  #itemMap = new Map();
  // 卡片节点 → 已填充条目对象（render 节点复用判据）：同键且同对象才搬运，防复用陈旧内容
  #cardItem = new WeakMap();
  #chunkRaf = 0;
  #scrollRafId = 0;
  #boundClickHandler = null;
  #container = null;
  // 快滚态（scroll 事件帧间差判定，见 #onGridScroll）：冻结填充与降级；
  // 停稳由 drain 轮询经 epoch 计数检测（rAF 读取者不推进判定基准）
  #lastScrollTop = 0;
  #scrollFast = false;
  #scrollEpoch = 0;
  #fastEpoch = 0;
  // 滚轮级停稳收口：FAST_SCROLL_THRESHOLD 是帧间位移阈值，只有拖拽滚动条达得到——
  // 滚轮平滑滚动全程 scrollFast 恒 false、refillBand 永不执行，停稳没有「丢积压 +
  // 视口带区直填」兜底。settle-checker 在滚动静止一帧后补同款收口
  #settleRaf = 0;
  #settleLastEpoch = 0;
  // 尾部占位（封闭视图）：以容器 padding-bottom 预留「未挂载余量行」的高度，滚动条总长
  // 在渲染首帧即收敛为终值——纯 style 写入、零卡片追加，滚动中内容零增长、滑块无回退；
  // 未挂载区随滚近由 #extendIfNeeded 按需铺卡并同步收缩占位（净高恒定）
  #tailReserve = 0;
  // 占位高度推导出的列数/行高（#slotsToReach 远跳追赶复用；非封闭态清零）
  #reserveCols = 0;
  #reserveRowH = 0;
  // 活动 DOM 窗口：槽位 0 对应的视图下标（重挂时整块平移）与头部占位行数/高度。
  // 窗口外的条目由 padding-top 代表，卡片脱 DOM——改一次卡宽只重排窗口内的卡
  // （实测每卡约 60µs，窗口恒定后折叠侧栏成本与总条目数解耦）
  #headTrim = 0;
  #headRows = 0;
  #headPad = 0;
  // 重挂防重入（重挂同步完成，仅防观察回调在换树窗口内回调）
  #remounting = false;
  // 远跳追赶续铺 rAF id（拖拽跳进占位区后按视口带区连帧赶齐，覆盖即止）
  #rushRaf = 0;
  #skeletonClass = "";
  #itemClass = "";
  #itemKey = "";
  #emptyMsg = "";
  #emptyHint = "";
  // 自适应卡宽布局结果（#applyLayout 落笔）：#applyFill 带区估算与 getGridLayout 消费方
  #layoutCols = 0;
  #layoutCardW = 0;
  // 上次落笔的容器宽：RO 回调只认宽度变化（本类写入只改高度不改宽度），自身写入
  // 触发的回读通知据此截断，避免 RO 自持循环（ResizeObserver loop 报错）
  #lastLayoutW = 0;
  // 改宽锚点（调用方在会改列数的 mutate 前登记，如 Sidebar 打开作者侧栏用被点击卡）：
  // 位移补偿整体挪进 RO 回调——点击任务零几何读取，测量发生在布局洁净的 RO 时机
  #resizeAnchor = null;
  // 改宽当帧跳过扩容探测：锚点已保持视口相对内容位置，占位在紧随的 rAF 里按新布局重算
  #skipExtendOnce = false;
  // 改宽当帧跳过窗口重挂：锚点补偿已把视口钉回原位，行号重算留到下一次滚动/停稳
  #skipWindowOnce = false;
  // 尾部占位几何缓存键（列数×卡宽）：同一布局下只实测一次，滚动帧零测量
  #reserveKey = "";
  // 容器宽度观察（窗口缩放等被动路径）：RO 回调内只登记、不写，落笔推迟一帧
  #resizeObserver = null;
  #resizeRafId = 0;
  #cardSizeVar = "--dy-card-size";
  // 卡宽容差带（占理想卡宽比例）：默认取全局 config，子类可经构造参数按域覆盖
  #sizeBandMin = config.CARD_SIZE_BAND_MIN;
  #sizeBandMax = config.CARD_SIZE_BAND_MAX;

  constructor({
    container,
    itemClass,
    skeletonClass,
    itemKey,
    emptyMsg,
    emptyHint,
    cardSizeVar,
    sizeBandMin,
    sizeBandMax,
  }) {
    this.#container = container;
    if (cardSizeVar) this.#cardSizeVar = cardSizeVar;
    if (sizeBandMin) this.#sizeBandMin = sizeBandMin;
    if (sizeBandMax) this.#sizeBandMax = sizeBandMax;
    this.#itemClass = itemClass;
    this.#skeletonClass = skeletonClass;
    this.#itemKey = itemKey;
    this.#emptyMsg = emptyMsg || "";
    this.#emptyHint = emptyHint || "";
    this.#boundClickHandler = this.#activate.bind(this);
    // 点击委托绑在 #mainGrid（稳定节点）而非容器上：clearActiveGrid 换壳重建容器后无需重绑
    dom.mainGrid.addEventListener("click", this.#boundClickHandler);
    dom.mainGrid.addEventListener("scroll", () => this.#onGridScroll(), { passive: true });
    // RO 观察 #mainGrid（稳定节点）而不是 #mainContainer：容器是本类唯一会写尺寸的对象
    //（轨宽/上下占位/铺卡都改它的高度），观察它会让「回调内写入 → 同帧回读通知」
    // 触发浏览器的 ResizeObserver loop 告警（undelivered notifications）。#mainGrid 的
    // 尺寸只由父级布局（侧栏折叠/窗口缩放）决定，宽度语义与之等价（容器宽 = 其内容宽）。
    // 初次 observe 会立即回调一次：此时实例未活跃，被 #onContainerResize 门控跳过
    this.#resizeObserver = new ResizeObserver(() => this.#onContainerResize());
    this.#resizeObserver.observe(dom.mainGrid);
  }

  get skeletonClass() {
    return this.#skeletonClass;
  }

  // 空态文案只读暴露：基类单份持有（#showEmpty / pruneEmptyTail / removeItems 复用），
  // 子类组合默认文案经此取，不再自存第二份
  get emptyText() {
    return this.#emptyMsg;
  }

  get emptyHintText() {
    return this.#emptyHint;
  }

  // 自适应布局结果只读暴露：子类滚动估算兜底（works-grid scrollTo 未建卡分支）复用；
  // 未落笔（#resetRenderState 清零）时返回 null，调用方回退 CSS 变量旧估算
  getGridLayout() {
    return this.#layoutCols ? { cols: this.#layoutCols, cardW: this.#layoutCardW } : null;
  }

  // 行高解析钩子（子类按卡结构覆写）：返回 0 = 行高与卡宽无关、用实测缓存。
  // 改宽当帧头部占位要与新行高同步落笔，实测会多逼一次重排，解析式可零读取
  rowHeightFor(cardW) {
    return 0;
  }

  // 清场换壳后重指向新容器（容器级事件监听与 RO 都绑在 #mainGrid 上，不受换壳影响）
  attachContainer(el) {
    this.#container = el;
  }

  // 改宽锚点登记（可选）：调用方在会改列数的 mutate（侧栏折叠/展开/拖宽落点）之前调用，
  // 补偿由紧随的 RO 回调消费。未登记时 #onContainerResize 回退「视口最上方卡」——
  // 对折叠/展开/窗口缩放与登记同效，登记只用于「指定某张卡保持不动」（打开作者侧栏）
  setResizeAnchor(el) {
    this.#resizeAnchor = el && el.isConnected ? el : null;
  }

  render(items, emptyMsg, emptyHint, totalSlots = 0, premountCap = config.GRID_PREMOUNT_CAP) {
    cancelAnimationFrame(this.#chunkRaf);
    this.#chunkRaf = 0;
    // wipe 前先停媒体：卡片摘除后 pointerout 永不触发，游离的播放中 video 会继续出声
    this.stopAllMedia();
    // 节点复用重排：wipe 前按 key 收集旧窗口卡（见 #collectReusableNodes），新视图同键
    // 槽位直接搬运原节点——已填充卡的封面/文案/媒体状态原样保留，不重探不重建，消除
    // 「整屏回灰骨架再回填」的二次刷屏。itemMap 与随后重置共用同一次键扫描
    const itemMap = new Map(items.map((item) => [item[this.#itemKey], item]));
    const reusable = this.#collectReusableNodes(itemMap);
    this.#container.className = "main-container";
    this.#container.innerHTML = "";
    dom.emptyState.classList.add("hidden");
    dom.errorState.classList.add("hidden");

    // 先完全重置实例状态（含空列表分支），避免残留 observer/队列影响后续渲染
    this.#resetRenderState(itemMap);
    // 视图快照（键控扩容取数源）：浅拷贝隔离，头插/移除的原地维护不反噬调用方数组
    this.#viewItems = items.slice();
    this.#viewKeys = new Set(items.map((item) => item[this.#itemKey]));

    // 重置后落自适应卡宽（列数/轨宽；resetRenderState 清布局字段，必须在其后落笔）：
    // 后续骨架卡直接铺进正确网格轨，避免「先按旧轨宽成行、落笔后再重排」的一帧错排
    this.#applyLayout();

    if (items.length === 0) {
      this.#showEmpty(emptyMsg, emptyHint);
      return;
    }

    this.#container.classList.remove("hidden");

    const skelTmpl = this.#getSkeletonTemplate();
    // 预铺数三重上限（调用方按态传 GRID_PREMOUNT_CAP / GRID_PREMOUNT_CAP_FILTER +
    // 活动 DOM 硬上限 GRID_MOUNT_MAX）：超出部分由滚近底部时键控扩容（#extendIfNeeded）
    // 铺卡——切组拆卸/布局/绘制的 O(N) 成本以 N=已挂载数为分母，而改一次卡宽要对每张
    // 已挂载卡重排内部子树（实测约 60µs/张），这是侧栏折叠/窗口缩放的卡顿来源。
    // 已知条目不再「全量铺」：快照（#viewItems）覆盖全部已加载条目，未挂载部分滚近
    // 由键控扩容铺真卡；余量行高由**尾部占位**（#syncTailReserve：容器 padding-bottom
    // 预留，style 写入零追加）在渲染首帧把滚动条总长收敛为已知条目终值，卡片滚近按需
    // 铺入、占位同步收缩——净高恒定，无「滚动中内容变长把滑块按比例打回」
    this.#totalSlots = Math.max(totalSlots, items.length);
    const slotCount = Math.min(this.#totalSlots, premountCap, config.GRID_MOUNT_MAX);

    // 两段式铺设：首段同步挂载（数据到达即出画面）；余量在游离 fragment 内按时间预算
    // 分帧拼装（脱 DOM 不触发布局），拼完一次挂载。容器全程只经历 2 次插入，万级列表
    // 从「逐帧向容器追加、每帧触发全容器 grid 重排（总成本 O(N²/块)）」收敛为收尾
    // 1 次 O(N) 布局
    const firstCount = Math.min(config.RENDER_CHUNK_SIZE, slotCount);
    const firstFragment = document.createDocumentFragment();
    const firstNodes = [];
    const firstSkeletons = [];
    const firstFilled = [];
    for (let i = 0; i < firstCount; i++) {
      let card;
      if (i < items.length) {
        const key = String(items[i][this.#itemKey]);
        card = reusable.get(key);
        if (card) reusable.delete(key); // 已复用：余量拼装不再重复取用
        else card = this.#cloneSkeleton(skelTmpl, items[i]);
        // 入场动画只限定首段卡：筛选切换/扩容时数百张卡不再同帧起 350ms opacity 动画
        //（屏外卡同样参与动画 tick），滚入/回填的卡直接呈现。复用节点属性已在、不重播
        card.dataset.fade = "1";
      } else {
        card = this.#clonePlaceholder(skelTmpl);
      }
      if (card.classList.contains(this.#skeletonClass)) firstSkeletons.push(card);
      else firstFilled.push(card);
      firstNodes.push(card);
      firstFragment.appendChild(card);
    }
    for (const node of firstNodes) this.#slots.push(node);
    this.#container.appendChild(firstFragment);
    // 完整卡（节点复用命中的已填充卡）交卸载圈接管生命周期（与 #remountWindow 同一交接）；
    // 骨架/占位卡走分圈填充观察
    if (firstFilled.length) {
      this.#ensureUnloadObserver();
      for (const card of firstFilled) this.#unloadObserver.observe(card);
    }
    this.#observeNewSkeletons(firstSkeletons);
    if (firstCount >= slotCount) {
      this.#finishRender();
      this.#chunkRaf = 0;
      this.#drainPendingInserts();
      this.#drainPendingAppends();
      return;
    }

    let index = firstCount;
    let mounted = firstCount;
    const restNodes = [];

    const buildChunk = () => {
      const deadline = performance.now() + config.RENDER_BUILD_BUDGET_MS;
      while (mounted < slotCount && performance.now() < deadline) {
        let card;
        if (index < items.length) {
          // removeItems 可能落在拼装窗口内：已删条目不占槽（#slots 与域数组同步收缩，
          // 槽位对齐关系保持）；占位卡补足 total 缺口
          const item = items[index++];
          if (!this.#itemMap.has(item[this.#itemKey])) continue;
          const key = String(item[this.#itemKey]);
          card = reusable.get(key);
          if (card) reusable.delete(key);
          else card = this.#cloneSkeleton(skelTmpl, item);
        } else {
          card = this.#clonePlaceholder(skelTmpl);
        }
        mounted++;
        restNodes.push(card);
      }
      if (mounted < slotCount) {
        this.#chunkRaf = requestAnimationFrame(buildChunk);
        return;
      }
      // 挂载前对账：拼装窗口内被 removeItems 删除的条目（键已出 itemMap）不挂载不占槽
      // ——挂出即成无主骨架，#doFill 查不到 itemMap 条目、永远停在灰卡态。
      // 余量在游离态按时间预算分帧拼装（脱 DOM 不触发布局），此处一次挂载：
      // 容器全程只经历 2 次插入。必须先挂载再交接观察：#extendObservation 把未连接
      // 节点视作重渲染死节点直接丢弃
      const mountFragment = document.createDocumentFragment();
      const aliveNodes = [];
      for (const node of restNodes) {
        const key = node.dataset[this.#itemKey];
        if (key && !this.#itemMap.has(key)) continue;
        aliveNodes.push(node);
        mountFragment.appendChild(node);
      }
      const aliveSkeletons = [];
      const aliveFilled = [];
      for (const node of aliveNodes) {
        if (node.classList.contains(this.#skeletonClass)) aliveSkeletons.push(node);
        else aliveFilled.push(node);
      }
      this.#container.appendChild(mountFragment);
      for (const node of aliveNodes) this.#slots.push(node);
      if (aliveFilled.length) {
        this.#ensureUnloadObserver();
        for (const card of aliveFilled) this.#unloadObserver.observe(card);
      }
      this.#observeNewSkeletons(aliveSkeletons);
      this.#finishRender();
      this.#chunkRaf = 0;
      this.#drainPendingInserts();
      this.#drainPendingFills();
      this.#drainPendingAppends();
    };
    buildChunk();
  }

  // 节点复用重排（render wipe 前收集）：按 key 索引旧窗口卡，供新视图同键槽位原样搬运。
  // 仅复用两类节点：①骨架/占位（内容为空，回填管线会重建）②已填充且条目对象恒等
  // （封面/文案/媒体状态有效，搬运即零探针）。同键但对象已被替换（STORE_CHANGED
  // upsert/重载）不复用——旧内容可能过期，交给骨架重建走完整填充。无键占位卡不可复用
  #collectReusableNodes(itemMap) {
    const reusable = new Map();
    for (const card of this.#slots) {
      const key = card.dataset[this.#itemKey];
      if (!key) continue;
      if (card.classList.contains(this.#skeletonClass) || this.#cardItem.get(card) === itemMap.get(key)) {
        reusable.set(key, card);
      }
    }
    return reusable;
  }

  // 分页渐进加载追加（loadDomainData → main.js 按筛选态分流后调用）：新页骨架接在
  // 已渲染网格尾部，页序 savedAt 降序与既有排列单调一致。复用两段式铺设约束：
  // 游离 fragment 拼装、一次挂载、挂载后再交接分圈观察。首屏 buildChunk 未完成时
  // 排队，完成后 drain。已挂载数达到 GRID_PREMOUNT_CAP 后只登记不挂载——活动 DOM
  // 规模由滚近扩容（#extendSlotsTo）决定，不再被自动翻页推满
  appendItems(items) {
    if (!items.length) return;
    if (this.#chunkRaf) {
      this.#pendingAppends.push(items);
      return;
    }
    this.#mountAppend(items);
  }

  #mountAppend(items) {
    const skelTmpl = this.#getSkeletonTemplate();
    const fragment = document.createDocumentFragment();
    const nodes = [];
    for (const item of items) {
      const key = item[this.#itemKey];
      if (this.#itemMap.has(key)) continue; // 页间边界重复去重
      this.#itemMap.set(key, item);
      this.#trackViewItem(item); // 快照随真实追加生长（键控扩容取数序）
      // 活动 DOM 上限：超出预铺上限的已加载条目只登记不挂载（数据仍在 #viewItems /
      // #itemMap，滚近由键控扩容铺真卡）。自动翻页会把整域条目全部挂进 DOM——2 万条
      // 时改一次卡宽就是全量重排（实测约 900ms），是折叠侧栏卡顿的根因
      if (this.#slots.length + nodes.length >= config.GRID_MOUNT_MAX) continue;
      const card = this.#cloneSkeleton(skelTmpl, item);
      nodes.push(card);
      fragment.appendChild(card);
    }
    // 有「已登记未挂载」条目：尾部占位须随 known 增长（滚动条总长跟加载进度走），
    // 合并到下一帧 catchUp 统一重算——逐页写 padding 会多付逐页布局
    if (nodes.length < items.length) this.#scheduleCatchUp();
    if (!nodes.length) return;
    this.#container.appendChild(fragment);
    for (const node of nodes) this.#slots.push(node);
    this.#observeNewSkeletons(nodes);
  }

  // 视图快照登记（按 key 去重）：页序单调，push 即与视图同序。
  // 同时抬高预铺目标下界到「已加载条目数」——对齐模式的筛选视图总量要等全量到达才可知，
  // totalSlots 不能停在首页渲染时的快照长度，否则尾部占位不随页增长、后到条目滚不到
  #trackViewItem(item) {
    if (!this.#viewItems) return;
    const key = item[this.#itemKey];
    if (this.#viewKeys.has(key)) return;
    this.#viewKeys.add(key);
    this.#viewItems.push(item);
    if (this.#viewItems.length > this.#totalSlots) this.#totalSlots = this.#viewItems.length;
  }

  #drainPendingAppends() {
    if (!this.#pendingAppends.length) return;
    const queue = this.#pendingAppends;
    this.#pendingAppends = [];
    for (const items of queue) this.#mountAppend(items);
  }

  // 渐进分页按槽回填：数据页与预铺骨架同为 savedAt 降序，页内条目对号入座——写真实键
  // + 登记 itemMap，零 DOM 增删（无布局开销）。落点由 #applyFill 以网格键前缀自锚定
  // （传入下标与首个无键槽取小者）：删除会让 #slots 相对页序收缩，固定下标会整页写偏。
  // 预铺 buildChunk 未完成时排队（此时槽位尚不存在，直接回填会误走追加造成双卡），
  // 拼装完成后 drain。视口带内的占位卡直接入填充队列（IO 对已相交目标不会重复回调），
  // 带外的保持观察、滚近自然触发。槽位越界/已占键的条目经 appendItems 登记（活动 DOM
  // 到上限后只进快照不挂载，滚近由键控扩容铺真卡）
  fillSlots(startIndex, items) {
    if (!items.length) return;
    if (this.#chunkRaf) {
      this.#pendingFills.push({ startIndex, items });
      return;
    }
    this.#applyFill(startIndex, items);
  }

  #applyFill(startIndex, items) {
    // 快照补登：槽位回填不经过 #mountAppend，不补登会让 #viewItems 缺口页——键控扩容
    // （尤其「已加载未挂载」的尾部）的取数序会整体错位。页序单调，push 即有序
    for (const item of items) this.#trackViewItem(item);
    // 完全落在窗口上方（已回收区）：只登记快照 + itemMap，无槽可填（itemMap 必须补登——
    // 窗口回滚到该区时按 itemMap 命中与否决定铺真卡还是占位卡，漏登会留永久灰卡）
    if (startIndex + items.length <= this.#headTrim) {
      for (const item of items) this.#itemMap.set(item[this.#itemKey], item);
      return;
    }
    // 视图下标 → 槽位下标（窗口起点 headTrim），本页跨窗口上界时由此得到负落点
    const slotStart = startIndex - this.#headTrim;
    // 落点自锚定：以首个无键占位卡为基准、与窗口内落点取小者。删除会使 #slots 相对
    // 页序收缩（拼装窗口内的在途删除、push→回填 rAF 间隙的删除），传入 start 按删除
    // 前状态长度计算，直接对号会整页写偏、留下永久无键灰卡；网格的键前缀是唯一
    // 可信对齐基准。无删除时两者相等，行为不变
    let start = this.#slots.length;
    for (let i = 0; i < this.#slots.length; i++) {
      if (!this.#slots[i].dataset[this.#itemKey]) {
        start = i;
        break;
      }
    }
    if (slotStart < start) start = slotStart;
    // 负落点 = 本页起始条目在窗口上方：跳过对应条目，从窗口首槽继续
    let offset = 0;
    if (start < 0) {
      offset = -start;
      start = 0;
    }
    const gridRect = dom.mainGrid.getBoundingClientRect();
    const margin = parseFloat(config.OBSERVER_ROOT_MARGIN) || 0;
    const bandTop = gridRect.top - margin;
    const bandBottom = gridRect.bottom + margin;
    // 带内外粗判走行几何估算（卡等高成行、纵向单调，与 #refillBand 二分同一假设）：
    // 页大小提到千级后逐卡 gBCR 的固定成本不可忽视——估算落在带界 ±1 行外的卡免
    // 实测（误判最多晚一个 IO 周期填充：带外卡保持观察，滚近由 IO 正常触发），边界
    // 卡与估算退化（CSS 变量缺失/首槽不存在）时回退逐卡实测
    const gap = config.CARD_GAP;
    // 估算优先取 #applyLayout 落笔结果（含拉伸卡宽，与 CSS 实际轨宽一致）；未落笔时
    // 回退 CSS 变量旧估算（本方法只在 render 之后可达，落笔值恒在，回退纯防御）
    const cardW =
      this.#layoutCardW ||
      parseInt(getComputedStyle(document.documentElement).getPropertyValue(this.#cardSizeVar)) ||
      config.CARD_SIZE_FALLBACK;
    const cols =
      this.#layoutCols ||
      Math.max(1, Math.floor((this.#container.clientWidth + gap) / (cardW + gap)));
    const rowH = (cardW * 4) / 3 + config.CARD_HEIGHT_OFFSET + gap;
    const firstCard = this.#slots[start];
    const firstTop = firstCard ? firstCard.getBoundingClientRect().top : null;
    const baseRow = Math.floor(start / cols);
    const misses = [];
    for (let i = offset; i < items.length; i++) {
      const item = items[i];
      const card = this.#slots[start + i - offset];
      if (card && card.isConnected && !card.dataset[this.#itemKey]) {
        card.dataset[this.#itemKey] = item[this.#itemKey];
        this.#itemMap.set(item[this.#itemKey], item);
        let inBand = null;
        if (firstTop !== null) {
          const estTop = firstTop + (Math.floor((start + i - offset) / cols) - baseRow) * rowH;
          if (estTop > bandBottom + rowH || estTop + rowH < bandTop - rowH) inBand = false;
        }
        if (inBand === null) {
          const rect = card.getBoundingClientRect();
          inBand = rect.bottom >= bandTop && rect.top <= bandBottom;
        }
        if (inBand) {
          // 带内：主动入队并摘除填充观察（填充后由卸载圈接管生命周期）
          if (this.#observer) this.#observer.unobserve(card);
          this.#enqueueFill(card);
        }
      } else {
        misses.push(item);
      }
    }
    if (misses.length) this.appendItems(misses);
  }

  #drainPendingFills() {
    if (!this.#pendingFills.length) return;
    const queue = this.#pendingFills;
    this.#pendingFills = [];
    for (const { startIndex, items } of queue) this.#applyFill(startIndex, items);
  }

  // 已渲染顺序快照（与挂载卡 DOM 一一对应的唯一权威顺序）：Batch 的 Shift 区间按它取序，
  // 保证「所见即所选」。不得改用 SearchBar 视图函数现算——排序/筛选后视图可能已随数据
  // 重算（作者作品数 rank 重排、渐进加载静默累积），DOM 却仍是上一版渲染顺序，按视图
  // 下标圈选会把区间落到视口/挂载窗口之外（见 docs/11「Shift 连选」）。render 前/abort
  // 后为 null，调用方回退视图函数。返回共享数组，调用方只读
  renderedItems() {
    return this.#viewItems;
  }

  // ---------- 头插原语（STORE_CHANGED 增量收口） ----------
  // 快滚冻结态暴露：增量收口期间与填充/降级同一冻结纪律（冻结期不做任何 DOM 变更），
  // 调用方据它降级整刷兜底
  isScrollFrozen() {
    return this.#scrollFast;
  }

  // 位插：调用方（main.js 收口管线）已把条目按视图序同步 splice 进 state 的同一位置，
  // 本方法在 #slots 对位 splice + 挂载骨架卡（内容由既有 IO 填充管线补齐），维持
  // 「slots[i] ↔ state[i]」键前缀对齐不变量——removeItems 的对偶操作。items 须已按
  // 视图序排好且落点连续（合批由调用方负责）。返回 false = 口径意外（重复键/落点
  // 越界，此时可能已部分挂载），调用方须整域整刷自愈
  insertItems(index, items) {
    if (!items.length) return true;
    if (this.#chunkRaf) {
      // 预铺拼装窗口内排队；收尾 drain 先于 fills/appends（state 已 splice，先恢复
      // slots 对齐再应用既有排队回填，两者落点基准才一致）
      this.#pendingInserts.push({ index, items });
      return true;
    }
    return this.#insertAt(index, items);
  }

  // 视图下标分派：落在已回收头部的只登记快照（窗口外由 padding 代表，不挂卡）；
  // 其余换算窗口槽位下标后位插
  #insertAt(index, items) {
    if (index < this.#headTrim) return this.#insertAboveWindow(index, items);
    return this.#mountInsert(index - this.#headTrim, items);
  }

  // 头插落点已回收：快照位插 + itemMap 登记，窗口起点后移 items.length，不产生 DOM
  #insertAboveWindow(index, items) {
    if (this.#viewItems) {
      const at = Math.min(index, this.#viewItems.length);
      for (let i = items.length - 1; i >= 0; i--) this.#viewItems.splice(at, 0, items[i]);
    }
    for (const item of items) {
      this.#itemMap.set(item[this.#itemKey], item);
      this.#viewKeys.add(item[this.#itemKey]);
    }
    this.#headTrim += items.length;
    this.#totalSlots += items.length;
    const padBefore = this.#headPad;
    this.#syncHeadPad();
    // 回收区上方插入：padding-top 随 #headTrim 上抬、内容整体下移，不补偿会把视口推向
    // 头部占位空白（单条约一行跳动、同批可致整屏空白）——与 #mountInsert 的「落点在视口
    // 上方按实测位移补偿 scrollTop」同口径；#headTrim 非行对齐时 ceil 不变、Δ=0 自动 no-op
    if (this.#headPad > padBefore) dom.mainGrid.scrollTop += this.#headPad - padBefore;
    this.#syncTailReserve();
    return true;
  }

  #mountInsert(index, items) {
    if (index > this.#slots.length) return false;
    const skelTmpl = this.#getSkeletonTemplate();
    // 先全量校验再提交，避免中途撞重复键留下半套 mutation（false 路径靠整刷自愈）
    for (const item of items) {
      if (this.#itemMap.has(item[this.#itemKey])) return false;
    }
    // 滚动锚定：落点处原首卡（被推下的第一张）在视口上沿之上 = 插入块整体在视口外
    // 上方，插后按其实测位移补偿 scrollTop，视口内容纹丝不动；落点在视口内不补偿
    //（新卡出现正是要让用户看见）。空网格无锚点不补偿
    const grid = dom.mainGrid;
    const anchorNode = this.#slots[index] || null;
    const useAnchor = Boolean(anchorNode && anchorNode.isConnected);
    let anchorTopBefore = 0;
    if (useAnchor) anchorTopBefore = anchorNode.getBoundingClientRect().top;
    const compensate = useAnchor && anchorTopBefore < grid.getBoundingClientRect().top;
    // 空网格首条：接管 emptyState 显隐（#showEmpty 的对偶）
    if (!this.#slots.length) {
      dom.emptyState.classList.add("hidden");
      this.#container.classList.remove("hidden");
    }
    const nodes = [];
    for (const item of items) {
      const key = item[this.#itemKey];
      this.#itemMap.set(key, item);
      nodes.push(this.#cloneSkeleton(skelTmpl, item));
    }
    // 反向逐个前插：避免 splice(...nodes) 大数组 spread 的栈上限（同 observeNewSkeletons 约定）
    for (let i = nodes.length - 1; i >= 0; i--) this.#slots.splice(index, 0, nodes[i]);
    // 视图快照同步位插（与 #slots 同 index，键控扩容取数序随真实视图生长）；
    // 快照短于落点（渐进态旧快照）时钳到尾部追加，保持快照内有序
    if (this.#viewItems) {
      const at = Math.min(index, this.#viewItems.length);
      for (let i = items.length - 1; i >= 0; i--) this.#viewItems.splice(at, 0, items[i]);
      for (const item of items) this.#viewKeys.add(item[this.#itemKey]);
    }
    const fragment = document.createDocumentFragment();
    for (const node of nodes) fragment.appendChild(node);
    this.#container.insertBefore(fragment, useAnchor ? anchorNode : null);
    this.#totalSlots += nodes.length;
    // 分圈观察（头插区优先）：分圈哨兵停在旧网格尾部，头插卡全部在其上方、向下的
    // 链推进永远够不到——把头插卡插队到待观察队列最前并清哨兵立即续接，首圈 observe
    // 的就是头插区，哨兵随后落在头插区内（双向 IO 保证滚近即推进；旧尾部以远的已
    // 观察卡不受影响）
    this.#ensureFillObserver();
    for (let i = nodes.length - 1; i >= 0; i--) this.#pendingSkeletons.unshift(nodes[i]);
    this.#sentinelCard = null;
    this.#extendObservation();
    if (compensate) {
      const delta = anchorNode.getBoundingClientRect().top - anchorTopBefore;
      if (delta > 0) grid.scrollTop += delta;
    }
    return true;
  }

  #drainPendingInserts() {
    if (!this.#pendingInserts.length) return;
    const queue = this.#pendingInserts;
    this.#pendingInserts = [];
    for (const { index, items } of queue) {
      if (!this.#insertAt(index, items)) {
        // 排队窗口内撞口径意外：无法原地自愈，告警并留待下一次全量渲染收口
        console.warn("[DDM] queued insert mismatch, waiting for next full render");
      }
    }
  }

  // 加载收尾：尾部仍无键的占位卡 = 预铺数超出实际条目的兜底残余（page-0 total 与到
  // 达页差额、删除收敛残余；removeItems 已同步收缩 #totalSlots，常态下应为空表），
  // 摘除之，避免文档尾部留永久灰卡
  pruneEmptyTail() {
    let pruned = false;
    while (this.#slots.length) {
      const card = this.#slots[this.#slots.length - 1];
      if (card.dataset[this.#itemKey]) break;
      this.#slots.pop();
      if (this.#observer) this.#observer.unobserve(card);
      if (this.#unloadObserver) this.#unloadObserver.unobserve(card);
      card.remove();
      pruned = true;
    }
    // 收敛到「已加载条目数」（预铺/页差额的兜底残余被摘除），而不是已挂载数：已加载
    // 未挂载的条目仍由尾部占位 + 键控扩容可达，收缩到 slots 会让它们永远滚不到
    this.#totalSlots = Math.max(this.#slots.length, this.#viewItems ? this.#viewItems.length : 0);
    this.#syncTailReserve();
    if (pruned && !this.#slots.length) this.#showEmpty(this.#emptyMsg, this.#emptyHint);
  }

  // 清除容器内全部勾选态（跨域保存后调用；不触碰 state.selectedIds）
  clearSelectionUI() {
    this.#container.querySelectorAll(".work-checkbox.checked, .following-checkbox.checked").forEach((el) => {
      el.classList.remove("checked");
      el.textContent = "";
      el.setAttribute("aria-checked", "false");
    });
  }

  removeItems(idSet) {
    let removed = 0;
    // 视图快照同步收缩（filter 产出新表，不反噬调用方数组）：键控扩容的取数序保持，
    // 防止已删条目被扩容复活成灰卡；删除落在已回收头部时窗口起点随视图同步前移
    if (this.#viewItems && idSet.size) {
      const trimmed = this.#headTrim;
      let headHits = 0;
      let i = 0;
      const kept = [];
      for (const w of this.#viewItems) {
        if (idSet.has(w[this.#itemKey])) {
          if (i < trimmed) headHits++;
        } else {
          kept.push(w);
        }
        i++;
      }
      this.#viewItems = kept;
      for (const id of idSet) this.#viewKeys.delete(id);
      if (headHits) {
        this.#headTrim = Math.max(0, this.#headTrim - headHits);
        const padBefore = this.#headPad;
        this.#syncHeadPad();
        // 回收区删除是 #insertAboveWindow 的对偶：padding-top 随 #headTrim 收缩、窗口内容
        // 整体上移，不补偿会把视口推向下方（整屏跳走）。浏览器滚动锚定只对节点级增删生效，
        // padding 收缩不触发补偿（实测 scrollTop 原样保留）；按占位差值反补，保持视口内
        // 同一批卡原位（未跨行时 Δ=0 自动 no-op）
        const padShrink = padBefore - this.#headPad;
        if (padShrink > 0) dom.mainGrid.scrollTop = Math.max(0, dom.mainGrid.scrollTop - padShrink);
      }
    }
    if (idSet.size) {
      // 单遍化批量删除：先摘 itemMap 记 known 集，再单遍 #slots 收集命中卡——替代
      // per-id querySelector + slots.indexOf 的 O(id数×(挂载数+槽位数)) 双重扫描
      //（万级批量删除的主线程成本集中于此）。#slots 与容器子节点同构（各挂载路径
      // 均同步 push），单遍扫描即可覆盖全部已挂卡
      const knownIds = new Set();
      for (const id of idSet) {
        if (this.#itemMap.delete(id)) knownIds.add(id);
      }
      const hitCards = [];
      for (const card of this.#slots) {
        if (idSet.has(card.dataset[this.#itemKey])) hitCards.push(card);
      }
      // 槽位表一次性重建（替代逐卡 indexOf+splice）：与域数组同步收缩，预铺回填的
      // 对齐关系依赖两侧同构
      if (hitCards.length) {
        this.#slots = this.#slots.filter((card) => !idSet.has(card.dataset[this.#itemKey]));
      }
      let sentinelHit = false;
      for (const card of hitCards) {
        if (this.#observer) this.#observer.unobserve(card);
        if (this.#unloadObserver) this.#unloadObserver.unobserve(card);
        if (card === this.#sentinelCard) sentinelHit = true;
        this.clearCard(card);
        card.remove();
        removed++;
      }
      if (sentinelHit) {
        // 哨兵被删除会导致观察圈断链、后续骨架永不填充：整批清理后统一续接一次
        this.#sentinelCard = null;
        this.#extendObservation();
      }
      // known 但无连接卡的 id（拼装窗口内被对账丢弃、永不占槽）同样计入：
      // #totalSlots 必须随真实条目数一起收缩，否则差额会被 #extendIfNeeded 当作
      // 未铺配额，滚近底部时原样补回无键占位卡（永久灰卡）
      const hitIds = new Set(hitCards.map((card) => card.dataset[this.#itemKey]));
      for (const id of knownIds) {
        if (!hitIds.has(id)) removed++;
      }
    }
    // 预铺目标与 #slots 同步收缩：下界取**视图系剩余条目数**，不是窗口系 #slots.length
    //（#slots.length ≤ GRID_MOUNT_MAX，窗口态下会减穿制造「已窗口化却报非窗口化」的错位，
    //  与扩容侧「换算到窗口系」红线同源的另一向坐标系混用）
    if (removed) {
      const remaining = this.#viewItems ? this.#viewItems.length : 0;
      this.#totalSlots = Math.max(remaining, this.#totalSlots - removed);
    }
    // 删除使余量行变化：尾部占位同步重算（封闭视图）
    if (removed) this.#syncTailReserve();
    const known = Math.min(this.#totalSlots, this.#viewItems ? this.#viewItems.length : 0);
    // 窗口与剩余规模失配：即时重挂，不依赖滚动事件（容器可能已无高度、事件收不到）。
    // 预铺拼装进行中（#chunkRaf）不重挂——与 buildChunk 双写 #slots 会交错，交给收尾
    // #finishRender → #scheduleCatchUp → #syncWindow 的同款不变量收口
    if (removed && known > 0 && !this.#chunkRaf) {
      if (known <= config.GRID_MOUNT_MAX) {
        // 剩余缩到非窗口化规模：窗口必须归零（#headTrim===0）并从顶部铺满，
        // 否则头部回收区只剩 padding-top，上滚即整屏空白（无卡无骨架）
        if (this.#headTrim > 0) this.#remountWindow(0);
      } else if (this.#slots.length === 0) {
        // 窗口被批量掏空（剩余仍超上限）：按当前视口行重挂
        const cols = this.#layoutCols;
        const rowH = this.#rowH();
        if (cols && rowH > 0) {
          const viewRows = Math.max(1, Math.ceil(dom.mainGrid.clientHeight / rowH));
          const vr = Math.max(0, Math.floor(dom.mainGrid.scrollTop / rowH));
          this.#remountWindow(Math.max(0, vr - Math.max(6, viewRows * 4)));
        }
      }
    }
    // 空态按数据口径判定：窗口态下「窗口掏空」≠ 网格为空（原 children.length===0 会误报）
    if (known === 0 && this.#viewItems) {
      this.#showEmpty(this.#emptyMsg, this.#emptyHint);
    }
    // 删除会让内容整体上移、视口落到另一批行上（批量移动/删除后无滚动事件、浏览器对
    // padding 收缩也不锚定补位的实测场景）：暴露出来的卡若在分圈观察前沿之外，没人给它们
    // 发观察入口，就会永久停在灰骨架直到用户滚动。与 #finishRender 同一条收口纪律——
    // 变更完成后下一帧统一补一次视口追赶
    if (removed && !this.#chunkRaf) this.#scheduleCatchUp();
  }

  // 中止未完成的分块渲染（域切换时调用，防止旧域骨架卡/observer 残留到共享容器）
  abortRender() {
    this.stopAllMedia();
    cancelAnimationFrame(this.#chunkRaf);
    this.#chunkRaf = 0;
    this.#resetRenderState(new Map());
  }

  // 渲染/中止共用的状态重置：断开双 observer、清空待观察队列/哨兵/填充队列/分帧 id
  #resetRenderState(itemMap) {
    if (this.#observer) {
      this.#observer.disconnect();
      this.#observer = null;
    }
    if (this.#unloadObserver) {
      this.#unloadObserver.disconnect();
      this.#unloadObserver = null;
    }
    this.#pendingSkeletons = [];
    this.#pendingAppends = [];
    this.#pendingFills = [];
    this.#pendingInserts = [];
    this.#pendingDemotes = [];
    cancelAnimationFrame(this.#demoteDrainRaf);
    this.#demoteDrainRaf = 0;
    cancelAnimationFrame(this.#settleRaf);
    this.#settleRaf = 0;
    this.#settleLastEpoch = 0;
    cancelAnimationFrame(this.#rushRaf);
    this.#rushRaf = 0;
    cancelAnimationFrame(this.#resizeRafId);
    this.#resizeRafId = 0;
    // 尾部占位随 wipe 清除（inline style 不随 innerHTML/换壳重置，必须显式还原）
    this.#tailReserve = 0;
    this.#reserveCols = 0;
    this.#reserveRowH = 0;
    this.#reserveKey = "";
    this.#resizeAnchor = null;
    this.#skipExtendOnce = false;
    this.#skipWindowOnce = false;
    this.#headTrim = 0;
    this.#headRows = 0;
    this.#headPad = 0;
    this.#remounting = false;
    this.#layoutCols = 0;
    this.#layoutCardW = 0;
    this.#container.style.paddingBottom = "";
    this.#container.style.paddingTop = "";
    this.#slots = [];
    this.#totalSlots = 0;
    this.#viewItems = null;
    this.#viewKeys = new Set();
    this.#sentinelCard = null;
    this.#itemMap = itemMap;
    cancelAnimationFrame(this.#drainRafId);
    this.#drainRafId = 0;
    this.#fillQueue = [];
  }

  #showEmpty(msg, hint) {
    dom.emptyState.classList.remove("hidden");
    dom.emptyState.querySelector("p").textContent = msg;
    dom.emptyState.querySelector(".empty-hint").textContent = hint;
    this.#container.classList.add("hidden");
  }

  #getSkeletonTemplate() {
    return document.getElementById(
      this.#skeletonClass.replace(/-([a-z])/g, (_, c) => c.toUpperCase()) + "Template",
    );
  }

  #clonePlaceholder(skelTmpl) {
    return skelTmpl.content.cloneNode(true).firstElementChild;
  }

  #cloneSkeleton(skelTmpl, item) {
    const card = this.#clonePlaceholder(skelTmpl);
    card.dataset[this.#itemKey] = item[this.#itemKey];
    return card;
  }

  // 双向虚拟化：完整卡滚出 UNLOAD_ROOT_MARGIN 外时降级回骨架（媒体子树/监听器随清空释放），
  // 重新滚近时经既有 fill 流程重填。卸载圈远大于填充圈形成滞回，避免边界抖动。
  #ensureUnloadObserver() {
    if (this.#unloadObserver) return;
    this.#unloadObserver = new IntersectionObserver(
      (entries) => {
        // 降级只入队不执行：成批积压（快滚期沿途数千张）一次性执行是数百毫秒长任务，
        // 会把停稳后的视窗填充顶到后面——经预算 drain 分帧消化
        for (const entry of entries) {
          if (!entry.isIntersecting) this.#pendingDemotes.push(entry.target);
        }
        this.#scheduleDemoteDrain();
      },
      // root 必须显式传 #mainGrid（滚动容器）：隐式根=文档视口时，rootMargin 会被
      // #mainGrid 自身作为祖先滚动容器的裁剪盒抵消，卸载圈塌缩到滚动口边缘——卡刚
      // 出可视区即降级、滚回即重填（「小幅滚动往返卡片重载」的根因，sidebar 同款
      // 规则见 sidebar.js）。#mainGrid 是稳定节点（clearActiveGrid 只换 #mainContainer），
      // 无需随换壳重挂
      { root: dom.mainGrid, rootMargin: config.UNLOAD_ROOT_MARGIN },
    );
  }

  // 降级分帧 drain：快滚期保持冻结（旧门控语义不变）；停稳后让位于填充队列（视口
  // 填充优先），按 DEMOTE_FRAME_BUDGET_MS 时间预算每帧消化一批
  #scheduleDemoteDrain() {
    if (this.#demoteDrainRaf) return;
    this.#demoteDrainRaf = requestAnimationFrame(() => {
      this.#demoteDrainRaf = 0;
      if (this.#scrollFast || this.#fillQueue.length) {
        this.#scheduleDemoteDrain();
        return;
      }
      const deadline = performance.now() + config.DEMOTE_FRAME_BUDGET_MS;
      while (this.#pendingDemotes.length && performance.now() < deadline) {
        this.#demote(this.#pendingDemotes.shift());
      }
      if (this.#pendingDemotes.length) this.#scheduleDemoteDrain();
    });
  }

  // 原地降级：只清内容、切回骨架类，不换根节点。grid 容器任一直接子节点被替换
  // 都会触发 Blink 全量重排，成本随卡片总数线性增长（3000 卡单次 >10ms）。
  #demote(card) {
    if (this.#scrollFast) return; // 快滚门控：冻结 DOM 变更，离屏卡保持已填（下次出圈 Crossing 再降级）
    if (!card.isConnected || card.classList.contains(this.#skeletonClass)) return;
    const key = card.dataset[this.#itemKey];
    if (!key || !this.#itemMap.has(key)) return;

    this.clearCard(card);
    card.classList.add(this.#skeletonClass);
    // unloadObserver 持续观察同一根节点无需重挂；fill observer 在填充时已 unobserve
    if (this.#observer) this.#observer.observe(card);
  }

  // 分圈观察：新骨架先进待观察队列，只把最靠前一圈（OBSERVE_CHUNK_SIZE 个）交给 IO，
  // 圈尾哨兵进圈（进入 OBSERVER_ROOT_MARGIN）时再放下一批。
  // computeIntersections 成本随已观察目标数线性，全量 observe 会让滚动期每帧
  // 重算 O(全部卡) 次几何——这是侧边栏打开后风扇高转的主因之一（实测 trace 占 1.2s/5s）
  #ensureFillObserver() {
    if (this.#observer) return;
    this.#observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const card = entry.target;
          // 哨兵续接先于占位判断：哨兵可能是未回填占位卡（链推进到预铺区），不能断链
          if (card === this.#sentinelCard) {
            this.#sentinelCard = null;
            this.#extendObservation();
          }
          // 占位卡（预铺未回填）保持观察不摘除：回填后带内由 fillSlots 主动入队、
          // 滚近再入带时由此处正常触发填充；若在此 unobserve 将永不填充
          const key = card.dataset[this.#itemKey];
          if (!key || !this.#itemMap.has(key)) continue;
          this.#observer.unobserve(card);
          this.#enqueueFill(card);
        }
      },
      // root 显式传 #mainGrid，理由同 #ensureUnloadObserver：预填带（OBSERVER_ROOT_MARGIN）
      // 必须相对滚动口自身矩形展开，否则被祖先裁剪抵消、卡片入画前不预填
      { root: dom.mainGrid, rootMargin: config.OBSERVER_ROOT_MARGIN },
    );
  }

  // 分圈观察的入队端（分圈推进机制与全量 observe 的成本依据见 #ensureFillObserver）：
  // 逐个 push：余量骨架可能上万，spread 实参（push(...nodes)）在大数组下有栈上限
  #observeNewSkeletons(nodes) {
    this.#ensureFillObserver();
    // 逐个 push：余量骨架可能上万，spread 实参（push(...nodes)）在大数组下有栈上限
    for (const node of nodes) this.#pendingSkeletons.push(node);
    if (!this.#sentinelCard) this.#extendObservation();
  }

  #extendObservation() {
    while (this.#pendingSkeletons.length) {
      const chunk = [];
      while (this.#pendingSkeletons.length && chunk.length < config.OBSERVE_CHUNK_SIZE) {
        const card = this.#pendingSkeletons.shift();
        if (card.isConnected) chunk.push(card);
      }
      if (!chunk.length) continue; // 本批全是被重渲染丢弃的死节点，继续丢
      for (const c of chunk) {
        c.dataset.observed = "1";
        this.#observer.observe(c);
      }
      this.#sentinelCard = chunk[chunk.length - 1];
      return;
    }
    this.#sentinelCard = null;
  }

  // 快滚判定与停稳基准：判定必须在 scroll 事件时刻完成（本帧 vs 上帧 scrollTop）——
  // rAF 侧一帧内有 catchUp / drain 轮询两个读取者，若各自推进基准，第二位读者必得
  // delta 0 而逐帧误判停稳：快滚冻结被打断、#refillBand 每帧空转、积压卡被反复丢弃
  #onGridScroll() {
    const st = dom.mainGrid.scrollTop;
    this.#scrollFast = Math.abs(st - this.#lastScrollTop) > config.FAST_SCROLL_THRESHOLD;
    this.#lastScrollTop = st;
    this.#scrollEpoch++;
    // 快滚轮询自持：停稳检测不依赖队列非空（空队列也须转出冻结态、释放 #demote 门控）。
    // 仅活跃网格需要轮询（abortRender 后 observer 为 null，无卡可冻结）
    if (this.#scrollFast && this.#observer) this.#scheduleDrain();
    this.#scheduleSettleCheck();
    this.#scheduleCatchUp();
  }

  // 任意滚动的停稳收口：快滚路径由 drain 的 epoch settle 触发 #refillBand；滚轮级滚动
  // scrollFast 恒 false、那条路径永不执行。滚动静止一帧后在此补收口（refillBand 幂等：
  // 已填卡被 #doFill 的骨架类检查无害跳过）；快滚未 settle 时仍由 drain 负责，此处跳过
  #scheduleSettleCheck() {
    if (!this.#observer) return; // 非活跃网格（abortRender 后）无需收口
    if (this.#settleRaf) return;
    this.#settleRaf = requestAnimationFrame(() => {
      this.#settleRaf = 0;
      if (this.#settleLastEpoch !== this.#scrollEpoch) {
        // 本帧仍有新滚动事件：推进静默基准续等
        this.#settleLastEpoch = this.#scrollEpoch;
        this.#scheduleSettleCheck();
        return;
      }
      if (!this.#scrollFast) {
        this.#refillBand();
        this.#syncWindow();
      }
    });
  }

  // 远跳兜底：快速滚动/拖动滚动条落点可能越过观察圈前沿，哨兵留在视口上方
  // 永不再相交、分圈推进断链，落点骨架因从未 observe 过而永远不填充。
  // 滚动时把填充带内未观察的骨架直连交给 fill observer（不走队列与哨兵，
  // 两条机制独立并存：慢速滚动仍由零成本的哨兵链推进）。
  #scheduleCatchUp() {
    if (this.#scrollRafId) return;
    this.#scrollRafId = requestAnimationFrame(() => {
      this.#scrollRafId = 0;
      // 顺序=只读在前、占位写（padding-bottom）收尾：写在帧尾才不会再触发一次强制
      // 布局（原顺序先把占位写掉、后续扩容/带区追赶的读取又逼一次重排）
      if (this.#skipExtendOnce) this.#skipExtendOnce = false;
      else this.#extendIfNeeded();
      this.#catchUpToViewport();
      // 尾部占位随滚动重判：容器宽度变化（折叠侧栏/窗口拖宽）会改列数，占位高度须跟上
      this.#syncTailReserve();
      // 窗口维护收尾（占位量已定）：视口离开窗口时整窗重挂，活动 DOM 恒定
      this.#syncWindow();
    });
  }

  // 接近底部（按需铺卡）：内容底距视口底不足 GRID_EXTEND_THRESHOLD 屏时扩容槽位。
  // 封闭视图的「真实内容底」= 容器底 − 尾部占位（#tailReserve）——余量行的滚动条总长
  // 已由占位预留，扩容只是把占位换成真实卡（净高恒定、滑块不回退）。步长 = min(倍增,
  // 单步上限 GRID_EXTEND_STEP)；视口带区已越过真实内容底（拖拽跳进占位区）时改为按
  // 带区直铺追赶（单步上限 GRID_EXTEND_JUMP_STEP，未覆盖视口时下一帧续铺）
  #extendIfNeeded() {
    if (this.#chunkRaf) return; // 预铺拼装未完成时不扩容：文档尚短，且双路径写 #slots 会交错
    // 扩容以已加载条目为界（与窗口/尾部占位同口径）：未加载尾部不可达
    const known = Math.min(this.#totalSlots, this.#viewItems ? this.#viewItems.length : 0);
    // 窗口内槽位数与「视图下标」是两个坐标系：已挂区间 = [#headTrim, #headTrim + slots)。
    // 扩容目标、上限都必须先换算到窗口系——混用 known（视图系）会让窗口每滚动一次就
    // 多铺出 headTrim 张占位卡（视图空间被无数据区撑长：整屏骨架 + 可无限下滚）
    const head = this.#headTrim;
    const mountedEnd = head + this.#slots.length;
    if (mountedEnd >= known) return;
    const rect = this.#container.getBoundingClientRect();
    const gridRect = dom.mainGrid.getBoundingClientRect();
    const margin = dom.mainGrid.clientHeight * config.GRID_EXTEND_THRESHOLD;
    if (rect.bottom - this.#tailReserve - gridRect.bottom > margin) return;
    const windowMax = Math.min(config.GRID_MOUNT_MAX, known - head);
    if (this.#slots.length >= windowMax) return; // 窗口已满：位置变化交给 #syncWindow 重挂
    let next = Math.min(windowMax, this.#slots.length * 2, this.#slots.length + config.GRID_EXTEND_STEP);
    if (this.#tailReserve > 0) {
      // #slotsToReach 返回视图系槽位下标，换算窗口系后再参与取大
      const need = this.#slotsToReach(gridRect.bottom + margin) - head;
      if (need > next) next = Math.min(windowMax, this.#slots.length + config.GRID_EXTEND_JUMP_STEP, need);
    }
    const added = this.#extendSlotsTo(next);
    // 远跳单步封顶未赶齐：下一帧续铺，直到视口带区被真实内容覆盖（覆盖即止，非全量物化）
    if (added > 0 && head + this.#slots.length < known && this.#tailReserve > 0) {
      const after = this.#container.getBoundingClientRect();
      if (after.bottom - this.#tailReserve - gridRect.bottom <= margin) this.#scheduleRush();
    }
  }

  // 远跳追赶续铺（幂等 rAF 链）：拖拽把视口丢进尾部占位区后按带区目标逐帧铺卡；
  // 与常速滚动共用 #extendIfNeeded（覆盖判定同上，覆盖即停）；render/abort 经
  // #resetRenderState 取消
  #scheduleRush() {
    if (this.#rushRaf) return;
    this.#rushRaf = requestAnimationFrame(() => {
      this.#rushRaf = 0;
      this.#extendIfNeeded();
      // 追赶是纯扩容路径（无 scroll 事件）而新卡的检查标记走分圈队列：不补一次带区
      // 追赶，落点带区的骨架会停在未观察态、永远灰卡（远跳到「已加载未挂载」尾部时
      // 必现——扩容铺出的正是落点要显示的那批卡）
      this.#catchUpToViewport();
    });
  }

  // 槽位扩容核心（键控/占位两态），无几何读取——触发时机由调用方判定（滚近铺卡/远跳
  // 追赶）。快照（#viewItems）覆盖到的槽位一律键控：锚取槽尾最后一张带键卡（DOM 实况
  // 推导，免维护游标不变量），在快照中定位后顺次取后继——活动 DOM 有上限后，「已加载
  // 未挂载」的条目全靠本路径铺真卡，占位卡会永久灰卡；快照尚未覆盖的槽位（页未到达）
  // 落无键占位卡，由 fillSlots 按槽回填。锚失配返回 0（不扩容，留待整刷自愈）。
  // 返回实际新增槽位数
  #extendSlotsTo(next) {
    const snapshot = this.#viewItems;
    // 快照是键控扩容的硬前置：render 后恒存在；abort 时 #totalSlots 与 #viewItems 同步清零，
    // #extendIfNeeded 的 known 早退也不会进入本方法
    if (!snapshot) return 0;
    // 窗口系上限：快照覆盖到「已知条目」，窗口从 #headTrim 起铺，最多铺到 known - head
    const known = Math.min(this.#totalSlots, snapshot.length);
    next = Math.min(next, known - this.#headTrim);
    if (next <= this.#slots.length) return 0;
    const skelTmpl = this.#getSkeletonTemplate();
    let cursor = -1;
    let anchorKey = null;
    for (let i = this.#slots.length - 1; i >= 0; i--) {
      anchorKey = this.#slots[i].dataset[this.#itemKey];
      if (anchorKey) break;
    }
    if (anchorKey) {
      cursor = snapshot.findIndex((w) => w[this.#itemKey] === anchorKey);
      // 锚不在快照（头插/移除维护窗口外的口径异常）：不扩容，留待整刷自愈
      if (cursor < 0) return 0;
    }
    // 槽尾无带键卡（理论不该出现）：cursor 保持 -1，从快照头部续铺
    const frag = document.createDocumentFragment();
    const nodes = [];
    for (let i = this.#slots.length; i < next; i++) {
      // 在册判定：render 已把视图全集登记进 itemMap——命中才克隆带键卡。旧实现条件
      // 写反（!has 才克隆），条件恒假、扩容全落无键占位卡，封闭视图预铺以远成永久
      // 骨架区（2026-09 修复）；快照含已移除条目（removeItems 已从 itemMap 摘除）时
      // 落占位兜底
      const item = snapshot[++cursor];
      const card =
        item && this.#itemMap.has(item[this.#itemKey])
          ? this.#cloneSkeleton(skelTmpl, item)
          : this.#clonePlaceholder(skelTmpl);
      this.#slots.push(card);
      nodes.push(card);
      frag.appendChild(card);
    }
    this.#container.appendChild(frag);
    this.#observeNewSkeletons(nodes);
    // 铺卡即等量收缩尾部占位：净高恒定，滑块位置不受影响
    this.#syncTailReserve();
    return nodes.length;
  }

  // ---------- 自适应卡宽（容差带布局） ----------
  // 列数不再由「理想卡宽 floor 取整」决定（右缘余量恒 < 一列宽，只能 justify-content
  // 均分），改为容差带内搜索：候选列数 c 的填满卡宽 w(c) = (W − (c−1)·gap) / c 随 c
  // 单调递减，可行域 w(c) ∈ [ideal×BAND_MIN, ideal×BAND_MAX]（c ∈ [lo, hi]，两端由
  // 带宽直接解出）；带内各候选均零空白，取 |w(c) − ideal| 最小者——w 恰等于 ideal 的
  // c 就是旧 floor 值，故列数相对旧值只增不减（密度不回退）。可行域外（相邻列宽差
  // 跨过整个带宽）：零空白优先——lo 列精确填满（向下破下限），破幅 ≤ 一个带宽
  //（fillW ≥ 2·minW − maxW）可接受；卡片明显过小才改取 hi 列钳到 maxW、收少量
  // 空白（justify-content: center 均分，无「右缘尾巴」观感）。结果以 inline style
  // 写容器：gridTemplateColumns 定列（替代样式表 auto-fill 兜底）、--dy-card-actual
  // 供 .work-card 宽高联动；容器擦除不清 inline style，跨域重渲由下一次
  // #applyLayout 以当域理想卡宽覆盖（works 族 249 / followings 212，经子类传入的
  // #cardSizeVar 读取）
  #applyLayout() {
    const W = this.#container.clientWidth;
    if (W <= 0) return; // 空态隐藏/换壳间隙：不落笔，样式表兜底继续生效
    this.#lastLayoutW = W;
    const gap = config.CARD_GAP;
    const ideal =
      parseInt(getComputedStyle(document.documentElement).getPropertyValue(this.#cardSizeVar)) ||
      config.CARD_SIZE_FALLBACK;
    const minW = ideal * this.#sizeBandMin;
    const maxW = ideal * this.#sizeBandMax;
    const hi = Math.max(1, Math.floor((W + gap) / (minW + gap)));
    const lo = Math.max(1, Math.ceil((W + gap) / (maxW + gap)));
    let cols = lo;
    if (lo <= hi) {
      let bestDev = Infinity;
      for (let c = lo; c <= hi; c++) {
        const w = (W - (c - 1) * gap) / c;
        const dev = Math.abs(w - ideal);
        // 平手取列多者（偏向密度）；w(c) 单调递减 → 偏差 V 形，线性扫全程即全局最优
        if (dev < bestDev || (dev === bestDev && c > cols)) {
          cols = c;
          bestDev = dev;
        }
      }
    } else if ((W - (lo - 1) * gap) / lo >= 2 * minW - maxW) {
      // 可行域外、破下限 ≤ 一个带宽：零空白优先，lo 列精确填满（卡片偏小可接受）
    } else {
      // 卡片明显过小：改取 hi 列钳到 maxW，收少量空白
      cols = hi;
    }
    // 钳上限（仅钳上限分支生效）；1/64px（LayoutUnit）向下对齐：杜绝浮点和 > W 的
    // 1e-13 级横向溢出（#mainGrid overflow-y:auto 使 overflow-x 同为 auto，亚像素
    // 越界会顶出横向滚动条）
    const cardW = Math.floor(Math.min((W - (cols - 1) * gap) / cols, maxW) * 64) / 64;
    // 列数与卡宽都没变（亚像素级改宽/重复通知）：不落笔——重写轨宽/--dy-card-actual
    // 会让整棵已挂载子树重新解析样式与布局，纯属白付
    if (cols === this.#layoutCols && cardW === this.#layoutCardW) return;
    this.#layoutCols = cols;
    this.#layoutCardW = cardW;
    const style = this.#container.style;
    style.gridTemplateColumns = `repeat(${cols}, ${cardW}px)`;
    style.setProperty("--dy-card-actual", cardW + "px");
  }

  // 容器宽度变化入口（RO 回调）：右栏折叠/窗口缩放/作者侧边栏拖宽。按活跃实例门控
  // ——各网格单例共享同一 #mainContainer、各自 RO 都会触发，#observer/#chunkRaf 仅活跃
  // 网格非空（render 建链、abortRender 断链），据此互斥落笔。列数变化会重排全部行：
  // 尾部占位与视口带区估算同步失效，rAF 后（新轨宽生效）统一补齐
  #onContainerResize() {
    if (!this.#observer && !this.#chunkRaf) return;
    // 只认宽度变化：本类对容器的全部写入（轨宽/上下占位/铺卡）只改高度不改宽度，
    // 自身写入的回读通知在此截断。但**本回调内一律不写**——写会改变容器尺寸，
    // 浏览器对同帧未送完的观察报「ResizeObserver loop completed with undelivered
    // notifications」；改宽落笔统一挪到下一帧 rAF（窗口缩放容忍一帧延迟，侧栏
    // 折叠/展开走 syncContainerWidth 同步路径，见 Sidebar/AppShell 调用点）
    const W = this.#container.clientWidth;
    if (W <= 0 || W === this.#lastLayoutW) return;
    if (this.#resizeRafId) return;
    this.#resizeRafId = requestAnimationFrame(() => {
      this.#resizeRafId = 0;
      this.syncContainerWidth();
    });
  }

  // 容器改宽落笔（同步）：侧栏折叠/展开/拖宽等调用方在 mutate 之后直接调用，点击
  // 任务内完成「读新宽 → 落轨宽 → 补偿锚点」，避免 RO 回调内写入触发 loop 告警。
  // 锚点补偿：改宽前首测（布局已随 mutate 更新、免费）→ 落笔 → 次测即绘制前必然
  // 发生的那次重排，总重排次数不增
  syncContainerWidth() {
    if (!this.#observer && !this.#chunkRaf) return;
    const W = this.#container.clientWidth;
    if (W <= 0 || W === this.#lastLayoutW) return;
    const anchor = this.#resizeAnchor?.isConnected ? this.#resizeAnchor : this.#topVisibleCard();
    this.#resizeAnchor = null;
    const before = anchor ? anchor.getBoundingClientRect().top : 0;
    this.#applyLayout();
    // 行高随卡宽变了：头部占位先按新行高落笔（解析式，零几何读取），锚点位移
    // 由紧随的二次测量一并吸收
    this.#syncHeadPad();
    if (anchor) {
      const delta = anchor.getBoundingClientRect().top - before;
      if (Math.abs(delta) > 1) dom.mainGrid.scrollTop += delta;
    }
    // 改宽当帧不做扩容探测：锚点保持视口相对真实内容底不变，扩容判定留到下一次
    // 滚动/停稳；尾部占位在紧随的 rAF 里按新列数/行高重算（写操作收在帧尾）
    this.#skipExtendOnce = true;
    this.#skipWindowOnce = true;
    this.#scheduleCatchUp();
  }

  // 当前行高（改宽后也有效）：优先解析式（works 族），其次实测缓存（行高与卡宽无关
  // 的域，followings）——全量已挂载时尾部占位关闭，但窗口重挂仍需要行高
  #rowH() {
    return this.rowHeightFor(this.#layoutCardW) || this.#reserveRowH;
  }

  // 头部占位落笔：行数按当前列数重算（窗口起点可能不在新列数的行边界上，向上取整），
  // 行高取自 #rowH——全程零几何读取，改宽当帧不新增重排
  #syncHeadPad() {
    if (this.#headTrim <= 0) {
      this.#headRows = 0;
      if (this.#headPad !== 0) {
        this.#headPad = 0;
        this.#container.style.paddingTop = "";
      }
      return;
    }
    const cols = this.#layoutCols;
    if (!cols) return;
    const rowH = this.#rowH();
    if (rowH <= 0) return;
    const rows = Math.ceil(this.#headTrim / cols);
    const pad = Math.round(rows * rowH);
    this.#headRows = rows;
    if (pad !== this.#headPad) {
      this.#headPad = pad;
      this.#container.style.paddingTop = pad + "px";
    }
  }

  // 改宽锚点兜底：视口内最上方卡片。子节点按行序纵向单调（骨架/完整卡同格同高），
  // 二分定位后取第一张。只在 RO 回调内调用——彼时布局洁净，读取不触发强制重排
  #topVisibleCard() {
    const children = this.#container.children;
    if (!children.length) return null;
    const bandTop = dom.mainGrid.getBoundingClientRect().top;
    let lo = 0;
    let hi = children.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (children[mid].getBoundingClientRect().bottom <= bandTop + 4) lo = mid + 1;
      else hi = mid;
    }
    return children[lo] || null;
  }

  // 尾部占位同步：按「已加载行数 − 已挂行数」写容器 padding-bottom——纯 style 写入、
  // 零卡片追加（大 M 下每次容器追加都是全网格重排，实测单次可达数百 ms，禁用
  // 「预挂余量」路线）。扩容铺卡后占位等量收缩，净高恒定。占位只覆盖**已加载**条目
  // （known = min(总数, 快照长度)）：未加载的尾部保持滚动不可达，杜绝「远跳落进空白」；
  // 已加载未挂载的条目滚近由键控扩容铺真卡。渐进加载期 known 随页到达增长，滚动条
  // 总长与旧「边加载边追加」一致、done 时不跳变。列数取 #applyLayout 落笔值、行高
  // 跨行实测一次并按「列数×卡宽」缓存（域无关，兼容两域卡尺寸）；单行未满不预留
  #syncTailReserve() {
    const container = this.#container;
    const slots = this.#slots.length;
    const known = Math.min(this.#totalSlots, this.#viewItems ? this.#viewItems.length : 0);
    // 窗口末条对应的视图下标：窗口外（头部回收）的行也要算进已挂行数
    const mountedEnd = this.#headTrim + slots;
    if (slots === 0 || known <= mountedEnd) {
      // 只清占位，不清几何缓存（#reserveCols/#reserveRowH）：窗口重挂与远跳追赶
      // 依赖它——全量已挂载时若把行高清零，窗口就再也收不回来（活动 DOM 停在全量）
      if (this.#tailReserve !== 0) {
        this.#tailReserve = 0;
        container.style.paddingBottom = "";
      }
      return;
    }
    const children = container.children;
    const n = children.length;
    // 列数取 #applyLayout 落笔值（与 inline 轨宽同源）；未落笔（空态/换壳间隙）不预留
    const cols = this.#layoutCols;
    if (!cols || n === 0) return;
    // 几何按布局缓存：列数/卡宽不变时行高恒定，滚动帧零读取（原先每帧扫首行至多
    // 64 张 gBCR）；改宽后 key 变化才重测一次，那一次落在 RO 回调已强制过的布局之后，
    // 不新增重排
    const key = cols + "x" + this.#layoutCardW;
    if (this.#reserveKey !== key || this.#reserveRowH <= 0) {
      const first = children[0];
      const firstTop = first.getBoundingClientRect().top;
      let rowH = 0;
      if (n > cols) rowH = children[cols].getBoundingClientRect().top - firstTop;
      if (rowH <= 0) {
        const gap = parseFloat(getComputedStyle(container).rowGap) || config.CARD_GAP;
        rowH = first.getBoundingClientRect().height + gap;
      }
      this.#reserveRowH = rowH;
      this.#reserveCols = cols;
      this.#reserveKey = key;
    }
    if (this.#reserveRowH <= 0) return; // 单行未满且卡高不可测：不预留
    const mountedRows = Math.ceil(slots / cols);
    const totalRows = Math.ceil(known / cols);
    const reserve = Math.max(0, Math.round((totalRows - this.#headRows - mountedRows) * this.#reserveRowH));
    if (reserve !== this.#tailReserve) {
      this.#tailReserve = reserve;
      container.style.paddingBottom = reserve > 0 ? reserve + "px" : "";
    }
  }

  // 覆盖到视口底 + 裕量所需的槽位数（远跳追赶目标；复用 #syncTailReserve 实测的列数/
  // 行高；缓存缺失时返回当前已挂载终点 = 不追赶）。返回值是**视图系**槽位下标
  //（从视图头部算起），调用方需减 #headTrim 换算成窗口内的槽位下标。头部占位算进内容起点
  #slotsToReach(targetBottomPx) {
    if (!this.#reserveCols || !this.#reserveRowH) return this.#headTrim + this.#slots.length;
    const grid = dom.mainGrid;
    const gridRect = grid.getBoundingClientRect();
    const contentTopInScroll =
      this.#container.getBoundingClientRect().top + this.#headPad - gridRect.top + grid.scrollTop;
    const targetInScroll = targetBottomPx - gridRect.top + grid.scrollTop;
    const rows = Math.ceil((targetInScroll - contentTopInScroll) / this.#reserveRowH) + 1;
    return Math.max(0, rows) * this.#reserveCols;
  }

  // ---------- 活动 DOM 窗口（头部回收 + 整窗重挂） ----------
  // 视口离开窗口舒适带时，把窗口整块重挂到视口位置：窗口外条目只留 padding 占位，
  // 滚动空间（headPad + 窗口高度 + tailPad = 总行数 × 行高）保持不变，scrollTop 无需
  // 修正。活动 DOM 恒定后，改一次卡宽 / 降级 / 删除的 O(N) 成本全部以窗口为分母。
  // 调用点：滚动帧（#scheduleCatchUp）与停稳收口（#scheduleSettleCheck）。
  // 快滚期只在「视口已完全离开窗口」（否则会露出占位空白）时重挂，其余情况保持冻结
  #syncWindow() {
    if (this.#remounting || this.#chunkRaf) return;
    if (this.#skipWindowOnce) {
      this.#skipWindowOnce = false;
      return;
    }
    const cols = this.#layoutCols;
    const rowH = this.#rowH();
    const snapshot = this.#viewItems;
    if (!cols || rowH <= 0 || !snapshot) return;
    // 可挂载/可滚动的宇宙 = **已加载条目**（known），不是首页 total：分页中断、或组计数
    // 与实际页数据不一致时，用 total 会让窗口冲进「没有数据的尾部」——整屏占位骨架，
    // 且每重挂一次就把滚动空间再往前推一段（表现为永无止境地滚）。未加载尾部保持
    // 不可达，页到达后 known 增长（与 #syncTailReserve 同一口径）
    const total = Math.min(this.#totalSlots, snapshot.length);
    // 非窗口化态的不变量是 #headTrim === 0：删除等路径把已加载数缩到 ≤ 上限后若仍残留
    // 窗口（头部回收区只剩 padding-top），必须重挂回顶铺满，否则上滚即整屏空白（无卡无骨架）
    if (total <= config.GRID_MOUNT_MAX) {
      if (this.#headTrim > 0) this.#remountWindow(0);
      return;
    }
    const grid = dom.mainGrid;
    const viewRows = Math.max(1, Math.ceil(grid.clientHeight / rowH));
    const vr = Math.max(0, Math.floor(Math.max(0, grid.scrollTop) / rowH));
    const mountedRows = Math.ceil(this.#slots.length / cols);
    const totalRows = Math.ceil(total / cols);
    const pre = Math.max(6, viewRows * 4);
    const post = Math.max(8, viewRows * 6);
    const clampRow = (row) => Math.max(0, Math.min(totalRows - 1, row));
    // 窗口是否已铺到「已加载末尾」：视口底越过文档末行属正常（下方是空白），不算出窗
    const windowEndRow = this.#headRows + mountedRows;
    const atTail = windowEndRow >= totalRows;
    const inside =
      vr >= this.#headRows && Math.min(vr + viewRows, totalRows) <= windowEndRow;
    if (!inside) {
      // 视口已落在占位区（拖拽滚动条/远跳）：必须立即重挂，否则整屏空白
      const target = clampRow(vr - pre);
      if (target !== this.#headRows) this.#remountWindow(target);
      return;
    }
    if (this.#scrollFast) return;
    // 快滚期扩容把窗口撑大：停稳后立即收回到硬上限（重挂到视口位置）
    if (this.#slots.length > config.GRID_MOUNT_MAX) {
      this.#remountWindow(clampRow(vr - pre));
      return;
    }
    // 舒适带留半幅滞回：改宽/小幅滚动引起的行列漂移不触发重建。
    // 窗口已到末尾时下方没有可预铺的内容：继续下滚不再重挂（否则每滚一行 target 就
    // +1 → 逐行整窗重建，活动卡在视口内反复回退骨架——用户感知的「滚动闪烁」）。
    // 上滚越过 topGuard 仍会重挂（需要补上方 pre 余量）
    const topGuard = this.#headRows + Math.floor(pre / 2);
    const botGuard = atTail ? Infinity : windowEndRow - Math.floor(post / 2);
    if (vr >= topGuard && vr + viewRows <= botGuard) return;
    const target = clampRow(vr - pre);
    if (target === this.#headRows) return; // 已在最优位置（列表头部）：不空转重挂
    this.#remountWindow(target);
  }

  // 整窗重挂：从 startRow（视图行号，行对齐）起铺至多 GRID_MOUNT_MAX 张卡，头部占位
  // 按行补齐。同步完成（一次换树 + 一次布局），换树前按 render 的收尾纪律断开观察器。
  // 平移复用：新旧窗口重叠区间的卡按 itemKey 原节点搬运（已填充卡保留封面/文案），
  // 只有新跨入窗口的边行克隆骨架——整窗从快照重克隆会让视口内全部卡瞬间回退灰骨架
  // （尾部逐行重挂时尤甚），是滚动期「网格闪一下」的根因
  #remountWindow(startRow) {
    const cols = this.#layoutCols;
    const rowH = this.#rowH();
    const snapshot = this.#viewItems;
    if (!cols || rowH <= 0 || !snapshot) return;
    // 与 #syncWindow 同口径：窗口不得越过已加载条目（否则铺出永不填充的占位骨架）
    const total = Math.min(this.#totalSlots, snapshot.length);
    // 换树前的头部占位/起点行：换树后按「占位差值 − 行差」精确平移 scrollTop
    const oldHeadPad = this.#headPad;
    const oldRow = this.#headRows;
    const totalRows = Math.ceil(total / cols);
    const row = Math.max(0, Math.min(startRow, Math.max(0, totalRows - 1)));
    const start = row * cols;
    const count = Math.min(config.GRID_MOUNT_MAX, Math.max(0, total - start));
    // 旧窗口卡按 key 建索引（无键占位卡无复用价值，直接丢弃）
    const reusable = new Map();
    for (const card of this.#slots) {
      const key = card.dataset[this.#itemKey];
      if (key) reusable.set(key, card);
    }
    this.#remounting = true;
    try {
      this.stopAllMedia();
      // 旧窗口整批脱 DOM：观察器与积压队列一并作废（旧节点不再被回调触及）
      if (this.#observer) {
        this.#observer.disconnect();
        this.#observer = null;
      }
      if (this.#unloadObserver) {
        this.#unloadObserver.disconnect();
        this.#unloadObserver = null;
      }
      this.#pendingSkeletons = [];
      this.#pendingDemotes = [];
      this.#pendingFills = [];
      this.#pendingAppends = [];
      this.#pendingInserts = [];
      this.#fillQueue = [];
      this.#sentinelCard = null;
      cancelAnimationFrame(this.#demoteDrainRaf);
      this.#demoteDrainRaf = 0;
      cancelAnimationFrame(this.#drainRafId);
      this.#drainRafId = 0;
      cancelAnimationFrame(this.#rushRaf);
      this.#rushRaf = 0;
      const skelTmpl = this.#getSkeletonTemplate();
      const frag = document.createDocumentFragment();
      const nodes = [];
      const skeletonNodes = [];
      const filledNodes = [];
      for (let i = 0; i < count; i++) {
        const item = snapshot[start + i];
        const itemKey = item ? item[this.#itemKey] : null;
        // dataset 键恒为字符串：数值型 id 归一后与旧卡索引对齐
        let card = itemKey != null ? reusable.get(String(itemKey)) : null;
        if (card) {
          reusable.delete(String(itemKey));
          // 旧观察器已断开：清掉圈内标记，收尾交还分圈观察/视口追赶重新判定
          delete card.dataset.observed;
        } else if (item && this.#itemMap.has(itemKey)) {
          card = this.#cloneSkeleton(skelTmpl, item);
        } else {
          card = this.#clonePlaceholder(skelTmpl);
        }
        if (card.classList.contains(this.#skeletonClass)) skeletonNodes.push(card);
        else filledNodes.push(card);
        nodes.push(card);
        frag.appendChild(card);
      }
      this.#container.replaceChildren(frag);
      this.#slots = nodes;
      this.#headTrim = start;
      this.#headRows = row;
      this.#headPad = row * rowH;
      this.#container.style.paddingTop = this.#headPad > 0 ? this.#headPad + "px" : "";
      // 尾部占位按新窗口重算（headRows 已计入）
      this.#syncTailReserve();
      // 视口精确平移：卡片整体位移 = 新头部占位 − 旧头部占位 − 行差 × 行高，按该差值
      // 调 scrollTop 可保持视口内同一批卡原位（像素级）——只依赖 padding 保持位置会
      // 随虚拟行数累积行高舍入误差（实测约 1600 行偏 50px），按整行重钉又会丢掉行内偏移
      const shift = this.#headPad - oldHeadPad - (row - oldRow) * rowH;
      if (Math.abs(shift) > 0.5) dom.mainGrid.scrollTop += shift;
      // 完整卡直接交卸载圈接管生命周期（与 populateItem 同一交接）；骨架走填充圈
      if (filledNodes.length) {
        this.#ensureUnloadObserver();
        for (const card of filledNodes) this.#unloadObserver.observe(card);
      }
      this.#observeNewSkeletons(skeletonNodes);
      this.#catchUpToViewport();
    } finally {
      this.#remounting = false;
    }
  }

  // 快滚判定已前移到 scroll 事件侧（#onGridScroll，rAF 读取者不推进基准）：
  // 快滚期间冻结一切 DOM 变更（填充挂起/降级跳过）——万级网格的每次变更都会打脏
  // 布局、把落点瓦片的光栅化排到主线程后面；变更冻结后 paint ops 保持有效，合成器
  // 可脱离主线程滚动显示灰骨架瓦片。快滚态下无新 scroll 事件即停稳（drain 轮询
  // epoch 检测）：清空沿路积压的填充队列、对落点带区强制补填

  // 停稳补填：丢弃沿路积压的填充队列（为滚过去的卡补布局只会拖慢落点；丢弃前重新
  // observe，见实现内注释），对当前视口带区的带键骨架无视 observed 标记直接补填
  //（二分定位带区后线性扫描）
  #refillBand() {
    // 丢弃沿路积压的填充队列——但积压卡入队时已 unobserve，直接清空会永久断链：
    // 滚回带区再无 IO 触发、骨架永不填充（快滚扫过的区段滞留灰卡）。丢弃前全量
    // 重新 observe 交还填充圈，恢复「滚近由 IO 触发填充」的惰性生命周期
    const backlog = this.#fillQueue;
    this.#fillQueue = [];
    if (!this.#observer) return;
    for (const card of backlog) {
      if (card.isConnected && card.classList.contains(this.#skeletonClass)) {
        this.#observer.observe(card);
      }
    }
    const children = this.#container.children;
    const count = children.length;
    if (!count) return;
    const margin = parseFloat(config.OBSERVER_ROOT_MARGIN) || 0;
    const gridRect = dom.mainGrid.getBoundingClientRect();
    const bandTop = gridRect.top - margin;
    const bandBottom = gridRect.bottom + margin;
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (children[mid].getBoundingClientRect().bottom < bandTop) lo = mid + 1;
      else hi = mid;
    }
    let refilled = 0;
    for (let i = lo; i < count; i++) {
      const card = children[i];
      if (card.getBoundingClientRect().top > bandBottom) break;
      if (!card.classList.contains(this.#skeletonClass) || !card.dataset[this.#itemKey]) continue;
      // 入口处的 observer 判空已保证非空（同步循环内无失效点）
      this.#observer.unobserve(card);
      this.#enqueueFill(card);
      refilled++;
    }
    if (refilled) console.debug(`[DDM] settle refill: ${refilled} cards`);
  }

  #catchUpToViewport() {
    // 非活跃实例的 observer 已被 abortRender()/render() 重置置空
    if (!this.#observer) return;
    // 未标记的骨架必然仍在待观察队列里；队列与哨兵双空 = 无需追赶
    if (!this.#sentinelCard && !this.#pendingSkeletons.length) return;
    const children = this.#container.children;
    const count = children.length;
    if (!count) return;
    const margin = parseFloat(config.OBSERVER_ROOT_MARGIN) || 0;
    const gridRect = dom.mainGrid.getBoundingClientRect();
    const bandTop = gridRect.top - margin;
    const bandBottom = gridRect.bottom + margin;
    // 卡片等高成行、纵向位置单调，二分定位带区起点后线性扫描到带区底；
    // 全程只读探测（gBCR），收集完再统一标记 observe，避免读写交错引发布局抖动
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const rect = children[mid].getBoundingClientRect();
      if (rect.bottom < bandTop) lo = mid + 1;
      else hi = mid;
    }
    const caught = [];
    for (let i = lo; i < count; i++) {
      const card = children[i];
      if (card.getBoundingClientRect().top > bandBottom) break;
      if (!card.classList.contains(this.#skeletonClass)) continue;
      if (card.dataset.observed === "1") continue; // 圈内/降级重观察路径已覆盖
      caught.push(card);
    }
    for (const card of caught) {
      card.dataset.observed = "1";
      this.#observer.observe(card);
    }
  }

  #finishRender() {
    // 原位整刷收尾的视口追赶：wipe 与重挂同任务同步完成、重渲前后内容等高时（典型：批量
    // 同步 SYNC_DONE 全量刷新），滚动位置原样保留、全程无 scroll 事件——分圈哨兵停在网格
    // 顶部、向下链推进够不着中部视口，而 #catchUpToViewport 只由 scroll 事件调度，视口
    // 带区骨架无人观察、永久停在灰卡态（手动滚一下才出封面）。整渲完成统一补一次追赶
    // （rAF 下一帧测量，届时全量挂载已完成），与 scroll 触发共用同一机制
    this.#scheduleCatchUp();
    // 以尾部占位把滚动条总长在首帧收敛为「已加载」终值（纯 style 写入、零追加）：
    // 已加载未挂载的条目全覆盖，未加载的尾部保持滚动不可达
    this.#syncTailReserve();
  }

  #enqueueFill(card) {
    this.#fillQueue.push(card);
    this.#scheduleDrain();
  }

  #scheduleDrain() {
    if (this.#drainRafId) return;
    this.#drainRafId = requestAnimationFrame(() => {
      this.#drainRafId = 0;
      // 快滚门控：冻结填充（变更会把万级布局打脏、瓦片光栅化排队）。快滚判定与基准
      // 推进只在 scroll 事件侧做（#onGridScroll），本循环只读 epoch：本轮无新
      // scroll 事件 = 停稳，转出快滚态并对落点带区补填
      if (this.#scrollFast) {
        if (this.#scrollEpoch !== this.#fastEpoch) {
          this.#fastEpoch = this.#scrollEpoch;
          this.#scheduleDrain();
          return;
        }
        this.#scrollFast = false;
        this.#refillBand();
        // 快滚期扩容可能把窗口撑过上限：停稳即收回（重挂到落点视口）
        this.#syncWindow();
      }
      // 时间预算制：每帧最多花 FILL_FRAME_BUDGET_MS 填卡即让出主线程，
      // 避免首屏集中填充时单帧超预算（固定张数在低端机上仍会卡）
      const deadline = performance.now() + config.FILL_FRAME_BUDGET_MS;
      while (this.#fillQueue.length && performance.now() < deadline) {
        this.#doFill(this.#fillQueue.shift());
      }
      if (this.#fillQueue.length) this.#scheduleDrain();
    });
  }

  #doFill(card) {
    // 骨架类/已摘除守卫由 populateItem 统一判定，此处只保证取得到条目
    const item = this.#itemMap.get(card.dataset[this.#itemKey]);
    if (item) this.populateItem(card, item);
  }

  // 原地填充：在骨架根节点上直接构建内容（同 #demote，禁止换根节点）
  populateItem(skeleton, item) {
    if (!skeleton.parentNode) return;
    if (!skeleton.classList.contains(this.#skeletonClass)) return;
    this.fillCard(skeleton, item);
    this.#cardItem.set(skeleton, item); // 复用判据：同键且同对象才搬运
    this.#ensureUnloadObserver();
    this.#unloadObserver.observe(skeleton);
  }

  #activate(event) {
    const itemEl = event.target.closest("." + this.#itemClass);
    if (!itemEl) return;
    const key = itemEl.dataset[this.#itemKey];
    const item = this.#itemMap.get(key);
    if (item) this.handleClick(event, item, itemEl);
  }

  // 子类必须实现：原地填充 / 清空还原骨架（均不得替换根节点）
  fillCard(card, item) {
    throw new Error("子类必须实现 fillCard");
  }
  clearCard(card) {
    throw new Error("子类必须实现 clearCard");
  }
  // render()/abortRender() wipe 容器前调用；含可播放媒体的子类覆写（默认无媒体）
  stopAllMedia() {}
  handleClick(event, item, itemEl) {
    throw new Error("子类必须实现 handleClick");
  }
}
