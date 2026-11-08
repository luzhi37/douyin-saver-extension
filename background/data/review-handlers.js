// background/data/review-handlers.js — 回顾域引用处理器
// review 表只存 { reviewId, sourceDomain, sourceId, kind, groupId, addedAt }；
// 读取时回源域 hydration，删除/移动只改引用，不触碰来源域数据。

import { CONFIG, DOMAIN_CONFIG } from "../core.js";
import { storage } from "./storage.js";

const REVIEW_STORE = CONFIG.STORAGE_KEYS.REVIEW;
const SOURCE_DOMAINS = ["works", "favorites", "collections", "followings", "candidates"];
const MAX_BATCH = 500;

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
    try {
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
    } catch (err) {
      sendResponse({ error: err.message || String(err) });
    }
  }

  // 生成新批次：默认替换（清空旧引用、保留回顾分组），append 只追加到目标分组。
  // 只存引用，不复制记录；追加按 sourceId 去重、受全局 500 条上限约束，
  // 回顾域已有其它来源域时拒绝（混域批次无法按单一卡片类型渲染）。
  // groupId 缺省/“all” 落默认「未分组」，便于在回顾域分组中继续管理
  async saveBatch(sourceDomain, sourceIds, groupId, append, sendResponse) {
    try {
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
      const buildRefs = (list) =>
        list.map((sourceId, i) => ({
          reviewId: `${batchId}:${sourceId}`,
          sourceDomain,
          sourceId,
          kind: CONFIG.AUTHOR_RECORD_DOMAINS.includes(sourceDomain) ? "authors" : "works",
          groupId: targetGroupId,
          addedAt: now - i,
        }));

      if (!append) {
        const refs = buildRefs(ids);
        await storage.clear(REVIEW_STORE);
        if (refs.length > 0) await storage.putBatch(REVIEW_STORE, refs);
        sendResponse({ ok: true, batchId, count: refs.length });
        return;
      }

      const existing = await this.#readRefs("all");
      // 回顾域任意时刻只允许单一来源域：混域批次会让 GET_REVIEW("all")/分组视图按单类型渲染失败
      const existingDomain = existing[0]?.sourceDomain;
      if (existingDomain && existingDomain !== sourceDomain) {
        sendResponse({ error: "SOURCE_DOMAIN_MISMATCH", sourceDomain: existingDomain });
        return;
      }
      const knownIds = new Set(existing.map((ref) => String(ref.sourceId)));
      const freshIds = ids.filter((id) => !knownIds.has(id));
      const room = Math.max(0, MAX_BATCH - existing.length);
      const accepted = freshIds.slice(0, room);
      const refs = buildRefs(accepted);
      if (refs.length > 0) await storage.putBatch(REVIEW_STORE, refs);
      sendResponse({
        ok: true,
        batchId,
        count: refs.length,
        full: freshIds.length > accepted.length,
      });
    } catch (err) {
      sendResponse({ error: err.message || String(err) });
    }
  }

  // 批量移除：只删回顾引用，来源域记录保留
  async deleteBySource(sourceDomain, sourceIds, sendResponse) {
    try {
      const ids = new Set((sourceIds || []).map(String));
      const refs = (await this.#readRefs("all")).filter(
        (ref) => ref.sourceDomain === sourceDomain && ids.has(String(ref.sourceId)),
      );
      if (refs.length > 0) await storage.deleteBatch(REVIEW_STORE, refs.map((r) => r.reviewId));
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ error: err.message || String(err) });
    }
  }

  // 批量移动：只改回顾引用的 groupId
  async moveBySource(sourceDomain, sourceIds, targetGroupId, sendResponse) {
    try {
      const ids = new Set((sourceIds || []).map(String));
      const refs = (await this.#readRefs("all")).filter(
        (ref) => ref.sourceDomain === sourceDomain && ids.has(String(ref.sourceId)),
      );
      const next = refs.map((ref) => ({ ...ref, groupId: targetGroupId }));
      if (next.length > 0) await storage.putBatch(REVIEW_STORE, next);
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ error: err.message || String(err) });
    }
  }
}

const reviewHandlers = new ReviewHandlers();

export { reviewHandlers };
