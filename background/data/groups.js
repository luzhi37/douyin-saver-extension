// background/data/groups.js — 分组 tab + 管理（域感知）

import { CONFIG, utils } from "../core.js";
import { storage } from "./storage.js";
import { domainStore } from "./domain-store.js";

// ---------- Groups ----------
// 分组 tab + 管理（域感知）。错误响应由路由层 asyncHandler 统一收口，处理器不自包装
class Groups {
  // 分组表取数前缀：空表回退默认组拷贝。normalizeGroups 不在此收口——get/add 需归一化、
  // rename/reorder/delete 现状未归一化，统一会改写 order（行为变更）
  async #loadGroups(domain) {
    const groupsName = domainStore.groupsName(domain);
    const def = domainStore.defaultGroups(domain);
    const list = await storage.getGroups(groupsName);
    return { groupsName, current: list.length ? list : def.map((g) => ({ ...g })) };
  }

  async get(domain, sendResponse) {
    // 排序唯一口径见 utils.normalizeGroups：固定分组钉前、其余按 order 升序
    //（getGroups 的数组序是 IDB 主键 id 序，不是显示序）
    const { current } = await this.#loadGroups(domain);
    sendResponse({ groups: utils.normalizeGroups(current) });
  }

  // 域切换/分组刷新：分组表 + count（已并入 *_groups）只读 groups 一张小表。
  // 计数由数据写入同事务维护；这里不做数据 store 扫描
  async getWithStats(domain, sendResponse) {
    const groupsName = domainStore.groupsName(domain);
    const def = domainStore.defaultGroups(domain);
    const snap = await storage.getGroupsWithStats(groupsName);
    const list = snap.groups.length ? snap.groups : def.map((g) => ({ ...g, count: 0 }));
    // counts/total 由 getGroupsWithStats 从同一 groups 列表派生，直接透传
    sendResponse({ groups: utils.normalizeGroups(list), counts: snap.counts, total: snap.total });
  }

  async add(domain, name, sendResponse) {
    const { groupsName, current: raw } = await this.#loadGroups(domain);
    const current = utils.normalizeGroups(raw);
    const id = CONFIG.GROUPS.ID_PREFIX + crypto.randomUUID();
    // 归一化后 order 连续，新组恒取尾部序号；直接以 current.length 会与删除留下的 order 断档撞号
    const group = { id, name: name.trim(), fixed: false, order: current.length };
    await storage.putGroups(groupsName, [...current, group]);
    sendResponse({ ok: true, group });
  }

  async rename(domain, groupId, newName, sendResponse) {
    const { groupsName, current } = await this.#loadGroups(domain);
    const g = current.find((x) => x.id === groupId);
    if (!g) return sendResponse({ error: "分组不存在" });
    if (g.fixed) return sendResponse({ error: "固定分组不可重命名" });
    g.name = newName.trim();
    await storage.putGroups(groupsName, current);
    sendResponse({ ok: true });
  }

  async reorder(domain, groupIds, sendResponse) {
    const { groupsName, current } = await this.#loadGroups(domain);
    const fixed = current.filter((g) => g.fixed);
    const ordered = groupIds.map((id) => current.find((x) => x.id === id)).filter(Boolean);
    const missingFixed = fixed.filter((g) => !ordered.some((x) => x.id === g.id));
    ordered.unshift(...missingFixed);
    ordered.forEach((g, i) => (g.order = i));
    await storage.putGroups(groupsName, ordered);
    sendResponse({ ok: true });
  }

  async delete(domain, groupId, sendResponse) {
    const storeName = domainStore.storeName(domain);
    const defaultGroupId = CONFIG.GROUPS.DEFAULT_ID;
    // 空表回退默认组拷贝（delete 仅 filter 不改元素、putGroups 重建记录，拷贝安全）
    const { groupsName, current } = await this.#loadGroups(domain);
    const g = current.find((x) => x.id === groupId);
    if (!g) return sendResponse({ error: "分组不存在" });
    if (g.fixed) return sendResponse({ error: "固定分组不可删除" });

    // 只取主键、只写 groupId：删除分组是并发场景（同步任务正在 checkpoint）下的
    // 批量移动，整条 get→put 会用旧快照覆盖并发写入的字段，且物化整组记录成本更高
    const idField = domainStore.facade(domain).idField;
    const keys = await storage.getAllKeysByIndex(storeName, "groupId", groupId);
    if (keys.length > 0) {
      await storage.patchBatch(
        storeName,
        keys.map((key) => ({ [idField]: key, groupId: defaultGroupId })),
        (old) => (old ? { ...old, groupId: defaultGroupId } : null),
      );
    }

    const filtered = current.filter((x) => x.id !== groupId);
    await storage.putGroups(groupsName, filtered);
    sendResponse({ ok: true });
  }
}
const groups = new Groups();

export { groups };
