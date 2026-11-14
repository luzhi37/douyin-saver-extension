// background/tasks/author-works-import.js — 作者作品入库分页循环（双模共用壳）
// ScanTasks / IndependentTasks 的 importUserWorks 各自注入页取数器 fetchPage(cursor)：
//   返回 { works, hasMore, maxCursor, total }，单页失败 throw Error（message 即 lastError）。
// 循环壳统一负责：BAD_PARAMS 守卫、重叠页去重防死循环、分块确认写落库、
// TASK_PROGRESS 进度、随机暂停、取消守卫与 TASK_DONE 收尾。落库向扫描族看齐（三族统一）：
// 页结果进缓冲、满 SYNC.SCAN_CHUNK 条单事务 mergeAndSave（静默），暂停 onSuspend /
// 终态 / 异常三处冲刷余块，已落库部分不回滚。STORE_CHANGED 仅终态一次裸载荷
//（changed>0 才发，不带 id 集，options 整域重载收口）——不可移回循环内逐页发。
// 分组语义：分页结果不加工（不预置 groupId），交给 mergeWork 的 old?.groupId || w.groupId || DEFAULT 链
//（已在作品域的保留原分组、新条目落「未分组」）。

import { CONFIG, utils, runtimeConfig } from "../core.js";
import { domainStore } from "../data/domain-store.js";
import { taskRegistry } from "./task-registry.js";

// ---------- 作者作品入库循环（Tab / 独立共用） ----------
export async function runAuthorWorksImport(secUid, fetchPage, sendResponse, taskId, mode) {
  if (!secUid) return sendResponse({ ok: false, error: "BAD_PARAMS" });
  const domain = CONFIG.STORAGE_KEYS.WORKS;
  const task = taskRegistry.start({
    taskId, kind: "importWorks", mode, domain, total: 0,
  });
  if (!task) return sendResponse({ ok: false, error: "QUEUE_FULL" });
  const requestId = task.taskId;
  const isCancelled = () => taskRegistry.isCancelled(requestId);
  sendResponse({ ok: true, requestId, taskId: requestId, total: 0, status: task.status });
  // 队列接入点 1：排队/暂停时在此挂起
  await taskRegistry.waitForTurn(requestId);

  const seen = new Set();
  const pending = []; // 待写缓冲（满 SYNC.SCAN_CHUNK 条单事务 mergeAndSave，flush 即释放）
  let collected = 0, added = 0, updated = 0, changed = 0;
  let cursor = 0, hasMore = true, total = 0, lastError = "";
  const report = () => {
    taskRegistry.update(requestId, { processed: collected, total, changed });
    utils.emitTaskProgress(requestId, {
      kind: "importWorks", domain, processed: collected, collected,
      savedCount: added + updated, total, hasMore,
      elapsed: Date.now() - task.startedAt,
    });
  };
  const done = (status, error = "") => {
    taskRegistry.finish(requestId, { status, error });
    utils.emitTaskDone(requestId, {
      kind: "importWorks", domain, ok: status !== "failed",
      cancelled: status === "cancelled", timedOut: status === "cancelled",
      error, processed: collected, collected, total,
      elapsed: Date.now() - task.startedAt,
      added, updated, changed,
    });
  };
  // 分块确认写（与扫描族 createScanWriter 同构）：满 SYNC.SCAN_CHUNK 条单事务
  // mergeAndSave（静默，无 stamps——savedAt 旧值优先语义与旧逐页口径一致）
  const flush = async () => {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    const result = await domainStore.mergeAndSave(CONFIG.STORAGE_KEYS.WORKS, batch);
    added += result.added;
    updated += result.updated;
    changed += result.changed;
  };
  try {
    while (hasMore && !isCancelled()) {
      // 队列接入点 2：暂停请求在此让出（挂起前冲刷待写块，与扫描族 checkpoint 同口径）
      await taskRegistry.checkpoint(requestId, { onSuspend: () => flush() });
      if (isCancelled()) break;
      let page;
      try {
        page = await fetchPage(cursor, isCancelled);
      } catch (e) {
        // 单页失败记入 lastError 续行收尾；首页即失败则由收尾整体报错
        lastError = e.message;
        break;
      }
      if (isCancelled()) break;
      // 服务端偶发返回重叠页：去重后为空即终止，防死循环
      const newWorks = page.works.filter((w) => w && w.awemeId && !seen.has(String(w.awemeId)));
      if (newWorks.length === 0) break;
      newWorks.forEach((w) => seen.add(String(w.awemeId)));
      collected += newWorks.length;
      pending.push(...newWorks);
      if (pending.length >= CONFIG.SYNC.SCAN_CHUNK) await flush();
      hasMore = page.hasMore;
      total = Number(page.total) || 0;
      cursor = page.maxCursor || cursor;
      report();
      if (hasMore && !isCancelled()) {
        await new Promise((r) => setTimeout(r, runtimeConfig.randomDelay("importWorks")));
      }
    }
    // 终态冲刷余块（取消/部分失败同样保留已落库部分）；STORE_CHANGED 仅终态一次裸载荷
    //（三族统一：不带 id 集，options 整域重载收口）。入库不经 DomainHandlers.save
    //（彼处是常规落库的广播点）；changed=0（一页未落或全部为无变化重复入库）不广播
    //——options 不该为 no-op 重载
    await flush();
    if (changed > 0) {
      utils.sendMessageSafe({ type: "STORE_CHANGED", domain });
    }
    if (collected === 0 && lastError) return done("failed", lastError);
    return done(isCancelled() ? "cancelled" : "done");
  } catch (err) {
    // 异常路径同样冲刷已抓部分（真实数据无假结论，不回滚），残差与取消同口径
    await flush().catch(() => {});
    if (changed > 0) utils.sendMessageSafe({ type: "STORE_CHANGED", domain });
    return done("failed", err.message);
  }
}
