// ---------- ImportExport ----------
import { config, dom, state, store, services } from '../core.js';
import { dialog } from '../components/dialog.js';
import { groups } from './groups.js';

// ---------- ImportExport ----------
// 数据维护弹窗（菜单「维护」）：四域导出/导入/重置三列聚合于一处，不随当前域自适应，
// 均显式指定目标域；导入经隐藏 #fileInput 选档，目标域在点击按钮时记入 #pendingImportDomain、
// change 事件到达时取回；重置确认/进度弹窗经 pushDialog 叠于维护弹窗之上，关闭即回到本弹窗
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
    const domainName = config.DOMAINS_META[domain].label;
    const confirmBody = document.createElement("p");
    confirmBody.className = "confirm-delete-msg";
    confirmBody.textContent = `确定要清空${domainName}域的所有数据？此操作不可撤销！`;
    dialog.pushDialog(`确认重置${domainName}`, confirmBody, [
      { text: "取消", ghost: true, callback: () => dialog.closeDialog() },
      {
        text: `清空${domainName}数据`,
        danger: true,
        callback: async () => {
          dialog.updateDialog("正在重置…", "<p>正在清空数据…</p>");
          state.preventDialogClose = true;
          try {
            const res = await services.bgMsg({ type: "RESET_DOMAIN", domain });
            if (!res || res.ok !== true) {
              dialog.closeDialog();
              dialog.showToast("重置失败: " + (res?.error || "未知错误"), "error");
              return;
            }
            state.selectedIds.clear();
            store.set("batchMode", false);
            store.set(domain, []);
            await groups.renderGroupTabs();
            dom.dialogTitle.textContent = "重置完成";
            dom.dialogBody.innerHTML = `<p>${domainName}数据已清空</p>`;
            dialog.showOkDialog();
          } finally {
            state.preventDialogClose = false;
          }
        },
      },
    ]);
  }

  async handleImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    dom.fileInput.value = "";
    const domain = this.#pendingImportDomain;
    this.#pendingImportDomain = "";
    if (!domain) return;
    // 进度/结果层叠于备份弹窗之上：关闭后回到弹窗继续操作，无需重开
    dialog.pushDialog("正在导入…", "<p>正在读取文件…</p>");
    state.preventDialogClose = true;
    try {
      const raw = await file.text();
      const data = JSON.parse(raw);

      if (!services.isDomainData(data, domain)) {
        const expected = config.DOMAINS_META[domain].label + "数据";
        dom.dialogTitle.textContent = "导入失败";
        dom.dialogBody.innerHTML = `<p class="dy-text-danger">文件内容不是${expected}</p>`;
        dialog.showOkDialog();
        return;
      }

      dom.dialogTitle.textContent = "正在保存…";
      dom.dialogBody.innerHTML = "<p>正在保存数据…</p>";
      const res = await services.bgMsg({ type: "IMPORT_DATA", data, domain });

      // 仅导入目标域为当前域时刷新视图；其余域在下次域切换时自然加载
      if (domain === state.domain) {
        await services.loadDomainData();
        await groups.renderGroupTabs();
      }

      dom.dialogBody.innerHTML = "";
      if (res.ok) {
        const importTmpl = document.getElementById("importResultTemplate");
        const importBody = importTmpl.content.cloneNode(true);
        importBody.querySelector(".import-file-name").textContent = file.name;
        importBody.querySelector(".import-added").textContent = res.added;
        importBody.querySelector(".import-updated").textContent = res.updated;
        importBody.querySelector(".import-invalid").textContent = res.invalid || 0;
        importBody.querySelector(".import-total").textContent = res.total;
        dom.dialogTitle.textContent = "导入完成";
        dom.dialogBody.appendChild(importBody);
        dialog.showOkDialog();
      } else {
        dom.dialogTitle.textContent = "导入失败";
        dom.dialogBody.innerHTML = `<p class="dy-text-danger">${res.error || "解析失败，请检查文件格式"}</p>`;
        dialog.showOkDialog();
      }
    } catch (err) {
      dom.dialogTitle.textContent = "导入失败";
      dom.dialogBody.innerHTML = `<p class="dy-text-danger">文件解析错误：${err.message}</p>`;
      dialog.showOkDialog();
    } finally {
      state.preventDialogClose = false;
    }
  }

  async handleExport(domain) {
    dialog.pushDialog("正在导出…", "<p>正在打包数据…</p>");
    state.preventDialogClose = true;
    try {
      const res = await services.bgMsg({ type: "EXPORT_DATA", domain });
      if (!res.ok || !res.data) {
        dom.dialogTitle.textContent = "导出失败";
        dom.dialogBody.innerHTML = `<p class="dy-text-danger">${res?.error || "未知错误"}</p>`;
        dialog.showOkDialog();
        return;
      }
      const dateStr = new Date().toLocaleDateString("zh-CN").replace(/\//g, "-");
      const filename = `${domain}-${dateStr}.json`;
      const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      dom.dialogTitle.textContent = "导出完成";
      dom.dialogBody.innerHTML = `<p>文件已下载：${filename}</p>`;
      dialog.showOkDialog();
    } catch (err) {
      dom.dialogTitle.textContent = "导出失败";
      dom.dialogBody.innerHTML = `<p class="dy-text-danger">${err.message}</p>`;
      dialog.showOkDialog();
    } finally {
      state.preventDialogClose = false;
    }
  }
}

export const importExport = new ImportExport();
