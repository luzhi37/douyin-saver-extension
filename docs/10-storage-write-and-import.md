# 10 · 存储写入与导入合并

> 职责边界：作品型三域与作者域两域的**写入路径语义**——作品/关注落库时的合并规则、计数保护、同批顺序保证、丢失检测，以及导入数据的分组对账。IndexedDB 结构与 chrome.storage.local 键表见 [01](./01-project-architecture.md)；各采集流程（同步/扫描）如何调用到这里的见 [02](./02-independent-sync-works.md) / [03](./03-independent-sync-followings.md) / [05](./05-independent-scan-collection.md)。

## 概述

全部写路径收敛在三个函数：

| 函数 | 服务消息 | 域 |
|------|----------|----|
| `domainStore.mergeAndSave` | `SAVE_WORKS`（抖音标签页保存按钮、侧边栏「存入」、点赞/收藏域批量存入作品域）、`IMPORT_DATA`（作品型三域分块）与 background 直调（SYNC_WORKS 收尾、persistScan 扫描落库） | 作品型三域 |
| `domainStore.mergeAndSaveAuthors`（经 `followingsHandlers.save` / `candidatesHandlers.save`，或任务类/导入路径直调） | `SAVE_FOLLOWINGS`（同步落库）/ `SAVE_CANDIDATES`（关注域批量入库）/ `IMPORT_CANDIDATE`（链接收录）/ `IMPORT_DATA`（作者域） | followings / candidates |
| `reconcileImportGroups` | `IMPORT_DATA` 的前置步骤 | 五个导入域通用 |

共同设计原则：**用户手动整理的成果优先于新采集数据**——分组归属（groupId）、首次保存时间（savedAt）、已校准计数不被采集结果冲掉。

## 核心流程图（文字描述）

```
作品域：
  手动保存（抖音标签页按钮）/ 未关注作品入库 → SAVE_WORKS { works }
  SYNC_WORKS 收尾 / createScanWriter 扫描分块确认写 → background 直调 domainStore.mergeAndSave
    → domainStore.mergeAndSave
        valid = 过滤有 awemeId 的条目（空集 → { added:0, updated:0, changed:0, total: await ds.count(), written:[], addedIds:[] } 直接返回）
        单事务 getBatch 批量读旧记录（按入参序对位，缺失为 null）→ mergeWork(w, old) 逐条合并
        putBatch(toWrite，仅真实变更集) → count() 得总数
        → 返回 { added, updated, changed, total, written, addedIds }

作者域（followings / candidates）：
  关注同步：FETCH_FOLLOWING 结果返回 options → SAVE_FOLLOWINGS { followings }
    → followingsHandlers.save（#saveAuthorRecords）
  候选写入：关注域批量模式 → SAVE_CANDIDATES { candidates } → candidatesHandlers.save；
            链接收录 → IMPORT_CANDIDATE → scanTasks.importCandidate
        旧记录 getBatch 按需读取 + getAllKeys 键集差做丢失检测（候选域忽略 lostUids）
        ├─ followerCount/awemeCount：>0 才写入（0 值保留旧值——校准结果保护，见 04）
        ├─ groupId：一律保留旧值；仅新记录采用来值（缺省落默认组）
        └─ savedAt：保留旧值；新条目按 baseTime - i 保证同批列表顺序
        丢失检测：旧 store 中不在本次集合的 uid 收集为 lostUids（仅关注域消费，不自动移动）
        putBatch（仅变更集）→ 返回 { ok, added, updated, changed, lost, lostUids, total }

导入：
  IMPORT_DATA { text, domain }                  // options 直传文件全文（字符串 clone 是 memcpy 级），
                                                // JSON.parse 在 SW 侧完成（主线程不再解析大文件、
                                                // 解析结果不再全量对象 clone 过消息通道）
    → JSON.parse 失败 → { ok:false, error:"IMPORT_PARSE_FAILED" }
    → extractImportItems(data, domain)          // 取 data[itemKey] 数组（仅识别现行 schemaVersion 2
                                                // 导出格式，旧版 v1 备份不再做键位兼容/引导）
    → 空数组 → { ok:false, error:"IMPORT_EMPTY" }  // 原 options 侧 isDomainData 前置校验职责移入
    → reconcileImportGroups(domain, data, items)  // 有 groups 时做三级对账（下节）
    → 二次校验：item.groupId 不在当前有效分组集合 → 回退 CONFIG.GROUPS.DEFAULT_ID("uncategorized")
    → 作者域（followings/candidates）走 domainStore.mergeAndSaveAuthors(domain, items)（分组本地优先，与作品型域同口径），
      同步响应计数（单遍无分块/暂停点，不登记任务坞）
    → 作品型三域：校验全部通过后登记任务坞（kind importData）并 ack { ok, taskId }——响应不再携带
      导入计数；按 CONFIG.IMPORT_CHUNK(2000) 分块逐块 mergeAndSave（单事务 10 万级 put 长时间独占
      SW 的 IDB），块边界即 TaskRegistry checkpoint（暂停让出/取消退出，取消保留已写入部分）；
      逐块 TASK_PROGRESS（公共 processed/total），收尾 added+updated>0 时裸 STORE_CHANGED { domain }
      （不带 changedIds——十万级 id 集补拉反而劣化，options 走整域重载兜底）→ finish → TASK_DONE
      携带 added/updated/invalid
```

## 接口 / 方法签名

```js
// background/data/domain-store.js —— 作品合并
function mergeWork(w, old) -> Work              // 纯函数：字段覆盖 + 三项保护（见代码片段）
async function mergeAndSave(domain, works, { stamps = null } = {}) -> Promise<{ added, updated, changed, total, written, addedIds }>
// changed = 真实变更计数（新增 + 内容有变化的更新，逐键浅比较 merged vs old 判定）；
// 内容全等的重复入库不写库、不计入 changed——广播方（DomainHandlers.save 等）据它
// 决定是否发 STORE_CHANGED，options 不为 no-op 重载网格（2026-09 定案）。
// stamps（createScanWriter 扫描分块确认写专用）：Map<主键, savedAt> 覆盖戳——主页序 savedAt
// 重排要求全部 valid 记录都写，写入集扩为全集（isSameRecord 在戳覆盖前判定，unchanged
// 记录写库但不计入 changed）；缺省 null = 常规路径，仅写 changed 集。
// written = 本次实际写入的合并后记录（常规路径仅真实变更条目）；addedIds = written 中
// 属于新增的记录 id——DomainHandlers.save 在 changed ≤ BROADCAST.UPSERTS_MAX 时把
// 两者作为 STORE_CHANGED 的 upserts/addedIds 载荷发给 options 局部应用（原地替换 vs
// 新增插入的区分依据），响应路径则剔除这两字段防大批量保存响应膨胀；仅单作品保存
// （items 有效条数=1）额外回读落库 groupId 并附 groupName（抖音标签页 toast 提示
// 作品是否已存在、位于哪个组，批量无单一分组不回传）。
// 批量变化（changed > UPSERTS_MAX，DomainHandlers.save 批量保存路径）广播降为
// 轻量 id 集 changedIds/addedIds（万级 ≈ 几十 KB），options flush 时经
// GET_WORKS_BY_IDS（DomainHandlers.getByIds，IDB 主键直取）补拉合并后记录，走与点
// 载荷相同的增量收口管线——视图内新增头插（VirtualGrid.insertItems）、已有记录原地
// 更新，不再整域重载（2026-09 定案：整刷 wipe→骨架→封面重探即「页面闪烁」）。
// 任务坞长任务不在此列：四族（扫描/取消/同步/作者入库）数据广播统一「仅终态一次
// 裸载荷」（2026-11 定案，changed>0 才发，options 整域重载收口）

// background/data/domain-store.js —— 关注合并
async function mergeAndSaveAuthors(domain, items) -> Promise<{ added, updated, changed, lost, lostUids, total }>
// 出参：{ added, updated, changed, lost, lostUids: string[], total }（ok 包装在 followingsHandlers/candidatesHandlers.save）

// background/data/domain-store.js —— 导入条目解析
function extractImportItems(data, domain) -> any[]     // data[cfg.itemKey] 或空数组

// background/data/data-tools.js —— 导入
async function reconcileImportGroups(domain, data, items) -> void   // 就地改写 item.groupId
async function dataTools.import(text, domain, sendResponse, taskId = "")  // 作品型三域登记 importData
                                                          // 任务坞长任务并 ack { ok, taskId }；作者域同步响应计数
async function dataTools.importChunk(msg, sendResponse)   // 分块上行缓冲外壳：seq=0 登记缓冲、幂等写入，
                                                          // 末块拼回全文走 import()（taskId 透传）；错误 IMPORT_TRANSFER_EXPIRED
async function dataTools.exportStart(domain, sendResponse) // { ok, exportId, total, header, footer }——建键快照会话
async function dataTools.exportChunk(msg, sendResponse)    // { ok, text, next, done }——逐块拉记录文本，
                                                           // 文件与整体 JSON.stringify(…, null, 2) 逐字节一致；错误 EXPORT_SESSION_EXPIRED
async function dataTools.reset(domain, sendResponse)   // clear(store) + putGroups(defaultGroups, { resetCounts: true })
```

## 关键代码片段

### mergeWork：三项保护与长效链降级防护

```js
function mergeWork(w, old) {
  const uid = w.uid != null && w.uid !== "" ? String(w.uid) : String(old?.uid || "");
  const createTime = Number(w.createTime) || utils.awemeIdCreateTime(w.awemeId) || 0;
  const merged = {
    ...w,
    uid,                                                             // 类型归一化（作者数索引硬前提）
    groupId: String(old?.groupId || w.groupId || CONFIG.GROUPS.DEFAULT_ID),  // 手动分组不丢
    savedAt: Number(old?.savedAt || w.savedAt) || Date.now(),        // 首次保存时间不变
    createTime,                                                      // 发布时间恒非零（aweme_id 高 32 位推导）
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
  lastUpdateAt:  f.lastUpdateAt  > 0 ? f.lastUpdateAt  : old?.lastUpdateAt  || 0,
  uid,
  groupId: old?.groupId || f.groupId || CONFIG.GROUPS.DEFAULT_ID,  // 本地整理优先；仅新记录采用来值
  savedAt: old?.savedAt ?? baseTime - i,   // 新条目按批次内序号倒推毫秒 → 列表顺序稳定
};
…
// 丢失检测改为键集差：旧实现 Object.keys(getAll) 全表物化，
// 现为 storage.getAllKeys（只取键、不反序列化记录值）
const lostUids = oldKeys.filter((uid) => !incomingUids.has(String(uid)));
```

### 扫描落库（createScanWriter）：分块确认写 + 终态结论

关注/点赞/收藏三扫描的落库统一走 `createScanWriter(domain)`（`tasks/scan-tasks.js` 模块级工厂，双模共用）——**「确认写」与「结论写」解耦**：

```
snapshot()  oldKeys = getAllKeys()               // 任务开始时键集快照（丢失检测基准）
            baseTime = Date.now()                // 戳基准
add(item)   keys.add(id)；stamps.set(id, baseTime − 全局下标)；入块缓冲
            缓冲 ≥ SCAN_CHUNK（设置面板 scanChunkSize，默认 200）→ flush()
flush()     单事务 upsert 当前块（followings 走 mergeAndSaveAuthors { lost:false, stamps }，
            点赞/收藏走 mergeAndSave { stamps }），写后释放记录本体——内存峰值 = 一块 + 键集
lostIds()   结论写：oldKeys − keys，仅完整扫描（无错误收尾）的终态由调用方执行
```

关键语义（2026-11-14 定案，取代旧 persistScan「终态一次性落库」）：

- **确认写静默且分块**：循环内不发 `STORE_CHANGED`，数据广播仅终态一次裸载荷（万级 id 集超 options `GRID_PREMOUNT_CAP(1500)` 会被丢弃，纯浪费）；savedAt 戳在收集时按任务级全局下标分配——跨块一致，savedAt desc = 主页序（点赞/收藏全量取戳重排；关注域仅新记录取戳，`old?.savedAt ?? stamps` 口径不变）。
- **结论绑死完整扫描**：丢失检测只对「无错误收尾」的扫描执行；中途页失败/取消保留已写块、`TASK_DONE` 不带 `lostUids`、回收站纹丝不动——修复旧实现「中途失败带着部分数据算丢失 → 假判丢失整批移入稍后删除」的 bug（Tab 与独立模式同病同修）。
- **中止/异常路径冲刷余块**：取消、暂停挂起（checkpoint `onSuspend`）、异常 catch 都先 `flush()` 再收尾——已抓到的真实数据全部保留，取消残差上限 = 0（块内未写部分随终态冲刷落库）。
- **中途失败以 `failed` 收口**：任何非取消取数失败（含中途页失败）都以 `failed` + `lastError` 如实呈现，禁止静默「done」——扫描未完整跑完必须可见。

旧 persistScan 的 stamps 一遍式消解（免读回重写）由 `mergeAndSave` 的 stamps 覆盖戳机制继承：戳覆盖发生在 mergeWork 合并之后、写入之前；added/updated/changed 计数仍按覆盖前 isSameRecord 口径。

### reconcileImportGroups：分组三级对账（本地优先）

本地既有分组（名称 + 用户拖拽顺序）是唯一权威；导入只做 id/名称映射与新组追加。

```js
const existingList = await storage.getGroups(groupsName);
const existing = utils.normalizeGroups(existingList.length ? existingList : def.map((g) => ({ ...g }))); // 主键(id)序 → 本地 order 序
const fixedIds = new Set(CONFIG.DEFAULT_GROUPS.map((g) => g.id));           // 固定分组由本地定义
const existingIds = new Set(existing.map((g) => g.id));
const existingNames = new Map(existing.map((g) => [g.name, g.id]));
for (const g of importedGroups) {
  if (!g || !g.id || fixedIds.has(g.id)) continue;
  if (existingIds.has(g.id))         groupIdMap.set(g.id, g.id);                 // ① 按 ID 匹配
  else if (existingNames.has(g.name)) groupIdMap.set(g.id, existingNames.get(g.name)); // ② 按名称匹配
  else { newGroups.push(g);          groupIdMap.set(g.id, g.id); }               // ③ 新建
}
newGroups.forEach((g, i) => (g.order = existing.length + i));   // 新组一律追加末尾（忽略文件内 order）
const merged = utils.normalizeGroups([...existing, ...newGroups]); // 既有顺序原样保留，固定分组钉前
await storage.putGroups(groupsName, merged);       // 覆盖数组语义（clear + put）
for (const item of items) {
  if (item.groupId && groupIdMap.has(item.groupId)) item.groupId = groupIdMap.get(item.groupId);
}
// dataTools.import 后续再兜一道：不在当前有效分组集合的 groupId → "uncategorized"
```

> 顺序红线：`storage.getGroups` / IDB `getAll` 返回的是主键 `id` 序（自定义组即 `custom_+UUID` 随机序），**不是**用户整理顺序——任何写路径都不得按该数组下标重写 `order`，排序统一走 `utils.normalizeGroups`。

### 分块传输：导出会话拉取与导入缓冲拼合（64MiB 消息上限）

> 依据：`chrome.runtime.sendMessage` 请求/响应单条硬上限 64MiB——整域导出文本与超大导入文件**双向**都会触顶。Port 每条消息同限、SW 内无 `URL.createObjectURL`（无法 SW 侧建 blob 直下）、data URL 下载限 ~2MB，均不可行，只能分块。

**导出（会话式分块拉取：`EXPORT_DATA` 建会话 → `EXPORT_CHUNK` 逐块拉）**

- `EXPORT_DATA { domain }`：`getAllKeys` 键快照（SW 内存会话 `exportId` + 滑动 TTL）+ `getGroups`，响应只回 `{ exportId, total, header, footer }`。header/footer 由 SW 组装，与整体 `JSON.stringify(…, null, 2)` 输出逐字节一致（含空域 `"itemKey": []` 内联特例）；格式知识全部留在 SW，options 不解析、不 stringify，只顺序拼接 `new Blob([header, ...parts, footer])`。
- `EXPORT_CHUNK { exportId, offset }`：按 `EXPORT_BATCH_KEYS`(500) 逐批 `getBatch` 序列化累计到 `EXPORT_CHUNK_CHARS`(8M 字符)，返回 `{ text, next, done }`。快照后已删除的键 getBatch 返回 null——跳过但计入 taken（游标按键序号推进）。首非空块判定用会话 `emitted` 标记而非 `offset>0`：快照头部键可能全被删，前导逗号会产生非法 JSON。
- 空域 `total=0` 时 options 循环自然跳过，header+footer 即完整文件。导出纯只读，**不参与 BUSY 互斥**（导入/重置为整批读改写才互斥）。options 拉取循环为任务坞本地任务 `exportData`（batchDownload 同款，不经队列/不占 RequestGate）：暂停=块边界协作让出（会话 TTL 5min 滑动续期，暂停超时后恢复即 `EXPORT_SESSION_EXPIRED` 行失败提示重试），取消=丢弃已拉文本不保存文件。

**导入（分块上行缓冲：`IMPORT_DATA` + `transfer` 载荷）**

- options 读文件后按 `IMPORT_TRANSFER_THRESHOLD`(16M 字符) 分支：超阈值以 `transfer:{ id, seq, total, text }`（块大小 `IMPORT_TRANSFER_CHUNK` 8M 字符）逐块 await 发送；SW 按 `transferId` 缓冲（同 seq 幂等），末块拼回全文走既有 `import()` 全流程（解析/对账/分块落库不变，`taskId` 透传），末块响应即任务 ack（作品域）或同步导入结果（作者域）；小文件单条全文路径不变。

## 异常场景及处理

| 场景 | 表现 | 处理 |
|------|------|------|
| 导入数据无该域条目数组 | `extractImportItems` 返回 `[]` | 所有域统一返回 `{ ok:false, error:"IMPORT_EMPTY" }` |
| 导入的 groupId 既对不上 ID 也对不上名称 | 映射到新建分组；若仍不在有效集合 | 兜底回退 `uncategorized` |
| 固定分组（all/uncategorized）出现在导入数据 | 被固定分组 id 白名单过滤 | 当前库固定分组原样保留且排序居首 |
| 导入文件的分组顺序与本地不同 | 既有分组按本地 order 原样保留 | 新组追加到末尾；文件内 `order` 不参与本地排序 |
| 关注同步出现丢失 uid | 计入 `lost`/`lostUids` 返回 | **不自动移入"稍后删除"**——由用户在 UI 点击按钮触发 `Sync.moveLostFollowings(lostUids)` |
| 历史数值主键 | uid/awemeId 统一 `String()` 归一 | options 读侧另有 number 主键拷贝归一化兜底 |
| 作品被删除后重新入库 | 视为新条目（added） | groupId/savedAt 从默认值起步 |
| 导出会话过期（TTL 5min 滑动 / SW 冷启动丢失内存会话） | `EXPORT_CHUNK` 回 `{ ok:false, error:"EXPORT_SESSION_EXPIRED" }` | options toast「导出中断，请重试」，重开导出即新建会话 |
| 导入分块传输中止（中途关页 / TTL 过期 / SW 冷启动） | 末块到达时缓冲缺失 | `IMPORT_TRANSFER_EXPIRED` → options toast「导入传输中断，请重试」+ 坞行 fail；残留缓冲靠 TTL 清扫 |
| 导入传输中途同域起同步任务 | 路由层 BUSY 守卫命中后续块 | options 走既有 BUSY toast + 坞行 fail；同上残留缓冲 TTL 清扫 |
| importData 落库阶段取消 | 块边界 `isCancelled` 退出 | **保留已写入部分**（对齐校准族）：已写块不回滚，裸 `STORE_CHANGED` 刷新，TASK_DONE `cancelled/timedOut` → 坞行 PARTIAL |
| importData 落库阶段异常 | catch 收口（finish 必须，防 RUNNING 泄漏卡死 isBusy 门禁） | **已写入块如实上报**：`added/updated` 用 try 外累加值（不为 0），`added+updated>0` 时补发裸 `STORE_CHANGED`（先于 TASK_DONE）刷新已落库部分，坞行 fail |
| importData 排队（异域任务运行中） | `TaskRegistry.start` 入队 | 行显示排队位，`waitForTurn` 挂起，队首让出后自动续跑；同域任务运行中则路由/入库前 `isBusy` 双重 BUSY 拒绝 |

## 配置项说明

| 配置 | 默认 | 作用 |
|------|------|------|
| `CONFIG.GROUPS.DEFAULT_ID` | `"uncategorized"` | 所有分组失效路径的最终回退目标 |
| `CONFIG.GROUPS.ID_PREFIX` | `"custom_"` | ADD_GROUP 生成的自定义分组 id 前缀 |
| `config.STORAGE_MAX_BYTES`（options/core.js） | 10MB | 存储指示器的占用百分比展示（`Groups.#applyStorageIndicator`）；不做导入体积门禁 |
| `config.TRASH_GROUP_NAME`（options/core.js） | `'稍后删除'` | 丢失关注手动移入的目标分组名 |
| `IMPORT_TRANSFER_THRESHOLD` / `IMPORT_TRANSFER_CHUNK` / `EXPORT_CHUNK_CHARS` / `EXPORT_BATCH_KEYS` / `TRANSFER_SESSION_TTL`（shared/limits.js，两侧同源） | 16M 字符 / 8M 字符 / 8M 字符 / 500 / 5min | 导入导出消息分块（chrome.runtime 单条 64MiB 上限），机制见本册「分块传输」节 |
| 默认分组定义 | `CONFIG.DEFAULT_GROUPS`（六域共用一份） | `{all, uncategorized}` 两个 fixed 组；RESET_DOMAIN / 首装初始化来源；消费处 `.map` 拷贝避免污染共享引用 |

## 相关文档

| 编号 | 文档 | 关联内容 |
|------|------|----------|
| 01 | [01-project-architecture.md](./01-project-architecture.md) | IndexedDB 结构、DOMAIN_CONFIG、data/storage.js 封装 API、chrome.storage.local 键表 |
| 02 | [02-independent-sync-works.md](./02-independent-sync-works.md) | SYNC_WORKS 循环末尾调用 domainStore.mergeAndSave 的位置与时序 |
| 03 | [03-independent-sync-followings.md](./03-independent-sync-followings.md) | 关注列表采集产出的 7 字段形状（本册负责怎么落） |
| 04 | [04-independent-calibrate-followings.md](./04-independent-calibrate-followings.md) | 计数 >0 才写入规则的上游：校准写入权威计数 |
| 05 | [05-independent-scan-collection.md](./05-independent-scan-collection.md) | 扫描分块确认写经 createScanWriter 进入本册合并路径（stamps 覆盖戳） |
