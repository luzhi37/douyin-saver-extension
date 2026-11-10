// background/data/storage.js — IndexedDB 封装层（class Storage + 单例）

import { CONFIG, DOMAIN_CONFIG } from "../core.js";

const DB_NAME = "douyin-saver";
const DB_VERSION = 12;
// v10 的独立计数表名：仅用于 v10→v11 迁移读取/删除，现行计数已并入各 *_groups.count
const LEGACY_GROUP_COUNTS_STORE = "group_counts";
// 有 groupId 语义的数据 store（作者域/回顾域同样需要分组计数）
const DATA_STORES = new Set(["works", "favorites", "collections", "followings", "candidates", "review"]);

const STORES = {
  works: {
    keyPath: "awemeId",
    indexes: ["groupId", "savedAt_id", "groupId_savedAt_id", "groupId_uid_sort"],
  },
  works_groups: { keyPath: "id" },
  followings: { keyPath: "uid", indexes: ["groupId"] },
  followings_groups: { keyPath: "id" },
  favorites: {
    keyPath: "awemeId",
    indexes: ["groupId", "savedAt_id", "groupId_savedAt_id", "groupId_uid_sort"],
  },
  favorites_groups: { keyPath: "id" },
  collections: {
    keyPath: "awemeId",
    indexes: ["groupId", "savedAt_id", "groupId_savedAt_id", "groupId_uid_sort"],
  },
  collections_groups: { keyPath: "id" },
  candidates: { keyPath: "uid", indexes: ["groupId"] },
  candidates_groups: { keyPath: "id" },
  // 回顾域只存引用：reviewId 为 `${batchId}:${sourceId}`，sourceId 回源域取完整记录
  review: { keyPath: "reviewId", indexes: ["groupId"] },
  review_groups: { keyPath: "id" },
};

// 复合索引名 → keyPath（其余同名同路径）。尾部拼主键使索引键全序唯一：
// keyset 翻页的开区间上界不会丢掉同 savedAt 的平级记录（同毫秒批量导入是真实场景）。
// groupId_uid_sort 供作者数安全排序视图：只读索引键即可完成“作者分桶 + 簇内排序”，
// 不反序列化作品记录值（字段类型必须稳定：uid/groupId/awemeId 为字符串、时间为数字）
const INDEX_KEY_PATHS = {
  savedAt_id: ["savedAt", "awemeId"],
  groupId_savedAt_id: ["groupId", "savedAt", "awemeId"],
  groupId_uid_sort: ["groupId", "uid", "createTime", "savedAt", "awemeId"],
};

// v3/v9 升级回填：savedAt/groupId 是 keyset 翻页索引依赖字段；uid/createTime 是
// groupId_uid_sort 索引的分量。IndexedDB 对缺失 keyPath 分量的记录不会建索引项——
// 任一分量缺失都会让该记录在作者数视图中“消失”，故升级时一次性补齐/归一化。
// v12 起同游标顺带剔除已废弃的标题字段（desc），旧库升级即清理，已完整的记录零写入
function backfillPagingKeys(tx, db) {
  const now = Date.now();
  for (const name of ["works", "favorites", "collections"]) {
    if (!db.objectStoreNames.contains(name)) continue;
    const store = tx.objectStore(name);
    store.openCursor().onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return;
      const w = cursor.value;
      const createTime = Number(w.createTime) || 0;
      const uid = typeof w.uid === "string" ? w.uid : String(w.uid ?? "");
      const savedAt = Number(w.savedAt) || (createTime ? createTime * 1000 : now);
      const groupId = w.groupId ? String(w.groupId) : CONFIG.GROUPS.DEFAULT_ID;
      const hasTitle = "desc" in w;
      if (
        !hasTitle &&
        w.savedAt === savedAt &&
        w.groupId === groupId &&
        w.uid === uid &&
        w.createTime === createTime
      ) {
        cursor.continue();
        return;
      }
      const next = { ...w, savedAt, groupId, uid, createTime };
      delete next.desc;
      cursor.update(next);
      cursor.continue();
    };
  }
}

// v11 升级：把分组计数并入各 *_groups.count，并删除 v10 的 group_counts 表。
// 只跑一次（oldVersion<11）；计数直接扫描数据 store 得到（groupId 缺失按默认组），
// 同时确保固定默认分组存在。之后所有写入经 putBatch/deleteBatch/clear 同事务维护
function backfillGroupCountsIntoGroups(tx, db, oldVersion) {
  if (oldVersion >= 11) return;
  let pending = 0;
  const finish = () => {
    if (db.objectStoreNames.contains(LEGACY_GROUP_COUNTS_STORE)) {
      try {
        db.deleteObjectStore(LEGACY_GROUP_COUNTS_STORE);
      } catch {
        /* 已被删除/被占用：忽略 */
      }
    }
  };
  for (const name of DATA_STORES) {
    const cfg = DOMAIN_CONFIG[name];
    if (!cfg || !db.objectStoreNames.contains(name) || !db.objectStoreNames.contains(cfg.groupsName)) {
      continue;
    }
    pending++;
    const dataStore = tx.objectStore(name);
    const groupsStore = tx.objectStore(cfg.groupsName);
    const counts = new Map();
    const cursorReq = dataStore.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        const value = cursor.value;
        const groupId = value.groupId ? String(value.groupId) : CONFIG.GROUPS.DEFAULT_ID;
        counts.set(groupId, (counts.get(groupId) || 0) + 1);
        cursor.continue();
        return;
      }
      const groupsReq = groupsStore.getAll();
      groupsReq.onsuccess = () => {
        const byId = new Map();
        for (const g of groupsReq.result || []) byId.set(g.id, { ...g, count: 0 });
        for (const def of cfg.defaultGroups) {
          if (!byId.has(def.id)) byId.set(def.id, { ...def, count: 0 });
        }
        let total = 0;
        for (const [groupId, count] of counts) {
          if (groupId === "all") continue;
          if (!byId.has(groupId)) {
            byId.set(groupId, { id: groupId, name: groupId, fixed: false, order: byId.size, count: 0 });
          }
          byId.get(groupId).count = count;
          total += count;
        }
        for (const g of byId.values()) {
          if (g.id === "all") g.count = total;
          groupsStore.put(g);
        }
        if (--pending === 0) finish();
      };
    };
  }
  if (pending === 0) finish();
}

// ---------- Storage ----------
// IndexedDB 封装层；单例连接以 #db 私有字段持有（首次打开后缓存 Promise）。
class Storage {
  #db = null;
  // 作品型三域的写入代际：SW 生命周期内有效（重启后归零，AuthorViews 内存视图同时清空）。
  // 必须在写事务 oncomplete 之后自增——读取方先取 rev 再开 readonly 事务，允许“视图偏旧”，
  // 禁止“旧快照 + 新 rev”的错误标记
  #revisions = new Map();

  getRevision(storeName) {
    return this.#revisions.get(storeName) || 0;
  }

  #bumpRevision(storeName) {
    if (!CONFIG.WORK_RECORD_DOMAINS.includes(storeName)) return;
    this.#revisions.set(storeName, this.getRevision(storeName) + 1);
  }

  #groupOf(record) {
    return record && record.groupId ? String(record.groupId) : CONFIG.GROUPS.DEFAULT_ID;
  }

  #addDelta(deltas, groupId, delta) {
    deltas.set(groupId, (deltas.get(groupId) || 0) + delta);
  }

  // 在写事务内把分组计数增量写回各 *_groups 的 count 字段；all 的 count 由净增量维护。
  // 缺失分组记录（历史 orphan）按默认组定义或 id 兜底创建，避免计数静默丢失
  #applyCountDeltas(tx, storeName, deltas) {
    if (deltas.size === 0) return;
    const cfg = DOMAIN_CONFIG[storeName];
    if (!cfg || !cfg.groupsName) return;
    const groupStore = tx.objectStore(cfg.groupsName);
    let net = 0;
    const updateGroup = (groupId, delta) => {
      if (!delta || groupId === "all") return;
      const req = groupStore.get(groupId);
      req.onsuccess = () => {
        let record = req.result;
        if (!record) {
          const def = cfg.defaultGroups.find((g) => g.id === groupId);
          record = def
            ? { ...def, count: 0 }
            : { id: groupId, name: groupId, fixed: false, order: 9999, count: 0 };
        }
        const next = (record.count || 0) + delta;
        if (next < 0) console.warn("[DDM] group count underflow:", storeName, groupId, next);
        record.count = Math.max(0, next);
        groupStore.put(record);
      };
    };
    for (const [groupId, delta] of deltas) {
      net += delta;
      updateGroup(groupId, delta);
    }
    if (net !== 0) {
      const req = groupStore.get("all");
      req.onsuccess = () => {
        let record = req.result;
        if (!record) {
          const def = cfg.defaultGroups.find((g) => g.id === "all");
          record = def
            ? { ...def, count: 0 }
            : { id: "all", name: "全部", fixed: true, order: 0, count: 0 };
        }
        record.count = Math.max(0, (record.count || 0) + net);
        groupStore.put(record);
      };
    }
  }

  // 清空某域所有分组计数（clear/RESET 同事务调用）
  #resetGroupCounts(tx, groupsName) {
    const groupStore = tx.objectStore(groupsName);
    const req = groupStore.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const group = cursor.value;
      if (group.count !== 0) {
        group.count = 0;
        cursor.update(group);
      }
      cursor.continue();
    };
  }

  #openDB() {
    if (this.#db) return this.#db;
    this.#db = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        const tx = e.target.transaction;
        // store 名即域键终态（favorites=点赞、collections=收藏，与 API 关键词一致），此版本
        // 起不再携带改名迁移——低版本旧库升上来时旧 store 不会改名，数据将不可见（升级前
        // 务必先在旧版导出备份）。将来若再改 store 名，必须配套升级迁移块。
        for (const [name, cfg] of Object.entries(STORES)) {
          // 已存在的 store（版本升级）经升级事务取出，补建后加的索引；新建 store 直接持引用
          const store = db.objectStoreNames.contains(name)
            ? tx.objectStore(name)
            : db.createObjectStore(name, { keyPath: cfg.keyPath });
          for (const idx of cfg.indexes || []) {
            if (!store.indexNames.contains(idx)) {
              store.createIndex(idx, INDEX_KEY_PATHS[idx] || idx, { unique: false });
            }
          }
        }
        // v6 历史版本曾引入 works.uid 索引（作者存在性集合查询），该方案已裁撤——现行
        // STORES 不含 uid，自动补建循环不再覆盖；此处对曾升到 v6 的库幂等删净（新库无此索引）
        if (db.objectStoreNames.contains("works")) {
          const worksStore = tx.objectStore("works");
          if (worksStore.indexNames.contains("uid")) worksStore.deleteIndex("uid");
        }
        backfillPagingKeys(tx, db);
        backfillGroupCountsIntoGroups(tx, db, e.oldVersion);
      };
      req.onblocked = () => {
        console.warn(
          "[DDM] IndexedDB upgrade blocked: close old extension pages/tabs or reload the extension",
        );
      };
      req.onsuccess = () => {
        const db = req.result;
        // 其他上下文升版本时主动让路：否则旧 options/SW 连接会阻塞下一次 DB 升级
        db.onversionchange = () => {
          console.warn("[DDM] IndexedDB versionchange: closing old connection");
          db.close();
          this.#db = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        this.#db = null;
        reject(req.error);
      };
    });
    return this.#db;
  }

  // 对象数组 → key→value 映射
  #toMap(items, keyField) {
    const map = {};
    for (const item of items) {
      if (item[keyField]) map[item[keyField]] = item;
    }
    return map;
  }

  async getAll(storeName) {
    const db = await this.#openDB();
    const keyField = STORES[storeName].keyPath;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(this.#toMap(req.result, keyField));
      req.onerror = () => reject(req.error);
    });
  }

  async get(storeName, key) {
    const db = await this.#openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  // 批量主键读取：单事务内发全部 get，结果与入参 keys 严格按下标对位（缺失为 null）。
  // 消灭「Promise.all 逐条 get」每条一事务的模式——万级批量读的事务开销 O(N)→O(1)。
  // 空键集直接返回空数组不开事务
  async getBatch(storeName, keys) {
    if (!keys || keys.length === 0) return [];
    const db = await this.#openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const results = new Array(keys.length);
      keys.forEach((key, i) => {
        const req = store.get(key);
        req.onsuccess = () => {
          results[i] = req.result || null;
        };
      });
      tx.oncomplete = () => resolve(results);
      tx.onerror = () => reject(tx.error);
    });
  }

  // 仅取全部主键（丢失检测等键集差场景）：不反序列化记录值，替代 getAll 后只取 keys 的用法
  async getAllKeys(storeName) {
    const db = await this.#openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  // 按索引区间取主键集合（不物化记录值）：随机回顾按来源域/分组抽样用
  async getAllKeysByIndex(storeName, indexName, range = null) {
    const db = await this.#openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const index = tx.objectStore(storeName).index(indexName);
      const req = range ? index.getAllKeys(range) : index.getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  // 数据写事务统一骨架：同一事务内维护 *_groups.count，提交后 bumpRevision。
  // 请求级失败走 fail(err)：保持「拒绝 Promise 但不中止事务」的既有语义
  //（不引入 tx.abort()，避免改变半提交时的可见行为）。
  #writeTx(storeName, mutate) {
    const groupsName = DOMAIN_CONFIG[storeName].groupsName;
    return this.#openDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction([storeName, groupsName], "readwrite");
          mutate({ tx, store: tx.objectStore(storeName), groupsName, fail: reject });
          tx.oncomplete = () => {
            this.#bumpRevision(storeName);
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        }),
    );
  }

  async putBatch(storeName, items) {
    if (!DATA_STORES.has(storeName)) throw new Error("putBatch: unknown data store " + storeName);
    // 同一 key 的重复 put 收敛为最后一条，避免计数被重复 +1
    const keyPath = STORES[storeName].keyPath;
    const unique = new Map();
    for (const item of items) {
      if (item && item[keyPath] != null) unique.set(item[keyPath], item);
    }
    if (unique.size === 0) return;
    return this.#writeTx(storeName, ({ tx, store, fail }) => {
      const deltas = new Map();
      let pending = unique.size;
      for (const item of unique.values()) {
        const req = store.get(item[keyPath]);
        req.onsuccess = () => {
          const old = req.result;
          const nextGroup = this.#groupOf(item);
          if (!old) {
            this.#addDelta(deltas, nextGroup, 1);
          } else {
            const prevGroup = this.#groupOf(old);
            if (prevGroup !== nextGroup) {
              this.#addDelta(deltas, prevGroup, -1);
              this.#addDelta(deltas, nextGroup, 1);
            }
          }
          store.put(item);
          if (--pending === 0) this.#applyCountDeltas(tx, storeName, deltas);
        };
        req.onerror = () => fail(req.error);
      }
    });
  }

  async deleteBatch(storeName, keys) {
    if (!DATA_STORES.has(storeName)) throw new Error("deleteBatch: unknown data store " + storeName);
    const unique = [...new Set(keys)];
    if (unique.length === 0) return;
    return this.#writeTx(storeName, ({ tx, store, fail }) => {
      const deltas = new Map();
      let pending = unique.length;
      for (const key of unique) {
        const req = store.get(key);
        req.onsuccess = () => {
          const old = req.result;
          if (old) this.#addDelta(deltas, this.#groupOf(old), -1);
          store.delete(key);
          if (--pending === 0) this.#applyCountDeltas(tx, storeName, deltas);
        };
        req.onerror = () => fail(req.error);
      }
    });
  }

  async clear(storeName) {
    if (!DATA_STORES.has(storeName)) throw new Error("clear: unknown data store " + storeName);
    return this.#writeTx(storeName, ({ tx, store, groupsName }) => {
      store.clear();
      this.#resetGroupCounts(tx, groupsName);
    });
  }

  // 索引键游标扫描：不反序列化记录值，逐条回调 (indexKey, primaryKey)。
  // onKey 返回 false 提前结束（分组边界）；空索引/越界范围直接 resolve
  async scanIndexKeys(storeName, indexName, { range = null, direction = "next", onKey } = {}) {
    const db = await this.#openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).index(indexName).openKeyCursor(range, direction);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve();
          return;
        }
        if (onKey(cursor.key, cursor.primaryKey) === false) {
          resolve();
          return;
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async count(storeName) {
    const db = await this.#openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async getByIndex(storeName, indexName, value) {
    const db = await this.#openDB();
    const keyField = STORES[storeName].keyPath;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).index(indexName).getAll(value);
      req.onsuccess = () => resolve(this.#toMap(req.result, keyField));
      req.onerror = () => reject(req.error);
    });
  }

  // 索引 keyset 翻页：direction 方向迭代取 limit 条，多读 1 条探测 hasMore（不物化进结果）。
  // 默认 "prev"（索引键降序，即 savedAt 降序）；"next" 供升序保存时间（从最旧一端分页）。
  // 返回 { items, hasMore, lastKey }，lastKey 为末条索引键（复合键含主键，全序唯一），
  // 调用方作下页开区间边界回传——并发增删不产生页间位移/重复
  async readIndexPage(storeName, indexName, range, limit, direction = "prev") {
    const db = await this.#openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).index(indexName).openCursor(range, direction);
      const items = [];
      let lastKey = null;
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve({ items, hasMore: false, lastKey });
          return;
        }
        if (items.length >= limit) {
          resolve({ items, hasMore: true, lastKey });
          return; // 不再 continue，事务随无挂起请求自动结束
        }
        items.push(cursor.value);
        lastKey = cursor.key;
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async countByIndex(storeName, indexName, value) {
    const db = await this.#openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).index(indexName).count(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // 分组表 + 计数：计数已并入 groups.count，读取只需 groups 一张小表。
  // total 取非 all 分组计数之和（对账口径与 tab 数字一致）
  async getGroupsWithStats(groupsName) {
    const groups = await this.getGroups(groupsName);
    const counts = {};
    let total = 0;
    for (const group of groups) {
      if (group.id === "all") continue;
      const count = Number(group.count) || 0;
      counts[group.id] = count;
      total += count;
    }
    counts.all = total;
    return { groups, counts, total };
  }

  // groups 专用：返回数组
  async getGroups(storeName) {
    const db = await this.#openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  // groups 专用：覆盖整个数组。计数按 id 保留已有值（分组改名/排序/删除不重置计数）；
  // 新分组初始化为 0；resetCounts=true 用于 RESET_DOMAIN 全量清零。
  // 不从入参读取 count——导入 JSON 里的派生计数不可信
  async putGroups(storeName, groups, { resetCounts = false } = {}) {
    const db = await this.#openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const existingReq = store.getAll();
      existingReq.onsuccess = () => {
        const existingCounts = new Map(
          (existingReq.result || []).map((g) => [g.id, Number(g.count) || 0]),
        );
        store.clear();
        for (const g of groups) {
          const count = resetCounts ? 0 : existingCounts.get(g.id) ?? 0;
          store.put({ ...g, count });
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async estimate() {
    return navigator.storage.estimate();
  }
}
const storage = new Storage();

export { storage };
