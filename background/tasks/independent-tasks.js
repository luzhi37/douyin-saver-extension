// background/tasks/independent-tasks.js — 独立模式长任务（fetchFollowing / fetchCollection / syncWorks / fetchWorksPage / importUserWorks / cancel）

import { CONFIG, formatters, utils, runtimeConfig } from "../core.js";
import { credentials } from "../identity/credentials.js";
import { independentClient } from "../identity/independent-client.js";
import {
  createScanWriter,
  runSyncWorks,
  runCancelTask,
  startScanTask,
  makeScanReporter,
  finishScanTask,
} from "./scan-tasks.js";
import { taskRegistry } from "./task-registry.js";
import { runAuthorWorksImport } from "./author-works-import.js";
import { tabUrl } from "../../shared/douyin-urls.js";

// ---------- IndependentTasks ----------
// 独立模式长任务（经 IndependentClient.request 直连循环）
class IndependentTasks {
  // 关注同步（独立）：分块确认写 + 终态结论（与 Tab 模式同一 createScanWriter 落库器），
  // 循环壳/收尾见 runIndependentScan。关注列表归属由 Cookie 决定（与收藏扫描同款）：仅传
  // sec_user_id 标识目标，不额外附带 user_id——user_id 从 uid cookie 取第一个值，存在
  // 多账号/过期 cookie 时可能与当前会话 uid 不一致，私密账户会据此判定为「他人查看」
  // 而返回 2096（errorMap 映射为明确错误）。"self" 前置解析见 preflight。
  fetchFollowing(secUid, sendResponse, taskId) {
    const seen = new Set(); // 服务端重叠页去重：整页重复即去重完尽，构成完整扫描结论
    return runIndependentScan({
      taskId,
      kind: "syncFollowings",
      delayKind: "syncFollowings",
      domain: CONFIG.STORAGE_KEYS.FOLLOWINGS,
      shape: "followings",
      totalFallback: true,
      sendResponse,
      preflight: async () => {
        if (secUid === "self" || !secUid) {
          const { secUid: stored } = await chrome.storage.local.get("secUid");
          secUid = stored && stored !== "self" ? stored : (await independentClient.resolveSelfSecUid()) || "";
          if (!secUid) throw new Error("NO_SEC_UID");
        }
      },
      buildRequest: async (offset) => ({
        api: CONFIG.API.FOLLOWING,
        params: await credentials.buildBaseParams({
          sec_user_id: secUid,
          count: String(CONFIG.PAGE.FOLLOWING),
          offset: String(offset),
          min_time: "0", max_time: "0", source_type: "4",
          gps_access: "0", address_book_access: "0", is_top: "1",
        }),
      }),
      parsePage: (data, offset, writer) => {
        if (!(data.status_code === 0 && Array.isArray(data.followings))) return null;
        // seen 以原始 uid 标记（旧实现口径）；格式化过滤后计数——earlyStop 用
        // 「writer.collected + 本页有效新增」与旧循环「加完再判」同口径
        const newRaw = data.followings.filter((item) => !seen.has(String(item.uid)));
        newRaw.forEach((item) => seen.add(String(item.uid)));
        const newItems = newRaw.map(formatters.formatFollowing).filter((f) => f && f.uid);
        const total = Number(data.total) || 0;
        // collected + 本页新增 ≥ total 早停（与旧循环「加完再判」同口径）
        const earlyStop = total > 0 && writer.collected + newItems.length >= total;
        return {
          items: newItems,
          hasMore: newItems.length > 0 && utils.hasMoreFlag(data) && !earlyStop,
          cursor: offset + CONFIG.PAGE.FOLLOWING,
          total,
        };
      },
      // 2096 = 目标账号关注列表因隐私设置不可见；独立模式同步「我的关注」时若
      // sec_uid 解析为其他账号即会触发，给出明确错误而非通用 API_ERROR
      errorMap: (e) => (e.statusCode === 2096 ? "FOLLOWING_LIST_PRIVATE" : e.message),
    });
  }

  // 收藏扫描（独立）：分块确认写 + 终态结论（与 Tab 模式 #paginate 同一 createScanWriter
  // 落库器），循环壳/收尾见 runIndependentScan。参考项目 TikTokDownloader 同端点形态：
  // 环境参数走 query，count/cursor 走 urlencoded body——空 body 的 POST 会被服务端 Argus
  // 以 Signature Not Found 拒绝；身份由 Cookie 决定，query/body 均不带 sec_user_id。
  fetchCollection(persist, sendResponse, taskId) {
    return runIndependentScan({
      taskId,
      kind: "scanCollections",
      delayKind: "syncCollection",
      domain: persist,
      shape: "works",
      sendResponse,
      buildRequest: async (cursor) => ({
        api: CONFIG.API.COLLECTION,
        params: await credentials.buildBaseParams({}),
        init: {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ count: String(CONFIG.PAGE.COLLECTION), cursor: String(cursor) }).toString(),
          referrer: tabUrl("collections"),
        },
      }),
      parsePage: (data, cursor) => {
        if (!(data.status_code === 0 && Array.isArray(data.aweme_list))) return null;
        const items = data.aweme_list.map(formatters.formatWork).filter((w) => w && w.awemeId);
        // 空页自然收尾同样构成完整结论（丢失检测仅完整扫描执行）
        return {
          items,
          hasMore: items.length > 0 && utils.hasMoreFlag(data),
          cursor: data.cursor || data.max_cursor || cursor + CONFIG.PAGE.COLLECTION,
          total: Number(data.total) || 0,
        };
      },
    });
  }

  // 作者作品批量入库（独立模式）：aweme/post 取页器 + runAuthorWorksImport 共用循环壳。
  // 语义与 Tab 模式 importUserWorks 一致：无丢失检测、每页即落库、分页结果不预置 groupId
  //（已在作品域的保留原分组、新条目落「未分组」）；单页请求失败记入 lastError 续行收尾，
  // 首页即失败才整体报错
  async importUserWorks(secUid, sendResponse, taskId) {
    if (!secUid) return sendResponse({ ok: false, error: "BAD_PARAMS" });
    try {
      await credentials.ensureABogus();
    } catch (e) {
      return sendResponse({ ok: false, error: e.message });
    }
    return runAuthorWorksImport(
      secUid,
      async (cursor, isCancelled) => {
        const data = await independentClient.request(
          CONFIG.API.POST,
          await credentials.buildBaseParams({
            sec_user_id: secUid,
            max_cursor: String(cursor || 0),
            count: String(CONFIG.PAGE.POST),
          }),
          { gatePriority: 1, isCancelled },
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
      taskId,
      "independent",
    );
  }

  async syncWorks(awemeIds, sendResponse, taskId = null) {
    return runSyncWorks({
      mode: "independent",
      awemeIds,
      sendResponse,
      taskId,
      preflight: () => credentials.ensureABogus(),
      // 详情响应缺 aweme_detail 计一条失败；RETRY_MAX 内隔一次随机延迟重试
      fetchOne: async (awemeId, isCancelled) => {
        const params = await credentials.buildBaseParams({
          aweme_id: awemeId,
          request_source: "600",
          origin_type: "video_page",
        });
        let w = null;
        for (let attempt = 0; attempt < CONFIG.SYNC.RETRY_MAX; attempt++) {
          const data = await independentClient.request(CONFIG.API.DETAIL, params, {
            gatePriority: 1,
            gateInterval: runtimeConfig.randomDelay("syncWorks"),
            isCancelled,
          });
          w = data.aweme_detail ? formatters.formatWork(data.aweme_detail) : null;
          if (w) break;
          if (attempt === 0) {
            await new Promise((r) => setTimeout(r, runtimeConfig.randomDelay("syncWorks")));
          }
        }
        return { work: w };
      },
    });
  }

  async fetchWorksPage(secUid, cursor, sendResponse, gateOpts = null) {
    try {
      await credentials.ensureABogus();
      const data = await independentClient.request(
        CONFIG.API.POST,
        await credentials.buildBaseParams({
          sec_user_id: secUid,
          max_cursor: String(cursor || 0),
          count: String(CONFIG.PAGE.POST),
        }),
        gateOpts || undefined,
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

  // 收藏端点鉴权：savedCookie 门禁 + ticket-guard 公钥（凭据走 credentials 内存镜像）
  async #collectionAuth() {
    const savedCookie = await credentials.getSavedCookie();
    if (!savedCookie) return { ok: false, error: "NO_COOKIE" };
    const bf = await credentials.getFeatures();
    return { ok: true, key: (bf && bf.securityKey) || "" };
  }

  // 收藏端点 POST 单一实现：active=false 取消、true 收藏；单作品切换与批量取消共用
  async #postCollectionAction(awemeId, active, key) {
    try {
      const ep = CONFIG.CANCEL.collection;
      const resp = await fetch(ep.url, {
        method: "POST",
        credentials: "include",
        referrer: ep.referrer,
        referrerPolicy: "unsafe-url",
        headers: {
          "content-type": ep.type,
          ...(key ? { "bd-ticket-guard-ree-public-key": key } : {}),
        },
        body: ep.body(awemeId, active === true),
      });
      return resp.ok ? { ok: true } : { ok: false, error: "HTTP_" + resp.status };
    } catch (e) {
      return { ok: false, error: e.message || "NETWORK_ERROR" };
    }
  }

  // 侧边栏卡片单作品收藏/取消收藏（独立模式）：与批量取消同一 collect 端点，
  // action 由 active 决定；本地域落库/删除由路由层收口（点赞无独立分支，路由层拒绝）
  async setReaction(awemeId, active) {
    if (!awemeId) return { ok: false, error: "EMPTY" };
    const auth = await this.#collectionAuth();
    if (!auth.ok) return auth;
    return this.#postCollectionAction(awemeId, active, auth.key);
  }

  // 批量「取消并移除」（独立）：任务坞统一生命周期，终态走 TASK_DONE；循环壳/分块确认删
  // 见 runCancelTask（与 Tab 模式共用）。鉴权在启动前完成（失败直接 ack 错误，不登记任务）
  async cancel(awemeIds, persistDomain, sendResponse, taskId) {
    if (!Array.isArray(awemeIds) || awemeIds.length === 0) return sendResponse({ ok: false, error: "EMPTY" });
    let auth;
    try {
      auth = await this.#collectionAuth();
    } catch (e) {
      return sendResponse({ ok: false, error: e.message });
    }
    if (!auth.ok) return sendResponse(auth);
    return runCancelTask({
      mode: "independent",
      awemeIds,
      kind: "cancelCollections",
      domain: persistDomain,
      sendResponse,
      taskId,
      cancelOne: (awemeId) => this.#postCollectionAction(awemeId, false, auth.key),
    });
  }
}
const independentTasks = new IndependentTasks();

// ---------- 独立模式扫描族共用循环壳（fetchFollowing / fetchCollection） ----------
// 任务坞统一生命周期与 Tab 模式 #paginate 同构：start（全局单飞）→ 立即 ack → 键集快照 →
// ensureABogus → preflight → while { checkpoint(onSuspend 冲刷) → request → parse →
// writer.add → report → 延迟 } → finishScanTask。差异收敛在三个注入点：
// - preflight(): secUid "self" 解析等前置（可抛；异常经 errorMap 归一后走失败收尾）
// - buildRequest(pageVar): 返回 { api, params, init? }，init 并入请求选项
//   （gatePriority/isCancelled 由壳固定，init 不可覆盖）
// - parsePage(data, pageVar, writer): 返回 { items(已格式化且主键齐), hasMore, cursor, total }
//   | null（null = 坏响应记 FETCH_FAILED）；空页/去重完尽/total 早停一律折算成 hasMore:false
//   ——与旧实现「break 即完整结论（不出丢失结论）」同口径
async function runIndependentScan({ taskId, kind, delayKind, domain, shape, totalFallback = false, sendResponse, preflight = null, buildRequest, parsePage, errorMap = null }) {
  const task = await startScanTask({ taskId, kind, mode: "independent", domain, sendResponse });
  if (!task) return sendResponse({ ok: false, error: "QUEUE_FULL" });
  const requestId = task.taskId;
  const isCancelled = () => taskRegistry.isCancelled(requestId);
  const writer = createScanWriter(domain);
  let hasMore = true, pageVar = 0, total = 0, lastError = "";
  const report = makeScanReporter(requestId, task, kind, domain, writer);
  try {
    // 键集快照在 try 内取（IDB 异常走 catch 收尾，防 RUNNING 泄漏卡死 isBusy 门禁）
    await writer.snapshot();
    await credentials.ensureABogus();
    if (preflight) await preflight();
    while (hasMore && !isCancelled()) {
      // 队列接入点 2：暂停请求在此让出（挂起前冲刷当前块）
      await taskRegistry.checkpoint(requestId, { onSuspend: () => writer.flush() });
      if (isCancelled()) break;
      const { api, params, init = {} } = await buildRequest(pageVar);
      const data = await independentClient.request(api, params, { gatePriority: 1, isCancelled, ...init });
      if (isCancelled()) break;
      const page = parsePage(data, pageVar, writer);
      if (!page) {
        // 坏响应与 Tab 模式同口径：记错误并以 failed 收尾，禁止静默 break 后带着
        // 部分数据走完整扫描的结论写（部分拉取误算 lostUids 已定案废除）
        lastError = "FETCH_FAILED";
        break;
      }
      for (const item of page.items) await writer.add(item);
      hasMore = page.hasMore;
      pageVar = page.cursor;
      total = page.total;
      report(total, hasMore);
      if (hasMore && !isCancelled()) {
        await new Promise((r) => setTimeout(r, runtimeConfig.randomDelay(delayKind)));
      }
    }
    return finishScanTask({ requestId, task, kind, domain, writer, lastError, total, totalFallback, shape });
  } catch (e) {
    // 异常路径同样冲刷已抓部分（真实数据无假结论），残差与取消同口径
    return finishScanTask({
      requestId, task, kind, domain, writer,
      lastError: errorMap ? errorMap(e) : e.message, total, totalFallback, shape,
    });
  }
}

export { independentTasks };
