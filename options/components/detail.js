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
  // 当前展示作品的 awemeId（字符串）：详情导航按「实际渲染顺序」重锚定的键——网格在
  // 详情打开期间重渲（渐进加载完成整渲/STORE_CHANGED 整刷）时，同一 #index 可能指向
  // 另一作品，靠该键把展示作品钉住、并把 #index 换算到新顺序里的位置
  #currentId = null;
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
  // 图集实况小视频：单例元素复用；#noteClipToken 为播放代际（与 #imgProbeToken 比对失效在途回调）
  #noteClip = null;
  #noteClipToken = 0;
  #rmQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  #reduceMotion() {
    return this.#rmQuery.matches;
  }
  #noteShowImage(idx) {
    this.#noteImgIndex = idx;
    // 切条即停上一条实况小视频（单次播放语义：本条再次进入时才重播）
    this.#stopNoteClip();
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
        dom.detailImage.setAttribute(
          "aria-label",
          this.#noteWork.nickname ? `@${this.#noteWork.nickname}的作品` : "",
        );
        // 本条静帧就位后才起步实况小视频（切条前已由 #stopNoteClip 停掉上一条）。
        // 关键时序：静帧提交是异步探针（网络 + decode），若小视频在探针之前同步上屏，
        // 它会叠在「上一条仍保留的旧静帧背景」之上（零空档切图不先清背景），形成两层
        // 错位叠加——移入提交点后，小视频只在其「同一条」静帧就位时出现，无旧帧残留
        this.#playNoteClip(idx, token);
        // 模糊背景不再逐图跟随（2026-09 性能定案）：全屏 blur(70px) 层随每次背景源
        // 变化整体重光栅化，图集自动播放每 3s 一次 10-50ms 级 paint——背景仅在切作品
        // 时更新一次（首图，见 renderDetail），图内翻页保持
      };
      // decode 保证首帧完整可绘后再提交；decode 失败（罕见）也照常提交——背景失败不可见
      probe.decode().then(doCommit, doCommit);
    };
    probe.onerror = () => {
      if (token !== this.#imgProbeToken) return;
      this.markMediaFail();
    };
    probe.src = url;
  }

  // ---------- 图集实况小视频（note 每条内容项可带 1-8s 静音小视频） ----------
  // 单例元素懒建复用，叠加在 #detailImage 同槽位之上：单次播放、muted、无控件；播完（ended）
  // 隐藏回静帧（静帧已由既有链换高清）；失败静默隐藏，不触熔断计数、不动全页静音偏好
  #ensureNoteClip() {
    if (this.#noteClip) return this.#noteClip;
    const v = document.createElement("video");
    v.className = "note-live-video";
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    // 一次性绑定：守卫播放代际（#stopNoteClip 置 0 失效在途回调）
    v.addEventListener("ended", () => {
      if (this.#noteClipToken !== this.#imgProbeToken) return;
      this.#hideNoteClip();
    });
    v.addEventListener("error", () => {
      if (this.#noteClipToken !== this.#imgProbeToken) return;
      this.#hideNoteClip();
    });
    dom.detailImage.parentElement.appendChild(v);
    this.#noteClip = v;
    return v;
  }

  #playNoteClip(idx, token) {
    const url = utils.pickHttpsUrl(this.#noteWork?.imageVideos?.[idx] || "");
    if (!url) return;
    const v = this.#ensureNoteClip();
    this.#noteClipToken = token;
    if (v.dataset.src !== url) {
      v.dataset.src = url;
      v.src = url;
    } else if (v.currentTime > 0) {
      v.currentTime = 0; // 同一条再次进入：从头重播
    }
    v.classList.add("on");
    v.play().catch(() => {
      if (this.#noteClipToken !== this.#imgProbeToken) return;
      this.#hideNoteClip();
    });
  }

  #hideNoteClip() {
    const v = this.#noteClip;
    if (!v) return;
    v.pause();
    v.classList.remove("on");
  }

  // 停播并失效在途回调（切条/离开页面前）：保留 src 供本条再次进入瞬时重播
  #stopNoteClip() {
    this.#noteClipToken = 0;
    this.#hideNoteClip();
  }

  // 释放（切作品/关闭详情，经 addCleanup）：清 src 释放缓冲
  #releaseNoteClip() {
    const v = this.#noteClip;
    if (!v) return;
    this.#noteClipToken = 0;
    v.pause();
    v.classList.remove("on");
    v.removeAttribute("src");
    v.load();
    delete v.dataset.src;
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
    this.#toggleMediaMute(dom.detailAudio);
  }

  // 全页静音偏好（state.mediaMuted）在详情侧的切换：翻转标志 → 施加到当前详情媒体元素 →
  // 同步按钮 UI 并回写网格卡片元素态（worksGrid.syncMediaMute 覆盖全部已渲染视频卡）
  #toggleMediaMute(el) {
    state.mediaMuted = !state.mediaMuted;
    el.muted = state.mediaMuted;
    this.#syncDetailMuteBtn();
    worksGrid.syncMediaMute();
  }

  // 静音按钮（图标/tooltip/aria）统一从 state.mediaMuted 同步：视频与图集音乐两条渲染路径共用
  #syncDetailMuteBtn() {
    dom.detailMuteBtn.innerHTML = state.mediaMuted ? config.icons.mute : config.icons.unmute;
    const label = state.mediaMuted ? "取消静音" : "静音";
    dom.detailMuteBtn.title = label;
    dom.detailMuteBtn.setAttribute("aria-label", label);
  }

  // ---------- 导航：详情与网格共用「实际渲染顺序」 ----------
  // 虚拟网格的 #viewItems 快照（renderedItems）是用户所见卡片 DOM 的唯一权威顺序
  //（Batch 的 Shift 连选已按此取序）。渐进加载期（作品数排序/加载中途切排序 → 页序与
  // 视图序失配，网格静默累积待完成整渲）视图函数可能已随 dataVersion 增长，而网格仍停在
  // 上一次渲染的顺序——此时按 getWorksView() 现算会让详情全程与网格可见顺序错位。
  // 快照缺失（尚未渲染/清场后）才回退视图函数
  #navList() {
    const rendered = search.activeWorkRecordGrid()?.renderedItems();
    return rendered || search.getWorksView();
  }

  // 展示作品在当前导航列表中的下标：优先按 #currentId 重锚定（网格重渲换了顺序时仍
  // 指向同一作品），查不到（已删除/换域）退回旧下标
  #resolveIndex(list) {
    if (this.#currentId == null) return this.#index;
    const idx = list.findIndex((w) => String(w.awemeId) === this.#currentId);
    return idx === -1 ? this.#index : idx;
  }

  #setCurrent(idx, list) {
    const work = list[idx] || null;
    this.#index = idx;
    this.#currentId = work ? String(work.awemeId) : null;
    return work;
  }

  // Detail 导航与网格共用同一渲染顺序：详情内翻页只在可见（已渲染）条目间进行
  openDetailIndex(awemeId) {
    const list = this.#navList();
    const idx = list.findIndex((w) => String(w.awemeId) === String(awemeId));
    if (idx === -1) return null;
    return this.#setCurrent(idx, list);
  }

  getCurrentWork() {
    const list = this.#navList();
    return list[this.#resolveIndex(list)] || null;
  }

  closeDetailIndex() {
    this.runCleanups();
    this.#index = -1;
    this.#currentId = null;
  }

  nextDetailIndex() {
    const list = this.#navList();
    const idx = this.#resolveIndex(list);
    if (idx < list.length - 1) return this.#setCurrent(idx + 1, list);
    return null;
  }

  prevDetailIndex() {
    const list = this.#navList();
    const idx = this.#resolveIndex(list);
    if (idx > 0) return this.#setCurrent(idx - 1, list);
    return null;
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
    const list = this.#navList();
    const total = list.length;
    if (this.#loopMode === "group" && total > 1) {
      const idx = this.#resolveIndex(list);
      this.#setCurrent(idx < total - 1 ? idx + 1 : 0, list);
      return "group";
    }
    return "off";
  }

  async removeWork(awemeId) {
    // 回顾域：只删回顾引用，来源域记录保留
    if (state.domain === config.REVIEW_DOMAIN) {
      await services.deleteReviewItems(state.reviewSourceDomain, [awemeId]);
      store.removeReviewItemsSilent(new Set([awemeId]), "awemeId");
      state.selectedIds.delete(awemeId);
      search.activeWorkRecordGrid().removeItems(new Set([awemeId]));
      store.refreshGroups();
      search.syncCount();
      return;
    }
    // 作品型三域（作品/点赞/收藏）网格均可打开详情，按当前域删除本地记录
    //（点赞/收藏域仅删本地，远端取消走批量入口）；state.domain 恒属 WORK_RECORD_DOMAINS
    await services.deleteWorkRecord(state.domain, [awemeId]);
    // authorCount 完整视图：本地摘卡并保留稳定顺序，不整域重载；视图不完整（加载中/
    // 分页中断）才回退整域重载。重载传 keepDetail，详情层不因删除而退出
    const authorOrderActive = search.isAuthorOrderActive();
    const patchable = authorOrderActive && search.isAuthorViewPatchable();
    store.removeWorkRecordSilent(state.domain, new Set([awemeId]), {
      preserveAuthorOrder: patchable,
    });
    state.selectedIds.delete(awemeId);
    search.activeWorkRecordGrid().removeItems(new Set([awemeId]));
    store.refreshGroups();
    search.syncCount();
    if (authorOrderActive && !patchable) {
      await search.reloadForPageOrder({ keepDetail: true });
    }
  }

  // 详情移除确认流程：底栏「移除」按钮与 Delete/Backspace 快捷键共用入口（确认弹窗，不直接删）
  #confirmRemoveCurrent() {
    const work = this.getCurrentWork();
    if (!work) return;
    // 点赞/收藏域的详情「移除」仅删本地记录（远端取消走批量入口），文案区分。
    // 回顾域移除的是回顾引用，来源域数据不变。
    const isReview = state.domain === config.REVIEW_DOMAIN;
    const localOnly = config.WORK_RECORD_DOMAINS.includes(state.domain) && state.domain !== "works";
    const removeBody = document.createElement("p");
    removeBody.className = "confirm-delete-msg";
    const label = work.nickname ? `「@${work.nickname}的作品」` : "「该作品」";
    removeBody.textContent = isReview
      ? `确定要从回顾批次移除${label}？来源域数据不会被删除。`
      : localOnly
        ? `确定要从${config.DOMAINS_META[state.domain].label}域移除${label}？远端点赞/收藏不受影响。`
        : `确定要移除${label}？`;
    dialog.showDialog("移除作品", removeBody, [
      {
        text: "移除",
        danger: true,
        callback: async () => {
          dialog.updateDialog("正在移除…", "");
          state.preventDialogClose = true;
          try {
            // 删除前记下当前视图下标：本地摘卡后原下标处即「下一件」；authorCount
            // 兜底重载会换序，重载后仍按该下标钳制顺延
            const beforeIndex = this.#resolveIndex(this.#navList());
            await this.removeWork(work.awemeId);
            // 兜底重载期间用户若已关闭详情（防御），只收尾弹窗与提示
            if (dom.detailOverlay.classList.contains("hidden")) {
              dialog.closeDialog();
              dialog.showToast("已移除该作品", "success");
              return;
            }
            // 移除后导航列表同步收缩：原下标处已是「下一件」，越界钳到末条并按新条目重锚定
            const list = this.#navList();
            if (list.length === 0) {
              this.closeDetail();
            } else {
              const at = Math.min(Math.max(beforeIndex, 0), list.length - 1);
              this.#setCurrent(at, list);
              this.renderDetail();
            }
            // 成功终态不再要求"好的"确认
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
    const list = this.#navList();
    const total = list.length;
    // 图集顺序位（视频模式此位显示 detailTime，不由此处写入）
    if (work.type === "note" && work.images?.length) {
      dom.detailOrder.textContent = `${this.#noteImgIndex + 1}/${work.images.length}`;
    }
    // 播放条最右端：作品序号（K 为输入框，Enter 提交跳转 / Esc 还原，见 #commitCounterJump）
    if (total > 1) {
      dom.detailCounterInput.value = String(this.#resolveIndex(list) + 1);
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
    input.style.width = `${Math.max(String(this.#navList().length).length, input.value.length)}ch`;
  }

  #revertCounterInput() {
    const list = this.#navList();
    dom.detailCounterInput.value = String(this.#resolveIndex(list) + 1);
    this.#resizeCounterInput();
  }

  // K 提交跳转：非数字/越界钳制到 [1, N]；相邻序号保留方向感过渡（与 ↑/↓ 同语义），远跳走普通淡入。
  // 关详情后网格滚动恢复走既有 restoreGridScroll，跳转结果自然落位
  #commitCounterJump() {
    const list = this.#navList();
    const total = list.length;
    const k = parseInt(dom.detailCounterInput.value, 10);
    if (total === 0 || !Number.isFinite(k)) return this.#revertCounterInput();
    const target = Math.min(Math.max(k, 1), total) - 1;
    const cur = this.#resolveIndex(list);
    if (target === cur) return this.#revertCounterInput();
    const dir = Math.abs(target - cur) === 1 ? (target > cur ? 1 : -1) : 0;
    this.#setCurrent(target, list);
    this.renderDetail(dir);
  }

  // 加载指示复位
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

  // Tab 焦点圈定：焦点在 overlay 内循环。
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

  // dir: 1 下一作品 / -1 上一作品 / 0 无方向（首次打开或循环回跳），驱动方向感过渡
  renderDetail(dir = 0) {
    const isSwitch = !dom.detailOverlay.classList.contains("hidden");
    const body = dom.detailBody;
    if (isSwitch) {
      body.classList.add("detail-transitioning");
    }
    // 方向感入场：先清旧类再强制 reflow，保证同向连续切换也能重放动画；
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
        dom.detailAuthor.classList.remove("hidden");
      } else {
        dom.detailAuthor.classList.add("hidden");
      }

      const typePath = work.type === "note" ? "note" : "video";
      dom.detailVisit.href = `${config.URL_BASE}/${typePath}/${work.awemeId}`;
      dom.detailVisit.textContent = String(work.awemeId);
      dom.detailCreateTime.textContent = utils.formatPublishDate(work.createTime);
      dom.detailCreateTime.classList.toggle("hidden", !dom.detailCreateTime.textContent);

      this.updateLoopBtn(isVideo);

      this.#updateCounters(work);
      this.#resetMediaStatus(isVideo);

      // 安全兜底：10 秒后强制结束过渡（防网络异常卡死）；正常结束由 onReady 清理。
      // 必须登记 cleanup：切作品后旧定时器不得再摘新过渡的 class
      let transitionTimer = 0;
      if (isSwitch) {
        transitionTimer = setTimeout(() => body.classList.remove("detail-transitioning"), 10000);
        this.addCleanup(() => clearTimeout(transitionTimer));
      }
      const onReady = () => {
        clearTimeout(transitionTimer);
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
          dom.detailImage.setAttribute("aria-label", work.nickname ? `@${work.nickname}的作品` : "");
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
    const readyFn = onReady;
    video.src = utils.getVideoUrl(work);

    // 加载指示：canplay 前亮 spinner
    dom.detailLoader.classList.remove("hidden");

    // 全页静音偏好跨作品保留：从 state.mediaMuted 施加到本作品（图集音乐同源，视频↔图集切换不丢）
    video.muted = state.mediaMuted;
    this.#syncDetailMuteBtn();

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
        // 自动播放被浏览器拦截：强制静音换播放权，并写入全页静音偏好（网格预览/后续作品沿用）
        state.mediaMuted = true;
        video.muted = true;
        this.#syncDetailMuteBtn();
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

    const readyFn = onReady;
    // 图片加载完成时结束过渡
    let readyFired = false;
    const fireReady = () => {
      if (readyFired) return;
      readyFired = true;
      readyFn();
    };
    // 切到新作品先清空上个作品的图，避免链接失效时残留上一作品内容
    this.#clearDetailImage();
    // 先加载 cover：网格卡已加载过同一 cover 大概率命中缓存，探针通过即先落为占位；
    // 高清首帧（images[0]）随后经独立探针静默替换（见下方 up）。候选去重防 cover 与
    // 首帧同 URL 重复加载；全部失败才进失效态。期间无 aria-label，杜绝中央区闪现
    // 无障碍文本（见 #clearDetailImage）
    const candidates = [...new Set([
      utils.pickHttpsUrl(work.cover || ""),
      utils.pickHttpsUrl(work.images?.[0] || ""),
    ].filter(Boolean))];
    if (!candidates.length) {
      this.#showImageFailed();
      fireReady();
    } else {
      const token = ++this.#imgProbeToken;
      this.#playNoteClip(0, token);
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
          dom.detailImage.setAttribute("aria-label", work.nickname ? `@${work.nickname}的作品` : "");
          fireReady();
          // 占位后换高清首帧：cover 命中网格缓存先落屏（瞬开），原图到达再替换（图集详情
          // 要原图细节）。静默换图不加熔断计数（与「单条候选失效不计数」同口径）
          const hiRes = utils.pickHttpsUrl(work.images?.[0] || "");
          if (i === 0 && hiRes && hiRes !== candidates[0]) {
            const up = new Image();
            up.onload = () => {
              if (token !== this.#imgProbeToken) return; // 翻页/重渲自增代际
              if (this.#noteWork !== work || this.#noteImgIndex !== 0) return; // 已翻走
              if (dom.detailOverlay.classList.contains("hidden")) return; // closeDetail 不清代际
              this.#setMediaAspect(up.naturalWidth, up.naturalHeight);
              dom.detailImage.style.backgroundImage = utils.cssUrl(hiRes);
            };
            up.src = hiRes;
          }
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
      // 全页静音偏好跨作品保留：从 state.mediaMuted 施加到本作品（视频同源）
      audio.muted = state.mediaMuted;
      this.#syncDetailMuteBtn();

      audio.play().catch((err) => {
        if (err.name === "NotAllowedError") {
          // 同视频路径：拦截即强制静音并写入全页偏好
          state.mediaMuted = true;
          audio.muted = true;
          this.#syncDetailMuteBtn();
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
    this.addCleanup(() => this.#releaseNoteClip());
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
      // 弹窗叠于详情层之上时全部让位（Space/M/L/方向键/删除键不穿透）；Esc 不经本监听，
      // 由 main.js 的 Esc 收口统一裁决（一次按键只关一层）
      if (!dom.dialogOverlay.classList.contains("hidden")) return;
      // Tab 焦点圈定
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
      // 播放控制快捷键：焦点在控件上时不拦截——Space 应触发聚焦按钮的原生点击、
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

    // 底栏作者与作品 awemeId 均为真实链接（新标签页打开），无需额外点击逻辑

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
    //（stopPropagation 拦在 document 层 Esc 单点收口（关弹窗/退出详情）之前）、失焦还原——展示值与当前作品恒一致
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

  // dir 透传给 renderDetail 驱动方向感过渡
  nextDetail(dir = 1) {
    if (this.nextDetailIndex()) this.renderDetail(dir);
  }

  prevDetail(dir = -1) {
    if (this.prevDetailIndex()) this.renderDetail(dir);
  }

  closeDetail() {
    // 先在索引复位前记录展示作品的 awemeId，供关闭后滚回同一张卡：网格在详情打开期间
    // 可能已重渲（顺序变化），按下标恢复会落到另一张卡，故按 id 定位（见 restoreGridScroll）
    const restoredId = this.#currentId;
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
    // 按当前来源域的活动网格恢复（回顾模式下是随机网格；普通模式是当前域网格）。
    // 作者域网格没有 restoreGridScroll，必须按能力调用，避免作者域关闭详情时报错
    const activeGrid = search.activeWorkRecordGrid();
    if (typeof activeGrid?.restoreGridScroll === "function") {
      activeGrid.restoreGridScroll(restoredId);
    }
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
    this.#stopNoteClip();
    dom.detailImage.style.backgroundImage = "";
    // div 载体以 role="img" + aria-label 提供无障碍标注，清空杜绝加载期中央区闪现无障碍文本
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
      // 缓冲段可视化：已播放实白、缓冲半透明白、未缓冲底色
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
    this.#toggleMediaMute(dom.detailVideo);
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
      this.#stopNoteClip();
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
    // 作者 uid 稳定、昵称会变/可重名；uid 缺失时整段省略，awemeId 始终保留（唯一主键）
    const uid = String(work.uid || "").replace(/[\\/:*?"<>|]/g, "_");
    const segments = [nick];
    if (uid) segments.push(uid);
    segments.push(work.awemeId);
    return `${segments.join("_")}.${ext}`;
  }

  async fetchBlob(url, signal) {
    const resp = await fetch(url, { signal });
    if (!resp.ok) {
      // 404/410 = 媒体对象已不存在（作品删除/私密/审核中/仅好友可见等），归为「不可用」：
      // 调用方跳过且不重试；其余状态码仍按下载失败处理（403 多为图片签名过期，可重同步修复）
      const err = new Error(`HTTP ${resp.status}`);
      err.code = resp.status === 404 || resp.status === 410 ? "MEDIA_UNAVAILABLE" : "HTTP_ERROR";
      err.status = resp.status;
      throw err;
    }
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
  // 取流重试内置（DOWNLOAD_MAX_RETRY / FETCH_RETRY_DELAY），失败抛错由调用方计数/汇报；
  // signal 供批量下载取消使用（abort 立即中断在途 fetch，且不进入重试）
  fetchWorkMedia(work, signal) {
    return this.#fetchWorkMediaWithRetry(work, 0, signal);
  }

  async #fetchWorkMediaWithRetry(w, attempt, signal) {
    try {
      return await this.#fetchWorkMediaOnce(w, signal);
    } catch (err) {
      // 不可用是确定性结果，重试同一死链无意义；用户取消（signal.aborted）同样不重试
      if (signal?.aborted || err.code === "MEDIA_UNAVAILABLE" || attempt >= config.DOWNLOAD_MAX_RETRY) throw err;
      await new Promise((r) => setTimeout(r, config.FETCH_RETRY_DELAY));
      return this.#fetchWorkMediaWithRetry(w, attempt + 1, signal);
    }
  }

  async #fetchWorkMediaOnce(work, signal) {
    const entries = [];
    if (work.type === "video" && utils.getVideoUrl(work)) {
      const { blob, ext } = await this.fetchBlob(utils.getVideoUrl(work), signal);
      entries.push({ name: this.getFilename(work, ext), blob });
    } else if (work.type === "note" && work.images?.length) {
      for (const [i, img] of work.images.entries()) {
        const absUrl = utils.pickHttpsUrl(img || "");
        const { blob, ext } = await this.fetchBlob(absUrl, signal);
        entries.push({ name: this.getFilename(work, `${i + 1}.${ext}`), blob });
      }
    }
    return entries;
  }

  // 视频=单文件直下；图集=打包 zip（全或无：任一张取流失败则整体失败，不产出半成品压缩包）
  async downloadWork(work) {
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
      // 不可用（404/410）属用户已知情况，不按下载失败报错。
      // 日志统一 info/debug：console.warn/error 会被 chrome://extensions 错误面板收录
      if (err.code === "MEDIA_UNAVAILABLE") {
        console.debug("[DY] work unavailable:", work?.awemeId);
        dialog.showToast("该作品已不可访问（可能已删除或设为私密）", "info");
        return false;
      }
      console.info("[DY] download failed:", err);
      dialog.showToast("下载失败: " + (err.message || "未知错误"), "error");
      return false;
    }
  }
}

export const detail = new Detail();
