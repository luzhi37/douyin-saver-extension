// ---------- 作者视图核心（options / background 共用纯函数） ----------
// buildViewFromEntries：把索引键元组按 authorKey 分桶、簇内排序、作者簇排序。
// serveView：按作者簇顺序 + 簇内偏移切页，返回 next cursor（ai/off）供续页。
import { compareAuthorCluster, compareWorkInAuthor } from "./author-sort.js";

export function buildViewFromEntries(entries) {
  const map = new Map(); // authorKey -> [{ id, createTime, savedAt, awemeId }]
  for (const entry of entries) {
    if (!map.has(entry.key)) map.set(entry.key, []);
    map.get(entry.key).push({
      id: entry.awemeId,
      createTime: Number(entry.createTime) || 0,
      savedAt: Number(entry.savedAt) || 0,
      awemeId: entry.awemeId,
    });
  }

  const authors = [];
  for (const [key, list] of map) {
    list.sort(compareWorkInAuthor);
    authors.push({ key, ids: list.map((item) => item.id) });
  }
  authors.sort(compareAuthorCluster);

  return {
    total: authors.reduce((sum, author) => sum + author.ids.length, 0),
    authors,
  };
}

export function serveView(view, direction, ai, off, limit) {
  const list = direction === "asc" ? [...view.authors].reverse() : view.authors;
  const ids = [];
  let authorIndex = ai;
  let offset = off;

  while (authorIndex < list.length && ids.length < limit) {
    const cluster = list[authorIndex];
    while (offset < cluster.ids.length && ids.length < limit) {
      ids.push(cluster.ids[offset++]);
    }
    if (offset >= cluster.ids.length) {
      authorIndex++;
      offset = 0;
    }
  }

  const hasMore = authorIndex < list.length;
  return { ids, next: hasMore ? { ai: authorIndex, off: offset } : null };
}
