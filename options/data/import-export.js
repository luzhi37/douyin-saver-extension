// ---------- ImportExport ----------
import { config, dom, state, services } from '../core.js';
import { dialog } from '../components/dialog.js';
import { groups } from './groups.js';

// ---------- ImportExport ----------
class ImportExport {
  async handleImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    dom.fileInput.value = "";
    dialog.showDialog("正在导入…", "<p>正在读取文件…</p>");
    state.preventDialogClose = true;
    try {
      const raw = await file.text();
      const data = JSON.parse(raw);
      const domain = state.domain;

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

      await services.loadDomainData();

      await groups.renderGroupTabs();
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

  async handleExport() {
    const domain = state.domain || "works";
    dialog.showDialog("正在导出…", "<p>正在打包数据…</p>");
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
