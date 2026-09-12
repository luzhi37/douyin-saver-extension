// ---------- Sidebar ----------
import { config, dom, state, utils, services } from '../core.js';
import { followingsGrid } from '../grids/followings-grid.js';
import { detail } from './detail.js';

// ---------- Sidebar ----------
export class Sidebar {
  static SNAP_POINTS = config.SIDEBAR_SNAP_POINTS;
  static STORAGE_KEY = "douyin_sidebar_width";
  #dragStartX = 0;
  #dragStartW = 0;
  #dragMoved = false;
  #pendingSidebarWidth = 0;
  #pendingSidebarWidthDirty = false;
  #pendingSidebarWidthRafId = 0;
  #scrollRafPending = false;
  #imgQueue = [];
  #imgDrainRafId = 0;
  #sideFillObs = null;
  #sideUnloadObs = null;
  #workMeta = new WeakMap();
  #onResizeDown = (e) => {
    this.#dragStartX = e.clientX;
    this.#dragStartW = dom.sidebar.classList.contains("sidebar-zero") ? 0 : dom.sidebar.getBoundingClientRect().width;
    this.#dragMoved = false;
    dom.sidebarResizeHandle.classList.add("active");
    document.addEventListener("mousemove", this.#onResizeMove);
    document.addEventListener("mouseup", this.#onResizeUp);
    e.preventDefault();
  };
  #onResizeMove = (e) => {
    if (!this.#dragMoved && Math.abs(e.clientX - this.#dragStartX) >= config.SIDEBAR_DRAG_THRESHOLD) {
      this.#dragMoved = true;
    }
    const snapped = this.#snapTo(this.#dragStartW - (e.clientX - this.#dragStartX));
    this.#pendingSidebarWidth = snapped;
    this.#pendingSidebarWidthDirty = true;
    if (this.#pendingSidebarWidthRafId) return;
    this.#pendingSidebarWidthRafId = requestAnimationFrame(() => {
      this.#pendingSidebarWidthRafId = 0;
      if (this.#pendingSidebarWidthDirty) {
        this.#pendingSidebarWidthDirty = false;
        this.setSidebarWidth(this.#pendingSidebarWidth);
      }
    });
  };
  #onResizeUp = () => {
    dom.sidebarResizeHandle.classList.remove("active");
    document.removeEventListener("mousemove", this.#onResizeMove);
    document.removeEventListener("mouseup", this.#onResizeUp);
    // 未越过拖拽位移阈值按点击处理：切换侧边栏显隐而非吸附宽度
    if (!this.#dragMoved) {
      this.toggleSidebar();
      return;
    }
    const finalWidth = this.#snapTo(
      dom.sidebar.classList.contains("sidebar-zero") ? 0 : dom.sidebar.getBoundingClientRect().width,
    );
    // 拖拽释放会吸附到吸附点（650/0），跨列阈值时同样锚定视口内最上方卡片
    this.#preserveAnchor(this.#topVisibleCard(), () => {
      this.setSidebarWidth(finalWidth);
      this.saveSidebarWidth(finalWidth);
    });
  };

  // 点击分割条：收起（落盘 0，与拖拽收起语义一致）；展开恢复上次保存的宽度。
  // 开关都会改变主网格列数（固定卡宽 auto-fill 跨列阈值时卡片跳位），
  // 锚定视口内最上方卡片，开关前后保持其视口 Y，避免用户丢失视觉参考
  toggleSidebar() {
    if (dom.sidebar.classList.contains("sidebar-zero")) {
      const target = this.#loadWidth() || Sidebar.SNAP_POINTS[0];
      this.#preserveAnchor(this.#topVisibleCard(), () => {
        this.setSidebarWidth(target);
        this.saveSidebarWidth(target);
      });
    } else {
      this.#preserveAnchor(this.#topVisibleCard(), () => {
        this.setSidebarWidth(0);
        this.saveSidebarWidth(0);
      });
    }
  }

  initSidebar() {
    const savedWidth = this.#loadWidth();
    const snapped = this.#snapTo(savedWidth);
    this.setSidebarWidth(snapped);
    this.#initResize();
    dom.sidebarBody.addEventListener("scroll", () => {
      if (this.#scrollRafPending) return;
      this.#scrollRafPending = true;
      requestAnimationFrame(() => {
        this.#scrollRafPending = false;
        if (
          dom.sidebarBody.scrollTop + dom.sidebarBody.clientHeight >=
          dom.sidebarBody.scrollHeight - config.SIDEBAR_SCROLL_THRESHOLD
        ) {
          this.#loadMoreWorks();
        }
      });
    }, { passive: true });
  }

  setSidebarWidth(w) {
    if (w === 0) {
      dom.sidebar.classList.add("sidebar-zero");
      dom.sidebar.style.width = "";
      document.body.classList.remove("sidebar-open");
      // 分割条仅在侧边栏展开时可见、可交互
      dom.sidebarResizeHandle.classList.add("hidden");
    } else {
      dom.sidebar.classList.remove("sidebar-zero");
      dom.sidebar.style.width = w + "px";
      document.body.classList.add("sidebar-open");
      dom.sidebarResizeHandle.classList.remove("hidden");
    }
  }

  saveSidebarWidth(width) {
    localStorage.setItem(Sidebar.STORAGE_KEY, String(width));
  }

  // 网格滚动锚点补偿的公共入口：记录锚点卡视口 Y → 执行 mutate（任何会改变主网格
  // 列数的布局变更）→ 调整 #mainGrid.scrollTop 把锚点卡拉回原视口 Y。
  // 供 AppShell（左侧边栏折叠）等复用；锚点为 null 时仅执行 mutate
  preserveGridAnchor(anchorEl, mutate) {
    return this.#preserveAnchor(anchorEl, mutate);
  }

  clearSidebarActive() {
    const active = dom.mainContainer.querySelector(".following-card.sidebar-active");
    if (active) active.classList.remove("sidebar-active");
  }

  openSidebar(following) {
    this.clearSidebarActive();
    const card = dom.mainContainer.querySelector(`[data-uid="${following.uid}"]`);
    if (card) card.classList.add("sidebar-active");

    state.currentFollowingSecUid = utils.secUidFromUrl(following.profileUrl);
    state.sidebarCursor = null;
    state.sidebarLoading = false;

    const needsExpand = dom.sidebar.classList.contains("sidebar-zero");
    if (needsExpand) {
      const target = this.#loadWidth() || 650;
      // 锚定被点击卡片：展开使网格减列、该卡下移，补偿后保持在原视口 Y 供用户定位参考
      this.#preserveAnchor(card, () => {
        this.setSidebarWidth(target);
        this.saveSidebarWidth(target);
      });
    }

    this.#resetSidebarGrid();
    this.loadSidebarWorks(state.currentFollowingSecUid, null, true);
    this.#calibrateFollowing(following);
  }

  // 打开侧边栏即顺带校准该用户的权威计数（profile/other，单请求）：成功后同步
  // 更新 state 与可见卡片；失败静默忽略，不影响作品加载
  async #calibrateFollowing(following) {
    const secUid = state.currentFollowingSecUid;
    if (!secUid || !following?.uid) return;
    const res = await services.bgMsg({ type: "CALIBRATE_FOLLOWING", uid: following.uid, secUid });
    if (!res?.ok) return;
    const entry = state.followings.find((f) => String(f.uid) === String(following.uid));
    if (entry) {
      entry.awemeCount = res.awemeCount;
      entry.followerCount = res.followerCount;
    }
    const card = dom.mainContainer.querySelector(`[data-uid="${following.uid}"]`);
    if (card && !card.classList.contains(followingsGrid.skeletonClass)) {
      const followersEl = card.querySelector(".stat-followers");
      const worksEl = card.querySelector(".stat-works");
      if (followersEl) followersEl.textContent = utils.formatCount(res.followerCount) + " 粉丝";
      if (worksEl) worksEl.textContent = utils.formatCount(res.awemeCount) + " 作品";
    }
  }

  // 重开作者前整体复位：在途探针作废、观察器断开重建，防止上一作者的条目观察残留
  #resetSidebarGrid() {
    this.#clearImgQueue();
    if (this.#sideFillObs) {
      this.#sideFillObs.disconnect();
      this.#sideFillObs = null;
    }
    if (this.#sideUnloadObs) {
      this.#sideUnloadObs.disconnect();
      this.#sideUnloadObs = null;
    }
    dom.sidebarWorksGrid.innerHTML = "";
  }

  async loadSidebarWorks(secUid, cursor, reset) {
    if (state.sidebarLoading) return;
    state.sidebarLoading = true;
    dom.sidebarLoader.classList.remove("hidden");

    try {
      const res = await services.bgMsg({
        type: "FETCH_WORKS_PAGE",
        secUid,
        cursor: cursor || "",
      });

      if (reset) dom.sidebarWorksGrid.innerHTML = "";

      if (res.ok && res.works) {
        const fragment = document.createDocumentFragment();
        const items = [];
        for (const w of res.works) {
          const item = this.#createWorkItem(w);
          fragment.appendChild(item);
          items.push(item);
        }
        dom.sidebarWorksGrid.appendChild(fragment);
        state.sidebarCursor = res.hasMore ? res.maxCursor || "" : null;
        // 新条目只进"观察圈"：进入视口才升级（发探针+绘制），滚出远圈后降级回占位态
        this.#ensureSideObservers();
        for (const el of items) {
          if (this.#workMeta.has(el)) this.#sideFillObs.observe(el);
        }
      }
      dom.sidebarLoader.classList.add("hidden");
    } catch (_e) {
      console.error("[DY] sidebar load failed:", _e);
      dom.sidebarLoader.querySelector(".spinner")?.remove();
      dom.sidebarLoader.textContent = "加载失败" + (_e.message ? ": " + _e.message : "");
    }

    state.sidebarLoading = false;

    if (
      state.sidebarCursor &&
      dom.sidebarBody.scrollHeight <= dom.sidebarBody.clientHeight + config.SIDEBAR_FILL_THRESHOLD
    ) {
      this.#loadMoreWorks();
    }
  }

  #loadWidth() {
    return parseInt(localStorage.getItem(Sidebar.STORAGE_KEY)) || 0;
  }

  #snapTo(v) {
    let n = Sidebar.SNAP_POINTS[0];
    for (let i = 0; i < Sidebar.SNAP_POINTS.length; i++) {
      if (Math.abs(Sidebar.SNAP_POINTS[i] - v) < Math.abs(n - v)) n = Sidebar.SNAP_POINTS[i];
    }
    return n;
  }

  // 锚点滚动补偿：侧边栏开关/拖拽释放改变主网格列数后，把锚点卡拉回原视口 Y
  //（水平列位随重排必然漂移，垂直精确保持即"尽量不变"）。必须同步执行：
  // setSidebarWidth 无宽度过渡，mutate 后一次 getBoundingClientRect 即读到新布局
  #preserveAnchor(anchorEl, mutate) {
    if (!anchorEl || !anchorEl.isConnected) return mutate();
    const grid = dom.mainGrid;
    const before = anchorEl.getBoundingClientRect().top;
    const result = mutate();
    if (!anchorEl.isConnected) return result;
    const after = anchorEl.getBoundingClientRect().top;
    const delta = after - before;
    if (Math.abs(delta) > 1) grid.scrollTop += delta;
    return result;
  }

  // 锚点兜底：取视口内最上方的卡片作锚（骨架/完整卡都参与网格流、几何位置真实，
  // 视口顶部的卡处于填充圈内、通常为完整卡）；无卡片（空态/错误态）时返回 null
  #topVisibleCard() {
    const gridTop = dom.mainGrid.getBoundingClientRect().top;
    for (const card of dom.mainContainer.querySelectorAll(".following-card")) {
      if (card.getBoundingClientRect().bottom > gridTop + 4) return card;
    }
    return null;
  }

  #initResize() {
    dom.sidebarResizeHandle.addEventListener("mousedown", this.#onResizeDown);
  }

  #loadMoreWorks() {
    if (state.sidebarLoading || !state.sidebarCursor || !state.currentFollowingSecUid) return;
    this.loadSidebarWorks(state.currentFollowingSecUid, state.sidebarCursor, false);
  }

  // 侧边栏双向虚拟化：与 VirtualGrid 同一不变量——根节点不换，只在占位态/完整态间原地切换。
  // 观察圈以 sidebarBody 为 root（rootMargin 相对滚动容器自身矩形展开，不受祖先裁剪抵消）
  #ensureSideObservers() {
    if (this.#sideFillObs) return;
    this.#sideFillObs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          this.#sideFillObs.unobserve(entry.target);
          this.#promoteItem(entry.target);
        }
      },
      { root: dom.sidebarBody, rootMargin: config.OBSERVER_ROOT_MARGIN },
    );
    this.#sideUnloadObs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) this.#demoteItem(entry.target);
        }
      },
      { root: dom.sidebarBody, rootMargin: config.UNLOAD_ROOT_MARGIN },
    );
  }

  #promoteItem(item) {
    const meta = this.#workMeta.get(item);
    if (!meta || !meta.url) return;
    this.#enqueueCover(meta.cover, meta.url, meta.placeholder);
    this.#sideUnloadObs.observe(item);
  }

  // 原地降级：清背景图、恢复占位层，尺寸由 aspect-ratio 保持；
  // 代际自增作废在途探针（重升级会再次入队，旧回调不得回填）
  #demoteItem(item) {
    const meta = this.#workMeta.get(item);
    if (!meta || !meta.url) return;
    meta.cover.dataset.gen = String((Number(meta.cover.dataset.gen) || 0) + 1);
    meta.cover.style.backgroundImage = "";
    meta.placeholder.style.display = "";
    this.#sideUnloadObs.unobserve(item);
    this.#sideFillObs.observe(item);
  }

  // 封面分帧探针化：每帧最多 SIDEBAR_IMG_PER_FRAME 张；gen 代际防降级/重升级后的乱序回填
  #enqueueCover(cover, url, placeholder) {
    const gen = String((Number(cover.dataset.gen) || 0) + 1);
    cover.dataset.gen = gen;
    this.#imgQueue.push({ cover, url, placeholder, gen });
    this.#scheduleImgDrain();
  }

  // 探针预载：失败 URL 不落可见节点（与关注头像同一不变量），封面 div 保持透明由条目底色兜底；
  // 成功提交背景图并直接隐藏占位层
  #scheduleImgDrain() {
    if (this.#imgDrainRafId) return;
    this.#imgDrainRafId = requestAnimationFrame(() => {
      this.#imgDrainRafId = 0;
      let n = 0;
      while (this.#imgQueue.length && n < config.SIDEBAR_IMG_PER_FRAME) {
        const { cover, url, placeholder, gen } = this.#imgQueue.shift();
        // 已降级/已重建的条目直接丢弃，不再发探针请求
        if (!cover.isConnected || cover.dataset.gen !== gen) continue;
        const alive = () => cover.isConnected && cover.dataset.gen === gen;
        const probe = new Image();
        probe.onload = () => {
          if (!alive()) return;
          detail.markMediaOk();
          cover.style.backgroundImage = `url("${url.replace(/["\\]/g, "\\$&")}")`;
          if (placeholder && placeholder.isConnected) placeholder.style.display = "none";
        };
        probe.onerror = () => {
          if (!alive()) return;
          detail.markMediaFail();
        };
        probe.src = url;
        n++;
      }
      if (this.#imgQueue.length) this.#scheduleImgDrain();
    });
  }

  #clearImgQueue() {
    if (this.#imgDrainRafId) {
      cancelAnimationFrame(this.#imgDrainRafId);
      this.#imgDrainRafId = 0;
    }
    this.#imgQueue = [];
  }

  #createWorkItem(work) {
    const item = dom.sidebarWorkTemplate.content.cloneNode(true).firstElementChild;
    const link = item.children[0];
    const isNote = work.type === "note";
    const type = isNote ? "note" : "video";
    link.href = `${config.URL_BASE}/${type}/${work.awemeId}`;

    const badge = link.querySelector(".work-type-badge");
    if (badge) badge.classList.toggle("hidden", !isNote);

    const img = link.children[0];
    const placeholder = link.children[1];
    const cover = isNote ? work.images?.[0] || work.cover : work.cover;
    const url = cover ? utils.pickHttpsUrl(cover) : "";
    if (url) {
      // 元数据挂 WeakMap；探针推迟到条目进入视口（#promoteItem）才发，不再创建即全量急切加载
      this.#workMeta.set(item, { url, cover: img, placeholder });
    } else {
      img.style.display = "none";
      if (isNote) placeholder.textContent = "📰";
    }

    const plays = work.statistics && work.statistics.play_count ? utils.formatCount(work.statistics.play_count) : "";
    const playsEl = link.children[2];
    if (plays) {
      playsEl.textContent = "\u25B6 " + plays;
    } else {
      playsEl.style.display = "none";
    }

    return item;
  }
}

export const sidebar = new Sidebar();
