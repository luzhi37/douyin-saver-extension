// background/data/domain-store.js — 域存储封装（mergeWork / mergeAndSave / mergeAndSaveFollowings / facade）

import { CONFIG, DOMAIN_CONFIG, utils } from "../core.js";
import { storage } from "./storage.js";

// ---------- DomainStore ----------
// 域存储的封装：store/group 名解析、合并落库（三作品型域通用 + 关注域专用计数保护）。

// 逐键浅比较（键取并集）：undefined 与缺失视为不同——旧格式记录缺新字段时判为有变化，
// 借下一次合并一次性补写自愈。用于跳过「内容无变化的重复落库」
function isSameRecord(a, b) {
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

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
      // createTime 恒非零：旧备份导入的 0 值记录按 aweme_id 高 32 位推导（发布 Unix 秒）兜底
      createTime: w.createTime || utils.awemeIdCreateTime(w.awemeId) || 0,
    };
    // 旧记录已存长效 v1/play 链接而新结果是短效 CDN 直链 → 保留旧链接，
    // 避免手动添加的作品被同步以短效直链覆盖降级
    if (old && utils.isLongLivedVideoUrl(old.video) && !utils.isLongLivedVideoUrl(w.video)) {
      merged.video = old.video;
      merged.videoExpireAt = old.videoExpireAt || 0;
    }
    return merged;
  }

  // 作品型三域（works/likes/favorites）共用的合并落库：mergeWork 三项保护 + 长效链降级防护。
  // changed = 真实变更计数（新增 + 内容有变化的更新）：内容全等的重复入库（重添已有作品）
  // 不写库、不计入 changed——广播方据它决定是否发 STORE_CHANGED，options 不该为 no-op 重载。
  // written = 本次实际写入的合并后记录（点变化广播的 upserts 载荷），addedIds = 其中属于
  // 新增的记录 id（options 区分「原地更新」与「新增插入」）
  async mergeAndSave(domain, works) {
    const ds = this.facade(domain);
    const valid = (works || []).filter((w) => w && w[ds.idField]);
    if (valid.length === 0) {
      return { added: 0, updated: 0, changed: 0, total: await ds.count(), written: [], addedIds: [] };
    }

    const oldItems = await Promise.all(
      valid.map((w) => ds.get(w[ds.idField]).then((old) => ({ w, old }))),
    );

    let added = 0,
      updated = 0,
      changed = 0;
    const toWrite = [];
    const addedIds = [];
    for (const { w, old } of oldItems) {
      const merged = this.mergeWork(w, old);
      if (old) {
        updated++;
        if (isSameRecord(merged, old)) continue;
      } else {
        added++;
        addedIds.push(w[ds.idField]);
      }
      changed++;
      toWrite.push(merged);
    }
    if (toWrite.length > 0) await ds.putBatch(toWrite);

    const totalCount = await ds.count();
    return { added, updated, changed, total: totalCount, written: toWrite, addedIds };
  }

  // 关注域专用合并落库：计数仅由校准更新，常规列表同步携带的 0 不覆盖已校准旧值。
  // changed 同 mergeAndSave：内容全等的重复收录不写库、不计入 changed
  async mergeAndSaveFollowings(domain, items, isImport = false) {
    const ds = this.facade(domain);
    const stored = await ds.getAll();
    const incomingUids = new Set();
    let added = 0,
      updated = 0,
      changed = 0;
    const toWrite = [];

    const baseTime = Date.now();
    for (let i = 0; i < items.length; i++) {
      const f = items[i];
      if (!f || !f.uid) continue;
      const uid = String(f.uid);
      incomingUids.add(uid);
      const old = stored[uid];
      const merged = {
        ...f,
        // 计数仅由校准更新：常规列表同步携带的 0 不覆盖已校准旧值；校准结果/导入快照 >0 时正常写入
        followerCount: f.followerCount > 0 ? f.followerCount : old?.followerCount || 0,
        awemeCount: f.awemeCount > 0 ? f.awemeCount : old?.awemeCount || 0,
        lastUpdateAt: f.lastUpdateAt > 0 ? f.lastUpdateAt : old?.lastUpdateAt || 0,
        uid,
        groupId: isImport
          ? f.groupId || CONFIG.GROUPS.DEFAULT_ID
          : old?.groupId || f.groupId || CONFIG.GROUPS.DEFAULT_ID,
        savedAt: old?.savedAt ?? baseTime - i,
      };
      stored[uid] = merged;
      if (!old) {
        added++;
        changed++;
        toWrite.push(merged);
      } else {
        updated++;
        if (!isSameRecord(merged, old)) {
          changed++;
          toWrite.push(merged);
        }
      }
    }

    // Mark users not in new list as 'lost'
    const lostUids = [];
    for (const uid of Object.keys(stored)) {
      if (!incomingUids.has(uid)) {
        lostUids.push(uid);
      }
    }

    if (toWrite.length > 0) await ds.putBatch(toWrite);
    return {
      added,
      updated,
      changed,
      lost: lostUids.length,
      lostUids,
      total: Object.keys(stored).length,
    };
  }
}
const domainStore = new DomainStore();

export { domainStore };
