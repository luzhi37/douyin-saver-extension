# 数据存储与合并

> 本文档描述 IndexedDB 结构、background.js 中的作品合并、关注合并与丢失检测、以及导入分组去重合并机制。

## 1. IndexedDB 结构（`storage.js`）

```js
const STORES = {
  works:             { keyPath: 'awemeId', indexes: ['groupId'] },
  works_groups:      { keyPath: 'id' },
  followings:        { keyPath: 'uid',    indexes: ['groupId'] },
  followings_groups: { keyPath: 'id' },
};
```

- `works` 和 `followings` 按 `groupId` 建立索引，支持快速按分组查询
- `storage.getAll(storeName)` 返回 `{ [keyPath]: item }` 映射（`toMap` 转换）
- `storage.count(storeName)` 返回 store 中的记录数（`IDBObjectStore.count()`）
- `storage.deleteBatch(storeName, keys)` 单事务批量删除
- `storage.getGroups(storeName)` 返回数组（分组需要保持顺序）
- 分组写入采用 `clear()` + 逐条 `put()`，实现"覆盖整个数组"语义

## 2. 作品合并逻辑（`mergeAndSaveWorks` / `mergeWork`）

```js
function mergeWork(w, old) {
  return {
    ...w,
    groupId: old?.groupId || w.groupId || CONFIG.GROUPS.DEFAULT_ID,
    savedAt: old?.savedAt || w.savedAt || Date.now(),
  };
}
```

- 新数据覆盖旧数据的所有字段
- **保留**旧 `groupId`（用户手动分组不丢失）
- **保留**旧 `savedAt`（首次保存时间不变）
- 最后调用 `storage.putBatch('works', Object.values(store))` 全量写入

## 3. 关注合并与丢失检测（`handleSaveFollowings`）

```js
// 1. uid 统一转字符串
const uid = String(f.uid);

// 2. groupId 保留策略
store[uid] = {
  ...f,
  uid,
  groupId: isImport
    ? (f.groupId || 'uncategorized')
    : (old?.groupId || f.groupId || 'uncategorized'),
  savedAt: old?.savedAt ?? (baseTime - i),
};

// 3. 丢失检测：未出现在新集合中的关注者
const lostUids = [];
for (const uid of Object.keys(store)) {
  if (!incomingUids.has(uid)) {
    lostUids.push(uid);
  }
}
```

- `savedAt` 使用 `baseTime - i` 保证同一批导入的关注者按数组顺序有微小时间差，便于排序
- 丢失检测仅针对**关注域**，作品域无此逻辑
- 丢失的 uid 不自动移入"稍后删除"分组，由用户同步完成后点击按钮手动触发
- 手动移入时调用 `Sync.moveLostFollowings(lostUids)`，后台创建/查找"稍后删除"分组后执行 `MOVE_FOLLOWINGS`

## 4. 导入分组去重合并（`reconcileImportGroups`）

```js
async function reconcileImportGroups(domain, data, items) {
  // 按 ID 匹配 → 按名称匹配 → 新建
  for (const g of importedGroups) {
    if (existingIds.has(g.id)) {
      groupIdMap.set(g.id, g.id);
    } else if (existingNames.has(g.name)) {
      groupIdMap.set(g.id, existingNames.get(g.name));  // 名称相同合并到现有分组
    } else {
      newGroups.push(g);  // 真正的新分组
      groupIdMap.set(g.id, g.id);
    }
  }
  // 导入数据的旧 groupId 映射到新 ID
  for (const item of items) {
    if (item.groupId && groupIdMap.has(item.groupId)) {
      item.groupId = groupIdMap.get(item.groupId);
    }
  }
}
```

- 导入时先处理分组：固定分组保留，非固定分组按 ID/名称去重
- 旧 `groupId` 通过 `groupIdMap` 映射到当前数据库中的有效 ID
- 若映射后 `groupId` 仍无效，回退到 `'uncategorized'`
