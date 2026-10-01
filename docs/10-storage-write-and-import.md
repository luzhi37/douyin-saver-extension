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
          单事务 getBatch 批量读旧记录（按入参序对位，缺失为 null）→ mergeWork(w, old) 逐条合并
          putBatch(toWrite) → count() 得总数
          → 返回 { added, updated, total }

关注域：
  FETCH_FOLLOWING 结果返回 options → SAVE_FOLLOWINGS { followings }
    → handleSaveFollowings(followings, sendResponse, isImport=false)
        旧记录 getBatch 按需读取 + getAllKeys 键集差做丢失检测（不物化全表）
        ├─ followerCount/awemeCount：>0 才写入（0 值保留旧值——校准结果保护，见 04）
        ├─ groupId：常规同步保留旧值；isImport 时取导入数据自带值（缺省落默认组）
        └─ savedAt：保留旧值；新条目按 baseTime - i 保证同批列表顺序
        丢失检测：旧 store 中不在本次集合的 uid 收集为 lostUids（不自动移动）
        putBatch 全量 → 返回 { ok, added, updated, lost, lostUids, total }

导入：
  IMPORT_DATA { text, domain }                  // options 直传文件全文（字符串 clone 是 memcpy 级），
                                                // JSON.parse 在 SW 侧完成（主线程不再解析大文件、
                                                // 解析结果不再全量对象 clone 过消息通道）
    → JSON.parse 失败 → { ok:false, error:"IMPORT_PARSE_FAILED" }
    → extractImportItems(data, domain)          // 取 data[itemKey] 数组
    → 空数组 → { ok:false, error:"IMPORT_EMPTY" }  // 原 options 侧 isDomainData 前置校验职责移入
    → reconcileImportGroups(domain, data, items)  // 有 groups 时做三级对账（下节）
    → 二次校验：item.groupId 不在当前有效分组集合 → 回退 CONFIG.GROUPS.DEFAULT_ID("uncategorized")
    → followings 域走 handleSaveFollowings(…, isImport=true)
    → 作品型三域按 CONFIG.IMPORT_CHUNK(2000) 分块逐块 mergeAndSave，IMPORT_PROGRESS 逐块
      回报（单事务 10 万级 put 长时间独占 SW 的 IDB）；计数跨块累计，响应只带计数——
      不再 spread 单次 mergeAndSave 的 written/addedIds 全记录（旧实现万级导入响应体
      膨胀至 MB 级，消费方只读 added/updated/total）
```

## 接口 / 方法签名

```js
// background/data/domain-store.js —— 作品合并
function mergeWork(w, old) -> Work              // 纯函数：字段覆盖 + 三项保护（见代码片段）
async function mergeAndSave(domain, works, { stamps = null } = {}) -> Promise<{ added, updated, changed, total, written, addedIds }>
// changed = 真实变更计数（新增 + 内容有变化的更新，逐键浅比较 merged vs old 判定）；
// 内容全等的重复入库不写库、不计入 changed——广播方（DomainHandlers.save 等）据它
// 决定是否发 STORE_CHANGED，options 不为 no-op 重载网格（2026-09 定案）。
// stamps（persistScan 扫描落库专用）：Map<主键, savedAt> 覆盖戳——主页序 savedAt 重排
// 要求全部 valid 记录都写，写入集扩为全集（isSameRecord 在戳覆盖前判定，unchanged
// 记录写库但不计入 changed）；缺省 null = 常规路径，仅写 changed 集。
// written = 本次实际写入的合并后记录（常规路径仅真实变更条目）；addedIds = written 中
// 属于新增的记录 id——DomainHandlers.save 在 changed ≤ BROADCAST.UPSERTS_MAX 时把
// 两者作为 STORE_CHANGED 的 upserts/addedIds 载荷发给 options 局部应用（原地替换 vs
// 新增插入的区分依据），响应路径则剔除这两字段防大批量保存响应膨胀。
// 批量变化（changed > UPSERTS_MAX，如作者入库收尾 runAuthorWorksImport）广播降为
// 轻量 id 集 changedIds/addedIds（万级 ≈ 几十 KB），options flush 时经
// GET_WORKS_BY_IDS（DomainHandlers.getByIds，IDB 主键直取）补拉合并后记录，走与点
// 载荷相同的增量收口管线——视图内新增头插（VirtualGrid.insertItems）、已有记录原地
// 更新，不再整域重载（2026-09 定案：整刷 wipe→骨架→封面重探即「页面闪烁」）

// background/data/domain-store.js —— 关注合并
async function mergeAndSaveFollowings(domain, followings, isImport = false) -> Promise<{ added, updated, changed, lost, lostUids, total }>
// 出参：{ ok:true, added, updated, changed, lost, lostUids: string[], total } | { ok:false, error:"EMPTY" }

// background/data/data-tools.js —— 导入
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
    createTime: w.createTime || awemeIdCreateTime(w.awemeId) || 0,   // 发布时间恒非零（aweme_id 高 32 位推导）
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
// 丢失检测改为键集差：旧实现 Object.keys(getAll) 全表物化，
// 现为 storage.getAllKeys（只取键、不反序列化记录值）
const lostUids = oldKeys.filter((uid) => !incomingUids.has(String(uid)));
```

### 扫描落库（persistScan）：stamps 一遍式

点赞/收藏扫描收尾的落库走 `ScanTasks.persistScan`（persist = "likes"/"favorites"）：

```
oldKeys = getAllKeys()                            // 丢失检测键集（只取键，不物化记录值）
stamps  = Map<主键, baseTime - i>                 // i 按有效条目序（主页顺序，最新在前）；
                                                  // 重复 id 末次出现生效（与 putBatch 后写覆盖等价）
saved   = mergeAndSave(domain, all, { stamps })   // 单次合并 + 单次 putBatch（一遍式）
lostUids = oldKeys \ stamps 键集
```

旧实现「mergeAndSave 后逐条读回全部记录、重打 savedAt 再整批重写一遍」的三遍读写已由
stamps 消解：戳覆盖发生在 mergeWork 合并之后、写入之前，无需读回；added/updated/changed
计数仍按覆盖前 isSameRecord 口径，汇总汇报语义不变。取消扫描时跳过 stamps 全流程之外的
丢失检测（部分拉取会产生假丢失），已收集部分照常落库（幂等）。

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
| 01 | [01-project-architecture.md](./01-project-architecture.md) | IndexedDB 结构、DOMAIN_CONFIG、data/storage.js 封装 API、chrome.storage.local 键表 |
| 02 | [02-independent-sync-works.md](./02-independent-sync-works.md) | SYNC_WORKS 循环末尾调用 mergeAndSaveWorks 的位置与时序 |
| 03 | [03-independent-sync-followings.md](./03-independent-sync-followings.md) | 关注列表采集产出的 6 字段形状（本册负责怎么落） |
| 04 | [04-independent-calibrate-followings.md](./04-independent-calibrate-followings.md) | 计数 >0 才写入规则的上游：校准写入权威计数 |
| 05 | [05-independent-scan-collection.md](./05-independent-scan-collection.md) | 扫描弹窗「添加」按钮经 SAVE_WORKS 进入本册合并路径 |
