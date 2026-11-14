// ---------- Settings ----------
import { dom, state, runtimeConfig, services, utils } from '../core.js';
import { dialog } from './dialog.js';
import { taskDock } from './task-dock.js';

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
  "scanChunkSize",
];

// 缓存条目单一来源：面板渲染（#renderCacheList）与刷新/复制分发（#bind）共用一张表。
// cookie 的 hasCopyAll 依赖 rawCookie 存在性（其余恒可复制），time/copy 取数路径各异
const CACHE_ITEMS = [
  {
    key: "cookie",
    label: "Cookie",
    refreshType: "COOKIE",
    hasCopyAll: (ci) => !!ci?.rawCookie,
    time: (ci, times) => ci?.time || times.cookie,
    copy: async () => {
      const ci = await services.bgMsg({ type: "GET_COOKIE_INFO" });
      return ci?.rawCookie || "";
    },
  },
  {
    key: "mstoken",
    label: "msToken",
    refreshType: "MSTOKEN",
    hasCopyAll: () => true,
    time: (_ci, times) => times.msToken,
    copy: async () => (await chrome.storage.local.get("savedMsToken")).savedMsToken || "",
  },
  {
    key: "webid",
    label: "webId",
    refreshType: "WEBID",
    hasCopyAll: () => true,
    time: (_ci, times) => times.webId,
    copy: async () => (await chrome.storage.local.get("savedWebId")).savedWebId || "",
  },
  {
    key: "browser_features",
    label: "浏览器特征",
    refreshType: "BROWSER_FEATURES",
    hasCopyAll: () => true,
    time: (_ci, times) => times.browserFeatures,
    copy: async () => {
      const res = await services.bgMsg({ type: "GET_BROWSER_FEATURES" });
      return res?.features ? JSON.stringify(res.features, null, 2) : "";
    },
  },
];

// 设置面板 7 行延迟 min/max 同构：模板只留容器、此处按表生成（data-key 命名与
// CONFIG_FIELDS 一致，渲染/校验/保存零改动）
const DELAY_ROWS = [
  ["同步作品", "syncWorks"],
  ["同步关注", "syncFollowings"],
  ["扫描点赞", "syncFavorites"],
  ["扫描收藏", "syncCollection"],
  ["取消点赞", "cancelFavorites"],
  ["取消收藏", "cancelCollection"],
  ["作者入库", "importWorks"],
];

function buildSettingsDelayRows() {
  const root = document.getElementById("settingsDelayRows");
  if (!root || root.childElementCount > 0) return;
  root.innerHTML = DELAY_ROWS.map(
    ([label, kind]) =>
      `<div class="kv-row"><label class="bf-label">${label} 延迟 min/max (ms)</label>` +
      `<input class="bf-input config-input" data-key="${kind}DelayMin" type="number" style="width:80px" />` +
      `<span style="margin:0 4px;color:var(--dy-text-muted)">~</span>` +
      `<input class="bf-input config-input" data-key="${kind}DelayMax" type="number" style="width:80px" /></div>`,
  ).join("");
}

// ---------- Settings ----------
class Settings {
  #dialogBody = null;
  #pendingIndependent = null;

  constructor() {
    // 任务进行中：设置入口与设置面板整体不可交互（不再单独禁用模式开关）
    taskDock.onRunningChange((busy) => this.setTaskLocked(busy));
  }

  #$(id) {
    return this.#dialogBody.querySelector("#" + id);
  }

  setTaskLocked(busy) {
    if (dom.btnSettings) {
      dom.btnSettings.disabled = busy;
      dom.btnSettings.title = busy ? "任务运行中不可打开设置" : "";
    }
    const panel = this.#dialogBody?.querySelector(".settings-panel");
    if (panel) panel.inert = busy;
  }

  async openPanel() {
    if (taskDock.isAnyRunning()) {
      dialog.showToast("任务运行中不可打开设置", "info");
      return;
    }
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
    const [ci, { independentMode }, ct] = await Promise.all([
      services.bgMsg({ type: "GET_COOKIE_INFO" }),
      chrome.storage.local.get("independentMode"),
      services.bgMsg({ type: "GET_CACHE_TIMES" }).catch(() => ({ ok: false, times: {} })),
    ]);
    const modeSwitch = this.#$("settingsModeSwitch");
    modeSwitch.checked = Boolean(this.#pendingIndependent ?? independentMode);
    // secUid
    const { secUid } = await chrome.storage.local.get("secUid");
    this.#$("settingsSecUid").value = secUid || "";
    // 缓存状态
    this.#renderCacheList(ci, ct);
    // 运行参数
    this.#renderConfigSection();
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
    list.innerHTML = CACHE_ITEMS.map((item) => {
      const copyBtn = item.hasCopyAll(ci)
        ? `<button class="cookie-copy-all-btn" data-copy-type="${item.key}">复制</button>`
        : "";
      return `<div class="cache-item">
        <span class="cache-label">${item.label}</span>
        <span class="cache-time">${utils.formatCacheTime(item.time(ci, times)) || "未捕获"}</span>
        ${copyBtn}
        <button class="cache-refresh-btn" data-refresh="${item.key}">刷新</button>
      </div>`;
    }).join("");
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
    // 缓存刷新/复制按钮（分发按 CACHE_ITEMS 单表）
    const cacheList = this.#$("settingsCacheList");
    if (cacheList) {
      const byKey = new Map(CACHE_ITEMS.map((item) => [item.key, item]));
      cacheList.addEventListener("click", async (e) => {
        const copyBtn = e.target.closest("[data-copy-type]");
        if (copyBtn) {
          e.stopPropagation();
          const copy = byKey.get(copyBtn.dataset.copyType)?.copy;
          if (copy) {
            const text = await copy();
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
        const item = byKey.get(btn.dataset.refresh);
        if (!item) return;
        btn.classList.add("loading");
        btn.textContent = "刷新中…";
        try {
          const res = await services.bgMsg({ type: "REFRESH_" + item.refreshType });
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

  // X 关闭时校验并持久化运行参数与 secUid；返回 false 表示校验未通过、保持弹窗打开
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
    // 扫描分块大小：整数 + 上下界（过小则事务频繁，过大则内存峰值与取消残差变差）
    if (!Number.isInteger(values.scanChunkSize) || values.scanChunkSize < 50 || values.scanChunkSize > 2000) {
      dialog.showToast("扫描分块大小需为 50~2000 的整数", "error");
      return false;
    }
    try {
      await runtimeConfig.save(values);
      const secUidInput = this.#dialogBody.querySelector("#settingsSecUid");
      await chrome.storage.local.set({ secUid: secUidInput?.value.trim() || "" });
    } catch {
      dialog.showToast("保存失败", "error");
    }
    // 独立模式：与运行参数同走关闭通道；与存储值有变化才下发 SET_MODE（写存储+background 运行态+a-bogus 初始化）
    const modeOn = this.#pendingIndependent ?? Boolean(section.querySelector("#settingsModeSwitch")?.checked);
    const { independentMode: savedOn } = await chrome.storage.local.get("independentMode");
    if (modeOn !== (savedOn === true)) {
      try {
        const res = await services.bgMsg({ type: "SET_MODE", enabled: modeOn });
        if (!res || res.ok !== true) {
          dialog.showToast(res?.error === "BUSY" ? "任务运行中，模式未切换" : "独立模式切换失败", "error");
          return false;
        }
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

// ---------- 模板占位填充 ----------
// 模块载入即填充（options.html 脚本在 DOM 解析后执行）；openPanel 时惰性 clone 模板，
// 生成时机只需早于首次打开设置面板
buildSettingsDelayRows();
