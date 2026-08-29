// background/tasks/independent-tasks.js — 独立模式长任务（fetchFollowing / fetchCollection / syncWorks / fetchWorksPage / cancel）

import { CONFIG, formatters, runtimeConfig } from "../core.js";
import { credentials } from "../identity/credentials.js";
import { independentClient } from "../identity/independent-client.js";
import { domainStore } from "../data/domain-store.js";
import { scanTasks } from "./scan-tasks.js";

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
      let cancelled = false,
        hasMore = true,
        offset = 0;
      const all = [];
      const seen = new Set();
      const cancelHandler = (msg) => {
        if (msg.type === "CANCEL_ACTIVE_TASK") cancelled = true;
      };
      chrome.runtime.onMessage.addListener(cancelHandler);
      while (hasMore && !cancelled) {
        const params = { sec_user_id: secUid, count: String(CONFIG.PAGE.FOLLOWING), offset: String(offset), min_time: "0", max_time: "0", source_type: "4", gps_access: "0", address_book_access: "0", is_top: "1" };
        const data = await independentClient.request(CONFIG.API.FOLLOWING, await credentials.buildBaseParams(params));
        if (data.status_code === 0 && Array.isArray(data.followings)) {
          if (data.followings.length === 0) break;
          const newItems = data.followings.filter((item) => !seen.has(String(item.uid)));
          if (newItems.length === 0) break;
          newItems.forEach((item) => seen.add(String(item.uid)));
          all.push(...newItems.map(formatters.formatFollowing));
          hasMore = data.has_more === true || data.has_more === 1;
          if (data.total > 0 && all.length >= data.total) hasMore = false;
          offset += CONFIG.PAGE.FOLLOWING;
        } else break;
        chrome.runtime
          .sendMessage({ type: "FOLLOWING_PROGRESS", collected: all.length, hasMore, total: data.total || 0, requestId })
          .catch(() => {});
        if (hasMore && !cancelled)
          await new Promise((r) =>
            setTimeout(r, runtimeConfig.delayRange("syncFollowings").MIN + Math.random() * (runtimeConfig.delayRange("syncFollowings").MAX - runtimeConfig.delayRange("syncFollowings").MIN)),
          );
      }
      if (!cancelled && all.length > 0 && independentClient.isCalibrateEnabled()) {
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
          () => cancelled,
          requestId,
        );
      }
      chrome.runtime.onMessage.removeListener(cancelHandler);
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
      let cancelled = false,
        hasMore = true,
        cursor = 0;
      const all = [];
      const cancelHandler = (msg) => {
        if (msg.type === "CANCEL_ACTIVE_TASK") cancelled = true;
      };
      chrome.runtime.onMessage.addListener(cancelHandler);
      while (hasMore && !cancelled) {
        // 参考项目 TikTokDownloader 同端点形态：环境参数走 query，count/cursor 走 urlencoded
        // body —— 空 body 的 POST 会被服务端 Argus 以 Signature Not Found 拒绝；身份由
        // Cookie 决定，query/body 均不带 sec_user_id（参考项目同样不传）。
        const data = await independentClient.request(
          CONFIG.API.COLLECTION,
          await credentials.buildBaseParams({}),
          {
            method: "POST",
            webSign: true,
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ count: String(CONFIG.PAGE.COLLECTION), cursor: String(cursor) }).toString(),
            referrer: "https://www.douyin.com/user/self?showTab=favorite_collection",
          },
        );
        if (data.status_code === 0 && Array.isArray(data.aweme_list)) {
          if (data.aweme_list.length === 0) break;
          all.push(...data.aweme_list.map(formatters.formatWork).filter(Boolean));
          hasMore = data.has_more === true || data.has_more === 1;
          cursor = data.cursor || data.max_cursor || cursor + CONFIG.PAGE.COLLECTION;
        } else break;
        const un = all.filter((w) => w.authorFollowed === false).length;
        chrome.runtime
          .sendMessage({
            type: "COLLECTION_PROGRESS",
            collected: all.length,
            unfollowedCount: un,
            hasMore,
            total: data.total || 0,
            requestId,
          })
          .catch(() => {});
        if (hasMore && !cancelled)
          await new Promise((r) =>
            setTimeout(r, runtimeConfig.delayRange("syncFollowings").MIN + Math.random() * (runtimeConfig.delayRange("syncFollowings").MAX - runtimeConfig.delayRange("syncFollowings").MIN)),
          );
      }
      chrome.runtime.onMessage.removeListener(cancelHandler);
      const { saved, lostUids } = await scanTasks.persistScan(persist, all, cancelled);
      sendResponse({ ok: true, requestId, works: all, timedOut: cancelled, saved, lostUids });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  }

  async syncWorks(awemeIds, sendResponse) {
    if (!Array.isArray(awemeIds) || awemeIds.length === 0) return sendResponse({ ok: false, error: "EMPTY" });
    try {
      await credentials.ensureABogus();
      const requestId = crypto.randomUUID();
      let cancelled = false;
      const allWorks = [],
        errors = [];
      const cancelHandler = (msg) => {
        if (msg.type === "CANCEL_ACTIVE_TASK") cancelled = true;
      };
      chrome.runtime.onMessage.addListener(cancelHandler);
      sendResponse({ ok: true, requestId, total: awemeIds.length });
      for (let i = 0; i < awemeIds.length && !cancelled; i++) {
        let currentOk = true;
        try {
          const params = await credentials.buildBaseParams({ aweme_id: awemeIds[i], request_source: "600", origin_type: "video_page" });
          let data, w;
          for (let attempt = 0; attempt < CONFIG.SYNC.RETRY_MAX; attempt++) {
            data = await independentClient.request(CONFIG.API.DETAIL, params);
            w = data.aweme_detail ? formatters.formatWork(data.aweme_detail) : null;
            if (w) break;
            if (attempt === 0) {
              const d = runtimeConfig.delayRange("syncWorks");
              await new Promise((r) => setTimeout(r, d.MIN + Math.random() * (d.MAX - d.MIN)));
            }
          }
          if (w) allWorks.push(w);
          else { errors.push({ awemeId: awemeIds[i], error: "DELETED" }); currentOk = false; }
        } catch (e) {
          errors.push({ awemeId: awemeIds[i], error: e.message });
          currentOk = false;
        }
        chrome.runtime
          .sendMessage({
            type: "SYNC_PROGRESS",
            requestId,
            index: i,
            total: awemeIds.length,
            status: currentOk ? "ok" : "error",
            awemeId: awemeIds[i],
          })
          .catch(() => {});
        if (!cancelled) {
          const { BATCH_SIZE, BATCH_PAUSE_MIN, BATCH_PAUSE_MAX, KEEPALIVE_INTERVAL } = CONFIG.SYNC;
          if (BATCH_SIZE > 0 && (i + 1) % BATCH_SIZE === 0) {
            const deadline = Date.now() + BATCH_PAUSE_MIN + Math.random() * (BATCH_PAUSE_MAX - BATCH_PAUSE_MIN);
            while (Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, KEEPALIVE_INTERVAL));
              await chrome.storage.local.get("keepalive");
            }
          } else {
            const d = runtimeConfig.delayRange("syncWorks");
            await new Promise((r) =>
              setTimeout(r, d.MIN + Math.random() * (d.MAX - d.MIN)),
            );
          }
        }
      }
      chrome.runtime.onMessage.removeListener(cancelHandler);
      if (allWorks.length > 0) {
        const result = await domainStore.mergeAndSave(CONFIG.STORAGE_KEYS.WORKS, allWorks);
        chrome.runtime
          .sendMessage({
            type: "SYNC_DONE",
            requestId,
            ok: true,
            refreshed: result.added + result.updated,
            failed: errors.length,
            failedAwemeIds: errors.map((e) => e.awemeId).filter(Boolean),
          })
          .catch(() => {});
      } else {
        chrome.runtime
          .sendMessage({ type: "SYNC_DONE", requestId, ok: false, error: errors[0]?.error || "NO_WORKS_COLLECTED" })
          .catch(() => {});
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
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
          count: String(CONFIG.PAGE.AUTHOR),
        }),
      );
      const works = (data.aweme_list || []).map(formatters.formatWork).filter(Boolean);
      sendResponse({
        ok: true,
        works,
        hasMore: data.has_more === true || data.has_more === 1,
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
      let cancelled = false;
      const errors = [];
      const cancelHandler = (msg) => {
        if (msg.type === "CANCEL_ACTIVE_TASK") cancelled = true;
      };
      chrome.runtime.onMessage.addListener(cancelHandler);
      sendResponse({ ok: true, requestId, total: awemeIds.length });

      for (let i = 0; i < awemeIds.length && !cancelled; i++) {
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
        chrome.runtime
          .sendMessage({
            type: "CANCEL_PROGRESS",
            requestId,
            index: i,
            total: awemeIds.length,
            status: ok ? "ok" : "error",
            awemeId: awemeIds[i],
          })
          .catch(() => {});
        if (!cancelled && i < awemeIds.length - 1) {
          const delayKind = kind === "collection" ? "cancelCollection" : "cancelLike";
          const d = runtimeConfig.delayRange(delayKind);
          await new Promise((r) =>
            setTimeout(r, d.MIN + Math.random() * (d.MAX - d.MIN)),
          );
        }
      }
      chrome.runtime.onMessage.removeListener(cancelHandler);
      const failedAwemeIds = errors.map((e) => e.awemeId).filter(Boolean);
      // 移除 = 取消并删本地：远端取消成功的条目同步删除该域本地记录
      const deletedIds = await scanTasks.deleteCancelled(persistDomain, awemeIds, failedAwemeIds);
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
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  }
}
const independentTasks = new IndependentTasks();

export { independentTasks };
