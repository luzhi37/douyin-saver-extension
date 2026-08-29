// background/data/domain-handlers.js — 域数据操作入口（4 实例：works/followings/likes/favorites）

import { CONFIG, DOMAIN_CONFIG } from "../core.js";
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

  async get(groupId, sendResponse) {
    try {
      let list;
      if (groupId && groupId !== "all") {
        const store = await storage.getByIndex(this.#cfg.storeName, "groupId", groupId);
        list = Object.values(store);
      } else {
        const store = await storage.getAll(this.#cfg.storeName);
        list = Object.values(store);
      }
      list.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
      sendResponse({ [this.#cfg.itemKey]: list });
    } catch (err) {
      sendResponse({ error: err.message });
    }
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
    sendResponse({ ok: true, ...result, invalid });
  }

  async #saveFollowings(items, isImport, sendResponse) {
    const result = await domainStore.mergeAndSaveFollowings(this.#domain, items, isImport);
    sendResponse({ ok: true, ...result });
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
}
const worksHandlers = new DomainHandlers(CONFIG.STORAGE_KEYS.WORKS);
const followingsHandlers = new DomainHandlers(CONFIG.STORAGE_KEYS.FOLLOWINGS);
const likesHandlers = new DomainHandlers(CONFIG.STORAGE_KEYS.LIKES);
const favoritesHandlers = new DomainHandlers(CONFIG.STORAGE_KEYS.FAVORITES);

export { worksHandlers, followingsHandlers, likesHandlers, favoritesHandlers };
