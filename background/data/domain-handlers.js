// background/data/domain-handlers.js — 域数据操作入口（5 实例：works/followings/favorites/collections/candidates）

import { CONFIG, DOMAIN_CONFIG, utils } from "../core.js";
import { storage } from "./storage.js";
import { domainStore } from "./domain-store.js";
import { authorViews } from "./author-views.js";

// 随机回顾抽样上限：单次响应保持可控（作品记录可能包含多图 URL）；本轮数量由用户
// 自定义，业务层钳制到 1–500。excludeIds 只保留最近 N 个，避免消息无界增长
const RANDOM_MAX_COUNT = 500;
const RANDOM_MAX_EXCLUDE = 2000;

// 部分 Fisher-Yates：只洗前 count 个，无偏且不复制整池
function pickRandomKeys(keys, count) {
  const n = Math.min(count, keys.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (keys.length - i));
    const tmp = keys[i];
    keys[i] = keys[j];
    keys[j] = tmp;
  }
  return keys.slice(0, n);
}

// ---------- DomainHandlers ----------
// 域数据操作的对外入口；save 按域分流（作品型三域 → mergeAndSave，作者域 → #saveAuthorRecords）
class DomainHandlers {
  #cfg;
  #domain;

  constructor(domain) {
    this.#cfg = DOMAIN_CONFIG[domain];
    this.#domain = domain;
  }

  // page=0 = 渐进加载首页；cursor = keyset 续页（上页末条索引键，开区间边界）。
  // 作者域两域单发全量（无 page/cursor）；作品型三域必须带 page 或 cursor。
  // ascending=true = 按 savedAt 升序从最旧一端分页（「保存时间(升)」排序用：页序即视图序，
  // options 侧可逐页续填、无需完成态整渲），返回页内仍为索引方向（升序块）。
  // 分页每次只物化单页记录（首屏 PAGE.GRID_FIRST、续页 PAGE.GRID，复合索引
  // savedAt_id / groupId_savedAt_id），不再全量读取+排序——万级分组的首页响应从数百毫秒
  // 降到几十毫秒
  async get({ groupId, page, cursor, ascending, sort, direction }, sendResponse) {
    try {
      if (sort === "authorCount") {
        if (CONFIG.AUTHOR_RECORD_DOMAINS.includes(this.#domain)) throw new Error("AUTHOR_PAGING_UNSUPPORTED");
        const payload = await authorViews.readPage({ domain: this.#domain, groupId, page, cursor, direction });
        sendResponse({
          [this.#cfg.itemKey]: payload.items,
          total: payload.total,
          hasMore: payload.hasMore,
          nextCursor: payload.nextCursor,
          ...(payload.authorMeta ? { authorMeta: payload.authorMeta } : {}),
        });
        return;
      }
      if (sort && sort !== "saved") throw new Error("BAD_SORT");
      const isAuthorDomain = CONFIG.AUTHOR_RECORD_DOMAINS.includes(this.#domain);
      if (isAuthorDomain) {
        // 作者域单发全量（无分页索引）：带分页参数显式报错，防止调用方误用后
        // 静默拿到整域载荷
        if (page === 0 || cursor) throw new Error("AUTHOR_PAGING_UNSUPPORTED");
        // 分组筛选走索引查询，否则全量读取；两条路径同一排序/返回。
        // savedAt 平级按 awemeId 降序，与 keyset 索引 prev 遍历、头插 viewOrderBefore
        // 以及作者视图的簇内末级 tie-break 保持同一口径
        const store =
          groupId && groupId !== "all"
            ? await storage.getByIndex(this.#cfg.storeName, "groupId", groupId)
            : await storage.getAll(this.#cfg.storeName);
        const list = Object.values(store);
        list.sort((a, b) => {
          const d = (b.savedAt || 0) - (a.savedAt || 0);
          if (d !== 0) return d;
          const ai = String(a.awemeId ?? "");
          const bi = String(b.awemeId ?? "");
          return ai < bi ? 1 : ai > bi ? -1 : 0;
        });
        sendResponse({ [this.#cfg.itemKey]: list });
        return;
      }
      // 作品型三域必须分页：首页 page:0、续页 cursor 二选一
      if (!(page === 0 || cursor)) throw new Error("BAD_PARAMS");
      sendResponse(await this.#readPaged(groupId, cursor || null, ascending === true));
    } catch (err) {
      sendResponse({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    }
  }

  // keyset 翻页：组内走 groupId_savedAt_id（键 = [groupId, savedAt, awemeId]）、
  // 「全部」走 savedAt_id（键 = [savedAt, awemeId]）。默认 prev 方向即 savedAt 降序；
  // ascending 走 next 方向、从索引下界（最旧）开始，页内为升序块。
  // 降序首页上界 [groupId, Infinity] 恰好罩住本组（Infinity 是合法 IDB 数值键且 savedAt
  // 恒有限）；续页以上页末键为开区间边界——索引键含主键全序唯一，同 savedAt 平级
  // 记录不丢失，并发增删不产生页间位移/重复
  async #readPaged(groupId, cursor, ascending) {
    const byGroup = Boolean(groupId && groupId !== "all");
    const indexName = byGroup ? "groupId_savedAt_id" : "savedAt_id";
    let range;
    if (ascending) {
      // 升序续页必须夹在本组上界内（lowerBound 全局起界会漏进后续分组的记录）
      range = byGroup
        ? cursor
          ? IDBKeyRange.bound(cursor, [groupId, Infinity], true, false)
          : IDBKeyRange.bound([groupId], [groupId, Infinity])
        : cursor
          ? IDBKeyRange.lowerBound(cursor, true)
          : null;
    } else if (byGroup) {
      range = cursor
        ? IDBKeyRange.bound([groupId], cursor, false, true)
        : IDBKeyRange.bound([groupId], [groupId, Infinity]);
    } else {
      range = cursor ? IDBKeyRange.upperBound(cursor, true) : null;
    }
    // 首屏（无 cursor）只物化小页 GRID_FIRST：切域首帧只等铺满活动窗口的条数，余页仍按
    // PAGE.GRID 续传——keyset 游标以末条索引键为边界，页大小可随时切换，hasMore/nextCursor
    // 与首页 total 语义不变
    const limit = cursor ? CONFIG.PAGE.GRID : CONFIG.PAGE.GRID_FIRST;
    const { items, hasMore, lastKey } = await storage.readIndexPage(
      this.#cfg.storeName,
      indexName,
      range,
      limit,
      ascending ? "next" : "prev",
    );
    const result = { [this.#cfg.itemKey]: items, hasMore, nextCursor: hasMore ? lastKey : null };
    if (!cursor) {
      // 首页附带 total：options 侧按它一次预铺全量骨架（余页按槽回填），需与分页读同一域
      result.total = byGroup
        ? await storage.countByIndex(this.#cfg.storeName, "groupId", groupId)
        : await storage.count(this.#cfg.storeName);
    }
    return result;
  }

  async delete(ids, sendResponse) {
    try {
      const keys = ids.map((id) => domainStore.toStorageId(this.#domain, id));
      await storage.deleteBatch(this.#cfg.storeName, keys);
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }

  async move(ids, targetGroupId, sendResponse) {
    try {
      const keys = ids.map((id) => domainStore.toStorageId(this.#domain, id));
      const items = await storage.getBatch(this.#cfg.storeName, keys);
      const toWrite = items.filter(Boolean).map((item) => ({ ...item, groupId: targetGroupId }));
      if (toWrite.length > 0) await storage.putBatch(this.#cfg.storeName, toWrite);
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }

  // save 必须域驱动：works/favorites/collections → domainStore.mergeAndSave；作者域 → #saveAuthorRecords
  async save(items, sendResponse) {
    if (CONFIG.AUTHOR_RECORD_DOMAINS.includes(this.#domain)) return this.#saveAuthorRecords(items, sendResponse);
    const result = await domainStore.mergeAndSave(this.#domain, items);
    // 内容真有变化才广播：重复添加已有且字段全等的作品是 no-op，不该让 options 重载网格。
    // 变化条数少于阈值时携带合并后记录（upserts/addedIds），options 局部应用——单发保存
    // （抖音标签页「保存」按钮）的真实变化从整网重载降为 O(1)；批量变化仍发无载荷广播整刷收口
    if (result.changed > 0) this.#broadcastStoreChanged(result.written, result.addedIds);
    const { written, addedIds, ...counts } = result;
    // 单作品保存（抖音标签页「添加」按钮）回读落库记录与分组名：added=0 即作品已在域，
    // 配 groupName 让该处 toast 能提示「已存在 / 位于哪个组」。批量保存跨分组、无单一
    // 分组可言，不回传。单键 + 小列表读取代价可忽略
    let groupName;
    const valid = (items || []).filter((w) => w && w[this.#cfg.idField]);
    if (valid.length === 1) {
      const [saved, groupList] = await Promise.all([
        storage.get(this.#cfg.storeName, valid[0][this.#cfg.idField]),
        storage.getGroups(this.#cfg.groupsName),
      ]);
      const groups = groupList.length ? groupList : this.#cfg.defaultGroups;
      groupName = groups.find((g) => g.id === (saved?.groupId || CONFIG.GROUPS.DEFAULT_ID))?.name || "未分组";
    }
    sendResponse({ ok: true, ...counts, ...(groupName ? { groupName } : {}) });
  }

  async #saveAuthorRecords(items, sendResponse) {
    // 导入路径（分组还原语义）由 dataTools 直调 mergeAndSaveAuthors(…, true)，不经此处
    const result = await domainStore.mergeAndSaveAuthors(this.#domain, items);
    // 作者域不走点载荷：网格无单卡更新原语，且作者域变化低频，整刷成本可接受
    if (result.changed > 0) this.#broadcastStoreChanged();
    sendResponse({ ok: true, ...result });
  }

  // 落库成功后广播存储变更（发送方可能是抖音标签页等外部上下文，options 页不在
  // 请求链路上）：changed ≤ BROADCAST.UPSERTS_MAX 时附带合并后记录与新增 id 集合供
  // options 局部应用，超过则发无载荷广播走整刷。无接收方时 sendMessageSafe 静默吞掉
  #broadcastStoreChanged(written = [], addedIds = []) {
    const message = { type: "STORE_CHANGED", domain: this.#domain };
    if (written.length > 0 && written.length <= CONFIG.BROADCAST.UPSERTS_MAX) {
      message.upserts = written;
      message.addedIds = addedIds;
    }
    utils.sendMessageSafe(message);
  }

  // 全部主键（作者域主键即 uid）：作者域成员资格集合的轻量通道——getAllKeys 不反序列化
  // 记录值，作品卡作者状态 chip 只需 uid 集、禁止为此拉全量记录（万级头像/计数载荷膨胀）
  async getAllKeys() {
    return storage.getAllKeys(this.#cfg.storeName);
  }

  // 随机回顾抽样：只取主键 + 最多 count 条完整记录，不物化整域；excludeIds 为本回顾会话
  // 已出现过的记录，避免「换一批」重复。返回 poolSize/eligible/remaining 供 options 判断
  // 是否已无更多可回顾数据
  async pickRandom({ groupId, count, excludeIds }, sendResponse) {
    try {
      const limit = Math.max(1, Math.min(RANDOM_MAX_COUNT, Math.floor(Number(count) || 20)));
      const exclude = new Set(
        (Array.isArray(excludeIds) ? excludeIds : [])
          .slice(-RANDOM_MAX_EXCLUDE)
          .map((id) => String(domainStore.toStorageId(this.#domain, id))),
      );
      const byGroup = Boolean(groupId && groupId !== "all");
      const keys = byGroup
        ? await storage.getAllKeysByIndex(this.#cfg.storeName, "groupId", IDBKeyRange.only(groupId))
        : await storage.getAllKeys(this.#cfg.storeName);
      const eligibleKeys = keys.filter((key) => !exclude.has(String(key)));
      const picks = pickRandomKeys(eligibleKeys, limit);
      const records = await storage.getBatch(this.#cfg.storeName, picks);
      const items = records.filter(Boolean);
      sendResponse({
        ok: true,
        items,
        poolSize: keys.length,
        eligible: eligibleKeys.length,
        remaining: Math.max(0, eligibleKeys.length - items.length),
      });
    } catch (err) {
      sendResponse({ error: err.message || String(err) });
    }
  }

  // 按 id 集合直取记录（IDB 主键 getBatch 单事务批量读）：bulk STORE_CHANGED 收口的补拉通道——
  // 广播只携带轻量 id 列表（万级 ≈ 几十 KB，规避全记录消息膨胀），options 据此拉取
  // 合并后记录，走与点载荷相同的局部应用管线，替代整域重载
  async getByIds(ids, sendResponse) {
    try {
      const keys = (ids || []).map((id) => domainStore.toStorageId(this.#domain, id));
      const items = await storage.getBatch(this.#cfg.storeName, keys);
      sendResponse({ items: items.filter(Boolean) });
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }
}
const worksHandlers = new DomainHandlers(CONFIG.STORAGE_KEYS.WORKS);
const followingsHandlers = new DomainHandlers(CONFIG.STORAGE_KEYS.FOLLOWINGS);
const favoritesHandlers = new DomainHandlers(CONFIG.STORAGE_KEYS.FAVORITES);
const collectionsHandlers = new DomainHandlers(CONFIG.STORAGE_KEYS.COLLECTIONS);
const candidatesHandlers = new DomainHandlers(CONFIG.STORAGE_KEYS.CANDIDATES);

export { worksHandlers, followingsHandlers, favoritesHandlers, collectionsHandlers, candidatesHandlers };
