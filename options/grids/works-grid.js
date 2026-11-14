// ---------- WorksGrid（作品/点赞/收藏三域共用） ----------
import { config, dom, state, utils } from '../core.js';
import { VirtualGrid, noteProgrammaticScroll } from './virtual-grid.js';
import { createProbeQueue } from './probe-queue.js';
import { search } from '../components/search-bar.js';
import { batch } from '../data/batch.js';
import { detail } from '../components/detail.js';
import { sidebar } from '../components/sidebar.js';

// 作品卡尺寸 CSS 变量单一出处：VirtualGrid 布局测量与滚动兜底估算共用（曾双写，改名即断）
const WORKS_CARD_SIZE_VAR = "--dy-card-size";

// 封面提交/失败语义（works 三域共用）：失败原样重试一次（dataset.retry 挂可见节点，
// 随重填换新节点自然复位；熔断冷却中不重试），仍失败停留透明占位态
function commitWorkCover(img, url, gen) {
  if (!img.isConnected || img.dataset.coverGen !== gen) return;
  detail.markMediaOk();
  img.style.backgroundImage = utils.cssUrl(url);
  img.classList.remove("media-loading");
}

function failWorkCover(img, url, gen) {
  if (!img.isConnected || img.dataset.coverGen !== gen) return;
  detail.markMediaFail();
  if (img.dataset.retry || detail.mediaRetryBlocked()) return;
  img.dataset.retry = "1";
  const retryProbe = new Image();
  retryProbe.onload = () => commitWorkCover(img, url, gen);
  retryProbe.onerror = () => failWorkCover(img, url, gen);
  retryProbe.src = url;
}

// ---------- WorksGrid ----------
// 与 search-bar/batch/detail 存在循环 import（它们各自反向引用本模块）：单例引用全部发生在
// 方法体内、模块图完全求值之后才被触达，靠 ES live binding 安全消解（AGENTS.md 设计例外）
class WorksGrid extends VirtualGrid {
  #sliderRaf = 0;
  #workCardTmpl = document.getElementById("workCardTemplate");
  // 封面探针分帧队列（probe-queue 共用壳）：代际防乱序回填
  #probeQueue = createProbeQueue({
    budget: config.GRID_IMG_PER_FRAME,
    alive: (t) => t.img.isConnected && t.img.dataset.coverGen === t.gen,
    commit: (t) => commitWorkCover(t.img, t.url, t.gen),
    fail: (t) => failWorkCover(t.img, t.url, t.gen),
  });
  #videoStates = new WeakMap();
  #currentMediaCard = null;
  #pointer = { x: 0, y: 0 }; // 最近指针客户端坐标（pointerover/out/move 保鲜）：滚动重判悬停用
  #hoverRecheckRaf = 0;
  constructor({ emptyMsg, emptyHint } = {}) {
    super({
      container: dom.mainContainer,
      itemClass: "work-card",
      skeletonClass: "work-skeleton",
      itemKey: "awemeId",
      emptyMsg,
      emptyHint,
      cardSizeVar: WORKS_CARD_SIZE_VAR,
      sizeBandMin: config.WORK_CARD_SIZE_BAND_MIN,
      sizeBandMax: config.WORK_CARD_SIZE_BAND_MAX,
    });
    // 空态文案按实例区分（作品/点赞/收藏域文案不同），默认文案由基类单份持有（emptyText）
    this.#bindMediaEvents();
  }

  // 行高解析钩子（.work-card 的 height calc 同式：卡宽 × 4/3 + 信息块 30 + 行距 11）：
  // 改宽当帧头部占位按解析式落笔，免一次实测重排；返回 0 表示未落笔（走实测缓存）
  rowHeightFor(cardW) {
    return cardW > 0 ? (cardW * 4) / 3 + config.CARD_HEIGHT_OFFSET + config.CARD_GAP : 0;
  }

  renderCards(view) {
    // 渲染取过滤后的视图列表（refreshGridView 是唯一调用方，恒注入现成视图）。
    // 筛选生效时空态文案区分"无数据"与"无匹配"。
    // 渐进加载首页渲染一次性消费预铺额度（state.gridSlots.total）：全量骨架预铺 +
    // 余页按槽回填；筛选态（封闭视图）预铺降档至 GRID_PREMOUNT_CAP_FILTER——每次筛选
    // 切换都全量拆建，预铺数直接决定切换的 DOM 成本，余量滚近底部键控扩容补齐
    const stash = state.gridSlots;
    const filtered = search.isFilterActive();
    const totalSlots =
      stash && !filtered && stash.domain === state.domain && stash.groupId === state.currentGroupId
        ? stash.total
        : 0;
    state.gridSlots = null;
    const premountCap = filtered ? config.GRID_PREMOUNT_CAP_FILTER : config.GRID_PREMOUNT_CAP;
    if (filtered) {
      this.render(view, "没有符合筛选条件的作品", "调整关键词或筛选条件后重试", totalSlots, premountCap);
    } else {
      // 各域统一轻量空态（图标 + 文案 + 提示），不再展示首次使用行动区
      this.render(view, this.emptyText, this.emptyHintText, totalSlots, premountCap);
    }
  }

  // 原地填充：骨架根节点保留，媒体子树从完整模板取新节点移入
  fillCard(card, work) {
    const fresh = this.#workCardTmpl.content.cloneNode(true).firstElementChild;
    card.classList.remove(this.skeletonClass);
    card.dataset.awemeId = work.awemeId;
    // 类型标记（video/note）：仅图集卡启用封面悬浮放大（CSS 按 data-type 选取）
    card.dataset.type = work.type;

    const media = card.querySelector(".work-media");
    media.replaceChildren(...fresh.querySelector(".work-media").childNodes);

    const badge = card.querySelector(".work-type-badge");
    const thumb = card.querySelector(".work-thumb");
    const video = card.querySelector(".work-video-player");
    const controls = card.querySelector(".work-video-controls");
    let checkbox = card.querySelector(".work-checkbox");
    if (!checkbox) {
      // 骨架模板不含勾选框：避免批量模式一次性对上千个骨架做样式重排/重绘，仅在卡片填充时创建
      checkbox = document.createElement("div");
      checkbox.className = "work-checkbox";
      checkbox.setAttribute("role", "checkbox");
      checkbox.setAttribute("aria-checked", "false");
      checkbox.setAttribute("aria-label", "选择作品");
      card.querySelector(".work-media").after(checkbox);
    }

    badge.classList.toggle("hidden", work.type === "video");
    if (work.type === "note") {
      video.style.display = "none";
      controls.style.display = "none";
    }

    batch.updateCheckboxDOM(checkbox, state.selectedIds.has(work.awemeId));

    const videoSrc = utils.getVideoUrl(work);
    if (work.type === "video" && videoSrc) {
      card.dataset.videoUrl = videoSrc;
      const coverUrl = utils.pickHttpsUrl(work.cover || "");
      this.#stageThumb(thumb);
      if (coverUrl) this.#enqueueCover(thumb, coverUrl);

      const st = {
        progress: controls.querySelector(".video-progress"),
        timeSpan: controls.querySelector(".video-time"),
        muteBtn: controls.querySelector(".video-mute-btn"),
        playBtn: controls.querySelector(".video-play-btn"),
        controls: controls,
      };
      this.#videoStates.set(video, st);
      // 全页静音偏好（state.mediaMuted）：新填充卡片继承当前标志（含按钮图标），
      // 保证经「播放」按钮直启而非悬停起播的路径音量口径一致
      video.muted = state.mediaMuted;
      st.muteBtn.innerHTML = state.mediaMuted ? config.icons.mute : config.icons.unmute;
      this.#bindVideoMediaEvents(video, st);
    } else if (work.type === "note") {
      const imgUrl = utils.pickCardCover(work);
      this.#stageThumb(thumb);
      if (imgUrl) this.#enqueueCover(thumb, imgUrl);
    }

    this.#applyInfo(card, work);
  }

  // 卡片作者为外链锚点：链作者主页（Ctrl/Cmd+点击新标签打开，普通点击打开侧边
  // 作品栏，见 handleClick）；无 authorHomeUrl 时作者位整行不显示（置空，行高由
  // .work-info 固定）。作品标题已不再入库，信息条只保留作者与发布日期
  #applyInfo(card, work) {
    // 发布日期与作者分支解耦：无 authorHomeUrl 的记录日期仍靠右显示
    const createTimeEl = card.querySelector(".work-create-time");
    if (createTimeEl) {
      createTimeEl.textContent = utils.formatPublishDate(work.createTime);
      createTimeEl.classList.toggle("hidden", !createTimeEl.textContent);
    }
    this.#applyAuthorFlags(card, work);
    const author = card.querySelector(".work-author");
    if (!author) return;
    if (work.authorHomeUrl) {
      author.textContent = `@${work.nickname || "未知作者"}`;
      author.href = work.authorHomeUrl;
    } else {
      author.textContent = "";
      author.removeAttribute("href");
    }
  }

  // 作者域状态 chip（关注/候选）：按 uid 主键集判定（跨分组），命中才显示。节点随填充
  // 懒创建、降级移除（同勾选框，骨架卡不多带节点）；chip 不可点击（pointer-events:none），
  // 不改变 .work-info 30px 高度数学（14px 行高嵌在 16px 作者行内）
  #applyAuthorFlags(card, work) {
    card.dataset.uid = String(work.uid || "");
    const row = card.querySelector(".work-author-row");
    if (!row) return;
    const date = row.querySelector(".work-create-time");
    let following = row.querySelector(".work-author-flag-following");
    if (!following) {
      following = document.createElement("span");
      following.className = "work-author-flag work-author-flag-following hidden";
      following.textContent = "关注";
      row.insertBefore(following, date);
    }
    let candidate = row.querySelector(".work-author-flag-candidate");
    if (!candidate) {
      candidate = document.createElement("span");
      candidate.className = "work-author-flag work-author-flag-candidate hidden";
      candidate.textContent = "候选";
      row.insertBefore(candidate, date);
    }
    const uid = card.dataset.uid;
    following.classList.toggle("hidden", !uid || !state.followedUids.has(uid));
    candidate.classList.toggle("hidden", !uid || !state.candidateUids.has(uid));
  }

  // 作者域主键集刷新后的挂载卡原地 patch（O(挂载卡)）：只 toggle chip 显隐，不整刷
  //（零封面重探/零滚动跳位）；骨架卡无 chip 自然跳过
  syncAuthorFlags() {
    for (const card of dom.mainContainer.querySelectorAll(".work-card[data-uid]")) {
      const uid = card.dataset.uid;
      if (!uid) continue;
      card
        .querySelector(".work-author-flag-following")
        ?.classList.toggle("hidden", !state.followedUids.has(uid));
      card
        .querySelector(".work-author-flag-candidate")
        ?.classList.toggle("hidden", !state.candidateUids.has(uid));
    }
  }

  #toggleMediaMute() {
    state.mediaMuted = !state.mediaMuted;
    this.syncMediaMute();
  }

  // 全页静音偏好在卡片侧的施加（网格切换与详情切换共用）：遍历当前容器全部已渲染视频卡，
  // 同步 video.muted 与按钮图标。按钮经 DOM 定位而非本实例 #videoStates——详情层切换静音
  // 时当前域卡片可能由另一个 WorksGrid 实例填充，WeakMap 查不到
  syncMediaMute() {
    for (const video of dom.mainContainer.querySelectorAll(".work-video-player")) {
      video.muted = state.mediaMuted;
      const muteBtn = video.closest(".work-card")?.querySelector(".video-mute-btn");
      if (muteBtn) muteBtn.innerHTML = state.mediaMuted ? config.icons.mute : config.icons.unmute;
    }
    // 侧栏悬停预览同属全页静音偏好（侧栏无静音按钮，起播时施加、此处同步在播预览）
    sidebar.syncMediaMute();
  }

  // 停止某张卡的悬停预览并复位 UI。卡片任何摘除/降级路径必须先走这里：
  // 元素脱 DOM 后 pointerout 等边界事件永不触发、浏览器也不会自动暂停，
  // 游离的播放中 video 会"画面消失但音频继续"
  #stopPreview(video) {
    const st = this.#videoStates.get(video);
    if (!st) return;
    const card = video.closest(".work-card");
    clearTimeout(st.hoverTimer);
    clearTimeout(video._retryTimer);
    clearTimeout(video._hoverTimeout);
    delete video.dataset.hovered;
    delete video._seeking;
    video.pause();
    video.classList.remove("video-ready");
    st.controls.classList.remove("video-ready");
    const thumb = card?.querySelector(".work-thumb");
    if (thumb) thumb.classList.remove("video-hidden");
    if (card && this.#currentMediaCard === card) this.#currentMediaCard = null;
  }

  stopAllMedia() {
    for (const video of dom.mainContainer.querySelectorAll(".work-video-player")) {
      this.#stopPreview(video);
    }
    this.#currentMediaCard = null;
  }

  // 滚动侧悬停重判（rAF 节流）：指针仍在当前预览卡的媒体框内则保留预览（轻微滚动卡未
  // 移位时不该误停），否则停播。修复「滚动把卡从指针下移走、但无 pointerout 补发 → 预览
  // 继续出声」的残留。仅在有活动预览卡时排程，无预览则零成本返回
  #scheduleHoverRecheck() {
    if (this.#hoverRecheckRaf || !this.#currentMediaCard) return;
    this.#hoverRecheckRaf = requestAnimationFrame(() => {
      this.#hoverRecheckRaf = 0;
      const card = this.#currentMediaCard;
      if (!card) return;
      const el = card.querySelector(".work-media");
      const r = el?.getBoundingClientRect();
      const { x, y } = this.#pointer;
      if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return; // 指针仍在卡上
      const video = card.querySelector(".work-video-player");
      if (video) this.#stopPreview(video);
    });
  }

  // 原地还原骨架：清空媒体区与作者，根节点与 .work-media/.work-info 容器保留
  clearCard(card) {
    // #demote 等摘除媒体子树的路径经此统一停掉预览，防止游离视频残留音频
    const previewVideo = card.querySelector(".work-video-player");
    if (previewVideo) this.#stopPreview(previewVideo);
    card.querySelector(".work-media")?.replaceChildren();
    const author = card.querySelector(".work-author");
    if (author) {
      author.textContent = "";
      author.removeAttribute("href");
    }
    const createTimeEl = card.querySelector(".work-create-time");
    if (createTimeEl) {
      createTimeEl.textContent = "";
      createTimeEl.classList.add("hidden");
    }
    delete card.dataset.videoUrl;
    delete card.dataset.type;
    // 作者域 chip 与勾选框同款：降级即移除（回填时重建），骨架无作者语义
    for (const flag of card.querySelectorAll(".work-author-flag")) flag.remove();
    delete card.dataset.uid;
    // 降级即移除勾选框（骨架无勾选语义，回填时重建）：勾选框若常驻累积，批量模式的
    // 全量勾选框遍历（全选/清除/进出模式）会随浏览量无界增长至秒级卡顿
    card.querySelector(".work-checkbox")?.remove();
  }

  // 批量卡更新（STORE_CHANGED 收口管线 applyStoreUpserts 专用）：updates = [{ awemeId, work }]，
  // work 为调用方持有的合并后记录（免逐条 state.find）。一次 querySelectorAll 建 id→卡映射
  //（O(挂载数)），替代逐条 querySelector + 逐条 state.find 的 O(M×(N+挂载数))——万级 bulk
  // 广播收口的主线程成本集中于此
  updateCardsDOM(updates) {
    if (!updates || updates.length === 0) return;
    const cardById = new Map();
    for (const card of dom.mainContainer.querySelectorAll("[data-aweme-id]")) {
      cardById.set(card.dataset.awemeId, card);
    }
    for (const { awemeId, work } of updates) {
      const card = cardById.get(awemeId);
      if (card) this.#applyCardUpdate(card, work);
    }
  }

  // updateCardsDOM 专用：骨架卡走完整填充管线，完整卡原地部分更新
  #applyCardUpdate(card, work) {
    if (card.classList.contains("work-skeleton")) {
      this.populateItem(card, work);
      return;
    }
    const videoUrl = utils.getVideoUrl(work);
    if (videoUrl) card.dataset.videoUrl = videoUrl;
    const thumb = card.querySelector(".work-thumb");
    const coverUrl = utils.pickCardCover(work);
    if (thumb && coverUrl) this.#enqueueCover(thumb, coverUrl);
    this.#applyInfo(card, work);
  }

  handleClick(event, work, el) {
    // 作者名是外链（作者主页）：Ctrl/Cmd+点击走浏览器默认行为在新标签打开，不进入
    // 侧栏/详情/勾选（两模式一致）；无修饰键时普通点击打开侧边作品栏——批量模式同样
    // 生效，链接点击不参与选中（选中命中区仅为 .work-media 内容区）
    const ctrl = event.ctrlKey || event.metaKey;
    const authorLink = event.target.closest(".work-author");
    if (authorLink) {
      if (ctrl) {
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      sidebar.openSidebar(
        { uid: work.uid, nickname: work.nickname, profileUrl: work.authorHomeUrl },
        el,
      );
      return;
    }
    if (event.target.closest(".work-checkbox")) {
      event.stopPropagation();
      batch.toggleBatchSelect(
        work.awemeId,
        event.target.closest(".work-checkbox"),
        event.shiftKey,
      );
      return;
    }
    if (event.target.closest(".video-mute-btn")) {
      event.stopPropagation();
      // 全页静音偏好：切换任意卡片的静音作用于三域全部卡片预览与详情播放器
      this.#toggleMediaMute();
      return;
    }
    if (event.target.closest(".video-play-btn")) {
      event.stopPropagation();
      const video = el.querySelector(".work-video-player");
      if (video) detail.toggleVideoPlay(video, el.querySelector(".video-play-btn"));
      return;
    }
    // 进度条/控件条内点击不进入详情、也不在批量模式下切换勾选：进度拖拽依赖 input 的
    // 默认行为（批量禁选 mousedown 已排除 input）；播放/静音按钮在上方各自处理后返回
    if (event.target.closest(".work-video-controls")) {
      event.stopPropagation();
      return;
    }
    if (state.batchMode) {
      // 选中命中区 = 卡片内容区（.work-media）；作者/日期所在信息条不改变选中态。
      // 播放/静音/进度控件已在上面各自收口，不会进入这里
      if (event.target.closest(".work-media")) {
        batch.toggleBatchSelect(work.awemeId, el.querySelector(".work-checkbox"), event.shiftKey);
      }
      return;
    }
    detail.openDetail(work.awemeId);
  }

  // 关详情后滚回原卡片：按 awemeId 定位（详情导航以网格已渲染顺序为准，期间网格可能
  // 已重渲、下标不可信）。目标下标取已渲染快照（与挂载卡 DOM 同序），快照缺失才回退视图
  restoreGridScroll(awemeId = null) {
    if (awemeId == null) return;
    const idStr = String(awemeId);
    const view = this.renderedItems() || search.getWorksView();
    const idx = view.findIndex((w) => String(w.awemeId) === idStr);
    if (idx === -1) return;
    requestAnimationFrame(() => {
      const grid = dom.mainGrid;
      // 优先用 DOM 实测位置（全量布局无 CV 跳过，骨架态布局框即真实位置）
      const card = dom.mainContainer.querySelector(`[data-aweme-id="${idStr}"]`);
      if (card) {
        const gridRect = grid.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const cardTopInScroll = cardRect.top - gridRect.top + grid.scrollTop;
        const target = cardTopInScroll - Math.min(grid.clientHeight / 3, cardTopInScroll);
        // 滚动容器是 #mainGrid 自身（overflow-y:auto），对 window 调 scrollTo 不生效
        grid.scrollTo({ top: Math.max(0, target) });
        noteProgrammaticScroll();
        return;
      }
      // 兜底：卡片尚未创建（分块渲染未完成），用数学估算（优先取自适应布局落笔值，
      // 与 CSS 实际轨宽一致；未落笔时回退 CSS 变量旧估算）
      const gap = config.CARD_GAP;
      const layout = this.getGridLayout();
      const cardW = layout
        ? layout.cardW
        : parseInt(getComputedStyle(document.documentElement).getPropertyValue(WORKS_CARD_SIZE_VAR)) ||
          config.CARD_SIZE_FALLBACK;
      const cols = layout
        ? layout.cols
        : Math.max(1, Math.floor((dom.mainContainer.clientWidth + gap) / (cardW + gap)));
      const row = Math.floor(idx / cols);
      const cardH = (cardW * 4) / 3 + config.CARD_HEIGHT_OFFSET;
      const cardTopInScroll = row * (cardH + gap);
      const target = cardTopInScroll - Math.min(grid.clientHeight / 3, cardTopInScroll);
      grid.scrollTo({ top: Math.max(0, target) });
      noteProgrammaticScroll();
    });
  }

  #bindMediaEvents() {
    // pointerenter/leave 不冒泡、无法做容器级委托；用冒泡的 pointerover/out，
    // relatedTarget 仍在同一 .work-media 内部时忽略，实现"跨界只触发一次"。
    // 事件委托绑在 #mainGrid（稳定节点）而非容器上：clearActiveGrid 换壳后无需重绑
    dom.mainGrid.addEventListener("pointerover", (e) => {
      this.#pointer.x = e.clientX;
      this.#pointer.y = e.clientY;
      const media = e.target.closest?.(".work-media");
      if (!media) return;
      if (e.relatedTarget && media.contains(e.relatedTarget)) return;
      const card = media.closest(".work-card");
      if (!card) return;
      if (this.#currentMediaCard === card) return;
      // 先停上一张卡的预览再判模式/弹窗守卫：批量模式、弹窗打开、熔断期间换卡
      // 也必须静音旧视频，否则旧预览只能依赖本委托链清理，漏掉即音频残留
      if (this.#currentMediaCard) {
        const prevVideo = this.#currentMediaCard.querySelector(".work-video-player");
        if (prevVideo) this.#stopPreview(prevVideo);
      }
      if (state.batchMode) return;
      if (!dom.dialogOverlay.classList.contains("hidden")) return;
      if (detail.mediaRetryBlocked()) return;
      const video = card.querySelector(".work-video-player");
      if (!video || !this.#videoStates.has(video)) return;
      const st = this.#videoStates.get(video);
      this.#currentMediaCard = card;
      if (st.hoverTimer) clearTimeout(st.hoverTimer);
      st.hoverTimer = setTimeout(() => {
        // 兜底：悬停延迟窗口内卡片被重建/摘除时，不得在游离节点上起播
        if (!card.isConnected || !video.isConnected) return;
        delete video.dataset.retries;
        video.dataset.hovered = "1";
        video.src = card.dataset.videoUrl || "";
        video.currentTime = 0;
        video.muted = state.mediaMuted;
        st.muteBtn.innerHTML = state.mediaMuted ? config.icons.mute : config.icons.unmute;
        video.load();
        const onCanPlay = () => {
          if (!video.dataset.hovered) return;
          detail.markMediaOk();
          video.classList.add("video-ready");
          st.controls.classList.add("video-ready");
          const thumb = card.querySelector(".work-thumb");
          if (thumb) thumb.classList.add("video-hidden");
          video.play().catch(() => {
            st.timeSpan.textContent = "⚠ 无法播放";
          });
        };
        video.addEventListener("canplay", onCanPlay, { once: true });
        video._hoverTimeout = setTimeout(() => {
          video.removeEventListener("canplay", onCanPlay);
        }, config.VIDEO_FALLBACK_TIMEOUT);
      }, config.HOVER_PREVIEW_DELAY);
    });

    dom.mainGrid.addEventListener("pointerout", (e) => {
      this.#pointer.x = e.clientX;
      this.#pointer.y = e.clientY;
      const media = e.target.closest?.(".work-media");
      if (!media) return;
      if (e.relatedTarget && media.contains(e.relatedTarget)) return;
      const card = media.closest(".work-card");
      if (!card) return;
      if (this.#currentMediaCard !== card) return;
      const video = card.querySelector(".work-video-player");
      if (video) this.#stopPreview(video);
    });
    // 指针坐标保鲜：同一张卡内的移动不跨越 over/out 边界（委托忽略），只有 pointermove
    // 能持续更新——滚动重判悬停必须拿到最新坐标，否则会用入界点误判
    dom.mainGrid.addEventListener(
      "pointermove",
      (e) => {
        this.#pointer.x = e.clientX;
        this.#pointer.y = e.clientY;
      },
      { passive: true },
    );
    // 滚动侧的悬停收口：滚动/布局变化会让卡片从指针下移走，但浏览器不重算 hover、也不补发
    // pointerout（「hover 粘住」），预览就没人停——唯一停靠点是 demote/整窗重挂/页面隐藏。
    // 滚动后按最新指针位置重判（指针已不在预览卡的媒体框内即停播，仍在其内则保留）
    dom.mainGrid.addEventListener("scroll", () => this.#scheduleHoverRecheck(), { passive: true });
    // timeupdate/loadedmetadata/error/play/pause 是媒体事件，不冒泡，无法委托到容器，
    // 已在 fillCard 内经 #bindVideoMediaEvents 直绑到 video 元素（见该方法注释）。
    dom.mainGrid.addEventListener("input", (e) => {
      const slider = e.target;
      if (!slider.matches || !slider.matches(".video-progress")) return;
      const card = slider.closest(".work-card");
      if (!card) return;
      const video = card.querySelector(".work-video-player");
      // 拖拽/点击进度期间冻结 timeupdate 回写（见 #bindVideoMediaEvents），否则播放进度会
      // 反复改写滑块、拖不准；change（松手提交）复位
      if (video) video._seeking = true;
      if (this.#sliderRaf) cancelAnimationFrame(this.#sliderRaf);
      this.#sliderRaf = requestAnimationFrame(() => {
        if (video && video.duration) video.currentTime = (slider.value / 100) * video.duration;
      });
    });
    dom.mainGrid.addEventListener("change", (e) => {
      const slider = e.target;
      if (!slider.matches || !slider.matches(".video-progress")) return;
      const card = slider.closest(".work-card");
      const video = card?.querySelector(".work-video-player");
      if (!video) return;
      delete video._seeking;
      if (video.duration) video.currentTime = (slider.value / 100) * video.duration;
    });
  }

  // 媒体事件（timeupdate/loadedmetadata/error/play/pause）不冒泡，无法走容器级委托，
  // 必须在 video 元素上直绑。fillCard 每次经 media.replaceChildren 重建 video 元素，
  // 故随卡片填充绑定一次即可；旧元素脱离 DOM 后被 GC，不会重复绑定或泄漏。
  #bindVideoMediaEvents(video, st) {
    video.addEventListener("timeupdate", () => {
      // 拖拽进度条期间不回写滑块（拖拽目标优先于播放进度）
      if (video._seeking) return;
      if (video._lastProgressUpdate && Date.now() - video._lastProgressUpdate < 250) return;
      video._lastProgressUpdate = Date.now();
      detail.updateVideoProgress(video, st.progress, st.timeSpan, "0.3");
    });
    video.addEventListener("loadedmetadata", () => {
      st.timeSpan.textContent = `0:00 / ${detail.formatTime(video.duration)}`;
    });
    video.addEventListener("error", () => {
      detail.handleVideoError(video, {
        onMax: () => { st.timeSpan.textContent = "⚠ 链接失效"; },
        onRetry: (retries, delay) => {
          st.timeSpan.textContent = delay > 0 ? `⏳ 重试(${retries + 1})…` : "⏳ 重试…";
        },
      });
    });
    video.addEventListener("play", () => {
      clearTimeout(video._retryTimer);
      st.playBtn.innerHTML = config.icons.pause;
    });
    video.addEventListener("pause", () => {
      st.playBtn.innerHTML = config.icons.play;
    });
  }

  // 封面代际自增：updateCardsDOM 会复用同一节点再次入队，作废在途探针的乱序回填
  #enqueueCover(img, url) {
    const gen = String((Number(img.dataset.coverGen) || 0) + 1);
    img.dataset.coverGen = gen;
    this.#probeQueue.enqueue({ img, url, gen });
  }

  // 赋 src 前置三态：thumb 先透明，露出 .work-media 渐变占位底
  #stageThumb(thumb) {
    thumb.classList.add("media-loading");
  }
}

export const worksGrid = new WorksGrid({
  emptyMsg: "还没有保存的作品",
  emptyHint: "浏览抖音时，作品会自动被捕获",
});
export const favoritesGrid = new WorksGrid({
  emptyMsg: "还没有同步的点赞作品",
  emptyHint: "点击菜单「同步」拉取本账户的点赞列表",
});
export const collectionsGrid = new WorksGrid({
  emptyMsg: "还没有同步的收藏作品",
  emptyHint: "点击菜单「同步」拉取本账户的收藏列表",
});
// 回顾域作品批次：复用作品卡与详情播放器，itemKey 仍为源作品 awemeId
export const reviewWorksGrid = new WorksGrid({
  emptyMsg: "还没有回顾批次",
  emptyHint: "点击「重新配置」从任意域随机抽取一批数据",
});
