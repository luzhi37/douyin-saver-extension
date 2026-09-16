// background/data/groups.js — 分组 tab + 管理（域感知）

import { CONFIG } from "../core.js";
import { storage } from "./storage.js";
import { domainStore } from "./domain-store.js";

// ---------- Groups ----------
// 分组 tab + 管理（域感知）
class Groups {
  async get(domain, sendResponse) {
    try {
      const groupsName = domainStore.groupsName(domain || CONFIG.STORAGE_KEYS.WORKS);
      const def = domainStore.defaultGroups(domain || CONFIG.STORAGE_KEYS.WORKS);
      const list = await storage.getGroups(groupsName);
      const result = list.length ? list : def.map((g) => ({ ...g }));
      result.forEach((g, i) => {
        if (!("order" in g)) g.order = i;
      });

      // 固定分组钉在队首（全部 → 未分组），其余按 order 升序；与写路径(reorder/reconcileImportGroups)保持一致
      const FIXED_FRONT = ["all", "uncategorized"];
      const fixed = FIXED_FRONT.map((id) => result.find((g) => g.id === id)).filter(Boolean);
      const rest = result
        .filter((g) => !FIXED_FRONT.includes(g.id))
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      const normalized = [...fixed, ...rest];

      normalized.forEach((g, i) => (g.order = i));

      // 顺序与存储不一致时回写，修复历史错位的脏数据（自愈，只读路径最多写一次）
      if (list.length && normalized.some((g, i) => list[i] !== g)) {
        await storage.putGroups(groupsName, normalized);
      }
      sendResponse({ groups: normalized });
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }

  async add(domain, name, sendResponse) {
    try {
      const groupsName = domainStore.groupsName(domain || CONFIG.STORAGE_KEYS.WORKS);
      const def = domainStore.defaultGroups(domain || CONFIG.STORAGE_KEYS.WORKS);
      const list = await storage.getGroups(groupsName);
      const current = list.length ? list : def.map((g) => ({ ...g }));
      const id = CONFIG.GROUPS.ID_PREFIX + crypto.randomUUID();
      current.push({
        id,
        name: name.trim(),
        fixed: false,
        order: current.length,
      });
      await storage.putGroups(groupsName, current);
      sendResponse({ ok: true, group: current[current.length - 1] });
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }

  async rename(domain, groupId, newName, sendResponse) {
    try {
      const groupsName = domainStore.groupsName(domain || CONFIG.STORAGE_KEYS.WORKS);
      const def = domainStore.defaultGroups(domain || CONFIG.STORAGE_KEYS.WORKS);
      const list = await storage.getGroups(groupsName);
      const current = list.length ? list : def.map((g) => ({ ...g }));
      const g = current.find((x) => x.id === groupId);
      if (!g) return sendResponse({ error: "分组不存在" });
      if (g.fixed) return sendResponse({ error: "固定分组不可重命名" });
      g.name = newName.trim();
      await storage.putGroups(groupsName, current);
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }

  async reorder(domain, groupIds, sendResponse) {
    try {
      const groupsName = domainStore.groupsName(domain || CONFIG.STORAGE_KEYS.WORKS);
      const def = domainStore.defaultGroups(domain || CONFIG.STORAGE_KEYS.WORKS);
      const list = await storage.getGroups(groupsName);
      const current = list.length ? list : def.map((g) => ({ ...g }));
      const fixed = current.filter((g) => g.fixed);
      const ordered = groupIds.map((id) => current.find((x) => x.id === id)).filter(Boolean);
      for (const g of fixed) {
        if (!ordered.some((x) => x.id === g.id)) ordered.unshift(g);
      }
      ordered.forEach((g, i) => (g.order = i));
      await storage.putGroups(groupsName, ordered);
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }

  async delete(domain, groupId, sendResponse) {
    try {
      const groupsName = domainStore.groupsName(domain || CONFIG.STORAGE_KEYS.WORKS);
      const storeName = domainStore.storeName(domain || CONFIG.STORAGE_KEYS.WORKS);
      const def = domainStore.defaultGroups(domain || CONFIG.STORAGE_KEYS.WORKS);
      const defaultGroupId = CONFIG.GROUPS.DEFAULT_ID;

      const list = await storage.getGroups(groupsName);
      const current = list.length ? list : def;
      const g = current.find((x) => x.id === groupId);
      if (!g) return sendResponse({ error: "分组不存在" });
      if (g.fixed) return sendResponse({ error: "固定分组不可删除" });

      const affected = await storage.getByIndex(storeName, "groupId", groupId);
      const affectedList = Object.values(affected);
      for (const item of affectedList) {
        item.groupId = defaultGroupId;
      }
      if (affectedList.length > 0) await storage.putBatch(storeName, affectedList);

      const filtered = current.filter((x) => x.id !== groupId);
      await storage.putGroups(groupsName, filtered);
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }
}
const groups = new Groups();

export { groups };
