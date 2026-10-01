// background/data/storage.js — IndexedDB 封装层（class Storage + 单例）

import { CONFIG } from "../core.js";

const DB_NAME = "douyin-saver";
const DB_VERSION = 3;

const STORES = {
  works: { keyPath: "awemeId", indexes: ["groupId", "savedAt_id", "groupId_savedAt_id"] },
  works_groups: { keyPath: "id" },
  followings: { keyPath: "uid", indexes: ["groupId"] },
  followings_groups: { keyPath: "id" },
  likes: { keyPath: "awemeId", indexes: ["groupId", "savedAt_id", "groupId_savedAt_id"] },
  likes_groups: { keyPath: "id" },
  favorites: { keyPath: "awemeId", indexes: ["groupId", "savedAt_id", "groupId_savedAt_id"] },
  favorites_groups: { keyPath: "id" },
};

// 复合索引名 → keyPath（其余同名同路径）。尾部拼主键使索引键全序唯一：
// keyset 翻页的开区间上界不会丢掉同 savedAt 的平级记录（同毫秒批量导入是真实场景）
const INDEX_KEY_PATHS = {
  savedAt_id: ["savedAt", "awemeId"],
  groupId_savedAt_id: ["groupId", "savedAt", "awemeId"],
};

// v3 升级回填：savedAt/groupId 是网格 keyset 翻页索引的依赖字段，老记录缺失会被复合
// 索引静默跳过（分页查询不可见）。savedAt 缺失按 createTime（Unix 秒）推导、兜底当前
// 时间；groupId 缺失归「未分组」。仅写缺失记录，存量完整时零写入
function backfillPagingKeys(tx, db) {
  const now = Date.now();
  for (const name of ["works", "likes", "favorites"]) {
    if (!db.objectStoreNames.contains(name)) continue;
    const store = tx.objectStore(name);
    store.openCursor().onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return;
      const w = cursor.value;
      if (w.savedAt && w.groupId) {
        cursor.continue();
        return;
      }
      cursor.update({
        ...w,
        savedAt: w.savedAt || (w.createTime ? w.createTime * 1000 : now),
        groupId: w.groupId || CONFIG.GROUPS.DEFAULT_ID,
      });
      cursor.continue();
    };
  }
}

// ---------- Storage ----------
// IndexedDB 封装层；单例连接以 #db 私有字段持有（首次打开后缓存 Promise）。
class Storage {
  #db = null;

  #openDB() {
    if (this.#db) return this.#db;
    this.#db = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        const tx = e.target.transaction;
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
        backfillPagingKeys(tx, db);
      };
      req.onsuccess = () => resolve(req.result);
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
      if (item?.[keyField]) map[item[keyField]] = item;
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

  async putBatch(storeName, items) {
    const db = await this.#openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      for (const item of items) store.put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async deleteBatch(storeName, keys) {
    const db = await this.#openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      for (const key of keys) store.delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async clear(storeName) {
    const db = await this.#openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
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

  // 索引 keyset 翻页：prev 方向迭代取 limit 条，多读 1 条探测 hasMore（不物化进结果）。
  // 返回 { items, hasMore, lastKey }，lastKey 为末条索引键（复合键含主键，全序唯一），
  // 调用方作下页开区间上界回传——并发增删不产生页间位移/重复
  async readIndexPage(storeName, indexName, range, limit) {
    const db = await this.#openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).index(indexName).openCursor(range, "prev");
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

  // groups 专用：覆盖整个数组
  async putGroups(storeName, groups) {
    const db = await this.#openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).clear();
      for (const g of groups) tx.objectStore(storeName).put(g);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async estimate() {
    if (navigator.storage?.estimate) {
      return navigator.storage.estimate();
    }
    return null;
  }
}
const storage = new Storage();

export { storage };
