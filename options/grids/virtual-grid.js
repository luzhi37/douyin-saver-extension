// ---------- VirtualGrid（抽象基类，仅导出 class 不实例化） ----------
import { config, dom, state } from '../core.js';

// ---------- VirtualGrid ----------
export class VirtualGrid {
  #observer = null;
  #unloadObserver = null;
  #fillQueue = [];
  #drainRafId = 0;
  #pendingSkeletons = [];
  #sentinelCard = null;
  #itemMap = new Map();
  #chunkRaf = 0;
  #scrollRafId = 0;
  #boundClickHandler = null;
  #container = null;
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
    this.#container.addEventListener("click", this.#boundClickHandler);
    // 键盘激活与点击共用同一条 handleClick 路径（docs/UI_IMPROVEMENTS.md 建议7）：
    // 勾选圆 Enter/Space 切换选中；卡片根节点 Enter 等价整卡点击
    this.#container.addEventListener("keydown", (e) => this.#onKeydown(e));
    dom.mainGrid.addEventListener("scroll", () => this.#scheduleCatchUp(), { passive: true });
  }

  get skeletonClass() {
    return this.#skeletonClass;
  }

  render(items, emptyMsg, emptyHint) {
    cancelAnimationFrame(this.#chunkRaf);
    this.#chunkRaf = 0;
    // wipe 前先停媒体：卡片摘除后 pointerout 永不触发，游离的播放中 video 会继续出声
    this.stopAllMedia();
    this.#container.className = "main-container";
    this.#container.innerHTML = "";
    dom.emptyState.classList.add("hidden");
    dom.errorState.classList.add("hidden");

    // 先完全重置实例状态（含空列表分支），避免残留 observer/队列影响后续渲染
    if (this.#observer) {
      this.#observer.disconnect();
      this.#observer = null;
    }
    if (this.#unloadObserver) {
      this.#unloadObserver.disconnect();
      this.#unloadObserver = null;
    }
    this.#pendingSkeletons = [];
    this.#sentinelCard = null;
    this.#itemMap = new Map(items.map((item) => [item[this.#itemKey], item]));
    cancelAnimationFrame(this.#drainRafId);
    this.#drainRafId = 0;
    this.#fillQueue = [];

    if (items.length === 0) {
      dom.emptyState.classList.remove("hidden");
      dom.emptyState.querySelector("p").textContent = emptyMsg;
      dom.emptyState.querySelector(".empty-hint").textContent = emptyHint;
      this.#container.classList.add("hidden");
      return;
    }

    dom.emptyState.classList.add("hidden");
    this.#container.classList.remove("hidden");

    const skelTmpl = this.#getSkeletonTemplate();
    let index = 0;

    const renderChunk = () => {
      const fragment = document.createDocumentFragment();
      const end = Math.min(index + config.RENDER_CHUNK_SIZE, items.length);
      const chunkNodes = [];

      for (let i = index; i < end; i++) {
        const card = skelTmpl.content.cloneNode(true).firstElementChild;
        card.dataset[this.#itemKey] = items[i][this.#itemKey];
        chunkNodes.push(card);
        fragment.appendChild(card);
      }

      this.#container.appendChild(fragment);
      index = end;

      this.#observeNewSkeletons(chunkNodes);

      if (index < items.length) {
        this.#chunkRaf = requestAnimationFrame(renderChunk);
      } else {
        this.#finishRender();
      }
    };

    renderChunk();
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
    for (const id of idSet) {
      this.#itemMap.delete(id);
      const card = this.#container.querySelector(`[data-${this.#dataAttr}="${id}"]`);
      if (card) {
        if (this.#observer) this.#observer.unobserve(card);
        if (this.#unloadObserver) this.#unloadObserver.unobserve(card);
        if (card === this.#sentinelCard) {
          // 哨兵被删除会导致观察圈断链、后续骨架永不填充，立刻续接
          this.#sentinelCard = null;
          this.#extendObservation();
        }
        this.clearCard(card);
        card.remove();
      }
    }
    if (this.#container.children.length === 0) {
      this.#container.classList.add("hidden");
      dom.emptyState.classList.remove("hidden");
      dom.emptyState.querySelector("p").textContent = this.#emptyMsg;
      dom.emptyState.querySelector(".empty-hint").textContent = this.#emptyHint;
    }
  }

  // 中止未完成的分块渲染（域切换时调用，防止旧域骨架卡/observer 残留到共享容器）
  abortRender() {
    this.stopAllMedia();
    cancelAnimationFrame(this.#chunkRaf);
    this.#chunkRaf = 0;
    if (this.#observer) {
      this.#observer.disconnect();
      this.#observer = null;
    }
    if (this.#unloadObserver) {
      this.#unloadObserver.disconnect();
      this.#unloadObserver = null;
    }
    this.#pendingSkeletons = [];
    this.#sentinelCard = null;
    this.#itemMap = new Map();
    cancelAnimationFrame(this.#drainRafId);
    this.#drainRafId = 0;
    this.#fillQueue = [];
  }

  #getSkeletonTemplate() {
    return document.getElementById(
      this.#skeletonClass.replace(/-([a-z])/g, (_, c) => c.toUpperCase()) + "Template",
    );
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
      { rootMargin: config.UNLOAD_ROOT_MARGIN },
    );
  }

  // 原地降级：只清内容、切回骨架类，不换根节点。grid 容器任一直接子节点被替换
  // 都会触发 Blink 全量重排，成本随卡片总数线性增长（3000 卡单次 >10ms）。
  #demote(card) {
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
  #observeNewSkeletons(nodes) {
    if (!this.#observer) {
      this.#observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const card = entry.target;
            this.#observer.unobserve(card);
            if (card === this.#sentinelCard) {
              this.#sentinelCard = null;
              this.#extendObservation();
            }
            this.#enqueueFill(card);
          }
        },
        { rootMargin: config.OBSERVER_ROOT_MARGIN },
      );
    }
    this.#pendingSkeletons.push(...nodes);
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

  // 远跳兜底：快速滚动/拖动滚动条落点可能越过观察圈前沿，哨兵留在视口上方
  // 永不再相交、分圈推进断链，落点骨架因从未 observe 过而永远不填充。
  // 滚动时把填充带内未观察的骨架直连交给 fill observer（不走队列与哨兵，
  // 两条机制独立并存：慢速滚动仍由零成本的哨兵链推进）。
  #scheduleCatchUp() {
    if (this.#scrollRafId) return;
    this.#scrollRafId = requestAnimationFrame(() => {
      this.#scrollRafId = 0;
      this.#catchUpToViewport();
    });
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
  }

  #enqueueFill(card) {
    this.#fillQueue.push(card);
    this.#scheduleDrain();
  }

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

  // 键盘激活：勾选圆上的 Enter/Space 切换选中；卡片根节点直接持有焦点时 Enter
  // 等价整卡点击（打开详情/侧边栏）。焦点在卡内按钮/输入框上时不拦截，走原生行为
  #onKeydown(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const isCheckbox = !!target.closest(".work-checkbox, .following-checkbox");
    const itemEl = target.closest("." + this.#itemClass);
    if (!itemEl) return;
    if (event.key === "Enter" || event.key === " ") {
      if (isCheckbox) {
        event.preventDefault();
        event.stopPropagation();
        this.#activate(event);
        return;
      }
      if (event.key === "Enter" && target === itemEl && !target.closest("button, input")) {
        event.preventDefault();
        this.#activate(event);
      }
      return;
    }
    // 方向键导航（P0-4）：焦点在卡片根节点上时，把焦点移到相邻卡片。
    // 目标为未填充骨架时先入填充队列，保证落焦后能看到内容（不触碰降级机制）
    if (event.key.startsWith("Arrow") && target === itemEl) {
      const delta = this.#arrowDelta(event.key);
      if (!delta) return;
      event.preventDefault();
      const cards = Array.from(this.#container.children);
      const idx = cards.indexOf(itemEl);
      if (idx === -1) return;
      const next = cards[idx + delta];
      if (!next) return;
      if (next.classList.contains(this.#skeletonClass)) this.#enqueueFill(next);
      next.focus();
    }
  }

  // 左右 ±1；上下按当前列数跳行。列数不足 2 时上下键不拦截（单列退化为无操作）
  #arrowDelta(key) {
    if (key === "ArrowLeft") return -1;
    if (key === "ArrowRight") return 1;
    const cols = this.#columns();
    if (cols < 2) return null;
    return key === "ArrowUp" ? -cols : cols;
  }

  #columns() {
    const cs = getComputedStyle(this.#container);
    const cols = cs.gridTemplateColumns.split(" ").filter(Boolean).length;
    if (cols >= 2) return cols;
    const first = this.#container.firstElementChild;
    if (!first) return 1;
    return Math.max(1, Math.round(this.#container.clientWidth / first.getBoundingClientRect().width));
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
