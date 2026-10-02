// ---------- Detail ----------
import { config, dom, state, utils, services, store } from '../core.js';
import { search } from './search-bar.js';
import { dialog } from './dialog.js';
import { worksGrid } from '../grids/works-grid.js';
import { createZip } from '../data/zip.js';

// ---------- Detail ----------
class Detail {
  // 下载/保存时按 MIME 取扩展名
  static MIME_EXT = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
  };

  #index = -1;
  #cleanups = [];
  #loopMode = "single";
  #detailListenersAttached = false;
  #noteWork = null;
  #noteImgIndex = 0;
  #noteAutoPlayTimer = null;
  #noteIsPlaying = false;
  #noteMode = "virtual";        // 图集进度驱动：music=音频 timeupdate / virtual=定时器兜底
  #noteVirtualElapsed = 0;      // virtual 模式当前轮播周期已播毫秒数
  #noteSegFills = [];           // 图集分段填充引用缓存（#buildNoteSegs 构建）：渲染 tick 免逐段 querySelector
  #noteSegLastIdx = -1;         // 上次推进到的段下标：#renderNoteSegs 跃迁双写的基准
  #wheelAt = 0;                 // wheel 切作品冷却时间戳（触控板惯性每秒数十次事件防连切）
  #noteSegOffset = 0;           // music 模式轮播周期偏移（ms）：周期时间 = audio.currentTime - offset。
                                // 手动切图/进度条 seek 只重定基偏移量，音乐本身不跳
  #trackPlayed = null;
  #trackThumb = null;
  #trackBuffered = null;
  #timeTip = null;
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
    // 预取下一张：翻页/自动播放到下一图时命中缓存（自动播放 3s/张，预取窗口充裕）
    this.#prefetchNoteImage(idx + 1);
    const url = utils.pickHttpsUrl(this.#noteWork.images[idx])
      || utils.pickHttpsUrl(this.#noteWork.cover)
      || "";
    this.#updateCounters(this.#noteWork);
    if (!url) return;
    // div+background-image 载体的零空档切图：背景在提交前保持旧图，失败在结构上不可见
    //（不存在 img 的裂图态）；探针先行，失败 URL 永不落到可见节点，失败时旧图本就未离开
    const token = ++this.#imgProbeToken;
    const probe = new Image();
    probe.onload = () => {
      if (token !== this.#imgProbeToken) return;
      this.markMediaOk();
      // 图集逐图自适应列宽（图组内比例不一致时随图切换）
      this.#setMediaAspect(probe.naturalWidth, probe.naturalHeight);
      this.#hideImageFailed();
      const doCommit = () => {
        if (token !== this.#imgProbeToken) return;
        dom.detailImage.style.backgroundImage = utils.cssUrl(url);
        dom.detailImage.setAttribute("aria-label", this.#noteWork.desc || "");
        // 模糊背景不再逐图跟随（2026-09 性能定案）：全屏 blur(70px) 层随每次背景源
        // 变化整体重光栅化，图集自动播放每 3s 一次 10-50ms 级 paint——背景仅在切作品
        // 时更新一次（首图，见 renderDetail），图内翻页保持
      };
      // decode 保证首帧完整可绘后再提交；decode 失败（罕见）也照常提交——背景失败不可见
      if (typeof probe.decode === "function") probe.decode().then(doCommit, doCommit);
      else doCommit();
    };
    probe.onerror = () => {
      if (token !== this.#imgProbeToken) return;
      this.markMediaFail();
    };
    probe.src = url;
  }

  // 预取指定图（仅预热 HTTP 缓存：无回调、不进熔断计数，展示探针才是计数决策点）；
  // 熔断冷却期跳过，避免冷却窗口内继续打请求
  #prefetchNoteImage(idx) {
    if (this.mediaRetryBlocked()) return;
    const url = utils.pickHttpsUrl(this.#noteWork?.images?.[idx] || "");
    if (!url) return;
    new Image().src = url;
  }

  // 图集分段进度条：N 段对应 N 张图（仅在段数变化时重建，避免 resume 时清空填充）
  #buildNoteSegs() {
    const work = this.#noteWork;
    if (!work?.images?.length) return;
    if (dom.noteSegs.children.length === work.images.length) return;
    dom.noteSegs.innerHTML = "";
    this.#noteSegFills = [];
    this.#noteSegLastIdx = -1;
    for (let i = 0; i < work.images.length; i++) {
      const seg = document.createElement("div");
      seg.className = "seg";
      const fill = document.createElement("div");
      fill.className = "seg-fill";
      seg.appendChild(fill);
      dom.noteSegs.appendChild(seg);
      this.#noteSegFills.push(fill);
    }
  }

  // 渐进填充：前段播满、当前段按 cur/total 推进、后段未播。
  // 跃迁双写：段引用建表时缓存，平时每 tick 只写当前段，段界跃迁（含 seek 跳段/续播
  // 恢复重置）一次性收敛区间段——替代逐 tick 全段展开 + querySelector + 全段写 width
  //（50 图图集 ≈ 每秒 200 次无效布局失效写入）
  #renderNoteSegs(cur, total) {
    const work = this.#noteWork;
    if (!work?.images?.length || !total) return;
    const segDur = total / work.images.length;
    const idx = Math.min(Math.max(Math.floor(cur / segDur), 0), work.images.length - 1);
    const fills = this.#noteSegFills;
    if (idx !== this.#noteSegLastIdx) {
      // 前向（含 fresh/续播）：旧当前段与跳过的中间段补满；后向（回退 seek）：越过段清零
      for (let k = Math.max(this.#noteSegLastIdx, 0); k < idx; k++) {
        if (fills[k]) fills[k].style.width = "100%";
      }
      for (let k = idx + 1; k <= this.#noteSegLastIdx; k++) {
        if (fills[k]) fills[k].style.width = "0%";
      }
      this.#noteSegLastIdx = idx;
    }
    const fill = fills[idx];
    if (fill) fill.style.width = Math.min(Math.max((cur - idx * segDur) / segDur, 0), 1) * 100 + "%";
  }

  // 图集自动轮播驱动：有音乐=音频 timeupdate 驱动（总时长=音乐真实时长），
  // 无音乐=虚拟时钟兜底（每图 NOTE_AUTO_PLAY_INTERVAL，行为与旧定时轮播一致）
  #noteStartAutoPlay() {
    const work = this.#noteWork;
    if (!work?.images?.length) return;
    this.#noteStopAutoPlay();
    this.#buildNoteSegs();
    this.#noteIsPlaying = true;
    if (work.music) {
      this.#noteMode = "music";
      const audio = dom.detailAudio;
      // 'off' 播完后音频停在末尾：再点播放需从头部重来，否则 play 后立即又触发 ended
      if (audio.ended) {
        audio.currentTime = 0;
        this.#noteSegOffset = 0;
      }
      audio.play().catch(() => {});
    } else {
      this.#noteMode = "virtual";
      this.#noteVirtualElapsed = 0;
      this.#noteAutoPlayTimer = setInterval(() => this.#onNoteVirtualTick(), 250);
    }
    this.#noteUpdatePlayBtn();
  }
  #noteStopAutoPlay() {
    if (this.#noteAutoPlayTimer) {
      clearInterval(this.#noteAutoPlayTimer);
      this.#noteAutoPlayTimer = null;
    }
    if (this.#noteMode === "music") dom.detailAudio.pause();
    this.#noteIsPlaying = false;
  }
  // 图集周期时间线辅助：total=周期总时长；cycle=周期内已播时间（music 模式=音频时钟减偏移）
  #noteTotal() {
    const work = this.#noteWork;
    if (this.#noteMode === "music") {
      const dur = dom.detailAudio.duration;
      return dur && isFinite(dur) ? dur : work.images.length * config.NOTE_AUTO_PLAY_INTERVAL;
    }
    return work.images.length * config.NOTE_AUTO_PLAY_INTERVAL;
  }
  #noteCycleTime() {
    if (this.#noteMode === "music") {
      return Math.min(Math.max(dom.detailAudio.currentTime - this.#noteSegOffset, 0), this.#noteTotal());
    }
    return this.#noteVirtualElapsed;
  }

  // 手动切图（箭头/键盘）：重定基周期偏移量对齐目标段起点——
  // 指示器/进度时间线随动，音乐本身不跳（方案A定案）；驱动继续按各自时钟推进
  #noteManualSwitch(idx) {
    const work = this.#noteWork;
    if (!work?.images?.length) return;
    idx = Math.min(Math.max(idx, 0), work.images.length - 1);
    if (this.#noteMode === "music" && dom.detailAudio.duration && isFinite(dom.detailAudio.duration)) {
      this.#noteSegOffset = dom.detailAudio.currentTime - (idx * dom.detailAudio.duration) / work.images.length;
    } else if (this.#noteMode === "virtual") {
      this.#noteVirtualElapsed = (idx * this.#noteTotal()) / work.images.length;
    }
    this.#noteShowImage(idx);
    this.#renderNoteSegs(this.#noteCycleTime(), this.#noteTotal());
  }

  // 音乐 timeupdate（initDetailEvents 绑定一次）：按重定基后的周期时间渐进填充 + 段满切图。
  // 手动切图后由偏移量保证不回弹（音乐不跳段）
  #onNoteAudioTimeUpdate() {
    if (dom.detailOverlay.classList.contains("hidden")) return;
    if (this.#noteMode !== "music") return;
    const work = this.#noteWork;
    const audio = dom.detailAudio;
    if (!work?.images?.length || !audio.duration || !isFinite(audio.duration)) return;
    const total = audio.duration;
    const cycle = audio.currentTime - this.#noteSegOffset;
    if (cycle >= total) {
      // 周期走完（含手动前跳提前耗尽剩余音乐）：按循环模式收尾
      const end = this.nextOnEnd();
      if (end === "single") {
        this.#noteSegOffset = audio.currentTime;
        this.#noteShowImage(0);
        this.#renderNoteSegs(0, total);
        return;
      }
      if (end === "group") {
        this.renderDetail();
        return;
      }
      this.#noteStopAutoPlay();
      this.#noteUpdatePlayBtn();
      return;
    }
    const clamped = Math.max(cycle, 0);
    this.#renderNoteSegs(clamped, total);
    const seg = Math.min(Math.floor(clamped / (total / work.images.length)), work.images.length - 1);
    if (seg !== this.#noteImgIndex) this.#noteShowImage(seg);
  }
  // 音乐播完：按循环模式收尾（single=重播，group=下一作品，off=停）。
  // 手动后跳会使周期未走完音乐先结束，故重播时同时清零偏移量
  #onNoteAudioEnded() {
    if (this.#noteMode !== "music") return;
    const end = this.nextOnEnd();
    if (end === "single") {
      this.#noteSegOffset = 0;
      dom.detailAudio.currentTime = 0;
      dom.detailAudio.play().catch(() => {});
      this.#noteShowImage(0);
      this.#renderNoteSegs(0, this.#noteTotal());
      return;
    }
    if (end === "group") {
      this.renderDetail();
      return;
    }
    this.#noteStopAutoPlay();
    this.#noteUpdatePlayBtn();
  }
  // 无音乐兜底 tick：虚拟时钟推进，收尾语义与旧定时轮播一致
  #onNoteVirtualTick() {
    const work = this.#noteWork;
    if (!work?.images?.length) return;
    const interval = config.NOTE_AUTO_PLAY_INTERVAL;
    const total = work.images.length * interval;
    this.#noteVirtualElapsed += 250;
    if (this.#noteVirtualElapsed >= total) {
      const end = this.nextOnEnd();
      if (end === "single") {
        this.#noteVirtualElapsed = 0;
        this.#noteShowImage(0);
        this.#renderNoteSegs(0, total);
        return;
      }
      if (end === "group") {
        this.renderDetail();
        return;
      }
      this.#noteStopAutoPlay();
      this.#noteUpdatePlayBtn();
      return;
    }
    this.#renderNoteSegs(this.#noteVirtualElapsed, total);
    const seg = Math.floor(this.#noteVirtualElapsed / interval);
    if (seg !== this.#noteImgIndex) this.#noteShowImage(seg);
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
    if (this.#noteIsPlaying) {
      this.#noteStopAutoPlay();
    } else {
      this.#noteStartAutoPlay();
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
    if (config.WORK_RECORD_DOMAINS.includes(state.domain)) {
      await services.deleteWorkRecord(state.domain, [awemeId]);
      store.removeWorkRecordSilent(state.domain, new Set([awemeId]));
      state.selectedIds.delete(awemeId);
      search.activeWorkRecordGrid().removeItems(new Set([awemeId]));
      store.refreshGroups();
      search.syncCount();
      return;
    }
    await services.bgMsg({ type: "DELETE_WORKS", awemeIds: [awemeId] });
    state.selectedIds.delete(awemeId);
    const idx = state.works.findIndex((w) => w.awemeId === awemeId);
    store.spliceWork(idx);
  }

  // 详情移除确认流程：底栏「移除」按钮与 Delete/Backspace 快捷键共用入口（确认弹窗，不直接删）
  #confirmRemoveCurrent() {
    const work = this.getCurrentWork();
    if (!work) return;
    // 点赞/收藏域的详情「移除」仅删本地记录（远端取消走批量入口），文案区分
    const localOnly = config.WORK_RECORD_DOMAINS.includes(state.domain) && state.domain !== "works";
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

  // ===== 详情层 UI 增强（定案见 docs/11）=====

  // 计数展示：bar-controls 信息位——视频为播放时间（#renderVideoProgress 维护 detailTime），
  // 图集为 K/N 图片顺序（#detailOrder，随 #noteShowImage 更新）；播放条最右端仍为作品序号
  #updateCounters(work) {
    const total = search.getWorksView().length;
    // 图集顺序位（视频模式此位显示 detailTime，不由此处写入）
    if (work.type === "note" && work.images?.length) {
      dom.detailOrder.textContent = `${this.#noteImgIndex + 1}/${work.images.length}`;
    }
    // 播放条最右端：作品序号（K 为输入框，Enter 提交跳转 / Esc 还原，见 #commitCounterJump）
    if (total > 1) {
      dom.detailCounterInput.value = String(this.getDetailIndex() + 1);
      dom.detailCounterTotal.textContent = ` / ${total}`;
      this.#resizeCounterInput();
      dom.detailCounter.classList.remove("hidden");
      // 焦点在输入框内时（渲染中切作品/跳转后）重选全文，下一次键入直接替换
      if (document.activeElement === dom.detailCounterInput) dom.detailCounterInput.select();
    } else {
      dom.detailCounter.classList.add("hidden");
    }
  }

  // K 输入框宽度自适应（ch = 本字体数字宽）：取总位数与当前输入位数的较大者，防位数增长截断
  #resizeCounterInput() {
    const input = dom.detailCounterInput;
    input.style.width = `${Math.max(String(search.getWorksView().length).length, input.value.length)}ch`;
  }

  #revertCounterInput() {
    dom.detailCounterInput.value = String(this.getDetailIndex() + 1);
    this.#resizeCounterInput();
  }

  // K 提交跳转：非数字/越界钳制到 [1, N]；相邻序号保留方向感过渡（与 ↑/↓ 同语义），远跳走普通淡入。
  // 关详情后网格滚动恢复走既有 restoreGridScroll，跳转结果自然落位
  #commitCounterJump() {
    const total = search.getWorksView().length;
    const k = parseInt(dom.detailCounterInput.value, 10);
    if (total === 0 || !Number.isFinite(k)) return this.#revertCounterInput();
    const target = Math.min(Math.max(k, 1), total) - 1;
    if (target === this.#index) return this.#revertCounterInput();
    const dir = Math.abs(target - this.#index) === 1 ? (target > this.#index ? 1 : -1) : 0;
    this.#index = target;
    this.renderDetail(dir);
  }

  // 加载指示复位（建议17）
  #resetMediaStatus(isVideo) {
    dom.detailLoader.classList.toggle("hidden", !isVideo);
  }

  // 清晰列宽自适应：写入 --media-aspect（.media-view 宽度 = min(视口宽, 可视高×比例)）。
  // 视频=loadedmetadata 的 videoWidth/Height，图片=探针 naturalWidth/Height；
  // 宽高无效（未加载/音频流）回落 9:16 缺省，切作品时主动复位防上一件比例残留
  #setMediaAspect(w, h) {
    const aspect = w > 0 && h > 0 ? w / h : 9 / 16;
    dom.detailOverlay.style.setProperty("--media-aspect", aspect.toFixed(4));
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
      const newUrl = utils.cssUrl(u);
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
    dom.detailOverlay.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    this.renderDetail();
  }

  // dir: 1 下一作品 / -1 上一作品 / 0 无方向（首次打开或循环回跳），驱动建议15的方向感过渡
  renderDetail(dir = 0) {
    const isSwitch = !dom.detailOverlay.classList.contains("hidden");
    const body = dom.detailBody;
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
      // 列宽比例同步复位 9:16 缺省，新作品元数据就绪后再收窄/放宽
      this.#setMediaAspect(0, 0);

      const isVideo = work.type === "video" && utils.getVideoUrl(work);
      if (isVideo) {
        this.resetAudio();
      } else {
        this.resetMediaElements();
      }

      const isNote = work.type === "note" && work.images?.length > 0;

      dom.detailPlayBtn.style.display = "";
      dom.detailMuteBtn.style.display = "";

      dom.detailVideoContainer.classList.toggle("hidden", !isVideo);
      dom.detailImageContainer.classList.toggle("hidden", !isNote && (isVideo || !work.cover));
      // 进度条双形态：视频=连续轨道，图集=分段进度（音乐/虚拟时钟驱动）
      dom.detailProgress.classList.toggle("hidden", !isVideo && !isNote);
      dom.detailProgress.classList.toggle("note-mode", isNote);
      dom.noteSegs.classList.toggle("hidden", !isNote);

      // 模糊背景（对齐抖音：同画面放大模糊）——视频=封面；图集=首图。仅在切作品时
      // 更新一次：图内翻页不再逐图重光栅化全屏 blur 层（2026-09 性能定案）
      // 候选链探针与代际机制见 #applyDetailBg，全部失效时降级为统一深色底
      if (isVideo) {
        this.#applyDetailBg([work.cover]);
      } else if (isNote) {
        this.#applyDetailBg([work.images[0]]);
      }

      // 导航箭头已上移至 .detail-body 直下（不随媒体容器切换动效），可见性须在此显式管理：
      // 仅多图图集出现，视频/单图路径不再依赖容器 hidden 连带隐藏
      const hasNoteNav = isNote && work.images.length > 1;
      dom.detailNavLeft.classList.toggle("hidden", !hasNoteNav);
      dom.detailNavRight.classList.toggle("hidden", !hasNoteNav);

      dom.detailTime.classList.toggle("hidden", !isVideo);
      dom.detailOrder.classList.toggle("hidden", !isNote);
      if (isVideo) {
        this.#resetVideoProgressUI();
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
      // 描述全文进入播放条（CSS 单行省略 + hover title 提示），不再 JS 截断
      dom.detailTitleText.textContent = work.desc || "无作品描述";
      dom.detailTitle.title = "在抖音打开作品页";
      dom.detailCreateTime.textContent = utils.formatPublishDate(work.createTime);
      dom.detailCreateTime.classList.toggle("hidden", !dom.detailCreateTime.textContent);

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
          this.#setMediaAspect(probe.naturalWidth, probe.naturalHeight);
          // div+background-image 载体：探针成功即提交，可见加载失败在结构上不存在
          dom.detailImage.style.backgroundImage = utils.cssUrl(work.cover);
          dom.detailImage.setAttribute("aria-label", work.desc || "");
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
    // 本轮渲染的加载监听统一挂 signal：切走时 runCleanups → abort 移除未触发的 once
    // 监听——resetVideo 的 load() 不触发 canplay/loadedmetadata，旧闭包滞留会在下一个
    // 视频 canplay 时连环引爆（幽灵 loader / 陈旧 markMediaOk / 窜位 aspect）
    const loadSignals = new AbortController();
    this.addCleanup(() => loadSignals.abort());
    // 仅在真实加载成功时复位熔断；error 路径也会调 fireReady，不能顺带 markMediaOk
    const fireLoaded = () => {
      this.markMediaOk();
      dom.detailLoader.classList.add("hidden");
      fireReady();
    };
    video.addEventListener("canplay", fireLoaded, { once: true, signal: loadSignals.signal });
    video.addEventListener("loadedmetadata", fireLoaded, { once: true, signal: loadSignals.signal });
    // 列宽收窄依据：元数据就绪即按真实宽高比自适应（与 fireLoaded 的 once 监听互不干扰）
    video.addEventListener("loadedmetadata", () => {
      this.#setMediaAspect(video.videoWidth, video.videoHeight);
    }, { once: true, signal: loadSignals.signal });

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

    this.#resetVideoProgressUI();
  }

  renderDetailNote(work, onReady) {
    this.#noteWork = work;
    this.#noteImgIndex = 0;
    this.#noteAutoPlayTimer = null;
    this.#noteIsPlaying = false;
    this.#noteSegOffset = 0;
    const audio = dom.detailAudio;

    const readyFn = () => { if (onReady) onReady(); };
    // 图片加载完成时结束过渡
    let readyFired = false;
    const fireReady = () => {
      if (readyFired) return;
      readyFired = true;
      readyFn();
    };
    // 切到新作品先清空上个作品的图，避免链接失效时残留上一作品内容
    this.#clearDetailImage();
    // 先加载 cover：网格卡已加载过同一 cover 大概率命中缓存，探针通过即先落为占位，
    // 再换高清首帧。候选去重防 cover 与首帧同 URL 重复加载；全部失败才进失效态。
    // 期间无 aria-label，杜绝中央区闪现作品标题文本（见 #clearDetailImage）
    const candidates = [...new Set([
      utils.pickHttpsUrl(work.cover || ""),
      utils.pickHttpsUrl(work.images?.[0] || ""),
    ].filter(Boolean))];
    if (!candidates.length) {
      this.#showImageFailed();
      fireReady();
    } else {
      const token = ++this.#imgProbeToken;
      const tryCandidate = (i) => {
        if (i >= candidates.length) {
          // 全部失效：保持清空并显示失效态，绝不回退到上一个作品
          this.markMediaFail();
          this.#clearDetailImage();
          this.#showImageFailed();
          fireReady();
          return;
        }
        const probe = new Image();
        probe.onload = () => {
          if (token !== this.#imgProbeToken) return;
          this.markMediaOk();
          this.#setMediaAspect(probe.naturalWidth, probe.naturalHeight);
          // div+background-image 载体：探针成功即提交，可见加载失败在结构上不存在
          //（背景失败不可见，无需 img error 兜底）
          dom.detailImage.style.backgroundImage = utils.cssUrl(candidates[i]);
          dom.detailImage.setAttribute("aria-label", work.desc || "");
          fireReady();
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

    // 预取第二张：首图经 cover 候选链落地后，翻页/自动播放到 images[1] 直接命中缓存
    this.#prefetchNoteImage(1);

    // 图集/作品计数统一走计数展示逻辑（底栏 [K/N] 图片页序 + 作品序号）
    this.#updateCounters(work);

    if (work.music) {
      audio.src = utils.pickHttpsUrl(work.music);
      audio.currentTime = 0;

      dom.detailMuteBtn.innerHTML = audio.muted ? config.icons.mute : config.icons.unmute;

      audio.play().catch((err) => {
        if (err.name === "NotAllowedError") {
          audio.muted = true;
          dom.detailMuteBtn.innerHTML = config.icons.mute;
          audio.play().catch(() => {});
        }
      });
      // 初始分段填充兜底：metadata 就绪后由 timeupdate 按真实音乐时长接管
      this.#renderNoteSegs(0, work.images.length * config.NOTE_AUTO_PLAY_INTERVAL);
    } else {
      dom.detailMuteBtn.style.display = "none";
    }

    this.#noteStartAutoPlay();

    this.addCleanup(() => this.#noteStopAutoPlay());
  }

  initDetailEvents() {
    if (this.#detailListenersAttached) return;
    this.#detailListenersAttached = true;

    dom.detailOverlay.addEventListener(
      "wheel",
      (e) => {
        // 300ms 冷却：触控板惯性每秒可发数十次 wheel，每次都走完整 renderDetail 流水线
        //（双 rAF + 探针链 + 兜底 timer）且一次手势会跳过大量作品；鼠标滚轮一格一滚无感
        const now = performance.now();
        if (now - this.#wheelAt < 300) return;
        this.#wheelAt = now;
        if (e.deltaY > 0) this.nextDetail();
        else this.prevDetail();
      },
      { passive: true },
    );

    document.addEventListener("keydown", (e) => {
      if (dom.detailOverlay.classList.contains("hidden")) return;
      // 弹窗叠于详情层之上时全部让位（Space/M/L/F/方向键/删除键不穿透）；Esc 不经本监听，
      // 由 main.js 的 Esc 收口统一裁决（一次按键只关一层）
      if (!dom.dialogOverlay.classList.contains("hidden")) return;
      // Tab 焦点圈定（建议21）
      if (e.key === "Tab") {
        this.#trapFocus(e);
        return;
      }
      // 计数输入框聚焦时全部让位：数字/方向键留在输入框，Enter/Esc 由其自身监听收口
      if (e.target === dom.detailCounterInput) return;
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
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          this.#noteManualSwitch(this.#noteImgIndex - 1);
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          this.#noteManualSwitch(this.#noteImgIndex + 1);
        }
      }
      // Delete/Backspace 移除当前作品：不进上方交互守卫（与聚焦按钮无原生冲突，焦点在任意
      // 按钮上也要可用），仅排除输入位；走 #confirmRemoveCurrent 与按钮同款确认弹窗
      if (
        work &&
        (e.key === "Delete" || e.key === "Backspace") &&
        !(e.target instanceof Element && e.target.closest("input, textarea"))
      ) {
        e.preventDefault();
        this.#confirmRemoveCurrent();
        return;
      }
    });

    dom.detailClose.addEventListener("click", () => this.closeDetail());

    // 底栏作者/标题为真实链接（新标签页打开），无需额外点击逻辑

    dom.detailRemoveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.#confirmRemoveCurrent();
    });

    dom.detailLoopBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const work = this.getCurrentWork();
      this.cycleLoopMode();
      this.updateLoopBtn(work?.type === "video" && utils.getVideoUrl(work));
    });

    dom.detailDownloadBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const work = this.getCurrentWork();
      if (work) this.downloadWork(work);
    });

    // 计数 K 编辑：聚焦全选、输入仅留数字并自适应宽度；Enter 提交跳转、Esc 还原并退出
    //（stopPropagation 拦在 document 层「Esc 关详情」之前）、失焦还原——展示值与当前作品恒一致
    dom.detailCounterInput.addEventListener("focus", () => dom.detailCounterInput.select());
    dom.detailCounterInput.addEventListener("input", () => {
      const input = dom.detailCounterInput;
      if (/\D/.test(input.value)) input.value = input.value.replace(/\D/g, "");
      this.#resizeCounterInput();
    });
    dom.detailCounterInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.#commitCounterJump();
      } else if (e.key === "Escape") {
        e.stopPropagation();
        this.#revertCounterInput();
        dom.detailCounterInput.blur();
      }
    });
    dom.detailCounterInput.addEventListener("blur", () => this.#revertCounterInput());

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
      this.#renderVideoProgress();
    });
    video.addEventListener("ended", () => {
      const mode = this.nextOnEnd();
      if (mode === "single") video.play();
      else if (mode === "group") this.renderDetail();
    });

    // 进度条：点击 seek（视频=currentTime / 图集=音乐进度）；键盘 ±5% 与 Home/End（role=slider）
    dom.detailProgress.addEventListener("click", (e) => {
      e.stopPropagation();
      this.#seekProgress(e.clientX);
    });
    dom.detailProgress.addEventListener("keydown", (e) => {
      const video = dom.detailVideo;
      const audio = dom.detailAudio;
      const dur = dom.detailProgress.classList.contains("note-mode")
        ? (this.#noteMode === "music" ? audio.duration : 0)
        : video.duration;
      if (!dur || !isFinite(dur)) return;
      const cur = dom.detailProgress.classList.contains("note-mode") ? audio.currentTime : video.currentTime;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        this.#applySeek(cur / dur + (e.key === "ArrowRight" ? 0.05 : -0.05));
      } else if (e.key === "Home") {
        e.preventDefault();
        this.#applySeek(0);
      } else if (e.key === "End") {
        e.preventDefault();
        this.#applySeek(1);
      }
    });

    // 图集进度驱动（音乐）：metadata 就绪重画分段，timeupdate 渐进填充切图，ended 按循环模式收尾
    dom.detailAudio.addEventListener("loadedmetadata", () => this.#onNoteAudioTimeUpdate());
    dom.detailAudio.addEventListener("timeupdate", () => this.#onNoteAudioTimeUpdate());
    dom.detailAudio.addEventListener("ended", () => this.#onNoteAudioEnded());

    // 上/下作品切换胶囊（对齐抖音 ⌃⌄）：不参与图集翻页，只切作品
    dom.detailSwitchPrev.addEventListener("click", (e) => {
      e.stopPropagation();
      this.prevDetail();
    });
    dom.detailSwitchNext.addEventListener("click", (e) => {
      e.stopPropagation();
      this.nextDetail();
    });

    dom.detailNavLeft.addEventListener("click", (e) => {
      e.stopPropagation();
      this.#noteManualSwitch(this.#noteImgIndex - 1);
    });

    dom.detailNavRight.addEventListener("click", (e) => {
      e.stopPropagation();
      this.#noteManualSwitch(this.#noteImgIndex + 1);
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
    dom.detailProgress.classList.add("hidden");
    dom.noteSegs.classList.add("hidden");
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
    dom.detailImage.style.backgroundImage = "";
    // div 载体以 role="img" + aria-label 提供无障碍标注，清空杜绝加载期中央区闪现作品标题
    dom.detailImage.removeAttribute("aria-label");
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

  // ===== 详情播放条进度（视频模式：真实 currentTime/duration/buffered 驱动） =====
  #ensureProgressEls() {
    if (this.#trackPlayed) return;
    this.#trackPlayed = dom.detailProgress.querySelector(".track-played");
    this.#trackThumb = dom.detailProgress.querySelector(".track-thumb");
    this.#trackBuffered = dom.detailProgress.querySelector(".track-buffered");
    this.#timeTip = dom.detailProgress.querySelector(".time-tip");
  }

  #renderVideoProgress() {
    const video = dom.detailVideo;
    const dur = video.duration;
    if (!dur || !isFinite(dur)) return;
    this.#ensureProgressEls();
    const pct = (video.currentTime / dur) * 100;
    this.#trackPlayed.style.width = pct + "%";
    this.#trackThumb.style.left = pct + "%";
    this.#timeTip.style.left = pct + "%";
    const info = `${this.formatTime(video.currentTime)} / ${this.formatTime(dur)}`;
    this.#timeTip.textContent = info;
    dom.detailTime.textContent = info;
    dom.detailProgress.setAttribute("aria-valuenow", String(Math.round(pct)));
    try {
      if (video.buffered.length) {
        this.#trackBuffered.style.width =
          (video.buffered.end(video.buffered.length - 1) / dur) * 100 + "%";
      }
    } catch (_) {}
  }

  #resetVideoProgressUI() {
    this.#ensureProgressEls();
    this.#trackPlayed.style.width = "0%";
    this.#trackThumb.style.left = "0%";
    this.#timeTip.style.left = "0%";
    this.#trackBuffered.style.width = "0%";
    this.#timeTip.textContent = "0:00 / 0:00";
    dom.detailTime.textContent = "0:00 / 0:00";
    dom.detailProgress.setAttribute("aria-valuenow", "0");
  }

  // seek：视频=currentTime；图集=音乐进度（music）或虚拟时钟（virtual），段落随位置切换
  #applySeek(frac) {
    frac = Math.min(Math.max(frac, 0), 1);
    if (dom.detailProgress.classList.contains("note-mode")) {
      const work = this.#noteWork;
      if (!work?.images?.length) return;
      // seek 只重定位轮播周期（music 模式重定基偏移量），音乐本身不跳
      const total = this.#noteTotal();
      if (!total) return;
      if (this.#noteMode === "music") {
        this.#noteSegOffset = dom.detailAudio.currentTime - frac * total;
      } else {
        this.#noteVirtualElapsed = frac * total;
      }
      this.#renderNoteSegs(frac * total, total);
      const seg = Math.min(Math.floor((frac * total) / (total / work.images.length)), work.images.length - 1);
      if (seg !== this.#noteImgIndex) this.#noteShowImage(seg);
      return;
    }
    const video = dom.detailVideo;
    if (video.duration) {
      video.currentTime = frac * video.duration;
      this.#renderVideoProgress();
    }
  }

  #seekProgress(clientX) {
    const rect = dom.detailProgress.getBoundingClientRect();
    const frac = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
    this.#applySeek(frac);
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

  // 离开扩展页面（切标签/最小化，页面转为隐藏）暂停详情播放：
  // 视频 pause 并复位播放按钮（含挂起的重试，避免后台静默续播）；图集停自动轮播
  // （music 模式同步暂停音频），由 main.js 的 visibilitychange 统一触发
  pauseOnHidden() {
    if (dom.detailOverlay.classList.contains("hidden")) return;
    const work = this.getCurrentWork();
    if (!work) return;
    if (work.type === "note" && work.images?.length > 0) {
      this.#noteStopAutoPlay();
      this.#noteUpdatePlayBtn();
      return;
    }
    const video = dom.detailVideo;
    clearTimeout(video._retryTimer);
    if (!video.paused) {
      video.pause();
      dom.detailPlayBtn.innerHTML = config.icons.play;
      dom.detailPlayBtn.title = "播放";
      dom.detailPlayBtn.setAttribute("aria-label", "播放");
    }
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

  // 拉取作品全部媒体为 [{ name, blob }]：视频=单条，图集=逐张。
  // 取流重试内置（DOWNLOAD_MAX_RETRY / FETCH_RETRY_DELAY），失败抛错由调用方计数/汇报。
  fetchWorkMedia(work) {
    return this.#fetchWorkMediaWithRetry(work, 0);
  }

  async #fetchWorkMediaWithRetry(w, attempt) {
    try {
      return await this.#fetchWorkMediaOnce(w);
    } catch (err) {
      if (attempt >= config.DOWNLOAD_MAX_RETRY) throw err;
      await new Promise((r) => setTimeout(r, config.FETCH_RETRY_DELAY));
      return this.#fetchWorkMediaWithRetry(w, attempt + 1);
    }
  }

  async #fetchWorkMediaOnce(work) {
    const entries = [];
    if (work.type === "video" && utils.getVideoUrl(work)) {
      const { blob, ext } = await this.fetchBlob(utils.getVideoUrl(work));
      entries.push({ name: this.getFilename(work, ext), blob });
    } else if (work.type === "note" && work.images?.length) {
      for (const [i, img] of work.images.entries()) {
        const absUrl = utils.pickHttpsUrl(img || "");
        const { blob, ext } = await this.fetchBlob(absUrl);
        entries.push({ name: this.getFilename(work, `${i + 1}.${ext}`), blob });
      }
    }
    return entries;
  }

  // silent=true 时抑制单条失败 toast 并返回成功布尔（批量下载用，聚合汇报由调用方负责）。
  // 视频=单文件直下；图集=打包 zip（全或无：任一张取流失败则整体失败，不产出半成品压缩包）
  async downloadWork(work, { silent = false } = {}) {
    try {
      const entries = await this.fetchWorkMedia(work);
      if (entries.length === 0) return true;
      if (work.type === "video") {
        this.triggerDownload(entries[0].blob, entries[0].name);
      } else {
        const zip = await createZip(entries);
        this.triggerDownload(zip, this.getFilename(work, "zip"));
      }
      return true;
    } catch (err) {
      console.error("[DY] download failed:", err);
      if (!silent) dialog.showToast("下载失败: " + (err.message || "未知错误"), "error");
      return false;
    }
  }
}

export const detail = new Detail();
