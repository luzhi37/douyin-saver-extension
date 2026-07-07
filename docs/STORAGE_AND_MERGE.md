# 数据存储与合并

> 本文档描述 IndexedDB 结构、作品合并、关注合并与丢失检测、以及导入分组去重合并机制。

## IndexedDB 结构

`storage.js` 定义 4 个 store：`works`（keyPath `awemeId`, 索引 `groupId`）、`works_groups`（keyPath `id`）、`followings`（keyPath `uid`, 索引 `groupId`）、`followings_groups`（keyPath `id`）。支持按 `groupId` 索引查询、`getAll` 返回 `{ [keyPath]: item }` 映射、`deleteBatch` 单事务批量删除。分组写入采用 `clear()` + 逐条 `put()` 实现"覆盖数组"语义。

## 作品合并

`mergeWork(w, old)` 实现：新数据覆盖旧数据所有字段，**保留**旧 `groupId`（用户手动分组不丢失）和 `savedAt`（首次保存时间不变）。最后调用 `storage.putBatch('works', toWrite)` 写入，仅变更条目。

## 关注合并与丢失检测

uid 统一转字符串，`groupId` 保留旧值（导入时 `isImport` 标志从导入数据读取），`savedAt` 使用 `baseTime - i` 保证同批顺序。丢失检测扫描旧 store 中不在新集合的 uid（仅关注域，作品域无此逻辑）。丢失 uid 不自动移入"稍后删除"，由用户点击按钮手动触发 `Sync.moveLostFollowings(lostUids)`。

## 导入分组去重合并

`reconcileImportGroups(domain, data, items)`：按 ID 匹配→按名称匹配→新建的三级策略。通过 `groupIdMap` 将导入数据的旧 `groupId` 映射到当前数据库有效 ID。固定分组保留，非固定分组去重合并。映射后无效的 `groupId` 回退到 `'uncategorized'`。