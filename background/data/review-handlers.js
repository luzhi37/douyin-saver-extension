// background/data/review-handlers.js — 回顾域引用处理器
// review 表只存 { reviewId, sourceDomain, sourceId, kind, groupId, addedAt }；
// 读取时回源域 hydration，删除/移动只改引用，不触碰来源域数据。
// 错误响应由路由层 asyncHandler 统一收口，处理器不自包装

import { CONFIG, DOMAIN_CONFIG } from "../core.js";
import { storage } from "./storage.js";
import { REVIEW_MAX_COUNT } from "../../shared/limits.js";
import { SOURCE_DOMAINS, isAuthorDomain } from "../../shared/domains.js";

const REVIEW_STORE = CONFIG.STORAGE_KEYS.REVIEW;
const MAX_BATCH = REVIEW_MAX_COUNT;

class ReviewHandlers {
  async #readRefs(groupId) {
    if (groupId && groupId !== "all") {
      const map = await storage.getByIndex(REVIEW_STORE, "groupId", groupId);
      return Object.values(map);
    }
    const map = await storage.getAll(REVIEW_STORE);
    return Object.values(map);
  }

  // 读取回顾批次：按组过滤 → 回源域取完整记录 → 叠加回顾域的 groupId/排序字段。
  // 来源记录已删除的引用视为失效并清理（只删引用，来源域不受影响）。
  async get(groupId, sendResponse) {
    const refs = await this.#readRefs(groupId);
    refs.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0) || String(b.reviewId).localeCompare(String(a.reviewId)));
    // 组内为空时仍从全批次取 sourceDomain/kind，保证空分组也按正确卡片类型渲染
    const metaRefs =
      refs.length === 0 && groupId && groupId !== "all"
        ? Object.values(await storage.getAll(REVIEW_STORE))
        : refs;
    const sourceDomain = metaRefs[0]?.sourceDomain || null;
    const kind = metaRefs[0]?.kind || null;
    const groups = new Map();
    for (const ref of refs) {
      if (!groups.has(ref.sourceDomain)) groups.set(ref.sourceDomain, []);
      groups.get(ref.sourceDomain).push(ref);
    }

    const items = [];
    const staleReviewIds = [];
    for (const [domain, domainRefs] of groups) {
      const cfg = DOMAIN_CONFIG[domain];
      if (!cfg) {
        staleReviewIds.push(...domainRefs.map((r) => r.reviewId));
        continue;
      }
      const sourceRecords = await storage.getBatch(cfg.storeName, domainRefs.map((r) => r.sourceId));
      const bySourceId = new Map();
      for (const record of sourceRecords) {
        if (record) bySourceId.set(String(record[cfg.idField]), record);
      }
      for (const ref of domainRefs) {
        const record = bySourceId.get(String(ref.sourceId));
        if (!record) {
          staleReviewIds.push(ref.reviewId);
          continue;
        }
        items.push({
          ...record,
          reviewId: ref.reviewId,
          sourceDomain: ref.sourceDomain,
          sourceId: ref.sourceId,
          groupId: ref.groupId,
          savedAt: ref.addedAt || record.savedAt || 0,
          reviewAddedAt: ref.addedAt || 0,
        });
      }
    }
    if (staleReviewIds.length > 0) await storage.deleteBatch(REVIEW_STORE, staleReviewIds);

    items.sort((a, b) => b.reviewAddedAt - a.reviewAddedAt);
    sendResponse({ ok: true, reviewItems: items, sourceDomain, kind, total: items.length });
  }

  // 生成新批次：清空旧引用后整批替换（保留回顾分组）。
  // 只存引用，不复制记录；groupId 缺省/“all” 落默认「未分组」，便于在回顾域分组中继续管理
  async saveBatch(sourceDomain, sourceIds, groupId, sendResponse) {
    if (!SOURCE_DOMAINS.includes(sourceDomain)) {
      sendResponse({ error: "BAD_DOMAIN" });
      return;
    }
    const ids = (Array.isArray(sourceIds) ? sourceIds : [])
      .map((id) => String(id))
      .slice(0, MAX_BATCH);
    const batchId = crypto.randomUUID();
    const now = Date.now();
    const targetGroupId = groupId && groupId !== "all" ? groupId : CONFIG.GROUPS.DEFAULT_ID;
    const refs = ids.map((sourceId, i) => ({
      reviewId: `${batchId}:${sourceId}`,
      sourceDomain,
      sourceId,
      kind: isAuthorDomain(sourceDomain) ? "authors" : "works",
      groupId: targetGroupId,
      addedAt: now - i,
    }));
    await storage.clear(REVIEW_STORE);
    if (refs.length > 0) await storage.putBatch(REVIEW_STORE, refs);
    sendResponse({ ok: true, batchId, count: refs.length });
  }

  // 批量移除：只删回顾引用，来源域记录保留
  async deleteBySource(sourceDomain, sourceIds, sendResponse) {
    const ids = new Set((sourceIds || []).map(String));
    const refs = (await this.#readRefs("all")).filter(
      (ref) => ref.sourceDomain === sourceDomain && ids.has(String(ref.sourceId)),
    );
    if (refs.length > 0) await storage.deleteBatch(REVIEW_STORE, refs.map((r) => r.reviewId));
    sendResponse({ ok: true });
  }

  // 批量移动：只改回顾引用的 groupId
  async moveBySource(sourceDomain, sourceIds, targetGroupId, sendResponse) {
    const ids = new Set((sourceIds || []).map(String));
    const refs = (await this.#readRefs("all")).filter(
      (ref) => ref.sourceDomain === sourceDomain && ids.has(String(ref.sourceId)),
    );
    const next = refs.map((ref) => ({ ...ref, groupId: targetGroupId }));
    if (next.length > 0) await storage.putBatch(REVIEW_STORE, next);
    sendResponse({ ok: true });
  }
}

const reviewHandlers = new ReviewHandlers();

export { reviewHandlers };
