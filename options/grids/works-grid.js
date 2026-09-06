// ---------- WorksGrid（作品/点赞/收藏三域共用） ----------
import { config, dom, state, utils, services, store } from '../core.js';
import { VirtualGrid } from './virtual-grid.js';
import { search } from '../components/search-bar.js';
import { batch } from '../data/batch.js';
import { detail } from '../components/detail.js';

// ---------- WorksGrid ----------
export class WorksGrid extends VirtualGrid {
  #sliderRaf = 0;
  #container = dom.mainContainer;
  #workCardTmpl = document.getElementById("workCardTemplate");
  #coverQueue = [];
  #coverDrainRafId = 0;
  #videoStates = new WeakMap();
  #currentMediaCard = null;
  #emptyMsg;
  #emptyHint;
  constructor({ emptyMsg, emptyHint } = {}) {
    super({
      container: dom.mainContainer,
      itemClass: "work-card",
      skeletonClass: "work-skeleton",
      itemKey: "awemeId",
      emptyMsg,
      emptyHint,
    });
    // 空态文案按实例区分（作品/点赞/收藏域文案不同）
    this.#emptyMsg = emptyMsg || "还没有保存的作品";
    this.#emptyHint = emptyHint || "浏览抖音时，作品会自动被捕获";
    this.#bindMediaEvents();
  }

  renderCards() {
    // 渲染取过滤后的视图列表（建议5）；筛选生效时空态文案区分"无数据"与"无匹配"
    const view = search.getWorksView();
    if (search.isFilterActive()) {
      this.render(view, "没有符合筛选条件的作品", "调整关键词或筛选条件后重试");
    } else {
      this.render(view, this.#emptyMsg, this.#emptyHint);
    }
  }

  // 原地填充：骨架根节点保留，媒体区/操作按钮从完整模板取新节点移入
  fillCard(card, work) {
    const fresh = this.#workCardTmpl.content.cloneNode(true).firstElementChild;
    card.classList.remove(this.skeletonClass);
    card.dataset.awemeId = work.awemeId;

    const media = card.querySelector(".work-media");
    media.replaceChildren(...fresh.querySelector(".work-media").childNodes);

    const title = card.querySelector(".work-title");
    title.querySelectorAll(".work-action-btn").forEach((btn) => btn.remove());
    // 单条同步按钮仅作品域注入（SYNC_WORKS 写 works store）；下载按钮四域通用
    if (state.domain === "works") {
      title.append(...fresh.querySelectorAll(".work-action-btn"));
    } else {
      title.append(
        ...[...fresh.querySelectorAll(".work-action-btn")].filter((b) => b.title !== "同步"),
      );
    }

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
      checkbox.tabIndex = 0;
      checkbox.setAttribute("aria-checked", "false");
      checkbox.setAttribute("aria-label", "选择作品");
      card.querySelector(".work-media").after(checkbox);
    }
    const titleText = card.querySelector(".work-title-text");

    badge.classList.toggle("hidden", work.type === "video");
    if (work.type === "note") {
      video.style.display = "none";
      controls.style.display = "none";
    }

    batch.updateCheckboxDOM(checkbox, state.selectedIds.has(work.awemeId));
    checkbox.style.display = state.batchMode ? "" : "none";

    if (work.type === "video" && utils.getVideoUrl(work)) {
      const videoSrc = utils.getVideoUrl(work);
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
      this.#bindVideoMediaEvents(video, st);
    } else if (work.type === "note") {
      const imgUrl = utils.pickHttpsUrl(work.images?.[0] || work.cover || "");
      this.#stageThumb(thumb);
      if (imgUrl) this.#enqueueCover(thumb, imgUrl);
    }

    titleText.textContent = work.desc || "无文案";
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
    video.pause();
    video.classList.remove("video-ready");
    st.controls.classList.remove("video-ready");
    const thumb = card?.querySelector(".work-thumb");
    if (thumb) thumb.classList.remove("video-hidden");
    if (card && this.#currentMediaCard === card) this.#currentMediaCard = null;
  }

  stopAllMedia() {
    for (const video of this.#container.querySelectorAll(".work-video-player")) {
      this.#stopPreview(video);
    }
    this.#currentMediaCard = null;
  }

  // 原地还原骨架：清空媒体区与标题，根节点与 .work-media/.work-title 容器保留
  clearCard(card) {
    // #demote 等摘除媒体子树的路径经此统一停掉预览，防止游离视频残留音频
    const previewVideo = card.querySelector(".work-video-player");
    if (previewVideo) this.#stopPreview(previewVideo);
    card.querySelector(".work-media")?.replaceChildren();
    card.querySelectorAll(".work-action-btn").forEach((btn) => btn.remove());
    const titleText = card.querySelector(".work-title-text");
    if (titleText) titleText.textContent = "";
    delete card.dataset.videoUrl;
    const checkbox = card.querySelector(".work-checkbox");
    if (checkbox) {
      batch.updateCheckboxDOM(checkbox, false);
      checkbox.style.display = state.batchMode ? "" : "none";
    }
  }

  updateCardDOM(awemeId) {
    const card = dom.mainContainer.querySelector(`[data-aweme-id="${awemeId}"]`);
    if (!card) return;
    const work = state.works.find((w) => w.awemeId === awemeId);
    if (!work) return;
    if (card.classList.contains("work-skeleton")) {
      this.populateItem(card, work);
      return;
    }
    const videoUrl = utils.getVideoUrl(work);
    if (videoUrl) card.dataset.videoUrl = videoUrl;
    const thumb = card.querySelector(".work-thumb");
    const coverUrl = work.cover ? utils.pickHttpsUrl(work.cover) : "";
    if (thumb && coverUrl) this.#enqueueCover(thumb, coverUrl);
    const title = card.querySelector(".work-title-text");
    if (title) title.textContent = work.desc || "无文案";
  }

  handleClick(event, work, el) {
    if (event.target.closest(".work-checkbox")) {
      event.stopPropagation();
      batch.toggleBatchSelect(work.awemeId, event.target.closest(".work-checkbox"), event.shiftKey);
      return;
    }
    if (event.target.closest(".video-mute-btn")) {
      event.stopPropagation();
      const video = el.querySelector(".work-video-player");
      if (video) detail.toggleVideoMute(video, el.querySelector(".video-mute-btn"));
      return;
    }
    if (event.target.closest(".video-play-btn")) {
      event.stopPropagation();
      const video = el.querySelector(".work-video-player");
      if (video) detail.toggleVideoPlay(video, el.querySelector(".video-play-btn"));
      return;
    }
    if (event.target.closest('.work-action-btn[title="同步"]')) {
      event.stopPropagation();
      const btn = event.target.closest(".work-action-btn");
      this.#handleWorkSync(btn, work.awemeId);
      return;
    }
    if (event.target.closest('.work-action-btn[title="下载"]')) {
      detail.downloadWork(work);
      return;
    }
    if (state.batchMode) {
      batch.toggleBatchSelect(work.awemeId, el.querySelector(".work-checkbox"), event.shiftKey);
      return;
    }
    detail.openDetail(work.awemeId);
  }

  async #handleWorkSync(btn, awemeId) {
    // 单条同步仅作品域有意义（SYNC_WORKS 写 works store）；点赞/收藏域卡片不注入同步按钮
    if (state.domain !== "works") return;
    btn.disabled = true;
    btn.classList.add("work-syncing");
    try {
      const newWork = await services.refreshSingleWork(awemeId);
      if (newWork) {
        store.updateWork(awemeId, newWork);
      }
    } catch {}
    btn.classList.remove("work-syncing");
    btn.disabled = false;
  }

  restoreGridScroll() {
    const idx = detail.getDetailIndex();
    const view = search.getWorksView();
    if (idx < 0 || idx >= view.length) return;
    requestAnimationFrame(() => {
      const grid = dom.mainGrid;
      if (!grid) return;
      const root = getComputedStyle(document.documentElement);
      const cardW = parseInt(root.getPropertyValue("--dy-card-size")) || config.CARD_SIZE_FALLBACK;
      const gap = config.CARD_GAP;
      const cols = Math.max(1, Math.floor((grid.clientWidth + gap) / (cardW + gap)));
      const row = Math.floor(idx / cols);
      const cardH = (cardW * 4) / 3 + config.CARD_HEIGHT_OFFSET;
      const target = row * (cardH + gap) - Math.min(window.innerHeight / 3, row * (cardH + gap));
      window.scrollTo({ top: Math.max(0, target) });
    });
  }

  #bindMediaEvents() {
    // pointerenter/leave 不冒泡、无法做容器级委托；用冒泡的 pointerover/out，
    // relatedTarget 仍在同一 .work-media 内部时忽略，实现"跨界只触发一次"
    this.#container.addEventListener("pointerover", (e) => {
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
        video.muted = false;
        st.muteBtn.innerHTML = config.icons.unmute;
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

    this.#container.addEventListener("pointerout", (e) => {
      const media = e.target.closest?.(".work-media");
      if (!media) return;
      if (e.relatedTarget && media.contains(e.relatedTarget)) return;
      const card = media.closest(".work-card");
      if (!card) return;
      if (this.#currentMediaCard !== card) return;
      const video = card.querySelector(".work-video-player");
      if (video) this.#stopPreview(video);
    });
    // timeupdate/loadedmetadata/error/play/pause 是媒体事件，不冒泡，无法委托到容器，
    // 已在 fillCard 内经 #bindVideoMediaEvents 直绑到 video 元素（见该方法注释）。
    this.#container.addEventListener("input", (e) => {
      const slider = e.target;
      if (!slider.matches || !slider.matches(".video-progress")) return;
      const card = slider.closest(".work-card");
      if (!card) return;
      const video = card.querySelector(".work-video-player");
      if (this.#sliderRaf) cancelAnimationFrame(this.#sliderRaf);
      this.#sliderRaf = requestAnimationFrame(() => {
        if (video && video.duration) video.currentTime = (slider.value / 100) * video.duration;
      });
    });
  }

  // 媒体事件（timeupdate/loadedmetadata/error/play/pause）不冒泡，无法走容器级委托，
  // 必须在 video 元素上直绑。fillCard 每次经 media.replaceChildren 重建 video 元素，
  // 故随卡片填充绑定一次即可；旧元素脱离 DOM 后被 GC，不会重复绑定或泄漏。
  #bindVideoMediaEvents(video, st) {
    video.addEventListener("timeupdate", () => {
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

  // 封面代际自增：updateCardDOM 会复用同一节点再次入队，作废在途探针的乱序回填
  #enqueueCover(img, url) {
    const gen = String((Number(img.dataset.coverGen) || 0) + 1);
    img.dataset.coverGen = gen;
    this.#coverQueue.push({ img, url, gen });
    this.#scheduleCoverDrain();
  }

  // 探针预载：成功才提交背景图（div 无裂图载体）；失败原样重试一次，仍失败停留透明占位态
  #scheduleCoverDrain() {
    if (this.#coverDrainRafId) return;
    this.#coverDrainRafId = requestAnimationFrame(() => {
      this.#coverDrainRafId = 0;
      let n = 0;
      while (this.#coverQueue.length && n < config.SIDEBAR_IMG_PER_FRAME) {
        const { img, url, gen } = this.#coverQueue.shift();
        const alive = () => img.isConnected && img.dataset.coverGen === gen;
        const commit = () => {
          if (!alive()) return;
          detail.markMediaOk();
          img.style.backgroundImage = `url("${url.replace(/["\\]/g, "\\$&")}")`;
          img.classList.remove("media-loading");
        };
        const fail = () => {
          if (!alive()) return;
          detail.markMediaFail();
          // dataset.retry 挂在可见节点上，随重填换新节点自然复位；熔断冷却中不重试
          if (img.dataset.retry || detail.mediaRetryBlocked()) return;
          img.dataset.retry = "1";
          const retryProbe = new Image();
          retryProbe.onload = commit;
          retryProbe.onerror = fail;
          retryProbe.src = url;
        };
        const probe = new Image();
        probe.onload = commit;
        probe.onerror = fail;
        probe.src = url;
        n++;
      }
      if (this.#coverQueue.length) this.#scheduleCoverDrain();
    });
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
export const likesGrid = new WorksGrid({
  emptyMsg: "还没有同步的点赞作品",
  emptyHint: "点击菜单「同步」拉取本账户的点赞列表",
});
export const favoritesGrid = new WorksGrid({
  emptyMsg: "还没有同步的收藏作品",
  emptyHint: "点击菜单「同步」拉取本账户的收藏列表",
});
