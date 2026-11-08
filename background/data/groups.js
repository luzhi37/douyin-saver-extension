// background/data/groups.js — 分组 tab + 管理（域感知）

import { CONFIG, utils } from "../core.js";
import { storage } from "./storage.js";
import { domainStore } from "./domain-store.js";

// ---------- Groups ----------
// 分组 tab + 管理（域感知）
class Groups {
  async get(domain, sendResponse) {
    try {
      const groupsName = domainStore.groupsName(domain);
      const def = domainStore.defaultGroups(domain);
      const list = await storage.getGroups(groupsName);
      // 排序唯一口径见 utils.normalizeGroups：固定分组钉前、其余按 order 升序
      //（getGroups 的数组序是 IDB 主键 id 序，不是显示序）
      sendResponse({ groups: utils.normalizeGroups(list.length ? list : def.map((g) => ({ ...g }))) });
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }

  // 域切换/分组刷新：分组表 + count（已并入 *_groups）只读 groups 一张小表。
  // 计数由数据写入同事务维护；这里不做数据 store 扫描
  async getWithStats(domain, sendResponse) {
    try {
      const groupsName = domainStore.groupsName(domain);
      const def = domainStore.defaultGroups(domain);
      const snap = await storage.getGroupsWithStats(groupsName);
      const list = snap.groups.length ? snap.groups : def.map((g) => ({ ...g, count: 0 }));
      const groups = utils.normalizeGroups(list);
      const counts = { all: snap.total };
      for (const g of groups) {
        if (g.id === "all") continue;
        counts[g.id] = snap.counts[g.id] || 0;
      }
      sendResponse({ groups, counts, total: snap.total });
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }

  async add(domain, name, sendResponse) {
    try {
      const groupsName = domainStore.groupsName(domain);
      const def = domainStore.defaultGroups(domain);
      const list = await storage.getGroups(groupsName);
      const current = utils.normalizeGroups(list.length ? list : def.map((g) => ({ ...g })));
      const id = CONFIG.GROUPS.ID_PREFIX + crypto.randomUUID();
      // 归一化后 order 连续，新组恒取尾部序号；直接以 current.length 会与删除留下的 order 断档撞号
      const group = { id, name: name.trim(), fixed: false, order: current.length };
      await storage.putGroups(groupsName, [...current, group]);
      sendResponse({ ok: true, group });
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }

  async rename(domain, groupId, newName, sendResponse) {
    try {
      const groupsName = domainStore.groupsName(domain);
      const def = domainStore.defaultGroups(domain);
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
      const groupsName = domainStore.groupsName(domain);
      const def = domainStore.defaultGroups(domain);
      const list = await storage.getGroups(groupsName);
      const current = list.length ? list : def.map((g) => ({ ...g }));
      const fixed = current.filter((g) => g.fixed);
      const ordered = groupIds.map((id) => current.find((x) => x.id === id)).filter(Boolean);
      const missingFixed = fixed.filter((g) => !ordered.some((x) => x.id === g.id));
      ordered.unshift(...missingFixed);
      ordered.forEach((g, i) => (g.order = i));
      await storage.putGroups(groupsName, ordered);
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }

  async delete(domain, groupId, sendResponse) {
    try {
      const groupsName = domainStore.groupsName(domain);
      const storeName = domainStore.storeName(domain);
      const def = domainStore.defaultGroups(domain);
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
