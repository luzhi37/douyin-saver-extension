// ---------- Sidebar ----------
import { config, dom, state, store, utils, services } from '../core.js';
import { search } from './search-bar.js';
import { detail } from './detail.js';
import { dialog } from './dialog.js';
import { authorImport } from '../sync/author-import.js';

// ---------- Sidebar ----------
class Sidebar {
  static STORAGE_KEY = "douyin_sidebar_width";
  // 展开默认落到 3 列（各域一致）；档位总数由可用宽度上限决定，不设固定上限——
  // 上限由 #availableMax 天然决定（主网格只剩 1 列可读卡时的宽度），窗口放不下
  // 目标档时自动回退到最大可用档（2/1 列）
  static DEFAULT_COLS = 3;
  #dragStartX = 0;
  #dragStartW = 0;
  #dragMoved = false;
  // 拖拽会话内缓存的展开宽度可用上限：mousemove 期 rect 读会强制 flush 在途 rAF 落宽，
  // 每次拖拽在 #onResizeDown 读一次缓存复用（见 #snapDragWidth）
  #dragAvailMax = 0;
  // 滚动条槽宽缓存（-1 = 未测；0 = 平台用 overlay 滚动条不计宽）
  #sbGutter = -1;
  // 因窗口过窄被「被动收起」前的宽度：窗口回宽后按此恢复（0 = 无待恢复）。
  // 用户主动收起/切域落盘 0 时清空，避免把强制收起误判成用户意愿。
  #autoCollapsedWidth = 0;
  #pendingSidebarWidth = 0;
  #pendingSidebarWidthDirty = false;
  #pendingSidebarWidthRafId = 0;
  #scrollRafPending = false;
  #imgQueue = [];
  #imgDrainRafId = 0;
  #sideFillObs = null;
  #sideUnloadObs = null;
  #workMeta = new WeakMap();
  // 悬停预览：当前预览条目、起播延迟定时器、最近指针坐标（滚动重判保鲜）、重判 rAF
  #previewItem = null;
  #previewTimer = 0;
  #pointer = { x: 0, y: 0 };
  #hoverRecheckRaf = 0;
  // 入库/移除进行中的作品 id 集：防双击重入 + 滚动重建后按钮禁用态回填
  #pendingSaves = new Set();
  // 作者头「加入候选域」进行中：防双击重入
  #pendingCandidateAdd = false;
  // 作者头「导入作品域」进行中：禁用入口防重复发起（authorImport 内部互斥再兜一层）
  #pendingImportWorks = false;
  // 点赞/收藏进行中的 `${domain}:${awemeId}` 集：防双击重入 + 指示按钮禁用态回填
  #pendingReactions = new Set();
  // 侧栏分页代际：切换作者时自增，作废上一作者在途回包（不得写入已清空的列表）
  #loadToken = 0;
  // 作者头数据：当前作者摘要 + 已加载作品数；头像探针代际防止旧作者回包覆盖新头
  #currentAuthor = null;
  #headerLoaded = 0;
  #avatarToken = 0;
  // 侧栏跨各域共用（关注/候选由作者卡打开，作品/点赞/收藏/回顾点击作者名打开）：
  // 展开/拖宽/锚点一律作用于当前域的活动网格
  #activeGrid() {
    return search.gridForDomain();
  }
  #onResizeDown = (e) => {
    this.#dragStartX = e.clientX;
    this.#dragStartW = dom.sidebar.classList.contains("sidebar-zero") ? 0 : dom.sidebar.getBoundingClientRect().width;
    this.#dragAvailMax = this.#availableMax();
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
    // 收起态（#dragStartW = 0）拖拽不改宽度：折叠/展开只经分割条点击
    if (!this.#dragStartW) return;
    const width = this.#snapDragWidth(this.#dragStartW - (e.clientX - this.#dragStartX));
    this.#pendingSidebarWidth = width;
    this.#pendingSidebarWidthDirty = true;
    if (this.#pendingSidebarWidthRafId) return;
    this.#pendingSidebarWidthRafId = requestAnimationFrame(() => {
      this.#pendingSidebarWidthRafId = 0;
      if (this.#pendingSidebarWidthDirty) {
        this.#pendingSidebarWidthDirty = false;
        this.setSidebarWidth(this.#pendingSidebarWidth);
        this.#activeGrid().syncContainerWidth();
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
    // 收起态会话（拖拽不展开）：无宽度变更，直接结束
    if (!this.#dragStartW) return;
    const finalWidth = this.#snapDragWidth(dom.sidebar.getBoundingClientRect().width);
    // 拖拽释放吸附到最近可用档位，跨列阈值时同样锚定视口内最上方卡片——补偿由网格
    // 统一完成（见 #preserveAnchor），点击任务不做几何读取
    this.setSidebarWidth(finalWidth);
    this.saveSidebarWidth(finalWidth);
    this.#activeGrid().syncContainerWidth();
  };

  // 点击分割条：收起（落盘 0，与拖拽收起语义一致）；展开恢复上次保存的宽度。
  // 开关都会改变主网格列数（卡片跨列阈值时跳位），锚点补偿由网格 RO 回调负责，
  // 开关前后把视口内最上方卡拉回原 Y，避免用户丢失视觉参考
  toggleSidebar() {
    if (dom.sidebar.classList.contains("sidebar-zero")) {
      // 侧栏内容恒绑定作者上下文：无作者时展开只会得到一个空面板，改为提示入口
      if (!state.currentAuthorSecUid) {
        dialog.showToast(
          utils.isAuthorRecordDomain()
            ? "先点击一张作者卡，再展开作品栏"
            : "先点击作品的作者名，再展开作品栏",
        );
        return;
      }
      const target = this.#expandWidth();
      this.setSidebarWidth(target);
      this.saveSidebarWidth(target);
    } else {
      this.setSidebarWidth(0);
      this.saveSidebarWidth(0);
    }
    this.#activeGrid().syncContainerWidth();
  }

  initSidebar() {
    // 档位卡宽/间距/内边距注入 CSS 变量（单一来源 config，CSS 端 var() 兜底同值）：
    // 轨宽恒等于档位卡宽（auto-fill 排出 N 列恰好铺满档位宽度），与主网格卡宽解耦
    const gridStyle = dom.sidebarWorksGrid.style;
    gridStyle.setProperty("--sb-card-size", config.SIDEBAR_CARD_SIZE + "px");
    gridStyle.setProperty("--sb-grid-gap", config.SIDEBAR_GRID_GAP + "px");
    gridStyle.setProperty("--sb-grid-padding", config.SIDEBAR_GRID_PADDING + "px");
    // 保存宽度（含历史值）吸附到最近可用档恢复；窗口放不下 1 列档时归 0 收起。
    // 侧栏内容恒绑定作者上下文：作品型三域启动不恢复宽度（此时无作者，展开只会是空面板）
    const savedWidth = utils.isAuthorRecordDomain() ? this.#loadWidth() : 0;
    this.setSidebarWidth(savedWidth ? this.#resolveWidth(savedWidth) : 0);
    this.#initResize();
    dom.sidebarAuthorClose.addEventListener("click", () => {
      if (!dom.sidebar.classList.contains("sidebar-zero")) this.toggleSidebar();
    });
    dom.sidebarAuthorImportWorks.addEventListener("click", () => this.#importAuthorWorks());
    dom.sidebarAuthorAddCandidate.addEventListener("click", () => this.#addAuthorToCandidates());
    dom.sidebarAuthorRemoveCandidate.addEventListener("click", () => this.#removeAuthorFromCandidates());
    dom.sidebarAuthorRefresh.addEventListener("click", () => this.refreshAuthorWorks());
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
    // 存入/点赞/收藏按钮：容器级委托（一次绑定跨整个会话；卡片节点增删不重绑）。
    // 信息条在 .sidebar-work-link 之外，命中即吞事件，绝不触发外链跳转
    dom.sidebarWorksGrid.addEventListener("click", (e) => {
      const saveBtn = e.target.closest(".sidebar-work-save");
      if (saveBtn) {
        e.stopPropagation();
        e.preventDefault();
        this.#toggleSaveWork(saveBtn);
        return;
      }
      const reactionBtn = e.target.closest(".sidebar-presence");
      if (reactionBtn) {
        e.stopPropagation();
        e.preventDefault();
        this.#setReaction(reactionBtn);
        return;
      }
      // 封面外链点击：预览立即停（新标签页打开时指针不一定移出，不能依赖 pointerout）
      const workLink = e.target.closest(".sidebar-work-link");
      if (workLink) this.#stopPreview(workLink.closest(".sidebar-work-item"));
    });

    // 悬停预览委托：pointerenter/leave 不冒泡，用冒泡的 pointerover/out + relatedTarget
    // 判「跨界只触发一次」；pointermove 保鲜指针坐标、sidebarBody 滚动后按最新坐标重判，
    // 补「滚动把条目从指针下移走、浏览器不补发 pointerout」的停播收口（同作品卡悬停预览）
    dom.sidebarWorksGrid.addEventListener("pointerover", (e) => {
      this.#pointer.x = e.clientX;
      this.#pointer.y = e.clientY;
      const link = e.target.closest?.(".sidebar-work-link");
      if (!link) return;
      if (e.relatedTarget && link.contains(e.relatedTarget)) return;
      const item = link.closest(".sidebar-work-item");
      if (!item || item === this.#previewItem) return;
      // 先停上一张再判守卫：弹窗/熔断命中时也必须停掉旧预览，否则旧预览成音频残留
      if (this.#previewItem) this.#stopPreview(this.#previewItem);
      if (!dom.dialogOverlay.classList.contains("hidden")) return;
      if (detail.mediaRetryBlocked()) return;
      const meta = this.#workMeta.get(item);
      if (!meta || !meta.videoUrl) return;
      this.#previewItem = item;
      clearTimeout(this.#previewTimer);
      this.#previewTimer = setTimeout(() => this.#startPreview(item), config.HOVER_PREVIEW_DELAY);
    });
    dom.sidebarWorksGrid.addEventListener("pointerout", (e) => {
      this.#pointer.x = e.clientX;
      this.#pointer.y = e.clientY;
      const link = e.target.closest?.(".sidebar-work-link");
      if (!link) return;
      if (e.relatedTarget && link.contains(e.relatedTarget)) return;
      const item = link.closest(".sidebar-work-item");
      if (!item || item !== this.#previewItem) return;
      this.#stopPreview(item);
    });
    dom.sidebarWorksGrid.addEventListener(
      "pointermove",
      (e) => {
        this.#pointer.x = e.clientX;
        this.#pointer.y = e.clientY;
      },
      { passive: true },
    );
    dom.sidebarBody.addEventListener("scroll", () => this.#scheduleHoverRecheck(), { passive: true });
  }

  setSidebarWidth(w) {
    document.documentElement.style.setProperty("--sidebar-live-width", w > 0 ? w + "px" : "0px");
    if (w === 0) {
      // 收起即视线离开列表：停掉悬停预览，避免面板不可见时音频继续
      this.stopAllMedia();
      dom.sidebar.classList.add("sidebar-zero");
      dom.sidebar.style.width = "";
      // 分割条常驻（折叠态保留 6px 可点击条）：展开只经点击，无拖拽展开手势
    } else {
      dom.sidebar.classList.remove("sidebar-zero");
      dom.sidebar.style.width = w + "px";
    }
  }

  saveSidebarWidth(width) {
    // 主动收起 / 切域归零：清掉「被动收起」待恢复标记，窗口回宽不得自动弹开
    if (width === 0) this.#autoCollapsedWidth = 0;
    localStorage.setItem(Sidebar.STORAGE_KEY, String(width));
  }

  // 窗口缩窄时向下钳制展开宽度（不覆写保存偏好）；因过窄被收起到 0 的情况记下原宽度，
  // 窗口回宽后自动恢复——用户主动收起不在此列（见 saveSidebarWidth 的清标记）。
  clampOpenWidth() {
    if (dom.sidebar.classList.contains("sidebar-zero")) {
      if (!this.#autoCollapsedWidth) return;
      const target = this.#resolveWidth(this.#autoCollapsedWidth);
      if (!target) return;
      this.#autoCollapsedWidth = 0;
      this.setSidebarWidth(target);
      this.#activeGrid().syncContainerWidth();
      return;
    }
    const width = dom.sidebar.getBoundingClientRect().width;
    const clamped = this.#resolveWidth(width);
    if (clamped < width) {
      // 只记录「收到 0」的场景；3 列→1 列这类降档不参与回宽恢复
      this.#autoCollapsedWidth = clamped === 0 ? width : 0;
      this.setSidebarWidth(clamped);
      this.#activeGrid().syncContainerWidth();
    }
  }

  clearSidebarActive() {
    for (const active of dom.mainContainer.querySelectorAll(".sidebar-active")) {
      active.classList.remove("sidebar-active");
    }
  }

  // 打开作品栏：author = { uid, nickname, profileUrl }（作者域传 Following 记录，作品型三域
  // 传 Work 归一化的作者摘要）；sourceCard 为点击源卡（作品卡传入；作者域可省略，按 uid 查卡）
  openSidebar(author, sourceCard = null) {
    const secUid = utils.secUidFromUrl(author.profileUrl);
    if (!secUid) {
      dialog.showToast("该作者缺少主页标识，无法打开作品栏", "error");
      return;
    }

    this.clearSidebarActive();
    const card = sourceCard?.isConnected
      ? sourceCard
      : dom.mainContainer.querySelector(`[data-uid="${author.uid}"]`);
    if (card) card.classList.add("sidebar-active");

    // 分页代际自增：作废上一作者在途回包（其结果不得写入已清空的列表）
    this.#loadToken++;
    state.currentAuthorSecUid = secUid;
    state.sidebarCursor = null;
    state.sidebarLoading = false;
    this.#headerLoaded = 0;
    this.#applyAuthorHead(author);
    // 作品型三域的摘要没有头像/统计；已打开作者域也可能缺少头像——都由后台按 uid 补一次
    this.#hydrateAuthorHead(author.uid);
    // 作者域已由侧栏校准回写精准计数；其余域（作品型/回顾）并行取 profile 作品数/粉丝数补头，
    // 不阻塞作品列表分页
    if (!config.AUTHOR_RECORD_DOMAINS.includes(state.domain)) this.#hydrateAuthorStats(secUid);

    const needsExpand = dom.sidebar.classList.contains("sidebar-zero");
    if (needsExpand) {
      const target = this.#expandWidth();
      // 锚定被点击卡片：展开使网格减列、该卡下移，补偿后保持在原视口 Y 供用户定位参考
      this.#preserveAnchor(card, () => {
        this.setSidebarWidth(target);
        this.saveSidebarWidth(target);
      });
    }

    this.#resetSidebarGrid();
    this.loadSidebarWorks(state.currentAuthorSecUid, null, true);
    // 校准只对作者域记录有效（作品型三域没有可回写的作者记录）
    if (config.AUTHOR_RECORD_DOMAINS.includes(state.domain)) this.#calibrateFollowing(author);
  }

  // 作者身份头：作者域使用完整档案，作品型三域使用点击时已获得的作者摘要；
  // 同 UID 的另一作者域记录（若已加载）只用于补缺失头像/昵称，不回写任何域数据。
  // 候选域历史记录可能只有 avatar 或头像字段为空，不能只看 avatarLarger。
  #applyAuthorHead(author) {
    const uid = String(author.uid);
    // 优先查“另一个作者域”的记录补档案字段（当前域对象本身无需再查）；
    // 作品型三域两侧都可作为已知作者摘要来源
    const known =
      state.domain === "candidates"
        ? state.followings.find((f) => String(f.uid) === uid)
        : state.domain === "followings"
          ? state.candidates.find((f) => String(f.uid) === uid)
          : state.followings.find((f) => String(f.uid) === uid) ||
            state.candidates.find((f) => String(f.uid) === uid) ||
            null;
    const info = { ...known, ...author };
    info.nickname = info.nickname || known?.nickname || "未知作者";
    info.avatarLarger =
      info.avatarLarger || info.avatar || known?.avatarLarger || known?.avatar || "";
    this.#currentAuthor = info;
    this.#renderAuthorHead();
    this.#syncCandidateAction();
  }

  #renderAuthorHead() {
    const info = this.#currentAuthor;
    if (!info) return;
    const name = info.nickname || "未知作者";
    dom.sidebarAuthorName.textContent = `@${name}`;
    dom.sidebarAuthorAvatar.setAttribute("aria-label", name);

    const status = state.domain === "followings" ? "关注" : state.domain === "candidates" ? "候选" : "";
    dom.sidebarAuthorStatus.textContent = status;
    dom.sidebarAuthorStatus.classList.toggle("hidden", !status);

    // 昵称本身即作者主页入口，不再额外放独立主页按钮
    const profileUrl = info.profileUrl || "";
    if (profileUrl) dom.sidebarAuthorName.href = profileUrl;
    else dom.sidebarAuthorName.removeAttribute("href");

    this.#loadAuthorAvatar();
    this.#syncAuthorHeadMeta();
  }

  // 作品型三域只有作者摘要（无头像/计数）：按 uid 从 background 一次取关注/候选档案补头。
  // 候选域记录缺头像时同样能借关注域记录；失败静默保留摘要，不阻塞作品栏加载。
  async #hydrateAuthorHead(uid) {
    if (!uid) return;
    const token = this.#loadToken;
    const records = await services.loadAuthorByUid(uid);
    if (!records || token !== this.#loadToken) return;
    const info = this.#currentAuthor;
    if (!info || String(info.uid) !== String(uid)) return;
    // 档案主键直取结果即权威成员资格：关注/候选任一存在即隐藏「加入候选域」入口
    this.#syncCandidateAction(Boolean(records.followings), Boolean(records.candidates));
    const found = [records.candidates, records.followings].filter(Boolean);
    if (!found.length) return;

    const withAvatar = found.find((r) => r.avatarLarger || r.avatar);
    const url = info.avatarLarger || info.avatar || withAvatar?.avatarLarger || withAvatar?.avatar || "";
    if (url) info.avatarLarger = url;
    for (const r of found) {
      if (!info.followerCount && r.followerCount) info.followerCount = r.followerCount;
      if (!info.awemeCount && r.awemeCount) info.awemeCount = r.awemeCount;
      if (!info.lastUpdateAt && r.lastUpdateAt) info.lastUpdateAt = r.lastUpdateAt;
    }
    this.#renderAuthorHead();
  }

  // 作者头精准统计（作品型三域/回顾域）：profile/other 按 secUid 只读取权威作品数/粉丝数，
  // 与作品列表并行；失败静默保留存储摘要。代际 + secUid 双校验防止切换作者后旧回包覆盖新头
  async #hydrateAuthorStats(secUid) {
    const token = this.#loadToken;
    const res = await services.loadAuthorStats(secUid);
    if (!res || token !== this.#loadToken || state.currentAuthorSecUid !== secUid) return;
    const info = this.#currentAuthor;
    if (!info) return;
    if (info.uid && String(info.uid) !== String(res.uid)) return;
    // 0 值可能是平台真实 0 作品/隐私不可见：只在 >0 时覆盖，避免把已有值降级为 0
    if (res.awemeCount > 0) info.awemeCount = res.awemeCount;
    if (res.followerCount > 0) info.followerCount = res.followerCount;
    if (res.avatarLarger && !info.avatarLarger) info.avatarLarger = res.avatarLarger;
    if (res.nickname && !info.nickname) info.nickname = res.nickname;
    this.#renderAuthorHead();
  }

  // 头部副标题只保留两段：已加载 / 作者作品总数 + 最近更新日期（粉丝数移出，避免信息过载）
  #syncAuthorHeadMeta() {
    const info = this.#currentAuthor;
    if (!info) return;
    const total = info.awemeCount;
    const count = total != null && total > 0 ? `${this.#headerLoaded} / ${utils.formatCount(total)} 作品` : `${this.#headerLoaded} 作品`;
    dom.sidebarAuthorSub.textContent = info.lastUpdateAt ? `${count} · ${utils.formatUpdateTime(info.lastUpdateAt)}` : count;
  }

  // 作者头候选域两入口：「加入候选域」只在作者既不在关注域也不在候选域时显示；
  // 「从候选域移除」只在作者确在候选域时显示。followed/isCandidate 由 GET_AUTHOR_BY_UID
  // 主键直取结果传入（权威）；取回前按当前域与作者主键集推断（作者域当前记录本身即成员资格）
  #syncCandidateAction(followed = null, isCandidate = null) {
    const addBtn = dom.sidebarAuthorAddCandidate;
    const removeBtn = dom.sidebarAuthorRemoveCandidate;
    if (!addBtn) return;
    const info = this.#currentAuthor;
    if (!info?.uid) {
      addBtn.classList.add("hidden");
      removeBtn?.classList.add("hidden");
      return;
    }
    const uid = String(info.uid);
    let known;
    let candidate;
    if (followed !== null || isCandidate !== null) {
      // 主键集并集兜底：刚由本入口收录的作者，档案回包可能仍早于入库（在途回包不得重新露出入口）
      candidate = Boolean(isCandidate) || state.candidateUids.has(uid);
      known = Boolean(followed) || candidate || state.followedUids.has(uid);
    } else if (config.AUTHOR_RECORD_DOMAINS.includes(state.domain)) {
      known = true;
      candidate = state.domain === "candidates" || state.candidateUids.has(uid);
    } else if (state.domain === config.REVIEW_DOMAIN && state.reviewKind === "authors") {
      // 回顾作者批次回源自关注/候选两域，作者必在其中一个域；候选成员资格仍以主键集为准
      known = true;
      candidate = state.candidateUids.has(uid);
    } else {
      known = state.followedUids.has(uid) || state.candidateUids.has(uid);
      candidate = state.candidateUids.has(uid);
    }
    addBtn.classList.toggle("hidden", known);
    removeBtn?.classList.toggle("hidden", !candidate);
  }

  // header 快捷收录：IMPORT_CANDIDATE 单请求（与工具弹窗候选入库同一条链路）。
  // 成功后同步本地候选主键集并隐藏入口；added=0（已在候选域）同样收口
  async #addAuthorToCandidates() {
    const btn = dom.sidebarAuthorAddCandidate;
    const secUid = state.currentAuthorSecUid;
    const info = this.#currentAuthor;
    if (!btn || !secUid || !info?.uid || this.#pendingCandidateAdd) return;
    const uid = String(info.uid);
    this.#pendingCandidateAdd = true;
    btn.disabled = true;
    try {
      const res = await services.bgMsg({ type: "IMPORT_CANDIDATE", secUid });
      if (!res || res.ok !== true) {
        const msg = res?.error || "未知错误";
        if (msg === "NO_SIGNATURE") {
          dialog.showNoSignatureDialog(config.URL_BASE + "/user/" + secUid, "作品", "加入候选域");
          return;
        }
        dialog.showToast(msg.includes("2096") ? "该账号因隐私设置不可见" : "加入候选域失败: " + msg, "error");
        return;
      }
      state.candidateUids.add(uid);
      const nick = res.candidate?.nickname || info.nickname || "未知";
      // 兜底文案与 shared/domains.js DEFAULT_GROUPS 的「未分组」保持一致
      const groupName = res.groupName || "未分组";
      dialog.showToast(
        res.added > 0
          ? `已加入候选域：${nick}（入「${groupName}」）`
          : `作者已在候选域：${nick}（分组「${groupName}」）`,
        "success",
      );
      // 等待期间已切换作者：不改当前头（入口态由新作者的同步流程决定）
      if (state.currentAuthorSecUid === secUid) this.#syncCandidateAction();
    } finally {
      this.#pendingCandidateAdd = false;
      btn.disabled = false;
    }
  }

  // header「导入作品域」：复用工具弹窗同一条 IMPORT_USER_WORKS 分页长任务（进度层/取消/
  // 三链路互斥全在 AuthorImport 内），完成后重判本栏已挂载作品的作品域存在性
  async #importAuthorWorks() {
    const btn = dom.sidebarAuthorImportWorks;
    const secUid = state.currentAuthorSecUid;
    if (!btn || !secUid || this.#pendingImportWorks) return;
    this.#pendingImportWorks = true;
    btn.disabled = true;
    try {
      const res = await authorImport.startWorksImportFor(secUid);
      if (res?.ok) await this.#refreshPresence();
    } finally {
      this.#pendingImportWorks = false;
      btn.disabled = false;
    }
  }

  // header「从候选域移除」：候选域无账号同步源，删本地记录即终态（DELETE_CANDIDATES），
  // 不可撤销故先确认；成功后本地主键集/网格/作者 chip 一并收口（作者域删除不广播）
  #removeAuthorFromCandidates() {
    const info = this.#currentAuthor;
    if (!info?.uid || this.#pendingCandidateAdd) return;
    const uid = String(info.uid);
    const name = info.nickname || "未知作者";
    const body = document.createElement("p");
    body.className = "confirm-delete-msg";
    body.textContent = `确定从候选域移除「${name}」？此操作不可撤销。`;
    dialog.showDialog("确认移除", body, [
      {
        text: "移除",
        danger: true,
        callback: () =>
          dialog.runTask({
            progressTitle: "正在移除…",
            progressHtml: `<p>正在移除「${name}」…</p>`,
            task: () => this.#deleteCandidateRecord(uid),
            successText: `已从候选域移除「${name}」`,
            failPrefix: "移除失败: ",
          }),
      },
    ]);
  }

  async #deleteCandidateRecord(uid) {
    const res = await services.deleteAuthorRecords("candidates", [uid]);
    if (!res || res.ok !== true) throw new Error(res?.error || "移除失败");
    state.candidateUids.delete(uid);
    store.removeAuthorRecordsSilent("candidates", new Set([uid]));
    if (state.domain === "candidates") {
      this.#activeGrid().removeItems(new Set([uid]));
      store.refreshGroups();
      search.syncCount();
      // 记录已删，头部「候选」状态随之失效（作品栏仍可用于浏览该作者作品）
      dom.sidebarAuthorStatus.classList.add("hidden");
    }
    if (config.WORK_RECORD_DOMAINS.includes(state.domain)) {
      search.activeWorkRecordGrid().syncAuthorFlags();
    }
    this.#syncCandidateAction();
  }

  // header「刷新」：代际自增作废在途回包后从第一页重取，并重取作者头计数/最近更新。
  // 在途请求的 finally 因代际失配跳过加载标志复位，这里必须显式清掉，
  // 否则新请求会在 loadSidebarWorks 首行被守卫挡回
  refreshAuthorWorks() {
    const secUid = state.currentAuthorSecUid;
    if (!secUid || this.#pendingImportWorks) return;
    this.#loadToken++;
    state.sidebarLoading = false;
    state.sidebarCursor = null;
    this.#headerLoaded = 0;
    this.#resetSidebarGrid();
    this.#syncAuthorHeadMeta();
    this.loadSidebarWorks(secUid, null, true);
    if (config.AUTHOR_RECORD_DOMAINS.includes(state.domain)) {
      if (this.#currentAuthor) this.#calibrateFollowing(this.#currentAuthor);
    } else {
      this.#hydrateAuthorStats(secUid);
    }
  }

  // 头像走探针先行：成功才提交背景图，失败保留昵称首字占位；代际 + secUid 双校验
  // 防止切换作者后在途旧图覆盖新头
  #loadAuthorAvatar() {
    const info = this.#currentAuthor;
    const secUid = state.currentAuthorSecUid;
    const token = ++this.#avatarToken;
    const avatar = dom.sidebarAuthorAvatar;
    const name = info?.nickname || "未知作者";
    const initial = name.trim().charAt(0).toUpperCase() || "?";
    avatar.textContent = initial;
    avatar.style.backgroundImage = "";
    const url = info?.avatarLarger || info?.avatar || "";
    if (!url) return;
    const probe = new Image();
    probe.onload = () => {
      if (token !== this.#avatarToken || state.currentAuthorSecUid !== secUid) return;
      avatar.style.backgroundImage = utils.cssUrl(url);
      avatar.textContent = "";
    };
    probe.onerror = () => {
      if (token !== this.#avatarToken || state.currentAuthorSecUid !== secUid) return;
      avatar.style.backgroundImage = "";
      avatar.textContent = initial;
    };
    probe.src = url;
  }

  // 打开侧边栏即顺带校准该用户的权威计数与档案字段（profile/other + 作品第一页取最近更新日期）：成功后同步
  // 更新 state 与可见卡片；失败静默忽略，不影响作品加载
  async #calibrateFollowing(following) {
    const secUid = state.currentAuthorSecUid;
    if (!secUid || !following?.uid) return;
    // 捕获发起时的作者域与网格：await 期间用户可能已切域，回调不得写错域数组/卡片
    const domain = state.domain;
    const grid = this.#activeGrid();
    const res = await services.bgMsg({
      type: domain === "candidates" ? "CALIBRATE_CANDIDATE" : "CALIBRATE_FOLLOWING",
      uid: following.uid,
      secUid,
    });
    if (!res?.ok) return;
    // 整对象替换（而非原地改写）：lcFields 归一化侧表以记录对象为键（WeakMap），原地改 nickname
    // 会让旧小写昵称缓存变成脏读（关键词搜索仍按旧名命中）；换新对象即随旧对象一并失效。
    // 同时 dataVersion++ 计入数据版本——绕过 store 封装的写入必须自增（视图缓存失效判据）
    const list = state[domain];
    const idx = list.findIndex((f) => String(f.uid) === String(following.uid));
    let entry = null;
    if (idx >= 0) {
      const old = list[idx];
      const { nickname, avatarLarger } = res;
      entry = {
        ...old,
        awemeCount: res.awemeCount,
        followerCount: res.followerCount,
        lastUpdateAt: res.lastUpdateAt,
        // 档案字段（昵称/头像）同 profile 权威值：仅在取到非空值时覆盖，空值保留旧值（见 docs/04）
        nickname: nickname || old.nickname,
        avatarLarger: avatarLarger || old.avatarLarger,
      };
      list[idx] = entry;
      state.dataVersion++;
    }
    // 切域后不再回写 DOM：当前容器里的同名卡片属于另一作者域，不能被旧域校准结果重填
    if (entry && state.domain === domain) {
      const card = dom.mainContainer.querySelector(`[data-uid="${following.uid}"]`);
      // 卡片走网格填充原语整体重填：昵称/头像/计数/最近更新一并刷新（头像经探针管线、代际作废
      // 在途旧探针），无需在此逐节点打补丁
      if (card && !card.classList.contains(grid.skeletonClass)) {
        grid.fillCard(card, entry);
      }
      if (state.currentAuthorSecUid === secUid) {
        const prev = this.#currentAuthor || {};
        this.#currentAuthor = {
          ...prev,
          ...entry,
          // 校准响应缺失字段时保留头上一次的值，避免头文案/头像退化
          nickname: entry.nickname || prev.nickname,
          avatarLarger: entry.avatarLarger || prev.avatarLarger || prev.avatar || "",
          followerCount: entry.followerCount ?? prev.followerCount,
          awemeCount: entry.awemeCount ?? prev.awemeCount,
          lastUpdateAt: entry.lastUpdateAt ?? prev.lastUpdateAt,
        };
        this.#renderAuthorHead();
      }
    }
  }

  // 重开作者前整体复位：在途探针作废、观察器断开重建，防止上一作者的条目观察残留
  #resetSidebarGrid() {
    this.stopAllMedia();
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
    // 上一作者的「已全部加载」提示随之复位（新作者数据到达后在加载收尾重判）
    dom.sidebarEndNotice.classList.add("hidden");
  }

  async loadSidebarWorks(secUid, cursor, reset) {
    if (state.sidebarLoading) return;
    state.sidebarLoading = true;
    // 代际快照：切换作者后 #loadToken 自增，本轮回包整体作废（不写列表/不自减 loading）
    const token = this.#loadToken;
    // 失败态兜底文案在上一轮曾被填入 loader：开新加载前还原纯 spinner
    //（否则重试/续页期间加载态不可见，旧「加载失败」文案也会滞留到成功之后）
    if (!dom.sidebarLoader.querySelector(".spinner")) {
      dom.sidebarLoader.textContent = "";
      const spinner = document.createElement("div");
      spinner.className = "spinner";
      dom.sidebarLoader.appendChild(spinner);
    }
    dom.sidebarLoader.classList.remove("hidden");
    // 触底加载触发时列表末端正处视口底部，先收起上一次的「已全部加载」提示（有新页则在收尾重判）
    dom.sidebarEndNotice.classList.add("hidden");

    let failed = false;
    try {
      const res = await services.bgMsg({
        type: "FETCH_WORKS_PAGE",
        secUid,
        cursor: cursor || "",
      });
      if (token !== this.#loadToken) return;

      if (reset) {
        this.stopAllMedia();
        dom.sidebarWorksGrid.innerHTML = "";
      }

      if (res.ok && res.works) {
        // 三域存在性判据（逐作品）：一次批量主键直取当前页 id（works/favorites/collections
        // 三域并行，GET_WORKS_BY_IDS 支持三域）→ 命中即在该域；任一域查询失败降级为空集
        //（按不存在保守展示，用户点存入时服务端合并去重兜底）
        const ids = res.works.map((w) => String(w.awemeId));
        const presence = await this.#fetchPresence(ids);
        if (token !== this.#loadToken) return;
        const fragment = document.createDocumentFragment();
        const items = [];
        for (const w of res.works) {
          const item = this.#createWorkItem(w, presence);
          fragment.appendChild(item);
          items.push(item);
        }
        dom.sidebarWorksGrid.appendChild(fragment);
        state.sidebarCursor = res.hasMore ? res.maxCursor || "" : null;
        this.#headerLoaded += res.works.length;
        this.#syncAuthorHeadMeta();
        // 新条目只进"观察圈"：进入视口才升级（发探针+绘制），滚出远圈后降级回占位态
        this.#ensureSideObservers();
        for (const el of items) this.#sideFillObs.observe(el);
      } else {
        // 失败/空响应：终结算尽；错误态让 loader 留在可见态显示原因（正常空响应仍收起）
        state.sidebarCursor = null;
        if (!res.ok) {
          failed = true;
          dom.sidebarLoader.textContent = "加载失败" + (res.error ? ": " + res.error : "");
        }
      }
    } catch (_e) {
      if (token !== this.#loadToken) return;
      console.error("[DY] sidebar load failed:", _e);
      failed = true;
      dom.sidebarLoader.textContent = "加载失败" + (_e.message ? ": " + _e.message : "");
      state.sidebarCursor = null;
    } finally {
      // 成功/空响应/取消收起加载圈；失败保留可见态承载错误文案（下一轮开头会还原 spinner）
      //（旧代回包的 finally 不得收起新代刚打开的加载圈）
      if (token === this.#loadToken && !failed) dom.sidebarLoader.classList.add("hidden");
    }
    if (token !== this.#loadToken) return;
    if (failed) {
      state.sidebarLoading = false;
      return;
    }

    state.sidebarLoading = false;
    // 「已全部加载」提示：全部页取完（无更多游标）且确有成列内容时驻底显示
    dom.sidebarEndNotice.classList.toggle("hidden", !(!state.sidebarCursor && dom.sidebarWorksGrid.children.length > 0));

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

  // 主网格保底宽度按域取：作者域沿用 SIDEBAR_MAIN_GRID_MIN（关注卡单列可读下限）；
  // 作品型三域取作品卡带宽下限（理想卡宽 × WORK_CARD_SIZE_BAND_MIN），保住一列可读的作品卡
  #mainGridMin() {
    return utils.isAuthorRecordDomain()
      ? config.SIDEBAR_MAIN_GRID_MIN
      : Math.round(config.CARD_SIZE_FALLBACK * config.WORK_CARD_SIZE_BAND_MIN);
  }

  // 侧栏展开宽度可用上限：appBody - 分割条 - 主网格保底宽度（按域取，见 #mainGridMin，
  // 保住主网格可用列数）。注意 appBody 是 body grid 的第 1 列，宽度已不含右侧导航轨，
  // 不能再减一次 --right-sidebar-width（否则白吃 48px，作品域阈值从 515 抬到 563）
  #availableMax() {
    return Math.max(
      0,
      dom.appBody.getBoundingClientRect().width -
        dom.sidebarResizeHandle.getBoundingClientRect().width -
        this.#mainGridMin(),
    );
  }

  // ---------- 档位（列数 × 固定卡宽，列数不封顶） ----------
  // 侧栏宽度只有收起(0)与 N 列档：档位宽 wN = N×CARD_SIZE + (N−1)×GAP + 2×PADDING + 滚动条槽宽
  //（sidebarBody 的 scrollbar-gutter: stable 常驻占槽，不计入会让内容区少一列）——
  // 作品卡恒为固定宽（SIDEBAR_CARD_SIZE）——无连续宽度、无容差带、无留白搜索。拖拽按
  // 最近可用档吸附（不收起不展开，折叠/展开只经分割条点击）；超出可用上限的档位从
  // 候选剔除，全部档位都放不下时被动收起。N 无固定上限：可用上限本身保底主网格
  // 1 列关注卡（SIDEBAR_MAIN_GRID_MIN），即「主网格只剩 1 列」就是极限档

  #stopWidth(n) {
    return (
      n * config.SIDEBAR_CARD_SIZE +
      (n - 1) * config.SIDEBAR_GRID_GAP +
      2 * config.SIDEBAR_GRID_PADDING +
      this.#scrollbarGutter()
    );
  }

  // sidebarBody 的 scrollbar-gutter: stable 常驻预留一条滚动条槽（Windows Chrome ≈15px），
  // 使内容区比面板宽度少一个槽宽。档位宽度必须把它算进去，否则 3 列档只放得下 2 列，
  // auto-fit 会把余量平分到两侧（卡片整体右移 + 左侧大片空白）。桌面端无槽时返回 0
  #scrollbarGutter() {
    if (this.#sbGutter >= 0) return this.#sbGutter;
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;top:-9999px;left:-9999px;width:100px;height:100px;overflow:scroll;";
    document.body.appendChild(probe);
    this.#sbGutter = Math.max(0, probe.offsetWidth - probe.clientWidth);
    probe.remove();
    return this.#sbGutter;
  }

  // 各档宽度（availMax 可注入拖拽会话缓存；超上限的档位不可用、从候选剔除）
  #stopWidths(availMax = this.#availableMax()) {
    const stops = [];
    for (let n = 1; ; n++) {
      const w = this.#stopWidth(n);
      if (w > availMax) break;
      stops.push(w);
    }
    return stops;
  }

  // 最近档吸附（候选非空）
  #snapStop(raw, stops) {
    let best = stops[0];
    for (const w of stops) {
      if (Math.abs(w - raw) < Math.abs(best - raw)) best = w;
    }
    return best;
  }

  // 拖拽路径（#onResizeDown 会话缓存 availMax）：最近可用档吸附；无可用档维持原宽
  #snapDragWidth(raw) {
    const stops = this.#stopWidths(this.#dragAvailMax);
    return stops.length ? this.#snapStop(raw, stops) : this.#dragStartW;
  }

  // 宽度决议（非拖拽路径：初始化恢复/窗口钳制）：吸附到最近可用档；无可用档（窗口
  // 放不下 1 列档）归 0 收起（保存偏好不受影响）
  #resolveWidth(raw, availMax = this.#availableMax()) {
    const stops = this.#stopWidths(availMax);
    if (!stops.length) return 0;
    return this.#snapStop(raw, stops);
  }

  // 展开默认落到 3 列档（DEFAULT_COLS，各域一致），不读保存偏好（保存值仅页面加载
  // 恢复/拖拽落定生效）；窗口放不下 3 列时回退到当前最大可用档（2/1 列），
  // 一个都放不下归 0 收起
  #expandWidth() {
    const stops = this.#stopWidths();
    if (!stops.length) return 0;
    const target = this.#stopWidth(Sidebar.DEFAULT_COLS);
    return stops.includes(target) ? target : stops[stops.length - 1];
  }

  // 指定锚点的改宽入口：先登记到网格、再执行 mutate（会改主网格列数的布局变更）。
  // 位移补偿整体挪到网格的 RO 回调里（布局洁净时机测量、改宽后一次补偿），mutate 内
  // 没有任何 getBoundingClientRect——原实现「测前→mutate→测后」会在改宽前强制
  // 一次 O(已挂载卡) 重排。调用方若需读壳层 rect（如 #expandWidth 的可用上限），须在
  // 本方法之前完成（壳层无网格级失效挂起，一次 flush 不构成双布局）。
  // 未登记锚点的调用方由网格回退「视口最上方卡」，等效
  #preserveAnchor(anchorEl, mutate) {
    if (anchorEl && anchorEl.isConnected) this.#activeGrid().setResizeAnchor(anchorEl);
    const result = mutate();
    this.#activeGrid().syncContainerWidth();
    return result;
  }

  #initResize() {
    dom.sidebarResizeHandle.addEventListener("mousedown", this.#onResizeDown);
  }

  #loadMoreWorks() {
    if (state.sidebarLoading || !state.sidebarCursor || !state.currentAuthorSecUid) return;
    this.loadSidebarWorks(state.currentAuthorSecUid, state.sidebarCursor, false);
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
    // 降级即离开视口：先停预览并释放解码缓冲（重新升级/悬停才再赋 src）
    this.#stopPreview(item);
    if (meta.player) {
      meta.player.removeAttribute("src");
      meta.player.load();
    }
    meta.cover.dataset.gen = String((Number(meta.cover.dataset.gen) || 0) + 1);
    meta.cover.style.backgroundImage = "";
    meta.placeholder.style.display = "";
    this.#sideUnloadObs.unobserve(item);
    this.#sideFillObs.observe(item);
  }

  // ---------- 悬停预览播放 ----------
  // 起播：侧栏列表是 API 即时产物，video 多为长效 playApi / video_id 链（videoExpireAt=0），
  // 直接按 utils.getVideoUrl 取 src；canplay 只决定首帧就绪后开播，不提前上屏
  #startPreview(item) {
    const meta = this.#workMeta.get(item);
    const video = meta && meta.player;
    if (!video || !meta.videoUrl || !item.isConnected) return;
    delete video.dataset.retries;
    video.dataset.hovered = "1";
    video.src = meta.videoUrl;
    video.currentTime = 0;
    video.muted = state.mediaMuted;
    video.load();
    const onCanPlay = () => {
      if (!video.dataset.hovered) return;
      video.play().catch(() => {});
    };
    video.addEventListener("canplay", onCanPlay, { once: true });
    video._hoverTimeout = setTimeout(() => {
      video.removeEventListener("canplay", onCanPlay);
    }, config.VIDEO_FALLBACK_TIMEOUT);
  }

  // 首帧可用即提交（play 事件直绑每播放器）：视频提亮 + 封面透明，零空档同作品卡；
  // 真实成功复位全局媒体熔断（错误路径由 detail.handleVideoError 计数）
  #commitPreview(item) {
    const meta = item && this.#workMeta.get(item);
    const video = meta && meta.player;
    if (!video || !meta.videoUrl || !video.dataset.hovered) return;
    detail.markMediaOk();
    video.classList.add("video-ready");
    meta.cover.classList.add("video-hidden");
  }

  // 停播并复位：指针移出、降级、切作者、收起、页面隐藏、外链点击均走这里。
  // 条目脱离 DOM / 面板收起后 pointerout 不再补发，漏停会留下「画面已消失但音频继续」的游离 video
  #stopPreview(item) {
    const meta = item && this.#workMeta.get(item);
    if (!meta) return;
    clearTimeout(this.#previewTimer);
    const video = meta.player;
    if (video) {
      clearTimeout(video._retryTimer);
      clearTimeout(video._hoverTimeout);
      delete video.dataset.hovered;
      video.pause();
      video.classList.remove("video-ready");
    }
    meta.cover.classList.remove("video-hidden");
    if (this.#previewItem === item) this.#previewItem = null;
  }

  // 滚动/布局变化后按最新指针坐标重判：指针仍在该条目封面框内则保留预览，否则停播
  //（滚动把条目从指针下移走时浏览器不重算 hover、不补发 pointerout，这里是唯一收口）
  #scheduleHoverRecheck() {
    if (this.#hoverRecheckRaf || !this.#previewItem) return;
    this.#hoverRecheckRaf = requestAnimationFrame(() => {
      this.#hoverRecheckRaf = 0;
      const item = this.#previewItem;
      if (!item) return;
      const link = item.querySelector(".sidebar-work-link");
      const r = link?.getBoundingClientRect();
      const { x, y } = this.#pointer;
      if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return;
      this.#stopPreview(item);
    });
  }

  // 全页静音偏好施加到侧栏预览（静音按钮只在网格/详情，切换后由 WorksGrid.syncMediaMute 调用）
  syncMediaMute() {
    for (const video of dom.sidebarWorksGrid.querySelectorAll(".sidebar-work-player")) {
      video.muted = state.mediaMuted;
    }
  }

  // 统一停播：页面隐藏（main.js visibilitychange）、收起、切作者、列表重置均调；
  // 不依赖 pointerout（面板隐藏/节点摘除后该事件不再补发）
  stopAllMedia() {
    if (this.#previewItem) this.#stopPreview(this.#previewItem);
    for (const video of dom.sidebarWorksGrid.querySelectorAll(".sidebar-work-player")) {
      clearTimeout(video._retryTimer);
      clearTimeout(video._hoverTimeout);
      delete video.dataset.hovered;
      video.pause();
      video.classList.remove("video-ready");
    }
    for (const cover of dom.sidebarWorksGrid.querySelectorAll(".sidebar-work-cover.video-hidden")) {
      cover.classList.remove("video-hidden");
    }
    this.#previewItem = null;
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
          cover.style.backgroundImage = utils.cssUrl(url);
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

  #createWorkItem(work, presence) {
    const item = dom.sidebarWorkTemplate.content.cloneNode(true).firstElementChild;
    const link = item.querySelector(".sidebar-work-link");
    const isNote = work.type === "note";
    const type = isNote ? "note" : "video";
    // 类型标记（video/note）：仅图集条目启用封面悬浮放大（CSS 按 data-type 选取）
    item.dataset.type = type;
    link.href = `${config.URL_BASE}/${type}/${work.awemeId}`;

    const badge = link.querySelector(".work-type-badge");
    if (badge) badge.classList.toggle("hidden", !isNote);

    const img = link.querySelector(".sidebar-work-cover");
    const placeholder = link.querySelector(".sidebar-work-cover-placeholder");
    const url = utils.pickCardCover(work);
    if (!url) {
      img.style.display = "none";
      if (isNote) placeholder.textContent = "📰";
    }

    // 悬停预览媒体：仅视频作品保留播放器，图集（note）无主视频直接移除节点（同作品卡）。
    // play/error 不冒泡，直绑元素；error 仅预览态（hovered）计入全局熔断与重试
    const videoUrl = isNote ? "" : utils.getVideoUrl(work);
    const player = link.querySelector(".sidebar-work-player");
    if (!videoUrl) {
      player?.remove();
    } else if (player) {
      player.addEventListener("play", () => this.#commitPreview(item));
      player.addEventListener("error", () => {
        if (!player.dataset.hovered) return;
        detail.handleVideoError(player, {
          // 重试耗尽：整体停播复位（封面恢复，不留黑帧/透明空壳）
          onMax: () => this.#stopPreview(item),
          onRetry: () => {},
        });
      });
    }

    // 三域存在性指示（点赞♥ / 收藏★ / 入库书签）：三者都是两态常显的切换按钮——存在 = 高亮
    //（.on / .in-works），不存在 = 暗色，点击即增删对应域（见 #syncPresenceState / #syncSaveState）。
    // 元素引用挂元数据供点击回查；探针推迟到条目进入视口（#promoteItem）才发，不再创建即全量急切加载
    const id = String(work.awemeId);
    const dateEl = item.querySelector(".sidebar-work-date");
    dateEl.textContent = utils.formatPublishDate(work.createTime) || "-";

    this.#workMeta.set(item, {
      url,
      cover: img,
      placeholder,
      work,
      player: videoUrl ? player : null,
      videoUrl,
      saveBtn: item.querySelector(".sidebar-work-save"),
      inWorks: presence.works.has(id),
      likeEl: item.querySelector(".sidebar-presence-like"),
      collectEl: item.querySelector(".sidebar-presence-collect"),
      presence: {
        favorites: presence.favorites.has(id),
        collections: presence.collections.has(id),
      },
    });
    this.#syncSaveState(item);
    this.#syncPresenceState(item, "favorites");
    this.#syncPresenceState(item, "collections");
    return item;
  }

  // ♥/★ 两态常显 + 点击切换：存在 = .on 高亮、不存在暗色；请求在途禁用并提示。
  // 按钮只剩图标（无可见文案），语义只挂 aria-label（不重复挂 title tooltip）
  #syncPresenceState(item, domain) {
    const meta = this.#workMeta.get(item);
    if (!meta || !meta.work) return;
    const el = domain === "favorites" ? meta.likeEl : meta.collectEl;
    if (!el) return;
    const active = Boolean(meta.presence[domain]);
    const pending = this.#pendingReactions.has(domain + ":" + String(meta.work.awemeId));
    const label = config.DOMAINS_META[domain].label;
    const title = pending ? "处理中…" : active ? `取消${label}并移出${label}域` : `${label}并加入${label}域`;
    el.classList.toggle("on", active);
    el.classList.toggle("pending", pending);
    el.disabled = pending;
    el.setAttribute("aria-label", title);
    el.setAttribute("aria-pressed", String(active));
  }

  // 「入库」按钮两态（图标按钮，动作 + 状态同体）：未入库 = 可点入库；已入库 = 高亮 .in-works，
  // 再点移出作品域（与 ♥/★ 同款 toggle）。请求在途禁用；重入靠 #pendingSaves 双保险
  #syncSaveState(item) {
    const meta = this.#workMeta.get(item);
    if (!meta || !meta.work) return;
    const btn = meta.saveBtn;
    if (!btn) return;
    const inWorks = Boolean(meta.inWorks);
    const pending = this.#pendingSaves.has(String(meta.work.awemeId));
    btn.disabled = pending;
    btn.classList.toggle("in-works", inWorks);
    // 只剩图标：语义只挂 aria-label（不重复挂可见 tooltip）
    const label = pending ? "处理中…" : inWorks ? "移出作品域" : "存入作品域";
    btn.setAttribute("aria-label", label);
    btn.setAttribute("aria-pressed", String(inWorks));
  }

  // 三个作品型域的存在性批量判定（按 awemeId 主键直取）：GET_WORKS_BY_IDS 支持
  // works/favorites/collections 三域，三域并行；任一域失败该域降级为空集（保守按不存在展示）
  async #fetchPresence(ids) {
    if (!ids.length) return { works: new Set(), favorites: new Set(), collections: new Set() };
    const query = async (domain) => {
      const res = await services.bgMsg({ type: "GET_WORKS_BY_IDS", domain, ids }).catch(() => null);
      if (!res || !Array.isArray(res.items)) return new Set();
      return new Set(res.items.map((w) => String(w.awemeId)));
    };
    const [works, favorites, collections] = await Promise.all([
      query("works"),
      query("favorites"),
      query("collections"),
    ]);
    return { works, favorites, collections };
  }

  // 已挂载条目的存在性重判：批量主键直取后只改按钮态，不重建卡片（导入完成后新入库条目
  // 由「存入」即时转「已入库」）
  async #refreshPresence() {
    const items = Array.from(dom.sidebarWorksGrid.children);
    const metas = items.map((item) => this.#workMeta.get(item)).filter(Boolean);
    if (!metas.length) return;
    const ids = metas.map((meta) => String(meta.work.awemeId));
    const presence = await this.#fetchPresence(ids);
    for (const item of items) {
      const meta = this.#workMeta.get(item);
      if (!meta) continue;
      const id = String(meta.work.awemeId);
      meta.inWorks = presence.works.has(id);
      meta.presence.favorites = presence.favorites.has(id);
      meta.presence.collections = presence.collections.has(id);
      this.#syncSaveState(item);
      this.#syncPresenceState(item, "favorites");
      this.#syncPresenceState(item, "collections");
    }
  }

  // 单作品入库/移除切换（静默短操作，无进度弹窗，toast 反馈 + 卡片原地更新）：
  // 未入库 → SAVE_WORKS 落库；已入库 → DELETE_WORKS 删本地记录（该消息不广播 STORE_CHANGED，
  // 当前作品域网格的摘卡由 #dropWorkFromGrid 本地收口）。失败保持原态
  async #toggleSaveWork(btn) {
    const item = btn.closest(".sidebar-work-item");
    const meta = item && this.#workMeta.get(item);
    if (!meta || !meta.work) return;
    const awemeId = String(meta.work.awemeId);
    if (this.#pendingSaves.has(awemeId)) return;
    const removing = Boolean(meta.inWorks);
    this.#pendingSaves.add(awemeId);
    this.#syncSaveState(item);
    try {
      if (removing) {
        const res = await services.deleteWorkRecord("works", [awemeId]);
        if (!res || res.ok !== true) {
          dialog.showToast("移出作品域失败: " + (res?.error || "未知错误"), "error");
          return;
        }
        meta.inWorks = false;
        this.#dropWorkFromGrid(awemeId);
        dialog.showToast("已移出作品域", "success");
      } else {
        const res = await services.bgMsg({ type: "SAVE_WORKS", works: [meta.work] });
        if (!res || res.ok !== true) {
          dialog.showToast("存入作品域失败: " + (res?.error || "未知错误"), "error");
          return;
        }
        meta.inWorks = true;
        dialog.showToast(`已存入作品域（新增 ${res.added ?? 0} · 更新 ${res.updated ?? 0}）`, "success");
      }
    } finally {
      this.#pendingSaves.delete(awemeId);
      this.#syncSaveState(item);
    }
  }

  // 移出作品域后的本地收口：DELETE_WORKS 不广播 STORE_CHANGED（批量删除由 Batch 自行摘卡），
  // 当前域就是作品域时同步摘卡并重算分组计数/结果数
  #dropWorkFromGrid(awemeId) {
    if (state.domain !== "works") return;
    const idSet = new Set([awemeId]);
    store.removeWorkRecordSilent("works", idSet, { preserveAuthorOrder: true });
    search.gridForDomain("works").removeItems(idSet);
    store.refreshGroups();
    search.syncCount();
  }

  // 单作品点赞/收藏状态切换：远端设置成功后本地域同步（添加经 background mergeAndSave
  // 落库、取消删本地记录），卡片原地更新；失败保持原态。点赞在独立模式无远端链路
  //（background 返回 UNSUPPORTED_INDEPENDENT），收藏双模均通
  async #setReaction(btn) {
    const item = btn.closest(".sidebar-work-item");
    const meta = item && this.#workMeta.get(item);
    if (!meta || !meta.work) return;
    const domain = btn.classList.contains("sidebar-presence-like") ? "favorites" : "collections";
    const awemeId = String(meta.work.awemeId);
    const key = domain + ":" + awemeId;
    if (this.#pendingReactions.has(key)) return;
    const active = !meta.presence[domain];
    const label = config.DOMAINS_META[domain].label;
    this.#pendingReactions.add(key);
    this.#syncPresenceState(item, domain);
    try {
      const message = {
        type: domain === "favorites" ? "SET_FAVORITES" : "SET_COLLECTION",
        awemeId,
        active,
      };
      if (active) message.work = meta.work;
      const res = await services.bgMsg(message);
      if (!res || res.ok !== true) {
        const error = res?.error || "未知错误";
        if (error === "UNSUPPORTED_INDEPENDENT") {
          dialog.showToast("独立模式不支持点赞操作，请在设置中切换 Tab 模式", "error");
        } else {
          dialog.showToast(`${active ? label : "取消" + label}失败: ${error}`, "error");
        }
        return;
      }
      meta.presence[domain] = active;
      dialog.showToast(active ? `已${label}并加入${label}域` : `已取消${label}并移出${label}域`, "success");
    } finally {
      this.#pendingReactions.delete(key);
      this.#syncPresenceState(item, domain);
    }
  }
}

export const sidebar = new Sidebar();
