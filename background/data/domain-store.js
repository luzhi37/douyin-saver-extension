// background/data/domain-store.js — 域存储封装（mergeWork / mergeAndSave / mergeAndSaveFollowings / facade）

import { CONFIG, DOMAIN_CONFIG, utils } from "../core.js";
import { storage } from "./storage.js";

// ---------- DomainStore ----------
// 域存储的封装：store/group 名解析、合并落库（三作品型域通用 + 关注域专用计数保护）。
class DomainStore {
  storeName(domain) {
    return DOMAIN_CONFIG[domain || CONFIG.STORAGE_KEYS.WORKS].storeName;
  }

  groupsName(domain) {
    return DOMAIN_CONFIG[domain || CONFIG.STORAGE_KEYS.WORKS].groupsName;
  }

  defaultGroups(domain) {
    return DOMAIN_CONFIG[domain || CONFIG.STORAGE_KEYS.WORKS].defaultGroups;
  }

  toStorageId(domain, id) {
    const cfg = DOMAIN_CONFIG[domain];
    return cfg.idToString ? String(id) : id;
  }

  // domainStorage: 封装 DOMAIN_CONFIG，让调用者只需传 domain 名称，避免硬编码 store 名
  facade(domain) {
    const cfg = DOMAIN_CONFIG[domain];
    if (!cfg) throw new Error("Unknown domain: " + domain);
    return {
      getAll: () => storage.getAll(cfg.storeName),
      get: (key) => storage.get(cfg.storeName, key),
      putBatch: (items) => storage.putBatch(cfg.storeName, items),
      deleteBatch: (keys) => storage.deleteBatch(cfg.storeName, keys),
      count: () => storage.count(cfg.storeName),
      countByGroup: (groupId) => storage.countByIndex(cfg.storeName, "groupId", groupId),
      getByGroup: (groupId) => storage.getByIndex(cfg.storeName, "groupId", groupId),
      clear: () => storage.clear(cfg.storeName),
      getGroups: () => storage.getGroups(cfg.groupsName),
      putGroups: (groups) => storage.putGroups(cfg.groupsName, groups),
      getDefaultGroups: () => cfg.defaultGroups,
      idField: cfg.idField,
      itemKey: cfg.itemKey,
    };
  }

  extractImportItems(data, domain) {
    const cfg = DOMAIN_CONFIG[domain];
    if (data[cfg.itemKey] && Array.isArray(data[cfg.itemKey])) return data[cfg.itemKey];
    return [];
  }

  mergeWork(w, old) {
    const merged = {
      ...w,
      groupId: old?.groupId || w.groupId || CONFIG.GROUPS.DEFAULT_ID,
      savedAt: old?.savedAt || w.savedAt || Date.now(),
    };
    // 旧记录已存长效 v1/play 链接而新结果是短效 CDN 直链 → 保留旧链接，
    // 避免手动添加的作品被同步以短效直链覆盖降级
    if (old && utils.isLongLivedVideoUrl(old.video) && !utils.isLongLivedVideoUrl(w.video)) {
      merged.video = old.video;
      merged.videoExpireAt = old.videoExpireAt || 0;
    }
    return merged;
  }

  // 作品型三域（works/likes/favorites）共用的合并落库：mergeWork 三项保护 + 长效链降级防护
  async mergeAndSave(domain, works) {
    const ds = this.facade(domain);
    const valid = (works || []).filter((w) => w && w[ds.idField]);
    if (valid.length === 0) return { added: 0, updated: 0, total: await ds.count() };

    const oldItems = await Promise.all(
      valid.map((w) => ds.get(w[ds.idField]).then((old) => ({ w, old }))),
    );

    let added = 0,
      updated = 0;
    const toWrite = [];
    for (const { w, old } of oldItems) {
      const isNew = !old;
      toWrite.push(this.mergeWork(w, old));
      if (isNew) added++;
      else updated++;
    }
    await ds.putBatch(toWrite);

    const totalCount = await ds.count();
    return { added, updated, total: totalCount };
  }

  // 关注域专用合并落库：计数仅由校准更新，常规列表同步携带的 0 不覆盖已校准旧值
  async mergeAndSaveFollowings(domain, items, isImport = false) {
    const ds = this.facade(domain);
    const stored = await ds.getAll();
    const incomingUids = new Set();
    let added = 0,
      updated = 0;

    const baseTime = Date.now();
    for (let i = 0; i < items.length; i++) {
      const f = items[i];
      if (!f || !f.uid) continue;
      const uid = String(f.uid);
      incomingUids.add(uid);
      const old = stored[uid];
      stored[uid] = {
        ...f,
        // 计数仅由校准更新：常规列表同步携带的 0 不覆盖已校准旧值；校准结果/导入快照 >0 时正常写入
        followerCount: f.followerCount > 0 ? f.followerCount : old?.followerCount || 0,
        awemeCount: f.awemeCount > 0 ? f.awemeCount : old?.awemeCount || 0,
        uid,
        groupId: isImport
          ? f.groupId || CONFIG.GROUPS.DEFAULT_ID
          : old?.groupId || f.groupId || CONFIG.GROUPS.DEFAULT_ID,
        savedAt: old?.savedAt ?? baseTime - i,
      };
      if (!old) added++;
      else updated++;
    }

    // Mark users not in new list as 'lost'
    const lostUids = [];
    for (const uid of Object.keys(stored)) {
      if (!incomingUids.has(uid)) {
        lostUids.push(uid);
      }
    }

    await ds.putBatch(Object.values(stored));
    return {
      added,
      updated,
      lost: lostUids.length,
      lostUids,
      total: Object.keys(stored).length,
    };
  }
}
const domainStore = new DomainStore();

export { domainStore };
