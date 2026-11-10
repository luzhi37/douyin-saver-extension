// ---------- RandomReview（回顾域：真实域 + 只持久化批次引用） ----------
import { config, state, services } from '../core.js';
import { dialog } from './dialog.js';
import { appShell } from './app-shell.js';

const SOURCE_DOMAINS = config.SOURCE_DOMAINS;
const CONFIG_KEY = "randomReviewConfig";

class RandomReview {
  #config = { sourceDomain: "works", count: config.RANDOM_REVIEW_DEFAULT_COUNT };
  #ready;
  #startToken = 0;

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

  // 配置读取/写入：设置弹窗渲染与关闭保存共用；等待首次存储恢复完成，避免竞态
  async getConfig() {
    await this.#ready;
    return { ...this.#config };
  }

  async saveConfig({ sourceDomain, count } = {}) {
    await this.#ready;
    const next = {
      sourceDomain: SOURCE_DOMAINS.includes(sourceDomain) ? sourceDomain : this.#config.sourceDomain,
      count: this.#clampCount(count),
    };
    this.#config = next;
    await chrome.storage.local.set({ [CONFIG_KEY]: next }).catch(() => {});
    return { ...next };
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
