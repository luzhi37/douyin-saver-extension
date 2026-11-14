// ---------- ImportExport ----------
import { config, dom, state, store, services } from '../core.js';
import { dialog } from '../components/dialog.js';
import { search } from '../components/search-bar.js';
import { groups } from './groups.js';
import { appShell } from '../components/app-shell.js';
import { taskDock } from '../components/task-dock.js';

// ---------- ImportExport ----------
// 数据维护弹窗（菜单「维护」）：五域导出/导入/重置三列聚合于一处，不随当前域自适应，
// 均显式指定目标域；导入经隐藏 #fileInput 选档，目标域在点击按钮时记入 #pendingImportDomain、
// change 事件到达时取回；重置确认/进度弹窗经 pushDialog 叠于维护弹窗之上，关闭即回到本弹窗。
// 导入分两路：作者域同步弹窗流程；作品型三域落库阶段登记任务坞（importData 长任务）。
// 导出全程走任务坞本地任务（exportData，不经队列/不参与互斥），不再占用弹窗进度层
class ImportExport {
  #pendingImportDomain = "";

  // 三列按钮由 DOMAINS_META 生成，与域元数据保持单一来源
  openDialog() {
    const tmpl = document.getElementById("ioDialogTemplate");
    const body = tmpl.content.cloneNode(true);
    const exportCol = body.querySelector("#ioExportCol");
    const importCol = body.querySelector("#ioImportCol");
    const resetCol = body.querySelector("#ioResetCol");
    for (const [domain, meta] of Object.entries(config.DOMAINS_META)) {
      // 回顾域只持久化批次引用，不参与导出/导入/重置
      if (meta.canImportExport === false) continue;
      const exportBtn = document.createElement("button");
      exportBtn.className = "dy-btn io-action";
      exportBtn.textContent = `${meta.label}域导出`;
      exportBtn.dataset.io = "export";
      exportBtn.dataset.domain = domain;
      exportCol.appendChild(exportBtn);

      const importBtn = document.createElement("button");
      importBtn.className = "dy-btn io-action";
      importBtn.textContent = `${meta.label}域导入`;
      importBtn.dataset.io = "import";
      importBtn.dataset.domain = domain;
      importCol.appendChild(importBtn);

      const resetBtn = document.createElement("button");
      resetBtn.className = "dy-btn io-action dy-btn-danger";
      resetBtn.textContent = `${meta.label}域重置`;
      resetBtn.dataset.io = "reset";
      resetBtn.dataset.domain = domain;
      resetCol.appendChild(resetBtn);

      // 整域导入/重置与同域同步任务互斥（background 同样返回 BUSY 兜底）
      if (taskDock.isDomainBusy(domain)) {
        for (const btn of [importBtn, resetBtn]) {
          btn.disabled = true;
          btn.title = "同步任务运行中，结束后再操作";
        }
      }
    }
    dialog.showDialog("数据维护", body);
    dom.dialogBody.querySelector(".io-dialog").addEventListener("click", (e) => {
      const btn = e.target.closest(".io-action");
      if (!btn) return;
      if (btn.dataset.io === "export") this.handleExport(btn.dataset.domain);
      else if (btn.dataset.io === "reset") this.handleReset(btn.dataset.domain);
      else this.#pickImportFile(btn.dataset.domain);
    });
  }

  #pickImportFile(domain) {
    this.#pendingImportDomain = domain;
    dom.fileInput.click();
  }

  // 重置目标域：确认/进度/结果层叠于维护弹窗之上，关闭后回到本弹窗继续操作
  handleReset(domain) {
    if (taskDock.isDomainBusy(domain)) {
      dialog.showToast("同步任务运行中，暂不能重置该域", "error");
      return;
    }
    const domainName = config.DOMAINS_META[domain].label;
    dialog.confirmTask({
      title: `确认重置${domainName}`,
      message: `确定要清空${domainName}域的所有数据？此操作不可撤销！`,
      actionText: `清空${domainName}数据`,
      push: true,
      progressTitle: "正在重置…",
      progressHtml: "<p>正在清空数据…</p>",
      task: async () => {
        const res = await services.bgMsg({ type: "RESET_DOMAIN", domain });
        if (!res || res.ok !== true) {
          throw new Error(res?.error === "BUSY" ? "同步任务运行中，暂不能重置该域" : res?.error || "未知错误");
        }
        state.selectedIds.clear();
        store.set("batchMode", false);
        store.set(domain, []);
        // 作者域整域清空：主键集同步清空（作品卡作者 chip 立即失效）
        if (config.AUTHOR_RECORD_DOMAINS.includes(domain)) await this.#syncAuthorUids(domain, true);
        await groups.renderGroupTabs();
      },
      successText: `${domainName}数据已清空`,
      failPrefix: "重置失败: ",
    });
  }

  async handleImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    dom.fileInput.value = "";
    const domain = this.#pendingImportDomain;
    this.#pendingImportDomain = "";
    if (!domain) return;
    if (taskDock.isDomainBusy(domain)) {
      dialog.showToast("同步任务运行中，暂不能导入该域", "error");
      return;
    }
    if (config.AUTHOR_RECORD_DOMAINS.includes(domain)) return this.#importAuthorDomain(file, domain);
    return this.#importWorkDomain(file, domain);
  }

  // 作者域导入：单遍 mergeAndSaveAuthors 秒级完成、无分块/暂停点，保持同步弹窗流程
  //（不登记任务坞）；响应携带计数，主键集与视图在本页直接收口
  async #importAuthorDomain(file, domain) {
    dialog.pushDialog("正在导入…", "<p>正在读取文件…</p>");
    state.preventDialogClose = true;
    try {
      const raw = await file.text();
      let res;
      if (raw.length > config.IMPORT_TRANSFER_THRESHOLD) {
        res = await this.#sendImportChunks(raw, domain);
      } else {
        dom.dialogTitle.textContent = "正在保存…";
        dom.dialogBody.innerHTML = "<p>正在保存数据…</p>";
        res = await services.bgMsg({ type: "IMPORT_DATA", text: raw, domain });
      }
      dialog.closeDialog();
      if (!res.ok) {
        dialog.showToast(this.#importErrorText(domain, res.error), "error");
        return;
      }
      // 作者域导入（无 STORE_CHANGED 广播）：重取主键集并 patch 作品卡作者 chip
      //（失败保留旧集；非作品型三域时 syncAuthorFlags 自然空转）
      await this.#syncAuthorUids(domain, false);
      // 仅导入目标域为当前域时刷新视图；其余域在下次域切换时自然加载
      if (domain === state.domain) {
        await appShell.loadDomainDataSafe();
        await groups.renderGroupTabs();
      }
      dialog.showToast(`导入完成：新增 ${res.added} · 更新 ${res.updated} · 无效 ${res.invalid || 0}`, "success");
    } catch (err) {
      dialog.closeDialog();
      dialog.showToast("文件解析错误：" + err.message, "error");
    } finally {
      state.preventDialogClose = false;
    }
  }

  // 作品型三域导入：落库阶段登记任务坞（importData 长任务）。坞行先于消息创建
  //（begin-before-send：TASK_DONE 无论多快到达都能命中行，bindPort 预绑定覆盖关页取消）；
  // 传输/解析秒级仍由弹窗承载并锁定，任务登记（ack 到达）后弹窗即收口，进度/终态/刷新
  // 全部移交任务坞（TASK_PROGRESS / TASK_DONE / 裸 STORE_CHANGED 整域重载），此处不碰 store
  async #importWorkDomain(file, domain) {
    const taskId = crypto.randomUUID();
    taskDock.begin({ taskId, kind: "importData", domain, total: 0, hint: file.name });
    taskDock.bindPort(taskId);
    dialog.pushDialog("正在导入…", "<p>正在读取文件…</p>");
    state.preventDialogClose = true;
    try {
      // 文件全文直发 background：主线程不再 JSON.parse 大文件、解析结果不再全量对象
      // clone 过消息通道（字符串 clone 是 memcpy 级）；解析与校验在 SW 侧完成。
      // 单条消息硬上限 64MiB——超阈值文件切片分块上行（SW 缓冲拼回后走既有 import()，
      // 末块响应即任务 ack）
      const raw = await file.text();
      let res;
      if (raw.length > config.IMPORT_TRANSFER_THRESHOLD) {
        res = await this.#sendImportChunks(raw, domain, taskId);
      } else {
        dom.dialogTitle.textContent = "正在保存…";
        dom.dialogBody.innerHTML = "<p>正在保存数据…</p>";
        res = await services.bgMsg({ type: "IMPORT_DATA", text: raw, domain, taskId });
      }
      dialog.closeDialog();
      if (!res.ok) {
        // 校验/排队错误不产生后台任务：坞行 fail 收口，toast 同步提示
        const text = this.#importErrorText(domain, res.error);
        taskDock.fail(taskId, text);
        dialog.showToast(text, "error");
      }
    } catch (err) {
      dialog.closeDialog();
      const text = "文件解析错误：" + err.message;
      taskDock.fail(taskId, text);
      dialog.showToast(text, "error");
    } finally {
      state.preventDialogClose = false;
    }
  }

  // 导入错误码 → 用户文案（前置校验职责在 background，专用错误码统一在此映射）
  #importErrorText(domain, error) {
    if (error === "BUSY") return "同步任务运行中，暂不能导入该域";
    if (error === "QUEUE_FULL") return "任务队列已满，请稍后重试";
    const expected = config.DOMAINS_META[domain].label + "数据";
    const messages = {
      IMPORT_EMPTY: `文件内容不是${expected}`,
      IMPORT_PARSE_FAILED: "文件解析错误：JSON 解析失败，请检查文件格式",
      IMPORT_TRANSFER_EXPIRED: "导入传输中断，请重试",
    };
    return messages[error] || "导入失败: " + (error || "解析失败，请检查文件格式");
  }

  // 作者域整域替换（重置/导入）后的主键集同步：重置直接清空对应集合（零往返），
  // 导入从 background 重取；当前在作品型三域时原地 patch 挂载卡作者 chip（不整刷）
  async #syncAuthorUids(domain, cleared) {
    if (cleared) {
      if (domain === "followings") state.followedUids = new Set();
      else state.candidateUids = new Set();
    } else {
      await services.loadAuthorUidSets();
    }
    if (config.WORK_RECORD_DOMAINS.includes(state.domain)) {
      search.activeWorkRecordGrid().syncAuthorFlags();
    }
  }

  // 大文件分块上行：逐块 await（SW 按 transferId 缓冲、末块拼回全文走既有 import()）。
  // 任一块非 ok（BUSY / IMPORT_TRANSFER_EXPIRED）即中止，把错误响应交回调用方统一处理；
  // 末块响应 = 作品域任务 ack（taskId 已在坞行上）或作者域同步导入结果
  async #sendImportChunks(raw, domain, taskId = "") {
    const total = Math.ceil(raw.length / config.IMPORT_TRANSFER_CHUNK);
    const transfer = { id: crypto.randomUUID(), total };
    let res = {};
    for (let seq = 0; seq < total; seq++) {
      dom.dialogTitle.textContent = "正在导入…";
      dom.dialogBody.innerHTML = `<p>正在传输 ${seq + 1} / ${total} 块…</p>`;
      res = await services.bgMsg({
        type: "IMPORT_DATA",
        domain,
        taskId,
        transfer: {
          ...transfer,
          seq,
          text: raw.slice(seq * config.IMPORT_TRANSFER_CHUNK, (seq + 1) * config.IMPORT_TRANSFER_CHUNK),
        },
      });
      if (!res.ok) return res;
    }
    return res;
  }

  // 整域导出：任务坞本地任务（batchDownload 同款，不经 background 队列/不占请求车道/
  // 不参与 BUSY 互斥——导出纯只读，background 无循环体可挂 checkpoint，注册队列反而
  // 空占全局单任务位）。拉取循环在 options 侧：暂停=块边界协作让出（挂起等待继续/取消
  // 唤醒）；取消=停止拉取、丢弃已拉文本不保存文件。background 键快照会话 TTL 5min 滑动
  // 续期——暂停超时后恢复，下一块返回 EXPORT_SESSION_EXPIRED，行失败提示重新导出
  async handleExport(domain) {
    const taskId = crypto.randomUUID();
    const task = { paused: false, cancelled: false, wake: null };
    // 块边界挂起点：已请求暂停则翻行走状态，等待继续/取消唤醒
    const hold = async () => {
      if (!task.paused || task.cancelled) return;
      taskDock.setLocalStatus(taskId, "paused");
      await new Promise((resolve) => { task.wake = resolve; });
      task.wake = null;
    };
    const wake = () => {
      const w = task.wake;
      task.wake = null;
      w?.();
    };
    taskDock.begin({
      taskId,
      kind: "exportData",
      domain,
      total: 0,
      hint: config.DOMAINS_META[domain].label,
      onPause: () => { task.paused = true; },
      onResume: () => { task.paused = false; wake(); },
      onCancel: () => {
        if (task.cancelled) return;
        task.cancelled = true;
        wake();
      },
    });
    try {
      // 会话式分块拉取：单条消息硬上限 64MiB——EXPORT_DATA 只回键快照会话 + header/footer，
      // EXPORT_CHUNK 逐块拉记录文本，options 顺序拼接成 Blob（格式知识留在 SW，
      // 不解析不 stringify；空域 total=0 时循环自然跳过，header+footer 即完整文件）
      const start = await services.bgMsg({ type: "EXPORT_DATA", domain });
      if (!start.ok) {
        taskDock.fail(taskId, "导出失败: " + (start.error || "未知错误"));
        return;
      }
      taskDock.onProgress({ taskId, processed: 0, total: start.total });
      const parts = [start.header];
      let offset = 0;
      while (offset < start.total) {
        await hold();
        if (task.cancelled) break;
        const chunk = await services.bgMsg({ type: "EXPORT_CHUNK", exportId: start.exportId, offset });
        if (!chunk.ok) {
          const reason = chunk.error === "EXPORT_SESSION_EXPIRED" ? "导出中断，请重试" : "导出失败: " + (chunk.error || "未知错误");
          taskDock.onDone({ taskId, ok: false, error: reason, processed: offset, total: start.total });
          return;
        }
        parts.push(chunk.text);
        offset = chunk.next;
        taskDock.onProgress({ taskId, processed: offset, total: start.total });
      }
      if (task.cancelled) {
        taskDock.onDone({ taskId, ok: true, cancelled: true, processed: offset, total: start.total });
        return;
      }
      parts.push(start.footer);
      const dateStr = new Date().toLocaleDateString("zh-CN").replace(/\//g, "-");
      const filename = `${domain}-${dateStr}.json`;
      const blob = new Blob(parts, { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      // 延迟 revoke（对齐 detail.triggerDownload）：同步 revoke 在大文件下载启动前
      // 撤源可能截断下载
      setTimeout(() => URL.revokeObjectURL(url), config.BLOB_REVOKE_DELAY);
      taskDock.onDone({ taskId, ok: true, processed: start.total, total: start.total, filename });
    } catch (err) {
      taskDock.onDone({ taskId, ok: false, error: "导出失败: " + (err.message || String(err)) });
    }
  }
}

export const importExport = new ImportExport();
