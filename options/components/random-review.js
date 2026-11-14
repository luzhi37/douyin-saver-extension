// ---------- RandomReview（回顾域：真实域 + 只持久化批次引用） ----------
import { config, dom, state, services } from '../core.js';
import { dialog } from './dialog.js';
import { appShell } from './app-shell.js';
import { SelectMenu } from './select-menu.js';

const SOURCE_DOMAINS = config.SOURCE_DOMAINS;
const CONFIG_KEY = "randomReviewConfig";

class RandomReview {
  #config = { sourceDomain: "works", count: config.RANDOM_REVIEW_DEFAULT_COUNT };
  #ready;
  #startToken = 0;
  // 顶栏回顾控件（回顾域下取代分组按钮组）：来源下拉 + 抽取数量，变更即持久化
  #sourceMenu = null;

  constructor() {
    // 恢复上次配置；回顾批次本身由 review 表持久化
    this.#ready = chrome.storage.local
      .get(CONFIG_KEY)
      .then((stored) => {
        const saved = stored?.[CONFIG_KEY];
        if (saved && SOURCE_DOMAINS.includes(saved.sourceDomain)) {
          this.#config = {
            sourceDomain: saved.sourceDomain,
            count: this.#clampCount(saved.count),
          };
        }
      })
      .catch(() => {});
  }

  // 顶栏控件初始化（main.js 组合根调用）：下拉键盘/ARIA 统一走 SelectMenu；
  // 存储恢复完成后回填当前值
  initTopBarControls() {
    if (this.#sourceMenu || !dom.sbReviewSource) return;
    this.#sourceMenu = new SelectMenu(
      dom.sbReviewSource,
      (opt) => this.#commit({ sourceDomain: opt.dataset.source }),
      { optionAttr: "data-source" },
    );
    dom.sbReviewCount?.addEventListener("change", () => this.#commitCount());
    // Enter 即提交（blur 触发 change）；Esc 由 main.js 单点收口负责失焦
    dom.sbReviewCount?.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      dom.sbReviewCount.blur();
    });
    this.#ready.then(() => this.syncControls());
  }

  // 按当前配置回填顶栏控件（来源下拉文案/选中态 + 数量输入）
  syncControls() {
    const { sourceDomain, count } = this.#config;
    this.#sourceMenu?.sync(sourceDomain, config.DOMAINS_META[sourceDomain]?.label || "");
    if (dom.sbReviewCount) dom.sbReviewCount.value = String(count);
  }

  async #commit(patch) {
    await this.#ready;
    const next = {
      sourceDomain: SOURCE_DOMAINS.includes(patch.sourceDomain) ? patch.sourceDomain : this.#config.sourceDomain,
      count: this.#clampCount(patch.count ?? this.#config.count),
    };
    // 内存态先同步更新再异步落库：blur（数量提交）与紧随其后的「同步」点击之间，
    // randomize 读到的必须是本次新配置
    this.#config = next;
    this.syncControls();
    await chrome.storage.local.set({ [CONFIG_KEY]: next }).catch(() => {});
  }

  // 数量显式提交（change）：非法值 toast 并回退到上次有效值，合法值钳制后落库
  async #commitCount() {
    await this.#ready;
    const raw = dom.sbReviewCount?.value.trim() ?? "";
    const n = Number(raw);
    if (!raw || !Number.isInteger(n) || n < 1 || n > config.RANDOM_REVIEW_MAX_COUNT) {
      dialog.showToast(`抽取数量需为 1–${config.RANDOM_REVIEW_MAX_COUNT} 的整数`, "error");
      if (dom.sbReviewCount) dom.sbReviewCount.value = String(this.#config.count);
      return;
    }
    await this.#commit({ count: n });
  }

  // 配置读取：等待首次存储恢复完成，避免竞态
  async getConfig() {
    await this.#ready;
    return { ...this.#config };
  }

  // 单一「随机回顾」入口：有当前批次时优先排除本批记录；排除后无新数据则允许整批重抽
  async randomize() {
    if (state.domain !== config.REVIEW_DOMAIN) return;
    const token = ++this.#startToken;
    const { sourceDomain, count } = await this.getConfig();
    // 主键必须按“本次来源域”取，不能按当前回顾批次类型取：首次从空回顾域切到关注/候选
    // 时 state.reviewKind 仍是 works，会把作者记录用 awemeId 映射成空数组，导致批次写空。
    const idKey = config.AUTHOR_RECORD_DOMAINS.includes(sourceDomain) ? "uid" : "awemeId";
    const currentIds =
      sourceDomain === state.reviewSourceDomain
        ? state.review.map((item) => item[idKey]).filter(Boolean)
        : [];
    try {
      let res = await services.pickRandomRecords({
        domain: sourceDomain,
        count,
        excludeIds: currentIds,
      });
      if (token !== this.#startToken) return;
      if ((!res.items || res.items.length === 0) && currentIds.length > 0) {
        // 当前批次已抽完：允许重新开始（可能与上一批重复）
        res = await services.pickRandomRecords({ domain: sourceDomain, count, excludeIds: [] });
        if (token !== this.#startToken) return;
      }
      if (!res.items || res.items.length === 0) {
        dialog.showToast(`「${config.DOMAINS_META[sourceDomain].label}」域暂无可回顾的数据`, "info");
        return;
      }
      const saved = await services.saveReviewBatch({
        sourceDomain,
        sourceIds: res.items.map((item) => item[idKey]).filter(Boolean),
        groupId: state.currentGroupId,
      });
      if (!saved || saved.ok !== true) {
        dialog.showToast("回顾批次保存失败: " + (saved?.error || "未知错误"), "error");
        return;
      }
      await appShell.reloadCurrentDomain();
    } catch (err) {
      console.warn("[DDM] random review failed:", err);
      if (token === this.#startToken) {
        dialog.showToast("随机抽取失败，请重试", "error");
      }
    }
  }

  #clampCount(value) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return config.RANDOM_REVIEW_DEFAULT_COUNT;
    return Math.max(1, Math.min(config.RANDOM_REVIEW_MAX_COUNT, n));
  }
}

export const randomReview = new RandomReview();
