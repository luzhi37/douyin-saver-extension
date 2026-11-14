// background/data/data-tools.js — 导入导出 / 重置 / 统计（reconcileImportGroups）

import { CONFIG, DOMAIN_CONFIG, utils } from "../core.js";
import { storage } from "./storage.js";
import { domainStore } from "./domain-store.js";
import { taskRegistry } from "../tasks/task-registry.js";

// ---------- DataTools ----------
// 导入导出 / 重置 / 统计（域感知）
class DataTools {
  // 导出会话：exportId -> { domain, keys, emitted, createdAt }。内存态不跨 SW 恢复，
  // 惰性 TTL（对齐 credentials.getClockSkew 惯例，SW 无 setTimeout 清扫器），过期在访问点判定
  #exportSessions = new Map();
  // 导入分块缓冲：transferId -> { domain, parts, received, total, createdAt }（内存态，同上）
  #importBuffers = new Map();

  // 分组对账：本地既有分组（含用户拖拽顺序）为唯一权威，导入只做「id/名称映射 + 追加新组」。
  // storage.getGroups 的数组序是 IDB 主键(id)序，必须先经 utils.normalizeGroups 还原 order 序，
  // 否则导入会把自定义分组（custom_+UUID）按 UUID 字典序重排，即用户可见的「分组顺序紊乱」
  async reconcileImportGroups(domain, data, items) {
    const importedGroups = data.groups || [];
    if (importedGroups.length === 0) return;
    const groupsName = domainStore.groupsName(domain);
    const def = domainStore.defaultGroups(domain);
    const existingList = await storage.getGroups(groupsName);
    const existing = utils.normalizeGroups(existingList.length ? existingList : def.map((g) => ({ ...g })));
    const fixedIds = new Set(CONFIG.DEFAULT_GROUPS.map((g) => g.id));
    const existingIds = new Set(existing.map((g) => g.id));
    const existingNames = new Map(existing.map((g) => [g.name, g.id]));
    const groupIdMap = new Map();
    const newGroups = [];
    for (const g of importedGroups) {
      if (!g || !g.id || fixedIds.has(g.id)) continue; // 固定分组由本地定义，不参与对账
      if (existingIds.has(g.id)) {
        groupIdMap.set(g.id, g.id);
      } else if (existingNames.has(g.name)) {
        groupIdMap.set(g.id, existingNames.get(g.name));
      } else {
        newGroups.push(g);
        groupIdMap.set(g.id, g.id);
      }
    }
    // 新组一律追加到末尾：先压到既有序号之后，避免文件内 order 把新组插进既有分组之间
    newGroups.forEach((g, i) => (g.order = existing.length + i));
    const merged = utils.normalizeGroups([...existing, ...newGroups]);
    await storage.putGroups(groupsName, merged);
    for (const item of items) {
      if (item.groupId && groupIdMap.has(item.groupId)) {
        item.groupId = groupIdMap.get(item.groupId);
      }
    }
  }

  async import(text, domain, sendResponse, taskId = "") {
    try {
      // 解析在 SW 侧完成：options 只传文件全文（字符串过消息通道是 memcpy 级 clone），
      // 主线程不再 JSON.parse 大文件、解析结果不再全量对象 clone
      let data;
      try {
        data = JSON.parse(text);
      } catch (_err) {
        return sendResponse({ ok: false, error: "IMPORT_PARSE_FAILED" });
      }
      const items = domainStore.extractImportItems(data, domain);
      if (items.length === 0) {
        // 原 options 侧 isDomainData 前置校验职责移入：非该域数据/空数组统一报空
        return sendResponse({ ok: false, error: "IMPORT_EMPTY" });
      }
      // reconcileImportGroups 内部对缺组/空组静默返回，此处不再重复判型
      await this.reconcileImportGroups(domain, data, items);

      const groupsName = domainStore.groupsName(domain);
      const def = domainStore.defaultGroups(domain);
      const groupsList = await storage.getGroups(groupsName);
      const currentGroups = groupsList.length ? groupsList : def;
      const validGroupIds = new Set(currentGroups.map((g) => g.id));
      for (const item of items) {
        if (!validGroupIds.has(item.groupId)) item.groupId = CONFIG.GROUPS.DEFAULT_ID;
      }

      if (CONFIG.AUTHOR_RECORD_DOMAINS.includes(domain)) {
        const result = await domainStore.mergeAndSaveAuthors(domain, items);
        sendResponse({ ok: true, ...result });
        return;
      }
      // 作品型三域：登记任务坞（importData）——分块落库是长循环，暂停/取消/队列互斥
      // 全部接入 TaskRegistry。任务在校验全部通过后才登记（解析/空数据等校验错误仍是
      // 纯响应、不产生坞行），start 前重查 isBusy 收窄 parse 秒级窗口内同域任务入队的竞态
      if (taskRegistry.isBusy(domain)) return sendResponse({ ok: false, error: "BUSY" });
      const task = taskRegistry.start({ taskId, kind: "importData", mode: "independent", domain, total: 0 });
      if (!task) return sendResponse({ ok: false, error: "QUEUE_FULL" });
      const requestId = task.taskId;
      // 先 ack 再落库：传输/解析阶段由维护弹窗承载，落库的进度/终态/刷新移交任务坞
      //（TASK_PROGRESS / TASK_DONE / STORE_CHANGED），响应不再携带导入计数
      sendResponse({ ok: true, taskId: requestId });
      const invalid = items.filter((w) => !w || !w[DOMAIN_CONFIG[domain].idField]).length;
      const total = items.length;
      let processed = 0; // 已完成块边界（catch 内也要读：中途失败须如实上报已写入部分）
      let added = 0; // 已写入计数同样提升到 try 外：catch 收口如实上报已落库部分
      let updated = 0;
      try {
        await taskRegistry.waitForTurn(requestId); // 队列接入点 1：排队时在此挂起
        taskRegistry.update(requestId, { total });
        // 分块落库：单事务 10 万级 put 会长时间独占 SW 的 IndexedDB——按块 mergeAndSave
        //（旧记录单事务 getBatch 批量读，块内成本 O(块大小)）；块边界即 checkpoint（队列
        // 接入点 2），每块自提交故暂停让出无需 onSuspend 落库冲刷
        for (let i = 0; i < total; i += CONFIG.IMPORT_CHUNK) {
          await taskRegistry.checkpoint(requestId);
          if (taskRegistry.isCancelled(requestId)) break;
          const result = await domainStore.mergeAndSave(domain, items.slice(i, i + CONFIG.IMPORT_CHUNK));
          added += result.added;
          updated += result.updated;
          processed = Math.min(i + CONFIG.IMPORT_CHUNK, total);
          taskRegistry.update(requestId, { processed });
          utils.emitTaskProgress(requestId, {
            kind: "importData", domain, processed, total,
            elapsed: Date.now() - task.startedAt,
          });
        }
        const cancelled = taskRegistry.isCancelled(requestId);
        // 导入可触及整域：裸 bulk 广播（不带 changedIds）走 options 整域重载兜底——十万级
        // id 集补拉反而劣化；TASK_DONE 必须在其后发（终态收口时数据已可见）
        if (added + updated > 0) utils.sendMessageSafe({ type: "STORE_CHANGED", domain });
        taskRegistry.finish(requestId, { status: cancelled ? "cancelled" : "done" });
        utils.emitTaskDone(requestId, {
          kind: "importData", domain, ok: true, cancelled, timedOut: cancelled,
          processed, total, added, updated, invalid,
          elapsed: Date.now() - task.startedAt,
        });
      } catch (err) {
        // 登记后任何异常都必须 finish，否则 RUNNING 任务泄漏会永久卡死 isBusy 门禁；
        // 已写入块如实收口：计数用 try 外的 added/updated，STORE_CHANGED 先于 TASK_DONE（对齐成功路径次序）
        if (added + updated > 0) utils.sendMessageSafe({ type: "STORE_CHANGED", domain });
        taskRegistry.finish(requestId, { status: "failed", error: err.message });
        utils.emitTaskDone(requestId, {
          kind: "importData", domain, ok: false, error: err.message,
          processed, total, added, updated, invalid,
        });
      }
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }

  // ---------- 导出（会话式分块拉取） ----------
  // 单条 chrome.runtime 消息硬上限 64MiB，整域序列化文本必须分块传输：EXPORT_DATA 只建
  // 会话（getAllKeys 键快照 + header/footer 文本），EXPORT_CHUNK 按偏移逐块拉记录文本，
  // options 只顺序拼接三段文本成 Blob 下载——格式知识全部留在 SW，options 不解析不 stringify。
  // 文件与旧版 JSON.stringify(…, null, 2) 输出逐字节一致（schemaVersion 2，新旧互导兼容）
  async exportStart(domain, sendResponse) {
    const cfg = DOMAIN_CONFIG[domain];
    const keys = await storage.getAllKeys(cfg.storeName);
    const groups = await storage.getGroups(cfg.groupsName);
    const def = domainStore.defaultGroups(domain);
    this.#sweepExportSessions();
    const exportId = crypto.randomUUID();
    this.#exportSessions.set(exportId, { domain, keys, emitted: false, createdAt: Date.now() });
    // header/footer 公式与整体 stringify 逐字节一致，含空域特例（无记录时 "itemKey": []
    // 内联，footer 不再带 "],"）；记录体由 exportChunk 补齐在二者之间
    const groupsText = JSON.stringify(utils.normalizeGroups(groups.length ? groups : def), null, 2)
      .replaceAll("\n", "\n  "); // 组数组从 0 层缩进抬到根对象键层（2 空格）
    const header = `{\n  "schemaVersion": 2,\n  "domain": ${JSON.stringify(domain)},\n  "exportedAt": ${JSON.stringify(new Date().toISOString())},\n  ${JSON.stringify(cfg.itemKey)}: ${keys.length ? "[\n" : "[]"}`;
    const footer = `${keys.length ? "\n  ]" : ""},\n  "groups": ${groupsText}\n}`;
    sendResponse({ ok: true, exportId, total: keys.length, header, footer });
  }

  async exportChunk(msg, sendResponse) {
    const session = this.#exportSessions.get(msg.exportId);
    if (!session || Date.now() - session.createdAt > CONFIG.TRANSFER_SESSION_TTL) {
      this.#exportSessions.delete(msg.exportId); // 未知/过期会话顺手清登记
      return sendResponse({ ok: false, error: "EXPORT_SESSION_EXPIRED" });
    }
    session.createdAt = Date.now(); // 滑动续期：持续拉取的会话不过期
    const { text, taken, done } = await this.#buildExportFragment(session, msg.offset);
    if (done) this.#exportSessions.delete(msg.exportId);
    sendResponse({ ok: true, text, next: msg.offset + taken, done });
  }

  // 一块记录文本：按 EXPORT_BATCH_KEYS 逐批 getBatch 序列化累计，达到 EXPORT_CHUNK_CHARS
  // 或键耗尽为止。快照后已删除的键 getBatch 返回 null——跳过但计入 taken（游标按键序号
  // 推进而非记录数）。块至少携带一批记录：单块最坏 ≈ 块目标长度 + 一批序列化体积，
  // 远离 64MiB 消息上限
  async #buildExportFragment(session, offset) {
    const cfg = DOMAIN_CONFIG[session.domain];
    const parts = [];
    let taken = 0;
    let len = 0;
    while (offset + taken < session.keys.length) {
      const slice = session.keys.slice(offset + taken, offset + taken + CONFIG.EXPORT_BATCH_KEYS);
      const records = await storage.getBatch(cfg.storeName, slice);
      for (let i = 0; i < records.length; i++) {
        taken++;
        if (!records[i]) continue;
        const text = this.#serializeRecord(records[i]);
        parts.push(text);
        len += text.length;
      }
      if (len >= CONFIG.EXPORT_CHUNK_CHARS) break;
    }
    // 首非空块判定用 emitted 而非 offset>0：快照头部键可能全被删，首个非空块前面不能带逗号
    const text = parts.length ? (session.emitted ? ",\n" : "") + parts.join(",\n") : "";
    if (parts.length) session.emitted = true;
    return { text, taken, done: offset + taken >= session.keys.length };
  }

  // 单条记录序列化并整体再缩进 2 空格：记录根落在第 4 列（根对象键 2 + 数组项 2），
  // 与 JSON.stringify 整体输出的数组项缩进逐字节一致
  #serializeRecord(rec) {
    return "    " + JSON.stringify(rec, null, 2).replaceAll("\n", "\n    ");
  }

  #sweepExportSessions() {
    const now = Date.now();
    for (const [id, s] of this.#exportSessions) {
      if (now - s.createdAt > CONFIG.TRANSFER_SESSION_TTL) this.#exportSessions.delete(id);
    }
  }

  // ---------- 导入（分块上行缓冲外壳，拼回后走既有 import()） ----------
  // 大文件全文超 64MiB 单条消息上限：options 按 IMPORT_TRANSFER_CHUNK 切片分条发送，
  // 末块拼回全文走既有 import()（解析/对账/分块落库全不变，taskId 透传给任务坞登记）。
  // BUSY 守卫在路由层对每个分块生效：传输中途同域起任务 → 后续块 BUSY，options 中止，
  // 残留缓冲靠 TTL 清扫；任务在末块之后才登记，路由守卫不会误拒自身分块
  importChunk(msg, sendResponse) {
    const t = msg.transfer;
    if (!t || typeof t.id !== "string" || !Number.isInteger(t.seq)
        || !Number.isInteger(t.total) || t.total < 1 || typeof t.text !== "string") {
      return sendResponse({ ok: false, error: "BAD_PARAMS" });
    }
    this.#sweepImportBuffers();
    if (t.seq === 0) {
      this.#importBuffers.set(t.id, {
        domain: msg.domain,
        parts: new Array(t.total),
        received: 0,
        total: t.total,
        createdAt: Date.now(),
      });
    }
    const buf = this.#importBuffers.get(t.id);
    if (!buf) return sendResponse({ ok: false, error: "IMPORT_TRANSFER_EXPIRED" });
    if (buf.parts[t.seq] === undefined) {
      buf.parts[t.seq] = t.text;
      buf.received++;
    }
    if (buf.received < buf.total) return sendResponse({ ok: true, received: buf.received });
    this.#importBuffers.delete(t.id);
    return this.import(buf.parts.join(""), buf.domain, sendResponse, msg.taskId);
  }

  #sweepImportBuffers() {
    const now = Date.now();
    for (const [id, b] of this.#importBuffers) {
      if (now - b.createdAt > CONFIG.TRANSFER_SESSION_TTL) this.#importBuffers.delete(id);
    }
  }

  async reset(domain, sendResponse) {
    const cfg = DOMAIN_CONFIG[domain];
    await storage.clear(cfg.storeName);
    await storage.putGroups(cfg.groupsName, cfg.defaultGroups, { resetCounts: true });
    sendResponse({ ok: true });
  }

  // msg.bytesOnly → 只回存储占用字节（存储指示器独立刷新用）；缺省视为非法请求。
  // 域分组计数已由 GET_DOMAIN_GROUPS 承接（读 *_groups 小表），此处不再提供按域统计
  async getStats(sendResponse, msg) {
    if (!msg.bytesOnly) {
      sendResponse({ ok: false, error: "BAD_PARAMS" });
      return;
    }
    sendResponse({ ok: true, stats: { bytes: (await storage.estimate()).usage } });
  }
}
const dataTools = new DataTools();

export { dataTools };
