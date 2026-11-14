// background/data/domain-store.js — 域存储封装（mergeWork / mergeAndSave / mergeAndSaveAuthors / facade）

import { CONFIG, DOMAIN_CONFIG, utils } from "../core.js";
import { storage } from "./storage.js";

// ---------- DomainStore ----------
// 域存储的封装：store/group 名解析、合并落库（三作品型域通用 + 作者域专用计数保护）。

// 逐键浅比较（键取并集）：undefined 与缺失视为不同——旧格式记录缺新字段时判为有变化，
// 借下一次合并一次性补写自愈。用于跳过「内容无变化的重复落库」
function isSameRecord(a, b) {
  // 四个调用点均已保证入参非空：mergeAndSave 经 Boolean(old) 短路，patchWorks/
  // patchAuthors 经 !old 短路，mergeAndSaveAuthors 位于 old 非空分支
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

class DomainStore {
  storeName(domain) {
    return DOMAIN_CONFIG[domain].storeName;
  }

  groupsName(domain) {
    return DOMAIN_CONFIG[domain].groupsName;
  }

  defaultGroups(domain) {
    return DOMAIN_CONFIG[domain].defaultGroups;
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
    // 类型归一化是 groupId_uid_sort 索引的硬前提：uid/groupId/awemeId 为字符串、
    // createTime/savedAt 为数字。索引对 undefined 分量不建项，字段类型混杂会让同一
    // 作者被拆成数字/字符串两个簇（历史导入 JSON 可能携带数字 uid）
    const uid = w.uid != null && w.uid !== "" ? String(w.uid) : String(old?.uid || "");
    const createTime = Number(w.createTime) || utils.awemeIdCreateTime(w.awemeId) || 0;
    const merged = {
      ...w,
      uid,
      groupId: String(old?.groupId || w.groupId || CONFIG.GROUPS.DEFAULT_ID),
      savedAt: Number(old?.savedAt || w.savedAt) || Date.now(),
      createTime,
    };
    // 旧记录已存长效 v1/play 链接而新结果是短效 CDN 直链 → 保留旧链接，
    // 避免手动添加的作品被同步以短效直链覆盖降级
    if (old && utils.isLongLivedVideoUrl(old.video) && !utils.isLongLivedVideoUrl(w.video)) {
      merged.video = old.video;
      merged.videoExpireAt = old.videoExpireAt || 0;
    }
    return merged;
  }

  // 作品型三域（works/favorites/collections）共用的合并落库：mergeWork 三项保护 + 长效链降级防护。
  // changed = 真实变更计数（新增 + 内容有变化的更新）：内容全等的重复入库（重添已有作品）
  // 不写库、不计入 changed——广播方据它决定是否发 STORE_CHANGED，options 不该为 no-op 重载。
  // written = 本次实际写入的合并后记录（点变化广播的 upserts 载荷），addedIds = 其中属于
  // 新增的记录 id（options 区分「原地更新」与「新增插入」）。
  // stamps（扫描分块确认写专用，createScanWriter 传入）：Map<主键, savedAt> 覆盖戳——主页序
  // savedAt 重排要求全部 valid 记录都写（含内容无变化者），写入集扩为全集；changed 仍按
  // 覆盖前的 isSameRecord 口径（在戳覆盖前判定），updated 则统计命中的存量条数（不做内容
  // 差异过滤）。缺省 null = 常规路径，仅写 changed 集
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

  // 字段级补丁落库（同步等 update-only 路径）：old 缺失即跳过（删除永远赢），内容无变化
  // 也跳过（不产生无意义写入与广播）。与 mergeAndSave 的差异只有两点：批量 get 与 put
  // 在同一事务内完成、永不新增记录——因此可与用户的删除/移动并发执行而不互相覆盖。
  // 返回 { patched, skipped, keysChanged, ids }（ids 仅含实际写入的主键）
  async patchWorks(domain, works) {
    const ds = this.facade(domain);
    const valid = (works || []).filter((w) => w && w[ds.idField]);
    if (valid.length === 0) return { patched: 0, skipped: 0, keysChanged: false, ids: [] };
    return storage.patchBatch(
      this.storeName(domain),
      valid,
      (old, w) => {
        if (!old) return null;
        const merged = this.mergeWork(w, old);
        return isSameRecord(merged, old) ? null : merged;
      },
      { bumpRevOnKeyChange: true },
    );
  }

  // 作者域字段级补丁（校准等 update-only 路径）：单事务 get → 合并白名单字段 → put。
  // old 缺失即跳过（删除永远赢）；groupId/savedAt/uid 不参与合并——网络等待期间用户的
  // 分组移动/删除不会被迟到的校准回包覆盖。返回与 storage.patchBatch 同构。
  async patchAuthors(domain, items, buildFields) {
    const valid = (items || []).filter((x) => x && x.uid != null && x.uid !== "");
    if (valid.length === 0) return { patched: 0, skipped: 0, keysChanged: false, ids: [] };
    return storage.patchBatch(
      this.storeName(domain),
      valid,
      (old, item) => {
        if (!old) return null;
        const merged = { ...old, ...buildFields(item, old) };
        return isSameRecord(merged, old) ? null : merged;
      },
    );
  }

  // 作者域（followings/candidates）专用合并落库：计数仅由校准更新，常规列表同步携带的 0
  // 不覆盖已校准旧值。changed 同 mergeAndSave：内容全等的重复收录不写库、不计入 changed。
  // 分组归属与作品型域同一口径：本地既有记录优先，采集/导入仅在新记录时采用来值——
  // 用户手工整理不被同步或导入冲掉（旧 isImport 分支按文件分组覆盖本地，已定案移除）。
  // lostUids 仅对原生 followings 有意义（candidates 调用方忽略，不据此自动删除）。
  // 旧记录在写事务内逐条 get→merge→put（单事务字段合并），丢失检测经 getAllKeys 键集差。
  // stamps（扫描分块落库专用）：Map<uid, savedAt> 为新记录提供跨块一致的戳——关注同步
  // 分块落库时每块独立调用本函数，块内 Date.now() 漂移会让后抓的作者排到先抓的之前，
  // 调用方用任务级 baseTime − 全局下标预先分配（savedAt desc = 主页关注序）。
  // lost:false（分块确认写专用）：跳过 getAllKeys 与丢失计算——「确认写」每块 upsert，
  // 丢失检测（结论写）由调用方在任务终态用起始键集快照统一执行，分块路径禁止在块边界
  // 产生任何丢失结论。返回 total 仅在 lost:true 时有意义（键集快照不可得时为 0）。
  async mergeAndSaveAuthors(domain, items, { lost = true, stamps = null } = {}) {
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
    // 丢失检测的键集必须在写事务前取（键集反映写前状态）；lost:false 分块路径跳过
    const oldKeys = lost ? await ds.getAllKeys() : [];
    const indexByUid = new Map(incoming.map((x, i) => [x.uid, i]));

    let added = 0,
      updated = 0,
      changed = 0;
    const baseTime = Date.now();
    // 单事务 get→merge→put：与用户的 MOVE/DELETE 在同一 store 上串行。
    // 禁止改回「先 getBatch、后 putBatch」的两次事务读改写——大域 getBatch 期间用户
    // 提交的移动会落在读写窗口中间，被本函数用旧 groupId 快照覆盖（表现为卡片刷新回旧组）
    await storage.patchBatch(
      this.storeName(domain),
      incoming.map(({ f, uid }) => ({ ...f, uid })),
      (old, item) => {
        const uid = String(item.uid);
        const i = indexByUid.get(uid) ?? 0;
        const merged = {
          ...item,
          // 计数仅由校准更新：常规列表同步携带的 0 不覆盖已校准旧值；校准结果/导入快照 >0 时正常写入
          followerCount: item.followerCount > 0 ? item.followerCount : old?.followerCount || 0,
          awemeCount: item.awemeCount > 0 ? item.awemeCount : old?.awemeCount || 0,
          lastUpdateAt: item.lastUpdateAt > 0 ? item.lastUpdateAt : old?.lastUpdateAt || 0,
          uid,
          // 分组本地优先：既有记录保留原分组（含任务期间的用户移动），仅新记录采用来值
          groupId: old?.groupId || item.groupId || CONFIG.GROUPS.DEFAULT_ID,
          // 戳序：既有记录保留旧值；新记录取 stamps（分块路径跨块一致），缺省回落块内序
          savedAt: old?.savedAt ?? stamps?.get(uid) ?? baseTime - i,
        };
        if (old) {
          updated++;
          if (isSameRecord(merged, old)) return null;
          changed++;
          return merged;
        }
        added++;
        changed++;
        return merged;
      },
    );

    // Mark users not in new list as 'lost'（仅整批调用：分块确认写 lost:false 不产生结论）
    const lostUids = lost ? oldKeys.filter((uid) => !incomingUids.has(String(uid))) : [];
    return {
      added,
      updated,
      changed,
      lost: lostUids.length,
      lostUids,
      total: lost ? oldKeys.length + added : 0,
    };
  }
}
const domainStore = new DomainStore();

export { domainStore };
