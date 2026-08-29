// background/data/data-tools.js — 导入导出 / 重置 / 统计（reconcileImportGroups）

import { CONFIG, DOMAIN_CONFIG } from "../core.js";
import { storage } from "./storage.js";
import { domainStore } from "./domain-store.js";

// ---------- DataTools ----------
// 导入导出 / 重置 / 统计（域感知）
class DataTools {
  async reconcileImportGroups(domain, data, items) {
    const importedGroups = data.groups || [];
    if (importedGroups.length === 0) return;
    const groupsName = domainStore.groupsName(domain);
    const def = domainStore.defaultGroups(domain);
    const existingList = await storage.getGroups(groupsName);
    const existing = existingList.length ? existingList : def.map((g) => ({ ...g }));
    const fixed = existing.filter((g) => g.fixed);
    const imported = importedGroups.filter((g) => !g.fixed);
    const existingIds = new Set(existing.map((g) => g.id));
    const existingNames = new Map(existing.map((g) => [g.name, g.id]));
    const groupIdMap = new Map();
    const newGroups = [];
    for (const g of imported) {
      if (existingIds.has(g.id)) {
        groupIdMap.set(g.id, g.id);
      } else if (existingNames.has(g.name)) {
        groupIdMap.set(g.id, existingNames.get(g.name));
      } else {
        newGroups.push(g);
        groupIdMap.set(g.id, g.id);
      }
    }
    const merged = [...fixed, ...existing.filter((g) => !g.fixed), ...newGroups];
    merged.forEach((g, i) => (g.order = i));
    await storage.putGroups(groupsName, merged);
    for (const item of items) {
      if (item.groupId && groupIdMap.has(item.groupId)) {
        item.groupId = groupIdMap.get(item.groupId);
      }
    }
  }

  async import(data, domain, sendResponse) {
    try {
      const cfg = DOMAIN_CONFIG[domain];
      const items = domainStore.extractImportItems(data, domain);
      if (Array.isArray(data.groups)) {
        await this.reconcileImportGroups(domain, data, items);
      }

      const groupsName = domainStore.groupsName(domain);
      const def = domainStore.defaultGroups(domain);
      const groupsList = await storage.getGroups(groupsName);
      const currentGroups = groupsList.length ? groupsList : def;
      const validGroupIds = new Set(currentGroups.map((g) => g.id));
      for (const item of items) {
        if (!validGroupIds.has(item.groupId)) item.groupId = CONFIG.GROUPS.DEFAULT_ID;
      }

      if (domain === CONFIG.STORAGE_KEYS.FOLLOWINGS) {
        const result = await domainStore.mergeAndSaveFollowings(domain, items, true);
        sendResponse({ ok: true, ...result });
      } else {
        await domainStore.mergeAndSave(domain, items).then((result) => {
          const invalid = items.filter((w) => !w || !w[DOMAIN_CONFIG[domain].idField]).length;
          sendResponse({ ok: true, ...result, invalid });
        });
      }
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }

  async export(domain, sendResponse) {
    try {
      const cfg = DOMAIN_CONFIG[domain];
      const items = await storage.getAll(cfg.storeName);
      const groups = await storage.getGroups(cfg.groupsName);
      const def = domainStore.defaultGroups(domain);
      sendResponse({
        ok: true,
        data: {
          domain,
          exportedAt: new Date().toISOString(),
          [cfg.itemKey]: Object.values(items),
          groups: groups.length ? groups : def,
        },
      });
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }

  async reset(domain, sendResponse) {
    try {
      const cfg = DOMAIN_CONFIG[domain];
      await storage.clear(cfg.storeName);
      await storage.putGroups(cfg.groupsName, cfg.defaultGroups);
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }

  async getStats(sendResponse) {
    try {
      // 分组 tab 每次切换/刷新都会走到这里：只做索引计数，不 getAll 反序列化整表，
      // 避免大数据量下每次统计都产生整表读取 + 大对象分配
      const dsWorks = domainStore.facade(CONFIG.STORAGE_KEYS.WORKS);
      const dsFollowings = domainStore.facade(CONFIG.STORAGE_KEYS.FOLLOWINGS);
      const dsLikes = domainStore.facade(CONFIG.STORAGE_KEYS.LIKES);
      const dsFavorites = domainStore.facade(CONFIG.STORAGE_KEYS.FAVORITES);
      const [works_groups, followings_groups, likes_groups, favorites_groups, est] = await Promise.all([
        dsWorks.getGroups(),
        dsFollowings.getGroups(),
        dsLikes.getGroups(),
        dsFavorites.getGroups(),
        storage.estimate(),
      ]);

      const bytes = est ? est.usage : 0;

      async function buildDomainStats(ds, groups) {
        const total = await ds.count();
        const groupCounts = { all: total };
        await Promise.all(
          (groups || []).map(async (g) => {
            if (g.id === "all") return;
            groupCounts[g.id] = await ds.countByGroup(g.id);
          }),
        );
        return { total, groupCounts };
      }

      const [works, followings, likes, favorites] = await Promise.all([
        buildDomainStats(dsWorks, works_groups),
        buildDomainStats(dsFollowings, followings_groups),
        buildDomainStats(dsLikes, likes_groups),
        buildDomainStats(dsFavorites, favorites_groups),
      ]);

      sendResponse({
        ok: true,
        stats: { works, followings, likes, favorites, bytes },
      });
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }
}
const dataTools = new DataTools();

export { dataTools };
