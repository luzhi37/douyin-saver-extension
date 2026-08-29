# 10 · 存储写入与导入合并

> 职责边界：两个数据域的**写入路径语义**——作品/关注落库时的合并规则、计数保护、同批顺序保证、丢失检测，以及导入数据的分组对账。IndexedDB 结构与 chrome.storage.local 键表见 [01](./01-project-architecture.md)；各采集流程（同步/扫描）如何调用到这里的见 [02](./02-independent-sync-works.md) / [03](./03-independent-sync-followings.md) / [05](./05-independent-scan-collection.md)。

## 概述

全部写路径收敛在三个函数：

| 函数 | 服务消息 | 域 |
|------|----------|----|
| `mergeAndSaveWorks` | `SAVE_WORKS`（含同步落库、扫描「添加」、手动保存按钮） | works |
| `handleSaveFollowings` | `SAVE_FOLLOWINGS`（含同步落库与 `isImport` 导入分支） | followings |
| `reconcileImportGroups` | `IMPORT_DATA` 的前置步骤 | 两域通用 |

共同设计原则：**用户手动整理的成果优先于新采集数据**——分组归属（groupId）、首次保存时间（savedAt）、已校准计数不被采集结果冲掉。

## 核心流程图（文字描述）

```
作品域：
  SYNC_WORKS 完成 / 扫描「添加」/ 手动保存
    → SAVE_WORKS { works }
      → handleSaveWorks → mergeAndSaveWorks
          valid = 过滤有 awemeId 的条目（空集 → {added:0,updated:0,total:0} 直接返回）
          并发逐条读旧记录 → mergeWork(w, old) 逐条合并
          putBatch(toWrite) → count() 得总数
          → 返回 { added, updated, total }

关注域：
  FETCH_FOLLOWING 结果返回 options → SAVE_FOLLOWINGS { followings }
    → handleSaveFollowings(followings, sendResponse, isImport=false)
        以旧 store 为底，逐条覆盖合并（uid 字符串化为主键）
        ├─ followerCount/awemeCount：>0 才写入（0 值保留旧值——校准结果保护，见 04）
        ├─ groupId：常规同步保留旧值；isImport 时取导入数据自带值（缺省落默认组）
        └─ savedAt：保留旧值；新条目按 baseTime - i 保证同批列表顺序
        丢失检测：旧 store 中不在本次集合的 uid 收集为 lostUids（不自动移动）
        putBatch 全量 → 返回 { ok, added, updated, lost, lostUids, total }

导入：
  IMPORT_DATA { data, domain }
    → extractImportItems(data, domain)            // 取 data[itemKey] 数组
    → reconcileImportGroups(domain, data, items)  // 有 groups 时做三级对账（下节）
    → 二次校验：item.groupId 不在当前有效分组集合 → 回退 CONFIG.GROUPS.DEFAULT_ID("uncategorized")
    → works 域走 handleSaveWorks / followings 域走 handleSaveFollowings(…, isImport=true)
```

## 接口 / 方法签名

```js
// background.js —— 作品合并
function mergeWork(w, old) -> Work              // 纯函数：字段覆盖 + 三项保护（见代码片段）
async function mergeAndSaveWorks(works) -> Promise<{ added, updated, total }>

// background.js —— 关注合并
async function handleSaveFollowings(followings, sendResponse, isImport = false)
// 出参：{ ok:true, added, updated, lost, lostUids: string[], total } | { ok:false, error:"EMPTY" }

// background.js —— 导入
function extractImportItems(data, domain) -> any[]     // data[cfg.itemKey] 或空数组
async function reconcileImportGroups(domain, data, items) -> void   // 就地改写 item.groupId
async function handleImportData(data, domain, sendResponse)
async function handleExportData(domain, sendResponse)  // { ok, data: { domain, exportedAt, [itemKey], groups } }
async function handleResetDomain(domain, sendResponse) // clear(store) + putGroups(defaultGroups)
```

## 关键代码片段

### mergeWork：三项保护与长效链降级防护

```js
function mergeWork(w, old) {
  const merged = {
    ...w,
    groupId: old?.groupId || w.groupId || CONFIG.GROUPS.DEFAULT_ID,  // 手动分组不丢
    savedAt: old?.savedAt || w.savedAt || Date.now(),                // 首次保存时间不变
  };
  // 旧记录已存长效 v1/play 链接而新结果是短效 CDN 直链 → 保留旧链接，
  // 避免手动添加的作品被同步以短效直链覆盖降级
  if (old && isLongLivedVideoUrl(old.video) && !isLongLivedVideoUrl(w.video)) {
    merged.video = old.video;
    merged.videoExpireAt = old.videoExpireAt || 0;
  }
  return merged;
}
```

### 关注合并：计数保护 + 同批保序 + 丢失检测

```js
stored[uid] = {
  ...f,
  // 计数仅由校准更新：常规列表同步携带的 0 不覆盖已校准旧值；校准结果/导入快照 >0 时正常写入
  followerCount: f.followerCount > 0 ? f.followerCount : old?.followerCount || 0,
  awemeCount:    f.awemeCount    > 0 ? f.awemeCount    : old?.awemeCount    || 0,
  uid,
  groupId: isImport
    ? f.groupId || CONFIG.GROUPS.DEFAULT_ID                              // 导入信任数据自带分组
    : old?.groupId || f.groupId || CONFIG.GROUPS.DEFAULT_ID,
  savedAt: old?.savedAt ?? baseTime - i,   // 新条目按批次内序号倒推毫秒 → 列表顺序稳定
};
…
const lostUids = [];                        // 仅关注域有丢失检测；作品域无此逻辑
for (const uid of Object.keys(stored)) {
  if (!incomingUids.has(uid)) lostUids.push(uid);
}
```

### reconcileImportGroups：分组三级对账

```js
for (const g of importedGroups.filter((g) => !g.fixed)) {
  if (existingIds.has(g.id))         groupIdMap.set(g.id, g.id);                 // ① 按 ID 匹配
  else if (existingNames.has(g.name)) groupIdMap.set(g.id, existingNames.get(g.name)); // ② 按名称匹配
  else { newGroups.push(g);          groupIdMap.set(g.id, g.id); }               // ③ 新建
}
const merged = [...fixed, ...existing.filter((g) => !g.fixed), ...newGroups];
merged.forEach((g, i) => (g.order = i));           // 固定分组恒居前，order 全量重排
await storage.putGroups(groupsName, merged);       // 覆盖数组语义（clear + put）
for (const item of items) {
  if (item.groupId && groupIdMap.has(item.groupId)) item.groupId = groupIdMap.get(item.groupId);
}
// handleImportData 后续再兜一道：不在当前有效分组集合的 groupId → "uncategorized"
```

## 异常场景及处理

| 场景 | 表现 | 处理 |
|------|------|------|
| 导入数据无该域条目数组 | `extractImportItems` 返回 `[]` | followings 域会因 EMPTY 报 `{ok:false}`；works 域静默零写入 |
| 导入的 groupId 既对不上 ID 也对不上名称 | 映射到新建分组；若仍不在有效集合 | 兜底回退 `uncategorized` |
| 固定分组（all/uncategorized）出现在导入数据 | 被 `!g.fixed` 过滤 | 当前库固定分组原样保留且排序居首 |
| 关注同步出现丢失 uid | 计入 `lost`/`lostUids` 返回 | **不自动移入"稍后删除"**——由用户在 UI 点击按钮触发 `Sync.moveLostFollowings(lostUids)` |
| 历史数值主键 | uid/awemeId 统一 `String()` 归一 | options 读侧另有 number 主键拷贝归一化兜底 |
| 作品被删除后重新入库 | 视为新条目（added） | groupId/savedAt 从默认值起步 |

## 配置项说明

| 配置 | 默认 | 作用 |
|------|------|------|
| `CONFIG.GROUPS.DEFAULT_ID` | `"uncategorized"` | 所有分组失效路径的最终回退目标 |
| `CONFIG.GROUPS.ID_PREFIX` | `"custom_"` | ADD_GROUP 生成的自定义分组 id 前缀 |
| `config.STORAGE_MAX_BYTES`（options/core.js） | 10MB | 导入体积门禁提示（UI 侧校验） |
| `config.TRASH_GROUP_NAME`（options/core.js） | `'稍后删除'` | 丢失关注手动移入的目标分组名 |
| 默认分组定义 | `CONFIG.DEFAULT_GROUPS`（四域共用一份） | `{all, uncategorized}` 两个 fixed 组；RESET_DOMAIN / 首装初始化来源；消费处 `.map` 拷贝避免污染共享引用 |

## 相关文档

| 编号 | 文档 | 关联内容 |
|------|------|----------|
| 01 | [01-project-architecture.md](./01-project-architecture.md) | IndexedDB 结构、DOMAIN_CONFIG、storage.js 封装 API、chrome.storage.local 键表 |
| 02 | [02-independent-sync-works.md](./02-independent-sync-works.md) | SYNC_WORKS 循环末尾调用 mergeAndSaveWorks 的位置与时序 |
| 03 | [03-independent-sync-followings.md](./03-independent-sync-followings.md) | 关注列表采集产出的 6 字段形状（本册负责怎么落） |
| 04 | [04-independent-calibrate-followings.md](./04-independent-calibrate-followings.md) | 计数 >0 才写入规则的上游：校准写入权威计数 |
| 05 | [05-independent-scan-collection.md](./05-independent-scan-collection.md) | 扫描弹窗「添加」按钮经 SAVE_WORKS 进入本册合并路径 |
