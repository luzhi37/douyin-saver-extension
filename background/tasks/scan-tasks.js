// background/tasks/scan-tasks.js — Tab 模式长任务（calibrateStats / calibrateOne / fetchFollowing / persistScan / fetchFavorites / fetchCollection / runCancelBatch / importUserWorks / syncWorks / importFollowing）

import { CONFIG, formatters, utils, runtimeConfig } from "../core.js";
import { credentials } from "../identity/credentials.js";
import { independentClient } from "../identity/independent-client.js";
import { tabBridge } from "../identity/tab-bridge.js";
import { domainStore } from "../data/domain-store.js";
import { runAuthorWorksImport } from "./author-works-import.js";

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
        // 最近更新日期：作品第一页 max(create_time)；失败静默保留旧值（含未校准 0）
        try {
          const t = await this.#fetchLatestWorkTime(m[1]);
          if (t) entry.lastUpdateAt = t;
        } catch (_e) {}
      }
      utils.sendMessageSafe({
        type: "FOLLOWING_PROGRESS",
        phase: "calibrate",
        collected: processed,
        total: list.length,
        hasMore: false,
        requestId,
      });
      if (!isCancelled()) {
        await new Promise((r) => setTimeout(r, runtimeConfig.randomDelay("syncFollowings")));
      }
    }
  }

  // 单用户校准：打开侧边栏时触发（不受 calibrateFollowings 开关门控），取 profile/other
  // 权威计数后直接落库；options 端据返回值更新 state 与可见卡片
  async calibrateOne(uid, secUid, sendResponse) {
    try {
      if (!uid || !secUid) return sendResponse({ ok: false, error: "BAD_PARAMS" });
      const stats = await this.#fetchProfileUser(secUid);
      const ds = domainStore.facade(CONFIG.STORAGE_KEYS.FOLLOWINGS);
      const record = await ds.get(String(uid));
      if (!record) return sendResponse({ ok: false, error: "NOT_FOUND" });
      record.awemeCount = stats.awemeCount;
      record.followerCount = stats.followerCount;
      // 最近更新日期：作品第一页 max(create_time)；失败保留旧值
      record.lastUpdateAt = (await this.#fetchLatestWorkTime(secUid).catch(() => 0)) || record.lastUpdateAt || 0;
      await ds.putBatch([record]);
      sendResponse({ ok: true, ...stats, lastUpdateAt: record.lastUpdateAt });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  }

  // 关注域入库：单请求收录作者档案。与「添加关注」同一条 mergeAndSaveFollowings 非 import
  // 分支——已在关注域的保留原分组，新作者落「未分组」（记录不预置 groupId）；
  // lastUpdateAt 借校准同款作品第一页采集，失败容忍占位 0
  async importFollowing(secUid, sendResponse) {
    try {
      if (!secUid) return sendResponse({ ok: false, error: "BAD_PARAMS" });
      const user = await this.#fetchProfileUser(secUid);
      if (!user.uid) throw new Error("PROFILE_FETCH_FAILED");
      const record = formatters.formatFollowingFromProfile(user);
      record.lastUpdateAt = (await this.#fetchLatestWorkTime(secUid).catch(() => 0)) || 0;
      const result = await domainStore.mergeAndSaveFollowings(CONFIG.STORAGE_KEYS.FOLLOWINGS, [record]);
      // 内容真有变化才广播：重复收录同一作者（字段全等）是 no-op，不该触发 options 重载
      if (result.changed > 0) {
        utils.sendMessageSafe({ type: "STORE_CHANGED", domain: CONFIG.STORAGE_KEYS.FOLLOWINGS });
      }
      sendResponse({ ok: true, following: record, added: result.added, updated: result.updated });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  }

  // 最近更新日期采集：作品列表第一页全部作品 create_time 的最大值（秒 → 毫秒）。
  // 与 fetchStats 同款按模式注入取数；失败抛错由调用方静默吞掉
  async #fetchLatestWorkTime(secUid) {
    let works = [];
    if (await independentClient.loadMode()) {
      await credentials.ensureABogus();
      const data = await independentClient.request(
        CONFIG.API.POST,
        await credentials.buildBaseParams({
          sec_user_id: secUid,
          max_cursor: "0",
          count: String(CONFIG.PAGE.AUTHOR),
        }),
      );
      works = (data.aweme_list || []).map(formatters.formatWork).filter(Boolean);
    } else {
      const resp = await tabBridge.sendAsync("FETCH_WORKS_PAGE", {
        secUid,
        cursor: "",
        count: CONFIG.PAGE.AUTHOR,
        timeout: CONFIG.TIMEOUT.REQUEST,
      });
      if (resp?.ok && Array.isArray(resp.works)) works = resp.works;
    }
    let max = 0;
    for (const w of works) {
      const t = Number(w.createTime) || 0;
      if (t > max) max = t;
    }
    return max ? max * 1000 : 0;
  }

  // 作者档案取数（双模）：独立直连 profile/other；Tab 转发 FETCH_USER_PROFILE。
  // 返回归一化 user 摘要（计数 + 关注域入库所需档案字段）；原始字段抽取与 inject 侧
  // FETCH_PROFILE_OTHER 结果对象的扁平化保持一致（calibrateOne / importFollowing 共用）
  async #fetchProfileUser(secUid) {
    if (await independentClient.loadMode()) {
      await credentials.ensureABogus();
      const data = await independentClient.request(
        CONFIG.API.PROFILE_OTHER,
        await credentials.buildBaseParams({ sec_user_id: secUid }),
      );
      if (!data.user) throw new Error("PROFILE_FETCH_FAILED");
      const user = data.user;
      return {
        awemeCount: user.aweme_count || 0,
        followerCount: user.follower_count || 0,
        nickname: user.nickname || "",
        avatarLarger: ((user.avatar_larger && user.avatar_larger.url_list) || [])[0] || "",
        uid: String(user.uid || ""),
        secUid: user.sec_uid || secUid,
      };
    }
    const resp = await tabBridge.sendAsync("FETCH_USER_PROFILE", {
      secUid,
      timeout: CONFIG.TIMEOUT.REQUEST,
    });
    if (!resp?.ok) throw new Error(resp?.error || "PROFILE_FETCH_FAILED");
    return {
      awemeCount: resp.awemeCount || 0,
      followerCount: resp.followerCount || 0,
      nickname: resp.nickname || "",
      avatarLarger: resp.avatarLarger || "",
      uid: String(resp.uid || ""),
      secUid: resp.secUid || secUid,
    };
  }

  async fetchFollowing(secUid, sendResponse) {
    try {
      const requestId = crypto.randomUUID();
      const guard = utils.withCancelGuard();

      const all = [];
      let offset = 0;
      let hasMore = true;
      let lastError = "";

      while (hasMore && !guard.isCancelled()) {
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
        utils.sendMessageSafe({
          type: "FOLLOWING_PROGRESS",
          collected: all.length,
          hasMore,
          total: resp.total || 0,
          requestId,
        });
        if (hasMore && !guard.isCancelled()) {
          await new Promise((r) => setTimeout(r, runtimeConfig.randomDelay("syncFollowings")));
        }
      }
      if (!guard.isCancelled() && all.length > 0 && (await independentClient.isCalibrateEnabled())) {
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
          () => guard.isCancelled(),
          requestId,
        );
      }
      guard.dispose();
      if (!guard.isCancelled() && all.length === 0 && lastError) {
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
  // 一遍式落库：getAllKeys 键集（丢失检测，不反序列化记录值）+ mergeAndSave({ stamps })
  // 单次合并写库——主页序 savedAt 戳记经 stamps 在写入前覆盖、全部 collected 记录一次
  // putBatch 写出。旧实现「mergeAndSave 后逐条读回再整批重写一遍」的三遍读写已由 stamps
  // 消解（戳覆盖发生在 mergeWork 合并之后、写入之前，无需读回）；added/updated/changed
  // 计数仍按覆盖前 isSameRecord 口径，汇总汇报语义不变
  async persistScan(persistDomain, all, cancelled) {
    if (!persistDomain || cancelled || all.length === 0) return { saved: null, lostUids: [] };
    const t0 = performance.now();
    const ds = domainStore.facade(persistDomain);
    const idField = ds.idField;
    const oldKeys = await ds.getAllKeys();

    // 按远端列表顺序（即主页点赞/收藏顺序，最新在前）写 savedAt，使列表顺序与主页一致。
    // 下标按有效条目序计（与旧 stampIds 口径一致）；重复 id 末次出现生效（Map 后写覆盖前写，
    // 与旧实现 putBatch 后写覆盖的最终态一致）；键用记录原值作主键（三作品型域 awemeId 恒为
    // 字符串，formatWork 保证），与 getBatch/put 同键空间
    const baseTime = Date.now();
    const stamps = new Map();
    let i = 0;
    for (const w of all) {
      if (w && w[idField]) stamps.set(w[idField], baseTime - i++);
    }
    const saved = await domainStore.mergeAndSave(persistDomain, all, { stamps });

    const lostUids = oldKeys.filter((k) => !stamps.has(String(k)));
    console.debug(
      `[DDM] persistScan ${persistDomain}: ${all.length} items in ${Math.round(performance.now() - t0)}ms`,
    );
    return { saved, lostUids };
  }

  // 点赞/收藏分页扫描通用循环：两者仅消息名/进度类型/延迟档/页大小/附加参数不同
  async #paginate({ fetchPage, progressType, delayKind, pageSize, extra = {}, persist, sendResponse }) {
    try {
      const requestId = crypto.randomUUID();
      const guard = utils.withCancelGuard();

      const all = [];
      let cursor = 0;
      let hasMore = true;
      let lastError = "";

      while (hasMore && !guard.isCancelled()) {
        const resp = await tabBridge.sendAsync(fetchPage, {
          ...extra,
          cursor,
          count: pageSize,
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
        utils.sendMessageSafe({
          type: progressType,
          collected: all.length,
          unfollowedCount,
          hasMore,
          total: resp.total || 0,
          requestId,
        });
        if (hasMore && !guard.isCancelled()) {
          await new Promise((r) => setTimeout(r, runtimeConfig.randomDelay(delayKind)));
        }
      }
      guard.dispose();
      if (!guard.isCancelled() && all.length === 0 && lastError) {
        sendResponse({ ok: false, error: lastError, requestId });
        return;
      }
      const { saved, lostUids } = await this.persistScan(persist, all, guard.isCancelled());
      sendResponse({ ok: true, requestId, works: all, timedOut: guard.isCancelled(), saved, lostUids });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  }

  fetchFavorites(secUid, persist, sendResponse) {
    return this.#paginate({
      fetchPage: "FETCH_FAVORITES_PAGE",
      progressType: "FAVORITES_PROGRESS",
      delayKind: "syncFavorites",
      pageSize: CONFIG.PAGE.FAVORITE,
      extra: { secUid },
      persist,
      sendResponse,
    });
  }

  fetchCollection(persist, sendResponse) {
    return this.#paginate({
      fetchPage: "FETCH_COLLECTION_PAGE",
      progressType: "COLLECTION_PROGRESS",
      delayKind: "syncCollection",
      pageSize: CONFIG.PAGE.COLLECTION,
      persist,
      sendResponse,
    });
  }

  // 作者作品批量入库（Tab 模式）：FETCH_WORKS_PAGE 取页器 + runAuthorWorksImport 共用循环壳。
  // 与收藏扫描（#paginate）的差异：
  // 1. 响应字段是 works/maxCursor 而非 items/cursor，不能直接套用 #paginate；
  // 2. 无丢失检测——他人作品列表不是本域全集，persistScan 会把存量误判 lost；
  // 3. 每页即落库，取消/异常保留已扫部分（落库/进度/去重/收尾在共用壳内）。
  async importUserWorks(secUid, sendResponse) {
    return runAuthorWorksImport(
      secUid,
      async (cursor) => {
        const resp = await tabBridge.sendAsync("FETCH_WORKS_PAGE", {
          secUid,
          cursor,
          count: CONFIG.PAGE.AUTHOR,
          timeout: CONFIG.TIMEOUT.REQUEST,
        });
        if (!resp?.ok || !Array.isArray(resp.works)) throw new Error(resp?.error || "FETCH_FAILED");
        return {
          works: resp.works,
          hasMore: resp.hasMore === true,
          maxCursor: resp.maxCursor,
          total: resp.total || 0,
        };
      },
      sendResponse,
    );
  }

  async runCancelBatch(awemeIds, tabType, progressType, persistDomain, sendResponse) {
    if (!Array.isArray(awemeIds) || awemeIds.length === 0) {
      sendResponse({ ok: false, error: "EMPTY" });
      return;
    }
    const requestId = crypto.randomUUID();
    const errors = [];
    const guard = utils.withCancelGuard();

    sendResponse({ ok: true, requestId, total: awemeIds.length });

    for (let i = 0; i < awemeIds.length && !guard.isCancelled(); i++) {
      const resp = await tabBridge.sendAsync(tabType, {
        awemeId: awemeIds[i],
        timeout: CONFIG.TIMEOUT.REQUEST,
      });
      if (resp?.ok) {
        // success
      } else {
        errors.push({ awemeId: awemeIds[i], error: resp?.error || "FAILED" });
      }
      utils.sendMessageSafe({
        type: progressType,
        requestId,
        index: i,
        total: awemeIds.length,
        status: resp?.ok ? "ok" : "error",
        awemeId: awemeIds[i],
      });

      if (!guard.isCancelled() && i < awemeIds.length - 1) {
        const delayKind = tabType === "CANCEL_ONE_COLLECTION" ? "cancelCollection" : "cancelLike";
        await new Promise((r) => setTimeout(r, runtimeConfig.randomDelay(delayKind)));
      }
    }

    guard.dispose();
    const failedAwemeIds = errors.map((e) => e.awemeId).filter(Boolean);
    // 移除 = 取消并删本地：远端取消成功的条目同步删除该域本地记录
    const deletedIds = await this.deleteCancelled(persistDomain, awemeIds, failedAwemeIds);
    utils.emitCancelDone(requestId, {
      ok: true,
      cancelled: guard.isCancelled(),
      refreshed: awemeIds.length - errors.length,
      failed: errors.length,
      failedAwemeIds,
      deletedIds,
    });
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

      utils.sendMessageSafe({
        type: "SYNC_PROGRESS",
        requestId,
        index: i,
        total: awemeIds.length,
        status: resp?.ok ? "ok" : "error",
        awemeId: awemeIds[i],
      });

      if (!cancelled) {
        await utils.pauseWithKeepalive(i, "syncWorks");
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
