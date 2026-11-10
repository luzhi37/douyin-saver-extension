// ---------- Settings ----------
import { config, dom, state, runtimeConfig, services, utils } from '../core.js';
import { dialog } from './dialog.js';
import { SelectMenu } from './select-menu.js';
import { randomReview } from './random-review.js';

// 运行参数键（面板渲染与关闭保存共用单一来源，与 runtimeConfig.DEFAULTS 键一致）
const CONFIG_FIELDS = [
  "timeoutRequest", "timeoutSecurityStatus",
  "syncWorksDelayMin", "syncWorksDelayMax",
  "syncFollowingsDelayMin", "syncFollowingsDelayMax",
  "syncFavoritesDelayMin", "syncFavoritesDelayMax",
  "syncCollectionDelayMin", "syncCollectionDelayMax",
  "cancelFavoritesDelayMin", "cancelFavoritesDelayMax",
  "cancelCollectionDelayMin", "cancelCollectionDelayMax",
  "importWorksDelayMin", "importWorksDelayMax",
  "syncBatchSize", "syncBatchPauseMin", "syncBatchPauseMax",
  "syncKeepaliveInterval", "syncRetryMax",
];

// ---------- Settings ----------
class Settings {
  #dialogBody = null;
  #pendingIndependent = null;
  #reviewMenu = null;
  #reviewSource = "works";

  #$(id) {
    return this.#dialogBody.querySelector("#" + id);
  }

  async openPanel() {
    // 上一轮设置弹窗的回顾下拉实例（模板每次打开重建 DOM）：先移除其 document 监听
    this.#reviewMenu?.destroy();
    this.#reviewMenu = null;
    const tmpl = document.getElementById("settingsDialogTemplate");
    const body = tmpl.content.cloneNode(true);
    dialog.showDialog("设置", body);
    this.#dialogBody = dom.dialogBody;
    // 开关的未保存选择：#refresh 渲染时 pending 优先于存储值，落库统一走 saveBeforeClose
    this.#pendingIndependent = null;
    this.#bind();
    state.preventDialogClose = true;
    try {
      await this.#refresh();
    } finally {
      state.preventDialogClose = false;
    }
  }

  async #refresh() {
    const [ci, { independentMode }, ct, reviewConfig] = await Promise.all([
      services.bgMsg({ type: "GET_COOKIE_INFO" }),
      chrome.storage.local.get("independentMode"),
      services.bgMsg({ type: "GET_CACHE_TIMES" }).catch(() => ({ ok: false, times: {} })),
      randomReview.getConfig(),
    ]);
    this.#$("settingsModeSwitch").checked = Boolean(this.#pendingIndependent ?? independentMode);
    // secUid
    const { secUid } = await chrome.storage.local.get("secUid");
    this.#$("settingsSecUid").value = secUid || "";
    // 缓存状态
    this.#renderCacheList(ci, ct);
    // 回顾配置（来源下拉 + 抽取数量）
    this.#renderReviewConfig(reviewConfig);
    // 运行参数
    this.#renderConfigSection();
  }

  // 回顾配置：首次渲染创建 SelectMenu；缓存刷新重入时只同步选中值，不重复绑定监听
  #renderReviewConfig({ sourceDomain, count }) {
    this.#reviewSource = sourceDomain;
    const sourceEl = this.#$("settingsReviewSource");
    if (sourceEl && !this.#reviewMenu) {
      this.#reviewMenu = new SelectMenu(
        sourceEl,
        (opt) => {
          this.#reviewSource = opt.dataset.source;
        },
        { optionAttr: "data-source" },
      );
    }
    this.#reviewMenu?.sync(sourceDomain, config.DOMAINS_META[sourceDomain].label);
    const countInput = this.#$("settingsReviewCount");
    if (countInput) countInput.value = String(count);
  }

  #renderConfigSection() {
    const cfg = runtimeConfig._cache || runtimeConfig.DEFAULTS;
    const section = this.#dialogBody.querySelector("#settingsConfigSection");
    for (const key of CONFIG_FIELDS) {
      const input = section.querySelector(`.config-input[data-key="${key}"]`);
      input.value = cfg[key] ?? "";
    }
  }

  #renderCacheList(ci, ct) {
    const list = this.#dialogBody.querySelector("#settingsCacheList");
    const times = ct?.times || {};
    const hasRawCookie = !!(ci?.rawCookie);
    const items = [
      {
        key: "cookie",
        label: "Cookie",
        time: ci?.time || times.cookie,
        hasCopyAll: hasRawCookie,
      },
      {
        key: "mstoken",
        label: "msToken",
        time: times.msToken,
        hasCopyAll: true,
      },
      {
        key: "webid",
        label: "webId",
        time: times.webId,
        hasCopyAll: true,
      },
      {
        key: "browser_features",
        label: "浏览器特征",
        time: times.browserFeatures,
        hasCopyAll: true,
      },
    ];
    list.innerHTML = items
      .map(
        (item) => {
          const copyBtn = item.hasCopyAll
            ? `<button class="cookie-copy-all-btn" data-copy-type="${item.key}">复制</button>`
            : "";
          return `<div class="cache-item">
        <span class="cache-label">${item.label}</span>
        <span class="cache-time">${utils.formatCacheTime(item.time) || "未捕获"}</span>
        ${copyBtn}
        <button class="cache-refresh-btn" data-refresh="${item.key}">刷新</button>
      </div>`;
        },
      )
      .join("");
  }

  // min/max 成对即时校验：两端同亮同灭，避免只标一端造成误读
  #validateDelayPair(section, key) {
    // section 由调用方 cfgSection 监听保证非空；key 来自模板静态 data-key
    if (!(key.endsWith("Min") || key.endsWith("Max"))) return;
    const base = key.slice(0, -3);
    const minInput = section.querySelector(`.config-input[data-key="${base}Min"]`);
    const maxInput = section.querySelector(`.config-input[data-key="${base}Max"]`);
    const min = Number(minInput.value);
    const max = Number(maxInput.value);
    const filled = minInput.value.trim() !== "" && maxInput.value.trim() !== "";
    const invalid = filled && Number.isFinite(min) && Number.isFinite(max) && min > max;
    minInput.classList.toggle("input-invalid", invalid);
    maxInput.classList.toggle("input-invalid", invalid);
  }

  #bind() {
    const cfgSection = this.#$("settingsConfigSection");
    // min/max 即时校验：输入期红框提示，保存拦截仍由 saveBeforeClose 兜底
    cfgSection.addEventListener("input", (e) => {
      const input = e.target.closest?.(".config-input");
      if (!input) return;
      this.#validateDelayPair(cfgSection, input.dataset.key);
    });
    // 开关仅切换视觉态；持久化与副作用统一走「关闭时校验并持久化」（saveBeforeClose）
    const modeSwitch = this.#$("settingsModeSwitch");
    modeSwitch.addEventListener("change", () => {
      this.#pendingIndependent = modeSwitch.checked;
    });
    // 缓存刷新按钮
    const cacheList = this.#$("settingsCacheList");
    if (cacheList) {
      const TYPE_MAP = { cookie: "COOKIE", mstoken: "MSTOKEN", webid: "WEBID", browser_features: "BROWSER_FEATURES" };
      const COPY_MAP = {
        cookie: async () => {
          const ci = await services.bgMsg({ type: "GET_COOKIE_INFO" });
          return ci?.rawCookie || "";
        },
        mstoken: async () => {
          const { savedMsToken } = await chrome.storage.local.get("savedMsToken");
          return savedMsToken || "";
        },
        webid: async () => {
          const { savedWebId } = await chrome.storage.local.get("savedWebId");
          return savedWebId || "";
        },
        browser_features: async () => {
          const res = await services.bgMsg({ type: "GET_BROWSER_FEATURES" });
          return res?.features ? JSON.stringify(res.features, null, 2) : "";
        },
      };
      cacheList.addEventListener("click", async (e) => {
        const copyBtn = e.target.closest("[data-copy-type]");
        if (copyBtn) {
          e.stopPropagation();
          const type = copyBtn.dataset.copyType;
          const fn = COPY_MAP[type];
          if (fn) {
            const text = await fn();
            if (text) {
              navigator.clipboard.writeText(text).then(
                () => dialog.showToast("已复制", "success")
              );
            }
          }
          return;
        }
        const btn = e.target.closest(".cache-refresh-btn");
        if (!btn || btn.classList.contains("loading")) return;
        const type = TYPE_MAP[btn.dataset.refresh];
        if (!type) return;
        btn.classList.add("loading");
        btn.textContent = "刷新中…";
        try {
          const res = await services.bgMsg({ type: "REFRESH_" + type });
          if (res?.ok) {
            await this.#refresh();
          } else {
            dialog.showToast(res?.hint || res?.error || "刷新失败", "error");
          }
        } catch {
          dialog.showToast("刷新失败", "error");
        } finally {
          btn.classList.remove("loading");
          btn.textContent = "刷新";
        }
      });
    }
  }

  // X 关闭时校验并持久化运行参数、回顾配置与 secUid；返回 false 表示校验未通过、保持弹窗打开
  async saveBeforeClose() {
    if (!this.#dialogBody) return true;
    const section = this.#dialogBody.querySelector("#settingsConfigSection");
    // 设置面板未打开（当前弹窗是其它面板）时无需处理
    if (!section) return true;
    const DELAY_PAIRS = [
      ["syncWorksDelayMin", "syncWorksDelayMax", "同步作品"],
      ["syncFollowingsDelayMin", "syncFollowingsDelayMax", "同步关注"],
      ["syncFavoritesDelayMin", "syncFavoritesDelayMax", "扫描点赞"],
      ["syncCollectionDelayMin", "syncCollectionDelayMax", "扫描收藏"],
      ["cancelFavoritesDelayMin", "cancelFavoritesDelayMax", "取消点赞"],
      ["cancelCollectionDelayMin", "cancelCollectionDelayMax", "取消收藏"],
      ["importWorksDelayMin", "importWorksDelayMax", "作者入库"],
    ];
    const values = {};
    for (const key of CONFIG_FIELDS) {
      const input = section.querySelector(`.config-input[data-key="${key}"]`);
      const raw = input.value.trim();
      const num = Number(raw);
      if (!raw || !Number.isFinite(num) || num <= 0) {
        dialog.showToast(`"${key}" 请输入有效的正数`, "error");
        return false;
      }
      values[key] = num;
    }
    for (const [minKey, maxKey, label] of DELAY_PAIRS) {
      if (values[minKey] > values[maxKey]) {
        dialog.showToast(`${label}延迟最小值不能大于最大值`, "error");
        return false;
      }
    }
    if (values.syncBatchPauseMin > values.syncBatchPauseMax) {
      dialog.showToast("批次暂停最小值不能大于最大值", "error");
      return false;
    }
    // 回顾配置：数量必须是 1–500 的整数；来源由下拉选择保证合法
    const reviewCountInput = this.#dialogBody.querySelector("#settingsReviewCount");
    const rawReviewCount = reviewCountInput?.value.trim() ?? "";
    const reviewCount = Number(rawReviewCount);
    if (
      !rawReviewCount ||
      !Number.isInteger(reviewCount) ||
      reviewCount < 1 ||
      reviewCount > config.RANDOM_REVIEW_MAX_COUNT
    ) {
      dialog.showToast(`回顾抽取数量需为 1–${config.RANDOM_REVIEW_MAX_COUNT} 的整数`, "error");
      return false;
    }
    try {
      await runtimeConfig.save(values);
      const secUidInput = this.#dialogBody.querySelector("#settingsSecUid");
      await chrome.storage.local.set({ secUid: secUidInput?.value.trim() || "" });
      await randomReview.saveConfig({ sourceDomain: this.#reviewSource, count: reviewCount });
    } catch {
      dialog.showToast("保存失败", "error");
    }
    // 独立模式：与运行参数同走关闭通道；与存储值有变化才下发 SET_MODE（写存储+background 运行态+a-bogus 初始化）
    const modeOn = this.#pendingIndependent ?? Boolean(section.querySelector("#settingsModeSwitch")?.checked);
    const { independentMode: savedOn } = await chrome.storage.local.get("independentMode");
    if (modeOn !== (savedOn === true)) {
      try {
        await services.bgMsg({ type: "SET_MODE", enabled: modeOn });
        this.#pendingIndependent = null;
      } catch {
        dialog.showToast("独立模式切换失败", "error");
        return false;
      }
    }
    return true;
  }
}

export const settings = new Settings();
