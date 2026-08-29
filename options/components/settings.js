// ---------- Settings ----------
import { dom, state, runtimeConfig, services, utils } from '../core.js';
import { dialog } from './dialog.js';

// ---------- Settings ----------
export class Settings {
  async openPanel() {
    const tmpl = document.getElementById("settingsDialogTemplate");
    const body = tmpl.content.cloneNode(true);
    dialog.showDialog("设置", body);
    this._dialogBody = dom.dialogBody;
    // 两个开关的未保存选择：_refresh 渲染时 pending 优先于存储值，落库统一走 saveBeforeClose
    this._pendingIndependent = null;
    this._pendingCalibrate = null;
    this._bind();
    this._bindStatus();
    state.preventDialogClose = true;
    try {
      await this._refresh();
    } finally {
      state.preventDialogClose = false;
    }
  }

  _statusTimeStr(updatedAt) {
    return updatedAt ? new Date(updatedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "";
  }

  _toggleTruncated(el, hint) {
    if (!el) return;
    const expanded = el.classList.toggle("sec-expanded");
    el.classList.toggle("sec-truncate", !expanded);
    if (hint) hint.textContent = expanded ? "[收起]" : "[展开]";
  }

  toggleKeyExpand(root) {
    const text = root.querySelector("#secKeyValueText");
    const hint = root.querySelector("#secKeyValue .sec-expand-hint");
    this._toggleTruncated(text, hint);
  }

  toggleSigExpand(root, rowId) {
    const row = root.querySelector("#" + rowId);
    if (!row) return;
    const text = row.querySelector(".sec-truncate, .sec-expanded");
    const hint = row.querySelector(".sec-expand-hint");
    if (!text || !hint || hint.classList.contains("hidden")) return;
    this._toggleTruncated(text, hint);
  }

  _renderStatusKey(root, key, updatedAt) {
    const statusEl = root.querySelector("#secKeyStatus");
    const valueEl = root.querySelector("#secKeyValueText");
    const expandHint = root.querySelector("#secKeyValue .sec-expand-hint");
    const hintEl = root.querySelector("#secKeyHint");
    const copyBtn = root.querySelector("#secKeyValue .sec-copy-btn");
    if (key) {
      const t = this._statusTimeStr(updatedAt);
      statusEl.textContent = t ? `✅ 可用 · ${t}` : "✅ 可用";
      statusEl.className = "sec-value sec-ok";
      valueEl.textContent = key;
      valueEl.classList.add("sec-truncate");
      valueEl.classList.remove("sec-expanded");
      if (expandHint) {
        expandHint.classList.remove("hidden");
        expandHint.textContent = "[展开]";
      }
      if (copyBtn) copyBtn.classList.remove("hidden");
      hintEl.classList.add("hidden");
    } else {
      statusEl.textContent = "❌ 不可用";
      statusEl.className = "sec-value sec-err";
      valueEl.textContent = "—";
      valueEl.classList.add("sec-truncate");
      valueEl.classList.remove("sec-expanded");
      if (expandHint) expandHint.classList.add("hidden");
      if (copyBtn) copyBtn.classList.add("hidden");
      hintEl.classList.remove("hidden");
      hintEl.textContent = "请确保抖音页面已打开且您已登录 → 刷新抖音页面（按 F5） → 等待页面加载完成（约 3-5 秒） → 返回此处点击刷新按钮";
    }
  }

  _renderStatusSig(root, sig, rowId, valueId, guidance) {
    const valueEl = root.querySelector("#" + valueId);
    const statusEl = root.querySelector("#" + valueId.replace(/Value$/, "Status"));
    const expandHint = root.querySelector("#" + rowId + " .sec-expand-hint");
    const hintEl = root.querySelector("#" + valueId.replace(/Value$/, "Hint"));
    const copyBtn = root.querySelector("#" + rowId + " .sec-copy-btn");
    const v = sig?.value || "";
    const t = sig?.updatedAt || 0;
    if (v) {
      const ts = this._statusTimeStr(t);
      statusEl.textContent = ts ? `✅ 已捕获 · ${ts}` : "✅ 已捕获";
      statusEl.className = "sec-value sec-ok";
      valueEl.textContent = v;
      valueEl.className = "sec-value sec-truncate";
      valueEl.classList.remove("sec-expanded");
      if (expandHint) {
        expandHint.classList.remove("hidden");
        expandHint.textContent = "[展开]";
      }
      if (copyBtn) copyBtn.classList.remove("hidden");
      hintEl.classList.add("hidden");
    } else {
      statusEl.textContent = "❌ 未捕获";
      statusEl.className = "sec-value sec-err";
      valueEl.textContent = "—";
      valueEl.className = "sec-value sec-err";
      valueEl.classList.remove("sec-expanded");
      if (expandHint) expandHint.classList.add("hidden");
      if (copyBtn) copyBtn.classList.add("hidden");
      hintEl.classList.remove("hidden");
      hintEl.textContent = guidance;
    }
  }

  _renderStatusHooks(root, hooks) {
    const fetchEl = root.querySelector("#secHookFetch");
    const xhrEl = root.querySelector("#secHookXhr");
    fetchEl.textContent = hooks.fetch ? "✅ 运行中" : "❌ 未运行";
    fetchEl.className = "sec-value " + (hooks.fetch ? "sec-ok" : "sec-err");
    xhrEl.textContent = hooks.xhr ? "✅ 运行中" : "❌ 未运行";
    xhrEl.className = "sec-value " + (hooks.xhr ? "sec-ok" : "sec-err");
  }

  async _refresh() {
    const [ci, bf, { independentMode }, ct] = await Promise.all([
      services.bgMsg({ type: "GET_COOKIE_INFO" }),
      services.bgMsg({ type: "GET_BROWSER_FEATURES" }),
      chrome.storage.local.get("independentMode"),
      services.bgMsg({ type: "GET_CACHE_TIMES" }).catch(() => ({ ok: false, times: {} })),
    ]);
    const secRes = await services.bgMsg({ type: "GET_SECURITY_STATUS" }).catch((err) => ({ ok: false, error: String(err && err.message || err) }));
    const $ = (id) => this._dialogBody.querySelector("#" + id);
    const cookieList = $("settingsCookieList");
    cookieList.innerHTML = "";
    const pairs = ci?.pairs || [];
    if (pairs.length > 0) {
      const table = document.createElement("table");
      table.className = "cookie-table";
      const colgroup = document.createElement("colgroup");
      const colKey = document.createElement("col");
      colKey.className = "cookie-key-col";
      const colVal = document.createElement("col");
      colgroup.appendChild(colKey);
      colgroup.appendChild(colVal);
      table.appendChild(colgroup);
      const tbody = document.createElement("tbody");
      for (const p of pairs) {
        const tr = document.createElement("tr");
        const tdKey = document.createElement("td");
        tdKey.className = "cookie-key";
        tdKey.textContent = p.key;
        const tdVal = document.createElement("td");
        const code = document.createElement("code");
        code.className = "cookie-val";
        code.textContent = p.value || "";
        tdVal.appendChild(code);
        tr.appendChild(tdKey);
        tr.appendChild(tdVal);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      cookieList.appendChild(table);
    } else {
      const hint = document.createElement("p");
      hint.className = "settings-hint";
      hint.textContent = "未捕获到 Cookie，请打开抖音页面";
      cookieList.appendChild(hint);
    }
    const modeSwitch = $("settingsModeSwitch");
    if (modeSwitch) {
      this.#applySwitchUI(modeSwitch, this._pendingIndependent ?? independentMode);
    }
    $("settingsModeHint").textContent = "";
    const features = bf?.features;
    const list = $("settingsBFList");
    list.innerHTML = "";
    if (features) {
      const entries = Object.entries(features).filter(([k]) => k !== "securityKey");
      if (entries.length > 0) {
        const table = document.createElement("table");
        table.className = "cookie-table";
        const colgroup = document.createElement("colgroup");
        const colKey = document.createElement("col");
        colKey.className = "cookie-key-col";
        const colVal = document.createElement("col");
        colgroup.appendChild(colKey);
        colgroup.appendChild(colVal);
        table.appendChild(colgroup);
        const tbody = document.createElement("tbody");
        for (const [k, v] of entries) {
          const tr = document.createElement("tr");
          const tdKey = document.createElement("td");
          tdKey.className = "cookie-key";
          tdKey.textContent = k;
          const tdVal = document.createElement("td");
          const code = document.createElement("code");
          code.className = "cookie-val";
          code.textContent = String(v);
          tdVal.appendChild(code);
          tr.appendChild(tdKey);
          tr.appendChild(tdVal);
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        list.appendChild(table);
      } else {
        list.innerHTML = '<span class="settings-hint">未捕获，将使用默认值。打开抖音页面后可自动捕获。</span>';
      }
    } else {
      list.innerHTML = '<span class="settings-hint">未捕获，将使用默认值。打开抖音页面后可自动捕获。</span>';
    }
    // secUid
    const { secUid } = await chrome.storage.local.get("secUid");
    if ($("settingsSecUid")) $("settingsSecUid").value = secUid || "";
    // 缓存状态
    this._renderCacheList(ci, ct);
    // ponytail: status readout — independent sub-fetch failure should not block the rest
    this._renderStatus(secRes);
    // 运行参数
    this._renderConfigSection();
  }

  _renderConfigSection() {
    const cfg = runtimeConfig._cache || runtimeConfig.DEFAULTS;
    const map = {
      timeoutRequest: "timeoutRequest",
      timeoutSecurityStatus: "timeoutSecurityStatus",
      syncWorksDelayMin: "syncWorksDelayMin",
      syncWorksDelayMax: "syncWorksDelayMax",
      syncFollowingsDelayMin: "syncFollowingsDelayMin",
      syncFollowingsDelayMax: "syncFollowingsDelayMax",
      syncFavoritesDelayMin: "syncFavoritesDelayMin",
      syncFavoritesDelayMax: "syncFavoritesDelayMax",
      syncCollectionDelayMin: "syncCollectionDelayMin",
      syncCollectionDelayMax: "syncCollectionDelayMax",
      cancelLikeDelayMin: "cancelLikeDelayMin",
      cancelLikeDelayMax: "cancelLikeDelayMax",
      cancelCollectionDelayMin: "cancelCollectionDelayMin",
      cancelCollectionDelayMax: "cancelCollectionDelayMax",
      syncBatchSize: "syncBatchSize",
      syncBatchPauseMin: "syncBatchPauseMin",
      syncBatchPauseMax: "syncBatchPauseMax",
      syncKeepaliveInterval: "syncKeepaliveInterval",
      syncRetryMax: "syncRetryMax",
    };
    const section = this._dialogBody.querySelector("#settingsConfigSection");
    if (!section) return;
    for (const [key, inputKey] of Object.entries(map)) {
      const input = section.querySelector(`.config-input[data-key="${inputKey}"]`);
      if (input) input.value = cfg[key] ?? "";
    }
    const calSwitch = section.querySelector("#settingsCalibrateSwitch");
    if (calSwitch) {
      this.#applySwitchUI(calSwitch, this._pendingCalibrate ?? (cfg.calibrateFollowings !== false));
    }
  }

  _renderCacheList(ci, ct) {
    const list = this._dialogBody.querySelector("#settingsCacheList");
    if (!list) return;
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

  _bindStatus() {
    const root = this._dialogBody;
    root.querySelectorAll(".sec-expand-hint").forEach((hint) => {
      hint.addEventListener("click", (e) => {
        e.stopPropagation();
        const row = hint.closest(".sec-clickable");
        if (!row) return;
        if (row.id === "secKeyValue") this.toggleKeyExpand(root);
        else this.toggleSigExpand(root, row.id);
      });
    });
    root.querySelectorAll(".sec-copy-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const targetId = btn.dataset.copy;
        if (!targetId) return;
        const el = root.querySelector("#" + targetId);
        const text = el?.textContent || "";
        if (!text || text === "\u2014") return;
        navigator.clipboard.writeText(text).then(
          () => dialog.showToast("\u5df2\u590d\u5236", "success")
        );
      });
    });
  }

  _renderStatus(secRes) {
    const root = this._dialogBody;
    if (!root) return;
    // ponytail: a failed sub-fetch only paints the status sections, never blocks others
    if (!secRes || !secRes.ok || !secRes.status) {
      const errMsg = secRes?.error || "QUERY_FAILED";
      const targets = ["secKeyStatus", "secSigFollowingStatus", "secSigPostStatus", "secSigFavoriteStatus", "secSigCollectionStatus", "secHookFetch", "secHookXhr"];
      for (const id of targets) {
        const el = root.querySelector("#" + id);
        if (!el) continue;
        if (id === "secHookFetch" || id === "secHookXhr") {
          el.textContent = "❌ 查询失败";
        } else {
          el.textContent = `❌ 查询失败：${errMsg}`;
        }
        el.className = "sec-value sec-err";
      }
      return;
    }
    const s = secRes.status;
    this._renderStatusKey(root, s.key, s.keyUpdatedAt);
    this._renderStatusSig(root, s.signatures?.following, "secSigFollowing", "secSigFollowingValue", "请在抖音页面访问关注列表，等待列表加载后返回刷新状态");
    this._renderStatusSig(root, s.signatures?.post, "secSigPost", "secSigPostValue", "请在抖音页面访问任意作者主页，等待作品加载后返回刷新状态");
    this._renderStatusSig(root, s.signatures?.favorite, "secSigFavorite", "secSigFavoriteValue", "请在抖音页面访问喜欢列表，等待加载后返回刷新状态");
    this._renderStatusSig(root, s.signatures?.collection, "secSigCollection", "secSigCollectionValue", "请在抖音页面访问收藏列表，等待加载后返回刷新状态");
    this._renderStatusHooks(root, s.hooks);
  }

  // 开关仅切换视觉态；持久化与副作用统一走「关闭时校验并持久化」（saveBeforeClose）
  #applySwitchUI(switchEl, on) {
    const btn = switchEl.querySelector(`.mode-btn[data-mode="${on ? "on" : "off"}"]`);
    if (!btn) return;
    switchEl.querySelectorAll(".mode-btn").forEach((b) => b.classList.toggle("active", b === btn));
    const slider = switchEl.querySelector(".mode-slider");
    if (slider) {
      slider.style.width = btn.offsetWidth + "px";
      slider.style.transform = "translateX(" + btn.offsetLeft + "px)";
    }
  }

  // min/max 成对即时校验：两端同亮同灭，避免只标一端造成误读
  #validateDelayPair(section, key) {
    if (!section || !key || !(key.endsWith("Min") || key.endsWith("Max"))) return;
    const base = key.slice(0, -3);
    const minInput = section.querySelector(`.config-input[data-key="${base}Min"]`);
    const maxInput = section.querySelector(`.config-input[data-key="${base}Max"]`);
    if (!minInput || !maxInput) return;
    const min = Number(minInput.value);
    const max = Number(maxInput.value);
    const filled = minInput.value.trim() !== "" && maxInput.value.trim() !== "";
    const invalid = filled && Number.isFinite(min) && Number.isFinite(max) && min > max;
    minInput.classList.toggle("input-invalid", invalid);
    maxInput.classList.toggle("input-invalid", invalid);
  }

  _bind() {
    const $ = (id) => this._dialogBody.querySelector("#" + id);
    // ponytail: section titles toggle a .collapsed class; CSS grid-template-rows handles the animation
    this._dialogBody.querySelectorAll(".settings-section-title").forEach((h3) => {
      h3.addEventListener("click", () => {
        h3.closest(".settings-section").classList.toggle("collapsed");
      });
    });
    // 恢复默认（建议9）：仅回填输入框，持久化仍统一走关闭面板时的 saveBeforeClose
    const cfgSection = $("settingsConfigSection");
    $("btnResetConfig")?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!cfgSection) return;
      cfgSection.querySelectorAll(".config-input").forEach((inp) => {
        const key = inp.dataset.key;
        if (key && runtimeConfig.DEFAULTS[key] != null) inp.value = runtimeConfig.DEFAULTS[key];
        inp.classList.remove("input-invalid");
      });
      dialog.showToast("已填入默认参数，关闭面板时保存", "info");
    });
    // min/max 即时校验（建议9）：输入期红框提示，保存拦截仍由 saveBeforeClose 兜底
    cfgSection?.addEventListener("input", (e) => {
      const input = e.target.closest?.(".config-input");
      if (!input) return;
      this.#validateDelayPair(cfgSection, input.dataset.key);
    });
    const modeSwitch = $("settingsModeSwitch");
    if (modeSwitch) {
      modeSwitch.addEventListener("click", (e) => {
        const btn = e.target.closest(".mode-btn");
        if (!btn || btn.classList.contains("active")) return;
        this._pendingIndependent = btn.dataset.mode === "on";
        this.#applySwitchUI(modeSwitch, this._pendingIndependent);
      });
    }
    const calibrateSwitch = this._dialogBody.querySelector("#settingsCalibrateSwitch");
    if (calibrateSwitch) {
      calibrateSwitch.addEventListener("click", (e) => {
        const btn = e.target.closest(".mode-btn");
        if (!btn || btn.classList.contains("active")) return;
        this._pendingCalibrate = btn.dataset.mode === "on";
        this.#applySwitchUI(calibrateSwitch, this._pendingCalibrate);
      });
    }
    // 缓存刷新按钮
    const cacheList = $("settingsCacheList");
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
            await this._refresh();
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
    if (!this._dialogBody) return true;
    const section = this._dialogBody.querySelector("#settingsConfigSection");
    // 设置面板未打开（当前弹窗是其它面板）时无需处理
    if (!section) return true;
    const FIELDS = [
      "timeoutRequest", "timeoutSecurityStatus",
      "syncWorksDelayMin", "syncWorksDelayMax",
      "syncFollowingsDelayMin", "syncFollowingsDelayMax",
      "syncFavoritesDelayMin", "syncFavoritesDelayMax",
      "syncCollectionDelayMin", "syncCollectionDelayMax",
      "cancelLikeDelayMin", "cancelLikeDelayMax",
      "cancelCollectionDelayMin", "cancelCollectionDelayMax",
      "syncBatchSize", "syncBatchPauseMin", "syncBatchPauseMax",
      "syncKeepaliveInterval", "syncRetryMax",
    ];
    const DELAY_PAIRS = [
      ["syncWorksDelayMin", "syncWorksDelayMax", "同步作品"],
      ["syncFollowingsDelayMin", "syncFollowingsDelayMax", "同步关注"],
      ["syncFavoritesDelayMin", "syncFavoritesDelayMax", "扫描点赞"],
      ["syncCollectionDelayMin", "syncCollectionDelayMax", "扫描收藏"],
      ["cancelLikeDelayMin", "cancelLikeDelayMax", "取消点赞"],
      ["cancelCollectionDelayMin", "cancelCollectionDelayMax", "取消收藏"],
    ];
    const values = {};
    for (const key of FIELDS) {
      const input = section.querySelector(`.config-input[data-key="${key}"]`);
      const raw = input?.value.trim();
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
    values.calibrateFollowings = this._pendingCalibrate ?? (section.querySelector("#settingsCalibrateSwitch .mode-btn.active")?.dataset.mode === "on");
    if (values.syncBatchPauseMin > values.syncBatchPauseMax) {
      dialog.showToast("批次暂停最小值不能大于最大值", "error");
      return false;
    }
    try {
      await runtimeConfig.save(values);
      const secUidInput = this._dialogBody.querySelector("#settingsSecUid");
      await chrome.storage.local.set({ secUid: secUidInput?.value.trim() || "" });
    } catch {
      dialog.showToast("保存失败", "error");
    }
    // 独立模式：与运行参数同走关闭通道；与存储值有变化才下发 SET_MODE（写存储+background 运行态+a-bogus 初始化）
    const modeOn = this._pendingIndependent ?? (section.querySelector("#settingsModeSwitch .mode-btn.active")?.dataset.mode === "on");
    const { independentMode: savedOn } = await chrome.storage.local.get("independentMode");
    if (modeOn !== (savedOn === true)) {
      try {
        await services.bgMsg({ type: "SET_MODE", enabled: modeOn });
        this._pendingIndependent = null;
      } catch {
        dialog.showToast("独立模式切换失败", "error");
        return false;
      }
    }
    return true;
  }
}

export const settings = new Settings();
