// ---------- AuthorImport（入库） ----------
import { config, dom, state, services } from '../core.js';
import { dialog } from '../components/dialog.js';
import { sync } from './sync.js';
import { domainScanSync } from './domain-scan-sync.js';

// ---------- 入库（作者 → 作品域 / 关注域） ----------
// 菜单「入库」弹窗：两行输入各配一个域按钮。
// 作品域入库 = IMPORT_USER_WORKS 分页循环长任务（进度态复用 syncDialogBodyTemplate，关闭即取消）；
// 关注域入库 = IMPORT_FOLLOWING 单请求收录作者档案（短操作，toast 反馈）。
// 分组语义与「添加作品/添加关注」一致：已在域的保留原分组、新条目落「未分组」
// （由 background mergeWork/mergeAndSaveFollowings 内建，本模块不做任何加工）。
class AuthorImport {
  #running = false;
  #requestId = null;
  #currentSecUid = "";
  #countEl = null;
  #summaryEl = null;
  #statusEl = null;
  #worksInput = null;
  #followingsInput = null;
  #btnWorks = null;
  #btnFollowings = null;
  // 关注域入库单请求短锁：与 #running（作品域长任务）互不覆盖
  #followingsBusy = false;

  isRunning() {
    return this.#running;
  }

  // ---------- 入库弹窗（配置态，两行输入） ----------
  openDialog() {
    if (this.#running) {
      dialog.showToast("已有入库任务进行中", "info");
      return;
    }
    const body = document.createElement("div");
    body.className = "import-rows";
    body.innerHTML = `
      <div class="import-row">
        <input class="import-input works-input" placeholder="sec_uid / uid / 主页链接" spellcheck="false" aria-label="作品域入库作者">
        <button class="dy-btn flex-inline-center dy-btn-primary btn-import-works">作品域入库</button>
      </div>
      <div class="import-row">
        <input class="import-input followings-input" placeholder="sec_uid / uid / 主页链接" spellcheck="false" aria-label="关注域入库作者">
        <button class="dy-btn flex-inline-center dy-btn-primary btn-import-followings">关注域入库</button>
      </div>
    `;
    this.#worksInput = body.querySelector(".works-input");
    this.#followingsInput = body.querySelector(".followings-input");
    this.#btnWorks = body.querySelector(".btn-import-works");
    this.#btnFollowings = body.querySelector(".btn-import-followings");
    dialog.showDialog("入库", body, [], () => this.closeDialog());

    this.#btnWorks.addEventListener("click", () => this.startWorksImport());
    this.#btnFollowings.addEventListener("click", () => this.startFollowingImport());
    // 输入框内回车触发本行按钮（键盘 a11y 约定）
    this.#worksInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.startWorksImport();
    });
    this.#followingsInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.startFollowingImport();
    });
  }

  closeDialog() {
    dialog.closeDialog();
    this.#running = false;
    this.#requestId = null;
    this.#currentSecUid = "";
    this.#countEl = this.#summaryEl = this.#statusEl = null;
    this.#worksInput = this.#followingsInput = null;
    this.#btnWorks = this.#btnFollowings = null;
  }

  // ---------- 作品域入库（长任务） ----------
  async startWorksImport() {
    if (this.#running || !this.#worksInput) return;
    // 三条 background 循环链路（sync / 域扫描 / 本入库）互斥，避免叠加请求频率
    if (sync.isRunning() || domainScanSync.isRunning()) {
      dialog.showToast("同步进行中，请等待完成后再入库", "error");
      return;
    }
    const parsed = this.#parseAuthorInput(this.#worksInput.value);
    if (!parsed) {
      dialog.showToast("请输入作者主页链接、sec_uid 或数字 uid", "error");
      return;
    }
    const secUid = await this.#resolveSecUid(parsed);
    if (!this.#worksInput) return; // 解析期间弹窗已被关闭
    if (!secUid) {
      dialog.showToast("无法解析该 uid，请改用主页链接或 sec_uid", "error");
      return;
    }

    this.#running = true;
    this.#requestId = null;
    this.#currentSecUid = secUid;
    // 清残留任务再开新循环（DomainScanSync 同款）
    chrome.runtime.sendMessage({ type: "CANCEL_ACTIVE_TASK" }).catch(() => {});
    this.#openProgressDialog();

    try {
      const res = await services.bgMsg({ type: "IMPORT_USER_WORKS", secUid });
      if (!this.#running) return; // 弹窗已关闭（取消）：迟到的终态静默吞掉，已落库部分保留
      if (!res || res.ok !== true) {
        this.#showError(res?.error || "IMPORT_FAILED");
        return;
      }
      this.#requestId = null;
      this.#showDone(res);
    } catch (err) {
      if (!this.#running) return;
      this.#showError(err.message || String(err));
    }
  }

  // ---------- 关注域入库（短操作） ----------
  async startFollowingImport() {
    if (this.#followingsBusy || !this.#followingsInput) return;
    const parsed = this.#parseAuthorInput(this.#followingsInput.value);
    if (!parsed) {
      dialog.showToast("请输入作者主页链接、sec_uid 或数字 uid", "error");
      return;
    }
    this.#followingsBusy = true;
    this.#setFollowingsBtn(true);
    try {
      const secUid = await this.#resolveSecUid(parsed);
      if (!this.#followingsInput) return; // 解析期间弹窗已被关闭
      if (!secUid) {
        dialog.showToast("无法解析该 uid，请改用主页链接或 sec_uid", "error");
        return;
      }
      const res = await services.bgMsg({ type: "IMPORT_FOLLOWING", secUid });
      if (!res || res.ok !== true) {
        const msg = res?.error || "未知错误";
        if (msg === "NO_SIGNATURE") {
          // profile 签名源兜底含 postQuery：引导打开作者主页并浏览作品列表即可完成捕获
          dialog.showNoSignatureDialog(config.URL_BASE + "/user/" + secUid, "作品", "收录作者档案");
          return;
        }
        dialog.showToast(msg.includes("2096") ? "该账号因隐私设置不可见" : "关注域入库失败: " + msg, "error");
        return;
      }
      const f = res.following || {};
      const verb = res.added > 0 ? "新增" : "更新";
      dialog.showToast(`已${verb}关注域：${f.nickname || "未知"}（新作者入「未分组」）`, "success");
      this.#followingsInput.value = "";
      if (state.domain === "followings") await services.loadDomainData();
    } finally {
      this.#followingsBusy = false;
      this.#setFollowingsBtn(false);
    }
  }

  // 进度消息入口（options 全局 listener 分发）；requestId 在终态前拿不到，running 期间全收
  //（三链路互斥保证不会串线，DomainScanSync 同款过滤逻辑）
  onProgress(msg) {
    if (!this.#running) return;
    if (this.#requestId !== null && msg.requestId !== this.#requestId) return;
    if (msg.type !== "IMPORT_WORKS_PROGRESS") return;
    const total = msg.total > 0 ? ` / 约 ${msg.total}` : "";
    if (this.#countEl) this.#countEl.textContent = `已扫描作品 ${msg.collected ?? 0}${total} · 已入库 ${msg.saved ?? 0}`;
  }

  // ---------- 私有：弹窗三态 ----------

  #openProgressDialog() {
    const tmpl = document.getElementById("syncDialogBodyTemplate");
    const body = tmpl.content.cloneNode(true);
    this.#countEl = body.querySelector(".sync-count");
    this.#summaryEl = body.querySelector(".sync-summary");
    this.#statusEl = body.querySelector(".sync-status");
    this.#countEl.textContent = "已扫描作品 0";
    this.#summaryEl.textContent = "正在获取作者作品…";
    this.#statusEl.textContent = "SYNCING";
    // 进度层叠于「入库」弹窗之上：关闭后回到弹窗继续操作（结果就地改写同层内容）
    dialog.pushDialog("导入作者作品", body, [], () => this.closeDialog());
  }

  #showDone(res) {
    const tmpl = document.getElementById("syncDialogBodyTemplate");
    const body = tmpl.content.cloneNode(true);
    this.#countEl = body.querySelector(".sync-count");
    this.#summaryEl = body.querySelector(".sync-summary");
    this.#statusEl = body.querySelector(".sync-status");
    this.#countEl.textContent = `已扫描作品 ${res.collected ?? 0}`;
    this.#summaryEl.textContent = `新增 ${res.added ?? 0}（入「未分组」）· 更新 ${res.updated ?? 0}（保留原分组）`;
    this.#statusEl.textContent = res.timedOut ? "PARTIAL" : "DONE";
    if (res.timedOut) {
      const hint = document.createElement("p");
      hint.className = "dy-text-danger sync-timeout-hint";
      hint.textContent = "已中途取消，仅保留部分数据";
      body.appendChild(hint);
    }
    // 结果就地改写进度层（showDialog 会清栈重建基层、摧毁「入库」弹窗，不可用）
    dom.dialogTitle.textContent = "导入作者作品";
    dom.dialogBody.innerHTML = "";
    dom.dialogBody.appendChild(body);
    dom.dialogFooter.innerHTML = "";
    dialog.showOkDialog();
    // 当前正处于作品域才刷新（不替用户切域；switchDomain 本就会重载目标域）
    if (state.domain === "works") services.loadDomainData();
  }

  // 错误展示：进度弹窗内联（summary 清空 + status 显示错误，DomainScanSync 同款）；
  // NO_SIGNATURE 关弹窗换签名引导（URL 指向作者主页，浏览作品列表即完成捕获）
  #showError(errorMsg) {
    const msg = errorMsg || "UNKNOWN";
    if (msg === "NO_SIGNATURE") {
      const url = config.URL_BASE + "/user/" + (this.#currentSecUid || "");
      this.closeDialog();
      dialog.showNoSignatureDialog(url, "作品", "导入作品");
      return;
    }
    if (this.#statusEl) this.#statusEl.textContent = msg.includes("2096") ? "账号作品因隐私设置不可见" : msg;
    if (this.#summaryEl) this.#summaryEl.textContent = "";
  }

  #setFollowingsBtn(busy) {
    if (!this.#btnFollowings?.isConnected) return;
    this.#btnFollowings.disabled = busy;
    this.#btnFollowings.textContent = busy ? "入库中…" : "关注域入库";
  }

  // ---------- 私有：输入解析与 secUid 兑换 ----------

  // 输入三形态：主页链接（pathname /user/<sec_uid>，天然免疫 query；兼容无协议的
  // 地址栏复制形态）、裸 sec_uid（长 token）、纯数字 uid。返回 { idType, id } 或 null
  #parseAuthorInput(text) {
    const raw = (text || "").trim();
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw) || /^[\w.-]+\.[a-z]{2,}\//i.test(raw)) {
      try {
        const url = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
        const m = url.pathname.match(config.SEC_UID_REGEX);
        // 是链接但解析不到 sec_uid（@handle 主页 / 短链）直接判无效，不落入裸 id 分支
        return m ? { idType: "secUid", id: m[1] } : null;
      } catch (_) {
        return null;
      }
    }
    if (/^\d+$/.test(raw)) return { idType: "uid", id: raw };
    if (/^[A-Za-z0-9_-]{30,}$/.test(raw)) return { idType: "secUid", id: raw };
    return null;
  }

  // 解析输入为 secUid：sec_uid 直通；uid 经 RESOLVE_AUTHOR 兑换（im/user/info），失败返回空串
  async #resolveSecUid(parsed) {
    if (parsed.idType === "secUid") return parsed.id;
    const res = await services.bgMsg({ type: "RESOLVE_AUTHOR", id: parsed.id, idType: "uid" }).catch(() => null);
    return res && res.ok ? res.secUid || "" : "";
  }
}
const authorImport = new AuthorImport();

export { authorImport };
