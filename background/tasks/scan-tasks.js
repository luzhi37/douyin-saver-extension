// background/tasks/scan-tasks.js — Tab 模式长任务（calibrateStats / calibrateOne / fetchFollowing / persistScan / fetchFavorites / fetchCollection / runCancelBatch / syncWorks）

import { CONFIG, utils, runtimeConfig } from "../core.js";
import { credentials } from "../identity/credentials.js";
import { independentClient } from "../identity/independent-client.js";
import { tabBridge } from "../identity/tab-bridge.js";
import { domainStore } from "../data/domain-store.js";

// ---------- ScanTasks ----------
// Tab 模式长任务（经 TabBridge 循环）
class ScanTasks {
  // 关注列表接口返回的 aweme_count/follower_count 是滞后快照值（与主页展示差异大），
  // 列表收集完成后逐用户请求 user/profile/other 用权威计数覆盖。
  // fetchStats(secUid) 由调用方按模式提供（tab 转发 / 独立直连）；单条失败静默跳过保留旧值。
  async calibrateStats(list, fetchStats, isCancelled, requestId) {
    let processed = 0;
    for (const entry of list) {
      if (isCancelled()) break;
      processed += 1;
      const m = String(entry.profileUrl || "").match(/\/user\/([^/?#]+)/);
      if (m && m[1]) {
        try {
          const stats = await fetchStats(m[1]);
          entry.awemeCount = stats.awemeCount;
          entry.followerCount = stats.followerCount;
        } catch (_e) {}
      }
      chrome.runtime
        .sendMessage({
          type: "FOLLOWING_PROGRESS",
          phase: "calibrate",
          collected: processed,
          total: list.length,
          hasMore: false,
          requestId,
        })
        .catch(() => {});
      if (!isCancelled()) {
        const d = runtimeConfig.delayRange("syncFollowings");
        const delay = d.MIN + Math.random() * (d.MAX - d.MIN);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  // 单用户校准：打开侧边栏时触发（不受 calibrateFollowings 开关门控），取 profile/other
  // 权威计数后直接落库；options 端据返回值更新 state 与可见卡片
  async calibrateOne(uid, secUid, sendResponse) {
    try {
      if (!uid || !secUid) return sendResponse({ ok: false, error: "BAD_PARAMS" });
      let stats;
      if (await independentClient.loadMode()) {
        await credentials.ensureABogus();
        const data = await independentClient.request(
          CONFIG.API.PROFILE_OTHER,
          await credentials.buildBaseParams({ sec_user_id: secUid }),
        );
        if (!data.user) throw new Error("PROFILE_FETCH_FAILED");
        stats = {
          awemeCount: data.user.aweme_count || 0,
          followerCount: data.user.follower_count || 0,
        };
      } else {
        const resp = await tabBridge.sendAsync("FETCH_USER_PROFILE", {
          secUid,
          timeout: CONFIG.TIMEOUT.REQUEST,
        });
        if (!resp?.ok) throw new Error(resp?.error || "PROFILE_FETCH_FAILED");
        stats = { awemeCount: resp.awemeCount, followerCount: resp.followerCount };
      }
      const ds = domainStore.facade(CONFIG.STORAGE_KEYS.FOLLOWINGS);
      const record = await ds.get(String(uid));
      if (!record) return sendResponse({ ok: false, error: "NOT_FOUND" });
      record.awemeCount = stats.awemeCount;
      record.followerCount = stats.followerCount;
      await ds.putBatch([record]);
      sendResponse({ ok: true, ...stats });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  }

  async fetchFollowing(secUid, sendResponse) {
    try {
      const requestId = crypto.randomUUID();
      let cancelled = false;
      const cancelHandler = (msg) => {
        if (msg.type === "CANCEL_ACTIVE_TASK") {
          cancelled = true;
        }
      };
      chrome.runtime.onMessage.addListener(cancelHandler);

      const all = [];
      let offset = 0;
      let hasMore = true;
      let lastError = "";

      while (hasMore && !cancelled) {
        const resp = await tabBridge.sendAsync("FETCH_FOLLOWING_PAGE", {
          secUid,
          offset,
          count: CONFIG.PAGE.FOLLOWING,
          timeout: CONFIG.TIMEOUT.REQUEST,
        });
        if (resp?.ok && Array.isArray(resp.items)) {
          all.push(...resp.items);
          hasMore = resp.hasMore === true;
          offset = resp.cursor;
        } else {
          lastError = resp?.error || "FETCH_FAILED";
          break;
        }
        chrome.runtime
          .sendMessage({
            type: "FOLLOWING_PROGRESS",
            collected: all.length,
            hasMore,
            total: resp.total || 0,
            requestId,
          })
          .catch(() => {});
        if (hasMore && !cancelled) {
          const d = runtimeConfig.delayRange("syncFollowings");
          const delay = d.MIN + Math.random() * (d.MAX - d.MIN);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      if (!cancelled && all.length > 0 && (await independentClient.isCalibrateEnabled())) {
        await this.calibrateStats(
          all,
          async (secUid) => {
            const resp = await tabBridge.sendAsync("FETCH_USER_PROFILE", {
              secUid,
              timeout: CONFIG.TIMEOUT.REQUEST,
            });
            if (!resp?.ok) throw new Error(resp?.error || "PROFILE_FETCH_FAILED");
            return resp;
          },
          () => cancelled,
          requestId,
        );
      }
      chrome.runtime.onMessage.removeListener(cancelHandler);
      if (!cancelled && all.length === 0 && lastError) {
        sendResponse({ ok: false, error: lastError, requestId });
        return;
      }
      sendResponse({ ok: true, requestId, followings: all, total: all.length });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  }

  // 扫描落库 + 丢失检测（persist = "likes" | "favorites" 时启用）。
  // 用户中途取消时跳过丢失检测（部分拉取会产生假丢失），已收集部分仍合并落库（幂等）。
  async persistScan(persistDomain, all, cancelled) {
    if (!persistDomain || cancelled || all.length === 0) return { saved: null, lostUids: [] };
    const ds = domainStore.facade(persistDomain);
    const idField = ds.idField;
    const oldKeys = Object.keys(await ds.getAll());
    const saved = await domainStore.mergeAndSave(persistDomain, all);

    // 按远端列表顺序（即主页点赞/收藏顺序，最新在前）写 savedAt，使列表顺序与主页一致。
    // 必须在落库后读回完整记录再合并写回，避免 putBatch 整条替换导致视频/封面等字段丢失；
    // 也不能用「落库后再 ds.get 判定是否新条目」——mergeAndSave 已先把新条目写入，
    // 会导致 newOnes 永远为空、savedAt 全退化为 Date.now()（即当前「保存时间都一样」的 bug）。
    const baseTime = Date.now();
    const stampIds = all.filter((w) => w && w[idField]).map((w) => String(w[idField]));
    const records = await Promise.all(stampIds.map((id) => ds.get(id)));
    const toWrite = records
      .map((rec, i) => (rec ? { ...rec, savedAt: baseTime - i } : null))
      .filter(Boolean);
    if (toWrite.length > 0) await ds.putBatch(toWrite);

    const incomingIds = new Set(stampIds);
    const lostUids = oldKeys.filter((k) => !incomingIds.has(String(k)));
    return { saved, lostUids };
  }

  async fetchFavorites(secUid, persist, sendResponse) {
    try {
      const requestId = crypto.randomUUID();
      let cancelled = false;
      const cancelHandler = (msg) => {
        if (msg.type === "CANCEL_ACTIVE_TASK") {
          cancelled = true;
        }
      };
      chrome.runtime.onMessage.addListener(cancelHandler);

      const all = [];
      let cursor = 0;
      let hasMore = true;
      let lastError = "";

      while (hasMore && !cancelled) {
        const resp = await tabBridge.sendAsync("FETCH_FAVORITES_PAGE", {
          secUid,
          cursor,
          count: CONFIG.PAGE.FAVORITE,
          timeout: CONFIG.TIMEOUT.REQUEST,
        });
        if (resp?.ok && Array.isArray(resp.items)) {
          all.push(...resp.items);
          hasMore = resp.hasMore === true;
          cursor = resp.cursor || cursor;
        } else {
          lastError = resp?.error || "FETCH_FAILED";
          break;
        }
        const unfollowedCount = all.filter((w) => w.authorFollowed === false).length;
        chrome.runtime
          .sendMessage({
            type: "FAVORITES_PROGRESS",
            collected: all.length,
            unfollowedCount,
            hasMore,
            total: resp.total || 0,
            requestId,
          })
          .catch(() => {});
        if (hasMore && !cancelled) {
          const d = runtimeConfig.delayRange("syncFavorites");
          const delay = d.MIN + Math.random() * (d.MAX - d.MIN);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      chrome.runtime.onMessage.removeListener(cancelHandler);
      if (!cancelled && all.length === 0 && lastError) {
        sendResponse({ ok: false, error: lastError, requestId });
        return;
      }
      const { saved, lostUids } = await this.persistScan(persist, all, cancelled);
      sendResponse({ ok: true, requestId, works: all, timedOut: cancelled, saved, lostUids });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  }

  async fetchCollection(persist, sendResponse) {
    try {
      const requestId = crypto.randomUUID();
      let cancelled = false;
      const cancelHandler = (msg) => {
        if (msg.type === "CANCEL_ACTIVE_TASK") {
          cancelled = true;
        }
      };
      chrome.runtime.onMessage.addListener(cancelHandler);

      const all = [];
      let cursor = 0;
      let hasMore = true;
      let lastError = "";

      while (hasMore && !cancelled) {
        const resp = await tabBridge.sendAsync("FETCH_COLLECTION_PAGE", {
          cursor,
          count: CONFIG.PAGE.COLLECTION,
          timeout: CONFIG.TIMEOUT.REQUEST,
        });
        if (resp?.ok && Array.isArray(resp.items)) {
          all.push(...resp.items);
          hasMore = resp.hasMore === true;
          cursor = resp.cursor || cursor;
        } else {
          lastError = resp?.error || "FETCH_FAILED";
          break;
        }
        const unfollowedCount = all.filter((w) => w.authorFollowed === false).length;
        chrome.runtime
          .sendMessage({
            type: "COLLECTION_PROGRESS",
            collected: all.length,
            unfollowedCount,
            hasMore,
            total: resp.total || 0,
            requestId,
          })
          .catch(() => {});
        if (hasMore && !cancelled) {
          const d = runtimeConfig.delayRange("syncCollection");
          const delay = d.MIN + Math.random() * (d.MAX - d.MIN);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      chrome.runtime.onMessage.removeListener(cancelHandler);
      if (!cancelled && all.length === 0 && lastError) {
        sendResponse({ ok: false, error: lastError, requestId });
        return;
      }
      const { saved, lostUids } = await this.persistScan(persist, all, cancelled);
      sendResponse({ ok: true, requestId, works: all, timedOut: cancelled, saved, lostUids });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  }

  async runCancelBatch(awemeIds, tabType, progressType, persistDomain, sendResponse) {
    if (!Array.isArray(awemeIds) || awemeIds.length === 0) {
      sendResponse({ ok: false, error: "EMPTY" });
      return;
    }
    const requestId = crypto.randomUUID();
    const errors = [];
    let cancelled = false;
    const cancelHandler = (msg) => {
      if (msg.type === "CANCEL_ACTIVE_TASK") cancelled = true;
    };
    chrome.runtime.onMessage.addListener(cancelHandler);

    sendResponse({ ok: true, requestId, total: awemeIds.length });

    for (let i = 0; i < awemeIds.length && !cancelled; i++) {
      const resp = await tabBridge.sendAsync(tabType, {
        awemeId: awemeIds[i],
        timeout: CONFIG.TIMEOUT.REQUEST,
      });
      if (resp?.ok) {
        // success
      } else {
        errors.push({ awemeId: awemeIds[i], error: resp?.error || "FAILED" });
      }
      chrome.runtime
        .sendMessage({
          type: progressType,
          requestId,
          index: i,
          total: awemeIds.length,
          status: resp?.ok ? "ok" : "error",
          awemeId: awemeIds[i],
        })
        .catch(() => {});

      if (!cancelled && i < awemeIds.length - 1) {
        const delayKind = tabType === "CANCEL_ONE_COLLECTION" ? "cancelCollection" : "cancelLike";
        const d = runtimeConfig.delayRange(delayKind);
        const delay = d.MIN + Math.random() * (d.MAX - d.MIN);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    chrome.runtime.onMessage.removeListener(cancelHandler);
    const failedAwemeIds = errors.map((e) => e.awemeId).filter(Boolean);
    // 移除 = 取消并删本地：远端取消成功的条目同步删除该域本地记录
    const deletedIds = await this.deleteCancelled(persistDomain, awemeIds, failedAwemeIds);
    chrome.runtime
      .sendMessage({
        type: "CANCEL_DONE",
        requestId,
        ok: true,
        cancelled,
        refreshed: awemeIds.length - errors.length,
        failed: errors.length,
        failedAwemeIds,
        deletedIds,
      })
      .catch(() => {});
  }

  // persistDomain 为空则跳过删本地（原扫描弹窗调用方无域概念）
  async deleteCancelled(persistDomain, awemeIds, failedAwemeIds) {
    if (!persistDomain) return [];
    const failedSet = new Set((failedAwemeIds || []).map(String));
    const ids = (awemeIds || []).map(String).filter((id) => !failedSet.has(id));
    if (ids.length === 0) return [];
    try {
      await domainStore.facade(persistDomain).deleteBatch(ids);
      return ids;
    } catch (err) {
      console.warn("[DY] delete cancelled from domain failed:", err.message);
      return [];
    }
  }

  async syncWorks(awemeIds, sendResponse) {
    if (!Array.isArray(awemeIds) || awemeIds.length === 0) {
      return sendResponse({ ok: false, error: "EMPTY" });
    }

    const requestId = crypto.randomUUID();
    let cancelled = false;

    const cancelHandler = (msg) => {
      if (msg.type === "CANCEL_ACTIVE_TASK") {
        cancelled = true;
        tabBridge.find().then((tab) => {
          if (!tab) return;
          chrome.tabs.sendMessage(tab.id, { type: "CANCEL_ACTIVE_TASK" }).catch(() => {});
        });
      }
    };
    chrome.runtime.onMessage.addListener(cancelHandler);

    sendResponse({ ok: true, requestId, total: awemeIds.length });

    const allWorks = [];
    const errors = [];

    for (let i = 0; i < awemeIds.length && !cancelled; i++) {
      const resp = await tabBridge.sendAsync("FETCH_SINGLE_WORK", {
        awemeId: awemeIds[i],
        timeout: CONFIG.TIMEOUT.REQUEST,
      });

      if (!resp?.ok) {
        const err = resp?.error || "UNKNOWN";
        if (CONFIG.FATAL_ERRORS.has(err) || err.startsWith("HTTP 429") || err.startsWith("HTTP 401")) {
          for (let j = i; j < awemeIds.length; j++) {
            errors.push({ awemeId: awemeIds[j], error: j === i ? err : "BATCH_TERMINATED" });
          }
          break;
        }
        errors.push({ awemeId: awemeIds[i], error: err });
      } else if (resp.work) {
        allWorks.push(resp.work);
      } else {
        errors.push({ awemeId: awemeIds[i], error: "DELETED" });
      }

      chrome.runtime
        .sendMessage({
          type: "SYNC_PROGRESS",
          requestId,
          index: i,
          total: awemeIds.length,
          status: resp?.ok ? "ok" : "error",
          awemeId: awemeIds[i],
        })
        .catch(() => {});

      if (!cancelled) {
        const { BATCH_SIZE, BATCH_PAUSE_MIN, BATCH_PAUSE_MAX, KEEPALIVE_INTERVAL } = CONFIG.SYNC;
        if (BATCH_SIZE > 0 && (i + 1) % BATCH_SIZE === 0) {
          const batchPause = BATCH_PAUSE_MIN + Math.random() * (BATCH_PAUSE_MAX - BATCH_PAUSE_MIN);
          const deadline = Date.now() + batchPause;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, KEEPALIVE_INTERVAL));
            await chrome.storage.local.get("keepalive");
          }
        } else {
          const d = runtimeConfig.delayRange("syncWorks");
          const delay = d.MIN + Math.random() * (d.MAX - d.MIN);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    chrome.runtime.onMessage.removeListener(cancelHandler);

    try {
      if (allWorks.length > 0) {
        const result = await domainStore.mergeAndSave(CONFIG.STORAGE_KEYS.WORKS, allWorks);
        utils.sendSyncDone(requestId, {
          ok: true,
          refreshed: result.added + result.updated,
          failed: errors.length,
          failedAwemeIds: errors.map((e) => e.awemeId).filter(Boolean),
        });
      } else {
        utils.sendSyncDone(requestId, { ok: false, error: errors[0]?.error || "NO_WORKS_COLLECTED" });
      }
    } catch (err) {
      utils.sendSyncDone(requestId, { ok: false, error: err.message });
    }
  }
}
const scanTasks = new ScanTasks();

export { scanTasks };
