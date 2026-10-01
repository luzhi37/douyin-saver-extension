// background/tasks/author-works-import.js — 作者作品入库分页循环（双模共用壳）
// ScanTasks / IndependentTasks 的 importUserWorks 各自注入页取数器 fetchPage(cursor)：
//   返回 { works, hasMore, maxCursor, total }，单页失败 throw Error（message 即 lastError）。
// 循环壳统一负责：BAD_PARAMS 守卫、重叠页去重防死循环、逐页 mergeAndSave 落库、
// IMPORT_WORKS_PROGRESS 进度、随机暂停、取消守卫与收尾响应形状。STORE_CHANGED 在
// 全部批次落库完成后统一广播一次，载荷为轻量 id 集（changedIds/addedIds，options
// 经 GET_WORKS_BY_IDS 补拉记录后局部应用，不整域重载）——不可移回循环内逐页发：
// 逐页广播会让入库全程每页触发一次 UI 收口。
// 分组语义：分页结果不加工（不预置 groupId），交给 mergeWork 的 old?.groupId || w.groupId || DEFAULT 链
//（已在作品域的保留原分组、新条目落「未分组」）。

import { CONFIG, utils, runtimeConfig } from "../core.js";
import { domainStore } from "../data/domain-store.js";

// ---------- 作者作品入库循环（Tab / 独立共用） ----------
export async function runAuthorWorksImport(secUid, fetchPage, sendResponse) {
  try {
    if (!secUid) return sendResponse({ ok: false, error: "BAD_PARAMS" });
    const requestId = crypto.randomUUID();
    const guard = utils.withCancelGuard();

    const seen = new Set();
    const changedIds = [];
    const addedIdList = [];
    let collected = 0;
    let added = 0;
    let updated = 0;
    let changed = 0;
    let cursor = 0;
    let hasMore = true;
    let lastError = "";

    while (hasMore && !guard.isCancelled()) {
      let page;
      try {
        page = await fetchPage(cursor);
      } catch (e) {
        // 单页失败记入 lastError 续行收尾；首页即失败则由收尾整体报错
        lastError = e.message;
        break;
      }
      // 服务端偶发返回重叠页：去重后为空即终止，防死循环
      const newWorks = page.works.filter((w) => w && w.awemeId && !seen.has(String(w.awemeId)));
      if (newWorks.length === 0) break;
      newWorks.forEach((w) => seen.add(String(w.awemeId)));
      collected += newWorks.length;
      const result = await domainStore.mergeAndSave(CONFIG.STORAGE_KEYS.WORKS, newWorks);
      added += result.added;
      updated += result.updated;
      changed += result.changed;
      for (const w of result.written) changedIds.push(w.awemeId);
      for (const id of result.addedIds) addedIdList.push(id);
      hasMore = page.hasMore;
      cursor = page.maxCursor || cursor;
      utils.sendMessageSafe({
        type: "IMPORT_WORKS_PROGRESS",
        requestId,
        collected,
        saved: added + updated,
        total: page.total || 0,
        hasMore,
      });
      if (hasMore && !guard.isCancelled()) {
        await new Promise((r) => setTimeout(r, runtimeConfig.randomDelay("importWorks")));
      }
    }
    guard.dispose();
    // 全部批次落库完成后统一广播一次 STORE_CHANGED（取消/部分失败同样发：已落库部分
    // 需让 options 收口）。载荷只带轻量 id 集（changedIds = 实际写入记录的 id，addedIds
    // 为其中新增子集；万级 ≈ 几十 KB，规避全记录消息膨胀）——options 经 GET_WORKS_BY_IDS
    // 补拉合并后记录，走与点载荷相同的局部应用管线（头插/原地更新），不再整域重载闪烁。
    // 入库不经 DomainHandlers.save（彼处是常规落库的广播点）；一页未落（collected=0）
    // 或全部为无变化的重复入库（changed=0）时不广播——options 不该为 no-op 重载
    if (changed > 0) {
      utils.sendMessageSafe({
        type: "STORE_CHANGED",
        domain: CONFIG.STORAGE_KEYS.WORKS,
        changedIds,
        addedIds: addedIdList,
      });
    }
    if (collected === 0 && lastError) {
      sendResponse({ ok: false, error: lastError, requestId });
      return;
    }
    sendResponse({
      ok: true,
      requestId,
      collected,
      added,
      updated,
      timedOut: guard.isCancelled(),
      error: lastError || undefined,
    });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}
