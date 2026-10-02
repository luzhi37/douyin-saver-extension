// background/tasks/independent-tasks.js — 独立模式长任务（fetchFollowing / fetchCollection / syncWorks / fetchWorksPage / importUserWorks / cancel）

import { CONFIG, formatters, utils, runtimeConfig } from "../core.js";
import { credentials } from "../identity/credentials.js";
import { independentClient } from "../identity/independent-client.js";
import { domainStore } from "../data/domain-store.js";
import { scanTasks } from "./scan-tasks.js";
import { runAuthorWorksImport } from "./author-works-import.js";

// ---------- IndependentTasks ----------
// 独立模式长任务（经 IndependentClient.request 直连循环）
class IndependentTasks {
  async fetchFollowing(secUid, sendResponse) {
    try {
      await credentials.ensureABogus();
      if (secUid === "self" || !secUid) {
        const { secUid: stored } = await chrome.storage.local.get("secUid");
        if (stored && stored !== "self") secUid = stored;
        else secUid = await independentClient.resolveSelfSecUid();
        if (!secUid) return sendResponse({ ok: false, error: "NO_SEC_UID" });
      }
      // 关注列表归属由 Cookie 决定（与收藏扫描同款）：仅传 sec_user_id 标识目标，
      // 不额外附带 user_id。user_id 从 uid cookie 取第一个值，存在多账号/过期 cookie
      // 时可能与当前会话 uid 不一致，私密账户会据此判定为「他人查看」而返回 2096。
      const requestId = crypto.randomUUID();
      const guard = utils.withCancelGuard();
      let hasMore = true,
        offset = 0;
      const all = [];
      const seen = new Set();
      while (hasMore && !guard.isCancelled()) {
        const params = { sec_user_id: secUid, count: String(CONFIG.PAGE.FOLLOWING), offset: String(offset), min_time: "0", max_time: "0", source_type: "4", gps_access: "0", address_book_access: "0", is_top: "1" };
        const data = await independentClient.request(CONFIG.API.FOLLOWING, await credentials.buildBaseParams(params));
        if (data.status_code === 0 && Array.isArray(data.followings)) {
          if (data.followings.length === 0) break;
          const newItems = data.followings.filter((item) => !seen.has(String(item.uid)));
          if (newItems.length === 0) break;
          newItems.forEach((item) => seen.add(String(item.uid)));
          all.push(...newItems.map(formatters.formatFollowing));
          hasMore = utils.hasMoreFlag(data);
          if (data.total > 0 && all.length >= data.total) hasMore = false;
          offset += CONFIG.PAGE.FOLLOWING;
        } else break;
        utils.sendMessageSafe({
          type: "FOLLOWING_PROGRESS",
          collected: all.length,
          hasMore,
          total: data.total || 0,
          requestId,
        });
        if (hasMore && !guard.isCancelled()) {
          await new Promise((r) => setTimeout(r, runtimeConfig.randomDelay("syncFollowings")));
        }
      }
      if (!guard.isCancelled() && all.length > 0 && (await independentClient.isCalibrateEnabled())) {
        await scanTasks.calibrateStats(
          all,
          async (secUid) => {
            const data = await independentClient.request(
              CONFIG.API.PROFILE_OTHER,
              await credentials.buildBaseParams({ sec_user_id: secUid }),
            );
            if (!data.user) throw new Error("PROFILE_FETCH_FAILED");
            return {
              awemeCount: data.user.aweme_count || 0,
              followerCount: data.user.follower_count || 0,
            };
          },
          () => guard.isCancelled(),
          requestId,
        );
      }
      guard.dispose();
      sendResponse({ ok: true, requestId, followings: all, total: all.length });
    } catch (e) {
      // 2096 = 目标账号关注列表因隐私设置不可见；独立模式同步「我的关注」时若
      // sec_uid 解析为其他账号即会触发，这里给出明确错误而非通用 API_ERROR。
      if (e.statusCode === 2096) {
        sendResponse({ ok: false, error: "FOLLOWING_LIST_PRIVATE" });
        return;
      }
      sendResponse({ ok: false, error: e.message });
    }
  }

  async fetchCollection(persist, sendResponse) {
    try {
      await credentials.ensureABogus();
      const requestId = crypto.randomUUID();
      const guard = utils.withCancelGuard();
      let hasMore = true,
        cursor = 0;
      const all = [];
      while (hasMore && !guard.isCancelled()) {
        // 参考项目 TikTokDownloader 同端点形态：环境参数走 query，count/cursor 走 urlencoded
        // body —— 空 body 的 POST 会被服务端 Argus 以 Signature Not Found 拒绝；身份由
        // Cookie 决定，query/body 均不带 sec_user_id（参考项目同样不传）。
        const data = await independentClient.request(
          CONFIG.API.COLLECTION,
          await credentials.buildBaseParams({}),
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ count: String(CONFIG.PAGE.COLLECTION), cursor: String(cursor) }).toString(),
            referrer: "https://www.douyin.com/user/self?showTab=favorite_collection",
          },
        );
        if (data.status_code === 0 && Array.isArray(data.aweme_list)) {
          if (data.aweme_list.length === 0) break;
          all.push(...data.aweme_list.map(formatters.formatWork).filter(Boolean));
          hasMore = utils.hasMoreFlag(data);
          cursor = data.cursor || data.max_cursor || cursor + CONFIG.PAGE.COLLECTION;
        } else break;
        const un = all.filter((w) => w.authorFollowed === false).length;
        utils.sendMessageSafe({
          type: "COLLECTION_PROGRESS",
          collected: all.length,
          unfollowedCount: un,
          hasMore,
          total: data.total || 0,
          requestId,
        });
        if (hasMore && !guard.isCancelled()) {
          await new Promise((r) => setTimeout(r, runtimeConfig.randomDelay("syncCollection")));
        }
      }
      guard.dispose();
      const { saved, lostUids } = await scanTasks.persistScan(persist, all, guard.isCancelled());
      sendResponse({ ok: true, requestId, works: all, timedOut: guard.isCancelled(), saved, lostUids });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  }

  // 作者作品批量入库（独立模式）：aweme/post 取页器 + runAuthorWorksImport 共用循环壳。
  // 语义与 scanTasks.importUserWorks 一致：无丢失检测、每页即落库、分页结果不预置 groupId
  //（已在作品域的保留原分组、新条目落「未分组」）；单页请求失败记入 lastError 续行收尾，
  // 首页即失败才整体报错
  async importUserWorks(secUid, sendResponse) {
    if (!secUid) return sendResponse({ ok: false, error: "BAD_PARAMS" });
    try {
      await credentials.ensureABogus();
    } catch (e) {
      return sendResponse({ ok: false, error: e.message });
    }
    return runAuthorWorksImport(
      secUid,
      async (cursor) => {
        const data = await independentClient.request(
          CONFIG.API.POST,
          await credentials.buildBaseParams({
            sec_user_id: secUid,
            max_cursor: String(cursor || 0),
            count: String(CONFIG.PAGE.POST),
          }),
        );
        const works = (data.aweme_list || []).map(formatters.formatWork).filter(Boolean);
        return {
          works,
          hasMore: utils.hasMoreFlag(data),
          maxCursor: data.max_cursor,
          total: data.total || 0,
        };
      },
      sendResponse,
    );
  }

  async syncWorks(awemeIds, sendResponse) {
    if (!Array.isArray(awemeIds) || awemeIds.length === 0) return sendResponse({ ok: false, error: "EMPTY" });
    let requestId = null;
    try {
      await credentials.ensureABogus();
      requestId = crypto.randomUUID();
      const guard = utils.withCancelGuard();
      const allWorks = [],
        errors = [];
      sendResponse({ ok: true, requestId, total: awemeIds.length });
      for (let i = 0; i < awemeIds.length && !guard.isCancelled(); i++) {
        let currentOk = true;
        try {
          const params = await credentials.buildBaseParams({ aweme_id: awemeIds[i], request_source: "600", origin_type: "video_page" });
          let data, w;
          for (let attempt = 0; attempt < CONFIG.SYNC.RETRY_MAX; attempt++) {
            data = await independentClient.request(CONFIG.API.DETAIL, params);
            w = data.aweme_detail ? formatters.formatWork(data.aweme_detail) : null;
            if (w) break;
            if (attempt === 0) {
              await new Promise((r) => setTimeout(r, runtimeConfig.randomDelay("syncWorks")));
            }
          }
          if (w) allWorks.push(w);
          else { errors.push({ awemeId: awemeIds[i], error: "DELETED" }); currentOk = false; }
        } catch (e) {
          // 系统性错误（缺 Cookie/限流空 body/401/429/超时 abort）与 tab 模式共用致命分类：
          // utils.isFatalTaskError 命中即早退 + 剩余标记 BATCH_TERMINATED
          const errMsg = e && e.name === "AbortError" ? "CANCELLED" : e.message;
          if (utils.isFatalTaskError(errMsg)) {
            for (let j = i; j < awemeIds.length; j++) {
              errors.push({ awemeId: awemeIds[j], error: j === i ? errMsg : "BATCH_TERMINATED" });
            }
            currentOk = false;
            break;
          }
          errors.push({ awemeId: awemeIds[i], error: errMsg });
          currentOk = false;
        }
        utils.sendMessageSafe({
          type: "SYNC_PROGRESS",
          requestId,
          index: i,
          total: awemeIds.length,
          status: currentOk ? "ok" : "error",
          awemeId: awemeIds[i],
        });
        if (!guard.isCancelled()) {
          await utils.pauseWithKeepalive(i, "syncWorks");
        }
      }
      guard.dispose();
      if (allWorks.length > 0) {
        const result = await domainStore.mergeAndSave(CONFIG.STORAGE_KEYS.WORKS, allWorks);
        utils.sendSyncDone(requestId, {
          ok: true,
          refreshed: result.added + result.updated,
          failed: errors.length,
          failedAwemeIds: errors.map((e) => e.awemeId).filter(Boolean),
        });
      } else {
        utils.sendSyncDone(requestId, {
          ok: false,
          error: errors[0]?.error || "NO_WORKS_COLLECTED",
        });
      }
    } catch (e) {
      // ack 之后 sendResponse 通道已关闭，只能经 SYNC_DONE 消息收尾，避免弹窗卡在 SYNCING
      if (requestId) {
        utils.sendSyncDone(requestId, { ok: false, error: e.message });
      } else {
        sendResponse({ ok: false, error: e.message });
      }
    }
  }

  async fetchWorksPage(secUid, cursor, sendResponse) {
    try {
      await credentials.ensureABogus();
      const data = await independentClient.request(
        CONFIG.API.POST,
        await credentials.buildBaseParams({
          sec_user_id: secUid,
          max_cursor: String(cursor || 0),
          count: String(CONFIG.PAGE.POST),
        }),
      );
      const works = (data.aweme_list || []).map(formatters.formatWork).filter(Boolean);
      sendResponse({
        ok: true,
        works,
        hasMore: utils.hasMoreFlag(data),
        maxCursor: data.max_cursor || "",
      });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  }

  async cancel(awemeIds, kind, persistDomain, sendResponse) {
    try {
      if (!Array.isArray(awemeIds) || awemeIds.length === 0) return sendResponse({ ok: false, error: "EMPTY" });
      const { savedCookie, browserFeatures } = await chrome.storage.local.get(["savedCookie", "browserFeatures"]);
      if (!savedCookie) return sendResponse({ ok: false, error: "NO_COOKIE" });
      const key = (browserFeatures && browserFeatures.securityKey) || "";
      const ep = CONFIG.CANCEL[kind];
      if (!ep) return sendResponse({ ok: false, error: "UNKNOWN_KIND" });

      const requestId = crypto.randomUUID();
      const guard = utils.withCancelGuard();
      const errors = [];
      sendResponse({ ok: true, requestId, total: awemeIds.length });

      for (let i = 0; i < awemeIds.length && !guard.isCancelled(); i++) {
        let ok = false;
        try {
          const resp = await fetch(ep.url, {
            method: "POST",
            credentials: "include",
            referrer: ep.referrer,
            referrerPolicy: "unsafe-url",
            headers: {
              "content-type": ep.type,
              ...(key ? { "bd-ticket-guard-ree-public-key": key } : {}),
            },
            body: ep.body(awemeIds[i]),
          });
          ok = resp.ok;
        } catch (_) {}
        if (!ok) errors.push({ awemeId: awemeIds[i], error: "FAILED" });
        utils.sendMessageSafe({
          type: "CANCEL_PROGRESS",
          requestId,
          index: i,
          total: awemeIds.length,
          status: ok ? "ok" : "error",
          awemeId: awemeIds[i],
        });
        if (!guard.isCancelled() && i < awemeIds.length - 1) {
          const delayKind = kind === "collection" ? "cancelCollection" : "cancelFavorites";
          await new Promise((r) => setTimeout(r, runtimeConfig.randomDelay(delayKind)));
        }
      }
      guard.dispose();
      const failedAwemeIds = errors.map((e) => e.awemeId).filter(Boolean);
      // 移除 = 取消并删本地：远端取消成功的条目同步删除该域本地记录
      const deletedIds = await scanTasks.deleteCancelled(persistDomain, awemeIds, failedAwemeIds);
      utils.emitCancelDone(requestId, {
        ok: true,
        cancelled: guard.isCancelled(),
        refreshed: awemeIds.length - errors.length,
        failed: errors.length,
        failedAwemeIds,
        deletedIds,
      });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  }
}
const independentTasks = new IndependentTasks();

export { independentTasks };
