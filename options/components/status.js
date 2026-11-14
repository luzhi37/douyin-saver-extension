// ---------- Status ----------
// 状态弹窗：Cookie 配置 / 浏览器特征 / Tab 模式捕获状态（只读，无保存逻辑）
import { dom, state, services } from '../core.js';
import { dialog } from './dialog.js';

// 状态面板六组签名捕获行同构（label + Status 值 + 可展开复制 Value + Hint）：模板只留
// 容器、此处按表生成——id 命名规则与旧静态标记逐字一致（水合/截断/复制语义零改动）
const SIG_ROWS = [
  ["Detail", "详情捕获"],
  ["Following", "关注捕获"],
  ["Profile", "资料捕获"],
  ["Post", "作品捕获"],
  ["Favorite", "点赞捕获"],
  ["Collection", "收藏捕获"],
];

function buildStatusSigRows() {
  const root = document.getElementById("statusSigRows");
  if (!root || root.childElementCount > 0) return;
  root.innerHTML = SIG_ROWS.map(
    ([key, label]) => `
      <div class="sec-item"><span class="sec-label">${label}</span><span class="sec-value" id="secSig${key}Status"></span></div>
      <div class="sec-item sec-clickable" id="secSig${key}">
        <span class="sec-value sec-truncate" id="secSig${key}Value"></span>
        <span class="sec-expand-hint hidden">[展开]</span>
        <button class="sec-copy-btn hidden" data-copy="secSig${key}Value">复制</button>
      </div>
      <div class="sec-hint hidden" id="secSig${key}Hint"></div>`,
  ).join("");
}

class Status {
  #dialogBody = null;

  #$(id) {
    return this.#dialogBody.querySelector("#" + id);
  }

  // 键值表构建（Cookie 对 / 浏览器特征共用）
  #buildKeyValueTable(entries) {
    const table = document.createElement("table");
    table.className = "cookie-table";
    const colgroup = document.createElement("colgroup");
    const colKey = document.createElement("col");
    colKey.className = "cookie-key-col";
    const colVal = document.createElement("col");
    colgroup.appendChild(colKey);
    colgroup.appendChild(colVal);
    table.appendChild(colgroup);
    const tbody = document.createElement("tbody");
    for (const [k, v] of entries) {
      const tr = document.createElement("tr");
      const tdKey = document.createElement("td");
      tdKey.className = "cookie-key";
      tdKey.textContent = k;
      const tdVal = document.createElement("td");
      const code = document.createElement("code");
      code.className = "cookie-val";
      code.textContent = v;
      tdVal.appendChild(code);
      tr.appendChild(tdKey);
      tr.appendChild(tdVal);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
  }

  async openDialog() {
    const tmpl = document.getElementById("statusDialogTemplate");
    const body = tmpl.content.cloneNode(true);
    dialog.showDialog("状态", body);
    this.#dialogBody = dom.dialogBody;
    this.#bindStatus();
    state.preventDialogClose = true;
    try {
      await this.#refresh();
    } finally {
      state.preventDialogClose = false;
    }
  }

  #statusTimeStr(updatedAt) {
    return updatedAt ? new Date(updatedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "";
  }

  #toggleTruncated(el, hint) {
    if (!el) return;
    const expanded = el.classList.toggle("sec-expanded");
    el.classList.toggle("sec-truncate", !expanded);
    if (hint) hint.textContent = expanded ? "[收起]" : "[展开]";
  }

  #toggleKeyExpand(root) {
    const text = root.querySelector("#secKeyValueText");
    const hint = root.querySelector("#secKeyValue .sec-expand-hint");
    this.#toggleTruncated(text, hint);
  }

  #toggleSigExpand(root, rowId) {
    const row = root.querySelector("#" + rowId);
    if (!row) return;
    const text = row.querySelector(".sec-truncate, .sec-expanded");
    const hint = row.querySelector(".sec-expand-hint");
    if (!text || hint.classList.contains("hidden")) return;
    this.#toggleTruncated(text, hint);
  }

  #renderStatusKey(root, key, updatedAt) {
    const statusEl = root.querySelector("#secKeyStatus");
    const valueEl = root.querySelector("#secKeyValueText");
    const expandHint = root.querySelector("#secKeyValue .sec-expand-hint");
    const hintEl = root.querySelector("#secKeyHint");
    const copyBtn = root.querySelector("#secKeyValue .sec-copy-btn");
    if (key) {
      const t = this.#statusTimeStr(updatedAt);
      statusEl.textContent = t ? `✅ 可用 · ${t}` : "✅ 可用";
      statusEl.className = "sec-value sec-ok";
      valueEl.textContent = key;
      valueEl.classList.add("sec-truncate");
      valueEl.classList.remove("sec-expanded");
      expandHint.classList.remove("hidden");
      expandHint.textContent = "[展开]";
      copyBtn.classList.remove("hidden");
      hintEl.classList.add("hidden");
    } else {
      statusEl.textContent = "❌ 不可用";
      statusEl.className = "sec-value sec-err";
      valueEl.textContent = "—";
      valueEl.classList.add("sec-truncate");
      valueEl.classList.remove("sec-expanded");
      expandHint.classList.add("hidden");
      copyBtn.classList.add("hidden");
      hintEl.classList.remove("hidden");
      hintEl.textContent = "请确保抖音页面已打开且您已登录 → 刷新抖音页面（按 F5） → 等待页面加载完成（约 3-5 秒） → 返回此处点击刷新按钮";
    }
  }

  #renderStatusSig(root, sig, rowId, valueId, guidance) {
    const valueEl = root.querySelector("#" + valueId);
    const statusEl = root.querySelector("#" + valueId.replace(/Value$/, "Status"));
    const expandHint = root.querySelector("#" + rowId + " .sec-expand-hint");
    const hintEl = root.querySelector("#" + valueId.replace(/Value$/, "Hint"));
    const copyBtn = root.querySelector("#" + rowId + " .sec-copy-btn");
    // captured 与 value 分离：捕获可能仅含 SDK 签名键（展示值已剥离），此时仍算已捕获
    const captured = Boolean(sig && sig.captured);
    const v = sig?.value || "";
    const t = sig?.updatedAt || 0;
    if (captured) {
      const ts = this.#statusTimeStr(t);
      statusEl.textContent = `✅ 已捕获${ts ? " · " + ts : ""}${sig?.webSign ? " · webSign" : ""}`;
      statusEl.className = "sec-value sec-ok";
      valueEl.textContent = v || "（仅含签名键，已由页面包装器代签）";
      valueEl.className = "sec-value sec-truncate";
      valueEl.classList.remove("sec-expanded");
      expandHint.classList.remove("hidden");
      expandHint.textContent = "[展开]";
      copyBtn.classList.toggle("hidden", !v);
      hintEl.classList.add("hidden");
    } else {
      statusEl.textContent = "❌ 未捕获";
      statusEl.className = "sec-value sec-err";
      valueEl.textContent = "—";
      valueEl.className = "sec-value sec-err";
      valueEl.classList.remove("sec-expanded");
      expandHint.classList.add("hidden");
      copyBtn.classList.add("hidden");
      hintEl.classList.remove("hidden");
      hintEl.textContent = guidance;
    }
  }

  #renderStatusHooks(root, hooks) {
    const fetchEl = root.querySelector("#secHookFetch");
    const xhrEl = root.querySelector("#secHookXhr");
    fetchEl.textContent = hooks.fetch ? "✅ 运行中" : "❌ 未运行";
    fetchEl.className = "sec-value " + (hooks.fetch ? "sec-ok" : "sec-err");
    xhrEl.textContent = hooks.xhr ? "✅ 运行中" : "❌ 未运行";
    xhrEl.className = "sec-value " + (hooks.xhr ? "sec-ok" : "sec-err");
  }

  #renderStatus(secRes) {
    const root = this.#dialogBody;
    if (!secRes || !secRes.ok || !secRes.status) {
      const errMsg = secRes?.error || "QUERY_FAILED";
      // NO_DOUYIN_TAB 是最常见失败：给出可操作的引导而非裸错误码
      const failText =
        errMsg === "NO_DOUYIN_TAB"
          ? "❌ 未找到抖音标签页（打开抖音页面并等待加载完成后重试）"
          : `❌ 查询失败：${errMsg}`;
      const targets = [
        "secKeyStatus",
        "secSigDetailStatus",
        "secSigFollowingStatus",
        "secSigProfileStatus",
        "secSigPostStatus",
        "secSigFavoriteStatus",
        "secSigCollectionStatus",
        "secHookFetch",
        "secHookXhr",
      ];
      for (const id of targets) {
        const el = root.querySelector("#" + id);
        el.textContent = failText;
        el.className = "sec-value sec-err";
      }
      return;
    }
    const s = secRes.status;
    this.#renderStatusKey(root, s.key, s.keyUpdatedAt);
    this.#renderStatusSig(root, s.signatures?.detail, "secSigDetail", "secSigDetailValue", "请在抖音页面播放任意作品（触发详情请求），等待加载后返回刷新状态");
    this.#renderStatusSig(root, s.signatures?.following, "secSigFollowing", "secSigFollowingValue", "请在抖音页面访问关注列表，等待列表加载后返回刷新状态");
    this.#renderStatusSig(root, s.signatures?.profile, "secSigProfile", "secSigProfileValue", "请在抖音页面访问任意作者主页，等待资料加载后返回刷新状态");
    this.#renderStatusSig(root, s.signatures?.post, "secSigPost", "secSigPostValue", "请在抖音页面访问任意作者主页，等待作品加载后返回刷新状态");
    this.#renderStatusSig(root, s.signatures?.favorite, "secSigFavorite", "secSigFavoriteValue", "请在抖音页面访问喜欢列表，等待列表加载后返回刷新状态");
    this.#renderStatusSig(root, s.signatures?.collection, "secSigCollection", "secSigCollectionValue", "请在抖音页面访问收藏列表，等待列表加载后返回刷新状态");
    this.#renderStatusHooks(root, s.hooks);
  }

  async #refresh() {
    const [ci, bf] = await Promise.all([
      services.bgMsg({ type: "GET_COOKIE_INFO" }),
      services.bgMsg({ type: "GET_BROWSER_FEATURES" }),
    ]);
    const secRes = await services.bgMsg({ type: "GET_SECURITY_STATUS" }).catch((err) => ({ ok: false, error: String(err && err.message || err) }));
    const cookieList = this.#$("statusCookieList");
    cookieList.innerHTML = "";
    const pairs = ci?.pairs || [];
    if (pairs.length > 0) {
      cookieList.appendChild(this.#buildKeyValueTable(pairs.map((p) => [p.key, p.value || ""])));
    } else {
      const hint = document.createElement("p");
      hint.className = "settings-hint";
      hint.textContent = "未捕获到 Cookie，请打开抖音页面";
      cookieList.appendChild(hint);
    }
    const features = bf?.features;
    const list = this.#$("statusBFList");
    list.innerHTML = "";
    if (features) {
      const entries = Object.entries(features).filter(([k]) => k !== "securityKey");
      if (entries.length > 0) {
        list.appendChild(this.#buildKeyValueTable(entries.map(([k, v]) => [k, String(v)])));
      } else {
        list.innerHTML = '<span class="settings-hint">未捕获，将使用默认值。打开抖音页面后可自动捕获。</span>';
      }
    } else {
      list.innerHTML = '<span class="settings-hint">未捕获，将使用默认值。打开抖音页面后可自动捕获。</span>';
    }
    this.#renderStatus(secRes);
  }

  #bindStatus() {
    const root = this.#dialogBody;
    root.querySelectorAll(".sec-expand-hint").forEach((hint) => {
      hint.addEventListener("click", (e) => {
        e.stopPropagation();
        const row = hint.closest(".sec-clickable");
        if (!row) return;
        if (row.id === "secKeyValue") this.#toggleKeyExpand(root);
        else this.#toggleSigExpand(root, row.id);
      });
    });
    root.querySelectorAll(".sec-copy-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const targetId = btn.dataset.copy;
        if (!targetId) return;
        const el = root.querySelector("#" + targetId);
        const text = el?.textContent || "";
        if (!text || text === "\u2014") return;
        navigator.clipboard.writeText(text).then(
          () => dialog.showToast("\u5df2\u590d\u5236", "success")
        );
      });
    });
  }
}

export const status = new Status();

// ---------- 模板占位填充 ----------
// 模块载入即填充（options.html 脚本在 DOM 解析后执行）；面板 openDialog 时惰性 clone
// 模板，生成时机只需早于首次打开
buildStatusSigRows();
