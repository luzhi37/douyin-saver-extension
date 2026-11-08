// ---------- Tooltip ----------
import { dom } from '../core.js';

// 全局 title tooltip：接管原生 title 的显示，统一抖音风格的深色浮层与定位。
// 仅服务视觉；aria-label 仍由控件自身维护。显示期间临时移除 title，防止原生 tooltip 叠加；
// 若控件在悬浮期间被动态改写 title，离开时以新值为准、不恢复旧值。
class Tooltip {
  #current = null;
  #storedTitle = "";
  #showTimer = 0;
  #initialized = false;

  initTooltip() {
    if (this.#initialized || !dom.dyTooltip) return;
    this.#initialized = true;
    document.addEventListener("pointerover", this.#onPointerOver);
    document.addEventListener("pointerout", this.#onPointerOut);
    document.addEventListener("pointerdown", this.#onPointerDown, true);
    window.addEventListener("scroll", this.#hideTipOnly, true);
    window.addEventListener("resize", this.#hideTipOnly);
  }

  #onPointerOver = (e) => {
    if (e.pointerType === "touch") return;
    const el = e.target instanceof Element ? e.target.closest("[title]") : null;
    if (!el || el === this.#current) return;
    const title = el.getAttribute("title");
    if (!title) return;
    this.#hide();
    this.#current = el;
    this.#storedTitle = title;
    el.removeAttribute("title");
    this.#showTimer = window.setTimeout(() => this.#show(el), 90);
  };

  #onPointerOut = (e) => {
    if (!this.#current) return;
    if (e.relatedTarget instanceof Node && this.#current.contains(e.relatedTarget)) return;
    this.#hide();
  };

  #onPointerDown = () => this.#hide();

  #show(el) {
    if (el !== this.#current || !this.#storedTitle || !el.isConnected) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) return;

    const tip = dom.dyTooltip;
    tip.textContent = this.#storedTitle;
    tip.classList.remove("visible", "below");
    tip.setAttribute("aria-hidden", "true");
    tip.style.left = "0px";
    tip.style.top = "0px";
    const tipRect = tip.getBoundingClientRect();
    const margin = 8;
    const gap = 8;
    const center = rect.left + rect.width / 2;
    const left = Math.min(
      Math.max(center - tipRect.width / 2, margin),
      Math.max(margin, window.innerWidth - tipRect.width - margin),
    );
    const below = rect.top < tipRect.height + gap + margin;
    let top = below ? rect.bottom + gap : rect.top - tipRect.height - gap;
    top = Math.min(Math.max(top, margin), Math.max(margin, window.innerHeight - tipRect.height - margin));
    const arrowLeft = Math.min(Math.max(center - left, 10), Math.max(10, tipRect.width - 10));

    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    tip.style.setProperty("--tooltip-arrow-left", `${Math.round(arrowLeft)}px`);
    tip.classList.toggle("below", below);
    tip.classList.add("visible");
    tip.setAttribute("aria-hidden", "false");
  }

  // 暂时收起浮层但保留当前 target/title 移除状态：滚动/缩放后指针未离开时，
  // 不恢复 title，避免原生 tooltip 在自定义浮层消失后补弹。
  #hideTipOnly = () => {
    clearTimeout(this.#showTimer);
    this.#showTimer = 0;
    const tip = dom.dyTooltip;
    if (!tip) return;
    tip.classList.remove("visible", "below");
    tip.setAttribute("aria-hidden", "true");
    tip.textContent = "";
  };

  #hide = () => {
    const el = this.#current;
    this.#hideTipOnly();
    if (el && el.isConnected && !el.hasAttribute("title") && this.#storedTitle) {
      el.setAttribute("title", this.#storedTitle);
    }
    this.#current = null;
    this.#storedTitle = "";
  };
}

export const tooltip = new Tooltip();
