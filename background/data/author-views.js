// ---------- AuthorViews（作者数排序：索引键扫描 + SW 内存视图） ----------
// 视图只存在 Service Worker 内存：token / epoch / rev 失效由 storage 的写入代际与
// 本模块的 EPOCH 共同决定。任何写入都会让 rev 前进；续页读到旧 rev 返回 VIEW_EXPIRED，
// options 整轮重载，禁止静默错序或跨组记录。
import { CONFIG, DOMAIN_CONFIG } from "../core.js";
import { storage } from "./storage.js";
import { buildViewFromEntries, serveView } from "../../shared/author-view-core.js";
import { authorKeyOf } from "../../shared/author-sort.js";

const EPOCH = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;

function fail(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function normalizeDirection(direction) {
  if (direction == null) return "desc";
  if (direction === "desc" || direction === "asc") return direction;
  throw fail("BAD_CURSOR");
}

class AuthorViews {
  #epoch = EPOCH;
  #seq = 0;
  #current = new Map(); // `${domain}|${groupId}` -> token
  #views = new Map(); // token -> view
  #building = new Map(); // `${domain}|${groupId}|${rev}` -> Promise

  async ensure(domain, groupId) {
    const cfg = DOMAIN_CONFIG[domain];
    if (!cfg) throw fail("BAD_DOMAIN");
    const rev = storage.getRevision(cfg.storeName);
    const view = this.#views.get(this.#current.get(`${domain}|${groupId}`));
    if (view && view.rev === rev) return view;
    return this.#buildOnce(domain, groupId, rev);
  }

  async #buildOnce(domain, groupId, rev) {
    const key = `${domain}|${groupId}|${rev}`;
    const pending = this.#building.get(key);
    if (pending) return pending;
    const promise = this.#build(domain, groupId, rev, false).finally(() => this.#building.delete(key));
    this.#building.set(key, promise);
    return promise;
  }

  async #build(domain, groupId, rev, retried) {
    const cfg = DOMAIN_CONFIG[domain];
    const raw = await this.#scanIndex(cfg.storeName, groupId);
    // 构建期间写入 → 视图从快照看是“偏旧”的；丢弃并按最新 rev 重建一次。
    // rev 只允许偏旧，不允许“旧快照 + 新 rev”（后者会让脏视图被当成最新接受）
    const latest = storage.getRevision(cfg.storeName);
    if (latest !== rev && !retried) return this.#build(domain, groupId, latest, true);

    const emptyUidEntries = raw.filter((e) => !e.uid);
    let keyById = null;
    if (emptyUidEntries.length > 0) {
      // uid="" 的记录按 authorKeyOf（uid || nickname）语义归组；索引只能按键值 uid
      // 聚合，故仅对这一小段读记录值兜底
      const records = await storage.getBatch(
        cfg.storeName,
        emptyUidEntries.map((e) => e.awemeId),
      );
      keyById = new Map();
      for (const record of records) {
        if (record) keyById.set(String(record.awemeId), authorKeyOf(record));
      }
    }
    const entries = raw.map((e) => ({
      key: e.uid || keyById?.get(String(e.awemeId)) || "",
      createTime: e.createTime,
      savedAt: e.savedAt,
      awemeId: e.awemeId,
    }));
    const viewData = buildViewFromEntries(entries);

    const expected =
      groupId === "all"
        ? await storage.count(cfg.storeName)
        : await storage.countByIndex(cfg.storeName, "groupId", groupId);
    const latest2 = storage.getRevision(cfg.storeName);
    if (latest2 !== rev && !retried) return this.#build(domain, groupId, latest2, true);
    if (viewData.total !== expected) {
      // 索引项与记录数不一致：通常是历史数据缺 uid/createTime 且回填未生效。
      // 不返回残缺视图（会让作者数排序静默丢作品），由 options 降级 saved 分页
      console.warn("[DDM] author view incomplete:", domain, groupId, viewData.total, expected);
      throw fail("AUTHOR_VIEW_INCOMPLETE");
    }

    const token = `${this.#epoch}:${++this.#seq}`;
    const view = {
      token,
      domain,
      groupId,
      rev,
      total: viewData.total,
      authors: viewData.authors,
      builtAt: Date.now(),
    };
    const mapKey = `${domain}|${groupId}`;
    const oldToken = this.#current.get(mapKey);
    if (oldToken) this.#views.delete(oldToken);
    this.#current.set(mapKey, token);
    this.#views.set(token, view);
    this.#trim();
    return view;
  }

  #scanIndex(storeName, groupId) {
    const keyRows = [];
    // 不能用 [groupId, Infinity] 做 uid 上界：IDB 键序 number < string，Infinity 会
    // 排在所有 uid 字符串之前。lowerBound([groupId]) + 分组边界提前停止是稳妥写法
    const range = groupId === "all" ? null : IDBKeyRange.lowerBound([groupId]);
    return storage
      .scanIndexKeys(storeName, "groupId_uid_sort", {
        range,
        onKey: (key, primaryKey) => {
          const gid = key[0];
          if (groupId !== "all" && gid !== groupId) return false;
          keyRows.push({
            uid: typeof key[1] === "string" ? key[1] : String(key[1] ?? ""),
            createTime: key[2],
            savedAt: key[3],
            awemeId: primaryKey,
          });
          return true;
        },
      })
      .then(() => keyRows);
  }

  #trim() {
    while (this.#views.size > CONFIG.AUTHOR_VIEW_CACHE_MAX) {
      const oldest = this.#views.keys().next().value;
      this.#views.delete(oldest);
      for (const [mapKey, token] of this.#current) {
        if (token === oldest) {
          this.#current.delete(mapKey);
          break;
        }
      }
    }
  }

  async #getRecords(storeName, ids) {
    if (ids.length === 0) return [];
    const records = await storage.getBatch(storeName, ids);
    const items = records.filter(Boolean);
    if (items.length !== ids.length) {
      // rev 已校验，正常不应发生；留痕便于定位索引/写入路径异常
      console.warn("[DDM] author view records missing:", storeName, ids.length - items.length);
    }
    return items;
  }

  async readPage({ domain, groupId, page, cursor, direction }) {
    const cfg = DOMAIN_CONFIG[domain];
    if (!cfg) throw fail("BAD_DOMAIN");
    const gid = groupId || "all";
    const dir = normalizeDirection(direction);
    const limitFirst = CONFIG.PAGE.GRID_FIRST;
    const limit = CONFIG.PAGE.GRID;

    if (!cursor) {
      if (page != null && page !== 0) throw fail("BAD_CURSOR");
      const view = await this.ensure(domain, gid);
      if (storage.getRevision(cfg.storeName) !== view.rev) throw fail("VIEW_EXPIRED");
      const { ids, next } = serveView(view, dir, 0, 0, limitFirst);
      const items = await this.#getRecords(cfg.storeName, ids);
      return {
        items,
        total: view.total,
        hasMore: Boolean(next),
        nextCursor: next ? { token: view.token, dir, ...next } : null,
        authorMeta: view.authors.map((author) => [author.key, author.ids.length]),
      };
    }

    if (typeof cursor !== "object") throw fail("BAD_CURSOR");
    if (direction && cursor.dir !== direction) throw fail("BAD_CURSOR");
    const cursorDir = normalizeDirection(cursor.dir);
    const ai = Number(cursor.ai);
    const off = Number(cursor.off);
    if (!cursor.token || !Number.isInteger(ai) || ai < 0 || !Number.isInteger(off) || off < 0) {
      throw fail("BAD_CURSOR");
    }
    const view = this.#views.get(cursor.token);
    if (!view || view.domain !== domain || view.groupId !== gid) throw fail("VIEW_EXPIRED");
    if (storage.getRevision(cfg.storeName) !== view.rev) throw fail("VIEW_EXPIRED");
    const { ids, next } = serveView(view, cursorDir, ai, off, limit);
    const items = await this.#getRecords(cfg.storeName, ids);
    return {
      items,
      total: view.total,
      hasMore: Boolean(next),
      nextCursor: next ? { token: view.token, dir: cursorDir, ...next } : null,
    };
  }
}

export const authorViews = new AuthorViews();
