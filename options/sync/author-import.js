// ---------- AuthorImport（工具） ----------
import { config, state, services } from '../core.js';
import { dialog } from '../components/dialog.js';
import { taskDock } from '../components/task-dock.js';

// ---------- 工具弹窗（作者入库 + 作者域批量校准 + 清理 + uid 反查） ----------
// 菜单「工具」弹窗：两行输入各配一个域入库按钮 + 一行两个批量校准按钮 + 两行清理按钮
// + 底部 uid 反查区块。
// 清理 = 本地短操作：关注全集比对后把点赞/收藏域未关注作者的作品、候选域已关注作者
// 移入「稍后删除」（候选域无账号同步源，重叠比对即其原「同步」按钮功能，现归本弹窗）。
// 作品域入库 / 批量校准 = 任务坞长任务（TASK_PROGRESS/TASK_DONE，取消走 CANCEL_TASK）；
// 候选域入库 = IMPORT_CANDIDATE 单请求收录作者档案（短操作，不登记任务坞/队列：
// 按钮 busy 态保护请求往返，终态 toast/签名引导就地收口，发出即清空输入）。
// uid 反查 = RESOLVE_USER_PROFILE 只读短请求：数字 uid 经 profile/other 的 user_id
// 换取 sec_uid 并拼主页链接，不写任何域；错误统一 toast。
// 分组语义与「添加作品/添加关注」一致：已在域的保留原分组、新条目落「未分组」
// （由 background mergeWork/mergeAndSaveAuthors 内建，本模块不做任何加工）。
class AuthorImport {
  #worksInput = null;
  #candidatesInput = null;
  #btnCandidates = null;
  #uidInput = null;
  #uidBtn = null;
  #uidResult = null;
  #uidLink = null;
  #uidCopyBtn = null;
  #uidProfileUrl = "";
  #btnCleanupFavorites = null;
  #btnCleanupCollections = null;
  #btnCleanupCandidates = null;
  #cleanupBusy = false;
  // 弹窗代际：关闭/重开自增，清理短操作在 await 后校验，防止已关闭会话的迟到结果
  // 把确认层推进新的工具弹窗
  #cleanupGen = 0;
  // 候选域入库单请求短锁：保护整个请求往返（按钮 busy 态），防重复提交
  #candidatesBusy = false;
  // uid 反查短锁：与 #candidatesBusy 互不覆盖，查询结束即释放
  #uidBusy = false;

  // ---------- 工具弹窗（配置态，两行输入 + 两行校准按钮） ----------
  openDialog() {
    // B6 队列：任务运行中仍可打开工具弹窗提交新的导入/校准任务（入队排队）
    this.#cleanupGen++;
    const body = document.createElement("div");
    body.className = "import-rows";
    body.innerHTML = `
      <div class="import-row">
        <input class="import-input works-input" placeholder="作者主页链接（douyin.com/user/…）" spellcheck="false" aria-label="作品域入库作者">
        <button class="dy-btn flex-inline-center dy-btn-primary btn-import-works">作品域入库</button>
      </div>
      <div class="import-row">
        <input class="import-input candidates-input" placeholder="作者主页链接（douyin.com/user/…）" spellcheck="false" aria-label="候选域入库作者">
        <button class="dy-btn flex-inline-center dy-btn-primary btn-import-candidates">候选域入库</button>
      </div>
      <div class="import-row">
        <span class="import-calibrate-hint">对关注/候选域全部作者重取主页权威计数、昵称/头像与最近更新日期</span>
        <button class="dy-btn flex-inline-center dy-btn-primary btn-calibrate-followings" aria-label="校准关注域全部作者的作品/粉丝计数、昵称/头像">校准关注域</button>
        <button class="dy-btn flex-inline-center dy-btn-primary btn-calibrate-candidates" aria-label="校准候选域全部作者的作品/粉丝计数、昵称/头像">校准候选域</button>
      </div>
      <div class="import-row">
        <span class="import-calibrate-hint">将点赞/收藏域未关注作者的作品移入「稍后删除」分组</span>
        <button class="dy-btn flex-inline-center dy-btn-primary btn-cleanup-favorites" aria-label="清理点赞域未关注作者作品">清理点赞域</button>
        <button class="dy-btn flex-inline-center dy-btn-primary btn-cleanup-collections" aria-label="清理收藏域未关注作者作品">清理收藏域</button>
      </div>
      <div class="import-row">
        <span class="import-calibrate-hint">将候选域已关注作者移入「稍后删除」分组（关注域记录保留）</span>
        <button class="dy-btn flex-inline-center dy-btn-primary btn-cleanup-candidates" aria-label="清理候选域已关注作者">清理候选域</button>
      </div>
      <div class="import-row">
        <input class="import-input uid-input" placeholder="抖音用户 uid（纯数字）" inputmode="numeric" spellcheck="false" aria-label="抖音用户 uid">
        <button class="dy-btn flex-inline-center dy-btn-primary btn-resolve-uid">获取主页链接</button>
      </div>
      <div class="import-result hidden">
        <div class="import-result-info">
          <a class="import-result-link" target="_blank" rel="noopener"></a>
        </div>
        <div class="import-result-actions">
          <button class="dy-btn flex-inline-center btn-copy-uid-link">复制</button>
        </div>
      </div>
    `;
    this.#worksInput = body.querySelector(".works-input");
    this.#candidatesInput = body.querySelector(".candidates-input");
    const btnWorks = body.querySelector(".btn-import-works");
    this.#btnCandidates = body.querySelector(".btn-import-candidates");
    this.#uidInput = body.querySelector(".uid-input");
    this.#uidBtn = body.querySelector(".btn-resolve-uid");
    this.#uidResult = body.querySelector(".import-result");
    this.#uidLink = body.querySelector(".import-result-link");
    this.#uidCopyBtn = body.querySelector(".btn-copy-uid-link");
    this.#btnCleanupFavorites = body.querySelector(".btn-cleanup-favorites");
    this.#btnCleanupCollections = body.querySelector(".btn-cleanup-collections");
    this.#btnCleanupCandidates = body.querySelector(".btn-cleanup-candidates");
    dialog.showDialog("工具", body, [], () => this.closeDialog(), { autoFocus: false });

    btnWorks.addEventListener("click", () => this.startWorksImport());
    this.#btnCandidates.addEventListener("click", () => this.startCandidateImport());
    body.querySelector(".btn-calibrate-followings").addEventListener("click", () => this.startCalibrate("followings"));
    body.querySelector(".btn-calibrate-candidates").addEventListener("click", () => this.startCalibrate("candidates"));
    this.#uidBtn.addEventListener("click", () => this.startResolveUid());
    this.#uidCopyBtn.addEventListener("click", () => this.#copyUidLink());
    // 输入框内回车触发本行按钮（键盘 a11y 约定）
    this.#worksInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.startWorksImport();
    });
    this.#candidatesInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.startCandidateImport();
    });
    this.#uidInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.startResolveUid();
    });
    this.#btnCleanupFavorites.addEventListener("click", () => this.#cleanupUnfollowed("favorites"));
    this.#btnCleanupCollections.addEventListener("click", () => this.#cleanupUnfollowed("collections"));
    this.#btnCleanupCandidates.addEventListener("click", () => this.#cleanupFollowedCandidates());
  }

  closeDialog() {
    dialog.closeDialog();
    this.#cleanupGen++;
    this.#worksInput = this.#candidatesInput = null;
    this.#btnCandidates = null;
    this.#uidInput = this.#uidBtn = this.#uidResult = null;
    this.#uidLink = null;
    this.#uidCopyBtn = null;
    this.#uidProfileUrl = "";
    this.#uidBusy = false;
    this.#btnCleanupFavorites = this.#btnCleanupCollections = null;
    this.#btnCleanupCandidates = null;
  }

  // 清理流程公共前置：加载关注全集（失败/为空拒绝）并解析本域「稍后删除」分组。
  // 弹窗关闭/重开（gen 变化）返回 null，调用方直接退出。
  async #prepareCleanup(domain, gen) {
    const followedOk = await services.loadFollowedUids();
    if (gen !== this.#cleanupGen) return null;
    if (!followedOk) {
      dialog.showToast("读取关注域失败，请稍后重试", "error");
      return null;
    }
    if (state.followedUids.size === 0) {
      dialog.showToast("关注域暂无数据，请先同步关注域后再清理", "info");
      return null;
    }
    const groupsRes = await services.bgMsg({ type: "GET_GROUPS", domain });
    if (gen !== this.#cleanupGen) return null;
    return {
      trashGroup: (groupsRes.groups || []).find((g) => g.name === config.TRASH_GROUP_NAME),
    };
  }

  // ---------- 清理点赞/收藏域未关注作者作品 ----------
  // 判定口径：作品 uid 不在关注全集（无 uid 的作品不参与判定，避免误移）；已位于
  // 「稍后删除」分组的条目不重复计入；关注域为空时拒绝执行。
  async #cleanupUnfollowed(domain) {
    if (this.#cleanupBusy) {
      dialog.showToast("正在处理中，请稍候", "info");
      return;
    }
    this.#cleanupBusy = true;
    this.#setCleanupButtonsDisabled(true);
    const gen = this.#cleanupGen;
    try {
      const ctx = await this.#prepareCleanup(domain, gen);
      if (!ctx) return;
      const meta = config.DOMAINS_META[domain];
      const trashGroup = ctx.trashGroup;
      // keyset 分页逐页比对、只留 awemeId（不做整域单发大载荷）；已位于「稍后删除」的条目跳过
      const ids = [];
      let res = await services.bgMsg({ type: "GET_" + domain.toUpperCase(), groupId: "all", page: 0 });
      for (;;) {
        if (gen !== this.#cleanupGen) return;
        if (res.error) {
          dialog.showToast(`读取${meta.label}域失败：${res.error}`, "error");
          return;
        }
        for (const w of res[meta.itemKey] || []) {
          if (!w || !w.awemeId || !w.uid) continue; // 无 uid 不参与判定
          if (trashGroup && w.groupId === trashGroup.id) continue;
          if (!state.followedUids.has(String(w.uid))) ids.push(w.awemeId);
        }
        if (!res.hasMore || !res.nextCursor) break;
        res = await services.bgMsg({
          type: "GET_" + domain.toUpperCase(),
          groupId: "all",
          cursor: res.nextCursor,
        });
      }
      if (ids.length === 0) {
        dialog.showToast(`未发现${meta.label}域未关注作者的作品`, "info");
        return;
      }
      this.#confirmTrash(
        domain,
        ids,
        "清理未关注作者",
        `发现 ${ids.length} 个${meta.label}域作品来自未关注作者，可将它们移入「${config.TRASH_GROUP_NAME}」分组（关注域记录不受影响）。`,
        "个作品",
        async (gid) => {
          const res = await services.moveWorkRecord(domain, ids, gid);
          if (res.error || res.ok !== true) throw new Error(res.error || "MOVE_FAILED");
        },
      );
    } finally {
      this.#cleanupBusy = false;
      this.#setCleanupButtonsDisabled(false);
    }
  }

  #confirmTrash(domain, ids, title, text, unit, moveFn) {
    const body = document.createElement("p");
    body.className = "confirm-delete-msg";
    body.textContent = text;
    dialog.pushDialog(
      title,
      body,
      [{ text: "移入稍后删除", primary: true, callback: () => this.#moveTrash(domain, ids, unit, moveFn) }],
      () => dialog.closeDialog(),
    );
  }

  // 确认后的实际移动：进度态就地改写确认层；关闭期间锁 X/Esc，成功/失败均回工具弹窗
  async #moveTrash(domain, ids, unit, moveFn) {
    dialog.updateDialog("正在移入稍后删除…", `<p>正在移动 ${ids.length}${unit}…</p>`);
    state.preventDialogClose = true;
    try {
      const group = await services.moveToTrashGroup(domain, ids, moveFn);
      if (!group) throw new Error("创建「稍后删除」分组失败");
      dialog.closeDialog();
      dialog.showToast(`已移入「${config.TRASH_GROUP_NAME}」${ids.length}${unit}`, "success");
    } catch (err) {
      dialog.closeDialog();
      dialog.showToast("移入失败：" + (err.message || String(err)), "error");
    } finally {
      state.preventDialogClose = false;
    }
  }

  #setCleanupButtonsDisabled(disabled) {
    for (const btn of [this.#btnCleanupFavorites, this.#btnCleanupCollections, this.#btnCleanupCandidates]) {
      if (btn) btn.disabled = disabled;
    }
  }

  // ---------- 清理候选域已关注作者 ----------
  // 候选域无账号同步源（原「同步」按钮功能迁入本弹窗）：按关注域 uid 全集做本地重叠比对
  // （不发网络请求），重叠作者确认后移入「稍后删除」分组（不自动删除，保留候选分组与
  // savedAt 台账）。判定口径同点赞/收藏清理：已位于「稍后删除」的条目不重复计入；
  // 关注域为空时拒绝执行，避免「零重叠」的假阳性结论。
  async #cleanupFollowedCandidates() {
    if (this.#cleanupBusy) {
      dialog.showToast("正在处理中，请稍候", "info");
      return;
    }
    this.#cleanupBusy = true;
    this.#setCleanupButtonsDisabled(true);
    const gen = this.#cleanupGen;
    try {
      const ctx = await this.#prepareCleanup("candidates", gen);
      if (!ctx) return;
      const trashGroup = ctx.trashGroup;
      // 候选域作者档案单发全量（无分页），一次取回后本地比对；已位于「稍后删除」的跳过
      const res = await services.bgMsg({ type: "GET_CANDIDATES", groupId: "all" });
      if (gen !== this.#cleanupGen) return;
      if (res.error || !Array.isArray(res.candidates)) {
        dialog.showToast("读取候选域失败：" + (res.error || "未知错误"), "error");
        return;
      }
      const uids = [];
      for (const c of res.candidates) {
        if (!c || !c.uid) continue;
        if (trashGroup && c.groupId === trashGroup.id) continue;
        if (state.followedUids.has(String(c.uid))) uids.push(String(c.uid));
      }
      if (uids.length === 0) {
        dialog.showToast("未发现候选域已关注作者", "info");
        return;
      }
      this.#confirmTrash(
        "candidates",
        uids,
        "清理候选域已关注作者",
        `发现 ${uids.length} 位候选作者已在关注域，可将它们移入「${config.TRASH_GROUP_NAME}」分组（关注域记录保留）。`,
        "位作者",
        async (gid) => {
          const res = await services.moveAuthorRecords("candidates", uids, gid);
          if (res.error || res.ok !== true) throw new Error(res.error || "MOVE_FAILED");
        },
      );
    } finally {
      this.#cleanupBusy = false;
      this.#setCleanupButtonsDisabled(false);
    }
  }

  // ---------- 作品域入库（任务坞长任务） ----------
  // 工具弹窗入口：解析主页链接 → sec_uid 后交给 startWorksImportFor。
  // 从点击到登记之间防重入（resolveSecUid 为异步，双击窗口内不重复排队）
  #importStarting = false;

  async startWorksImport() {
    if (!this.#worksInput || this.#importStarting) return;
    const inputEl = this.#worksInput;
    const parsed = this.#parseAuthorInput(inputEl.value);
    if (!parsed) {
      dialog.showToast("请粘贴作者主页链接（douyin.com/user/…）", "error");
      return;
    }
    const hint = inputEl.value.trim().slice(0, 24);
    this.#importStarting = true;
    try {
      const secUid = await this.#resolveSecUid(parsed);
      if (!this.#worksInput) return; // 解析期间弹窗已被关闭
      if (!secUid) {
        dialog.showToast("无法解析该主页对应的 sec_uid", "error");
        return;
      }
      // 入队即清空输入：任务已登记坞内（排队/进度/失败均由坞行收口），无需保留文本原地重试。
      // startWorksImportFor 内 begin+bindPort 同步完成，未 await 前行已存在
      const pending = this.startWorksImportFor(secUid, { hint });
      if (this.#worksInput) this.#worksInput.value = "";
      await pending;
    } finally {
      this.#importStarting = false;
    }
  }

  // 作品域入库入口：工具弹窗与侧边栏共用；终态/进度全由任务坞收口。
  // onDone 透传给侧边栏（复位按钮 / 刷新 presence），工具弹窗入口不传；
  // hint 透传任务坞行（排队/暂停摘要显示作者标识）。返回约定：bindPort 失败 = null、
  // 队列/异常失败 = { ok:false, error }、成功 = { ok:true, taskId }
  async startWorksImportFor(secUid, { onDone = null, hint = "" } = {}) {
    const result = await taskDock.launchRemote({
      begin: {
        kind: "importWorks",
        domain: "works",
        total: 0,
        hint,
        onDone: (msg) => this.#onImportDone(secUid, msg, onDone),
      },
      queueFullText: "任务队列已满，请稍后重试",
      payload: { type: "IMPORT_USER_WORKS", secUid },
    });
    if (result.bindFailed) return null;
    if (result.error) return { ok: false, error: result.error };
    return { ok: true, taskId: result.response?.taskId || result.taskId };
  }

  async #onImportDone(secUid, msg, onDone) {
    // NO_SIGNATURE 需弹签名引导层（坞内不承载）；URL 指向作者主页
    if (msg.error === "NO_SIGNATURE") {
      dialog.showNoSignatureDialog(config.URL_BASE + "/user/" + secUid, "作品", "导入作品");
    }
    if (typeof onDone === "function") await onDone(msg);
  }

  // ---------- 作者域批量校准（任务坞长任务） ----------
  async startCalibrate(domain) {
    await taskDock.launchRemote({
      begin: {
        kind: domain === "candidates" ? "calibrateCandidates" : "calibrateFollowings",
        domain,
        total: 0,
      },
      queueFullText: "任务队列已满，请稍后重试",
      payload: { type: domain === "candidates" ? "CALIBRATE_CANDIDATES" : "CALIBRATE_FOLLOWINGS" },
    });
  }

  // ---------- 候选域入库（单请求短操作，不进任务坞） ----------
  // IMPORT_CANDIDATE 不登记 TaskRegistry：与侧栏 header 候选按钮同一交互模型——按钮 busy
  // 态保护全程，终态反馈（toast/签名引导/刷新候选域数据）就地收口；任务坞只承载长任务
  async startCandidateImport() {
    if (this.#candidatesBusy || !this.#candidatesInput) return;
    const inputEl = this.#candidatesInput;
    const parsed = this.#parseAuthorInput(inputEl.value);
    if (!parsed) {
      dialog.showToast("请粘贴作者主页链接（douyin.com/user/…）", "error");
      return;
    }
    this.#candidatesBusy = true;
    this.#setCandidatesBtn(true);
    try {
      const secUid = await this.#resolveSecUid(parsed);
      if (!this.#candidatesInput) return; // 解析期间弹窗已被关闭
      if (!secUid) {
        dialog.showToast("无法解析该主页对应的 sec_uid", "error");
        return;
      }
      // 发出即清空输入：结果由 toast/签名引导收口，无需保留文本原地重试
      inputEl.value = "";
      const res = await services.bgMsg({ type: "IMPORT_CANDIDATE", secUid });
      if (!res || res.ok !== true) {
        const msg = res?.error || "未知错误";
        if (msg === "NO_SIGNATURE") {
          // profile 签名源兜底含 postQuery：引导打开作者主页并浏览作品列表即可完成捕获
          dialog.showNoSignatureDialog(config.URL_BASE + "/user/" + secUid, "作品", "收录作者档案");
          return;
        }
        const text = msg.includes("2096") ? "该账号因隐私设置不可见" : `候选域入库失败: ${msg}`;
        dialog.showToast(text, "error");
        return;
      }
      const f = res.candidate || {};
      const nick = f.nickname || "未知";
      // 兜底文案与 shared/domains.js DEFAULT_GROUPS 的「未分组」保持一致
      const groupName = res.groupName || "未分组";
      // added>0 为新收录；否则作者已在候选域，按落库 groupId 解析的分组名提示所在组
      dialog.showToast(
        res.added > 0 ? `已新增候选作者：${nick}（入「${groupName}」）` : `作者已在候选域：${nick}（分组「${groupName}」）`,
        "success",
      );
      if (state.domain === "candidates") await services.loadDomainData();
    } finally {
      this.#candidatesBusy = false;
      this.#setCandidatesBtn(false);
    }
  }

  // ---------- uid 反查主页链接（短操作，只读） ----------
  // 无任务门禁：RESOLVE_USER_PROFILE 走 RequestGate priority 2（交互式车道），可插队于
  // 长任务的 priority 1 请求之前，与任务并行不互相阻塞
  async startResolveUid() {
    if (!this.#uidInput || this.#uidBusy) return;
    const uid = this.#uidInput.value.trim();
    if (!/^\d{5,20}$/.test(uid)) {
      dialog.showToast("请输入纯数字抖音 uid", "error");
      return;
    }
    this.#uidBusy = true;
    this.#setUidBusy(true);
    this.#hideUidResult();
    try {
      const res = await services.bgMsg({ type: "RESOLVE_USER_PROFILE", uid });
      if (!this.#uidInput) return; // 查询期间弹窗已被关闭
      if (!res || res.ok !== true) {
        this.#showUidError(res?.error || "RESOLVE_FAILED");
        return;
      }
      this.#renderUidResult(res);
    } catch (err) {
      if (!this.#uidInput) return;
      this.#showUidError(err.message || String(err));
    } finally {
      this.#uidBusy = false;
      this.#setUidBusy(false);
    }
  }

  #setUidBusy(busy) {
    if (this.#uidBtn?.isConnected) {
      this.#uidBtn.disabled = busy;
      this.#uidBtn.textContent = busy ? "查询中…" : "获取主页链接";
    }
    if (this.#uidInput?.isConnected) this.#uidInput.disabled = busy;
  }

  #renderUidResult(res) {
    this.#uidProfileUrl = res.profileUrl || "";
    this.#uidLink.textContent = this.#uidProfileUrl;
    this.#uidLink.href = this.#uidProfileUrl;
    this.#uidResult.classList.remove("hidden");
  }

  #hideUidResult() {
    this.#uidProfileUrl = "";
    this.#uidResult?.classList.add("hidden");
  }

  #copyUidLink() {
    if (!this.#uidProfileUrl) return;
    navigator.clipboard.writeText(this.#uidProfileUrl).then(() => dialog.showToast("已复制主页链接", "success"));
  }

  // uid 反查错误统一 toast（用户定案：不弹签名引导层）
  #showUidError(error) {
    const msg = error || "RESOLVE_FAILED";
    const map = {
      BAD_UID: "请输入纯数字抖音 uid",
      NO_COOKIE: "未检测到登录 Cookie，请先在设置中刷新 Cookie",
      LOGIN_REQUIRED: "登录状态失效，请刷新 Cookie 后重试",
      NO_DOUYIN_TAB: "未找到抖音页面，请先打开 douyin.com 后重试",
      NO_SIGNATURE: "Tab 模式需先在抖音打开作者主页，捕获签名后重试",
      NO_LISTENER: "抖音页面未响应，请刷新页面后重试",
      TIMEOUT: "请求超时，请稍后重试",
      UID_NOT_FOUND: "未找到该 uid 对应的用户",
      USER_PRIVATE: "该账号因隐私设置不可见",
      RATE_LIMITED: "请求被限流，请稍后重试",
      PROFILE_FETCH_FAILED: "未找到该 uid 对应的用户",
    };
    let text = map[msg];
    if (!text && /2096/.test(msg)) text = map.USER_PRIVATE;
    if (!text && /3170/.test(msg)) text = map.UID_NOT_FOUND;
    if (!text && /HTTP\s*403/.test(msg)) text = map.RATE_LIMITED;
    dialog.showToast(text || `查询失败：${msg}`, "error");
  }

  #setCandidatesBtn(busy) {
    if (!this.#btnCandidates?.isConnected) return;
    this.#btnCandidates.disabled = busy;
    this.#btnCandidates.textContent = busy ? "入库中…" : "候选域入库";
  }

  // ---------- 私有：输入解析与 secUid 提取 ----------

  // 仅支持作者主页链接：pathname /user/<sec_uid>，天然免疫 query；兼容无协议的
  // 地址栏复制形态。uid 需经 im/user/info 兑换（多一次请求且对陌生作者不可靠）、
  // 裸 sec_uid 难以脱离页面上下文取得，均已裁撤——不是链接直接判无效。
  // 返回 sec_uid 字符串或 null
  #parseAuthorInput(text) {
    const raw = (text || "").trim();
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw) || /^[\w.-]+\.[a-z]{2,}\//i.test(raw)) {
      try {
        const url = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
        const m = url.pathname.match(config.SEC_UID_REGEX);
        return m ? m[1] : null;
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  // 链接即 sec_uid；唯一例外是自己主页（登录态地址栏是 /user/self，无真实 sec_uid），
  // 经 RESOLVE_SEC_UID 用 uid cookie 兑换（本人场景 im/user/info 必然可用），失败返回空串
  async #resolveSecUid(secUid) {
    if (secUid !== "self") return secUid;
    const res = await services.bgMsg({ type: "RESOLVE_SEC_UID" }).catch(() => null);
    return res && res.ok ? res.secUid || "" : "";
  }
}
const authorImport = new AuthorImport();

export { authorImport };
