// ---------- Detail ----------
import { config, dom, state, utils, services, store } from '../core.js';
import { search } from './search-bar.js';
import { dialog } from './dialog.js';
import { worksGrid } from '../grids/works-grid.js';

// ---------- Detail ----------
export class Detail {
  #index = -1;
  #cleanups = [];
  #loopMode = "single";
  #detailListenersAttached = false;
  #noteWork = null;
  #noteImgIndex = 0;
  #noteAutoPlayTimer = null;
  #detailSliderRaf = 0;
  #noteIsPlaying = false;
  #mediaFailCount = 0;
  #mediaLastFailAt = 0;
  #mediaBreakUntil = 0;
  #imgProbeToken = 0;
  #bgProbeToken = 0;
  #rmQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  #reduceMotion() {
    return this.#rmQuery.matches;
  }
  #noteShowImage(idx) {
    this.#noteImgIndex = idx;
    const img = dom.detailImage;
    // 淡出当前图片
    img.style.opacity = '0';
    requestAnimationFrame(() => {
      const url = utils.pickHttpsUrl(this.#noteWork.images[this.#noteImgIndex])
        || utils.pickHttpsUrl(this.#noteWork.cover)
        || "";
      // 探针先行：失败 URL 不落可见节点（裂图无载体），失败时恢复显示上一张
      const token = ++this.#imgProbeToken;
      if (!url) {
        img.style.opacity = '1';
        return;
      }
      const probe = new Image();
      probe.onload = () => {
        if (token !== this.#imgProbeToken) return;
        this.markMediaOk();
        img.addEventListener('load', () => { img.style.opacity = '1'; }, { once: true });
        img.src = url;
      };
      probe.onerror = () => {
        if (token !== this.#imgProbeToken) return;
        this.markMediaFail();
        img.style.opacity = '1';
      };
      probe.src = url;
    });
    this.#updateCounters(this.#noteWork);
  }
  #noteStartAutoPlay() {
    const AUTO_PLAY_INTERVAL = config.NOTE_AUTO_PLAY_INTERVAL;
    this.#noteStopAutoPlay();
    const tick = () => {
      this.#noteAutoPlayTimer = setTimeout(() => {
        if (this.#noteImgIndex < this.#noteWork.images.length - 1) {
          this.#noteShowImage(this.#noteImgIndex + 1);
          tick();
        } else {
          const mode = this.nextOnEnd();
          if (mode === "single") {
            this.#noteShowImage(0);
            tick();
          } else if (mode === "group") {
            this.renderDetail();
          } else {
            this.#noteIsPlaying = false;
            this.#noteUpdatePlayBtn();
          }
        }
      }, AUTO_PLAY_INTERVAL);
    };
    tick();
  }
  #noteStopAutoPlay() {
    if (this.#noteAutoPlayTimer) {
      clearTimeout(this.#noteAutoPlayTimer);
      this.#noteAutoPlayTimer = null;
    }
  }
  #noteUpdatePlayBtn() {
    if (this.#noteIsPlaying) {
      dom.detailPlayBtn.innerHTML = config.icons.pause;
      const label = "暂停轮播";
      dom.detailPlayBtn.title = label;
      dom.detailPlayBtn.setAttribute("aria-label", label);
    } else {
      dom.detailPlayBtn.innerHTML = config.icons.play;
      const label = "自动播放";
      dom.detailPlayBtn.title = label;
      dom.detailPlayBtn.setAttribute("aria-label", label);
    }
  }
  #toggleNoteAutoPlay() {
    const audio = dom.detailAudio;
    if (this.#noteIsPlaying) {
      this.#noteStopAutoPlay();
      audio?.pause();
      this.#noteIsPlaying = false;
    } else {
      this.#noteStartAutoPlay();
      audio?.play().catch(() => {});
      this.#noteIsPlaying = true;
    }
    this.#noteUpdatePlayBtn();
  }

  #toggleNoteMute() {
    const audio = dom.detailAudio;
    if (!audio) return;
    audio.muted = !audio.muted;
    dom.detailMuteBtn.innerHTML = audio.muted ? config.icons.mute : config.icons.unmute;
    const label = audio.muted ? "取消静音" : "静音";
    dom.detailMuteBtn.title = label;
    dom.detailMuteBtn.setAttribute("aria-label", label);
  }

  static MIME_EXT = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
  };

  // Detail 导航与网格共用同一过滤视图（建议5）：详情内翻页只在可见条目间进行
  openDetailIndex(awemeId) {
    const list = search.getWorksView();
    const idx = list.findIndex((w) => w.awemeId === awemeId);
    if (idx === -1) return null;
    this.#index = idx;
    return list[idx];
  }

  getCurrentWork() {
    return search.getWorksView()[this.#index] || null;
  }

  closeDetailIndex() {
    this.runCleanups();
    this.#index = -1;
  }

  nextDetailIndex() {
    if (this.#index < search.getWorksView().length - 1) {
      this.#index++;
      return this.getCurrentWork();
    }
    return null;
  }

  prevDetailIndex() {
    if (this.#index > 0) {
      this.#index--;
      return this.getCurrentWork();
    }
    return null;
  }

  getDetailIndex() {
    return this.#index;
  }

  addCleanup(fn) {
    this.#cleanups.push(fn);
  }

  runCleanups() {
    for (const fn of this.#cleanups.splice(0)) {
      try {
        fn();
      } catch (e) {}
    }
  }

  cycleLoopMode() {
    if (this.#loopMode === "single") {
      this.#loopMode = "group";
    } else if (this.#loopMode === "group") {
      this.#loopMode = "off";
    } else {
      this.#loopMode = "single";
    }
    return this.#loopMode;
  }

  nextOnEnd() {
    if (this.#loopMode === "single") return "single";
    const total = search.getWorksView().length;
    if (this.#loopMode === "group" && total > 1) {
      if (this.#index < total - 1) {
        this.#index++;
      } else {
        this.#index = 0;
      }
      return "group";
    }
    return "off";
  }

  async removeWork(awemeId) {
    // 作品型三域按当前域删除本地记录（点赞/收藏域仅删本地，远端取消走批量入口）
    if (config.WORK_LIKE_DOMAINS.includes(state.domain)) {
      await services.deleteWorkLike(state.domain, [awemeId]);
      state[state.domain] = state[state.domain].filter((w) => w.awemeId !== awemeId);
      state.selectedIds.delete(awemeId);
      search.activeWorkLikeGrid().removeItems(new Set([awemeId]));
      store.refreshGroups();
      search.syncCount();
      return;
    }
    await services.bgMsg({ type: "DELETE_WORKS", awemeIds: [awemeId] });
    state.selectedIds.delete(awemeId);
    const idx = state.works.findIndex((w) => w.awemeId === awemeId);
    store.spliceWork(idx);
  }

  async syncWork(awemeId) {
    return services.refreshSingleWork(awemeId);
  }

  updateLoopBtn(isVideo) {
    if (this.#loopMode === "single") {
      dom.detailLoopBtn.innerHTML = config.icons.loopSingle;
      dom.detailLoopBtn.title = isVideo ? "单作品循环" : "幻灯片循环";
    } else if (this.#loopMode === "group") {
      dom.detailLoopBtn.innerHTML = config.icons.loopGroup;
      dom.detailLoopBtn.title = "分组循环";
    } else {
      dom.detailLoopBtn.innerHTML = config.icons.noLoop;
      dom.detailLoopBtn.title = "不循环";
    }
    dom.detailLoopBtn.setAttribute("aria-label", dom.detailLoopBtn.title);
  }

  // ===== 详情层 UI 增强（docs/UI_IMPROVEMENTS.md 建议10-21）=====

  // 计数展示：底栏时间位显示媒体指示——视频为播放时间（updateVideoProgress 维护），
  // 图片类型/图集为 [K/N] 图片页序；底栏最右端仍为作品序号
  #updateCounters(work) {
    const total = search.getWorksView().length;
    // 底栏时间位：图片类型显示 [K/N]（视频在此位显示播放时间，不由此处写入）
    if (work.type === "note" && work.images?.length) {
      dom.detailTime.textContent = `${this.#noteImgIndex + 1}/${work.images.length}`;
    }
    // 底栏右侧：作品序号
    if (total > 1) {
      dom.detailCounter.textContent = `${this.getDetailIndex() + 1} / ${total}`;
      dom.detailCounter.classList.remove("hidden");
    } else {
      dom.detailCounter.classList.add("hidden");
    }
  }

  // 加载指示复位（建议17）
  #resetMediaStatus(isVideo) {
    dom.detailLoader.classList.toggle("hidden", !isVideo);
  }

  // 背景虚化的健壮提交：候选 URL 逐个探针，成功才写入 --bg-url（带引号转义）；
  // 全部失效或本件无可用封面时降级为统一深色底（--bg-url:none），绝不回退到上一件作品的模糊封面。
  // 直接给 CSS 背景塞失效链接会静默变成纯黑——note 类型"虚化丢失"的根源即此。
  #applyDetailBg(candidates) {
    const urls = [...new Set(candidates.map((u) => utils.pickHttpsUrl(u || "")).filter(Boolean))];
    if (!urls.length) {
      dom.detailOverlay.style.setProperty("--bg-url", "none");
      return;
    }
    const token = ++this.#bgProbeToken;
    const commit = (u) => {
      const escaped = u.replace(/["\\]/g, "\\$&");
      const newUrl = `url("${escaped}")`;
      if (dom.detailOverlay.style.getPropertyValue("--bg-url") !== newUrl) {
        dom.detailOverlay.style.setProperty("--bg-url", newUrl);
      }
    };
    const tryNext = (i) => {
      if (token !== this.#bgProbeToken) return;
      if (i >= urls.length) {
        // 全部失效：统一深色底，不沿用上一件成功封面
        dom.detailOverlay.style.setProperty("--bg-url", "none");
        return;
      }
      const probe = new Image();
      probe.onload = () => {
        if (token !== this.#bgProbeToken) return;
        this.markMediaOk();
        commit(urls[i]);
      };
      probe.onerror = () => {
        if (token !== this.#bgProbeToken) return;
        tryNext(i + 1);
      };
      probe.src = urls[i];
    };
    tryNext(0);
  }

  // 焦点是否落在可交互控件上（按钮/输入框/链接/滑块/文本域）：是则放行原生键盘行为
  #isInteractiveTarget(target) {
    return (
      target instanceof Element &&
      !!target.closest("button, input, a[href], textarea, select")
    );
  }

  // F 全屏：按当前可见媒体类型选择全屏容器（视频区 / 大图容器）
  #toggleFullscreen() {
    const isVideo = !dom.detailVideoContainer.classList.contains("hidden");
    const target = isVideo ? dom.detailVideoContainer : dom.detailImageContainer;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      target.requestFullscreen?.().catch(() => {});
    }
  }

  // Tab 焦点圈定（建议21）：焦点在 overlay 内循环。
  // 可见性用 rects 判断而非 offsetParent——fixed 定位元素（如右上关闭钮）的 offsetParent 恒为 null
  #trapFocus(e) {
    const focusables = [...dom.detailOverlay.querySelectorAll("button, input, a[href]")]
      .filter((el) => el.getClientRects().length > 0);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    const inside = dom.detailOverlay.contains(active);
    if (e.shiftKey && (!inside || active === first)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (!inside || active === last)) {
      e.preventDefault();
      first.focus();
    }
  }

  async openDetail(awemeId) {
    const work = this.openDetailIndex(awemeId);
    if (!work) return;
    // 单条同步仅作品域有意义（SYNC_WORKS 写 works store）；点赞/收藏域隐藏该按钮
    const isWorkLikeNonWorks =
      config.WORK_LIKE_DOMAINS.includes(state.domain) && state.domain !== "works";
    dom.detailSyncBtn.classList.toggle("hidden", isWorkLikeNonWorks);
    dom.detailOverlay.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    this.renderDetail();
  }

  // dir: 1 下一作品 / -1 上一作品 / 0 无方向（首次打开或循环回跳），驱动建议15的方向感过渡
  renderDetail(dir = 0) {
    const isSwitch = !dom.detailOverlay.classList.contains("hidden");
    const body = dom.detailBody || document.querySelector(".detail-body");
    if (isSwitch) {
      body.classList.add("detail-transitioning");
    }
    // 方向感入场（建议15）：先清旧类再强制 reflow，保证同向连续切换也能重放动画；
    // prefers-reduced-motion 时跳过位移，只保留容器淡入（CSS 侧已把动画压到不可感知）
    body.classList.remove("enter-down", "enter-up");
    if (dir !== 0 && !this.#reduceMotion()) {
      void body.offsetWidth;
      body.classList.add(dir > 0 ? "enter-down" : "enter-up");
    }
    this.#transitionToNext(body, isSwitch);
  }

  #transitionToNext(body, isSwitch) {
    // 等待淡出完成
    const doRender = () => {
      this.runCleanups();
      const work = this.getCurrentWork();
      if (!work) return this.closeDetail();

      // 切作品先复位背景为统一深色底，避免探针完成前残留上一件作品的模糊封面
      dom.detailOverlay.style.setProperty("--bg-url", "none");

      const isVideo = work.type === "video" && utils.getVideoUrl(work);
      if (isVideo) {
        this.resetAudio();
      } else {
        this.resetMediaElements();
      }

      const bgUrl = work.cover || work.images?.[0] || "";
      if (bgUrl) {
        // 候选链探测：封面优先、图集各帧兜底；全部失效时降级为统一深色底（见 #applyDetailBg）
        this.#applyDetailBg([work.cover, ...(work.images || [])]);
      }

      const isNote = work.type === "note" && work.images?.length > 0;

      dom.detailPlayBtn.style.display = "";
      dom.detailMuteBtn.style.display = "";

      dom.detailVideoContainer.classList.toggle("hidden", !isVideo);
      dom.detailImageContainer.classList.toggle("hidden", !isNote && (isVideo || !work.cover));
      dom.detailProgressSlider.classList.toggle("hidden", !isVideo);

      // 导航箭头已上移至 .detail-body 直下（不随媒体容器切换动效），可见性须在此显式管理：
      // 仅多图图集出现，视频/单图路径不再依赖容器 hidden 连带隐藏
      const hasNoteNav = isNote && work.images.length > 1;
      dom.detailNavLeft.classList.toggle("hidden", !hasNoteNav);
      dom.detailNavRight.classList.toggle("hidden", !hasNoteNav);

      if (isVideo) {
        dom.detailTime.textContent = "0:00 / 0:00";
      } else {
        // 图片类型的时间位由 #updateCounters 写入 [K/N]，此处先清空避免残留
        dom.detailTime.textContent = "";
      }

      if (work.authorHomeUrl) {
        dom.detailAuthor.textContent = `@${work.nickname || "未知作者"}`;
        dom.detailAuthor.href = work.authorHomeUrl;
        dom.detailAuthor.title = "打开作者主页";
        dom.detailAuthor.classList.remove("hidden");
      } else {
        dom.detailAuthor.classList.add("hidden");
      }

      const typePath = work.type === "note" ? "note" : "video";
      dom.detailTitle.href = `${config.URL_BASE}/${typePath}/${work.awemeId}`;
      dom.detailTitle.textContent = (work.desc || "无作品描述").slice(0, config.DETAIL_TITLE_MAX_LEN);
      dom.detailTitle.title = "在抖音打开作品页";

      this.updateLoopBtn(isVideo);

      this.#updateCounters(work);
      this.#resetMediaStatus(isVideo);

      const onReady = () => {
        body.classList.remove("detail-transitioning");
      };

      if (isVideo) {
        this.renderDetailVideo(work, onReady);
      } else if (isNote) {
        this.renderDetailNote(work, onReady);
      } else if (work.cover) {
        dom.detailPlayBtn.style.display = "none";
        dom.detailMuteBtn.style.display = "none";
        // 切到新作品先清空上个作品的图，避免链接失效时残留上一作品内容
        this.#clearDetailImage();
        // 探针先行：失败不落可见节点；onReady 在探针落定后触发，不再先于加载结束过渡
        const token = ++this.#imgProbeToken;
        const probe = new Image();
        probe.onload = () => {
          if (token !== this.#imgProbeToken) return;
          this.markMediaOk();
          dom.detailImage.src = work.cover;
          onReady();
        };
        probe.onerror = () => {
          if (token !== this.#imgProbeToken) return;
          this.markMediaFail();
          // 链接失效：保持清空并显示失效态，绝不回退到上一个作品
          this.#showImageFailed();
          onReady();
        };
        probe.src = work.cover;
      } else {
        this.#clearDetailImage();
        onReady();
      }

      // 安全兜底：10 秒后强制结束过渡（防止网络异常卡死）
      if (isSwitch) {
        setTimeout(() => {
          body.classList.remove("detail-transitioning");
        }, 10000);
      }
    };

    if (isSwitch) {
      requestAnimationFrame(() => {
        requestAnimationFrame(doRender);
      });
    } else {
      doRender();
    }
  }

  renderDetailVideo(work, onReady) {
    const video = dom.detailVideo;
    const readyFn = () => { if (onReady) onReady(); };
    video.src = utils.getVideoUrl(work);

    // 加载指示（建议17）：canplay 前亮 spinner
    dom.detailLoader.classList.remove("hidden");

    dom.detailMuteBtn.innerHTML = video.muted ? config.icons.mute : config.icons.unmute;

    // 视频可播放时结束过渡
    let readyFired = false;
    const fireReady = () => {
      if (readyFired) return;
      readyFired = true;
      readyFn();
    };
    // 仅在真实加载成功时复位熔断；error 路径也会调 fireReady，不能顺带 markMediaOk
    const fireLoaded = () => {
      this.markMediaOk();
      dom.detailLoader.classList.add("hidden");
      fireReady();
    };
    video.addEventListener("canplay", fireLoaded, { once: true });
    video.addEventListener("loadedmetadata", fireLoaded, { once: true });

    video.play().catch((err) => {
      if (err.name === "NotAllowedError") {
        video.muted = true;
        dom.detailMuteBtn.innerHTML = config.icons.mute;
        video.play().catch(() => {});
      }
      // 播放失败也算准备完成，避免卡死
      fireReady();
    });

    video.onerror = () => {
      fireReady();
      this.handleVideoError(video, {
        onMax: () => {
          dom.detailLoader.classList.add("hidden");
          dom.detailPlayBtn.innerHTML = config.icons.play;
          dom.detailPlayBtn.title = "链接失效";
          dom.detailPlayBtn.setAttribute("aria-label", "链接失效");
        },
        onRetry: (retries, delay) => {
          dom.detailPlayBtn.innerHTML = config.icons.play;
          dom.detailPlayBtn.title = delay > 0 ? `重试(${retries + 1})` : "重试";
        },
      });
    };
    this.addCleanup(() => clearTimeout(video._retryTimer));

    dom.detailPlayBtn.innerHTML = config.icons.pause;

    const slider = dom.detailProgressSlider;
    slider.value = 0;
    slider.style.background = "linear-gradient(to right, #fff 0%, rgba(255,255,255,0.2) 0%)";
  }

  renderDetailNote(work, onReady) {
    this.#noteWork = work;
    this.#noteImgIndex = 0;
    this.#noteAutoPlayTimer = null;
    this.#noteIsPlaying = false;
    const img = dom.detailImage;
    const audio = dom.detailAudio;

    const readyFn = () => { if (onReady) onReady(); };
    // 图片加载完成时结束过渡
    let readyFired = false;
    const fireReady = () => {
      if (readyFired) return;
      readyFired = true;
      readyFn();
    };
    img.alt = "";
    // 切到新作品先清空上个作品的图，避免链接失效时残留上一作品内容
    this.#clearDetailImage();
    // 先加载 cover：网格卡已加载过同一 cover 大概率命中缓存，探针通过即先落为占位，
    // 再换高清首帧。候选去重防 cover 与首帧同 URL 重复加载；全部失败才进失效态。
    // 期间 img 无 src 不写 alt，杜绝中央区闪现作品标题文本（见 #clearDetailImage）
    const candidates = [...new Set([
      utils.pickHttpsUrl(work.cover || ""),
      utils.pickHttpsUrl(work.images?.[0] || ""),
    ].filter(Boolean))];
    if (!candidates.length) {
      this.#showImageFailed();
      fireReady();
    } else {
      const token = ++this.#imgProbeToken;
      const loadUrl = (url) => {
        // 无障碍标注在图片真正加载成功后才落，避免失效时以文本展示标题
        img.addEventListener("load", () => { img.alt = work.desc || ""; }, { once: true });
        img.addEventListener("load", fireReady, { once: true });
        img.addEventListener("error", fireReady, { once: true });
        img.src = url;
      };
      const tryCandidate = (i) => {
        if (i >= candidates.length) {
          // 全部失效：保持清空并显示失效态，绝不回退到上一个作品
          this.markMediaFail();
          this.#showImageFailed();
          fireReady();
          return;
        }
        const probe = new Image();
        probe.onload = () => {
          if (token !== this.#imgProbeToken) return;
          this.markMediaOk();
          loadUrl(candidates[i]);
        };
        probe.onerror = () => {
          if (token !== this.#imgProbeToken) return;
          // 单条候选失效不计数，整体失效兜底分支才 markMediaFail
          tryCandidate(i + 1);
        };
        probe.src = candidates[i];
      };
      tryCandidate(0);
    }

    // 图集/作品计数统一走计数展示逻辑（底栏 [K/N] 图片页序 + 作品序号）
    this.#updateCounters(work);

    if (work.music) {
      audio.src = utils.pickHttpsUrl(work.music);

      dom.detailMuteBtn.innerHTML = audio.muted ? config.icons.mute : config.icons.unmute;

      audio.play().catch((err) => {
        if (err.name === "NotAllowedError") {
          audio.muted = true;
          dom.detailMuteBtn.innerHTML = config.icons.mute;
          audio.play().catch(() => {});
        }
      });
    } else {
      dom.detailMuteBtn.style.display = "none";
    }

    this.#noteIsPlaying = true;
    this.#noteStartAutoPlay();
    this.#noteUpdatePlayBtn();

    this.addCleanup(() => this.#noteStopAutoPlay());
  }

  initDetailEvents() {
    if (this.#detailListenersAttached) return;
    this.#detailListenersAttached = true;

    dom.detailOverlay.addEventListener(
      "wheel",
      (e) => {
        if (e.deltaY > 0) this.nextDetail();
        else this.prevDetail();
      },
      { passive: true },
    );

    document.addEventListener("keydown", (e) => {
      if (dom.detailOverlay.classList.contains("hidden")) return;
      // Tab 焦点圈定（建议21）
      if (e.key === "Tab") {
        this.#trapFocus(e);
        return;
      }
      if (e.key === "Escape") {
        this.closeDetail();
        return;
      }
      const work = this.getCurrentWork();
      if (e.key === "ArrowUp") {
        e.preventDefault();
        this.prevDetail(-1);
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.nextDetail(1);
      }
      // 播放控制快捷键（P0-3）：焦点在控件上时不拦截——Space 应触发聚焦按钮的原生点击、
      // 滑块应保留原生步进，避免与详情层交互冲突
      if (!this.#isInteractiveTarget(e.target) && work) {
        if (e.key === " " || e.code === "Space") {
          e.preventDefault();
          if (work.type === "note" && work.images?.length > 0) this.#toggleNoteAutoPlay();
          else this.toggleDetailVideoPlay();
          return;
        }
        if (e.key === "m" || e.key === "M") {
          e.preventDefault();
          if (work.type === "note" && work.music) this.#toggleNoteMute();
          else if (work.type === "video") this.toggleDetailVideoMute();
          return;
        }
        if (e.key === "l" || e.key === "L") {
          e.preventDefault();
          this.cycleLoopMode();
          this.updateLoopBtn(work?.type === "video" && utils.getVideoUrl(work));
          return;
        }
        if (e.key === "f" || e.key === "F") {
          e.preventDefault();
          this.#toggleFullscreen();
          return;
        }
      }
      if (work?.type === "note" && work.images?.length > 1) {
        if (e.key === "ArrowLeft" && this.#noteImgIndex > 0) {
          e.preventDefault();
          this.#noteShowImage(this.#noteImgIndex - 1);
        }
        if (e.key === "ArrowRight" && this.#noteImgIndex < work.images.length - 1) {
          e.preventDefault();
          this.#noteShowImage(this.#noteImgIndex + 1);
        }
      }
    });

    dom.detailClose.addEventListener("click", () => this.closeDetail());

    // 底栏作者/标题为真实链接（新标签页打开），无需额外点击逻辑

    dom.detailRemoveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const work = this.getCurrentWork();
      if (!work) return;
      // 点赞/收藏域的详情「移除」仅删本地记录（远端取消走批量入口），文案区分
      const localOnly = config.WORK_LIKE_DOMAINS.includes(state.domain) && state.domain !== "works";
      const removeBody = document.createElement("p");
      removeBody.className = "confirm-delete-msg";
      removeBody.textContent = localOnly
        ? `确定要从${config.DOMAINS_META[state.domain].label}域移除"${(work.desc || "无作品描述").slice(0, config.DETAIL_TITLE_MAX_LEN)}"？远端点赞/收藏不受影响。`
        : `确定要移除"${(work.desc || "无作品描述").slice(0, config.DETAIL_TITLE_MAX_LEN)}"？`;
      dialog.showDialog("移除作品", removeBody, [
        { text: "取消", ghost: true, callback: () => dialog.closeDialog() },
        {
          text: "移除",
          danger: true,
          callback: async () => {
            dialog.updateDialog("正在移除…", "");
            state.preventDialogClose = true;
            try {
              await this.removeWork(work.awemeId);
              if (search.getWorksView().length === 0) {
                this.closeDetail();
              } else {
                if (this.getDetailIndex() >= search.getWorksView().length) this.#index = search.getWorksView().length - 1;
                this.renderDetail();
              }
              store.refreshGroups();
              // 成功终态不再要求"好的"确认（建议2）
              dialog.closeDialog();
              dialog.showToast("已移除该作品", "success");
            } finally {
              state.preventDialogClose = false;
            }
          },
        },
      ]);
    });

    dom.detailLoopBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const work = this.getCurrentWork();
      this.cycleLoopMode();
      this.updateLoopBtn(work?.type === "video" && utils.getVideoUrl(work));
    });

    // 单条同步仅作品域有意义（SYNC_WORKS 写 works store）；点赞/收藏域隐藏该按钮。
    // initDetailEvents 仅执行一次，不能在此读 state.domain，改为每次打开详情时同步显隐
    dom.detailSyncBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const work = this.getCurrentWork();
      if (!work) return;
      dom.detailSyncBtn.disabled = true;
      dom.detailSyncBtn.classList.add("work-syncing");
      try {
        const newWork = await this.syncWork(work.awemeId);
        if (newWork) {
          store.updateWork(work.awemeId, newWork);
        }
      } catch {}
      // 旋转态（建议20）：复用网格卡 .work-syncing 的图标自转样式
      dom.detailSyncBtn.classList.remove("work-syncing");
      dom.detailSyncBtn.disabled = false;
    });

    dom.detailDownloadBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const work = this.getCurrentWork();
      if (work) this.downloadWork(work);
    });

    dom.detailPlayBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const work = this.getCurrentWork();
      if (!work) return;
      if (work.type === "note" && work.images?.length > 0) {
        this.#toggleNoteAutoPlay();
      } else {
        this.toggleDetailVideoPlay();
      }
    });

    dom.detailMuteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const work = this.getCurrentWork();
      if (!work) return;
      if (work.type === "note" && work.music) {
        this.#toggleNoteMute();
      } else if (work.type === "video") {
        this.toggleDetailVideoMute();
      }
    });

    dom.detailVideoWrap.addEventListener("click", () => this.toggleDetailVideoPlay());

    const video = dom.detailVideo;
    video.addEventListener("play", () => clearTimeout(video._retryTimer));
    video.addEventListener("timeupdate", () => {
      if (video._lastProgressUpdate && Date.now() - video._lastProgressUpdate < 250) return;
      video._lastProgressUpdate = Date.now();
      this.updateVideoProgress(video, dom.detailProgressSlider, dom.detailTime, "0.2");
    });
    video.addEventListener("ended", () => {
      const mode = this.nextOnEnd();
      if (mode === "single") video.play();
      else if (mode === "group") this.renderDetail();
    });

    dom.detailProgressSlider.addEventListener("input", () => {
      cancelAnimationFrame(this.#detailSliderRaf);
      this.#detailSliderRaf = requestAnimationFrame(() => {
        if (video.duration) video.currentTime = (dom.detailProgressSlider.value / 100) * video.duration;
      });
    });

    dom.detailNavLeft.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.#noteImgIndex > 0) this.#noteShowImage(this.#noteImgIndex - 1);
    });

    dom.detailNavRight.addEventListener("click", (e) => {
      e.stopPropagation();
      const maxIndex = (this.#noteWork?.images.length || 1) - 1;
      if (this.#noteImgIndex < maxIndex) this.#noteShowImage(this.#noteImgIndex + 1);
    });

    const noteContainer = dom.detailImageContainer.querySelector(".detail-image-container");
    noteContainer.addEventListener("click", () => {
      this.#toggleNoteAutoPlay();
    });
  }

  // dir 透传给 renderDetail 驱动方向感过渡（建议15）
  nextDetail(dir = 1) {
    if (this.nextDetailIndex()) this.renderDetail(dir);
  }

  prevDetail(dir = -1) {
    if (this.prevDetailIndex()) this.renderDetail(dir);
  }

  closeDetail() {
    // 先在索引复位前记录原位置，供关闭后滚动卡片回到相应位置（closeDetailIndex 会清空 #index）
    const restoredIndex = this.getDetailIndex();
    this.closeDetailIndex();
    this.resetMediaElements();
    // 复位增强态 UI：加载指示隐藏，下次打开从干净状态开始
    dom.detailLoader.classList.add("hidden");
    dom.detailProgressSlider.classList.add("hidden");
    // 导航箭头已不在媒体容器内，须随关闭显式隐藏
    dom.detailNavLeft.classList.add("hidden");
    dom.detailNavRight.classList.add("hidden");
    dom.detailVideoContainer.classList.add("hidden");
    dom.detailImageContainer.classList.add("hidden");
    dom.detailOverlay.style.removeProperty("--bg-url");
    dom.detailOverlay.classList.add("hidden");
    document.body.style.overflow = "";
    worksGrid.restoreGridScroll(restoredIndex);
  }

  resetVideo() {
    dom.detailVideo.removeAttribute("src");
    dom.detailVideo.load();
  }

  resetAudio() {
    dom.detailAudio.pause();
    dom.detailAudio.removeAttribute("src");
    dom.detailAudio.load();
  }

  resetMediaElements() {
    this.resetVideo();
    this.resetAudio();
  }

  // 切作品时清空详情主图，杜绝链接失效时残留上一作品的内容
  #clearDetailImage() {
    dom.detailImage.removeAttribute("src");
    // 无 src 的 <img> 会以文本渲染 alt 属性——清空 alt，杜绝加载期中央区闪现作品标题
    dom.detailImage.alt = "";
    this.#hideImageFailed();
  }

  #showImageFailed() {
    dom.detailImage.parentElement.classList.add("detail-image-failed");
  }

  #hideImageFailed() {
    dom.detailImage.parentElement.classList.remove("detail-image-failed");
  }

  toggleVideoPlay(video, playBtn) {
    if (video.paused) {
      video.play().catch(() => {});
      playBtn.innerHTML = config.icons.pause;
    } else {
      video.pause();
      playBtn.innerHTML = config.icons.play;
    }
  }

  toggleVideoMute(video, muteBtn) {
    video.muted = !video.muted;
    muteBtn.innerHTML = video.muted ? config.icons.mute : config.icons.unmute;
  }

  updateVideoProgress(video, slider, timeSpan, opacity) {
    if (video.duration) {
      const pct = (video.currentTime / video.duration) * 100;
      // 缓冲段可视化（建议16）：已播放实白、缓冲半透明白、未缓冲底色
      let bufferedPct = pct;
      try {
        if (video.buffered.length) bufferedPct = (video.buffered.end(video.buffered.length - 1) / video.duration) * 100;
      } catch (_) {}
      slider.value = pct;
      slider.style.background = `linear-gradient(to right, #fff ${pct}%, rgba(255,255,255,0.45) ${pct}%, rgba(255,255,255,0.45) ${bufferedPct}%, rgba(255,255,255,${opacity}) ${bufferedPct}%)`;
      timeSpan.textContent = `${this.formatTime(video.currentTime)} / ${this.formatTime(video.duration)}`;
    }
  }

  // 媒体熔断：滑动窗口内失败计数，密集失败（网络异常）时进入冷却期，
  // 期间视频/封面跳过重试直接降级；任何媒体成功加载即复位。
  markMediaFail() {
    const now = Date.now();
    this.#mediaFailCount =
      now - this.#mediaLastFailAt > config.MEDIA_FAIL_WINDOW ? 1 : this.#mediaFailCount + 1;
    this.#mediaLastFailAt = now;
    if (this.#mediaFailCount >= config.MEDIA_FAIL_MAX) {
      this.#mediaBreakUntil = now + config.MEDIA_BREAK_COOLDOWN;
      this.#mediaFailCount = 0;
    }
  }

  markMediaOk() {
    this.#mediaFailCount = 0;
    this.#mediaBreakUntil = 0;
  }

  mediaRetryBlocked() {
    return Date.now() < this.#mediaBreakUntil;
  }

  handleVideoError(video, ui) {
    if (!video.src) return;
    this.markMediaFail();
    const retries = parseInt(video.dataset.retries || "0");
    if (retries >= config.VIDEO_RETRY_MAX || this.mediaRetryBlocked()) {
      ui.onMax(retries);
      return;
    }
    video.dataset.retries = String(retries + 1);
    const delay = config.VIDEO_RETRY_DELAYS[retries] ?? config.VIDEO_RETRY_FALLBACK_DELAY;
    ui.onRetry(retries, delay);
    clearTimeout(video._retryTimer);
    video._retryTimer = setTimeout(() => {
      if (!video.isConnected) return;
      video.load();
      video.play().catch(() => {});
    }, delay);
  }

  toggleDetailVideoPlay() {
    this.toggleVideoPlay(dom.detailVideo, dom.detailPlayBtn);
    const label = dom.detailVideo.paused ? "播放" : "暂停";
    dom.detailPlayBtn.title = label;
    dom.detailPlayBtn.setAttribute("aria-label", label);
  }

  toggleDetailVideoMute() {
    this.toggleVideoMute(dom.detailVideo, dom.detailMuteBtn);
    const label = dom.detailVideo.muted ? "取消静音" : "静音";
    dom.detailMuteBtn.title = label;
    dom.detailMuteBtn.setAttribute("aria-label", label);
  }

  formatTime(seconds) {
    if (!seconds || !isFinite(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  getFilename(work, ext) {
    const nick = (work.nickname || "unknown").replace(/[\\/:*?"<>|]/g, "_");
    return `${nick}_${work.awemeId}.${ext}`;
  }

  async fetchBlob(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const ext = Detail.MIME_EXT[blob.type] || "mp4";
    return { blob, ext };
  }

  triggerDownload(blob, filename) {
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), config.BLOB_REVOKE_DELAY);
  }

  // silent=true 时抑制单条失败 toast 并返回成功布尔（批量下载用，聚合汇报由调用方负责）
  async downloadWork(work, { silent = false } = {}) {
    return this.#downloadWithRetry(work, 0, silent);
  }

  async #downloadWithRetry(w, attempt, silent) {
    try {
      if (w.type === "video" && utils.getVideoUrl(w)) {
        const { blob, ext } = await this.fetchBlob(utils.getVideoUrl(w));
        this.triggerDownload(blob, this.getFilename(w, ext));
      } else if (w.type === "note" && w.images?.length) {
        for (const [i, img] of w.images.entries()) {
          const absUrl = utils.pickHttpsUrl(img || "");
          const { blob, ext } = await this.fetchBlob(absUrl);
          this.triggerDownload(blob, this.getFilename(w, `${i + 1}.${ext}`));
        }
      }
      return true;
    } catch (err) {
      console.error("[DY] download failed:", err);
      if (attempt >= config.DOWNLOAD_MAX_RETRY) {
        if (!silent) dialog.showToast("下载失败: " + (err.message || "未知错误"), "error");
        return false;
      }
      await new Promise((r) => setTimeout(r, config.FETCH_RETRY_DELAY));
      return this.#downloadWithRetry(w, attempt + 1, silent);
    }
  }
}

export const detail = new Detail();
