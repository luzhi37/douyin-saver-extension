// ---------- VirtualGrid（抽象基类，仅导出 class 不实例化） ----------
import { config, dom, state } from '../core.js';

// ---------- VirtualGrid ----------
export class VirtualGrid {
  #observer = null;
  #unloadObserver = null;
  #fillQueue = [];
  #drainRafId = 0;
  #pendingSkeletons = [];
  #pendingAppends = [];
  #pendingFills = [];
  #pendingInserts = [];
  // 预铺槽位表：render 按文档序持有的全部卡节点（真数据卡 + 未回填占位卡），
  // 渐进页经 fillSlots 以键前缀自锚定回填。与域数组同步收缩（removeItems splice
  // + #totalSlots 同步递减），对齐不变
  #slots = [];
  #totalSlots = 0; // 预铺目标总槽位（首页响应 total）：#slots 按上限铺、滚近底部倍增扩容至此
  #sentinelCard = null;
  #itemMap = new Map();
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
  #skeletonClass = "";
  #itemClass = "";
  #itemKey = "";
  #dataAttr = "";
  #emptyMsg = "";
  #emptyHint = "";

  constructor({ container, itemClass, skeletonClass, itemKey, emptyMsg, emptyHint }) {
    this.#container = container;
    this.#itemClass = itemClass;
    this.#skeletonClass = skeletonClass;
    this.#itemKey = itemKey;
    this.#dataAttr = itemKey.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
    this.#emptyMsg = emptyMsg || "";
    this.#emptyHint = emptyHint || "";
    this.#boundClickHandler = this.#onClick.bind(this);
    // 点击委托绑在 #mainGrid（稳定节点）而非容器上：clearActiveGrid 换壳重建容器后无需重绑
    dom.mainGrid.addEventListener("click", this.#boundClickHandler);
    dom.mainGrid.addEventListener("scroll", () => this.#onGridScroll(), { passive: true });
  }

  get skeletonClass() {
    return this.#skeletonClass;
  }

  // 清场换壳后重指向新容器（容器级事件监听在 #mainGrid 上，不受换壳影响）
  attachContainer(el) {
    this.#container = el;
  }

  render(items, emptyMsg, emptyHint, totalSlots = 0) {
    cancelAnimationFrame(this.#chunkRaf);
    this.#chunkRaf = 0;
    // wipe 前先停媒体：卡片摘除后 pointerout 永不触发，游离的播放中 video 会继续出声
    this.stopAllMedia();
    this.#container.className = "main-container";
    this.#container.innerHTML = "";
    dom.emptyState.classList.add("hidden");
    dom.errorState.classList.add("hidden");

    // 先完全重置实例状态（含空列表分支），避免残留 observer/队列影响后续渲染
    this.#resetRenderState(new Map(items.map((item) => [item[this.#itemKey], item])));

    if (items.length === 0) {
      this.#showEmpty(emptyMsg, emptyHint);
      return;
    }

    dom.emptyState.classList.add("hidden");
    this.#container.classList.remove("hidden");

    const skelTmpl = this.#getSkeletonTemplate();
    // 渐进加载的预铺：预铺数有上限（GRID_PREMOUNT_CAP），超出部分由滚近底部时倍增扩容
    // （#extendIfNeeded）——活 DOM 规模封顶，切组拆卸/布局/绘制的 O(N) 成本以 N=已挂载
    // 数为分母；未到达且未挂载的槽位在滚动条上不可达，「远跳落进空白」结构性不存在。
    // 已知条目（items.length）始终全量铺，未到达槽位为无键占位卡（fillSlots 按槽对号）
    this.#totalSlots = Math.max(totalSlots, items.length);
    const slotCount = Math.min(this.#totalSlots, Math.max(config.GRID_PREMOUNT_CAP, items.length));

    // 两段式铺设：首段同步挂载（数据到达即出画面）；余量在游离 fragment 内按时间预算
    // 分帧拼装（脱 DOM 不触发布局），拼完一次挂载。容器全程只经历 2 次插入，万级列表
    // 从「逐帧向容器追加、每帧触发全容器 grid 重排（总成本 O(N²/块)）」收敛为收尾
    // 1 次 O(N) 布局
    const firstCount = Math.min(config.RENDER_CHUNK_SIZE, slotCount);
    const firstFragment = document.createDocumentFragment();
    const firstNodes = [];
    for (let i = 0; i < firstCount; i++) {
      const card =
        i < items.length ? this.#cloneSkeleton(skelTmpl, items[i]) : this.#clonePlaceholder(skelTmpl);
      firstNodes.push(card);
      firstFragment.appendChild(card);
    }
    for (const node of firstNodes) this.#slots.push(node);
    this.#container.appendChild(firstFragment);
    this.#observeNewSkeletons(firstNodes);
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
          card = this.#cloneSkeleton(skelTmpl, item);
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
      this.#container.appendChild(mountFragment);
      for (const node of aliveNodes) this.#slots.push(node);
      this.#observeNewSkeletons(aliveNodes);
      this.#finishRender();
      this.#chunkRaf = 0;
      this.#drainPendingInserts();
      this.#drainPendingFills();
      this.#drainPendingAppends();
    };
    buildChunk();
  }

  // 分页渐进加载追加（loadDomainData → main.js 按筛选态分流后调用）：新页骨架接在
  // 已渲染网格尾部，页序 savedAt 降序与既有排列单调一致。复用两段式铺设约束：
  // 游离 fragment 拼装、一次挂载、挂载后再交接分圈观察。首屏 buildChunk 未完成时
  // 排队，完成后 drain
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
      const card = this.#cloneSkeleton(skelTmpl, item);
      nodes.push(card);
      fragment.appendChild(card);
    }
    if (!nodes.length) return;
    this.#container.appendChild(fragment);
    for (const node of nodes) this.#slots.push(node);
    this.#observeNewSkeletons(nodes);
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
  // 带外的保持观察、滚近自然触发。槽位越界/已占键的条目回退 appendItems 追加
  fillSlots(startIndex, items) {
    if (!items.length) return;
    if (this.#chunkRaf) {
      this.#pendingFills.push({ startIndex, items });
      return;
    }
    this.#applyFill(startIndex, items);
  }

  #applyFill(startIndex, items) {
    // 落点自锚定：以首个无键占位卡为基准、与传入 start 取小者。删除会使 #slots 相对
    // 页序收缩（拼装窗口内的在途删除、push→回填 rAF 间隙的删除），传入 start 按删除
    // 前 state 长度计算，直接对号会整页写偏、留下永久无键灰卡；网格的键前缀是唯一
    // 可信对齐基准。无删除时两者相等，行为不变
    let start = this.#slots.length;
    for (let i = 0; i < this.#slots.length; i++) {
      if (!this.#slots[i].dataset[this.#itemKey]) {
        start = i;
        break;
      }
    }
    if (startIndex < start) start = startIndex;
    const gridRect = dom.mainGrid.getBoundingClientRect();
    const margin = parseFloat(config.OBSERVER_ROOT_MARGIN) || 0;
    const bandTop = gridRect.top - margin;
    const bandBottom = gridRect.bottom + margin;
    const misses = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const card = this.#slots[start + i];
      if (card && card.isConnected && !card.dataset[this.#itemKey]) {
        card.dataset[this.#itemKey] = item[this.#itemKey];
        this.#itemMap.set(item[this.#itemKey], item);
        const rect = card.getBoundingClientRect();
        if (rect.bottom >= bandTop && rect.top <= bandBottom) {
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
    return this.#mountInsert(index, items);
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
      if (!this.#mountInsert(index, items)) {
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
    this.#totalSlots = this.#slots.length; // 收敛后不再扩容
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
    for (const id of idSet) {
      const known = this.#itemMap.delete(id);
      const card = this.#container.querySelector(`[data-${this.#dataAttr}="${id}"]`);
      if (card) {
        if (this.#observer) this.#observer.unobserve(card);
        if (this.#unloadObserver) this.#unloadObserver.unobserve(card);
        if (card === this.#sentinelCard) {
          // 哨兵被删除会导致观察圈断链、后续骨架永不填充，立刻续接
          this.#sentinelCard = null;
          this.#extendObservation();
        }
        // 槽位表与域数组同步收缩：预铺回填的对齐关系依赖两侧同构
        const slotIdx = this.#slots.indexOf(card);
        if (slotIdx !== -1) this.#slots.splice(slotIdx, 1);
        this.clearCard(card);
        card.remove();
        removed++;
      } else if (known) {
        // 网格确认持有但无连接卡：条目已克隆进拼装窗口的游离节点，挂载时被对账丢弃、
        // 永不占槽。#totalSlots 必须随真实条目数一起收缩，否则差额会被 #extendIfNeeded
        // 当作未铺配额，在滚近底部时原样补回无键占位卡（永久灰卡）
        removed++;
      }
    }
    // 预铺目标与 #slots 同步收缩；clamp 防御异常态下减穿下界
    if (removed) this.#totalSlots = Math.max(this.#slots.length, this.#totalSlots - removed);
    if (this.#container.children.length === 0) {
      this.#showEmpty(this.#emptyMsg, this.#emptyHint);
    }
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
    this.#slots = [];
    this.#totalSlots = 0;
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
        for (const entry of entries) {
          if (!entry.isIntersecting) this.#demote(entry.target);
        }
      },
      // root 必须显式传 #mainGrid（滚动容器）：隐式根=文档视口时，rootMargin 会被
      // #mainGrid 自身作为祖先滚动容器的裁剪盒抵消，卸载圈塌缩到滚动口边缘——卡刚
      // 出可视区即降级、滚回即重填（「小幅滚动往返卡片重载」的根因，sidebar 同款
      // 规则见 sidebar.js）。#mainGrid 是稳定节点（clearActiveGrid 只换 #mainContainer），
      // 无需随换壳重挂
      { root: dom.mainGrid, rootMargin: config.UNLOAD_ROOT_MARGIN },
    );
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

  // 分圈观察：新骨架先进待观察队列，只把最靠前一圈（OBSERVE_CHUNK_SIZE 个）交给 IO，
  // 圈尾哨兵进圈（进入 OBSERVER_ROOT_MARGIN）时再放下一批。
  // computeIntersections 成本随已观察目标数线性，全量 observe 会让滚动期每帧
  // 重算 O(全部卡) 次几何——这是侧边栏打开后风扇高转的主因之一（实测 trace 占 1.2s/5s）
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
    this.#scheduleCatchUp();
  }

  // 远跳兜底：快速滚动/拖动滚动条落点可能越过观察圈前沿，哨兵留在视口上方
  // 永不再相交、分圈推进断链，落点骨架因从未 observe 过而永远不填充。
  // 滚动时把填充带内未观察的骨架直连交给 fill observer（不走队列与哨兵，
  // 两条机制独立并存：慢速滚动仍由零成本的哨兵链推进）。
  #scheduleCatchUp() {
    if (this.#scrollRafId) return;
    this.#scrollRafId = requestAnimationFrame(() => {
      this.#scrollRafId = 0;
      this.#extendIfNeeded();
      this.#catchUpToViewport();
    });
  }

  // 接近底部扩容：内容底距视口底不足 GRID_EXTEND_THRESHOLD 屏时，预铺槽位数倍增至
  // totalSlots 上限（尾批对齐剩余量）。追加走占位卡克隆 + 分圈观察既有机制；
  // 已到达的数据页不受影响（fillSlots 以键前缀自锚定落点，槽源与 state 并行生长）
  #extendIfNeeded() {
    if (this.#chunkRaf) return; // 预铺拼装未完成时不扩容：文档尚短，且双路径写 #slots 会交错
    if (this.#slots.length >= this.#totalSlots) return;
    const rect = this.#container.getBoundingClientRect();
    const gridRect = dom.mainGrid.getBoundingClientRect();
    if (rect.bottom - gridRect.bottom > dom.mainGrid.clientHeight * config.GRID_EXTEND_THRESHOLD) return;
    const next = Math.min(this.#totalSlots, this.#slots.length * 2);
    if (next <= this.#slots.length) return;
    const skelTmpl = this.#getSkeletonTemplate();
    const frag = document.createDocumentFragment();
    const nodes = [];
    for (let i = this.#slots.length; i < next; i++) {
      const card = this.#clonePlaceholder(skelTmpl);
      this.#slots.push(card);
      nodes.push(card);
      frag.appendChild(card);
    }
    this.#container.appendChild(frag);
    this.#observeNewSkeletons(nodes);
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
      if (this.#observer) this.#observer.unobserve(card);
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
    if (state.batchMode) {
      this.#container
        .querySelectorAll(
          "." + this.#skeletonClass + " .work-checkbox, ." + this.#skeletonClass + " .following-checkbox",
        )
        .forEach((cb) => {
          cb.style.display = "";
        });
    }
    // 原位整刷收尾的视口追赶：wipe 与重挂同任务同步完成、重渲前后内容等高时（典型：批量
    // 同步 SYNC_DONE 全量刷新），滚动位置原样保留、全程无 scroll 事件——分圈哨兵停在网格
    // 顶部、向下链推进够不着中部视口，而 #catchUpToViewport 只由 scroll 事件调度，视口
    // 带区骨架无人观察、永久停在灰卡态（手动滚一下才出封面）。整渲完成统一补一次追赶
    // （rAF 下一帧测量，届时全量挂载已完成），与 scroll 触发共用同一机制
    this.#scheduleCatchUp();
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
    const key = card.dataset[this.#itemKey];
    const item = this.#itemMap.get(key);
    if (item && card.classList.contains(this.#skeletonClass)) {
      this.populateItem(card, item);
    }
  }

  // 原地填充：在骨架根节点上直接构建内容（同 #demote，禁止换根节点）
  populateItem(skeleton, item) {
    if (!skeleton.parentNode) return;
    if (!skeleton.classList.contains(this.#skeletonClass)) return;
    this.fillCard(skeleton, item);
    this.#ensureUnloadObserver();
    this.#unloadObserver.observe(skeleton);
  }

  #onClick(event) {
    this.#activate(event);
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
