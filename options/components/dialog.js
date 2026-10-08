// ---------- Dialog ----------
import { config, dom, state } from '../core.js';

// ---------- Dialog ----------
// 多层弹窗：基层为静态 #dialogOverlay，上层经 pushDialog 动态创建独立 overlay 实例叠于其上
// （z-index 逐层递增、遮罩减淡，父层 DOM 原地保留——监听器/输入值/滚动位置不丢，关闭顶层即回到父层）。
// dom.dialogTitle/dialogBody/dialogFooter/dialogClose 四字段由本类动态指向顶层实例元素，调用方
// 即时访问自动命中顶层（仅本类可写）；dom.dialogOverlay 恒指基层，其 hidden 即「有无弹窗」全局信号。
class Dialog {
  #toastTimer = null;
  #lastFocused = null;
  #layers = []; // { overlay, title, body, footer, onClose }

  get depth() {
    return this.#layers.length;
  }

  get isBase() {
    return this.#layers.length <= 1;
  }

  showDialog(title, body, footerBtns, onClose) {
    // 基层语义：销毁全部上层实例后重置基层内容（无链式关系的调用点行为不变）
    while (this.#layers.length > 1) this.closeDialog();
    if (this.#layers.length === 0) this.#layers.push(this.#baseLayer());
    this.#mountLayer(this.#layers[0], title, body, footerBtns, onClose);
  }

  // 叠加一层新弹窗：当前层原地保留为父层，关闭新层后自动回到父层继续操作
  pushDialog(title, body, footerBtns, onClose) {
    const layer = this.#createLayer();
    this.#layers.push(layer);
    this.#mountLayer(layer, title, body, footerBtns, onClose);
  }

  // 基层帧：容器即静态 #dialogOverlay，元素节点稳定（showDialog 只清空 body/footer 内部，不换节点）
  #baseLayer() {
    return {
      overlay: dom.dialogOverlay,
      title: dom.dialogOverlay.querySelector("#dialogTitle"),
      body: dom.dialogOverlay.querySelector("#dialogBody"),
      footer: dom.dialogOverlay.querySelector("#dialogFooter"),
      onClose: null,
      enterExplicit: null,
      dangerAction: null,
      primaryAction: null,
      ctrlEnterAction: null,
    };
  }

  #createLayer() {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay layered";
    overlay.style.zIndex = String(1000 + this.#layers.length);
    overlay.innerHTML =
      '<div class="dy-dialog flex-col" role="dialog" aria-modal="true">' +
      '<div class="dy-dialog-header flex-row">' +
      '<span class="dialog-layer-title"></span>' +
      '<button class="dy-dialog-close icon-btn flex-center" aria-label="关闭">✕</button>' +
      '</div>' +
      '<div class="dy-dialog-body"></div>' +
      '<div class="dy-dialog-footer"></div>' +
      '</div>';
    document.body.appendChild(overlay);
    return {
      overlay,
      title: overlay.querySelector(".dialog-layer-title"),
      body: overlay.querySelector(".dy-dialog-body"),
      footer: overlay.querySelector(".dy-dialog-footer"),
      onClose: null,
      enterExplicit: null,
      dangerAction: null,
      primaryAction: null,
      ctrlEnterAction: null,
    };
  }

  #mountLayer(layer, title, body, footerBtns, onClose) {
    layer.overlay.classList.remove("hidden");
    layer.title.textContent = title;
    layer.body.innerHTML = "";
    layer.footer.innerHTML = "";
    this.#resetFooterHotkeys(layer);
    layer.onClose = onClose || null;
    this.#syncTopDom();
    // 顶层 onClose 登记给 requestDialogClose：X/Esc 关闭时调用并联动 CANCEL_ACTIVE_TASK
    state.activeDialog = layer.onClose;

    if (typeof body === "string") {
      layer.body.innerHTML = body;
    } else if (body instanceof DocumentFragment || body instanceof HTMLElement) {
      layer.body.appendChild(body);
    }

    if (footerBtns) {
      const created = [];
      for (const btn of footerBtns) {
        const el = document.createElement("button");
        el.className = `dy-btn flex-inline-center ${btn.primary ? "dy-btn-primary" : ""} ${btn.danger ? "dy-btn-danger" : ""} ${btn.ghost ? "dy-btn-ghost" : ""}`;
        el.textContent = btn.text;
        el.addEventListener("click", btn.callback);
        this.#applyBtnHotkey(layer, btn, btn.callback);
        layer.footer.appendChild(el);
        created.push([btn, el]);
      }
      // 徽标只标真正占用槽位的按钮：Ctrl+Enter 跟随显式标注；Enter 徽标跟随后解析的
      // 主动作（enterExplicit > danger > primary），与 handleKeydown 分发同源不脱钩
      const enterCb = layer.enterExplicit || layer.dangerAction || layer.primaryAction;
      for (const [btn, el] of created) {
        this.#applyHotkeyBadge(el, btn.hotkey === "ctrl+enter" ? "Ctrl+Enter" : btn.callback === enterCb ? "Enter" : "");
      }
    }

    // 焦点管理（建议3）：基层打开时记触发元素、最终关闭时还原；打开上层不覆盖该记录，
    // 关闭上层后焦点移入还原出的下层第一控件
    if (this.#layers.length === 1) {
      this.#lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    this.focusFirstControl();
  }

  #syncTopDom() {
    const top = this.#layers[this.#layers.length - 1];
    dom.dialogTitle = top.title;
    dom.dialogBody = top.body;
    dom.dialogFooter = top.footer;
    dom.dialogClose = top.overlay.querySelector(".dy-dialog-close");
  }

  closeDialog() {
    const top = this.#layers[this.#layers.length - 1];
    // 关键防御：防止重复关闭触发栈溢出或重复回调
    if (!top || (this.#layers.length === 1 && top.overlay.classList.contains("hidden"))) {
      state.activeDialog = null;
      return;
    }
    this.#layers.pop();
    if (this.#layers.length === 0) {
      state.activeDialog = null;
      top.overlay.classList.add("hidden");
      if (this.#lastFocused?.isConnected) this.#lastFocused.focus();
      this.#lastFocused = null;
      return;
    }
    // 上层关闭：实例销毁、露出下层（activeDialog 还原为父层回调），焦点移入还原层
    state.activeDialog = this.#layers[this.#layers.length - 1].onClose;
    top.overlay.remove();
    this.#syncTopDom();
    this.focusFirstControl();
  }

  // ---------- footer 按钮键盘直达（无焦点设计） ----------
  // 键盘不依赖焦点、不管理 Tab：Enter 直接触发顶层弹窗的主动作，Ctrl+Enter 触发显式
  // hotkey 标注的次要动作。登记随 footer 增清同步：mount 重置、追加按钮补登、
  // updateDialog 清 footer 即失效——杜绝悬空引用已移除按钮的回调
  #resetFooterHotkeys(layer) {
    layer.enterExplicit = null;
    layer.dangerAction = null;
    layer.primaryAction = null;
    layer.ctrlEnterAction = null;
  }

  // 推断规则：danger 优先于 primary 占 Enter，ghost 永不占（取消语义 Esc 已覆盖）；
  // 显式 hotkey 覆盖推断。Ctrl+Enter 槽仅显式 `hotkey: "ctrl+enter"` 可占、不做自动推断
  //（避免危险弹窗两个动作都被键盘直达）
  #applyBtnHotkey(layer, def, callback) {
    if (def.hotkey === "ctrl+enter") {
      layer.ctrlEnterAction = callback;
    } else if (def.hotkey === "enter") {
      layer.enterExplicit = callback;
    } else if (def.danger) {
      layer.dangerAction = callback;
    } else if (def.primary) {
      layer.primaryAction = callback;
    }
  }

  // 按钮内快捷键徽标（.dy-btn-kbd）：与 handleKeydown 的实际绑定严格一致，label 为空不加节点
  #applyHotkeyBadge(el, label) {
    if (!label) return;
    const kbd = document.createElement("kbd");
    kbd.className = "dy-btn-kbd";
    kbd.textContent = label;
    el.appendChild(kbd);
  }

  // 键盘直达收口（document 级监听在本文件底部绑定）：只作用顶层弹窗；输入框让位（改名/
  // 新分组/入库等输入位 Enter 有自身语义）；Esc 不在此处理（main.js 单点收口）。
  // 焦点恰好落在顶层弹窗内部的操作按钮（原生 Tab / 鼠标点击残留）时全让位走原生激活，
  // 不与直达键争抢；✕ 关闭钮除外——它是 focusFirstControl 对纯文本弹窗的默认落点，
  // 若让位则 Enter 恒走原生「点击 ✕ = 关闭」，直达键永无生效机会（2026-10-03 修复）。
  // 弹窗外的残留焦点元素则被 preventDefault 屏蔽（Chrome 鼠标点过的按钮保留 DOM 焦点，
  // 否则弹窗开着按 Enter/Space 会被那个看不见的焦点隐形触发）
  handleKeydown(e) {
    if (this.#layers.length === 0) return;
    const top = this.#layers[this.#layers.length - 1];
    if (top.overlay.classList.contains("hidden")) return;
    const t = e.target;
    if (t instanceof HTMLElement && t.closest("input, textarea, select, [contenteditable]")) return;
    if (
      t instanceof Element &&
      top.overlay.contains(t) &&
      t.closest("button") &&
      !t.closest(".dy-dialog-close")
    ) {
      return;
    }
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    if (e.key === "Enter" && !e.altKey) {
      if (e.ctrlKey || e.metaKey) top.ctrlEnterAction?.();
      else (top.enterExplicit || top.dangerAction || top.primaryAction)?.();
    }
  }

  addTrashButton(onClick, onClose) {
    const btn = document.createElement("button");
    btn.className = "dy-btn flex-inline-center dy-btn-ghost";
    btn.textContent = "稍后删除";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await onClick();
      onClose();
    });
    dom.dialogFooter.appendChild(btn);
  }

  focusFirstControl() {
    const focusable = dom.dialogBody.querySelector(
      "button, input:not([type='hidden']), select, textarea, [tabindex]:not([tabindex='-1'])",
    );
    (focusable || dom.dialogClose).focus();
  }

  updateDialog(title, bodyHtml) {
    dom.dialogTitle.textContent = title;
    dom.dialogBody.innerHTML = bodyHtml || "";
    dom.dialogFooter.innerHTML = "";
    const top = this.#layers[this.#layers.length - 1];
    if (top) this.#resetFooterHotkeys(top);
  }

  addDialogBtn(text, type, cb) {
    const btn = document.createElement("button");
    btn.className = `dy-btn flex-inline-center dy-btn-${type}`;
    btn.textContent = text;
    btn.addEventListener("click", cb);
    dom.dialogFooter.appendChild(btn);
    const top = this.#layers[this.#layers.length - 1];
    if (top) {
      this.#applyBtnHotkey(top, { danger: type === "danger", primary: type === "primary" }, cb);
      const resolved = top.enterExplicit || top.dangerAction || top.primaryAction;
      if (cb === resolved) this.#applyHotkeyBadge(btn, "Enter");
    }
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
    if (this.#toastTimer) clearTimeout(this.#toastTimer);
    this.#toastTimer = setTimeout(() => {
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
    const body = document.createElement("div");
    body.innerHTML = `
      <p>扩展需要先从抖音页面捕获请求签名才能${scanLabel}。</p>
      <p style="margin-top:8px">请按以下步骤操作：</p>
      <ol style="margin-top:4px;padding-left:20px;line-height:1.8">
        <li>在浏览器中打开 <code style="font-size:12px">${tabUrl}</code></li>
        <li>在打开的页面上点击「${stepLabel}」标签（页面会自动加载列表）</li>
        <li>回到本扩展，再次点击「${scanLabel}」</li>
      </ol>
    `;
    // 必须走 showDialog：直接写 dom.dialog* 不会解除基层 hidden（栈空时弹窗不可见）
    this.showDialog("未捕获到签名", body, [
      { text: "好的", primary: true, callback: () => this.closeDialog() },
    ]);
  }
}

export const dialog = new Dialog();

// ---------- 弹窗键盘直达监听 ----------
// Enter/Ctrl+Enter/Space 分发见 Dialog#handleKeydown；Esc 归 main.js 单点收口，Tab 不管理
//（无焦点设计）
document.addEventListener("keydown", (e) => dialog.handleKeydown(e));
