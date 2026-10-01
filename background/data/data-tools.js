// background/data/data-tools.js — 导入导出 / 重置 / 统计（reconcileImportGroups）

import { CONFIG, DOMAIN_CONFIG, utils } from "../core.js";
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

  async import(text, domain, sendResponse) {
    try {
      // 解析在 SW 侧完成：options 只传文件全文（字符串过消息通道是 memcpy 级 clone），
      // 主线程不再 JSON.parse 大文件、解析结果不再全量对象 clone
      let data;
      try {
        data = JSON.parse(text);
      } catch (_err) {
        return sendResponse({ ok: false, error: "IMPORT_PARSE_FAILED" });
      }
      const cfg = DOMAIN_CONFIG[domain];
      const items = domainStore.extractImportItems(data, domain);
      if (items.length === 0) {
        // 原 options 侧 isDomainData 前置校验职责移入：非该域数据/空数组统一报空
        return sendResponse({ ok: false, error: "IMPORT_EMPTY" });
      }
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
        // 分块落库：单事务 10 万级 put 会长时间独占 SW 的 IndexedDB——按块 mergeAndSave
        //（旧记录单事务 getBatch 批量读，块内成本 O(块大小)），逐块回报 IMPORT_PROGRESS；
        // 计数跨块累计，响应只带计数（不再 spread 单次 mergeAndSave 的 written/addedIds
        // 全记录——旧实现万级导入的响应体因此膨胀至 MB 级，消费方只读 added/updated/total）
        const invalid = items.filter((w) => !w || !w[DOMAIN_CONFIG[domain].idField]).length;
        let added = 0;
        let updated = 0;
        let changed = 0;
        let last = null;
        for (let i = 0; i < items.length; i += CONFIG.IMPORT_CHUNK) {
          last = await domainStore.mergeAndSave(domain, items.slice(i, i + CONFIG.IMPORT_CHUNK));
          added += last.added;
          updated += last.updated;
          changed += last.changed;
          utils.sendMessageSafe({
            type: "IMPORT_PROGRESS",
            domain,
            processed: Math.min(i + CONFIG.IMPORT_CHUNK, items.length),
            total: items.length,
          });
        }
        sendResponse({
          ok: true,
          added,
          updated,
          changed,
          total: last ? last.total : await domainStore.facade(domain).count(),
          invalid,
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
      // 序列化在 SW 侧一次完成（无缩进）：options 不再收全量对象（structured clone 大头）、
      // 不再主线程 stringify（缩进还使体积膨胀 20-30%）——文本 clone 是 memcpy 级
      const text = JSON.stringify({
        domain,
        exportedAt: new Date().toISOString(),
        [cfg.itemKey]: Object.values(items),
        groups: groups.length ? groups : def,
      });
      sendResponse({ ok: true, text });
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
