// ---------- 六域事实表（background / options 单一来源） ----------
// 纯常量模块：不依赖 chrome.* / DOM。新增/调整域只改这里。
//
// 三个键位语义不同，禁止混用：
//   idField  → 存储表主键（GET_* 分页 / 合并落库用）
//   idKey    → 内存条目键（options 视图 / 批量勾选用）
//   itemKey  → GET_* 响应里的数组键
// 仅 review 三者取值不同（reviewId / sourceId / reviewItems）：存储的是批次引用，
// 展示的是回源后的作品或作者，直接按同名合并会写坏回顾域。

export const STORAGE_KEYS = {
  WORKS: "works",
  WORKS_GROUPS: "works_groups",
  FOLLOWINGS: "followings",
  FOLLOWINGS_GROUPS: "followings_groups",
  FAVORITES: "favorites",
  FAVORITES_GROUPS: "favorites_groups",
  COLLECTIONS: "collections",
  COLLECTIONS_GROUPS: "collections_groups",
  CANDIDATES: "candidates",
  CANDIDATES_GROUPS: "candidates_groups",
  REVIEW: "review",
  REVIEW_GROUPS: "review_groups",
};

// 各域默认分组结构一致（全部 → 未分组），共用同一份定义；
// 消费处通过 .map 拷贝，避免原地改写污染共享引用。
export const DEFAULT_GROUPS = [
  { id: "all", name: "全部", fixed: true },
  { id: "uncategorized", name: "未分组", fixed: true },
];

export const GROUP_IDS = { UNCATEGORIZED: "uncategorized" };

// 六域事实表：键序即 options「数据维护」按钮顺序（works → review），禁止随意调整
export const DOMAINS = {
  works: {
    label: "作品",
    storeName: STORAGE_KEYS.WORKS,
    groupsName: STORAGE_KEYS.WORKS_GROUPS,
    itemKey: STORAGE_KEYS.WORKS,
    idField: "awemeId",
    idKey: "awemeId",
    defaultGroups: DEFAULT_GROUPS,
    isAuthorRecord: false,
    canImportExport: true,
  },
  followings: {
    label: "关注",
    storeName: STORAGE_KEYS.FOLLOWINGS,
    groupsName: STORAGE_KEYS.FOLLOWINGS_GROUPS,
    itemKey: STORAGE_KEYS.FOLLOWINGS,
    idField: "uid",
    idKey: "uid",
    idToString: true,
    defaultGroups: DEFAULT_GROUPS,
    isAuthorRecord: true,
    canImportExport: true,
  },
  favorites: {
    label: "点赞",
    storeName: STORAGE_KEYS.FAVORITES,
    groupsName: STORAGE_KEYS.FAVORITES_GROUPS,
    itemKey: STORAGE_KEYS.FAVORITES,
    idField: "awemeId",
    idKey: "awemeId",
    defaultGroups: DEFAULT_GROUPS,
    isAuthorRecord: false,
    canImportExport: true,
  },
  collections: {
    label: "收藏",
    storeName: STORAGE_KEYS.COLLECTIONS,
    groupsName: STORAGE_KEYS.COLLECTIONS_GROUPS,
    itemKey: STORAGE_KEYS.COLLECTIONS,
    idField: "awemeId",
    idKey: "awemeId",
    defaultGroups: DEFAULT_GROUPS,
    isAuthorRecord: false,
    canImportExport: true,
  },
  candidates: {
    label: "候选",
    storeName: STORAGE_KEYS.CANDIDATES,
    groupsName: STORAGE_KEYS.CANDIDATES_GROUPS,
    itemKey: STORAGE_KEYS.CANDIDATES,
    idField: "uid",
    idKey: "uid",
    idToString: true,
    defaultGroups: DEFAULT_GROUPS,
    isAuthorRecord: true,
    canImportExport: true,
  },
  review: {
    label: "回顾",
    storeName: STORAGE_KEYS.REVIEW,
    groupsName: STORAGE_KEYS.REVIEW_GROUPS,
    itemKey: STORAGE_KEYS.REVIEW + "Items",
    idField: "reviewId",
    idKey: "sourceId",
    defaultGroups: DEFAULT_GROUPS,
    isAuthorRecord: false,
    canImportExport: false,
  },
};

// 作品型三域（存储结构与 mergeWork 语义一致；作者数分页索引也只建在这三个域）
export const WORK_RECORD_DOMAINS = ["works", "favorites", "collections"];
// 作者档案型域：followings=账号原生关注镜像，candidates=扩展自建候选作者池
export const AUTHOR_RECORD_DOMAINS = ["followings", "candidates"];
// 回顾批次引用可指向的来源域（顺序即 UI 选择序）
export const SOURCE_DOMAINS = ["works", "favorites", "collections", "followings", "candidates"];
export const REVIEW_DOMAIN = "review";

export function isKnownDomain(domain) {
  return Object.prototype.hasOwnProperty.call(DOMAINS, domain);
}

export function isWorkDomain(domain) {
  return WORK_RECORD_DOMAINS.includes(domain);
}

export function isAuthorDomain(domain) {
  return AUTHOR_RECORD_DOMAINS.includes(domain);
}
