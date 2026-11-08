// ---------- RandomReview（回顾域：真实域 + 只持久化批次引用） ----------
import { config, dom, state, services, store } from '../core.js';
import { dialog } from './dialog.js';
import { appShell } from './app-shell.js';
import { SelectMenu } from './select-menu.js';

const SOURCE_DOMAINS = config.SOURCE_DOMAINS;
const CONFIG_KEY = "randomReviewConfig";
// 追加批次固定落「未分组」：追加不替换已有批次，未分组充当追加收件箱
const APPEND_GROUP_ID = "uncategorized";

class RandomReview {
  #config = { sourceDomain: "works", count: config.RANDOM_REVIEW_DEFAULT_COUNT };
  #startToken = 0;
  #sourceMenu = null;

  constructor() {
    // 恢复上次配置；回顾批次本身由 review 表持久化
    chrome.storage.local
      .get(CONFIG_KEY)
      .then((stored) => {
        const saved = stored?.[CONFIG_KEY];
        if (saved && SOURCE_DOMAINS.includes(saved.sourceDomain)) {
          this.#config = {
            sourceDomain: saved.sourceDomain,
            count: this.#clampCount(saved.count),
          };
        }
        this.syncReviewBar();
      })
      .catch(() => {});
    this.#bindSourceMenu();
    store.on("review", () => this.syncReviewBar());
    store.on("review-meta", () => this.syncReviewBar());
    store.on("domain", () => this.syncReviewBar());
  }

  // 来源下拉与搜索栏共用 SelectMenu：鼠标 / 键盘 / ARIA 同构，选中后只写回顾来源
  #bindSourceMenu() {
    if (!dom.reviewSourceScope) return;
    this.#sourceMenu = new SelectMenu(
      dom.reviewSourceScope,
      (opt) => this.#selectSource(opt.dataset.source),
      { optionAttr: "data-source" },
    );
  }

  #selectSource(domain) {
    if (!dom.reviewSourceScope || !SOURCE_DOMAINS.includes(domain)) return;
    this.#sourceMenu?.sync(domain, config.DOMAINS_META[domain].label);
  }

  #closeSourceMenu() {
    this.#sourceMenu?.close();
  }

  // 回顾分组行内联配置：来源下拉 + 数量输入
  syncReviewBar() {
    if (!dom.reviewSourceScope || !dom.reviewCountInput) return;
    if (state.domain !== config.REVIEW_DOMAIN) {
      this.#closeSourceMenu();
      return;
    }
    const source = state.reviewSourceDomain || this.#config.sourceDomain;
    if (SOURCE_DOMAINS.includes(source)) this.#selectSource(source);
    if (!dom.reviewCountInput.matches(":focus")) {
      dom.reviewCountInput.value = String(this.#config.count);
    }
  }

  // 从分组行控件读取当前用户输入；非法值回退到上次有效配置
  readTopbarConfig() {
    const active = dom.reviewSourceScope?.querySelector(".sb-scope-option.active");
    const sourceDomain =
      active && SOURCE_DOMAINS.includes(active.dataset.source)
        ? active.dataset.source
        : this.#config.sourceDomain || "works";
    const rawCount = Math.floor(Number(dom.reviewCountInput?.value));
    return {
      sourceDomain,
      count: this.#clampCount(Number.isFinite(rawCount) ? rawCount : this.#config.count),
    };
  }

  // 单一「随机回顾」入口：有当前批次时优先排除本批记录；排除后无新数据则允许整批重抽
  async randomize() {
    if (state.domain !== config.REVIEW_DOMAIN) return;
    const token = ++this.#startToken;
    const { sourceDomain, count } = this.readTopbarConfig();
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
      await this.#applyConfig({ sourceDomain, count });
      await appShell.reloadCurrentDomain();
    } catch (err) {
      console.warn("[DDM] random review failed:", err);
      if (token === this.#startToken) {
        dialog.showToast("随机抽取失败，请重试", "error");
      }
    }
  }

  // 追加批次：固定落「未分组」，只允许同来源域追加；跨来源域仅提示 toast，不改动已有批次。
  // 抽样排除回顾域已有记录；未分组为空时等价于在该组新建一批。
  async append() {
    if (state.domain !== config.REVIEW_DOMAIN) return;
    const token = ++this.#startToken;
    const { sourceDomain, count } = this.readTopbarConfig();
    const meta = config.DOMAINS_META[sourceDomain];
    const idKey = config.AUTHOR_RECORD_DOMAINS.includes(sourceDomain) ? "uid" : "awemeId";
    try {
      // 以回顾域全量引用做同域判断与去重（GET_REVIEW 不写 state，避免污染当前分组视图）
      const probe = await services.bgMsg({ type: "GET_REVIEW", groupId: "all" });
      if (token !== this.#startToken) return;
      if (!probe || probe.error) {
        dialog.showToast("读取回顾域批次失败，请重试", "error");
        return;
      }
      const existing = probe.reviewItems || [];
      if (existing.length > 0 && probe.sourceDomain && probe.sourceDomain !== sourceDomain) {
        const existingLabel = config.DOMAINS_META[probe.sourceDomain]?.label || probe.sourceDomain;
        dialog.showToast(`回顾域已有「${existingLabel}」批次，不能追加「${meta.label}」数据`, "info");
        return;
      }
      const excludeIds = existing.map((item) => item[idKey]).filter(Boolean);
      const res = await services.pickRandomRecords({ domain: sourceDomain, count, excludeIds });
      if (token !== this.#startToken) return;
      if (!res.items || res.items.length === 0) {
        dialog.showToast(`回顾域已没有更多可追加的${meta.label}数据`, "info");
        return;
      }
      const saved = await services.saveReviewBatch({
        sourceDomain,
        sourceIds: res.items.map((item) => item[idKey]).filter(Boolean),
        groupId: APPEND_GROUP_ID,
        append: true,
      });
      if (!saved || saved.ok !== true) {
        if (saved?.error === "SOURCE_DOMAIN_MISMATCH") {
          const existingLabel = config.DOMAINS_META[saved.sourceDomain]?.label || saved.sourceDomain;
          dialog.showToast(`回顾域已有「${existingLabel}」批次，不能追加「${meta.label}」数据`, "info");
          return;
        }
        dialog.showToast("回顾批次追加失败: " + (saved?.error || "未知错误"), "error");
        return;
      }
      if (saved.count <= 0) {
        dialog.showToast(
          saved.full
            ? `回顾域已达 ${config.RANDOM_REVIEW_MAX_COUNT} 条上限，无法追加`
            : "本次抽样结果均已在回顾域中，请重试",
          "info",
        );
        return;
      }
      await this.#applyConfig({ sourceDomain, count });
      dialog.showToast(
        `已追加 ${saved.count} 条到「未分组」${
          saved.full ? `（达到 ${config.RANDOM_REVIEW_MAX_COUNT} 条上限，其余未加入）` : ""
        }`,
        "success",
      );
      await appShell.reloadCurrentDomain();
    } catch (err) {
      console.warn("[DDM] review append failed:", err);
      if (token === this.#startToken) dialog.showToast("追加抽取失败，请重试", "error");
    }
  }

  #clampCount(value) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return config.RANDOM_REVIEW_DEFAULT_COUNT;
    return Math.max(1, Math.min(config.RANDOM_REVIEW_MAX_COUNT, n));
  }

  async #applyConfig({ sourceDomain, count }) {
    this.#config = { sourceDomain, count: this.#clampCount(count) };
    await chrome.storage.local.set({ [CONFIG_KEY]: this.#config }).catch(() => {});
    this.syncReviewBar();
  }
}

export const randomReview = new RandomReview();
