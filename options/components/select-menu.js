// ---------- SelectMenu ----------
// 自绘下拉（.sb-scope）统一交互：鼠标 + 键盘 + ARIA。
// 搜索栏（类型/排序/关注排序）与顶栏回顾来源下拉同构复用；DOM 由 options.html 提供。
const FOCUS_CLASS = "is-focus";
const HIDDEN_CLASS = "hidden";

export class SelectMenu {
  #el;
  #menu;
  #valueEl;
  #options;
  #optionAttr;
  #onSelect;
  #activeIndex = 0;
  #isOpen = false;
  #onDocumentClick = (e) => {
    if (this.#isOpen && !this.#el.contains(e.target)) this.close();
  };

  constructor(el, onSelect, { optionAttr = "data-value" } = {}) {
    this.#el = el;
    this.#menu = el?.querySelector(".sb-scope-menu") || null;
    this.#valueEl = el?.querySelector(".sb-scope-value") || null;
    this.#options = el ? Array.from(el.querySelectorAll(".sb-scope-option")) : [];
    this.#optionAttr = optionAttr;
    this.#onSelect = typeof onSelect === "function" ? onSelect : () => {};
    if (!this.#menu || this.#options.length === 0) return;

    this.#initA11y();
    this.#bindEvents();
    this.#isOpen = !this.#menu.classList.contains(HIDDEN_CLASS);
    this.#el.setAttribute("aria-expanded", String(this.#isOpen));
  }

  // 按选项属性值同步文案/激活态/aria-selected；值失配时只回退文案
  sync(value, fallback = "") {
    const index = this.#options.findIndex((opt) => opt.getAttribute(this.#optionAttr) === value);
    if (index < 0) {
      if (this.#valueEl) this.#valueEl.textContent = fallback;
      this.#options.forEach((opt) => {
        opt.classList.remove("active");
        opt.setAttribute("aria-selected", "false");
      });
      return;
    }
    this.#activeIndex = index;
    this.#options.forEach((opt, i) => {
      const on = i === index;
      opt.classList.toggle("active", on);
      opt.setAttribute("aria-selected", String(on));
    });
    if (this.#valueEl) this.#valueEl.textContent = this.#options[index].textContent.trim();
    if (this.#isOpen) this.#setActive(index);
  }

  open() {
    if (this.#isOpen) return;
    this.#isOpen = true;
    this.#menu.classList.remove(HIDDEN_CLASS);
    this.#el.setAttribute("aria-expanded", "true");
    const active = this.#options.findIndex(
      (opt) => opt.classList.contains("active") && !opt.classList.contains(HIDDEN_CLASS),
    );
    const visible = this.#visibleOptions();
    this.#activeIndex = active >= 0 ? active : this.#options.indexOf(visible[0] || this.#options[0]);
    this.#setActive(this.#activeIndex);
    if (document.activeElement !== this.#el) this.#el.focus({ preventScroll: true });
  }

  close({ focus = false } = {}) {
    if (!this.#isOpen) {
      if (focus) this.#el.focus({ preventScroll: true });
      return;
    }
    this.#isOpen = false;
    this.#menu.classList.add(HIDDEN_CLASS);
    this.#el.setAttribute("aria-expanded", "false");
    this.#el.removeAttribute("aria-activedescendant");
    this.#options.forEach((opt) => opt.classList.remove(FOCUS_CLASS));
    if (focus) this.#el.focus({ preventScroll: true });
  }

  toggle() {
    if (this.#isOpen) this.close();
    else this.open();
  }

  #initA11y() {
    const base = this.#el.id || "sbSelect";
    if (!this.#menu.id) this.#menu.id = `${base}Menu`;
    this.#el.setAttribute("role", "combobox");
    this.#el.setAttribute("tabindex", "0");
    this.#el.setAttribute("aria-haspopup", "listbox");
    this.#el.setAttribute("aria-controls", this.#menu.id);
    this.#menu.setAttribute("role", "listbox");
    this.#menu.setAttribute("aria-label", `${this.#el.getAttribute("aria-label") || "选项"}选项`);
    this.#options.forEach((opt, i) => {
      opt.setAttribute("role", "option");
      // 选项不进 Tab 序：焦点留在 combobox，用 aria-activedescendant 表达高亮项
      opt.setAttribute("tabindex", "-1");
      if (!opt.id) opt.id = `${base}Opt${i}`;
      opt.setAttribute("aria-selected", String(opt.classList.contains("active")));
    });
    const active = this.#options.findIndex((opt) => opt.classList.contains("active"));
    this.#activeIndex = active >= 0 ? active : 0;
  }

  #bindEvents() {
    this.#el.addEventListener("click", (e) => this.#onClick(e));
    this.#el.addEventListener("keydown", (e) => this.#onKeydown(e));
    document.addEventListener("click", this.#onDocumentClick);
  }

  #onClick(e) {
    const opt = e.target.closest(".sb-scope-option");
    if (opt) {
      this.#select(opt);
      return;
    }
    if (this.#menu.contains(e.target)) return;
    this.toggle();
  }

  #onKeydown(e) {
    if (e.key === "Escape") {
      if (!this.#isOpen) return;
      e.preventDefault();
      e.stopPropagation();
      this.close({ focus: true });
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!this.#isOpen) this.open();
      else this.#select(this.#options[this.#activeIndex]);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!this.#isOpen) {
        this.open();
        return;
      }
      this.#move(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      if (!this.#isOpen) return;
      e.preventDefault();
      const visible = this.#visibleOptions();
      if (visible.length === 0) return;
      const target = e.key === "Home" ? visible[0] : visible[visible.length - 1];
      this.#setActive(this.#options.indexOf(target));
      return;
    }
    if (e.key === "Tab" && this.#isOpen) this.close();
  }

  #select(opt) {
    const index = this.#options.indexOf(opt);
    if (index < 0) return;
    this.#options.forEach((item, i) => {
      const on = i === index;
      item.classList.toggle("active", on);
      item.setAttribute("aria-selected", String(on));
    });
    if (this.#valueEl) this.#valueEl.textContent = opt.textContent.trim();
    this.#onSelect(opt);
    this.close({ focus: true });
  }

  #move(step) {
    const visible = this.#visibleOptions();
    if (visible.length === 0) return;
    const current = this.#options[this.#activeIndex];
    let pos = visible.indexOf(current);
    if (pos < 0) pos = step > 0 ? -1 : 0;
    const next = visible[(pos + step + visible.length) % visible.length];
    this.#setActive(this.#options.indexOf(next));
  }

  // 键盘导航跳过隐藏选项（按域显隐的控件复用同一套开合逻辑）
  #visibleOptions() {
    return this.#options.filter((opt) => !opt.classList.contains(HIDDEN_CLASS));
  }

  #setActive(index) {
    if (index < 0 || index >= this.#options.length) return;
    this.#activeIndex = index;
    this.#options.forEach((opt, i) => opt.classList.toggle(FOCUS_CLASS, i === index));
    const active = this.#options[index];
    if (active) this.#el.setAttribute("aria-activedescendant", active.id);
  }
}
