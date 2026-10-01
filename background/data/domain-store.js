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

  // domainStorage: 封装 DOMAIN_CONFIG，让调用者只需传 domain 名称，避免硬编码 store 名。
  // 条目收敛为调用方实际消费的集合（getAll/getByGroup/clear/putGroups/getDefaultGroups/
  // itemKey 已删：等价能力各有直连承担方——storage.getAll/clear/putGroups/countByIndex、
  // domainStore.defaultGroups()、DOMAIN_CONFIG.itemKey）
  facade(domain) {
    const cfg = DOMAIN_CONFIG[domain];
    if (!cfg) throw new Error("Unknown domain: " + domain);
    return {
      get: (key) => storage.get(cfg.storeName, key),
      getBatch: (keys) => storage.getBatch(cfg.storeName, keys),
      getAllKeys: () => storage.getAllKeys(cfg.storeName),
      putBatch: (items) => storage.putBatch(cfg.storeName, items),
      deleteBatch: (keys) => storage.deleteBatch(cfg.storeName, keys),
      count: () => storage.count(cfg.storeName),
      countByGroup: (groupId) => storage.countByIndex(cfg.storeName, "groupId", groupId),
      getGroups: () => storage.getGroups(cfg.groupsName),
      idField: cfg.idField,
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
  // 新增的记录 id（options 区分「原地更新」与「新增插入」）。
  // stamps（persistScan 扫描落库专用）：Map<主键, savedAt> 覆盖戳——主页序 savedAt 重排要求
  // 全部 valid 记录都写（含内容无变化者），写入集扩为全集；但 added/updated/changed 计数仍按
  // 覆盖前的 isSameRecord 口径（isSameRecord 在戳覆盖前判定），汇报语义与常规路径一致。
  // 缺省 null = 常规路径，仅写 changed 集
  async mergeAndSave(domain, works, { stamps = null } = {}) {
    const ds = this.facade(domain);
    const valid = (works || []).filter((w) => w && w[ds.idField]);
    if (valid.length === 0) {
      return { added: 0, updated: 0, changed: 0, total: await ds.count(), written: [], addedIds: [] };
    }

    // 旧记录批量读取：单事务 getBatch 按入参序对位（缺失为 null），语义与逐条 ds.get 一致
    //（三作品型域主键经 formatWork 恒为字符串，无键类型转换问题）
    const olds = await ds.getBatch(valid.map((w) => w[ds.idField]));

    let added = 0,
      updated = 0,
      changed = 0;
    const toWrite = [];
    const addedIds = [];
    for (let i = 0; i < valid.length; i++) {
      const w = valid[i];
      const old = olds[i];
      const merged = this.mergeWork(w, old);
      // isSameRecord 必须在 stamps 覆盖 savedAt 之前判定：戳重排是每条都写的机械结果，不计入 changed
      const unchanged = Boolean(old) && isSameRecord(merged, old);
      if (stamps) merged.savedAt = stamps.get(w[ds.idField]) ?? merged.savedAt;
      if (old) {
        updated++;
      } else {
        added++;
        addedIds.push(w[ds.idField]);
      }
      // changed 只按 pre-stamp 口径计；stamps 路径内容无变化的记录也要写（savedAt 重排），但不计入 changed
      if (!unchanged) changed++;
      if (stamps || !unchanged) toWrite.push(merged);
    }
    if (toWrite.length > 0) await ds.putBatch(toWrite);

    const totalCount = await ds.count();
    return { added, updated, changed, total: totalCount, written: toWrite, addedIds };
  }

  // 关注域专用合并落库：计数仅由校准更新，常规列表同步携带的 0 不覆盖已校准旧值。
  // changed 同 mergeAndSave：内容全等的重复收录不写库、不计入 changed。
  // 旧记录经 getBatch 单事务按需读取（替代 getAll 全表物化——单条收录路径不再按全表付费），
  // 丢失检测经 getAllKeys 键集差（不反序列化记录值），total = 存量键数 + 新增
  async mergeAndSaveFollowings(domain, items, isImport = false) {
    const ds = this.facade(domain);
    // 同批重复 uid 取首次出现（列表接口不应产生重复，防御性收敛；与旧实现「putBatch 后写覆盖」
    // 相比仅重复条的 savedAt 毫秒差之别）
    const incoming = [];
    const incomingUids = new Set();
    for (const f of items || []) {
      if (!f || !f.uid) continue;
      const uid = String(f.uid);
      if (incomingUids.has(uid)) continue;
      incomingUids.add(uid);
      incoming.push({ f, uid });
    }
    // 丢失检测与旧记录读取并行；getAllKeys 须在 putBatch 前取（键集反映写前状态）
    const [olds, oldKeys] = await Promise.all([
      ds.getBatch(incoming.map((x) => x.uid)),
      ds.getAllKeys(),
    ]);

    let added = 0,
      updated = 0,
      changed = 0;
    const toWrite = [];

    const baseTime = Date.now();
    for (let i = 0; i < incoming.length; i++) {
      const { f, uid } = incoming[i];
      const old = olds[i];
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
    const lostUids = oldKeys.filter((uid) => !incomingUids.has(String(uid)));

    if (toWrite.length > 0) await ds.putBatch(toWrite);
    return {
      added,
      updated,
      changed,
      lost: lostUids.length,
      lostUids,
      total: oldKeys.length + added,
    };
  }
}
const domainStore = new DomainStore();

export { domainStore };
