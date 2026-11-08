// ---------- Sync ----------
import { config, state, services, store, utils } from '../core.js';
import { dialog } from '../components/dialog.js';
import { groups } from '../data/groups.js';
import { appShell } from '../components/app-shell.js';

// ---------- Sync ----------
class Sync {
  #running = false;
  #requestId = null;
  #currentDomain = null;
  #doneCount = 0;
  #total = 0;
  #errorCount = 0;
  #countEl = null;
  #summaryEl = null;
  #statusEl = null;

  isRunning() {
    return this.#running;
  }

  #initProgress(total) {
    this.#total = total;
    this.#doneCount = 0;
    this.#errorCount = 0;
  }

  #updateCount() {
    if (!this.#countEl) return;
    const label = this.#currentDomain === "followings" ? "作者" : "作品";
    this.#countEl.textContent = `已同步${label} ${this.#doneCount} / ${this.#total}`;
  }

  #setSummary(text) {
    if (this.#summaryEl) this.#summaryEl.textContent = text || "";
  }

  async #refreshWorks() {
    // 统一走 loadDomainDataSafe：作品同步完成后必须遵循当前 pagingMode（含 authorCount
    // 作者视图游标），不能再用一次性全量读取 + store.set 退回全量 saved 序
    if (state.domain === "works") await appShell.loadDomainDataSafe();
    await groups.renderGroupTabs();
  }

  openSyncDialog(total, domain) {
    this.#initProgress(total);
    this.#currentDomain = domain;

    const { body, countEl, summaryEl, statusEl } = utils.buildSyncProgressBody();
    this.#countEl = countEl;
    this.#summaryEl = summaryEl;
    this.#statusEl = statusEl;

    const label = domain === "followings" ? "作者" : "作品";
    this.#countEl.textContent = `已同步${label} 0 / ${total}`;
    this.#summaryEl.textContent = domain === "followings" ? "正在获取关注…" : "同步失败作品 0 个";

    dialog.showDialog(domain === "followings" ? "同步关注" : "同步作品", body, [], () => this.closeSyncDialog());
  }

  closeSyncDialog() {
    dialog.closeDialog();
    this.finish();
  }

  finish() {
    this.#running = false;
    this.#requestId = null;
    this.#currentDomain = null;
  }

  onSyncProgress(msg) {
    if (!this.#running || this.#currentDomain !== "works") return;
    if (msg.requestId !== this.#requestId) return;

    this.#doneCount++;
    if (msg.status !== "ok") this.#errorCount++;
    this.#updateCount();
    this.#setSummary(`同步失败作品 ${this.#errorCount} 个`);
  }

  async onSyncDone(msg) {
    if (!this.#running || this.#currentDomain !== "works") return;
    if (msg && msg.requestId !== this.#requestId) return;

    this.#running = false;

    if (!msg || !msg.ok) {
      if (this.#statusEl) this.#statusEl.textContent = msg?.error || "ERROR";
      return;
    }

    await this.#refreshWorks();

    this.#setSummary(`同步失败作品 ${msg.failed || 0} 个`);
    if (this.#statusEl) this.#statusEl.textContent = "DONE";

    const failedIds = msg.failedAwemeIds || [];
    if (failedIds.length > 0) {
      dialog.addTrashButton(() => this.moveFailed(failedIds), () => this.closeSyncDialog());
    }
  }

  onFollowingProgress(msg) {
    if (!this.#running || this.#currentDomain !== "followings") return;
    if (this.#requestId !== null && msg.requestId !== this.#requestId) return;

    this.#doneCount = msg.collected || 0;
    this.#total = msg.total || 0;
    this.#updateCount();
    this.#setSummary("正在获取关注…");
  }

  async startSync(awemeIds) {
    // 调用方 syncAwemeIds 已做 isRunning/空数组前置检查，此处不再重复守卫
    this.#running = true;

    chrome.runtime.sendMessage({ type: "CANCEL_ACTIVE_TASK" }).catch(() => {});

    try {
      const res = await services.bgMsg({ type: "SYNC_WORKS", awemeIds });
      if (!this.#running) return "CANCELLED";
      if (!res || res.error === "NO_DOUYIN_TAB") {
        this.#running = false;
        return "NO_DOUYIN_TAB";
      }
      if (!res || res.requestId === null || res.requestId === undefined) {
        this.#running = false;
        return { error: (res && res.error) || "未知错误" };
      }
      this.#requestId = res.requestId;
      return { requestId: res.requestId };
    } catch (err) {
      this.#running = false;
      return { error: err.message || String(err) };
    }
  }

  async syncAwemeIds(awemeIds) {
    if (this.isRunning()) return;
    if (!Array.isArray(awemeIds) || awemeIds.length === 0) return;

    this.openSyncDialog(awemeIds.length, "works");
    const result = await this.startSync(awemeIds);

    if (result === "NO_DOUYIN_TAB") {
      if (this.#statusEl) this.#statusEl.textContent = "NO_DOUYIN_TAB";
      return;
    }
    if (result && result.error) {
      if (this.#statusEl) this.#statusEl.textContent = result.error;
    }
  }

  async syncCurrentGroup() {
    if (this.isRunning()) return;
    if (state.domain !== "works") return;
    const awemeIds = [...new Set(state.works.map((w) => String(w.awemeId)).filter(Boolean))];
    if (awemeIds.length === 0) return;
    await this.syncAwemeIds(awemeIds);
  }

  async vmSyncFollowings() {
    // 调用方 syncFollowings 已做同款前置检查（中间无异步点，守卫不可达）
    this.#running = true;

    // 两模式统一取完整本人 sec_uid（不用 "self" 哨兵）：优先配置面板填写的本地 secUid，
    // 未填写时由 findSecUid 按模式回退（tab=打开的 /user/* 页面，独立=RESOLVE_SEC_UID 兑换）。
    const secUid = await services.findSecUid();
    if (!secUid) {
      this.#running = false;
      return "NO_SEC_UID";
    }

    chrome.runtime.sendMessage({ type: "CANCEL_ACTIVE_TASK" }).catch(() => {});

    try {
      const res = await services.bgMsg({ type: "FETCH_FOLLOWING", secUid });
      if (!this.#running) return "CANCELLED";
      if (res.error === "NO_DOUYIN_TAB") {
        this.#running = false;
        return "NO_DOUYIN_TAB";
      }
      if (!res.ok) {
        this.#running = false;
        if (res.error && res.error.includes("NO_SIGNATURE")) return "NO_SIGNATURE";
        if (res.error === "FOLLOWING_LIST_PRIVATE") return "FOLLOWING_LIST_PRIVATE";
        throw new Error(res.error || "FETCH_FAILED");
      }
      this.#requestId = res.requestId || null;

      if (!this.#running) return "CANCELLED";

      const saveRes = await services.bgMsg({ type: "SAVE_FOLLOWINGS", followings: res.followings || [] });
      if (!this.#running) return "CANCELLED";

      await services.loadDomainData();
      this.#running = false;
      this.#requestId = null;
      return saveRes;
    } catch (err) {
      this.#running = false;
      this.#requestId = null;
      const msg = err.message || String(err);
      if (msg.includes("NO_SIGNATURE")) return "NO_SIGNATURE";
      return { error: msg };
    }
  }

  async syncFollowings() {
    if (this.isRunning()) return;
    if (state.domain !== "followings") return;

    this.openSyncDialog(0, "followings");

    const result = await this.vmSyncFollowings();

    if (result === "NO_SEC_UID") {
      if (this.#statusEl) this.#statusEl.textContent = "NO_SEC_UID";
      return;
    }

    if (result === "NO_DOUYIN_TAB") {
      if (this.#statusEl) this.#statusEl.textContent = "NO_DOUYIN_TAB";
      return;
    }

    if (result === "NO_SIGNATURE") {
      this.closeSyncDialog();
      dialog.showNoSignatureDialog(config.URL_USER_SELF + config.URL_FOLLOWING_TAB, "关注", "同步关注列表");
      return;
    }

    if (result === "CANCELLED") return;

    if (result === "FOLLOWING_LIST_PRIVATE") {
      if (this.#statusEl) this.#statusEl.textContent = "关注列表不可见（账号隐私设置）";
      return;
    }

    if (result && result.error) {
      if (this.#statusEl) this.#statusEl.textContent = result.error;
      return;
    }

    if (result && result.added !== undefined) {
      // 网格刷新已由 vmSyncFollowings 内 loadDomainData 完成，此处不再二次拉取重渲
      store.refreshGroups();
      this.#setSummary(`新增关注 ${result.added}，取消关注 ${result.lost}`);
      if (this.#statusEl) this.#statusEl.textContent = "DONE";
      const lostUids = result.lostUids || [];
      if (lostUids.length > 0) {
        dialog.addTrashButton(() => this.moveLostFollowings(lostUids), () => this.closeSyncDialog());
      }
    }
  }

  async moveFailed(failedIds) {
    return services.moveToTrashGroup("works", failedIds, (gid) =>
      services.bgMsg({ type: "MOVE_WORKS", awemeIds: failedIds, targetGroupId: gid }),
    );
  }

  async moveLostFollowings(lostUids) {
    return services.moveToTrashGroup("followings", lostUids, (gid) =>
      services.moveAuthorRecords("followings", lostUids, gid),
    );
  }
}

export const sync = new Sync();
