// ---------- Dialog ----------
import { config, dom, state } from '../core.js';

// ---------- Dialog ----------
export class Dialog {
  constructor() {
    this.__toastTimer = null;
    this.__lastFocused = null;
  }

  showDialog(title, body, footerBtns, onClose) {
    dom.dialogOverlay.classList.remove("hidden");
    dom.dialogTitle.textContent = title;
    dom.dialogBody.innerHTML = "";
    state.activeDialog = onClose || null;

    if (typeof body === "string") {
      dom.dialogBody.innerHTML = body;
    } else if (body instanceof DocumentFragment || body instanceof HTMLElement) {
      dom.dialogBody.appendChild(body);
    }

    dom.dialogFooter.innerHTML = "";
    if (footerBtns) {
      for (const btn of footerBtns) {
        const el = document.createElement("button");
        el.className = `dy-btn flex-inline-center ${btn.primary ? "dy-btn-primary" : ""} ${btn.danger ? "dy-btn-danger" : ""} ${btn.ghost ? "dy-btn-ghost" : ""}`;
        el.textContent = btn.text;
        el.addEventListener("click", btn.callback);
        dom.dialogFooter.appendChild(el);
      }
    }

    // 焦点管理：打开时移入弹窗、关闭后还原到触发元素（docs/UI_IMPROVEMENTS.md 建议3）
    this.__lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.focusFirstControl();
  }

  focusFirstControl() {
    const focusable = dom.dialogBody.querySelector(
      "button, input:not([type='hidden']), select, textarea, [tabindex]:not([tabindex='-1'])",
    );
    (focusable || dom.dialogClose).focus();
  }

  closeDialog() {
    // 关键防御:防止重复关闭触发栈溢出或重复回调
    if (dom.dialogOverlay.classList.contains("hidden")) {
      state.activeDialog = null;
      return;
    }
    state.activeDialog = null;
    dom.dialogOverlay.classList.add("hidden");
    if (this.__lastFocused?.isConnected) this.__lastFocused.focus();
    this.__lastFocused = null;
  }

  updateDialog(title, bodyHtml) {
    dom.dialogTitle.textContent = title;
    dom.dialogBody.innerHTML = bodyHtml || "";
    dom.dialogFooter.innerHTML = "";
  }

  addDialogBtn(text, type, cb) {
    const btn = document.createElement("button");
    btn.className = `dy-btn flex-inline-center dy-btn-${type}`;
    btn.textContent = text;
    btn.addEventListener("click", cb);
    dom.dialogFooter.appendChild(btn);
  }

  showOkDialog() {
    this.addDialogBtn("好的", "primary", () => this.closeDialog());
  }

  // 分型 toast（建议1）：info 默认；success/error 带左色条，error 加长驻留
  showToast(message, type = "info") {
    const toast = document.getElementById("dy-options-toast");
    toast.textContent = message;
    toast.classList.remove("hide", "toast-info", "toast-success", "toast-error");
    toast.classList.add("show", `toast-${type}`);
    if (this.__toastTimer) clearTimeout(this.__toastTimer);
    this.__toastTimer = setTimeout(() => {
      toast.classList.remove("show");
      toast.classList.add("hide");
    }, type === "error" ? config.TOAST_ERROR_DURATION : config.TOAST_DURATION);
  }

  showGroupSelectDialog(title, groups, onSelect) {
    const list = document.createElement("div");
    list.className = "group-select-list";
    const tmpl = document.getElementById("groupSelectItemTemplate");
    for (const g of groups.filter((g) => !g.fixed)) {
      const el = tmpl.content.cloneNode(true).firstElementChild;
      el.dataset.groupId = g.id;
      el.appendChild(document.createTextNode(" " + g.name));
      el.addEventListener("click", () => onSelect(g.id));
      list.appendChild(el);
    }
    this.showDialog(title, list);
  }

  showNoSignatureDialog(tabUrl, stepLabel, scanLabel) {
    dom.dialogTitle.textContent = "未捕获到签名";
    dom.dialogBody.innerHTML = `
      <p>扩展需要先从抖音页面捕获请求签名才能${scanLabel}。</p>
      <p style="margin-top:8px">请按以下步骤操作：</p>
      <ol style="margin-top:4px;padding-left:20px;line-height:1.8">
        <li>在浏览器中打开 <code style="font-size:12px">${tabUrl}</code></li>
        <li>在打开的页面上点击「${stepLabel}」标签（页面会自动加载列表）</li>
        <li>回到本扩展，再次点击「${scanLabel}」</li>
      </ol>
    `;
    this.showOkDialog();
  }

  showFetchErrorDialog(msg) {
    dom.dialogTitle.textContent = "获取失败";
    let hint = msg;
    if (msg.includes("NO_DOUYIN_TAB")) hint = "未找到抖音页面，请确保已打开抖音";
    else if (msg.includes("TIMEOUT")) hint = "获取超时，可能是网络问题或内容过多";
    else if (msg.includes("HTTP_403")) {
      // 注意：任何 403 都会走到这里，服务端未必真的返回「sign invalid」——同源 fetch
      // 元数据（Sec-Fetch-Site/Origin）被 DNR 剥离、会话过期等同样会触发 403。不要再把
      // 所有 403 一律归因为签名被拒，以免误导用户反复刷新无关缓存。
      hint = "抖音返回 403 拒绝了该请求。若已刷新 Cookie/webid/msToken/浏览器特征仍失败，多为请求头被服务端拦截（独立模式 POST 端点尤甚），可改用标签页模式扫描，或重新刷新缓存后重试";
    }
    dom.dialogBody.innerHTML = `<p>${hint}</p>`;
    this.showOkDialog();
  }
}

export const dialog = new Dialog();
