// background/data/data-tools.js — 导入导出 / 重置 / 统计（reconcileImportGroups）

import { CONFIG, DOMAIN_CONFIG, utils } from "../core.js";
import { storage } from "./storage.js";
import { domainStore } from "./domain-store.js";

// ---------- DataTools ----------
// 导入导出 / 重置 / 统计（域感知）
class DataTools {
  // 分组对账：本地既有分组（含用户拖拽顺序）为唯一权威，导入只做「id/名称映射 + 追加新组」。
  // storage.getGroups 的数组序是 IDB 主键(id)序，必须先经 utils.normalizeGroups 还原 order 序，
  // 否则导入会把自定义分组（custom_+UUID）按 UUID 字典序重排，即用户可见的「分组顺序紊乱」
  async reconcileImportGroups(domain, data, items) {
    const importedGroups = data.groups || [];
    if (importedGroups.length === 0) return;
    const groupsName = domainStore.groupsName(domain);
    const def = domainStore.defaultGroups(domain);
    const existingList = await storage.getGroups(groupsName);
    const existing = utils.normalizeGroups(existingList.length ? existingList : def.map((g) => ({ ...g })));
    const fixedIds = new Set(CONFIG.DEFAULT_GROUPS.map((g) => g.id));
    const existingIds = new Set(existing.map((g) => g.id));
    const existingNames = new Map(existing.map((g) => [g.name, g.id]));
    const groupIdMap = new Map();
    const newGroups = [];
    for (const g of importedGroups) {
      if (!g || !g.id || fixedIds.has(g.id)) continue; // 固定分组由本地定义，不参与对账
      if (existingIds.has(g.id)) {
        groupIdMap.set(g.id, g.id);
      } else if (existingNames.has(g.name)) {
        groupIdMap.set(g.id, existingNames.get(g.name));
      } else {
        newGroups.push(g);
        groupIdMap.set(g.id, g.id);
      }
    }
    // 新组一律追加到末尾：先压到既有序号之后，避免文件内 order 把新组插进既有分组之间
    newGroups.forEach((g, i) => (g.order = existing.length + i));
    const merged = utils.normalizeGroups([...existing, ...newGroups]);
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
      // 旧备份兼容（schemaVersion 缺失 = v1 旧格式；导入目标域由弹窗显式指定，不读文件内
      // domain 字段）。favorites 键在 v1 = 收藏数据、v2 = 点赞数据，同名不同义以版本区分
      if (cfg.itemKey === "favorites" && !data.schemaVersion) {
        if (Array.isArray(data.likes)) {
          data.favorites = data.likes; // 旧点赞备份（键 likes = 点赞，语义同）
        } else if (Array.isArray(data.favorites)) {
          // 旧收藏备份误投点赞域：旧格式的 favorites 键是收藏数据
          return sendResponse({ ok: false, error: "LEGACY_COLLECTION_BACKUP" });
        }
      }
      if (cfg.itemKey === "collections" && !data.schemaVersion
          && !Array.isArray(data.collections) && Array.isArray(data.favorites)) {
        data.collections = data.favorites; // 旧收藏备份导入收藏域
      }
      // 候选域兼容旧关注域备份：旧文件只有 followings 键（账户关注镜像），手动导入候选域时
      // 按作者档案读取；不做自动迁移，仅在用户显式选择该文件时生效
      if (domain === CONFIG.STORAGE_KEYS.CANDIDATES
          && !Array.isArray(data.candidates) && Array.isArray(data.followings)) {
        data.candidates = data.followings;
      }
      const items = domainStore.extractImportItems(data, domain);
      if (items.length === 0) {
        // 原 options 侧 isDomainData 前置校验职责移入：非该域数据/空数组统一报空
        return sendResponse({ ok: false, error: "IMPORT_EMPTY" });
      }
      // reconcileImportGroups 内部对缺组/空组静默返回，此处不再重复判型
      await this.reconcileImportGroups(domain, data, items);

      const groupsName = domainStore.groupsName(domain);
      const def = domainStore.defaultGroups(domain);
      const groupsList = await storage.getGroups(groupsName);
      const currentGroups = groupsList.length ? groupsList : def;
      const validGroupIds = new Set(currentGroups.map((g) => g.id));
      for (const item of items) {
        if (!validGroupIds.has(item.groupId)) item.groupId = CONFIG.GROUPS.DEFAULT_ID;
      }

      if (CONFIG.AUTHOR_RECORD_DOMAINS.includes(domain)) {
        const result = await domainStore.mergeAndSaveAuthors(domain, items);
        sendResponse({ ok: true, ...result });
      } else {
        // 分块落库：单事务 10 万级 put 会长时间独占 SW 的 IndexedDB——按块 mergeAndSave
        //（旧记录单事务 getBatch 批量读，块内成本 O(块大小)），逐块回报 IMPORT_PROGRESS；
        // 计数跨块累计，响应只带计数（不再 spread 单次 mergeAndSave 的 written/addedIds
        // 全记录——旧实现万级导入的响应体因此膨胀至 MB 级，消费方只读 added/updated/invalid）
        const invalid = items.filter((w) => !w || !w[DOMAIN_CONFIG[domain].idField]).length;
        let added = 0;
        let updated = 0;
        for (let i = 0; i < items.length; i += CONFIG.IMPORT_CHUNK) {
          const result = await domainStore.mergeAndSave(domain, items.slice(i, i + CONFIG.IMPORT_CHUNK));
          added += result.added;
          updated += result.updated;
          utils.sendMessageSafe({
            type: "IMPORT_PROGRESS",
            domain,
            processed: Math.min(i + CONFIG.IMPORT_CHUNK, items.length),
            total: items.length,
          });
        }
        sendResponse({ ok: true, added, updated, invalid });
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
      // 序列化在 SW 侧一次完成（2 空格缩进，导出文件是人类查看的交付物，单行 JSON 虽合法
      // 但不可读）：options 不再收全量对象（structured clone 大头）、不再主线程 stringify
      // ——文本 clone 是 memcpy 级；缩进的体积代价（+20-30%）由用户侧承担且可接受
      const text = JSON.stringify(
        {
          schemaVersion: 2,
          domain,
          exportedAt: new Date().toISOString(),
          [cfg.itemKey]: Object.values(items),
          groups: utils.normalizeGroups(groups.length ? groups : def),
        },
        null,
        2,
      );
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

  // msg.domain    → 只统计该域的分组计数（切域/切组渲染分组 tab 用，避免拖上全部五域）
  // msg.bytesOnly → 只回存储占用字节（存储指示器独立刷新用，不做任何 count）
  // 两者都缺省视为非法请求；计数只走索引 count/countByGroup，不 getAll 反序列化整表，避免大数据量下整表读取 + 大对象分配
  async getStats(sendResponse, msg) {
    try {
      const buildDomainStats = async (domain) => {
        const ds = domainStore.facade(domain);
        const groups = await ds.getGroups();
        const total = await ds.count();
        const groupCounts = { all: total };
        await Promise.all(
          (groups || []).map(async (g) => {
            if (g.id === "all") return;
            groupCounts[g.id] = await ds.countByGroup(g.id);
          }),
        );
        return { total, groupCounts };
      };
      const byteUsage = async () => (await storage.estimate()).usage;

      if (msg.bytesOnly) {
        sendResponse({ ok: true, stats: { bytes: await byteUsage() } });
        return;
      }

      const domainNames = new Set(Object.keys(DOMAIN_CONFIG));
      if (msg.domain && domainNames.has(msg.domain)) {
        // 按域收窄：只算当前域；不再捆绑存储估算（存储指示器走 bytesOnly 独立刷新）
        const stats = await buildDomainStats(msg.domain);
        sendResponse({ ok: true, stats: { [msg.domain]: stats } });
        return;
      }

      sendResponse({ ok: false, error: "BAD_PARAMS" });
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }
}
const dataTools = new DataTools();

export { dataTools };
