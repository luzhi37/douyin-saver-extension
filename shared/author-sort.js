// ---------- 作者排序契约（options / background 共用） ----------
// 纯函数模块：authorCount 视图的作者簇顺序、簇内顺序与 savedAt 合并全部在此定案。
// 两侧必须引用同一实现，否则后台分页序与 options 本地 fallback 序会漂移。

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function idText(value) {
  return String(value ?? "");
}

function num(value) {
  return Number(value) || 0;
}

// 作者键：uid 优先，缺失时退化到 nickname（后台空 uid 桶的兜底语义）
export function authorKeyOf(work) {
  return String(work?.uid || work?.nickname || "");
}

// 作者簇：count 降序；同 count 按 authorKey 升序
export function compareAuthorCluster(a, b) {
  return b.ids.length - a.ids.length || compareText(a.key, b.key);
}

// 簇内：createTime 降 → savedAt 降 → awemeId 降（全显式 tie-break，不依赖稳定排序）
export function compareWorkInAuthor(a, b) {
  return (
    num(b?.createTime) - num(a?.createTime) ||
    num(b?.savedAt) - num(a?.savedAt) ||
    compareText(idText(b?.awemeId), idText(a?.awemeId))
  );
}

// 域数组不变量：savedAt 降 → awemeId 降
export function compareSavedAtDesc(a, b) {
  return num(b?.savedAt) - num(a?.savedAt) || compareText(idText(b?.awemeId), idText(a?.awemeId));
}

export function sortSavedAtDesc(items) {
  return [...(items || [])].sort(compareSavedAtDesc);
}

// 双指针归并两个 savedAt 降序数组；按 awemeId 去重（同名主键只保留先出现者）。
// base 必须已满足 savedAt 降序不变量，调用方负责；incoming 可未排序，内部先排序。
export function mergeSavedAtDesc(base, incoming) {
  const left = Array.isArray(base) ? base : [];
  const right = sortSavedAtDesc(incoming);
  const out = [];
  const seen = new Set();

  const push = (item) => {
    if (!item) return;
    const key = item.awemeId == null ? null : String(item.awemeId);
    if (key != null) {
      if (seen.has(key)) return;
      seen.add(key);
    }
    out.push(item);
  };

  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i >= left.length) {
      push(right[j++]);
    } else if (j >= right.length) {
      push(left[i++]);
    } else if (compareSavedAtDesc(left[i], right[j]) <= 0) {
      push(left[i++]);
    } else {
      push(right[j++]);
    }
  }
  return out;
}
