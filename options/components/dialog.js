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
    };
  }

  #mountLayer(layer, title, body, footerBtns, onClose) {
    layer.overlay.classList.remove("hidden");
    layer.title.textContent = title;
    layer.body.innerHTML = "";
    layer.footer.innerHTML = "";
    layer.onClose = onClose || null;
    this.#syncTopDom();

    if (typeof body === "string") {
      layer.body.innerHTML = body;
    } else if (body instanceof DocumentFragment || body instanceof HTMLElement) {
      layer.body.appendChild(body);
    }

    if (footerBtns) {
      for (const btn of footerBtns) {
        const el = document.createElement("button");
        el.className = `dy-btn flex-inline-center ${btn.primary ? "dy-btn-primary" : ""} ${btn.danger ? "dy-btn-danger" : ""} ${btn.ghost ? "dy-btn-ghost" : ""}`;
        el.textContent = btn.text;
        el.addEventListener("click", btn.callback);
        layer.footer.appendChild(el);
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
}

export const dialog = new Dialog();
