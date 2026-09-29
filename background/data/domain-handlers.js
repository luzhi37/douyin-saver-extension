// background/data/domain-handlers.js — 域数据操作入口（4 实例：works/followings/likes/favorites）

import { CONFIG, DOMAIN_CONFIG, utils } from "../core.js";
import { storage } from "./storage.js";
import { domainStore } from "./domain-store.js";

// ---------- DomainHandlers ----------
// 域数据操作的对外入口；save 已改域驱动（决策 8），闭合 likes/favorites 断路缺陷。
class DomainHandlers {
  #cfg;
  #domain;

  constructor(domain) {
    this.#cfg = DOMAIN_CONFIG[domain];
    this.#domain = domain;
  }

  // page=0 = 渐进加载首页；cursor = keyset 续页（上页末条索引键，开区间上界）；
  // 两者皆无 = 一次性全量（loadWorks 同步清单/重试路径，语义不变）。
  // 分页每次只物化 PAGE.GRID 条记录（v3 复合索引 savedAt_id / groupId_savedAt_id），
  // 不再全量读取+排序——万级分组的首页响应从数百毫秒降到几十毫秒
  async get(groupId, sendResponse, page, cursor) {
    try {
      if (page === 0 || cursor) {
        sendResponse(await this.#readPaged(groupId, cursor || null));
        return;
      }
      // 分组筛选走索引查询，否则全量读取；两分支随后同一排序/返回
      const store =
        groupId && groupId !== "all"
          ? await storage.getByIndex(this.#cfg.storeName, "groupId", groupId)
          : await storage.getAll(this.#cfg.storeName);
      const list = Object.values(store);
      list.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
      sendResponse({ [this.#cfg.itemKey]: list });
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }

  // keyset 翻页：组内走 groupId_savedAt_id（键 = [groupId, savedAt, awemeId]）、
  // 「全部」走 savedAt_id（键 = [savedAt, awemeId]），prev 方向即 savedAt 降序。
  // 首页上界 [groupId, Infinity] 恰好罩住本组（Infinity 是合法 IDB 数值键且 savedAt
  // 恒有限）；续页以上页末键为开区间上界——索引键含主键全序唯一，同 savedAt 平级
  // 记录不丢失，并发增删不产生页间位移/重复
  async #readPaged(groupId, cursor) {
    const byGroup = Boolean(groupId && groupId !== "all");
    const indexName = byGroup ? "groupId_savedAt_id" : "savedAt_id";
    let range;
    if (byGroup) {
      range = cursor
        ? IDBKeyRange.bound([groupId], cursor, false, true)
        : IDBKeyRange.bound([groupId], [groupId, Infinity]);
    } else {
      range = cursor ? IDBKeyRange.upperBound(cursor, true) : null;
    }
    const { items, hasMore, lastKey } = await storage.readIndexPage(
      this.#cfg.storeName,
      indexName,
      range,
      CONFIG.PAGE.GRID,
    );
    const result = { [this.#cfg.itemKey]: items, hasMore, nextCursor: hasMore ? lastKey : null };
    if (!cursor) {
      // 首页附带 total：options 侧按它一次预铺全量骨架（余页按槽回填），需与分页读同一域
      result.total = byGroup
        ? await storage.countByIndex(this.#cfg.storeName, "groupId", groupId)
        : await storage.count(this.#cfg.storeName);
    }
    return result;
  }

  async delete(ids, sendResponse) {
    try {
      const keys = ids.map((id) => domainStore.toStorageId(this.#domain, id));
      await storage.deleteBatch(this.#cfg.storeName, keys);
      const remaining = await storage.count(this.#cfg.storeName);
      sendResponse({ ok: true, remaining });
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }

  async move(ids, targetGroupId, sendResponse) {
    try {
      const keys = ids.map((id) => domainStore.toStorageId(this.#domain, id));
      const items = await Promise.all(keys.map((k) => storage.get(this.#cfg.storeName, k)));
      const toWrite = items.filter(Boolean).map((item) => ({ ...item, groupId: targetGroupId }));
      if (toWrite.length > 0) await storage.putBatch(this.#cfg.storeName, toWrite);
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }

  // save 必须域驱动：works/likes/favorites → domainStore.mergeAndSave；followings → #saveFollowings
  async save(items, sendResponse, isImport = false) {
    if (this.#domain === CONFIG.STORAGE_KEYS.FOLLOWINGS) return this.#saveFollowings(items, isImport, sendResponse);
    const result = await domainStore.mergeAndSave(this.#domain, items);
    const idField = DOMAIN_CONFIG[this.#domain].idField;
    const invalid = (items || []).filter((w) => !w || !w[idField]).length;
    // 内容真有变化才广播：重复添加已有且字段全等的作品是 no-op，不该让 options 重载网格。
    // 变化条数少于阈值时携带合并后记录（upserts/addedIds），options 局部应用——单发保存
    // （抖音标签页「保存」按钮）的真实变化从整网重载降为 O(1)；批量变化仍发无载荷广播整刷收口
    if (result.changed > 0) this.#broadcastStoreChanged(result.written, result.addedIds);
    const { written, addedIds, ...counts } = result;
    sendResponse({ ok: true, ...counts, invalid });
  }

  async #saveFollowings(items, isImport, sendResponse) {
    const result = await domainStore.mergeAndSaveFollowings(this.#domain, items, isImport);
    // followings 不走点载荷：网格无单卡更新原语，且关注变化低频，整刷成本可接受
    if (result.changed > 0) this.#broadcastStoreChanged();
    sendResponse({ ok: true, ...result });
  }

  // 落库成功后广播存储变更（发送方可能是抖音标签页等外部上下文，options 页不在
  // 请求链路上）：changed ≤ BROADCAST.UPSERTS_MAX 时附带合并后记录与新增 id 集合供
  // options 局部应用，超过则发无载荷广播走整刷。无接收方时 sendMessageSafe 静默吞掉
  #broadcastStoreChanged(written = [], addedIds = []) {
    const message = { type: "STORE_CHANGED", domain: this.#domain };
    if (written.length > 0 && written.length <= CONFIG.BROADCAST.UPSERTS_MAX) {
      message.upserts = written;
      message.addedIds = addedIds;
    }
    utils.sendMessageSafe(message);
  }

  async getOne(id, sendResponse) {
    try {
      const ds = domainStore.facade(this.#domain);
      const item = await ds.get(id);
      sendResponse({ work: item || null });
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }

  // 按 id 集合直取记录（IDB 主键 Promise.all）：bulk STORE_CHANGED 收口的补拉通道——
  // 广播只携带轻量 id 列表（万级 ≈ 几十 KB，规避全记录消息膨胀），options 据此拉取
  // 合并后记录，走与点载荷相同的局部应用管线，替代整域重载
  async getByIds(ids, sendResponse) {
    try {
      const keys = (ids || []).map((id) => domainStore.toStorageId(this.#domain, id));
      const items = await Promise.all(keys.map((k) => storage.get(this.#cfg.storeName, k)));
      sendResponse({ items: items.filter(Boolean) });
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }
}
const worksHandlers = new DomainHandlers(CONFIG.STORAGE_KEYS.WORKS);
const followingsHandlers = new DomainHandlers(CONFIG.STORAGE_KEYS.FOLLOWINGS);
const likesHandlers = new DomainHandlers(CONFIG.STORAGE_KEYS.LIKES);
const favoritesHandlers = new DomainHandlers(CONFIG.STORAGE_KEYS.FAVORITES);

export { worksHandlers, followingsHandlers, likesHandlers, favoritesHandlers };
